/**
 * workflow — a pi coding-agent extension implementing a plan/build requirement pipeline.
 *
 * Design notes:
 * - pi-side stages (PRD / split / review) DO NOT rely on the model's write tool.
 *   The model returns content as text; the EXTENSION writes the artifact files.
 *   This is deterministic and immune to tool-calling quirks.
 * - While a workflow is active, pi's tools are restricted to read-only
 *   (read/grep/find/ls), so the discussion/plan phases can never touch real
 *   code. Only reasonix writes code, in its own process, during BUILD.
 *
 * PLAN mode: discuss with deepseek-pro; `/wf draft` => glm-5.2 writes prd.md,
 *   deepseek-pro emits the subtask breakdown (subtasks/*.md + index.json).
 * BUILD mode: `/build` => per subtask reasonix run (deepseek-flash) + verify +
 *   one code commit; stop on failure, skip dependents; then glm-5.2 review.md.
 *
 * Load:  pi -e ./workflow/extensions/workflow.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  buildReasonixArgs,
  type BuildResult,
  commitArtifacts,
  isGitRepo,
  gitHead,
  nowStamp,
  readRepoBrief,
  repoBriefPath,
  reqPath,
  type RoleRef,
  runBuildPipeline,
  runVerify,
  saveState,
  sh,
  slug,
  type SubtaskState,
  type WorkflowConfig,
  type WorkflowState,
} from "./lib.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: WorkflowConfig = {
  providers: {
    deepseek: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", api: "openai-completions", thinkingFormat: "deepseek" },
    zai: { baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKeyEnv: "GLM_API_KEY", api: "openai-completions", thinkingFormat: "zai" },
  },
  roles: {
    discuss: { provider: "deepseek", model: "deepseek-v4-pro" },
    prd: { provider: "zai", model: "glm-5.2" },
    split: { provider: "deepseek", model: "deepseek-v4-pro" },
    review: { provider: "zai", model: "glm-5.2" },
  },
  reasonix: { bin: "reasonix", model: "deepseek-flash", maxSteps: 0, timeoutMs: 1800000 },
  build: { verifyCommand: "", commitPrefix: "subtask" },
};

function loadConfig(): WorkflowConfig {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, "..", "workflow.config.json"),
      path.join(here, "workflow.config.json"),
      path.join(process.cwd(), "workflow.config.json"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const raw = JSON.parse(fs.readFileSync(c, "utf8"));
        return {
          providers: { ...DEFAULT_CONFIG.providers, ...(raw.providers || {}) },
          roles: { ...DEFAULT_CONFIG.roles, ...(raw.roles || {}) },
          reasonix: { ...DEFAULT_CONFIG.reasonix, ...(raw.reasonix || {}) },
          build: { ...DEFAULT_CONFIG.build, ...(raw.build || {}) },
        };
      }
    }
  } catch (_e) { /* defaults */ }
  return DEFAULT_CONFIG;
}

const READONLY_TOOLS = ["read", "grep", "find", "ls"];

let CONFIG = loadConfig();
let wf: WorkflowState | undefined;
let lastAssistantText = "";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait for the turn triggered by sendUserMessage to fully settle. Polls
 * isIdle(): first wait for the turn to start, then wait until the agent stays
 * idle for a settle window — this tolerates pi's error-retry (error turn ->
 * automatic retry -> success), which would otherwise be seen as completion.
 */
