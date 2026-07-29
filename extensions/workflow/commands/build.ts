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
// EXECUTE mode: spawn manager + register dev/test tools
// ---------------------------------------------------------------------------

/** Load the manager system prompt, injecting run context (reqId/repo/epicId/prd).
 *  Optional overrides let /execute point the manager at a different PRD + epic
 *  than the current wf (for /execute <prd-path>). */
/** Load the manager prompt (.pi/manager-prompt.md) + inject run context.
 *  The manager prompt guides the main session through the pipeline in build mode.
 *  It's NOT an agent definition — the main session IS the manager. */
export function loadManagerPrompt(prdPathOverride?: string, epicIdOverride?: string, dryRun = false): string {
  if (!wf) throw new Error("无活动需求");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "..", ".pi", "manager-prompt.md"),
    path.join(here, "..", "..", ".pi", "manager-prompt.md"),
    path.join(process.cwd(), ".pi", "manager-prompt.md"),
  ];
  let template = "";
  for (const c of candidates) {
    if (fs.existsSync(c)) { template = fs.readFileSync(c, "utf8"); break; }
  }
  if (!template) throw new Error("找不到 .pi/manager-prompt.md");
  const prdFile = prdPathOverride || reqPath(wf, "prd.md");
  const epicId = epicIdOverride || wf.epicId;
  if (!epicId) throw new Error("缺少 bd epic id");
  let existingTaskCount = 0;
  try { existingTaskCount = bd.children(wf.repo, epicId).filter((i) => i.issue_type === "task").length; } catch { /* tool will report bd errors */ }
  const context = [
    ``,
    `--- 运行上下文 ---`,
    `需求 ID:${wf.reqId}`,
    `目标仓库:${wf.repo}`,
    `bd epic:${epicId}`,
    `PRD 文件:${prdFile}`,
    `结果文件目录:${reqPath(wf, "results")}(dev/reviewer 的 output JSON 写到这里)`,
    `writer 并行上限:1(安全硬限制;禁止 tasks:[...] 和 worktree:true)`,
    `------------------`,
    ``,
    ...(dryRun
      ? [
          `**DRY-RUN 模式(只拆分,不实现)**`,
          `本次是预演:你只做到"拆分 + 给出计划"就停,**绝对不要派 dev、不要调 subagent、不要改任何代码**。`,
          `步骤:`,
          `1. 读 PRD 文件。`,
          `2. 先 bd_query(children)；只有当前 epic 没有 task 时,由你根据 PRD 形成结构化 subtasks 数组并一次调用 split_prd_to_tasks({prd_path,subtasks})。已有 task 时复用现有图。`,
          `3. 把拆分结果整理成计划:task 标题、依赖、严格串行顺序和风险点。`,
          `4. 然后**停下来**,告诉用户"dry-run 完成,确认计划无误后跑 /execute 正式执行"。`,
          `不要调 bd_task(claim)、不要调 subagent、不要调 run_verify/finalize_test。`,
        ]
      : [
          existingTaskCount > 0
            ? `当前 epic 已有 ${existingTaskCount} 个 task:不要重复 split,先 bd_query(children) 后继续现有 task 循环。`
            : `当前 epic 没有 task:先读 PRD,形成完整 subtasks 数组,一次调用 split_prd_to_tasks({prd_path,subtasks})。`,
          `一口气跑完整条流水线,异常(dev 反复失败/reviewer 多次 fail)才停下问用户。`,
        ]),
  ].join("\n");
  return template + "\n" + context;
}

/** /execute — switch the main session to build mode and trigger the pipeline.
 *  No more spawn of a manager subprocess — the main session runs the pipeline
 *  itself (interactive, user can watch + intervene via /wf status).
 *  Optional prdPath arg points at a specific PRD (auto-creates a fresh epic). */
