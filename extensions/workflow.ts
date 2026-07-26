/**
 * workflow — an omp coding-agent extension implementing a two-mode pipeline:
 *
 *   PRD mode:      you + omp discuss the requirement → glm-5.2 writes prd.md
 *   EXECUTE mode:  omp spawns a "manager" sub-process (separate omp session)
 *                  that reads prd.md, splits it into bd tasks, assigns them to
 *                  omp native "dev" subagents (each in a fixed worktree),
 *                  and finally has glm-5.2 test the output. Failed tests
 *                  become bd bugs the manager re-assigns.
 *
 * The manager is driven by .omp/agents/manager.md (editable, no code change).
 * It uses omp's NATIVE `task` tool to spawn dev/reviewer subagents, plus
 * extension tools (split_prd_to_tasks, bd_task, run_test) for deterministic
 * bd lifecycle and pipeline stages. Scheduling is the manager's LLM judgment.
 *
 * Dev execution: the manager calls `task(agent="dev", ...)` — omp spawns the
 * subagent natively (no manual worktree/spawn in the extension). Dev changes
 * land in the main repo's git history; the reviewer subagent reads them via
 * git diff. Cross-task context is carried by bd comments + the DeepSeek
 * prefix cache (cache.ts freezes the system-prompt date).
 *
 * WF_ROLE env var distinguishes the main session (PRD mode, commands active)
 * from the manager session (execute mode, tools active).
 *
 * Load:  omp -e ./workflow/extensions/workflow.ts   (or pi -e ...)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
  commitArtifacts,
  gitHead,
  isGitRepo,
  nowStamp,
  readRepoBrief,
  repoBriefPath,
  reqPath,
  runVerify,
  saveState,
  sh,
  slug,
  type RoleRef,
  type WorkflowConfig,
  type WorkflowState,
} from "./lib.ts";
import * as bd from "./bd.ts";

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
const WF_ROLE = process.env.WF_ROLE || "main";  // "main" (PRD mode) | "manager" (execute mode)

let CONFIG = loadConfig();
let wf: WorkflowState | undefined;
// Manager-side tool-call tracking (only meaningful when WF_ROLE === "manager").
// Used to detect "manager exited without doing any work" (no split, no assign).
let mgrHasSplit = false;
let mgrTasksProcessed = 0;
let lastAssistantText = "";

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

/** Restore the most recent requirement's wf from disk. Returns true if restored.
 *  Used by session_start (main) so a new session picks up the last active req. */
function restoreLatestWf(ctx: ExtensionCommandContext): boolean {
  const states = listAllStates(ctx.cwd);
  if (states.length === 0) return false;
  wf = states[0];
  return true;
}