async function waitTurnComplete(ctx: ExtensionCommandContext, maxMs = 600000): Promise<void> {
  const start = Date.now();
  while (ctx.isIdle() && Date.now() - start < 10000) await sleep(200); // wait for start
  let idleSince: number | null = null;
  while (Date.now() - start < maxMs) {
    if (ctx.isIdle()) {
      if (idleSince === null) idleSince = Date.now();
      else if (Date.now() - idleSince > 2500) return;
    } else idleSince = null;
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// pi-side helpers
// ---------------------------------------------------------------------------

function setModeStatus(ctx: ExtensionCommandContext): void {
  const label = wf ? `WF:${wf.mode} ${wf.reqId}` : "WF:—";
  try { ctx.ui.setStatus("workflow", label); } catch (_e) { /* ignore */ }
}

function lockReadonly(pi: ExtensionAPI): void {
  try {
    // Keep the read-only built-ins, plus any MCP-bridged tools registered by the
    // pi-mcp extension (server_toolName, e.g. playwright_browser_navigate) so
    // PLAN-mode discussion/analyze can browse the web without gaining write
    // access to the target repo's real files. pi-mcp registers one server per
    // .mcp.json entry; we don't hardcode names, we detect by prefix.
    const mcpServerNames = Object.keys(readMcpServers());
    const allNames = pi.getAllTools().map((t) => t.name);
    const mcpTools = allNames.filter((n) => mcpServerNames.some((s) => n.startsWith(`${s}_`)) || n.startsWith("mcp__"));
    pi.setActiveTools([...READONLY_TOOLS, ...mcpTools]);
  } catch (_e) { /* ignore */ }
}

function readMcpServers(): Record<string, unknown> {
  try {
    // .mcp.json lives next to workflow.config.json (the framework directory),
    // not process.cwd() — pi's cwd at launch is whatever directory the user
    // happened to be in, which is not necessarily where this extension (and
    // its .mcp.json) lives.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [path.join(here, "..", ".mcp.json"), path.join(here, ".mcp.json")];
    for (const p of candidates) {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  } catch (_e) { /* ignore */ }
  return {};
}

function extractAssistantText(messages: any[]): string {
  let out = "";
  for (const m of messages || []) {
    if (!m || m.role !== "assistant") continue;
    const c = m.content;
    if (typeof c === "string") out = c;
    else if (Array.isArray(c)) out = c.filter((p) => p && p.type === "text").map((p) => p.text).join("");
  }
  return out.trim();
}

function stripFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

function extractJson(text: string): any | undefined {
  const stripped = stripFence(text);
  try { return JSON.parse(stripped); } catch (_e) { /* try to find a JSON object */ }
  const s = stripped.indexOf("{");
  const e = stripped.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try { return JSON.parse(stripped.slice(s, e + 1)); } catch (_e) { /* ignore */ }
  }
  return undefined;
}

async function useRole(pi: ExtensionAPI, ctx: ExtensionCommandContext, role: RoleRef): Promise<boolean> {
  const model = ctx.modelRegistry.find(role.provider, role.model);
  if (!model) { ctx.ui.notify(`模型未找到:${role.provider}/${role.model}(检查 provider 注册与 API key)`, "error"); return false; }
  const ok = await pi.setModel(model);
  if (!ok) ctx.ui.notify(`无法切换到 ${role.provider}/${role.model}:缺少 API key`, "error");
  return ok;
}

/** Run one LLM stage and return its assistant text; retries on empty output
 *  (transient provider/network errors such as "Connection error."). */
async function runStageText(pi: ExtensionAPI, ctx: ExtensionCommandContext, role: RoleRef, prompt: string, attempts = 3): Promise<string | null> {
  await ctx.waitForIdle(); // ensure any prior turn finished (commands run even mid-stream)
  if (!(await useRole(pi, ctx, role))) return null;
  for (let i = 0; i < attempts; i++) {
    lastAssistantText = "";
    pi.sendUserMessage(prompt);
    await waitTurnComplete(ctx);
    if (lastAssistantText) return lastAssistantText;
    if (i < attempts - 1) { ctx.ui.notify(`  ↻ 模型无输出(可能瞬时错误),重试 ${i + 2}/${attempts}…`, "warning"); await sleep(1500); }
  }
  return null;
}

function registerProviders(pi: ExtensionAPI): void {
  const byProvider = new Map<string, Set<string>>();
  for (const role of Object.values(CONFIG.roles)) {
    if (!byProvider.has(role.provider)) byProvider.set(role.provider, new Set());
    byProvider.get(role.provider)!.add(role.model);
  }
  for (const [provName, modelIds] of byProvider) {
    const p = CONFIG.providers[provName];
    if (!p) continue;
    const models = [...modelIds].map((id) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: id.startsWith("deepseek") ? 1000000 : 200000,
      maxTokens: 8192,
      compat: p.thinkingFormat ? ({ thinkingFormat: p.thinkingFormat } as any) : undefined,
    }));
    pi.registerProvider(provName, { baseUrl: p.baseUrl, apiKey: `$${p.apiKeyEnv}`, api: p.api as any, models });
  }
}

