import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  addUsage, buildRunSummary, commitArtifacts, commitSplitArtifacts,
  emptyUsageTotals, formatUsageLine,
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
  extractSuggestedVerifyCommand, assertActiveChildIssue, assertWorkflowAgentsUnshadowed, renderedToolName
} from "../runtime.ts";

// ---------------------------------------------------------------------------
// Manager tools (registered for every session; handlers require active wf)
// ---------------------------------------------------------------------------

export function registerSplitTool(pi: ExtensionAPI): void {
  // Tool 1: split_prd_to_tasks — read PRD, create bd tasks with deps
  pi.registerTool({
    name: "split_prd_to_tasks",
    label: "拆分 PRD 为 task",
    description: "把 manager 已生成的结构化 subtasks 确定性写成规格和当前 epic 的 Beads task。工具本身不递归调用主模型。",
    parameters: Type.Object({
      prd_path: Type.Optional(Type.String({ description: "必须是当前 canonical PRD 路径" })),
      subtasks: Type.Array(Type.Object({
        id: Type.String({ description: "逻辑 id,如 01" }),
        title: Type.String(),
        depends_on: Type.Array(Type.String()),
        spec: Type.String({ description: "完整 Markdown 规格" }),
      }), { minItems: 1 }),
    }),
    async execute(_id, params) {
      const wf = currentWorkflow();
      if (!wf?.epicId) {
        return { content: [{ type: "text", text: "错误:没有活动 epic。先 /wf new。" }], details: {} };
      }
      const canonicalPrdPath = reqPath(wf, "prd.md");
      const requestedPrdPath = (params as any).prd_path;
      if (requestedPrdPath && path.resolve(requestedPrdPath) !== path.resolve(canonicalPrdPath)) {
        return { content: [{ type: "text", text: `错误:split 只允许当前 canonical PRD:${canonicalPrdPath}` }], details: {} };
      }
      if (!fs.existsSync(canonicalPrdPath)) {
        return { content: [{ type: "text", text: `错误:PRD 文件不存在 ${canonicalPrdPath}` }], details: {} };
      }
      const prdSha256 = sha256File(canonicalPrdPath)!;
      const manifestPath = reqPath(wf, "results", "split.json");
      const manifest = readJson(manifestPath);
      const existingTasks = bd.children(wf.repo, wf.epicId).filter((i) => i.issue_type === "task");
      const decision = splitDecision(existingTasks.map((i) => i.id), manifest, prdSha256);
      if (decision === "reuse") {
        const persisted = commitSplitArtifacts(wf);
        if (!persisted.ok) {
          return { content: [{ type: "text", text: `错误:已有 task 图的规格/manifest 无法持久化到 Git:${persisted.error || "unknown error"}` }], details: {} };
        }
        wf.subtaskIds = [...new Set([...(wf.subtaskIds || []), ...existingTasks.map((i) => i.id)])];
        saveState(wf);
        return { content: [{ type: "text", text: `split 已完成,复用 ${existingTasks.length} 个 task${persisted.committed ? `;权威规格已提交 ${persisted.sha}` : ""}:\n${existingTasks.map((i) => `${i.id} ${i.status} ${i.title}`).join("\n")}` }], details: {} };
      }
      if (decision === "reject") {
        return { content: [{ type: "text", text: `错误:split state 不一致或不完整。为避免静默缺任务/重复任务,本工具拒绝继续。existingTasks=${existingTasks.length},manifestStatus=${manifest?.status || "missing"},manifest:${manifestPath}` }], details: {} };
      }

      const rawSubs = (params as any).subtasks as any[];
      const logicalIds = new Set<string>();
      for (const r of rawSubs) {
        if (!r?.id?.trim() || !r?.title?.trim() || !r?.spec?.trim()) return { content: [{ type: "text", text: "错误:每个 subtask 必须有非空 id/title/spec" }], details: {} };
        if (logicalIds.has(r.id)) return { content: [{ type: "text", text: `错误:重复 subtask id:${r.id}` }], details: {} };
        for (const dep of r.depends_on || []) if (!logicalIds.has(dep)) return { content: [{ type: "text", text: `错误:${r.id} 的依赖 ${dep} 必须指向前面已定义的 task` }], details: {} };
        logicalIds.add(r.id);
      }

      const created: { id: string; logicalId: string; title: string; depends_on: string[] }[] = [];
      fs.writeFileSync(manifestPath, JSON.stringify({
        status: "creating", prdPath: canonicalPrdPath, prdSha256,
        intended: rawSubs.map((r) => ({ id: r.id, title: r.title, depends_on: r.depends_on })),
        created, startedAt: new Date().toISOString(),
      }, null, 2) + "\n");
      try {
        const idToBd = new Map<string, string>();
        for (const r of rawSubs) {
          const file = `subtasks/${r.id}-${slug(r.title)}.md`;
          fs.writeFileSync(reqPath(wf, file), `# ${r.title}\n\n${String(r.spec).replace(/\r/g, "")}\n`);
          const specAbs = reqPath(wf, file);
          const bdId = bd.create(wf.repo, { title: r.title, type: "task", parent: wf.epicId, notes: `规格文件:${specAbs}` });
          idToBd.set(r.id, bdId);
          created.push({ id: bdId, logicalId: r.id, title: r.title, depends_on: r.depends_on || [] });
          fs.writeFileSync(manifestPath, JSON.stringify({ status: "creating", prdPath: canonicalPrdPath, prdSha256, created }, null, 2) + "\n");
        }
        for (const c of created) for (const depLogical of c.depends_on) {
          const depBd = idToBd.get(depLogical);
          if (!depBd) throw new Error(`找不到依赖映射:${depLogical}`);
          bd.depAdd(wf.repo, c.id, depBd, "blocks");
        }
        fs.writeFileSync(manifestPath, JSON.stringify({
          status: "complete", prdPath: canonicalPrdPath, prdSha256, created,
          completedAt: new Date().toISOString(),
        }, null, 2) + "\n");
      } catch (e) {
        fs.writeFileSync(manifestPath, JSON.stringify({
          status: "failed", prdPath: canonicalPrdPath, prdSha256, created,
          error: (e as Error).message, failedAt: new Date().toISOString(),
        }, null, 2) + "\n");
        return { content: [{ type: "text", text: `错误:split partial failure,已记录 ${created.length} 个已创建 task。拒绝自动重试以避免重复:\n${(e as Error).message}\nmanifest:${manifestPath}` }], details: {} };
      }
      const persisted = commitSplitArtifacts(wf);
      if (!persisted.ok) {
        return { content: [{ type: "text", text: `错误:task 已创建,但规格/manifest 无法持久化到 Git。修复 Git 后重试 split 会复用现有 task 并再次提交:${persisted.error || "unknown error"}` }], details: {} };
      }
      wf.subtaskIds = [...new Set([...(wf.subtaskIds || []), ...created.map((c) => c.id)])];
      saveState(wf);
      setManagerSplit(true);
      const summary = created.map((c) => `${c.id}: ${c.title}${c.depends_on.length ? ` (依赖 ${c.depends_on.join(",")})` : ""}`).join("\n");
      return { content: [{ type: "text", text: `已确定性创建 ${created.length} 个 task${persisted.committed ? `;权威规格已提交 ${persisted.sha}` : ""}:\n${summary}\n\n现在严格串行处理 ready task:claim → pi-workflow.dev → pi-workflow.reviewer → close/reopen。` }], details: {} };
    },
  });

}
