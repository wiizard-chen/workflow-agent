import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  addUsage, buildRunSummary, commitArtifacts, emptyUsageTotals, formatUsageLine,
  getVerifyCommand, gitHead, isGitRepo, nowStamp, readRepoBrief, readRunSummary,
  repoBriefPath, reqPath, runVerify, saveState, sh, slug, writeRunSummary,
  validateIntegratedCommitRange,
  type RoleRef, type UsageTotals, type WorkflowConfig, type WorkflowState,
} from "../../lib.ts";
import * as bd from "../../bd.ts";
import {
  CONFIG, wf, baseActiveTools, activeDevToolCallId, mgrHasSplit, mgrTasksProcessed,
  lastAssistantText, usageByModel, loadConfig, setConfig, setWorkflow,
  setBaseActiveTools, setActiveDevToolCallId, setManagerSplit,
  setManagerTasksProcessed, incrementManagerTasksProcessed, setLastAssistantText,
  resetUsageByModel, trackUsage, setModeStatus, applyModeTools, readJson,
  sha256File, ensureRequirementDirs, preservedBaseline, splitDecision,
  validateSubagentCall, listAllStates, extractAssistantText, stripFence,
  extractSubtasksJson, useRole, runStageText, withBrief, analyzePrompt,
  extractSuggestedVerifyCommand, assertActiveChildIssue, assertWorkflowAgentsUnshadowed,
  workflowAgentConfig, renderedToolName
} from "../runtime.ts";

// ---------------------------------------------------------------------------
// Manager tools (registered for every session; handlers require active wf)
// ---------------------------------------------------------------------------