// ---------------------------------------------------------------------------
// Prompts (stages return content as text; the extension writes the files)
// ---------------------------------------------------------------------------

/** Prepend the repo-level steering brief (if present) so the model doesn't
 *  start from zero knowledge of the target repo. Absent brief => no-op. */
function withBrief(repo: string, body: string): string {
  const brief = readRepoBrief(repo);
  if (!brief) return body;
  return [
    `以下是对目标仓库的分析简报(供你参考,不要重复分析仓库):`,
    `--- 仓库简报 开始 ---`,
    brief.trim(),
    `--- 仓库简报 结束 ---`,
    ``,
    body,
  ].join("\n");
}

function analyzePrompt(): string {
  return [
    `你是资深技术负责人,第一次接触这个仓库。用只读工具(read/grep/find/ls)探查这个仓库,产出一份分析简报。`,
    `直接把简报的 Markdown 正文作为你的回答输出(不要用工具写文件,不要用代码块包裹,不要额外解释)。`,
    `简报需包含以下几节,每节给具体事实(文件名/路径/命令),不要泛泛而谈:`,
    `## 技术栈`,
    `语言、框架、主要依赖(从 package.json / go.mod / requirements.txt / Cargo.toml 等实际文件读出来)。`,
    `## 目录结构与关键模块`,
    `顶层目录职责;入口文件;核心业务逻辑在哪;测试在哪。`,
    `## 代码约定`,
    `命名风格、测试框架、格式化/lint 工具;如果有 CONTRIBUTING/AGENTS.md/CLAUDE.md 之类的约定文档,摘要其要点。`,
    `## 相关已有模块`,
    `扫一眼有没有和"常见新需求"可能重叠或可复用的现有模块(不确定就写"未发现明显相关模块",不要编)。`,
    `## 建议验证命令`,
    `从 package.json scripts / Makefile / CI 配置等找到的构建或测试命令,给出一条最合适的(如 \`npm test\`、\`go build ./... && go test ./...\`);找不到就写"未发现,建议留空"。这一行必须以 \`建议命令:\` 开头,后面跟命令本身(找不到则写"未发现")。`,
  ].join("\n");
}