function lockReadonly(pi: ExtensionAPI): void {
  try {
    const mcpServerNames = Object.keys(readMcpServers());
    const allNames = pi.getAllTools();
    const mcpTools = allNames.filter((n) => mcpServerNames.some((s) => n.startsWith(`${s}_`)) || n.startsWith("mcp__"));
    pi.setActiveTools([...READONLY_TOOLS, ...mcpTools]);
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

/** Strict JSON extraction (P1 #3): validate required fields, fail loudly. */
function extractSubtasksJson(text: string): { subtasks: any[] } {
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

function registerProviders(pi: ExtensionAPI): void {
  const byProvider = new Map<string, Set<string>>();
  for (const role of Object.values(CONFIG.roles)) {
    if (!byProvider.has(role.provider)) byProvider.set(role.provider, new Set());
    byProvider.get(role.provider)!.add(role.model);
  }
  for (const [provName, modelIds] of byProvider) {
    const p = CONFIG.providers[provName];
    if (!p) continue;
    const apiKey = process.env[p.apiKeyEnv];
    if (!apiKey) console.error(`[workflow] provider ${provName}: env ${p.apiKeyEnv} not set.`);
    const models = [...modelIds].map((id) => ({
      id, name: id, reasoning: true,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: id.startsWith("deepseek") ? 1000000 : 200000,
      maxTokens: 8192,
      compat: p.thinkingFormat ? ({ thinkingFormat: p.thinkingFormat } as any) : undefined,
    }));
    pi.registerProvider(provName, { baseUrl: p.baseUrl, apiKey: apiKey ?? "", api: p.api as any, models });
  }
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

function prdPrompt(repo: string): string {
  return withBrief(repo, [
    `你是资深产品经理。基于本会话上文的需求讨论,产出一份专业的 PRD。`,
    `直接把 PRD 的 Markdown 正文作为你的回答输出(不要使用任何工具,不要用代码块包裹)。`,
    `PRD 需包含:背景/目标、范围(含明确的非目标)、功能点/用户故事、可测试的验收标准、技术约束/依赖、风险。`,
  ].join("\n"));
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
  fs.mkdirSync(reqPath(wf, "subtasks"), { recursive: true });
  fs.mkdirSync(reqPath(wf, "results"), { recursive: true });
  saveState(wf);
  setModeStatus(ctx);
  lockReadonly(pi);
  await useRole(pi, ctx, CONFIG.roles.discuss);
  ctx.ui.notify(`新需求 ${reqId}\n目标 repo: ${repo}\nbd epic: ${epicId}\n已进入 PRD 模式(${CONFIG.roles.discuss.model},只读)。讨论需求,满意后 /wf prd 生成 PRD,再 /execute 执行。`, "info");
}

async function cmdPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new。", "warning"); return; }
  wf.mode = "plan"; saveState(wf); setModeStatus(ctx); lockReadonly(pi);
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

/** /wf prd — generate prd.md from the discussion. */
async function cmdPrd(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new。", "warning"); return; }
  if (wf.mode !== "plan") { ctx.ui.notify("只能在 PRD 模式生成。先 /plan。", "warning"); return; }
  if (!readRepoBrief(wf.repo)) {
    ctx.ui.notify("尚无仓库简报,先自动分析一次…", "info");
    if (!(await cmdAnalyze(pi, ctx, { silent: true }))) return;
  }
  ctx.ui.notify("生成 PRD(glm-5.2)…", "info");
  const prd = await runStageText(pi, ctx, CONFIG.roles.prd, prdPrompt(wf.repo));
  if (!prd) { ctx.ui.notify("PRD 生成失败。", "error"); return; }
  fs.writeFileSync(reqPath(wf, "prd.md"), stripFence(prd) + "\n");
  await useRole(pi, ctx, CONFIG.roles.discuss);
  ctx.ui.notify(`PRD 已生成:${reqPath(wf, "prd.md")}\n审阅后 /execute 进入执行模式(经理拆 task + 分配 dev + 测试)。`, "info");
}

function cmdStatus(ctx: ExtensionCommandContext): void {
  if (!wf) { ctx.ui.notify("无活动需求。/wf new <名字> [repo] 开始。", "info"); return; }
  let lines: string[] = [];
  try {
    if (wf.epicId) {
      const kids = bd.children(wf.repo, wf.epicId);
      lines = kids.map((c) => `  ${c.id} [${c.status}] ${c.title}`);
    }
  } catch (_e) { lines = ["  (无法读取 bd)"]; }
  ctx.ui.notify(`需求 ${wf.reqId}\n模式 ${wf.mode}\nrepo ${wf.repo}\nepic ${wf.epicId}\n${lines.join("\n") || "  (无子任务)"}`, "info");
}

/** /wf resume <reqId> — switch the active requirement to a previously-created
 *  one (loaded from its state.json). No arg = list available requirements. */
function cmdResume(ctx: ExtensionCommandContext, args: string): void {
  const arg = args.trim().replace(/["']/g, "");
  const states = listAllStates(ctx.cwd);
  if (!arg) {
    if (states.length === 0) { ctx.ui.notify("没有可恢复的需求。/wf new 新建。", "info"); return; }
    const lines = states.map((s) => {
      const cur = (wf && s.reqId === wf.reqId) ? " ← 当前" : "";
      return `  ${s.reqId}  [${s.mode}] ${s.name}${cur}`;
    });
    ctx.ui.notify(`可恢复的需求(按创建时间倒序):\n${lines.join("\n")}\n\n用 /wf resume <reqId> 切换。`, "info");
    return;
  }
  const target = states.find((s) => s.reqId === arg || s.reqId.includes(arg));
  if (!target) { ctx.ui.notify(`找不到需求:${arg}\n/wf resume(无参)看列表。`, "error"); return; }
  if (wf && wf.mode === "build") { ctx.ui.notify(`需求 ${wf.reqId} 正在执行中,不能切换。`, "error"); return; }
  wf = target;
  setModeStatus(ctx);
  ctx.ui.notify(`已切换到需求 ${wf.reqId}(epic ${wf.epicId})\n模式 ${wf.mode}`, "info");
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


// ---------------------------------------------------------------------------
// EXECUTE mode: spawn manager + register dev/test tools
// ---------------------------------------------------------------------------

/** Load the manager system prompt, injecting run context (reqId/repo/epicId/prd).
 *  Optional overrides let /execute point the manager at a different PRD + epic
 *  than the current wf (for /execute <prd-path>). */
function loadManagerPrompt(prdPathOverride?: string, epicIdOverride?: string): string {
  if (!wf) throw new Error("无活动需求");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", ".omp", "agents", "manager.md"),
    path.join(here, ".omp", "agents", "manager.md"),
    path.join(process.cwd(), ".omp", "agents", "manager.md"),
  ];
  let template = "";
  for (const c of candidates) {
    if (fs.existsSync(c)) { template = fs.readFileSync(c, "utf8"); break; }
  }
  if (!template) throw new Error("找不到 .omp/agents/manager.md");
  // Strip YAML frontmatter; inject run context after the body.
  const body = template.replace(/^---\n[\s\S]*?\n---\n/, "");
  const prdFile = prdPathOverride || reqPath(wf, "prd.md");
  const epicId = epicIdOverride || wf.epicId;
  const context = [
    ``,
    `--- 运行上下文 ---`,
    `需求 ID:${wf.reqId}`,
    `目标仓库:${wf.repo}`,
    `bd epic:${epicId}`,
    `PRD 文件:${prdFile}`,
    `dev 并发上限:${CONFIG.execute?.maxParallel ?? 20}(用原生 task 工具调 dev/reviewer subagent,可并行)`,
    `------------------`,
    ``,
    `现在开始:先读 PRD 文件,然后调 split_prd_to_tasks。`,
  ].join("\n");
  return body + "\n" + context;
}

/** /execute — spawn a manager omp process and wait for it to finish.
 *  Optional prdPath arg points the manager at a specific PRD (auto-creates a
 *  fresh epic for it). Without args, uses the current requirement's prd.md. */
async function cmdExecute(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string = ""): Promise<void> {
  if (!wf) { ctx.ui.notify("没有活动需求。先 /wf new。", "warning"); return; }
  if (!wf.epicId) { ctx.ui.notify("缺少 bd epic id。", "error"); return; }

  // Parse optional PRD path arg. Empty → use current requirement's prd.md.
  const prdArg = args.trim().replace(/["']/g, "");
  let prdPath = "";
  let epicIdOverride = "";
  if (prdArg) {
    prdPath = path.resolve(ctx.cwd, prdArg);
    if (!fs.existsSync(prdPath)) { ctx.ui.notify(`PRD 文件不存在:${prdPath}`, "error"); return; }
    // External PRD → auto-create a fresh epic (named after the file) so its
    // tasks/bugs stay isolated from the current requirement's epic.
    const epicTitle = path.basename(prdPath, ".md");
    try {
      epicIdOverride = bd.create(wf.repo, { title: epicTitle, type: "epic" });
    } catch (e) {
      ctx.ui.notify(`为外部 PRD 建 epic 失败:${(e as Error).message}`, "error"); return;
    }
    ctx.ui.notify(`外部 PRD:${prdPath}\n新建 epic:${epicIdOverride}(${epicTitle})`, "info");
  } else {
    prdPath = reqPath(wf, "prd.md");
    if (!fs.existsSync(prdPath)) { ctx.ui.notify("还没有 PRD。先 /wf prd 生成。", "error"); return; }
  }

  wf.mode = "build";
  wf.baseline = gitHead(wf.repo);
  saveState(wf);
  setModeStatus(ctx);

  const dirty = sh("git", ["status", "--porcelain", "--", ".", ":!.workflow"], wf.repo).stdout.trim();
  if (dirty) {
    const go = await ctx.ui.confirm("工作树不干净", "目标 repo 有未提交改动,建议先提交。仍要继续?");
    if (!go) { wf.mode = "plan"; saveState(wf); setModeStatus(ctx); return; }
  }

  // Resolve the omp binary (fall back to pi).
  const mgrBin = sh("which", ["omp"], wf.repo).stdout.trim() || sh("which", ["pi"], wf.repo).stdout.trim();
  if (!mgrBin) { ctx.ui.notify("找不到 omp 或 pi 二进制", "error"); return; }

  const extPath = fileURLToPath(import.meta.url);
  const managerModel = CONFIG.roles.split.model;  // manager uses the reasoning model
  const prompt = loadManagerPrompt(prdPath || undefined, epicIdOverride || undefined);

  ctx.ui.notify(`EXECUTE:启动经理进程(${mgrBin}, model ${managerModel})。它将拆 task、分配 dev、测试。`, "info");

  // Spawn the manager as a separate omp session in --print mode (non-interactive).
  // WF_ROLE=manager activates the dev/test tools inside that process.
  // WF_PRD_PATH/WF_EPIC_ID let /execute <prd-path> point the manager at a
  // specific PRD + auto-created epic (otherwise manager uses wf's defaults).
  const mgrEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    WF_ROLE: "manager",
    WF_REQID: wf.reqId,
    BEADS_REPO: wf.repo,
  };
  if (prdPath) mgrEnv.WF_PRD_PATH = prdPath;
  if (epicIdOverride) mgrEnv.WF_EPIC_ID = epicIdOverride;
  const mgrProc = spawn(mgrBin, [
    "-e", extPath,
    "--print",
    "--model", `${CONFIG.roles.split.provider}/${managerModel}`,
    prompt,
  ], { cwd: wf.repo, env: mgrEnv, stdio: ["ignore", "inherit", "inherit"] });

  const exitCode: number = await new Promise((resolve) => {
    mgrProc.on("exit", (code) => resolve(code ?? -1));
    mgrProc.on("error", () => resolve(-1));
  });

  // Commit artifacts regardless of manager outcome.
  const art = commitArtifacts(wf);
  // Reload state.json: the manager process may have written managerNoop=true
  // if it exited without calling split/assign (a silent no-op).
  try {
    const sp = reqPath(wf, "state.json");
    if (fs.existsSync(sp)) wf = { ...wf, ...JSON.parse(fs.readFileSync(sp, "utf8")) };
  } catch (_e) { /* keep in-memory */ }
  // Recover subtaskIds from bd if the manager's saveState was lost/clobbered.
  // The manager writes subtaskIds in split_prd_to_tasks, but a later agent_end
  // saveState (with stale wf) can overwrite it with []. bd is authoritative.
  if (wf.epicId && (!wf.subtaskIds || wf.subtaskIds.length === 0)) {
    try {
      const epic = process.env.WF_EPIC_ID || wf.epicId;
      const kids = bd.children(wf.repo, epic).filter((i: any) => i.issue_type === "task");
      if (kids.length > 0) wf.subtaskIds = kids.map((k: any) => k.id);
    } catch (_e) { /* bd unreachable, leave as-is */ }
  }

  if (exitCode === 0 && wf.managerNoop) {
    // Manager exited clean but did ZERO work (no split, no bd_task) — almost
    // certainly a model/prompt failure. Warn loudly so the user doesn't mistake
    // this for success.
    ctx.ui.notify(
      `⚠ EXECUTE 空跑:经理进程退出码 0,但没有调用任何工具(split_prd_to_tasks / bd_task / task 都没触发)。\n` +
      `可能原因:模型出错、prompt 问题、或经理进程崩溃。\n` +
      `bd epic ${wf.epicId} 下没有创建任何 task。请检查经理模型(${CONFIG.roles.split.provider}/${CONFIG.roles.split.model})配置后重试 /execute。`,
      "error"
    );
  } else if (exitCode === 0) {
    ctx.ui.notify(`EXECUTE 完成。${art.committed ? `工件已提交 ${art.sha?.slice(0, 8)}` : "(无工件改动)"}\n用 /wf status 查看 bd 状态,或 bd children ${wf.epicId}。`, "info");
  } else {
    ctx.ui.notify(`EXECUTE 经理进程退出码 ${exitCode}。可能部分完成——/wf status 查看,修复后可重新 /execute 继续。`, "warning");
  }
  wf.mode = "plan";
  saveState(wf);
  setModeStatus(ctx);
}

// ---------------------------------------------------------------------------
// Manager tools (registered only when WF_ROLE=manager)
// ---------------------------------------------------------------------------

function registerManagerTools(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  if (WF_ROLE !== "manager") return;
  if (!wf) return;

  // Tool 1: split_prd_to_tasks — read PRD, create bd tasks with deps
  pi.registerTool({
    name: "split_prd_to_tasks",
    label: "拆分 PRD 为 task",
    description: "读取 PRD 文件,把需求拆成尽量独立的 task(带依赖),创建为 bd issue。返回创建的 task 列表。",
    parameters: Type.Object({
      prd_path: Type.Optional(Type.String({ description: "PRD 文件路径(默认用上下文里的)" })),
    }),
    async execute(_id, params) {
      const prdPath = (params as any).prd_path || process.env.WF_PRD_PATH || reqPath(wf!, "prd.md");
      if (!fs.existsSync(prdPath)) {
        return { content: [{ type: "text", text: `错误:PRD 文件不存在 ${prdPath}` }], details: {} };
      }
      // Use the split LLM stage to produce the breakdown.
      const prdText = fs.readFileSync(prdPath, "utf8");
      const splitPromptText = withBrief(wf!.repo, [
        `你是技术负责人。基于以下 PRD,把需求拆成一组尽量独立、可单独实现与验证的子任务。`,
        `只输出严格 JSON:{"subtasks":[{"id":"01","title":"标题","depends_on":[],"spec":"完整 Markdown 规格"}]}`,
        `要求:id 从 01 递增;depends_on 用其他 id;被依赖者在前面;每个子任务可独立提交。`,
        ``,
        `--- PRD ---`,
        prdText,
      ].join("\n"));
      const splitText = await runStageText(pi, ctx, CONFIG.roles.split, splitPromptText);
      if (!splitText) {
        return { content: [{ type: "text", text: "错误:拆分模型无输出" }], details: {} };
      }
      let rawSubs: any[];
      try { rawSubs = extractSubtasksJson(splitText).subtasks; }
      catch (e) { return { content: [{ type: "text", text: `错误:${(e as Error).message}` }], details: {} }; }

      // Write specs + create bd issues.
      const created: { id: string; title: string; depends_on: string[] }[] = [];
      const idToBd = new Map<string, string>();
      for (let i = 0; i < rawSubs.length; i++) {
        const r = rawSubs[i];
        const logicalId = r.id || String(i + 1).padStart(2, "0");
        const file = `subtasks/${logicalId}-${slug(r.title)}.md`;
        fs.writeFileSync(reqPath(wf!, file), `# ${r.title}\n\n${String(r.spec || "").replace(/\r/g, "")}\n`);
        const specAbs = reqPath(wf!, file);
        const parentEpic = process.env.WF_EPIC_ID || wf!.epicId;
        const bdId = bd.create(wf!.repo, { title: r.title, type: "task", parent: parentEpic, notes: `规格文件:${specAbs}` });
        idToBd.set(logicalId, bdId);
        created.push({ id: bdId, title: r.title, depends_on: Array.isArray(r.depends_on) ? r.depends_on : [] });
      }
      // Add deps.
      for (const c of created) {
        for (const depLogical of c.depends_on) {
          const depBd = idToBd.get(depLogical);
          if (depBd) try { bd.depAdd(wf!.repo, c.id, depBd, "blocks"); } catch (_e) { /* ignore */ }
        }
      }
      wf!.subtaskIds = created.map((c) => c.id);
      saveState(wf!);
      mgrHasSplit = true;   // track that the manager actually did work
      const summary = created.map((c) => `${c.id}: ${c.title}${c.depends_on.length ? ` (依赖 ${c.depends_on.join(",")})` : ""}`).join("\n");
      return { content: [{ type: "text", text: `已创建 ${created.length} 个 task:\n${summary}\n\n现在对每个 ready 的 task:用 bd_task(action=claim) 认领,再用原生 task 工具调 dev subagent 实现,然后调 reviewer subagent review,根据 review 结果用 bd_task(close 或 reopen)。独立的 task 可并行(多次 task 调用)。` }], details: {} };
    },
  });

  // Tool 2: bd_task — atomic bd lifecycle operations (claim/close/reopen/comment).
  // The manager uses this for deterministic bd state transitions around native
  // task() calls to dev/reviewer subagents. Replaces the former assign_dev tool
  // which baked these into a spawn-based executor.
  pi.registerTool({
    name: "bd_task",
    label: "bd task 生命周期操作",
    description: "对 bd issue 做确定性生命周期操作:claim(原子认领)、close(关闭,可带 reason)、reopen(放回 ready)、comment(留备注)。配合原生 task 工具使用:claim → task(dev) → review → close/reopen。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("claim"), Type.Literal("close"), Type.Literal("reopen"), Type.Literal("comment")], { description: "操作类型" }),
      task_id: Type.String({ description: "bd issue id" }),
      text: Type.Optional(Type.String({ description: "close 的 reason / comment 的内容" })),
    }),
    async execute(_id, params) {
      const p = params as any;
      const action: string = p.action;
      const taskId: string = p.task_id;
      const text: string | undefined = p.text;
      const repo = wf!.repo;
      try {
        if (action === "claim") {
          const agent = `manager-${wf!.reqId}`;
          const ok = bd.claim(repo, taskId, agent);
          return { content: [{ type: "text", text: ok ? `✓ 已认领 ${taskId}` : `✗ 认领失败(已被占用或状态非 open):${taskId}` }], details: {} };
        }
        if (action === "close") {
          bd.close(repo, taskId, text);
          mgrTasksProcessed++;
          return { content: [{ type: "text", text: `✓ 已关闭 ${taskId}${text ? `(${text})` : ""}` }], details: {} };
        }
        if (action === "reopen") {
          bd.reopen(repo, taskId);
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

  // Tool 3: run_test — write cumulative diff + run the verify gate.
  // NOTE: per-task review is now done by the manager calling task(agent="reviewer")
  // during the dispatch loop. run_test is the FINAL whole-requirement gate:
  // it writes the cumulative diff (for the manager to feed a final reviewer
  // subagent if desired) and runs the P0 verify command. Bug creation from
  // review findings is now the manager's job (bd.create via bash), not baked in.
  pi.registerTool({
    name: "run_test",
    label: "测试产出",
    description: "所有 task 完成后调用。写累积 diff(供最终整体 review 用)+ 跑 P0 验证门。返回验证结果 + diff 路径。整体 review 由你(manager)自行调 task(agent='reviewer') 看 cumulative.diff;发现 blocker 用 bash 调 bd create 建 bug。",
    parameters: Type.Object({}),
    async execute() {
      // Write cumulative diff.
      const diffBase = wf!.baseline || "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const diff = sh("git", ["diff", diffBase, "HEAD"], wf!.repo).stdout;
      const diffPath = reqPath(wf!, "results", "cumulative.diff");
      try { fs.writeFileSync(diffPath, diff); } catch (_e) { /* ignore */ }

      // Verify gate (P0 safety — runs the configured verify command).
      const v = runVerify(CONFIG, wf!, true);
      const verifyPart = v.ok ? "验证通过" : `验证失败:\n${v.output.slice(-1500)}`;

      commitArtifacts(wf!);
      return {
        content: [{ type: "text", text:
          `${verifyPart}\n累积 diff 已写入:${diffPath}\n` +
          `下一步建议:调 task(agent="reviewer", task="审查整个需求的累积 diff:<diffPath>,对照 PRD:<prdPath>")。reviewer 返回 blocker 时,用 bash 跑 bd create 建 bug issue,再走 claim→task(dev)→task(reviewer) 循环修复。`
        }],
        details: {},
      };
    },
  });

  // HARD CONSTRAINT: lock the tool set so the manager delegates rather than
  // hand-writing code. The manager uses native `task` to spawn dev/reviewer
  // subagents, and the bd_task tool for deterministic bd lifecycle. Without
  // this lock, the manager LLM in --print mode would use built-in write/edit
  // to implement tasks directly, bypassing the dev subagent pipeline.
  try {
    pi.setActiveTools([
      "split_prd_to_tasks", "bd_task", "run_test",   // workflow tools (bd lifecycle + pipeline)
      "task",                                         // NATIVE omp: spawn dev/reviewer subagents
      ...READONLY_TOOLS,                             // read, grep, find, ls
      "bash",                                        // for bd CLI queries + reading code/diffs
    ]);
  } catch (_e) { /* if setActiveTools fails, tools remain open (best effort) */ }

  ctx.ui.notify(`经理工具已激活:split_prd_to_tasks, bd_task, run_test, task(原生 subagent)(已锁定:无法自己写代码)`, "info");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default function workflowExtension(pi: ExtensionAPI): void {
  CONFIG = loadConfig();
  registerProviders(pi);

  pi.on("session_start", async (_e, ctx) => {
    setModeStatus(ctx as any);
    // Main session: restore the most recent requirement so /execute etc. work
    // across sessions (wf is an in-memory singleton that doesn't survive restart).
    if (WF_ROLE === "main") {
      if (!wf && restoreLatestWf(ctx as any)) {
        ctx.ui.notify?.(`已恢复上次需求 ${wf!.reqId}(epic ${wf!.epicId})。\n/wf resume <reqId> 切换,或 /wf new 新建。`, "info");
        setModeStatus(ctx as any);
      }
    }
    // In manager mode, restore wf from state.json before registering tools.
    if (WF_ROLE === "manager") {
      const reqId = process.env.WF_REQID;
      if (reqId) {
        // Find the state.json: search .workflow/<reqId>/state.json in cwd and candidates.
        const cwd = process.cwd();
        const candidates = [
          path.join(cwd, ".workflow", reqId, "state.json"),
          ...((process.env.BEADS_REPO ? [path.join(process.env.BEADS_REPO, ".workflow", reqId, "state.json")] : [])),
        ];
        for (const sp of candidates) {
          if (fs.existsSync(sp)) {
            try {
              wf = JSON.parse(fs.readFileSync(sp, "utf8")) as WorkflowState;
              ctx.ui.notify?.(`经理:已恢复需求 ${wf.reqId}(epic ${wf.epicId})`, "info");
              break;
            } catch (_e) { /* ignore */ }
          }
        }
      }
      if (!wf) {
        ctx.ui.notify?.("经理:未能从 state.json 恢复需求状态,工具不可用", "error");
        return;
      }
      registerManagerTools(pi, ctx as any);
    }
  });

  pi.on("resources_discover", async () => {
    try {
      const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
      if (fs.existsSync(dir)) return { skillPaths: [dir] };
    } catch (_e) { /* ignore */ }
    return {};
  });

  pi.on("agent_end", async (event: any) => {
    try { const t = extractAssistantText(event?.messages); if (t) lastAssistantText = t; } catch (_e) { /* ignore */ }
    // Manager-side: detect "exited without doing any work" so the main session
    // can warn loudly instead of reporting a false success. Written to state.json
    // because the manager is a separate process (main reads it on exit).
    //
    // We use TWO signals: in-memory counters (mgrHasSplit/mgrTasksProcessed)
    // AND a bd reality check (actual task count under the epic). The bd check is
    // authoritative — if the tool ran but crashed mid-way (leaving counters
    // stale), bd still has the tasks it created. Only flag noop when BOTH agree.
    if (WF_ROLE === "manager" && wf) {
      const memSaysNoop = !mgrHasSplit && mgrTasksProcessed === 0;
      if (memSaysNoop) {
        // Double-check against bd: count actual tasks under the epic.
        let bdTaskCount = 0;
        try {
          if (wf.epicId) {
            const epic = process.env.WF_EPIC_ID || wf.epicId;
            bdTaskCount = bd.children(wf.repo, epic).filter((i: any) => i.issue_type === "task").length;
          }
        } catch (_e) { /* if bd is unreachable, trust the memory signal */ }
        // If bd has tasks, the manager DID work (tool ran, just didn't update
        // counters). Don't flag noop.
        if (bdTaskCount === 0) {
          wf.managerNoop = true;
          saveState(wf);
        }
      }
    }
  });

  // Commands only in main session (not the manager).
  if (WF_ROLE === "main") {
    pi.registerCommand("wf", {
      description: "workflow(PRD + 执行双模式):new / prd / analyze / status / verify / execute / help",
      getArgumentCompletions: (prefix: string) => {
        const subs = ["new", "prd", "analyze", "status", "verify", "execute", "resume", "bug", "help"];
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
          case "resume": cmdResume(ctx, rest); break;
          case "bug": await cmdBug(pi, ctx, rest); break;
          case "execute": await cmdExecute(pi, ctx, rest); break;
          case "verify":
            if (!wf) { ctx.ui.notify("无活动需求。", "warning"); break; }
            wf.verifyCommand = rest; saveState(wf);
            ctx.ui.notify(`验证命令:${rest || "(清空)"}`, "info"); break;
          default:
            ctx.ui.notify([
              "workflow 用法(PRD + 执行双模式):",
              "/wf new <名> [repo]    新建需求(bd epic),进 PRD 模式(只读讨论)",
              "/plan                   回 PRD 模式讨论",
              "/wf resume [reqId]      切换到已有需求(无参=列列表)。新 session 自动恢复最近需求",
              "/wf analyze [--refresh] 分析仓库,生成跨需求复用简报",
              "/wf prd                 生成 prd.md(glm-5.2,基于讨论)",
              "/execute [prd路径]      启动经理进程:拆 task→分配 dev(omp subagent)→测试。传 PRD 路径则用该 PRD(自动建新 epic),否则用当前需求 prd.md",
              "/wf status              查看 bd 子任务状态",
              "/wf bug <描述>          建 bd bug(挂当前需求 epic,跳过 PRD),然后 /execute 修复",
              "/wf verify <cmd>        设置验证命令",
            ].join("\n"), "info");
        }
      },
    });

    pi.registerCommand("plan", {
      description: "进入 PRD 模式(讨论需求,只读)",
      handler: async (_args: string, ctx: ExtensionCommandContext) => { await cmdPlan(pi, ctx); },
    });

    pi.registerCommand("execute", {
      description: "进入执行模式(启动经理:拆 task→分配 dev→测试)",
      handler: async (args: string, ctx: ExtensionCommandContext) => { await cmdExecute(pi, ctx, args); },
    });
  }
}