export async function cmdExecute(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string = ""): Promise<void> {
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new。", "warning"); return; }
  if (!wf.epicId) { ctx.ui.notify("缺少 bd epic id。", "error"); return; }
  try { assertWorkflowAgentsUnshadowed(wf.repo); }
  catch (e) { ctx.ui.notify(`拒绝进入 build:${(e as Error).message}`, "error"); return; }
  const verifyCommand = getVerifyCommand(CONFIG, wf);
  if (!verifyCommand) {
    ctx.ui.notify("无法进入 build:未配置验证命令。请先执行 /wf verify <cmd>。空命令不允许跳过。", "error");
    return;
  }

  // Parse args: optional `--dry-run` flag + optional PRD path.
  // dry-run (P1) = split the PRD into bd tasks and report the plan, but never
  // dispatch dev/reviewer subagents or touch code. Lets you sanity-check the
  // breakdown before a system that self-commits starts writing.
  const rawArgs = args.trim().replace(/["']/g, "");
  const dryRun = /(^|\s)--dry-run(\s|$)/.test(rawArgs);
  const prdArg = rawArgs.replace(/(^|\s)--dry-run(\s|$)/, " ").trim();
  let prdPath = "";
  let epicIdOverride = "";
  if (prdArg) {
    prdPath = path.resolve(ctx.cwd, prdArg);
    if (!fs.existsSync(prdPath)) { ctx.ui.notify(`PRD 文件不存在:${prdPath}`, "error"); return; }
    // External PRD → auto-create a fresh epic (named after the file).
    const epicTitle = path.basename(prdPath, ".md");
    try {
      epicIdOverride = bd.create(wf.repo, { title: epicTitle, type: "epic" });
    } catch (e) {
      ctx.ui.notify(`为外部 PRD 建 epic 失败:${(e as Error).message}`, "error"); return;
    }
    const originalPath = prdPath;
    wf.reqId = `${nowStamp()}-${slug(epicTitle)}`;
    wf.epicId = epicIdOverride;
    wf.name = epicTitle;
    wf.subtaskIds = [];
    wf.baseline = undefined;
    resetUsageByModel();
    setActiveDevToolCallId(undefined);
    ensureRequirementDirs(wf);
    const canonicalPrdPath = reqPath(wf, "prd.md");
    fs.copyFileSync(originalPath, canonicalPrdPath);
    prdPath = canonicalPrdPath;
    ctx.ui.notify(`外部 PRD:${originalPath}\n已复制到:${canonicalPrdPath}\n活动 epic:${epicIdOverride}(${epicTitle})`, "info");
  } else {
    prdPath = reqPath(wf, "prd.md");
    if (!fs.existsSync(prdPath)) { ctx.ui.notify("还没有 PRD。先 /wf prd 生成。", "error"); return; }
    const audit = readJson(reqPath(wf, "results", "prd-generation.json"));
    if (!audit || audit.status !== "completed" || audit.resolvedModel !== "zai/glm-5.2"
      || audit.context !== "fork" || audit.outputSha256 !== sha256File(prdPath)) {
      ctx.ui.notify("PRD 缺少有效的 prd-writer GLM 审计,或生成后已被修改。请重新 /wf prd；外部 PRD 请显式传路径给 /execute。", "error");
      return;
    }
  }

  // Switch to build mode + lock the executor toolset.
  wf.mode = "build";
  wf.baseline = preservedBaseline(wf.baseline, gitHead(wf.repo));
  wf.managerNoop = false;
  setManagerSplit(false);
  setManagerTasksProcessed(0);
  saveState(wf);
  setModeStatus(ctx);
  applyModeTools(pi, ctx);

  // Dirty-tree check only matters when we're about to actually write code.
  // A dry-run never dispatches dev, so uncommitted work is harmless.
  if (!dryRun) {
    const dirty = sh("git", ["status", "--porcelain", "--", ".", ":!.workflow"], wf.repo).stdout.trim();
    if (dirty) {
      const go = await ctx.ui.confirm("工作树不干净", "目标 repo 有未提交改动,建议先提交。仍要继续?");
      if (!go) { wf.mode = "plan"; saveState(wf); setModeStatus(ctx); applyModeTools(pi, ctx); return; }
    }
  }

  // Switch to the split/reasoning model for orchestration, then inject the
  // manager prompt as a user message — the main session LLM picks it up and
  // starts running the pipeline (split → pi-workflow.dev → pi-workflow.reviewer → ...).
  await useRole(pi, ctx, CONFIG.roles.split);
  const prompt = loadManagerPrompt(prdPath || undefined, wf.epicId, dryRun);
  ctx.ui.notify(
    dryRun
      ? `EXECUTE --dry-run:只拆分 + 汇报计划,不派 dev、不改代码。\n拆分结果会真的建成 bd task(方便审阅依赖图),确认无误后跑 /execute 正式执行;不满意可 /wf abort 清理。`
      : `EXECUTE:主 session 进入 build 模式,开始跑流水线(拆 task → 派 dev/reviewer → 测试)。\n用 /wf status 看进度。跑完 /wf done 切回通用模式,跑歪了可 /wf abort 回滚到 baseline。`,
    "info",
  );
  pi.sendUserMessage(prompt);
  // cmdExecute returns here — the pipeline runs asynchronously in the main session.
  // The user can watch it unfold and intervene; /wf done ends it.
}

/** /wf abort — roll the target repo back to the baseline recorded at /execute
 *  time and reopen every bd task under the epic (P1 fix: `wf.baseline` was
 *  recorded but nothing ever used it, so a run that went the wrong way could
 *  only be undone by hand).
 *
 *  This is destructive: it hard-resets the repo's code commits made since
 *  baseline. Requires explicit confirmation and reports exactly what it will
 *  discard first. `.workflow/` artifacts are preserved (they're the audit
 *  trail — a separate commit anyway). */
export async function cmdAbort(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!wf) { ctx.ui.notify("无活动需求。", "warning"); return; }
  if (!wf.baseline) {
    ctx.ui.notify("这个需求没有记录 baseline(可能从未 /execute 过),无法回滚。", "error");
    return;
  }
  const head = gitHead(wf.repo);
  if (head === wf.baseline) {
    ctx.ui.notify(`HEAD 已经在 baseline (${wf.baseline.slice(0, 8)}),没有代码改动需要回滚。`, "info");
  }

  // Show exactly what would be discarded before asking.
  const log = sh("git", ["log", "--oneline", `${wf.baseline}..HEAD`], wf.repo).stdout.trim();
  const stat = sh("git", ["diff", "--stat", wf.baseline, "HEAD"], wf.repo).stdout.trim();
  const dirty = sh("git", ["status", "--porcelain", "--", ".", ":!.workflow"], wf.repo).stdout.trim();

  const preview = [
    `目标 repo:${wf.repo}`,
    `baseline:${wf.baseline.slice(0, 8)}   当前 HEAD:${head?.slice(0, 8) ?? "?"}`,
    ``,
    log ? `将丢弃的 commit:\n${log}` : `(baseline..HEAD 之间没有 commit)`,
    stat ? `\n改动统计:\n${stat}` : "",
    dirty ? `\n⚠ 还有未提交改动,也会被一并丢弃:\n${dirty}` : "",
  ].filter(Boolean).join("\n");

  ctx.ui.notify(`/wf abort 预览:\n${preview}`, "warning");
  const go = await ctx.ui.confirm(
    "确认回滚?(不可逆)",
    `将 git reset --hard 到 baseline ${wf.baseline.slice(0, 8)},丢弃上面列出的代码 commit 和未提交改动,并把 epic ${wf.epicId} 下的 task 全部 reopen。.workflow/ 工件会保留。确定继续?`,
  );
  if (!go) { ctx.ui.notify("已取消,未做任何改动。", "info"); return; }

  // 1) Roll back code. Keep .workflow/ artifacts by stashing them out of the way:
  //    reset --hard would nuke uncommitted artifact changes too, so commit them
  //    first (they're the audit trail of what just happened).
  commitArtifacts(wf);
  const reset = sh("git", ["reset", "--hard", wf.baseline], wf.repo);
  if (reset.code !== 0) {
    ctx.ui.notify(`git reset --hard 失败:\n${reset.stderr || reset.stdout}`, "error");
    return;
  }

  // 2) Reopen every non-closed-by-design task under the epic so the pipeline
  //    can be re-run from a clean slate.
  let reopened = 0;
  let bdError = "";
  try {
    if (wf.epicId) {
      const kids = bd.children(wf.repo, wf.epicId).filter((k: any) => k.issue_type === "task" || k.issue_type === "bug");
      for (const k of kids) {
        if (k.status === "open") continue;   // already ready
        try {
          bd.reopen(wf.repo, k.id);
          bd.comment(wf.repo, k.id, `[abort] 需求回滚到 baseline ${wf.baseline!.slice(0, 8)},task 已重置为 open`);
          reopened++;
        } catch (_e) { /* keep going; report the count we managed */ }
      }
    }
  } catch (e) { bdError = (e as Error).message.split("\n")[0]; }

  // 3) Return to plan mode after rollback; the epic remains active.
  setActiveDevToolCallId(undefined);
  wf.mode = "plan";
  saveState(wf);
  setModeStatus(ctx);
  applyModeTools(pi, ctx);

  ctx.ui.notify(
    `已回滚到 baseline ${wf.baseline.slice(0, 8)}。\n` +
    `- 代码:git reset --hard 完成(HEAD 现在是 ${gitHead(wf.repo)?.slice(0, 8) ?? "?"})\n` +
    `- bd:reopen 了 ${reopened} 个 task${bdError ? `(bd 读取有问题:${bdError})` : ""}\n` +
    `- .workflow/ 工件已保留(回滚前先提交了一次,作为审计记录)\n` +
    `- 模式:已切回 plan\n` +
    `想重跑:修订 PRD 后 /execute,或先 /execute --dry-run 看计划。`,
    "info",
  );
}