/** Parse the "建议命令: <cmd>" line out of the analyze stage's output, if present. */
function extractSuggestedVerifyCommand(brief: string): string | undefined {
  const m = brief.match(/建议命令[:：]\s*`?([^\n`]+)`?/);
  if (!m) return undefined;
  const cmd = m[1].trim();
  if (!cmd || /未发现|建议留空|none|n\/a/i.test(cmd)) return undefined;
  return cmd;
}

function prdPrompt(repo: string): string {
  return withBrief(repo, [
    `你是资深产品经理。基于本会话上文的需求讨论,产出一份专业的 PRD。`,
    `直接把 PRD 的 Markdown 正文作为你的回答输出(不要使用任何工具,不要用代码块包裹,不要额外解释)。`,
    `PRD 需包含:背景/目标、范围(含明确的非目标)、功能点/用户故事、可测试的验收标准、技术约束/依赖、风险。`,
  ].join("\n"));
}

function splitPrompt(repo: string, reqId: string): string {
  return withBrief(repo, [
    `你是技术负责人。基于本会话上文的需求与 PRD,把需求拆成一组尽量独立、可单独实现与验证的子任务。`,
    `只输出一个严格 JSON(不要任何解释、不要代码块包裹),格式:`,
    `{"subtasks":[{"id":"01","title":"简短标题","depends_on":[],"spec":"该子任务的完整 Markdown 规格:目标/改动范围与文件/详细实现说明/可验证的验收标准"}]}`,
    `要求:id 从 "01" 递增;depends_on 用其它子任务 id 表示先后依赖;数组顺序即执行顺序(被依赖者在前);粒度适中,每个子任务是一个可独立提交的改动;避免循环依赖。`,
    `(reqId=${reqId};spec 字段是字符串,内部换行用 \\n 转义。)`,
  ].join("\n"));
}

function reviewPrompt(s: WorkflowState): string {
  return withBrief(s.repo, [
    `你是资深代码审查者。对整个需求的实现做一次整体 review。`,
    `请用 read 工具读取以下文件后再评审:`,
    `- PRD:${reqPath(s, "prd.md")}`,
    `- 子任务清单:${reqPath(s, "subtasks", "index.json")}`,
    `- 全量累积改动 diff:${reqPath(s, "results", "cumulative.diff")}`,
    `然后把 review 报告的 Markdown 正文作为你的回答直接输出(不要用 write/edit,不要代码块包裹)。`,
    `报告包含:1) 总体结论(是否符合 PRD、是否有缺失验收项);2) 问题清单,每条 文件:行 + 严重程度(blocker/major/minor)+ 说明;3) 子任务间集成/一致性问题;4) 建议(仅建议)。`,
  ].join("\n"));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdNew(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) { ctx.ui.notify("用法:/wf new <需求名> [目标repo路径]", "warning"); return; }
  const name = parts[0].replace(/["']/g, "");
  let repo = path.resolve(parts[1] ? parts[1].replace(/["']/g, "") : ctx.cwd);
  if (!fs.existsSync(repo)) { ctx.ui.notify(`目标目录不存在:${repo}`, "error"); return; }
  try { repo = fs.realpathSync(repo); } catch (_e) { /* keep resolved */ } // canonicalize (macOS /var -> /private/var)
  if (!isGitRepo(repo)) { ctx.ui.notify(`目标不是 git 仓库:${repo}(请先 git init)`, "error"); return; }

  const reqId = `${nowStamp()}-${slug(name)}`;
  wf = { reqId, name, repo, mode: "plan", createdAt: new Date().toISOString(), subtasks: [] };
  fs.mkdirSync(reqPath(wf, "subtasks"), { recursive: true });
  fs.mkdirSync(reqPath(wf, "results"), { recursive: true });
  saveState(wf);
  setModeStatus(ctx);
  lockReadonly(pi);
  await useRole(pi, ctx, CONFIG.roles.discuss);
  ctx.ui.notify(`新需求 ${reqId}\n目标 repo: ${repo}\n已进入 PLAN 模式(${CONFIG.roles.discuss.provider}/${CONFIG.roles.discuss.model},pi 工具只读)。讨论需求,满意后 /wf draft 生成计划。`, "info");
}

async function cmdPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!wf) { ctx.ui.notify("没有活动需求。先运行 /wf new <名字> [repo]。", "warning"); return; }
  wf.mode = "plan"; saveState(wf); setModeStatus(ctx); lockReadonly(pi);
  await useRole(pi, ctx, CONFIG.roles.discuss);
  ctx.ui.notify(`已进入 PLAN 模式(对代码只读)。讨论需求,或 /wf draft 生成/刷新计划。`, "info");
}

async function cmdAnalyze(pi: ExtensionAPI, ctx: ExtensionCommandContext, opts: { silent?: boolean } = {}): Promise<boolean> {
  if (!wf) { ctx.ui.notify("没有活动需求。先运行 /wf new。", "warning"); return false; }
  if (!opts.silent) ctx.ui.notify("分析仓库(deepseek-pro,只读探查)…", "info");
  const brief = await runStageText(pi, ctx, CONFIG.roles.discuss, analyzePrompt());
  if (!brief) { ctx.ui.notify("仓库分析失败(模型无输出)。", "error"); return false; }
  const text = stripFence(brief);
  fs.writeFileSync(repoBriefPath(wf.repo), text + "\n");
  const suggested = extractSuggestedVerifyCommand(text);
  const hint = suggested ? `\n检测到建议验证命令:${suggested}\n可执行 /wf verify ${suggested} 采用。` : "";
  ctx.ui.notify(`仓库简报已生成:${repoBriefPath(wf.repo)}(后续需求自动复用,除非 /wf analyze --refresh 重新分析)${hint}`, "info");
  return true;
}

async function cmdDraft(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!wf) { ctx.ui.notify("没有活动需求。先运行 /wf new。", "warning"); return; }
  if (wf.mode !== "plan") { ctx.ui.notify("只能在 PLAN 模式生成计划。先 /plan。", "warning"); return; }

  if (!readRepoBrief(wf.repo)) {
    ctx.ui.notify("尚无仓库简报,先自动分析一次(仅需一次,后续需求复用)…", "info");
    if (!(await cmdAnalyze(pi, ctx, { silent: true }))) return;
  }

  ctx.ui.notify("① 生成 PRD(glm-5.2)…", "info");
  const prd = await runStageText(pi, ctx, CONFIG.roles.prd, prdPrompt(wf.repo));
  if (!prd) { ctx.ui.notify("PRD 生成失败(模型无输出)。", "error"); return; }
  fs.writeFileSync(reqPath(wf, "prd.md"), stripFence(prd) + "\n");

  ctx.ui.notify("② 拆分子任务(deepseek-pro)…", "info");
  const splitText = await runStageText(pi, ctx, CONFIG.roles.split, splitPrompt(wf.repo, wf.reqId));
  const parsed = splitText ? extractJson(splitText) : undefined;
  const rawSubs = parsed && Array.isArray(parsed.subtasks) ? parsed.subtasks : undefined;
  if (!rawSubs || rawSubs.length === 0) { ctx.ui.notify("子任务拆分失败(未得到有效 JSON)。可再试一次 /wf draft。", "error"); return; }

  // Extension writes the subtask specs + index.json.
  const subs: SubtaskState[] = [];
  const index: any = { subtasks: [] };
  for (let i = 0; i < rawSubs.length; i++) {
    const r = rawSubs[i];
    const id = String(r.id ?? String(i + 1).padStart(2, "0"));
    const title = String(r.title ?? `subtask ${id}`);
    const file = `subtasks/${id}-${slug(title)}.md`;
    const depends_on = Array.isArray(r.depends_on) ? r.depends_on.map(String) : [];
    fs.writeFileSync(reqPath(wf, file), `# ${title}\n\n${String(r.spec ?? "").replace(/\r/g, "")}\n`);
    index.subtasks.push({ id, title, file, depends_on });
    subs.push({ id, title, file, depends_on, status: "pending" });
  }
  fs.writeFileSync(reqPath(wf, "subtasks", "index.json"), JSON.stringify(index, null, 2));
  wf.subtasks = subs; saveState(wf);

  await useRole(pi, ctx, CONFIG.roles.discuss);
  const lines = subs.map((t) => `  ${t.id} ${t.title}${t.depends_on.length ? ` (依赖 ${t.depends_on.join(",")})` : ""}`);
  ctx.ui.notify(`计划已生成:\n- PRD: ${reqPath(wf, "prd.md")}\n- 子任务(${subs.length}):\n${lines.join("\n")}\n\n审阅 prd.md 与 subtasks/。不满意继续讨论后再 /wf draft;满意则 /build。`, "info");
}

