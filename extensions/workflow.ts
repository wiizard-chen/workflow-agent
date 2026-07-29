/**
 * workflow — a pi coding-agent extension implementing a two-mode pipeline:
 *
 *   no active epic: normal Pi session; use /wf new or /wf resume to enter workflow.
 *   plan  mode: readonly discussion; a dedicated GLM subagent writes prd.md.
 *   build mode: the main session is a code-readonly manager that delegates
 *               implementation/review and uses narrow deterministic tools.
 *
 * The main session IS the manager — there's no separate manager process. The
 * manager prompt (.pi/manager-prompt.md) is injected as a user message on
 * /execute; the session LLM runs the pipeline, watched by the user.
 *
 * Dev/reviewer are pi-subagents subagents (defined in .pi/agents/*.md, discovered
 * via the package's standard `.pi/agents/**\/*.md` convention). The manager calls
 * `subagent({ agent: "pi-workflow.dev", task: "...", output: "..." })`; dev writes code +
 * commits + writes a structured result JSON to an output file; reviewer reads
 * git diff + writes a verdict JSON. The manager reads these files to decide bd
 * close/reopen.
 *
 * Load:  pi -e ./extensions/workflow.ts -e ./extensions/cache.ts
 *        (requires nicobailon/pi-subagents: pi install npm:pi-subagents — this
 *        registers a tool named `subagent`, NOT `delegate`; earlier revisions
 *        of this project's docs/prompts incorrectly called it `delegate`)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  addUsage,
  buildRunSummary,
  commitArtifacts,
  emptyUsageTotals,
  formatUsageLine,
  getVerifyCommand,
  gitHead,
  isGitRepo,
  nowStamp,
  readRepoBrief,
  readRunSummary,
  repoBriefPath,
  reqPath,
  runVerify,
  saveState,
  sh,
  slug,
  writeRunSummary,
  validateIntegratedCommitRange,
  type RoleRef,
  type UsageTotals,
  type WorkflowConfig,
  type WorkflowState,
} from "./lib.ts";
import * as bd from "./bd.ts";
import { registerWorkflowProviders } from "./providers.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: WorkflowConfig = {
  providers: {
    deepseek: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", api: "openai-completions", thinkingFormat: "deepseek" },
    zai: { baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKeyEnv: "GLM5_2_API_KEY", api: "openai-completions", thinkingFormat: "zai" },
  },
  roles: {
    discuss: { provider: "deepseek", model: "deepseek-v4-pro" },
    prd: { provider: "zai", model: "glm-5.2" },
    split: { provider: "deepseek", model: "deepseek-v4-pro" },
    review: { provider: "zai", model: "glm-5.2" },
  },
  build: { verifyCommand: "", commitPrefix: "subtask" },
  // Worktree-isolated parallel children return patches/handoff manifests; they
  // do not auto-merge into the target repository. Until deterministic handoff
  // integration is implemented, the safe default is one serial dev writer.
  execute: { driver: "bd", maxParallel: 1, pollIntervalMs: 2000 },
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
          build: { ...DEFAULT_CONFIG.build, ...(raw.build || {}) },
          execute: { ...DEFAULT_CONFIG.execute, ...(raw.execute || {}) },
        };
      }
    }
  } catch (_e) { /* defaults */ }
  return DEFAULT_CONFIG;
}

const READONLY_TOOLS = ["read", "grep", "find", "ls"];

// Tools registered by nicobailon/pi-web-access (pi install npm:pi-web-access),
// if installed. These are plain extension tools (not MCP-prefixed like the
// playwright bridge below), so they need an explicit name allowlist rather
// than the prefix-matching used for MCP servers. Web access is read-only by
// nature (search/fetch, no code mutation), so it's safe to allow in PLAN mode
// alongside playwright-mcp — the two are complementary, not competing:
// playwright-mcp drives a real browser for frontend debugging (screenshots,
// DOM interaction, click-testing); pi-web-access is for PLAN-stage research
// (search, doc/GitHub content fetch) without needing a live browser session.
const WEB_ACCESS_TOOLS = ["web_search", "fetch_content", "get_search_content", "source_check"];

let CONFIG = loadConfig();
let wf: WorkflowState | undefined;
let baseActiveTools: string[] = [];
let activeDevToolCallId: string | undefined;
// Tool-call tracking: detect "session did zero work" (no split, no bd_task) so we
// can warn instead of reporting a false success.
let mgrHasSplit = false;
let mgrTasksProcessed = 0;
let lastAssistantText = "";

// Cost/cache telemetry accumulator, keyed by "provider/model". Reset when the
// active requirement changes; flushed to results/summary.json on every turn end
// (cheap: one small JSON write) so a crashed/interrupted run still leaves data.
let usageByModel: Record<string, UsageTotals> = {};

