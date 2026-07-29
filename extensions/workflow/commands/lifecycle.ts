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
  extractSuggestedVerifyCommand, assertActiveChildIssue, assertWorkflowAgentsUnshadowed,
  activeModelProfile, assertActiveProfileModelsAvailable, renderedToolName
} from "../runtime.ts";

export function cmdDone(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  if (!wf) { ctx.ui.notify("无活动需求。", "info"); return; }
  const finished = wf;
  // Persist a resumable non-executing mode before clearing the in-memory
  // active context. Beads remains authoritative; /wf resume can select it.
  finished.mode = "plan";
  saveState(finished);
  setWorkflow(undefined);
  setActiveDevToolCallId(undefined);
  resetUsageByModel();
  setModeStatus(ctx);
  applyModeTools(pi, ctx);
  ctx.ui.notify(`已退出需求 ${finished.epicId}(${finished.name})并恢复普通 Pi。需要继续时用 /wf resume 选择 epic。`, "info");
}

export function cmdStatus(ctx: ExtensionCommandContext): void {
  if (!wf) { ctx.ui.notify("无活动需求。/wf new <名字> [repo] 开始。", "info"); return; }
  let lines: string[] = [];
  let summary = "";
  let bdFailed = false;
  try {
    if (wf.epicId) {
      const kids = bd.children(wf.repo, wf.epicId).filter((k: any) => k.issue_type === "task" || k.issue_type === "bug");
      if (kids.length === 0) {
        lines = ["  (无子任务 — 还没 split,或 manager 还没跑到)"];
      } else {
        // Progress summary: count by status.
        const byStatus: Record<string, number> = {};
        for (const k of kids) byStatus[k.status] = (byStatus[k.status] || 0) + 1;
        const closed = byStatus["closed"] || 0;
        summary = `进度:${closed}/${kids.length} 完成` +
          (byStatus["in_progress"] ? `, ${byStatus["in_progress"]} 进行中` : "") +
          (byStatus["open"] ? `, ${byStatus["open"]} 待处理` : "");
        // Per-task detail with latest comment (progress trail).
        const icon: Record<string, string> = { open: "○", in_progress: "◐", closed: "✓", blocked: "●" };
        lines = kids.map((c) => {
          const i = icon[c.status] || "·";
          let line = `  ${i} ${c.id} ${c.title}`;
          // Show latest comment (truncated) for in_progress/open tasks — that's the progress signal.
          if (c.status !== "closed") {
            const cmt = bd.latestComment(wf!.repo, c.id);
            if (cmt) line += `\n      └ ${cmt.slice(0, 100)}`;
          }
          return line;
        });
      }
    }
  } catch (e) {
    // P1 fix: bd being unreachable (Dolt issue, missing binary, corrupt db) used
    // to make progress completely invisible. Fall back to the task ids recorded
    // in state.json — less detail (no live status), but you still know what the
    // split produced and can go look those ids up by hand.
    bdFailed = true;
    const ids = wf.subtaskIds ?? [];
    lines = [
      `  ⚠ 无法读取 bd:${(e as Error).message.split("\n")[0]}`,
      `  降级显示 state.json 记录的子任务 id(无实时状态):`,
      ...(ids.length ? ids.map((id) => `    · ${id}`) : ["    (state.json 里也没有记录的子任务 id)"]),
      `  排查:bd -C ${wf.repo} children ${wf.epicId} --json`,
    ];
  }
  // Cost/cache rollup (P1): read the persisted summary so a run's token spend
  // and DeepSeek cache hit rate are visible, not just task status.
  const usage = readRunSummary(wf);
  const usageLine = usage ? `\n用量 ${formatUsageLine(usage)}` : "";
  ctx.ui.notify(
    `需求 ${wf.reqId}  模式 ${wf.mode}\nepic ${wf.epicId}\n模型 profile ${CONFIG.activeModelProfile} (main=${activeModelProfile().main}, dev=${activeModelProfile().dev}, review=${activeModelProfile().reviewer})` +
    (bdFailed ? "  (bd 不可用,降级模式)" : "") +
    (summary ? `\n${summary}` : "") + usageLine + `\n${lines.join("\n")}`,
    bdFailed ? "warning" : "info",
  );
}