async function cmdBuild(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string = ""): Promise<void> {
  if (!wf) { ctx.ui.notify("没有活动需求。先运行 /wf new。", "warning"); return; }
  if (!wf.subtasks || wf.subtasks.length === 0) { ctx.ui.notify("没有可执行的计划。先在 PLAN 模式 /wf draft。", "warning"); return; }

  const fresh = args.trim() === "--fresh";
  if (fresh) {
    // Full rerun: clear every subtask's status so nothing is treated as already done.
    for (const t of wf.subtasks) { t.status = "pending"; t.commit = undefined; t.note = undefined; }
  } else {
    // Resumable (default): subtasks left over from a prior run in "failed" or
    // "skipped" state are retried; "done"/"no-change" are left alone so
    // runBuildPipeline skips re-executing them. Only clear stale skip/fail
    // notes so a subtask that failed last time gets a clean retry attempt.
    for (const t of wf.subtasks) {
      if (t.status === "failed" || t.status === "skipped") { t.status = "pending"; t.note = undefined; }
    }
  }
  wf.mode = "build";
  wf.baseline = gitHead(wf.repo);
  saveState(wf); setModeStatus(ctx);

  const dirty = sh("git", ["status", "--porcelain", "--", ".", ":!.workflow"], wf.repo).stdout.trim();
  if (dirty) {
    const go = await ctx.ui.confirm("工作树不干净", "目标 repo 有未提交代码改动,建议先提交/清理再 build。仍要继续吗?");
    if (!go) { wf.mode = "plan"; saveState(wf); setModeStatus(ctx); return; }
  }

  const alreadyDone = wf.subtasks.filter((t) => t.status === "done" || t.status === "no-change").length;
  ctx.ui.notify(
    `BUILD 开始:${wf.subtasks.length} 个子任务,串行执行(reasonix / ${CONFIG.reasonix.model})。` +
      (fresh ? "(--fresh:全量重跑)" : alreadyDone > 0 ? `(断点续跑:${alreadyDone} 个已完成将跳过;用 /build --fresh 强制全量重跑)` : ""),
    "info",
  );

  const result: BuildResult = await runBuildPipeline(wf, CONFIG, {
    execReasonix: async (t: SubtaskState) => {
      fs.mkdirSync(reqPath(wf!, "results"), { recursive: true });
      const args = buildReasonixArgs(CONFIG, wf!, t);
      const res = await pi.exec(CONFIG.reasonix.bin, args, { cwd: wf!.repo, timeout: CONFIG.reasonix.timeoutMs });
      return { code: res.code };
    },
    verify: (s) => runVerify(CONFIG, s),
    notify: (msg, level) => ctx.ui.notify(msg, level),
    save: saveState,
  });

  if (result.fail > 0) {
    ctx.ui.notify(`BUILD 中止:成功 ${result.ok + result.noChange} / 失败 ${result.fail} / 跳过 ${result.skip}。\n修复后可 /plan 修订或手动处理,再 /build。跳过 review(实现未完成)。`, "error");
    setModeStatus(ctx);
    return;
  }

  ctx.ui.notify(`所有子任务完成(${result.ok + result.noChange})。开始整体 review(glm-5.2)…`, "info");
  const review = await runStageText(pi, ctx, CONFIG.roles.review, reviewPrompt(wf));
  if (review) fs.writeFileSync(reqPath(wf, "review.md"), stripFence(review) + "\n");
  const art = commitArtifacts(wf);
  const avg = result.summary?.totals?.avgCacheHit;
  ctx.ui.notify(
    `BUILD 完成。\n- review: ${reqPath(wf, "review.md")}\n- 汇总: ${reqPath(wf, "results", "summary.json")}` +
      (avg != null ? `(平均 cache 命中 ${(avg <= 1 ? avg * 100 : avg).toFixed(2)}%)` : "") +
      (art.committed ? `\n- 工件已提交 ${art.sha?.slice(0, 8)}` : "") +
      `\n请阅读 review.md 决定后续;需修订可 /plan。`,
    "info",
  );
  setModeStatus(ctx);
}

