import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  addUsage, authoritativeArtifactDrift, buildRunSummary, commitArtifacts,
  commitAuthoritativeArtifacts, emptyUsageTotals, formatUsageLine,
  getVerifyCommand, gitHead, isGitRepo, nowStamp, readRepoBrief, readRunSummary,
  repoBriefPath, reqPath, runVerify, saveState, sh, slug, writeRunSummary,
  validateIntegratedCommitRange,
  type RoleRef, type UsageTotals, type WorkflowConfig, type WorkflowState,
} from "../../lib.ts";
import * as bd from "../../bd.ts";
import {
  CONFIG, baseActiveTools, activeDevToolCallId, mgrHasSplit, mgrTasksProcessed,
  lastAssistantText, usageByModel, loadConfig, setConfig, setWorkflow, currentWorkflow,
  setBaseActiveTools, setActiveDevToolCallId, setManagerSplit,
  setManagerTasksProcessed, incrementManagerTasksProcessed, setLastAssistantText,
  resetUsageByModel, trackUsage, setModeStatus, applyModeTools, readJson,
  sha256File, ensureRequirementDirs, preservedBaseline, splitDecision,
  validateSubagentCall, listAllStates, extractAssistantText, stripFence,
  extractSubtasksJson, useRole, runStageText, withBrief, analyzePrompt,
  extractSuggestedVerifyCommand, assertActiveChildIssue, assertWorkflowAgentsUnshadowed,
  workflowAgentConfig, workflowAgentModel, renderedToolName
} from "../runtime.ts";

// ---------------------------------------------------------------------------
// Manager tools (registered for every session; handlers require active wf)
// ---------------------------------------------------------------------------