/** /wf resume — select any Beads epic; reconstruct missing local state. */
export async function cmdResume(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  try { await assertActiveProfileModelsAvailable(ctx); }
  catch (e) { ctx.ui.notify(`模型 profile 不可用:${(e as Error).message}`, "error"); return; }
  const arg = args.trim().replace(/["']/g, "");
  if (wf?.mode === "build") {
    ctx.ui.notify(`需求 ${wf.reqId} 正在 build,先 /wf done 或 /wf abort。`, "error");
    return;
  }

  let epics: bd.BdIssue[];
  try {
    epics = bd.list(ctx.cwd, { type: "epic", all: true, limit: 0 });
  } catch (e) {
    ctx.ui.notify(`读取 Beads epic 失败:${(e as Error).message}`, "error");
    return;
  }
  if (epics.length === 0) {
    ctx.ui.notify("当前仓库没有 Beads epic。用 /wf new 创建。", "info");
    return;
  }

  const states = listAllStates(ctx.cwd);
  const byEpic = new Map(states.filter((s) => s.epicId).map((s) => [s.epicId!, s]));
  const rows = epics.map((epic) => {
    let progress = "尚未拆分";
    try {
      const kids = bd.children(ctx.cwd, epic.id).filter((i) => i.issue_type === "task" || i.issue_type === "bug");
      if (kids.length) progress = `${kids.filter((i) => i.status === "closed").length}/${kids.length} 完成`;
    } catch (_e) { progress = "进度未知"; }
    const state = byEpic.get(epic.id);
    const resumability = state ? `[${state.mode === "build" ? "build" : "plan"}]` : "[需重建]";
    return { epic, state, label: `${resumability} ${epic.id}  ${epic.title}  (${progress}, ${epic.status})` };
  });

  let chosen = arg
    ? rows.find((r) => r.epic.id === arg || r.epic.id.includes(arg) || r.epic.title.includes(arg))
    : undefined;
  if (!arg) {
    const label = await ctx.ui.select("选择要恢复的 Beads epic", rows.map((r) => r.label));
    if (!label) return;
    chosen = rows.find((r) => r.label === label);
  }
  if (!chosen) {
    ctx.ui.notify(`找不到 epic:${arg}`, "error");
    return;
  }

  let target = chosen.state;
  if (!target) {
    const rebuild = await ctx.ui.confirm(
      "重建 workflow 上下文?",
      `Epic ${chosen.epic.id} 没有本地 state.json。将从 Beads 重建 plan 上下文和结果目录,不会修改代码。`,
    );
    if (!rebuild) return;
    const reqId = `${nowStamp()}-${slug(chosen.epic.title)}`;
    const kids = bd.children(ctx.cwd, chosen.epic.id).filter((i) => i.issue_type === "task" || i.issue_type === "bug");
    target = {
      reqId,
      name: chosen.epic.title,
      repo: fs.realpathSync(ctx.cwd),
      mode: "plan",
      createdAt: new Date().toISOString(),
      epicId: chosen.epic.id,
      subtaskIds: kids.map((i) => i.id),
    };
    fs.mkdirSync(reqPath(target, "subtasks"), { recursive: true });
    fs.mkdirSync(reqPath(target, "results"), { recursive: true });
  }

  // Normalize historical idle states from older versions.
  if ((target as any).mode === "idle") target.mode = "plan";
  if (!(await useRole(pi, ctx, target.mode === "build" ? CONFIG.roles.split : CONFIG.roles.discuss))) return;
  setWorkflow(target);
  saveState(target);
  resetUsageByModel();
  setModeStatus(ctx);
  applyModeTools(pi, ctx);

  const kids = bd.children(target.repo, chosen.epic.id).filter((i) => i.issue_type === "task" || i.issue_type === "bug");
  const summary = [
    `[workflow resume context — 只恢复上下文,不要自动执行]`,
    `Epic:${chosen.epic.id}`,
    `标题:${chosen.epic.title}`,
    `状态:${chosen.epic.status}`,
    `本地模式:${target.mode}`,
    `PRD:${reqPath(target, "prd.md")}${fs.existsSync(reqPath(target, "prd.md")) ? "(存在)" : "(缺失)"}`,
    `任务:${kids.filter((i) => i.status === "closed").length}/${kids.length} closed; ${kids.filter((i) => i.status === "in_progress").length} in_progress; ${kids.filter((i) => i.status === "open").length} open`,
    `等待用户决定下一步。`,
  ].join("\n");
  pi.sendUserMessage(summary);
  ctx.ui.notify(`已恢复 epic ${chosen.epic.id}:${chosen.epic.title}`, "info");
}

/** /wf bug <描述> — 轻量 bug 修复入口。跳过 PRD,直接建 bd bug + 最小规格,
 *  挂当前需求 epic。如果描述里包含多个独立问题(首先/其次/另外),用 split 模型
 *  自动拆成多个 bug,每个一个规格。然后 /execute 让经理分配 dev 修复。 */