/** Fold the just-finished message's usage into the accumulator + persist. */
function trackUsage(event: any, ctx: any): void {
  if (!wf) return;
  const usage = event?.message?.usage;
  if (!usage) return;
  const model = ctx?.model;
  const key = model ? `${model.provider ?? "?"}/${model.id ?? model.name ?? "?"}` : "unknown";
  if (!usageByModel[key]) usageByModel[key] = emptyUsageTotals();
  addUsage(usageByModel[key], usage);
  writeRunSummary(wf, buildRunSummary(wf, usageByModel));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitTurnComplete(ctx: ExtensionCommandContext, maxMs = 600000): Promise<void> {
  const start = Date.now();
  while (ctx.isIdle() && Date.now() - start < 10000) await sleep(200);
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
// pi-side helpers (LLM stages)
// ---------------------------------------------------------------------------

function setModeStatus(ctx: ExtensionCommandContext): void {
  const label = wf ? `WF:${wf.mode} ${wf.reqId}` : "WF:—";
  try { ctx.ui.setStatus("workflow", label); } catch (_e) { /* ignore */ }
}

/** Apply the capability boundary for the active workflow mode. */
function applyModeTools(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  if (!wf) {
    if (baseActiveTools.length) pi.setActiveTools(baseActiveTools);
    return;
  }
  if (wf.mode === "plan") {
    lockReadonly(pi, true);
    return;
  }
  pi.setActiveTools([
    "split_prd_to_tasks", "bd_query", "bd_task", "run_verify", "finalize_test",
    "subagent",
    ...READONLY_TOOLS,
  ]);
  ctx.ui.notify?.("build 模式:manager 对代码只读;仅开放受控 workflow 工具 + subagent + 只读工具", "info");
}

function readJson(file: string): any | undefined {
  try { return JSON.parse(stripFence(fs.readFileSync(file, "utf8"))); }
  catch { return undefined; }
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sha256File(file: string): string | undefined {
  return fs.existsSync(file) ? sha256Text(fs.readFileSync(file, "utf8")) : undefined;
}

function resolvedPath(value: unknown): string {
  return path.resolve(String(value || ""));
}

function pathInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Enforce delegation as a capability boundary, not a prompt convention. */
export function ensureRequirementDirs(state: WorkflowState): void {
  fs.mkdirSync(reqPath(state, "subtasks"), { recursive: true });
  fs.mkdirSync(reqPath(state, "results"), { recursive: true });
}

export function renderedToolName(call: any): string {
  const rendered = String(call?.toolName || call?.name || call?.text || call?.expandedText || "").trim();
  if (rendered.startsWith("$ ")) return "bash";
  return rendered.split(/\s+/, 1)[0] || "";
}

export function preservedBaseline(existing: string | undefined, current: string | undefined): string | undefined {
  return existing || current;
}

export function splitDecision(existingTaskIds: string[], manifest: any, prdSha256: string): "create" | "reuse" | "reject" {
  if (existingTaskIds.length > 0) {
    if (manifest?.status !== "complete" || manifest?.prdSha256 !== prdSha256 || !Array.isArray(manifest?.created)) return "reject";
    const recorded = manifest.created.map((item: any) => String(item?.id || "")).filter(Boolean).sort();
    const actual = [...existingTaskIds].sort();
    return recorded.length === actual.length && recorded.every((id: string, i: number) => id === actual[i]) ? "reuse" : "reject";
  }
  return manifest ? "reject" : "create";
}

function bundledAgentsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".pi", "agents");
}

function agentRuntimeName(file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, "utf8");
    const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fm) return undefined;
    const name = fm[1].match(/^name:\s*([^\n#]+)/m)?.[1]?.trim();
    const pkg = fm[1].match(/^package:\s*([^\n#]+)/m)?.[1]?.trim();
    return name ? (pkg ? `${pkg}.${name}` : name) : undefined;
  } catch { return undefined; }
}

function markdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Fail closed if higher-precedence user/target definitions can shadow roles. */
function assertWorkflowAgentsUnshadowed(repo: string): void {
  const required = new Set([
    "pi-workflow.dev", "pi-workflow.reviewer",
    "pi-workflow.prd-writer", "pi-workflow.final-reviewer",
  ]);
  const bundled = bundledAgentsDir();
  const dirs = [
    path.join(repo, ".pi", "agents"), path.join(repo, ".agents"),
    path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "agents"),
    path.join(os.homedir(), ".agents"),
    ...(process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS || "").split(path.delimiter).filter(Boolean),
  ];
  for (const dir of dirs) {
    for (const file of markdownFiles(dir)) {
      if (pathInside(file, bundled)) continue;
      const runtime = agentRuntimeName(file);
      if (runtime && required.has(runtime)) throw new Error(`workflow agent 被高优先级定义覆盖:${runtime} (${file})`);
    }
  }
  for (const settingsPath of [
    path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "settings.json"),
    path.join(repo, ".pi", "settings.json"),
  ]) {
    const settings = readJson(settingsPath);
    const overrides = settings?.subagents?.agentOverrides;
    if (!overrides || typeof overrides !== "object") continue;
    for (const runtime of required) if (Object.prototype.hasOwnProperty.call(overrides, runtime)) {
      throw new Error(`workflow agent 存在 settings override:${runtime} (${settingsPath})`);
    }
  }
}

function validateSubagentCall(event: any): string | undefined {
  if (!wf) return undefined;
  try { assertWorkflowAgentsUnshadowed(wf.repo); }
  catch (e) { return (e as Error).message; }
  const input = event?.input ?? {};
  if (input.tasks || input.chain || input.worktree || input.async || input.count) {
    return "workflow 禁止 parallel/chain/worktree/async subagent 调用";
  }
  if (input.model || input.acceptance || input.outputSchema) {
    return "workflow 禁止覆盖 agent model/acceptance/output schema";
  }
  if (resolvedPath(input.cwd) !== path.resolve(wf.repo)) {
    return `subagent cwd 必须精确为当前 workflow repo:${wf.repo}`;
  }
  const agent = String(input.agent || "");
  const output = resolvedPath(input.output);

  if (wf.mode === "plan") {
    if (agent !== "pi-workflow.prd-writer") return "plan 模式只允许 pi-workflow.prd-writer subagent";
    if (input.context !== "fork") return "prd-writer 必须 context=fork";
    if (output !== path.resolve(reqPath(wf, "prd.md"))) return "prd-writer output 必须是当前 prd.md";
    return undefined;
  }

  const resultsDir = reqPath(wf, "results");
  if (!pathInside(output, resultsDir)) return `subagent output 必须位于 ${resultsDir}`;
  if (!["pi-workflow.dev", "pi-workflow.reviewer", "pi-workflow.final-reviewer"].includes(agent)) {
    return "build 模式只允许 pi-workflow.dev/reviewer/final-reviewer";
  }
  if (input.context !== "fresh") return `${agent} 必须 context=fresh`;
  if (agent === "pi-workflow.dev") {
    if (activeDevToolCallId) return "已有 dev writer 在运行;writer 上限固定为 1";
    if (!/\.json$/.test(output) || /\.review\.json$/.test(output)) return "dev output 必须是 results/<taskId>.json";
    const taskId = path.basename(output, ".json");
    try { assertActiveChildIssue(taskId); } catch (e) { return (e as Error).message; }
    if (!fs.existsSync(reqPath(wf, "results", `${taskId}.claim.json`))) return `缺少 ${taskId}.claim.json;先 bd_task(claim)`;
    activeDevToolCallId = String(event?.toolCallId || "dev-running");
    return undefined;
  }
  if (agent === "pi-workflow.reviewer") {
    if (!/\.review\.json$/.test(output)) return "reviewer output 必须是 results/<taskId>.review.json";
    const taskId = path.basename(output).replace(/\.review\.json$/, "");
    try { assertActiveChildIssue(taskId); } catch (e) { return (e as Error).message; }
    if (!fs.existsSync(reqPath(wf, "results", `${taskId}.claim.json`)) || !fs.existsSync(reqPath(wf, "results", `${taskId}.json`))) {
      return `reviewer 缺少 ${taskId} 的 claim/dev 证据`;
    }
    return undefined;
  }
  if (output !== path.resolve(reqPath(wf, "results", "final-review.json"))) return "final-reviewer output 路径错误";
  if (!fs.existsSync(reqPath(wf, "results", "verify.json"))) return "先调用 run_verify 生成 verify.json";
  return undefined;
}

/** Scan `<repo>/.workflow/<reqId>/state.json` files, return all parsed states
 *  sorted by createdAt descending (newest first). Restore wf in a new session. */
function listAllStates(repo: string): WorkflowState[] {
  const wfDir = path.join(repo, ".workflow");
  if (!fs.existsSync(wfDir)) return [];
  const states: WorkflowState[] = [];
  for (const entry of fs.readdirSync(wfDir)) {
    if (entry.startsWith("_")) continue;   // skip _repo-brief.md etc.
    const sp = path.join(wfDir, entry, "state.json");
    if (!fs.existsSync(sp)) continue;
    try { states.push(JSON.parse(fs.readFileSync(sp, "utf8")) as WorkflowState); }
    catch (_e) { /* skip corrupt */ }
  }
  return states.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function lockReadonly(pi: ExtensionAPI, allowSubagent = false): void {
  try {
    // Keep the read-only built-ins, plus any MCP-bridged tools registered by the
    // pi-mcp extension (server_toolName, e.g. playwright_browser_navigate) so
    // PLAN-mode discussion/analyze can browse the web without gaining write
    // access to the target repo's real files. pi-mcp registers one server per
    // .mcp.json entry; we don't hardcode names, we detect by prefix.
    const mcpServerNames = Object.keys(readMcpServers());
    const allNames = pi.getAllTools().map((t) => t.name);
    const mcpTools = allNames.filter((n) => mcpServerNames.some((s) => n.startsWith(`${s}_`)) || n.startsWith("mcp__"));
    // Also allow pi-web-access's tools if that package is installed (checked
    // by name, not by package presence — setActiveTools silently ignores
    // names that aren't registered, so this is a no-op when absent).
    const webAccessTools = WEB_ACCESS_TOOLS.filter((n) => allNames.includes(n));
    pi.setActiveTools([...READONLY_TOOLS, ...mcpTools, ...webAccessTools, ...(allowSubagent ? ["subagent"] : [])]);
  } catch (_e) { /* ignore */ }
}

function readMcpServers(): Record<string, unknown> {
  try {
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

/** Strict JSON extraction (P1 #3): validate required fields, fail loudly.
 *  Exported for unit testing (test/workflow-logic.test.ts) — pure function,
 *  no pi/bd dependency. */
export function extractSubtasksJson(text: string): { subtasks: any[] } {
  const stripped = stripFence(text);
  let parsed: any;
  try {
    parsed = JSON.parse(stripped);
  } catch (_e) {
    const s = stripped.indexOf("{");
    const e = stripped.lastIndexOf("}");
    if (s < 0 || e <= s) throw new Error("子任务拆分输出不含可解析的 JSON 对象。");
    try { parsed = JSON.parse(stripped.slice(s, e + 1)); }
    catch (e2) { throw new Error(`子任务 JSON 解析失败:${(e2 as Error).message}`); }
  }
  if (!parsed || !Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
    throw new Error("子任务 JSON 结构无效:缺少非空 subtasks 数组。");
  }
  for (let i = 0; i < parsed.subtasks.length; i++) {
    const t = parsed.subtasks[i];
    if (!t || typeof t !== "object") throw new Error(`子任务[${i}]不是对象。`);
    if (!t.title) throw new Error(`子任务[${i}]缺少 title。`);
    if (t.spec === undefined) throw new Error(`子任务[${i}]缺少 spec。`);
  }
  return parsed;
}

async function useRole(pi: ExtensionAPI, ctx: ExtensionCommandContext, role: RoleRef): Promise<boolean> {
  const model = ctx.modelRegistry.find(role.provider, role.model);
  if (!model) { ctx.ui.notify(`模型未找到:${role.provider}/${role.model}`, "error"); return false; }
  const ok = await pi.setModel(model);
  if (!ok) ctx.ui.notify(`无法切换到 ${role.provider}/${role.model}:缺少 API key`, "error");
  return ok;
}

async function runStageText(pi: ExtensionAPI, ctx: ExtensionCommandContext, role: RoleRef, prompt: string, attempts = 3): Promise<string | null> {
  await ctx.waitForIdle();
  if (!(await useRole(pi, ctx, role))) return null;
  for (let i = 0; i < attempts; i++) {
    lastAssistantText = "";
    pi.sendUserMessage(prompt);
    await waitTurnComplete(ctx);
    if (lastAssistantText) return lastAssistantText;
    if (i < attempts - 1) { ctx.ui.notify(`  ↻ 模型无输出,重试 ${i + 2}/${attempts}…`, "warning"); await sleep(1500); }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function withBrief(repo: string, body: string): string {
  const brief = readRepoBrief(repo);
  if (!brief) return body;
  return [`以下是对目标仓库的分析简报(供你参考,不要重复分析仓库):`, `--- 仓库简报 开始 ---`, brief.trim(), `--- 仓库简报 结束 ---`, ``, body].join("\n");
}

function analyzePrompt(): string {
  return [
    `你是资深技术负责人,第一次接触这个仓库。用只读工具(read/grep/find/ls)探查这个仓库,产出一份分析简报。`,
    `直接把简报的 Markdown 正文作为你的回答输出(不要用工具写文件,不要用代码块包裹,不要额外解释)。`,
    `简报需包含:## 技术栈、## 目录结构与关键模块、## 代码约定、## 相关已有模块、## 建议验证命令(以 \`建议命令:\` 开头)。`,
  ].join("\n");
}

function extractSuggestedVerifyCommand(brief: string): string | undefined {
  const m = brief.match(/建议命令[:：]\s*`?([^\n`]+)`?/);
  if (!m) return undefined;
  const cmd = m[1].trim();
  if (!cmd || /未发现|建议留空|none|n\/a/i.test(cmd)) return undefined;
  return cmd;
}

// ---------------------------------------------------------------------------
// PRD mode commands
// ---------------------------------------------------------------------------

async function cmdNew(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
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
  wf = { reqId, name, repo, mode: "plan", createdAt: new Date().toISOString(), epicId, subtaskIds: [] };
  usageByModel = {};   // fresh telemetry for a fresh requirement
  ensureRequirementDirs(wf);
  saveState(wf);
  setModeStatus(ctx);
  applyModeTools(pi, ctx);
  await useRole(pi, ctx, CONFIG.roles.discuss);
  ctx.ui.notify(`新需求 ${reqId}\n目标 repo: ${repo}\nbd epic: ${epicId}\n已进入 PRD 模式(${CONFIG.roles.discuss.model},只读)。讨论需求,满意后 /wf prd 生成 PRD,再 /execute 执行。`, "info");
}

async function cmdPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new。", "warning"); return; }
  activeDevToolCallId = undefined;
  wf.mode = "plan"; saveState(wf); setModeStatus(ctx); applyModeTools(pi, ctx);
  await useRole(pi, ctx, CONFIG.roles.discuss);
  ctx.ui.notify(`已进入 PRD 模式(只读)。讨论需求,或 /wf prd 生成 PRD。`, "info");
}

async function cmdAnalyze(pi: ExtensionAPI, ctx: ExtensionCommandContext, opts: { silent?: boolean } = {}): Promise<boolean> {
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
async function cmdPrd(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
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
function cmdDone(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  if (!wf) { ctx.ui.notify("无活动需求。", "info"); return; }
  const finished = wf;
  // Persist a resumable non-executing mode before clearing the in-memory
  // active context. Beads remains authoritative; /wf resume can select it.
  finished.mode = "plan";
  saveState(finished);
  wf = undefined;
  activeDevToolCallId = undefined;
  usageByModel = {};
  setModeStatus(ctx);
  applyModeTools(pi, ctx);
  ctx.ui.notify(`已退出需求 ${finished.epicId}(${finished.name})并恢复普通 Pi。需要继续时用 /wf resume 选择 epic。`, "info");
}

function cmdStatus(ctx: ExtensionCommandContext): void {
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
    `需求 ${wf.reqId}  模式 ${wf.mode}\nepic ${wf.epicId}` +
    (bdFailed ? "  (bd 不可用,降级模式)" : "") +
    (summary ? `\n${summary}` : "") + usageLine + `\n${lines.join("\n")}`,
    bdFailed ? "warning" : "info",
  );
}

/** /wf resume — select any Beads epic; reconstruct missing local state. */
async function cmdResume(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
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
    saveState(target);
  }

  // Normalize historical idle states from older versions.
  if ((target as any).mode === "idle") target.mode = "plan";
  wf = target;
  usageByModel = {};
  setModeStatus(ctx);
  applyModeTools(pi, ctx);
  await useRole(pi, ctx, wf.mode === "build" ? CONFIG.roles.split : CONFIG.roles.discuss);

  const kids = bd.children(wf.repo, chosen.epic.id).filter((i) => i.issue_type === "task" || i.issue_type === "bug");
  const summary = [
    `[workflow resume context — 只恢复上下文,不要自动执行]`,
    `Epic:${chosen.epic.id}`,
    `标题:${chosen.epic.title}`,
    `状态:${chosen.epic.status}`,
    `本地模式:${wf.mode}`,
    `PRD:${reqPath(wf, "prd.md")}${fs.existsSync(reqPath(wf, "prd.md")) ? "(存在)" : "(缺失)"}`,
    `任务:${kids.filter((i) => i.status === "closed").length}/${kids.length} closed; ${kids.filter((i) => i.status === "in_progress").length} in_progress; ${kids.filter((i) => i.status === "open").length} open`,
    `等待用户决定下一步。`,
  ].join("\n");
  pi.sendUserMessage(summary);
  ctx.ui.notify(`已恢复 epic ${chosen.epic.id}:${chosen.epic.title}`, "info");
}

/** /wf bug <描述> — 轻量 bug 修复入口。跳过 PRD,直接建 bd bug + 最小规格,
 *  挂当前需求 epic。如果描述里包含多个独立问题(首先/其次/另外),用 split 模型
 *  自动拆成多个 bug,每个一个规格。然后 /execute 让经理分配 dev 修复。 */
async function cmdBug(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
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

  const lines = created.map((c) => `  ${c.id}: ${c.title}`).join("\n");
  ctx.ui.notify(
    `已建 ${created.length} 个 bug(挂 epic ${wf.epicId}):\n${lines}\n\n/execute 修复(经理会检查 epic 下的 open bug)`,
    "info"
  );
}

/** /wf task <描述> — 轻量功能入口,跳过 PRD。把一句话小需求用 split 模型拆成一组
 *  尽量独立、可单独实现与验证的 beads task(带依赖),挂在当前活动需求 epic 下。
 *  跟 /wf bug 的区别:bug 是修(task type=bug),task 是加功能(type=task),
 *  而且拆分用 split_prd_to_tasks 同款的 tracer-bullet 原则(垂直切片、依赖最小化),
 *  会标注 task 之间的 blocks 依赖。建完后手动 /execute 让经理串行派 dev 实现。 */
async function cmdTask(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
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

  const lines = created.map((c) =>
    `  ${c.id}: ${c.title}${c.depends_on.length ? ` (依赖 ${c.depends_on.join(",")})` : ""}`
  ).join("\n");
  ctx.ui.notify(
    `已建 ${created.length} 个 task(挂 epic ${wf.epicId}):\n${lines}\n\n/execute 让经理按安全单-writer顺序串行实现`,
    "info"
  );
}


// ---------------------------------------------------------------------------
// EXECUTE mode: spawn manager + register dev/test tools
// ---------------------------------------------------------------------------

/** Load the manager system prompt, injecting run context (reqId/repo/epicId/prd).
 *  Optional overrides let /execute point the manager at a different PRD + epic
 *  than the current wf (for /execute <prd-path>). */
/** Load the manager prompt (.pi/manager-prompt.md) + inject run context.
 *  The manager prompt guides the main session through the pipeline in build mode.
 *  It's NOT an agent definition — the main session IS the manager. */
function loadManagerPrompt(prdPathOverride?: string, epicIdOverride?: string, dryRun = false): string {
  if (!wf) throw new Error("无活动需求");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", ".pi", "manager-prompt.md"),
    path.join(here, ".pi", "manager-prompt.md"),
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
async function cmdExecute(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string = ""): Promise<void> {
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
    usageByModel = {};
    activeDevToolCallId = undefined;
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
  mgrHasSplit = false;
  mgrTasksProcessed = 0;
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
async function cmdAbort(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
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
  activeDevToolCallId = undefined;
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

// ---------------------------------------------------------------------------
// Manager tools (registered for every session; handlers require active wf)
// ---------------------------------------------------------------------------

function assertActiveChildIssue(taskId: string): bd.BdIssue {
  if (!wf?.epicId) throw new Error("没有活动 epic");
  const issue = bd.show(wf.repo, taskId);
  if (!issue || issue.parent !== wf.epicId || (issue.issue_type !== "task" && issue.issue_type !== "bug")) {
    throw new Error(`issue ${taskId} 不是活动 epic ${wf.epicId} 的直接 task/bug child`);
  }
  return issue;
}

export function registerManagerTools(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  // Register these tools for every session, including a fresh repository that
  // has not created its first workflow yet. Each execute handler performs its
  // own active-workflow check so an early/manual call fails safely.

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
        wf.subtaskIds = [...new Set([...(wf.subtaskIds || []), ...existingTasks.map((i) => i.id)])];
        saveState(wf);
        return { content: [{ type: "text", text: `split 已完成,复用 ${existingTasks.length} 个 task:\n${existingTasks.map((i) => `${i.id} ${i.status} ${i.title}`).join("\n")}` }], details: {} };
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
      wf.subtaskIds = [...new Set([...(wf.subtaskIds || []), ...created.map((c) => c.id)])];
      saveState(wf);
      mgrHasSplit = true;
      const summary = created.map((c) => `${c.id}: ${c.title}${c.depends_on.length ? ` (依赖 ${c.depends_on.join(",")})` : ""}`).join("\n");
      return { content: [{ type: "text", text: `已确定性创建 ${created.length} 个 task:\n${summary}\n\n现在严格串行处理 ready task:claim → pi-workflow.dev → pi-workflow.reviewer → close/reopen。` }], details: {} };
    },
  });

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
    description: "对 bd issue 做确定性生命周期操作:claim(原子认领,记录 baseline SHA 供 reviewer 精确 diff 定位)、close(要求绑定 commit 的 GLM review pass,并重跑验证命令)、reopen(放回 ready)、comment(留备注)。配合受控 pi-workflow.dev/reviewer subagent 使用。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("claim"), Type.Literal("close"), Type.Literal("reopen"), Type.Literal("comment")], { description: "操作类型" }),
      task_id: Type.String({ description: "bd issue id" }),
      text: Type.Optional(Type.String({ description: "close 的 reason / comment 的内容" })),
    }),
    async execute(_id, params) {
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
          track(`▶ 认领,开始派 dev。baseline=${baseline}`);
          return { content: [{ type: "text", text: `✓ 已认领 ${taskId}; baseline 已保存到 ${claimPath}` }], details: {} };
        }
        if (action === "close") {
          // Prove this task produced a non-empty commit range after its claim,
          // and that the resulting commit is integrated into target HEAD.
          const resultPath = reqPath(wf, "results", `${taskId}.json`);
          const claimPath = reqPath(wf, "results", `${taskId}.claim.json`);
          let commitSha = "";
          let baseline = "";
          try {
            const result = readJson(resultPath);
            const resultAudit = readJson(reqPath(wf, "results", `${taskId}.audit.json`));
            const claim = readJson(claimPath);
            if (!result || !resultAudit || !claim) throw new Error("JSON artifact 无法解析");
            if (resultAudit.status !== "completed" || resultAudit.resolvedModel !== "deepseek/deepseek-v4-flash"
              || resultAudit.context !== "fresh" || resultAudit.outputSha256 !== sha256File(resultPath) || resultAudit.toolsSafe !== true) {
              throw new Error("dev agent/model/tool/output audit 无效");
            }
            commitSha = typeof result?.commitSha === "string" ? result.commitSha.trim() : "";
            baseline = claim?.taskId === taskId && typeof claim?.baseline === "string" ? claim.baseline.trim() : "";
          } catch (e) {
            bd.reopen(repo, taskId);
            track(`✗ close 被拒:dev 结果或 claim baseline 缺失/无效,已自动 reopen。`);
            return {
              content: [{ type: "text", text: `✗ close 被拒绝:结果或 claim baseline 缺失/无效,已自动 reopen ${taskId}。\n${(e as Error).message}` }],
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
            const auditValid = audit?.status === "completed" && audit?.resolvedModel === "zai/glm-5.2"
              && audit?.context === "fresh" && audit?.outputSha256 === sha256File(reviewPath);
            if (!reviewBound || !auditValid) throw new Error("review verdict 未通过、未绑定 task/commit,或 GLM audit 无效");
          } catch (e) {
            bd.reopen(repo, taskId);
            track(`✗ close 被拒:review 证据缺失/无效,已自动 reopen。`);
            return { content: [{ type: "text", text: `✗ close 被拒绝:必须先由 zai/glm-5.2 reviewer 对 taskId/baseline/commitSha 给出绑定的 pass verdict。\n${(e as Error).message}` }], details: {} };
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
          mgrTasksProcessed++;
          return { content: [{ type: "text", text: `✓ 已关闭 ${taskId}(验证复核通过)${text ? `(${text})` : ""}` }], details: {} };
        }
        if (action === "reopen") {
          bd.reopen(repo, taskId);
          track(`✗ 放回 ready${text ? `:${text.slice(0, 120)}` : ""}`);
          return { content: [{ type: "text", text: `✓ 已放回 ready ${taskId}` }], details: {} };
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
      return { content: [{ type: "text", text:
        `确定性验证${evidence.ok ? "通过" : "失败"}(exit ${v.code},runId ${runId})。\nverify:${verifyPath}\ndiff:${diffPath}\n` +
        `下一步必须调用 subagent({agent:"pi-workflow.final-reviewer", context:"fresh", cwd:${JSON.stringify(wf.repo)}, output:${JSON.stringify(reqPath(wf, "results", "final-review.json"))}, task:"读取 PRD ${prdPath}、verify ${verifyPath}、diff ${diffPath},逐条验收并在 JSON 中原样返回 runId=${runId}"}),然后调用 finalize_test。`
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
        if (audit?.status !== "completed" || audit?.resolvedModel !== "zai/glm-5.2" || audit?.context !== "fresh"
          || audit?.verifyRunId !== verify.runId || audit?.verifySha256 !== sha256File(verifyPath)
          || audit?.outputSha256 !== sha256File(reviewPath)) {
          throw new Error("final-reviewer GLM audit 缺失、模型错误或 evidence 已变化");
        }
        const blockingReviewIssues = review.issues.filter((i: any) => i && ["blocker", "major"].includes(i.severity));
        const failedChecks = review.acceptanceChecks.filter((c: any) => !c || c.status !== "pass" || !String(c.criterion || "").trim() || !String(c.evidence || "").trim());
        if (review.verdict === "pass" && (verify.ok !== true || failedChecks.length || blockingReviewIssues.length)) {
          throw new Error("pass verdict 与验证/checks/blocking issues 矛盾");
        }
        if (review.verdict === "pass") {
          const committed = commitArtifacts(wf);
          if (!committed.committed) throw new Error("workflow 最终工件提交失败或没有可提交工件");
          return { content: [{ type: "text", text: `✓ 最终验证与 GLM review 均通过。runId:${verify.runId}\n报告:${reviewPath}\n工件 commit:${committed.sha}` }], details: {} };
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
  // NOTE: tool-set locking by mode is now handled centrally by applyModeTools(),
  // called on session_start and whenever mode changes. No WF_ROLE gating.
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default function workflowExtension(pi: ExtensionAPI): void {
  CONFIG = loadConfig();
  registerWorkflowProviders(pi, CONFIG);

  pi.on("session_start", async (_e, ctx) => {
    // No epic is auto-restored. Normal Pi is the default; /wf resume presents
    // the Beads epic picker. Capture the pre-workflow active tool set so /wf
    // done can restore it exactly.
    if (baseActiveTools.length === 0) baseActiveTools = pi.getActiveTools();
    wf = undefined;
    activeDevToolCallId = undefined;
    setModeStatus(ctx as any);
    registerManagerTools(pi, ctx as any);
    applyModeTools(pi, ctx as any);
  });

  pi.on("resources_discover", async () => {
    try {
      const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
      if (fs.existsSync(dir)) return { skillPaths: [dir] };
    } catch (_e) { /* ignore */ }
    return {};
  });

  // Cost/cache telemetry (P1): accumulate per-model token usage for the active
  // requirement and persist it to results/summary.json. This restores the
  // observability lost when the reasonix `-metrics` aggregation was removed.
  pi.on("message_end", async (event: any, ctx: any) => {
    try { trackUsage(event, ctx); } catch (_e) { /* never break a run over telemetry */ }
  });

  pi.on("tool_call", async (event: any) => {
    if (event?.toolName !== "subagent") return;
    const reason = validateSubagentCall(event);
    if (reason) return { block: true, reason };
  });

  // Persist the resolved child model and child usage reported by pi-subagents.
  // The PRD/final-review output remains the child's raw artifact; this adjacent
  // envelope makes provider/model selection auditable without trusting text the
  // child wrote about itself.
  pi.on("tool_result", async (event: any) => {
    try {
      if (event?.toolName !== "subagent") return;
      const agent = String(event?.input?.agent || "");
      if (agent === "pi-workflow.dev" && activeDevToolCallId === String(event?.toolCallId || "")) activeDevToolCallId = undefined;
      if (!wf || !["pi-workflow.prd-writer", "pi-workflow.dev", "pi-workflow.reviewer", "pi-workflow.final-reviewer"].includes(agent)) return;
      const result = event?.details?.results?.[0];
      const usage = result?.usage ?? event?.details?.totalChildUsage ?? event?.usage ?? null;
      const inputOutput = String(event?.input?.output || "");
      let expectedOutput: string;
      let auditPath: string;
      let expectedContext: "fork" | "fresh";
      if (agent === "pi-workflow.prd-writer") {
        expectedOutput = reqPath(wf, "prd.md");
        auditPath = reqPath(wf, "results", "prd-generation.json");
        expectedContext = "fork";
      } else if (agent === "pi-workflow.final-reviewer") {
        expectedOutput = reqPath(wf, "results", "final-review.json");
        auditPath = reqPath(wf, "results", "final-review.audit.json");
        expectedContext = "fresh";
      } else if (agent === "pi-workflow.dev") {
        expectedOutput = inputOutput;
        auditPath = inputOutput.replace(/\.json$/, ".audit.json");
        expectedContext = "fresh";
      } else {
        expectedOutput = inputOutput;
        auditPath = inputOutput.replace(/\.review\.json$/, ".review.audit.json");
        expectedContext = "fresh";
      }
      const exactOutput = !!inputOutput && path.resolve(inputOutput) === path.resolve(expectedOutput)
        && (!result?.savedOutputPath || path.resolve(result.savedOutputPath) === path.resolve(expectedOutput));
      const resolvedModel = result?.model ?? null;
      const context = result?.context ?? event?.details?.context ?? null;
      const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
      const allowedTools = agent === "pi-workflow.dev"
        ? new Set(["read", "write", "edit", "bash", "grep", "find"])
        : agent === "pi-workflow.reviewer"
          ? new Set(["read", "bash", "grep", "find", "ls"])
          : new Set(["read", "grep", "find", "ls"]);
      const toolsSafe = toolCalls.every((call: any) => {
        const toolName = renderedToolName(call);
        return allowedTools.has(toolName);
      });
      const verify = agent === "pi-workflow.final-reviewer" ? readJson(reqPath(wf, "results", "verify.json")) : undefined;
      const expectedModel = agent === "pi-workflow.dev" ? "deepseek/deepseek-v4-flash" : "zai/glm-5.2";
      const ok = !event?.isError && result?.exitCode === 0 && !result?.outputSaveError
        && exactOutput && fs.existsSync(expectedOutput) && resolvedModel === expectedModel
        && context === expectedContext && !!usage && toolsSafe;
      fs.writeFileSync(auditPath, JSON.stringify({
        status: ok ? "completed" : "failed",
        agent,
        requestedModel: expectedModel,
        resolvedModel,
        attemptedModels: result?.attemptedModels ?? [],
        context,
        usage,
        output: expectedOutput,
        outputSha256: sha256File(expectedOutput) ?? null,
        outputExists: fs.existsSync(expectedOutput),
        exactOutput,
        toolsSafe,
        toolCalls,
        verifyRunId: verify?.runId ?? null,
        verifySha256: agent === "pi-workflow.final-reviewer" ? sha256File(reqPath(wf, "results", "verify.json")) ?? null : null,
        exitCode: result?.exitCode ?? null,
        error: result?.error ?? result?.outputSaveError ?? (event?.isError ? "subagent tool failed" : null),
        completedAt: new Date().toISOString(),
      }, null, 2) + "\n");
    } catch (_e) { /* audit must not alter the subagent tool result */ }
  });

  pi.on("agent_end", async (event: any) => {
    try { const t = extractAssistantText(event?.messages); if (t) lastAssistantText = t; } catch (_e) { /* ignore */ }
    // In build mode, detect "did zero work" so we can warn instead of a false success.
    // Two signals: in-memory counters AND a bd reality check (task count under epic).
    if (wf && wf.mode === "build") {
      const memSaysNoop = !mgrHasSplit && mgrTasksProcessed === 0;
      if (memSaysNoop) {
        let bdTaskCount = 0;
        try {
          if (wf.epicId) {
            bdTaskCount = bd.children(wf.repo, wf.epicId).filter((i: any) => i.issue_type === "task").length;
          }
        } catch (_e) { /* if bd is unreachable, trust the memory signal */ }
        if (bdTaskCount === 0) {
          wf.managerNoop = true;
          saveState(wf);
        }
      }
    }
  });

  // Commands (always registered — there's only one session now, no WF_ROLE split).
  pi.registerCommand("wf", {
      description: "workflow 流水线:new / prd / analyze / status / verify / execute / resume / bug / task / done / abort",
      getArgumentCompletions: (prefix: string) => {
        const subs = ["new", "prd", "analyze", "status", "verify", "execute", "resume", "bug", "task", "done", "abort", "help"];
        const f = subs.filter((s) => s.startsWith(prefix));
        return f.length ? f.map((s) => ({ value: s, label: s })) : null;
      },
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const trimmed = args.trim();
        const sub = trimmed.split(/\s+/)[0] || "help";
        const rest = trimmed.slice(sub.length).trim();
        switch (sub) {
          case "new": await cmdNew(pi, ctx, rest); break;
          case "prd": await cmdPrd(pi, ctx); break;
          case "analyze": {
            if (!wf) { ctx.ui.notify("无活动需求。", "warning"); break; }
            if (readRepoBrief(wf.repo) && rest !== "--refresh") { ctx.ui.notify(`简报已存在。/wf analyze --refresh 重析。`, "info"); break; }
            await cmdAnalyze(pi, ctx); break;
          }
          case "status": cmdStatus(ctx); break;
          case "resume": await cmdResume(pi, ctx, rest); break;
          case "bug": await cmdBug(pi, ctx, rest); break;
          case "task": await cmdTask(pi, ctx, rest); break;
          case "done": cmdDone(pi, ctx); break;
          case "abort": await cmdAbort(pi, ctx); break;
          case "execute": await cmdExecute(pi, ctx, rest); break;
          case "verify":
            if (!wf) { ctx.ui.notify("无活动需求。", "warning"); break; }
            if (!rest.trim()) { ctx.ui.notify("验证命令不能为空。用法:/wf verify <cmd>", "error"); break; }
            wf.verifyCommand = rest.trim(); saveState(wf);
            ctx.ui.notify(`验证命令:${wf.verifyCommand}`, "info"); break;
          default:
            ctx.ui.notify([
              "workflow 两模式:plan(讨论/PRD,代码只读) / build(manager 代码只读,委派执行)。无 active epic 时是普通 Pi。",
              "",
              "/wf new <名> [repo]     新建 Beads epic,进入 plan",
              "/wf resume [epicId]     从全部 Beads epic 选择;缺 state 时可重建",
              "/plan                   回 plan 模式讨论",
              "/wf analyze [--refresh] 分析仓库,生成跨需求复用简报",
              "/wf prd                 调用 fork 的 prd-writer(GLM-5.2)生成并展示 PRD",
              "/execute [prd路径]      进入 build;要求非空验证命令",
              "/execute --dry-run      只拆 task + 汇报计划,不派 dev",
              "/wf status              查看当前 epic 任务和 token/cache 用量",
              "/wf done                退出当前 epic,恢复普通 Pi;之后可 resume",
              "/wf abort               回滚到 execute baseline,task reopen,回到 plan",
              "/wf bug <描述>          在当前 epic 创建 bug",
              "/wf task <描述>         在当前 epic 创建 task",
              "/wf verify <cmd>        设置强制验证命令;空命令直接报错",
            ].join("\n"), "info");
        }
      },
    });

  pi.registerCommand("plan", {
    description: "进入 PRD 模式(讨论需求,只读)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => { await cmdPlan(pi, ctx); },
  });

  pi.registerCommand("execute", {
    description: "进入执行模式(拆 task→派 dev/reviewer→测试);--dry-run 只拆分不实现",
    handler: async (args: string, ctx: ExtensionCommandContext) => { await cmdExecute(pi, ctx, args); },
  });

}