function issueFingerprint(issues: unknown[]): string {
  const normalized = issues.map((issue: any) => ({
    severity: String(issue?.severity || "").trim().toLowerCase(),
    file: String(issue?.file || "").trim(),
    line: Number.isFinite(Number(issue?.line)) ? Number(issue.line) : null,
    desc: String(issue?.desc || "").replace(/\s+/g, " ").trim(),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export interface ReviewerRetryDecision {
  autoRetryAllowed: boolean;
  failedReviews: number;
  maxAutoFixes: number;
  consecutiveSameIssues: number;
  sameIssueStopAfter: number;
  reason: "within-budget" | "auto-fix-budget-exhausted" | "same-issues-repeated";
}

export function reviewerRetryDecision(feedback: any, maxAutoFixes: number, sameIssueStopAfter: number): ReviewerRetryDecision {
  const reviews = Array.isArray(feedback?.reviews) ? feedback.reviews : [];
  const fingerprints = reviews.map((review: any) => typeof review?.issueFingerprint === "string"
    ? review.issueFingerprint
    : issueFingerprint(Array.isArray(review?.issues) ? review.issues : []));
  const latest = fingerprints.at(-1);
  let consecutiveSameIssues = 0;
  for (let index = fingerprints.length - 1; index >= 0 && fingerprints[index] === latest; index--) consecutiveSameIssues++;
  const budgetExhausted = reviews.length > maxAutoFixes;
  const sameIssuesRepeated = reviews.length > 0 && consecutiveSameIssues >= sameIssueStopAfter;
  return {
    autoRetryAllowed: !budgetExhausted && !sameIssuesRepeated,
    failedReviews: reviews.length,
    maxAutoFixes,
    consecutiveSameIssues,
    sameIssueStopAfter,
    reason: sameIssuesRepeated ? "same-issues-repeated" : budgetExhausted ? "auto-fix-budget-exhausted" : "within-budget",
  };
}

// Preserve reviewer failures as non-authoritative retry context. Authoritative
// review.json/audit files are deleted on the next claim so they cannot be
// reused as close evidence, but a fresh dev still needs the exact findings.
export function persistReviewerFeedback(wf: WorkflowState, taskId: string): string | undefined {
  const reviewPath = reqPath(wf, "results", `${taskId}.review.json`);
  const review = readJson(reviewPath);
  if (review?.verdict !== "fail" || !Array.isArray(review?.issues)) return undefined;
  const feedbackPath = reqPath(wf, "results", `${taskId}.review-feedback.json`);
  const existing = readJson(feedbackPath);
  const reviews = Array.isArray(existing?.reviews) ? [...existing.reviews] : [];
  const entry = {
    baseline: typeof review.baseline === "string" ? review.baseline : null,
    commitSha: typeof review.commitSha === "string" ? review.commitSha : null,
    issues: review.issues,
    issueFingerprint: issueFingerprint(review.issues),
    summary: typeof review.summary === "string" ? review.summary : "",
    reviewSha256: sha256File(reviewPath),
    recordedAt: new Date().toISOString(),
  };
  if (!reviews.some((item: any) => item?.reviewSha256 === entry.reviewSha256)) reviews.push(entry);
  fs.writeFileSync(feedbackPath, JSON.stringify({
    taskId,
    authoritative: false,
    purpose: "retry-context-only",
    reviews,
  }, null, 2) + "\n");
  return feedbackPath;
}

export function registerBeadsTools(pi: ExtensionAPI): void {
  // Tool 2: read-only Beads queries. This replaces manager shell access.
  pi.registerTool({
    name: "bd_query",
    label: "查询当前 epic",
    description: "只读查询当前 Beads epic 的 children/ready/show/blocked 状态。不能修改 issue。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("children"), Type.Literal("ready"), Type.Literal("show"), Type.Literal("blocked")]),
      issue_id: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const wf = currentWorkflow();
      if (!wf?.epicId) return { content: [{ type: "text", text: "错误:没有活动 epic。" }], details: {} };
      try {
        const p = params as any;
        let result: unknown;
        if (p.action === "children") result = bd.children(wf.repo, wf.epicId);
        else if (p.action === "ready") {
          const childIds = new Set(bd.children(wf.repo, wf.epicId).map((i) => i.id));
          result = bd.ready(wf.repo).filter((i) => childIds.has(i.id));
        } else if (p.action === "blocked") {
          const childIds = new Set(bd.children(wf.repo, wf.epicId).map((i) => i.id));
          result = bd.blocked(wf.repo).filter((i) => childIds.has(i.id));
        } else {
          if (!p.issue_id) throw new Error("show 需要 issue_id");
          const issue = bd.show(wf.repo, p.issue_id);
          const allowed = issue.id === wf.epicId || bd.children(wf.repo, wf.epicId).some((i) => i.id === issue.id);
          if (!allowed) throw new Error("只能查询当前 epic 及其子 issue");
          result = issue;
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `错误:${(e as Error).message}` }], details: {} };
      }
    },
  });

  // Tool 3: bd_task — atomic bd lifecycle operations (claim/close/reopen/comment).
  // The manager uses this for deterministic bd state transitions around
  // subagent({ agent: "pi-workflow.dev"|"pi-workflow.reviewer", ... }) calls.
  // This replaces the old spawn-based executor.
  pi.registerTool({
    name: "bd_task",
    label: "bd task 生命周期操作",
    description: "对 bd issue 做确定性生命周期操作:claim(原子认领,记录 baseline SHA)、close(要求绑定 commit 且符合 active profile 的 reviewer pass,并重跑验证命令)、reopen、comment。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("claim"), Type.Literal("close"), Type.Literal("reopen"), Type.Literal("comment")], { description: "操作类型" }),
      task_id: Type.String({ description: "bd issue id" }),
      text: Type.Optional(Type.String({ description: "close 的 reason / comment 的内容" })),
    }),
    async execute(_id, params) {
      const wf = currentWorkflow();
      if (!wf) {
        return { content: [{ type: "text", text: "错误:没有活动需求。先 /wf new。" }], details: {} };
      }
      const p = params as any;
      const action: string = p.action;
      const taskId: string = p.task_id;
      const text: string | undefined = p.text;
      const repo = wf!.repo;
      // Helper: leave a timestamped progress comment so /wf status can show
      // what's happening with each task (claim/close/reopen are auto-tracked).
      const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      const track = (msg: string) => { try { bd.comment(repo, taskId, `[${stamp}] ${msg}`); } catch (_e) { /* best effort */ } };
      try {
        assertActiveChildIssue(taskId);
        if (action === "claim") {
          if (!getVerifyCommand(CONFIG, wf)) {
            return { content: [{ type: "text", text: "✗ claim 被拒绝:未配置验证命令。先 /wf verify <cmd>。" }], details: {} };
          }
          const prdPath = reqPath(wf, "prd.md");
          const prdAudit = readJson(reqPath(wf, "results", "prd-generation.json"));
          if (prdAudit?.outputSha256 && prdAudit.outputSha256 !== sha256File(prdPath)) {
            return { content: [{ type: "text", text: "✗ claim 被拒绝:canonical PRD 与 prd-writer 审计 hash 不一致。先恢复 PRD 或重新 /wf prd。" }], details: {} };
          }
          const splitManifest = readJson(reqPath(wf, "results", "split.json"));
          if (splitManifest?.prdSha256 && splitManifest.prdSha256 !== sha256File(prdPath)) {
            return { content: [{ type: "text", text: "✗ claim 被拒绝:split manifest 绑定的 PRD 已变化。必须重新规划 task 图。" }], details: {} };
          }
          const persisted = commitAuthoritativeArtifacts(wf);
          if (!persisted.ok) {
            return { content: [{ type: "text", text: `✗ claim 被拒绝:权威 PRD/task 工件无法持久化到 Git:${persisted.error || "unknown error"}` }], details: {} };
          }
          const persistedHead = gitHead(repo);
          if (!persistedHead) {
            return { content: [{ type: "text", text: "✗ claim 被拒绝:持久化后无法读取 Git HEAD。" }], details: {} };
          }
          const preClaimDrift = authoritativeArtifactDrift(wf, persistedHead);
          if (!preClaimDrift.ok || preClaimDrift.paths.length > 0) {
            return { content: [{ type: "text", text: `✗ claim 被拒绝:权威输入未冻结:${preClaimDrift.error || preClaimDrift.paths.join(", ")}` }], details: {} };
          }
          const agent = `manager-${wf.reqId}`;
          const ok = bd.claim(repo, taskId, agent);
          if (!ok) {
            return { content: [{ type: "text", text: `✗ 认领失败(已被占用或状态非 open):${taskId}` }], details: {} };
          }
          // Persist a structured claim baseline. close uses this to prove the
          // reported commit belongs to a non-empty range created after claim.
          const baseline = gitHead(repo);
          const claimPath = reqPath(wf, "results", `${taskId}.claim.json`);
          if (!baseline) {
            bd.reopen(repo, taskId);
            return { content: [{ type: "text", text: `✗ 认领后无法读取目标仓库 HEAD,已 reopen ${taskId}` }], details: {} };
          }
          try {
            fs.mkdirSync(path.dirname(claimPath), { recursive: true });
            for (const stale of [
              reqPath(wf, "results", `${taskId}.json`),
              reqPath(wf, "results", `${taskId}.audit.json`),
              reqPath(wf, "results", `${taskId}.review.json`),
              reqPath(wf, "results", `${taskId}.review.audit.json`),
            ]) if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
            fs.writeFileSync(claimPath, JSON.stringify({ taskId, baseline, claimedAt: new Date().toISOString() }, null, 2) + "\n");
          } catch (e) {
            bd.reopen(repo, taskId);
            return { content: [{ type: "text", text: `✗ 无法保存 claim baseline,已 reopen ${taskId}: ${(e as Error).message}` }], details: {} };
          }
          const feedbackPath = fs.existsSync(reqPath(wf, "results", `${taskId}.review-feedback.json`))
            ? reqPath(wf, "results", `${taskId}.review-feedback.json`)
            : undefined;
          track(`▶ 认领,开始派 dev。baseline=${baseline}${feedbackPath ? `;必须读取 reviewer 反馈=${feedbackPath}` : ""}`);
          return { content: [{ type: "text", text: `✓ 已认领 ${taskId}; baseline 已保存到 ${claimPath}${feedbackPath ? `; dev 必须读取 ${feedbackPath}` : ""}` }], details: {} };
        }
        if (action === "close") {
          // Prove this task produced a non-empty commit range after its claim,
          // and that the resulting commit is integrated into target HEAD.
          const resultPath = reqPath(wf, "results", `${taskId}.json`);
          let commitSha = "";
          let baseline = "";
          try {
            const result = readJson(resultPath);
            const resultAudit = readJson(reqPath(wf, "results", `${taskId}.audit.json`));
            if (!result || !resultAudit) throw new Error("JSON artifact 无法解析");
            const expectedDev = workflowAgentConfig("pi-workflow.dev");
            if (resultAudit.status !== "completed" || resultAudit.requestedModel !== expectedDev.model
              || resultAudit.requestedEffort !== expectedDev.effort || resultAudit.resolvedModel !== expectedDev.model
              || resultAudit.resolvedEffort !== expectedDev.effort
              || resultAudit.profile !== CONFIG.activeModelProfile
              || resultAudit.context !== "fresh" || resultAudit.outputSha256 !== sha256File(resultPath)
              || resultAudit.toolsSafe !== true || resultAudit.authoritativeInputsUnchanged !== true
              || resultAudit.claimTaskId !== taskId || typeof resultAudit.claimBaseline !== "string" || !resultAudit.claimBaseline.trim()) {
              throw new Error("dev agent/model/tool/output/authoritative-input/trusted-baseline audit 无效");
            }
            commitSha = typeof result?.commitSha === "string" ? result.commitSha.trim() : "";
            baseline = resultAudit.claimBaseline.trim();
          } catch (e) {
            bd.reopen(repo, taskId);
            track(`✗ close 被拒:dev 结果或可信 baseline audit 缺失/无效,已自动 reopen。`);
            return {
              content: [{ type: "text", text: `✗ close 被拒绝:结果或可信 baseline audit 缺失/无效,已自动 reopen ${taskId}。\n${(e as Error).message}` }],
              details: {},
            };
          }
          const reviewPath = reqPath(wf, "results", `${taskId}.review.json`);
          const reviewAuditPath = reqPath(wf, "results", `${taskId}.review.audit.json`);
          try {
            const review = readJson(reviewPath);
            const audit = readJson(reviewAuditPath);
            if (!review || !audit) throw new Error("review JSON artifact 无法解析");
            const reviewBound = review?.verdict === "pass" && review?.taskId === taskId
              && review?.baseline === baseline && review?.commitSha === commitSha;
            const expectedReviewer = workflowAgentConfig("pi-workflow.reviewer");
            const auditValid = audit?.status === "completed" && audit?.requestedModel === expectedReviewer.model
              && audit?.requestedEffort === expectedReviewer.effort && audit?.resolvedModel === expectedReviewer.model
              && audit?.resolvedEffort === expectedReviewer.effort
              && audit?.profile === CONFIG.activeModelProfile
              && audit?.context === "fresh" && audit?.outputSha256 === sha256File(reviewPath);
            if (!reviewBound || !auditValid) throw new Error(`review verdict 未通过、未绑定 task/commit,或 ${expectedReviewer.model} effort=${expectedReviewer.effort} audit 无效`);
          } catch (e) {
            bd.reopen(repo, taskId);
            track(`✗ close 被拒:review 证据缺失/无效,已自动 reopen。`);
            return { content: [{ type: "text", text: `✗ close 被拒绝:必须先由 ${workflowAgentModel("pi-workflow.reviewer")} reviewer 对 taskId/baseline/commitSha 给出绑定的 pass verdict。\n${(e as Error).message}` }], details: {} };
          }
          const range = validateIntegratedCommitRange(repo, baseline, commitSha);
          if (!range.ok) {
            bd.reopen(repo, taskId);
            track(`✗ close 被拒:commit range 校验失败(${range.reason}),已自动 reopen。`);
            return {
              content: [{ type: "text", text:
                `✗ close 被拒绝:task ${taskId} 的 commit range 无效(${range.reason}),已自动 reopen。\n` +
                `baseline=${baseline || "(空)"}\ncommit=${commitSha || "(空)"}\n` +
                `要求:dev 必须在 claim 后产生非空 commit,且该 commit 已进入目标仓库 HEAD。worktree patch/handoff 未集成时不会通过。`
              }],
              details: {},
            };
          }

          // Code-level P0 recheck (risk #2/#4): don't trust the dev's
          // Missing verification is always a hard failure; runVerify has no
          // bypass flag and the same policy applies to run_verify.
          const v = runVerify(CONFIG, wf!);
          if (!v.ok) {
            bd.reopen(repo, taskId);
            track(`✗ close 被拒:代码层验证复核未通过,已自动 reopen。\n${v.output.slice(-800)}`);
            return {
              content: [{ type: "text", text:
                `✗ close 被拒绝:验证命令复核未通过,已自动 reopen ${taskId}。\n` +
                `${v.output.slice(-1200)}\n` +
                `不要直接重试 close——先确认 pi-workflow.dev 指令里传的验证命令和仓库配置一致,或检查 dev 的改动是否真的让验证通过。`
              }],
              details: {},
            };
          }
          bd.close(repo, taskId, text);
          track(`✔ 关闭(验证复核通过)${text ? `:${text.slice(0, 120)}` : ""}`);
          incrementManagerTasksProcessed();
          return { content: [{ type: "text", text: `✓ 已关闭 ${taskId}(验证复核通过)${text ? `(${text})` : ""}` }], details: {} };
        }
        if (action === "reopen") {
          const feedbackPath = persistReviewerFeedback(wf, taskId);
          const retryDecision = feedbackPath ? reviewerRetryDecision(
            readJson(feedbackPath),
            CONFIG.execute?.maxReviewerAutoFixes ?? 3,
            CONFIG.execute?.sameIssueStopAfter ?? 2,
          ) : undefined;
          bd.reopen(repo, taskId);
          const retryText = retryDecision
            ? retryDecision.autoRetryAllowed
              ? `;AUTO_RETRY_ALLOWED failedReviews=${retryDecision.failedReviews}/${retryDecision.maxAutoFixes}`
              : `;STOP_REQUIRED reason=${retryDecision.reason},failedReviews=${retryDecision.failedReviews}/${retryDecision.maxAutoFixes},sameIssues=${retryDecision.consecutiveSameIssues}/${retryDecision.sameIssueStopAfter}`
            : "";
          track(`✗ 放回 ready${text ? `:${text.slice(0, 120)}` : ""}${feedbackPath ? `;reviewer 反馈已保存:${feedbackPath}` : ""}${retryText}`);
          return {
            content: [{ type: "text", text: `✓ 已放回 ready ${taskId}${feedbackPath ? `; reviewer 反馈已保存到 ${feedbackPath}` : ""}${retryText}` }],
            details: { feedbackPath, retryDecision } as any,
          };
        }
        if (action === "comment") {
          if (!text) return { content: [{ type: "text", text: "错误:comment 需要 text 参数" }], details: {} };
          bd.comment(repo, taskId, text);
          return { content: [{ type: "text", text: `✓ 已在 ${taskId} 留 comment` }], details: {} };
        }
        return { content: [{ type: "text", text: `未知 action:${action}` }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `错误:${(e as Error).message}` }], details: {} };
      }
    },
  });

}
