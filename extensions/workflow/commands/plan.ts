import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
  CONFIG, baseActiveTools, activeDevToolCallId, mgrHasSplit, mgrTasksProcessed,
  lastAssistantText, usageByModel, loadConfig, setConfig, setWorkflow, currentWorkflow,
  setBaseActiveTools, setActiveDevToolCallId, setManagerSplit,
  setManagerTasksProcessed, incrementManagerTasksProcessed, setLastAssistantText,
  resetUsageByModel, trackUsage, setModeStatus, applyModeTools, readJson,
  sha256File, ensureRequirementDirs, preservedBaseline, splitDecision,
  validateSubagentCall, listAllStates, extractAssistantText, stripFence,
  extractSubtasksJson, useRole, runStageText, withBrief, analyzePrompt,
  extractSuggestedVerifyCommand, assertActiveChildIssue, assertWorkflowAgentsUnshadowed,
  assertAdvisoryAgentsUnshadowed, advisoryOutputPath, advisoryRepoSnapshot,
  assertActiveProfileModelsAvailable, workflowAgentEffort, workflowAgentModel, renderedToolName
} from "../runtime.ts";

// ---------------------------------------------------------------------------
// PRD mode commands
// ---------------------------------------------------------------------------

export async function cmdNew(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const wf = currentWorkflow();
  try { await assertActiveProfileModelsAvailable(ctx); }
  catch (e) { ctx.ui.notify(`模型 profile 不可用:${(e as Error).message}`, "error"); return; }
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) { ctx.ui.notify("用法:/wf new <需求名> [目标repo路径]", "warning"); return; }
  if (wf && wf.mode === "build") { ctx.ui.notify(`需求 ${wf.reqId} 正在执行中,不能新建。`, "error"); return; }
  const name = parts[0].replace(/["']/g, "");
  let repo = path.resolve(parts[1] ? parts[1].replace(/["']/g, "") : ctx.cwd);
  if (!fs.existsSync(repo)) { ctx.ui.notify(`目标目录不存在:${repo}`, "error"); return; }
  try { repo = fs.realpathSync(repo); } catch (_e) { /* keep */ }
  if (!isGitRepo(repo)) { ctx.ui.notify(`目标不是 git 仓库:${repo}`, "error"); return; }
  if (!(await useRole(pi, ctx, CONFIG.roles.discuss))) return;

  let epicId: string | undefined;
  try {
    bd.init(repo);
    epicId = bd.create(repo, { title: name, type: "epic" });
  } catch (e) {
    ctx.ui.notify(`bd 初始化或创建 epic 失败:${(e as Error).message}`, "error");
    return;
  }

  const reqId = `${nowStamp()}-${slug(name)}`;
  const nextWorkflow: WorkflowState = { reqId, name, repo, mode: "plan", createdAt: new Date().toISOString(), epicId, subtaskIds: [] };
  setWorkflow(nextWorkflow);
  resetUsageByModel();   // fresh telemetry for a fresh requirement
  ensureRequirementDirs(nextWorkflow);
  saveState(nextWorkflow);
  setModeStatus(ctx);
  applyModeTools(pi, ctx);
  ctx.ui.notify(`新需求 ${reqId}\n目标 repo: ${repo}\nbd epic: ${epicId}\n已进入 PRD 模式(${CONFIG.roles.discuss.model},只读)。讨论需求,满意后 /wf prd 生成 PRD,再 /execute 执行。`, "info");
}

export async function cmdPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const wf = currentWorkflow();
  try { await assertActiveProfileModelsAvailable(ctx); }
  catch (e) { ctx.ui.notify(`模型 profile 不可用:${(e as Error).message}`, "error"); return; }
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new。", "warning"); return; }
  if (!(await useRole(pi, ctx, CONFIG.roles.discuss))) return;
  setActiveDevToolCallId(undefined);
  wf.mode = "plan"; saveState(wf); setModeStatus(ctx); applyModeTools(pi, ctx);
  ctx.ui.notify(`已进入 PRD 模式(只读)。讨论需求,或 /wf prd 生成 PRD。`, "info");
}

export async function cmdResearch(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const wf = currentWorkflow();
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new。", "warning"); return; }
  if (wf.mode !== "plan") { ctx.ui.notify("researcher 只允许在 plan 模式运行。先 /plan。", "warning"); return; }
  try { assertAdvisoryAgentsUnshadowed(wf.repo); }
  catch (e) { ctx.ui.notify(`拒绝启动 builtin researcher:${(e as Error).message}`, "error"); return; }
  const topic = args.trim() || `围绕需求“${wf.name}”研究相关官方文档、标准、生态实践与近期变化，给出对产品和技术决策有用的外部证据`;
  const outputPath = advisoryOutputPath("researcher");
  const auditPath = reqPath(wf, "results", "research.audit.json");
  fs.writeFileSync(auditPath, JSON.stringify({ status: "launched", agent: "researcher", authority: "advisory", context: "fresh", output: outputPath, repoSnapshot: advisoryRepoSnapshot(wf.repo), launchedAt: new Date().toISOString() }, null, 2) + "\n");
  ctx.ui.notify("将由 builtin researcher 进行外部资料研究(advisory,不修改 Beads)…", "info");
  pi.sendUserMessage([
    `请调用 builtin researcher subagent,为当前 PLAN 阶段生成外部研究简报。`,
    `必须调用: subagent({ agent: "researcher", context: "fresh", cwd: ${JSON.stringify(wf.repo)}, output: ${JSON.stringify(outputPath)}, task: ${JSON.stringify(`${topic}。只做外部研究和只读分析；不要修改项目/source 文件，不要修改 Beads。输出需包含来源链接、证据强度、缺口及其对当前需求的决策含义。`)} })`,
    `不要由主模型代写,不要调用其他 agent。完成后读取并展示 ${outputPath};明确标注它只是 advisory context,不进入 task close/finalize evidence。`,
  ].join("\n"));
}

export async function cmdAnalyze(pi: ExtensionAPI, ctx: ExtensionCommandContext, opts: { silent?: boolean } = {}): Promise<boolean> {
  const wf = currentWorkflow();
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new。", "warning"); return false; }
  if (wf.mode !== "plan") { ctx.ui.notify("scout 只允许在 plan 模式运行。先 /plan。", "warning"); return false; }
  try { assertAdvisoryAgentsUnshadowed(wf.repo); }
  catch (e) { ctx.ui.notify(`拒绝启动 builtin scout:${(e as Error).message}`, "error"); return false; }
  const outputPath = advisoryOutputPath("scout");
  const auditPath = reqPath(wf, "results", "scout.audit.json");
  fs.writeFileSync(auditPath, JSON.stringify({ status: "launched", agent: "scout", authority: "advisory", context: "fresh", output: outputPath, repoSnapshot: advisoryRepoSnapshot(wf.repo), launchedAt: new Date().toISOString() }, null, 2) + "\n");
  if (!opts.silent) ctx.ui.notify("将由 builtin scout 分析仓库(advisory,只读探查)…", "info");
  pi.sendUserMessage([
    `请调用 builtin scout subagent,生成 workflow 仓库简报。`,
    `必须调用: subagent({ agent: "scout", context: "fresh", cwd: ${JSON.stringify(wf.repo)}, output: ${JSON.stringify(outputPath)}, task: ${JSON.stringify(`只读探查当前仓库,为需求“${wf.name}”生成压缩上下文。不要修改项目/source 文件或 Beads；bash 仅可用于只读 inspection。简报必须包含:## 技术栈、## 目录结构与关键模块、## 代码约定、## 相关已有模块、## 建议验证命令(以“建议命令:”开头),并引用具体文件路径。`)} })`,
    `不要由主模型代写,不要调用其他 agent。完成后读取并展示 ${outputPath};若有“建议命令:”则提示用户可用 /wf verify 采用。`,
  ].join("\n"));
  return true;
}

/** /wf prd — delegate PRD generation to a dedicated forked GLM subagent. */
export async function cmdPrd(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const wf = currentWorkflow();
  try { await assertActiveProfileModelsAvailable(ctx); }
  catch (e) { ctx.ui.notify(`模型 profile 不可用:${(e as Error).message}`, "error"); return; }
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new 或 /wf resume。", "warning"); return; }
  if (wf.mode !== "plan") { ctx.ui.notify("只能在 plan 模式生成。先 /plan。", "warning"); return; }
  try { assertWorkflowAgentsUnshadowed(wf.repo); }
  catch (e) { ctx.ui.notify(`拒绝启动 PRD writer:${(e as Error).message}`, "error"); return; }
  if (!readRepoBrief(wf.repo)) {
    ctx.ui.notify("尚无仓库简报,先启动 builtin scout。完成后重新执行 /wf prd。", "info");
    await cmdAnalyze(pi, ctx, { silent: true });
    return;
  }
  const outputPath = reqPath(wf, "prd.md");
  const auditPath = reqPath(wf, "results", "prd-generation.json");
  const briefPath = repoBriefPath(wf.repo);
  const prdModel = workflowAgentModel("pi-workflow.prd-writer");
  const prdEffort = workflowAgentEffort("pi-workflow.prd-writer");
  fs.writeFileSync(auditPath, JSON.stringify({
    status: "launched",
    agent: "pi-workflow.prd-writer",
    profile: CONFIG.activeModelProfile,
    requestedModel: prdModel,
    requestedEffort: prdEffort,
    context: "fork",
    output: outputPath,
    launchedAt: new Date().toISOString(),
  }, null, 2) + "\n");
  ctx.ui.notify(`将由独立 prd-writer subagent(${prdModel},effort=${prdEffort},profile=${CONFIG.activeModelProfile})生成 PRD…`, "info");
  pi.sendUserMessage([
    `请使用 subagent 工具生成当前需求的 PRD。`,
    `必须调用:`,
    `subagent({`,
    `  agent: "pi-workflow.prd-writer",`,
    `  model: ${JSON.stringify(prdModel)},`,
    `  thinking: ${JSON.stringify(prdEffort)},`,
    `  context: "fork",`,,
    `  cwd: ${JSON.stringify(wf.repo)},`,
    `  output: ${JSON.stringify(outputPath)},`,
    `  task: ${JSON.stringify(`为需求 ${wf.name} 生成完整 PRD。读取仓库简报:${briefPath}。基于 fork 上下文中的完整需求讨论,只返回 Markdown PRD 正文。`)}`,
    `})`,
    `不要由当前主模型代写,不要 fallback 到其他模型。subagent 完成后先读取 ${auditPath} 获取实际 resolved provider/model/usage,再读取 ${outputPath},在主 session 中展示实际模型和完整 PRD 正文;失败则原样报告错误。`,
  ].join("\n"));
}

/** /wf oracle — optional advisory consistency review after PRD generation. */
export async function cmdOracle(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const wf = currentWorkflow();
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new 或 /wf resume。", "warning"); return; }
  if (wf.mode !== "plan") { ctx.ui.notify("oracle 只允许在 plan 模式运行。先 /plan。", "warning"); return; }
  const prdPath = reqPath(wf, "prd.md");
  if (!fs.existsSync(prdPath)) { ctx.ui.notify("尚无 PRD。先 /wf prd。", "warning"); return; }
  try { assertAdvisoryAgentsUnshadowed(wf.repo); }
  catch (e) { ctx.ui.notify(`拒绝启动 builtin oracle:${(e as Error).message}`, "error"); return; }
  const outputPath = advisoryOutputPath("oracle");
  const auditPath = reqPath(wf, "results", "prd-oracle.audit.json");
  fs.writeFileSync(auditPath, JSON.stringify({ status: "launched", agent: "oracle", authority: "advisory", context: "fork", output: outputPath, prd: prdPath, repoSnapshot: advisoryRepoSnapshot(wf.repo), launchedAt: new Date().toISOString() }, null, 2) + "\n");
  ctx.ui.notify("将由 builtin oracle 审查 PRD 与既有决策的一致性(advisory)…", "info");
  pi.sendUserMessage([
    `请调用 builtin oracle subagent,对当前 PRD 做可选的一致性审查。`,
    `必须调用: subagent({ agent: "oracle", context: "fork", cwd: ${JSON.stringify(wf.repo)}, output: ${JSON.stringify(outputPath)}, task: ${JSON.stringify(`读取 PRD:${prdPath}、仓库简报:${repoBriefPath(wf.repo)}，以及存在时的外部研究:${reqPath(wf, "results", "research.md")}。依据 fork 对话中的既有需求决策检查范围漂移、矛盾、隐藏假设与遗漏。只读审查，不修改代码或 Beads。明确区分 blocker、建议和无需采纳的意见。`)} })`,
    `不要由主模型代写,不要调用其他 agent。完成后读取并展示 ${outputPath};明确它是 advisory review,不会自动阻止 /execute，也不进入 finalize evidence。`,
  ].join("\n"));
}

/** /wf done — detach the active epic and return to normal Pi. */
