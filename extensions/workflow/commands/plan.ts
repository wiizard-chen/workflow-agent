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
  CONFIG, wf, baseActiveTools, activeDevToolCallId, mgrHasSplit, mgrTasksProcessed,
  lastAssistantText, usageByModel, loadConfig, setConfig, setWorkflow,
  setBaseActiveTools, setActiveDevToolCallId, setManagerSplit,
  setManagerTasksProcessed, incrementManagerTasksProcessed, setLastAssistantText,
  resetUsageByModel, trackUsage, setModeStatus, applyModeTools, readJson,
  sha256File, ensureRequirementDirs, preservedBaseline, splitDecision,
  validateSubagentCall, listAllStates, extractAssistantText, stripFence,
  extractSubtasksJson, useRole, runStageText, withBrief, analyzePrompt,
  extractSuggestedVerifyCommand, assertActiveChildIssue, assertWorkflowAgentsUnshadowed, renderedToolName
} from "../runtime.ts";

// ---------------------------------------------------------------------------
// PRD mode commands
// ---------------------------------------------------------------------------

export async function cmdNew(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) { ctx.ui.notify("用法:/wf new <需求名> [目标repo路径]", "warning"); return; }
  if (wf && wf.mode === "build") { ctx.ui.notify(`需求 ${wf.reqId} 正在执行中,不能新建。`, "error"); return; }
  const name = parts[0].replace(/["']/g, "");
  let repo = path.resolve(parts[1] ? parts[1].replace(/["']/g, "") : ctx.cwd);
  if (!fs.existsSync(repo)) { ctx.ui.notify(`目标目录不存在:${repo}`, "error"); return; }
  try { repo = fs.realpathSync(repo); } catch (_e) { /* keep */ }
  if (!isGitRepo(repo)) { ctx.ui.notify(`目标不是 git 仓库:${repo}`, "error"); return; }

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
  await useRole(pi, ctx, CONFIG.roles.discuss);
  ctx.ui.notify(`新需求 ${reqId}\n目标 repo: ${repo}\nbd epic: ${epicId}\n已进入 PRD 模式(${CONFIG.roles.discuss.model},只读)。讨论需求,满意后 /wf prd 生成 PRD,再 /execute 执行。`, "info");
}

export async function cmdPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new。", "warning"); return; }
  setActiveDevToolCallId(undefined);
  wf.mode = "plan"; saveState(wf); setModeStatus(ctx); applyModeTools(pi, ctx);
  await useRole(pi, ctx, CONFIG.roles.discuss);
  ctx.ui.notify(`已进入 PRD 模式(只读)。讨论需求,或 /wf prd 生成 PRD。`, "info");
}

export async function cmdAnalyze(pi: ExtensionAPI, ctx: ExtensionCommandContext, opts: { silent?: boolean } = {}): Promise<boolean> {
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new。", "warning"); return false; }
  if (!opts.silent) ctx.ui.notify("分析仓库(deepseek-pro,只读)…", "info");
  const brief = await runStageText(pi, ctx, CONFIG.roles.discuss, analyzePrompt());
  if (!brief) { ctx.ui.notify("仓库分析失败。", "error"); return false; }
  const text = stripFence(brief);
  fs.writeFileSync(repoBriefPath(wf.repo), text + "\n");
  const suggested = extractSuggestedVerifyCommand(text);
  const hint = suggested ? `\n检测到建议验证命令:${suggested}\n可执行 /wf verify ${suggested} 采用。` : "";
  ctx.ui.notify(`仓库简报已生成:${repoBriefPath(wf.repo)}${hint}`, "info");
  return true;
}

/** /wf prd — delegate PRD generation to a dedicated forked GLM subagent. */
export async function cmdPrd(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new 或 /wf resume。", "warning"); return; }
  if (wf.mode !== "plan") { ctx.ui.notify("只能在 plan 模式生成。先 /plan。", "warning"); return; }
  try { assertWorkflowAgentsUnshadowed(wf.repo); }
  catch (e) { ctx.ui.notify(`拒绝启动 PRD writer:${(e as Error).message}`, "error"); return; }
  if (!readRepoBrief(wf.repo)) {
    ctx.ui.notify("尚无仓库简报,先自动分析一次…", "info");
    if (!(await cmdAnalyze(pi, ctx, { silent: true }))) return;
  }
  const outputPath = reqPath(wf, "prd.md");
  const auditPath = reqPath(wf, "results", "prd-generation.json");
  const briefPath = repoBriefPath(wf.repo);
  fs.writeFileSync(auditPath, JSON.stringify({
    status: "launched",
    agent: "pi-workflow.prd-writer",
    requestedModel: "zai/glm-5.2",
    context: "fork",
    output: outputPath,
    launchedAt: new Date().toISOString(),
  }, null, 2) + "\n");
  ctx.ui.notify("将由独立 prd-writer subagent(zai/glm-5.2)生成 PRD…", "info");
  pi.sendUserMessage([
    `请使用 subagent 工具生成当前需求的 PRD。`,
    `必须调用:`,
    `subagent({`,
    `  agent: "pi-workflow.prd-writer",`,
    `  context: "fork",`,
    `  cwd: ${JSON.stringify(wf.repo)},`,
    `  output: ${JSON.stringify(outputPath)},`,
    `  task: ${JSON.stringify(`为需求 ${wf.name} 生成完整 PRD。读取仓库简报:${briefPath}。基于 fork 上下文中的完整需求讨论,只返回 Markdown PRD 正文。`)}`,
    `})`,
    `不要由当前主模型代写,不要 fallback 到其他模型。subagent 完成后先读取 ${auditPath} 获取实际 resolved provider/model/usage,再读取 ${outputPath},在主 session 中展示实际模型和完整 PRD 正文;失败则原样报告错误。`,
  ].join("\n"));
}

/** /wf done — detach the active epic and return to normal Pi. */