function cmdStatus(ctx: ExtensionCommandContext): void {
  if (!wf) { ctx.ui.notify("无活动需求。/wf new <名字> [repo] 开始。", "info"); return; }
  const lines = wf.subtasks.map((t) => `  ${t.id} [${t.status}] ${t.title}${t.commit ? ` (${t.commit.slice(0, 8)})` : ""}`);
  ctx.ui.notify(`需求 ${wf.reqId}\n模式 ${wf.mode}\nrepo ${wf.repo}\n验证命令 ${(wf.verifyCommand ?? CONFIG.build.verifyCommand) || "(无)"}\n子任务:\n${lines.join("\n") || "  (尚未拆分)"}`, "info");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default function workflowExtension(pi: ExtensionAPI): void {
  CONFIG = loadConfig();
  registerProviders(pi);

  pi.on("session_start", async (_e, ctx) => { setModeStatus(ctx as any); });

  // Make the bundled skill(s) discoverable even when loaded via `pi -e workflow.ts`.
  pi.on("resources_discover", async () => {
    try {
      const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
      if (fs.existsSync(dir)) return { skillPaths: [dir] };
    } catch (_e) { /* ignore */ }
    return {};
  });

  // Capture assistant text from completed turns (ignore empty/error turns so a
  // failed attempt that pi auto-retries doesn't clobber the successful text).
  pi.on("agent_end", async (event: any) => {
    try { const t = extractAssistantText(event?.messages); if (t) lastAssistantText = t; } catch (_e) { /* ignore */ }
  });

  pi.registerCommand("wf", {
    description: "workflow 流水线:new / analyze / draft / status / verify / help",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["new", "analyze", "draft", "status", "verify", "help"];
      const f = subs.filter((s) => s.startsWith(prefix));
      return f.length ? f.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const sub = trimmed.split(/\s+/)[0] || "help";
      const rest = trimmed.slice(sub.length).trim();
      switch (sub) {
        case "new": await cmdNew(pi, ctx, rest); break;
        case "analyze": {
          if (!wf) { ctx.ui.notify("无活动需求。先 /wf new。", "warning"); break; }
          if (readRepoBrief(wf.repo) && rest !== "--refresh") {
            ctx.ui.notify(`仓库简报已存在:${repoBriefPath(wf.repo)}\n如需重新分析,用 /wf analyze --refresh。`, "info");
            break;
          }
          await cmdAnalyze(pi, ctx);
          break;
        }
        case "draft": await cmdDraft(pi, ctx); break;
        case "status": cmdStatus(ctx); break;
        case "verify":
          if (!wf) { ctx.ui.notify("无活动需求。", "warning"); break; }
          wf.verifyCommand = rest; saveState(wf);
          ctx.ui.notify(`已设置验证命令:${rest || "(清空)"}`, "info");
          break;
        default:
          ctx.ui.notify(
            [
              "workflow 用法(plan/build 双模式):",
              "/wf new <需求名> [目标repo路径]  开始新需求,进入 PLAN(pi 工具只读)",
              "/plan                            返回 PLAN(与 deepseek-pro 讨论)",
              "/wf analyze [--refresh]          分析目标仓库,生成/刷新跨需求复用的仓库简报",
              "/wf draft                        生成/刷新完整计划(缺仓库简报会先自动分析一次;PRD + 子任务拆分)",
              "/build [--fresh]                进入 BUILD:reasonix 串行实现+验证+每子任务一commit,再整体 review。默认断点续跑(跳过已完成子任务),--fresh 强制全量重跑",
              "/wf status                       查看当前需求与子任务状态",
              "/wf verify <cmd>                 设置本需求的验证命令(留空清除)",
            ].join("\n"),
            "info",
          );
      }
    },
  });

  pi.registerCommand("plan", {
    description: "进入 PLAN 模式(讨论需求,对代码只读)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => { await cmdPlan(pi, ctx); },
  });

  pi.registerCommand("build", {
    description: "进入 BUILD 模式并执行计划(默认断点续跑,跳过已完成子任务;--fresh 强制全量重跑)",
    handler: async (args: string, ctx: ExtensionCommandContext) => { await cmdBuild(pi, ctx, args); },
  });
}
