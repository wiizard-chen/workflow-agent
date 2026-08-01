import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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

export async function cmdBug(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const wf = currentWorkflow();
  const desc = args.trim().replace(/["']/g, "");
  if (!desc) { ctx.ui.notify("用法:/wf bug <描述>(可包含多个问题)", "warning"); return; }
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf resume 切到要修 bug 的需求。", "warning"); return; }
  if (!wf.epicId) { ctx.ui.notify("当前需求缺少 bd epic id。", "error"); return; }
  fs.mkdirSync(reqPath(wf, "subtasks"), { recursive: true });

  // Use the split model to analyze the description and break out independent bugs.
  // Single problem → 1 bug; multiple ("首先/其次/另外") → multiple bugs.
  ctx.ui.notify("分析 bug 描述…", "info");
  const analyzePrompt = [
    `你是 bug 分类助手。分析下面这段 bug 描述,把里面独立的、不相关的问题拆开。`,
    `只输出严格 JSON:{"bugs":[{"title":"短标题(≤20字)","desc":"具体问题描述"}]}`,
    `要求:每个独立问题一个 bug;相关联的合并成一个;title 简短;desc 包含足够细节让开发者复现。`,
    `如果只有一个问题,JSON 里就一个 bug。`,
    ``,
    `--- bug 描述 ---`,
    desc,
  ].join("\n");
  const analysisText = await runStageText(pi, ctx, CONFIG.roles.split, analyzePrompt);

  // Parse the analysis; fall back to a single bug if model fails.
  let bugs: { title: string; desc: string }[] = [];
  if (analysisText) {
    try {
      const parsed = extractSubtasksJson(analysisText) as any;
      const raw = parsed.bugs || parsed.subtasks || [];
      bugs = raw.map((b: any) => ({ title: String(b.title || "").slice(0, 60), desc: String(b.desc || b.spec || b.title || desc) }));
    } catch (_e) { /* fall through to single-bug fallback */ }
  }
  if (bugs.length === 0) bugs = [{ title: desc.slice(0, 40), desc }];

  // Create each bug with its own spec file.
  const created: { id: string; title: string }[] = [];
  for (const b of bugs) {
    try {
      const safeName = slug(b.title).slice(0, 30) || "bug";
      const specPath = reqPath(wf, "subtasks", `bug-${safeName}.md`);
      const specBody = [
        `# Bug: ${b.title}`,
        ``,
        `## 问题描述`,
        b.desc,
        ``,
        `## 目标`,
        `修复这个 bug,使行为符合预期。如果是 UI bug,确保各屏幕尺寸正常。`,
        ``,
        `## 验收标准`,
        `- [ ] 上述问题不再复现`,
        `- [ ] 验证命令通过(或手动验证行为正确)`,
        `- [ ] 没有引入新的回归`,
        ``,
        `> 由 /wf bug 生成。dev 实现时先复现,再修。`,
      ].join("\n");
      fs.writeFileSync(specPath, specBody);
      const bugId = bd.create(wf.repo, {
        title: `bug: ${b.title}`,
        type: "bug",
        parent: wf.epicId,
        description: b.desc,
        notes: `规格文件:${specPath}`,
      });
      created.push({ id: bugId, title: b.title });
    } catch (e) {
      ctx.ui.notify(`建 bug 失败(${b.title}):${(e as Error).message}`, "error");
    }
  }

  const persisted = commitSplitArtifacts(wf);
  if (!persisted.ok) ctx.ui.notify(`bug 已创建,但规格无法持久化到 Git:${persisted.error || "unknown error"}`, "error");
  const lines = created.map((c) => `  ${c.id}: ${c.title}`).join("\n");
  ctx.ui.notify(
    `已建 ${created.length} 个 bug(挂 epic ${wf.epicId})${persisted.committed ? `;规格 commit ${persisted.sha}` : ""}:\n${lines}\n\n/execute 修复(经理会检查 epic 下的 open bug)`,
    "info"
  );
}

/** /wf task <描述> — 轻量功能入口,跳过 PRD。把一句话小需求用 split 模型拆成一组
 *  尽量独立、可单独实现与验证的 beads task(带依赖),挂在当前活动需求 epic 下。
 *  跟 /wf bug 的区别:bug 是修(task type=bug),task 是加功能(type=task),
 *  而且拆分用 split_prd_to_tasks 同款的 tracer-bullet 原则(垂直切片、依赖最小化),
 *  会标注 task 之间的 blocks 依赖。建完后手动 /execute 让经理串行派 dev 实现。 */
export async function cmdTask(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const wf = currentWorkflow();
  const desc = args.trim().replace(/["']/g, "");
  if (!desc) { ctx.ui.notify("用法:/wf task <描述>(一句话小需求,会自动拆成多个 task)", "warning"); return; }
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf resume 切到要加功能的需求。", "warning"); return; }
  if (!wf.epicId) { ctx.ui.notify("当前需求缺少 bd epic id。", "error"); return; }
  fs.mkdirSync(reqPath(wf, "subtasks"), { recursive: true });

  // Use the split model with the same tracer-bullet prompt as split_prd_to_tasks
  // (vertical slices, dependency minimization) so the breakdown matches what
  // /execute would produce from a full PRD. Single coherent ask → 1 task;
  // multi-part ask ("加 X 和 Y") → multiple independent tasks.
  ctx.ui.notify("分析需求,拆成可独立验证的 task…", "info");
  const splitPromptText = withBrief(wf.repo, [
    `你是技术负责人。基于以下需求描述,把它拆成一组尽量独立、可单独实现与验证的子任务(tracer-bullet 垂直切片)。`,
    `只输出严格 JSON:{"subtasks":[{"id":"01","title":"标题","depends_on":[],"spec":"完整 Markdown 规格"}]}`,
    `要求:id 从 01 递增;depends_on 用其他 id(被依赖者在前面);每个子任务切透所有相关层、可独立提交;`,
    `spec 包含背景/要做什么/验收标准/范围边界,让 dev 拿到就能独立实现;`,
    `只有"B 必须基于 A 的产出"才是真依赖,同文件改动不是;如果需求是单一连贯的事,JSON 里就一个 task。`,
    ``,
    `--- 需求描述 ---`,
    desc,
  ].join("\n"));
  const splitText = await runStageText(pi, ctx, CONFIG.roles.split, splitPromptText);

  // Parse the breakdown; fall back to a single task if the model fails.
  let rawSubs: { id?: string; title?: string; depends_on?: string[]; spec?: string }[] = [];
  if (splitText) {
    try {
      const parsed = extractSubtasksJson(splitText) as any;
      rawSubs = (parsed.subtasks || []).map((r: any) => ({
        id: r.id ? String(r.id) : undefined,
        title: String(r.title || "").slice(0, 80),
        depends_on: Array.isArray(r.depends_on) ? r.depends_on.map(String) : [],
        spec: String(r.spec || r.desc || r.title || desc),
      }));
    } catch (_e) { /* fall through to single-task fallback */ }
  }
  if (rawSubs.length === 0) {
    rawSubs = [{ id: "01", title: desc.slice(0, 40), depends_on: [], spec: desc }];
  }

  // Write specs + create bd tasks under the current epic.
  const created: { id: string; title: string; depends_on: string[] }[] = [];
  const idToBd = new Map<string, string>();
  for (let i = 0; i < rawSubs.length; i++) {
    const r = rawSubs[i];
    const logicalId = r.id || String(i + 1).padStart(2, "0");
    try {
      const file = `subtasks/${logicalId}-${slug(r.title || "task")}.md`;
      const specAbs = reqPath(wf, file);
      fs.writeFileSync(specAbs, `# ${r.title}\n\n${(r.spec || "").replace(/\r/g, "")}\n\n> 由 /wf task 生成。dev 按 spec 实现。\n`);
      const bdId = bd.create(wf.repo, {
        title: r.title || desc.slice(0, 40),
        type: "task",
        parent: wf.epicId,
        notes: `规格文件:${specAbs}`,
      });
      idToBd.set(logicalId, bdId);
      created.push({ id: bdId, title: r.title || desc.slice(0, 40), depends_on: r.depends_on || [] });
    } catch (e) {
      ctx.ui.notify(`建 task 失败(${r.title || logicalId}):${(e as Error).message}`, "error");
    }
  }

  // Wire up dependencies (blocks type, so they actually gate the ready queue).
  for (const c of created) {
    for (const depLogical of c.depends_on) {
      const depBd = idToBd.get(depLogical);
      if (depBd) try { bd.depAdd(wf.repo, c.id, depBd, "blocks"); } catch (_e) { /* ignore */ }
    }
  }

  // Track the new task ids on wf so /wf status shows them.
  wf.subtaskIds = [...(wf.subtaskIds || []), ...created.map((c) => c.id)];
  saveState(wf);
  const persisted = commitSplitArtifacts(wf);
  if (!persisted.ok) ctx.ui.notify(`task 已创建,但规格无法持久化到 Git:${persisted.error || "unknown error"}`, "error");

  const lines = created.map((c) =>
    `  ${c.id}: ${c.title}${c.depends_on.length ? ` (依赖 ${c.depends_on.join(",")})` : ""}`
  ).join("\n");
  ctx.ui.notify(
    `已建 ${created.length} 个 task(挂 epic ${wf.epicId})${persisted.committed ? `;规格 commit ${persisted.sha}` : ""}:\n${lines}\n\n/execute 让经理按安全单-writer顺序串行实现`,
    "info"
  );
}