export function registerVerificationTools(pi: ExtensionAPI): void {
  // Tool 4: deterministic verification. The manager cannot run shell; this
  // tool executes only the preconfigured command and persists bounded evidence.
  pi.registerTool({
    name: "run_verify",
    label: "运行确定性验证",
    description: "所有 task/bug 关闭后运行预配置验证命令,写 verify.json 与 cumulative.diff。不能接受任意命令参数。",
    parameters: Type.Object({}),
    async execute() {
      if (!wf?.epicId) return { content: [{ type: "text", text: "错误:没有活动 epic。" }], details: {} };
      const command = getVerifyCommand(CONFIG, wf);
      if (!command) return { content: [{ type: "text", text: "错误:未配置验证命令。先 /wf verify <cmd>。" }], details: {} };
      const dirtyCode = sh("git", ["status", "--porcelain", "--", ".", ":!.workflow"], wf.repo).stdout.trim();
      if (dirtyCode) return { content: [{ type: "text", text: `错误:代码工作树不干净,不能生成最终证据:\n${dirtyCode}` }], details: {} };
      const unfinished = bd.children(wf.repo, wf.epicId).filter((i) => (i.issue_type === "task" || i.issue_type === "bug") && i.status !== "closed");
      if (unfinished.length) {
        return { content: [{ type: "text", text: `错误:仍有 ${unfinished.length} 个未关闭 task/bug:\n${unfinished.map((i) => `${i.id} ${i.status} ${i.title}`).join("\n")}` }], details: {} };
      }
      const diffBase = wf.baseline || "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const diffPath = reqPath(wf, "results", "cumulative.diff");
      const verifyPath = reqPath(wf, "results", "verify.json");
      const finalPath = reqPath(wf, "results", "final-review.json");
      const finalAuditPath = reqPath(wf, "results", "final-review.audit.json");
      const prdPath = reqPath(wf, "prd.md");
      if (!fs.existsSync(prdPath)) return { content: [{ type: "text", text: `错误:PRD 不存在:${prdPath}` }], details: {} };
      fs.mkdirSync(path.dirname(diffPath), { recursive: true });
      for (const stale of [finalPath, finalAuditPath]) if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
      const headBefore = gitHead(wf.repo);
      if (!headBefore) return { content: [{ type: "text", text: "错误:无法读取当前 HEAD" }], details: {} };
      const diffResult = sh("git", ["diff", diffBase, headBefore], wf.repo);
      if (diffResult.code !== 0) return { content: [{ type: "text", text: `错误:生成 cumulative diff 失败:${diffResult.stderr}` }], details: {} };
      fs.writeFileSync(diffPath, diffResult.stdout);
      const startedAt = new Date().toISOString();
      const runId = randomUUID();
      const v = runVerify(CONFIG, wf);
      const headAfter = gitHead(wf.repo);
      const headStable = headAfter === headBefore;
      const evidence = {
        runId,
        command: v.command,
        ok: v.ok && headStable,
        exitCode: v.code,
        output: headStable ? v.output : `${v.output}\n验证命令执行期间 HEAD 发生变化:${headBefore} -> ${headAfter}`,
        startedAt,
        completedAt: new Date().toISOString(),
        baseline: diffBase,
        head: headBefore,
        diffPath,
        prdPath,
        prdSha256: sha256File(prdPath),
        diffSha256: sha256File(diffPath),
      };
      fs.writeFileSync(verifyPath, JSON.stringify(evidence, null, 2) + "\n");
      const finalReviewer = workflowAgentConfig("pi-workflow.final-reviewer");
      return { content: [{ type: "text", text:
        `确定性验证${evidence.ok ? "通过" : "失败"}(exit ${v.code},runId ${runId})。\nverify:${verifyPath}\ndiff:${diffPath}\n` +
        `下一步必须调用 subagent({agent:"pi-workflow.final-reviewer", model:${JSON.stringify(finalReviewer.model)}, thinking:${JSON.stringify(finalReviewer.effort)}, context:"fresh", cwd:${JSON.stringify(wf.repo)}, output:${JSON.stringify(reqPath(wf, "results", "final-review.json"))}, task:"读取 PRD ${prdPath}、verify ${verifyPath}、diff ${diffPath},逐条验收并在 JSON 中原样返回 runId=${runId}"}),然后调用 finalize_test。`
      }], details: {} };
    },
  });

  // Tool 5: validate final-reviewer JSON and create bugs deterministically.
  pi.registerTool({
    name: "finalize_test",
    label: "处理最终审查",
    description: "读取固定路径 verify.json/final-review.json,校验结构;失败时在当前 epic 下创建 bug,通过时提交 workflow 工件。",
    parameters: Type.Object({}),
    async execute() {
      if (!wf?.epicId) return { content: [{ type: "text", text: "错误:没有活动 epic。" }], details: {} };
      const verifyPath = reqPath(wf, "results", "verify.json");
      const reviewPath = reqPath(wf, "results", "final-review.json");
      const auditPath = reqPath(wf, "results", "final-review.audit.json");
      const diffPath = reqPath(wf, "results", "cumulative.diff");
      const prdPath = reqPath(wf, "prd.md");
      try {
        const command = getVerifyCommand(CONFIG, wf);
        if (!command) throw new Error("未配置验证命令;禁止 finalize");
        const dirtyCode = sh("git", ["status", "--porcelain", "--", ".", ":!.workflow"], wf.repo).stdout.trim();
        if (dirtyCode) throw new Error(`代码工作树不干净;必须重新提交/验证:\n${dirtyCode}`);
        const verify = readJson(verifyPath);
        const review = readJson(reviewPath);
        const audit = readJson(auditPath);
        if (!verify || !review || !audit) throw new Error("最终 evidence JSON 无法解析");
        const currentHead = gitHead(wf.repo);
        const unfinished = bd.children(wf.repo, wf.epicId).filter((i) => (i.issue_type === "task" || i.issue_type === "bug") && i.status !== "closed");
        if (unfinished.length) throw new Error(`仍有 ${unfinished.length} 个未关闭 task/bug`);
        if (!verify?.runId || verify.command !== command || verify.head !== currentHead) throw new Error("verify evidence 与当前 command/HEAD 不匹配");
        if (verify.prdSha256 !== sha256File(prdPath) || verify.diffSha256 !== sha256File(diffPath)) throw new Error("PRD/diff hash 已变化;必须重新 run_verify");
        if (!review || review.runId !== verify.runId || !["pass", "fail"].includes(review.verdict)
          || !Array.isArray(review.issues) || !Array.isArray(review.acceptanceChecks) || review.acceptanceChecks.length === 0
          || typeof review.summary !== "string" || !review.summary.trim()) {
          throw new Error("final-review.json schema/runId 无效");
        }
        const expectedFinal = workflowAgentConfig("pi-workflow.final-reviewer");
        if (audit?.status !== "completed" || audit?.requestedModel !== expectedFinal.model
          || audit?.requestedEffort !== expectedFinal.effort || audit?.resolvedModel !== expectedFinal.model
          || audit?.resolvedEffort !== expectedFinal.effort
          || audit?.profile !== CONFIG.activeModelProfile || audit?.context !== "fresh"
          || audit?.verifyRunId !== verify.runId || audit?.verifySha256 !== sha256File(verifyPath)
          || audit?.outputSha256 !== sha256File(reviewPath)) {
          throw new Error(`final-reviewer audit 缺失、模型/effort 错误(${expectedFinal.model},effort=${expectedFinal.effort},profile=${CONFIG.activeModelProfile})或 evidence 已变化`);
        }
        const blockingReviewIssues = review.issues.filter((i: any) => i && ["blocker", "major"].includes(i.severity));
        const failedChecks = review.acceptanceChecks.filter((c: any) => !c || c.status !== "pass" || !String(c.criterion || "").trim() || !String(c.evidence || "").trim());
        if (review.verdict === "pass" && (verify.ok !== true || failedChecks.length || blockingReviewIssues.length)) {
          throw new Error("pass verdict 与验证/checks/blocking issues 矛盾");
        }
        if (review.verdict === "pass") {
          const committed = commitArtifacts(wf);
          if (!committed.committed) throw new Error("workflow 最终工件提交失败或没有可提交工件");
          return { content: [{ type: "text", text: `✓ 最终验证与 ${expectedFinal.model} effort=${expectedFinal.effort} review 均通过。runId:${verify.runId}\n报告:${reviewPath}\n工件 commit:${committed.sha}` }], details: {} };
        }

        const issues = blockingReviewIssues;
        if (verify.ok !== true && issues.length === 0) {
          issues.push({
            severity: "blocker",
            title: "验证命令失败",
            description: `${verify.command} exit ${verify.exitCode}\n${String(verify.output || "").slice(-1500)}`,
            suggestedFix: "修复验证失败后重新运行最终验收",
          });
        }
        if (issues.length === 0) throw new Error("final verdict=fail 但没有 blocker/major issue");

        const created: string[] = [];
        for (let i = 0; i < issues.length; i++) {
          const issue = issues[i];
          const title = String(issue.title || `最终审查问题 ${i + 1}`).slice(0, 80);
          const specPath = reqPath(wf, "subtasks", `bug-final-${String(i + 1).padStart(2, "0")}-${slug(title)}.md`);
          const body = [
            `# Bug: ${title}`, "", `## 严重度`, String(issue.severity), "",
            `## 问题`, String(issue.description || ""), "",
            `## 位置`, `${issue.file || "未指定"}${issue.line ? `:${issue.line}` : ""}`, "",
            `## 建议修复`, String(issue.suggestedFix || "根据最终审查证据修复"), "",
            `## 验收标准`, `- [ ] 问题不再复现`, `- [ ] ${verify.command} 通过`, `- [ ] final-reviewer verdict=pass`, "",
          ].join("\n");
          fs.writeFileSync(specPath, body);
          const id = bd.create(wf.repo, {
            title: `bug: ${title}`,
            type: "bug",
            parent: wf.epicId,
            description: String(issue.description || title),
            notes: `规格文件:${specPath};来源:${reviewPath}`,
          });
          created.push(id);
        }
        wf.subtaskIds = [...(wf.subtaskIds || []), ...created];
        saveState(wf);
        return { content: [{ type: "text", text: `最终审查失败,已创建 ${created.length} 个 bug:\n${created.join("\n")}\n修复后重新 run_verify → final-reviewer → finalize_test。` }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `错误:${(e as Error).message}` }], details: {} };
      }
    },
  });
}
