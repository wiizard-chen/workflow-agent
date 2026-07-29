import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  addUsage, buildRunSummary, commitArtifacts, emptyUsageTotals, formatUsageLine,
  getVerifyCommand, gitHead, isGitRepo, nowStamp, readRepoBrief, readRunSummary,
  repoBriefPath, reqPath, runVerify, saveState, sh, slug, writeRunSummary,
  validateIntegratedCommitRange,
  type ModelProfile, type ModelProfileEntry, type ResolvedModelProfile, type RoleRef, type ThinkingEffort,
  type UsageTotals, type WorkflowConfig, type WorkflowState,
} from "../lib.ts";
import * as bd from "../bd.ts";
import { syncSubagentCapabilityCeiling } from "./capabilities.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_PROFILES: Record<string, ModelProfile> = {
  gpt56: {
    main: { model: "codex2api/gpt-5.6-sol", effort: "xhigh" },
    prd: { model: "codex2api/gpt-5.6-sol", effort: "high" },
    dev: { model: "codex2api/gpt-5.6-terra", effort: "high" },
    reviewer: { model: "codex2api/gpt-5.6-luna", effort: "xhigh" },
    finalReviewer: { model: "codex2api/gpt-5.6-luna", effort: "xhigh" },
  },
  "deepseek-glm": {
    main: { model: "deepseek/deepseek-v4-pro", effort: "high" },
    prd: { model: "zai/glm-5.2", effort: "high" },
    dev: { model: "deepseek/deepseek-v4-flash", effort: "high" },
    reviewer: { model: "zai/glm-5.2", effort: "high" },
    finalReviewer: { model: "zai/glm-5.2", effort: "high" },
  },
};

const THINKING_EFFORTS = new Set<ThinkingEffort>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_ROLE_EFFORT: Record<keyof ResolvedModelProfile, ThinkingEffort> = {
  main: "xhigh", prd: "high", dev: "high", reviewer: "xhigh", finalReviewer: "xhigh",
};

function defaultEffortForProfile(profileName: string | undefined, key: keyof ResolvedModelProfile): ThinkingEffort {
  if (profileName === "deepseek-glm") return "high";
  return DEFAULT_ROLE_EFFORT[key];
}

export function parseProfileEntry(value: unknown, key: keyof ResolvedModelProfile, profileName?: string): ModelProfileEntry {
  const entry = typeof value === "string" ? { model: value, effort: defaultEffortForProfile(profileName, key) } : value as any;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`模型 profile ${key} 必须是字符串或 {model,effort} 对象`);
  const model = String(entry.model || "").trim();
  parseQualifiedModel(model);
  if (typeof entry.effort !== "string" || !THINKING_EFFORTS.has(entry.effort as ThinkingEffort)) {
    throw new Error(`模型 profile ${key}.effort 无效:${String(entry.effort ?? "(空)")}`);
  }
  return { model, effort: entry.effort as ThinkingEffort };
}

export function parseQualifiedModel(value: string, effort: ThinkingEffort = "high"): RoleRef {
  const normalized = String(value || "").trim();
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash === normalized.length - 1) throw new Error(`模型必须是 provider/model 格式:${normalized || "(空)"}`);
  return { provider: normalized.slice(0, slash), model: normalized.slice(slash + 1), effort };
}

export function activeModelProfile(config: WorkflowConfig = CONFIG): ResolvedModelProfile {
  const profile = config.modelProfiles?.[config.activeModelProfile];
  if (!profile) throw new Error(`未知 activeModelProfile:${config.activeModelProfile}`);
  return {
    main: parseProfileEntry(profile.main, "main", config.activeModelProfile),
    prd: parseProfileEntry(profile.prd, "prd", config.activeModelProfile),
    dev: parseProfileEntry(profile.dev, "dev", config.activeModelProfile),
    reviewer: parseProfileEntry(profile.reviewer, "reviewer", config.activeModelProfile),
    finalReviewer: parseProfileEntry(profile.finalReviewer, "finalReviewer", config.activeModelProfile),
  };
}

export async function assertActiveProfileModelsAvailable(ctx: ExtensionCommandContext, config: WorkflowConfig = CONFIG): Promise<void> {
  const profile = activeModelProfile(config);
  const available = await ctx.modelRegistry.getAvailable();
  const availableIds = new Set(available.map((model: any) => `${model.provider}/${model.id}`));
  for (const entry of Object.values(profile)) {
    const role = parseQualifiedModel(entry.model, entry.effort);
    if (!ctx.modelRegistry.find(role.provider, role.model)) throw new Error(`active profile 模型未注册:${entry.model}`);
    if (!availableIds.has(entry.model)) throw new Error(`active profile 模型未配置认证或当前不可用:${entry.model}`);
  }
}

export function workflowAgentConfig(agent: string, config: WorkflowConfig = CONFIG): ModelProfileEntry {
  const profile = activeModelProfile(config);
  if (agent === "pi-workflow.prd-writer") return profile.prd;
  if (agent === "pi-workflow.dev") return profile.dev;
  if (agent === "pi-workflow.reviewer") return profile.reviewer;
  if (agent === "pi-workflow.final-reviewer") return profile.finalReviewer;
  throw new Error(`未知 workflow agent:${agent}`);
}

export function workflowAgentModel(agent: string, config: WorkflowConfig = CONFIG): string {
  return workflowAgentConfig(agent, config).model;
}

export function workflowAgentEffort(agent: string, config: WorkflowConfig = CONFIG): ThinkingEffort {
  return workflowAgentConfig(agent, config).effort;
}

function roleFromEntry(entry: ModelProfileEntry): RoleRef {
  return parseQualifiedModel(entry.model, entry.effort);
}

function derivedRoles(profile: ModelProfile, profileName: string): WorkflowConfig["roles"] {
  const resolved: ResolvedModelProfile = {
    main: parseProfileEntry(profile.main, "main", profileName), prd: parseProfileEntry(profile.prd, "prd", profileName),
    dev: parseProfileEntry(profile.dev, "dev", profileName), reviewer: parseProfileEntry(profile.reviewer, "reviewer", profileName),
    finalReviewer: parseProfileEntry(profile.finalReviewer, "finalReviewer", profileName),
  };
  return {
    discuss: roleFromEntry(resolved.main),
    prd: roleFromEntry(resolved.prd),
    split: roleFromEntry(resolved.main),
    review: roleFromEntry(resolved.reviewer),
  };
}

export const DEFAULT_CONFIG: WorkflowConfig = {
  providers: {
    deepseek: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", api: "openai-completions", thinkingFormat: "deepseek" },
    zai: { baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKeyEnv: "GLM5_2_API_KEY", api: "openai-completions", thinkingFormat: "zai" },
  },
  activeModelProfile: "gpt56",
  modelProfiles: DEFAULT_MODEL_PROFILES,
  roles: derivedRoles(DEFAULT_MODEL_PROFILES.gpt56, "gpt56"),
  build: { verifyCommand: "", commitPrefix: "subtask" },
  // Worktree-isolated parallel children return patches/handoff manifests; they
  // do not auto-merge into the target repository. Until deterministic handoff
  // integration is implemented, the safe default is one serial dev writer.
  execute: { driver: "bd", maxParallel: 1, pollIntervalMs: 2000 },
};

export function configuredActiveProfileName(raw: any, fallback: string): string {
  if (!Object.prototype.hasOwnProperty.call(raw, "activeModelProfile")) return fallback;
  if (typeof raw.activeModelProfile !== "string" || !raw.activeModelProfile.trim()) {
    throw new Error("workflow 配置 activeModelProfile 必须是非空字符串");
  }
  return raw.activeModelProfile.trim();
}

export function loadConfig(): WorkflowConfig {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "workflow.config.json"),
    path.join(here, "..", "workflow.config.json"),
    path.join(process.cwd(), "workflow.config.json"),
  ];
  const configPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!configPath) return DEFAULT_CONFIG;
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch (e) { throw new Error(`workflow 配置解析失败:${configPath}:${(e as Error).message}`); }
  if (raw.modelProfiles !== undefined && (!raw.modelProfiles || typeof raw.modelProfiles !== "object" || Array.isArray(raw.modelProfiles))) {
    throw new Error(`workflow 配置 modelProfiles 必须是对象 (${configPath})`);
  }
  const modelProfiles = { ...DEFAULT_MODEL_PROFILES, ...(raw.modelProfiles || {}) } as Record<string, ModelProfile>;
  let activeName: string;
  try { activeName = configuredActiveProfileName(raw, DEFAULT_CONFIG.activeModelProfile); }
  catch (e) { throw new Error(`${(e as Error).message} (${configPath})`); }
  const profile = modelProfiles[activeName];
  if (!profile) throw new Error(`workflow 配置引用未知 profile:${activeName} (${configPath})`);
  const config: WorkflowConfig = {
    providers: { ...DEFAULT_CONFIG.providers, ...(raw.providers || {}) },
    activeModelProfile: activeName,
    modelProfiles,
    roles: derivedRoles(profile, activeName),
    build: { ...DEFAULT_CONFIG.build, ...(raw.build || {}) },
    execute: { ...DEFAULT_CONFIG.execute, ...(raw.execute || {}) },
  };
  activeModelProfile(config);
  return config;
}

export const READONLY_TOOLS = ["read", "grep", "find", "ls"];

// Tools registered by nicobailon/pi-web-access (pi install npm:pi-web-access),
// if installed. These are plain extension tools (not MCP-prefixed like the
// playwright bridge below), so they need an explicit name allowlist rather
// than the prefix-matching used for MCP servers. Web access is read-only by
// nature (search/fetch, no code mutation), so it's safe to allow in PLAN mode
// alongside playwright-mcp — the two are complementary, not competing:
// playwright-mcp drives a real browser for frontend debugging (screenshots,
// DOM interaction, click-testing); pi-web-access is for PLAN-stage research
// (search, doc/GitHub content fetch) without needing a live browser session.
export const WEB_ACCESS_TOOLS = ["web_search", "fetch_content", "get_search_content", "source_check"];

export let CONFIG = loadConfig();
export let wf: WorkflowState | undefined;
export let baseActiveTools: string[] = [];
export let activeDevToolCallId: string | undefined;
// Tool-call tracking: detect "session did zero work" (no split, no bd_task) so we
// can warn instead of reporting a false success.
export let mgrHasSplit = false;
export let mgrTasksProcessed = 0;
export let lastAssistantText = "";

// Cost/cache telemetry accumulator, keyed by "provider/model". Reset when the
// active requirement changes; flushed to results/summary.json on every turn end
// (cheap: one small JSON write) so a crashed/interrupted run still leaves data.
export let usageByModel: Record<string, UsageTotals> = {};

export function setConfig(value: WorkflowConfig): void { CONFIG = value; }
export function setWorkflow(value: WorkflowState | undefined): void { wf = value; }
export function setBaseActiveTools(value: string[]): void { baseActiveTools = value; }
export function setActiveDevToolCallId(value: string | undefined): void { activeDevToolCallId = value; }
export function setManagerSplit(value: boolean): void { mgrHasSplit = value; }
export function setManagerTasksProcessed(value: number): void { mgrTasksProcessed = value; }
export function incrementManagerTasksProcessed(): void { mgrTasksProcessed++; }
export function setLastAssistantText(value: string): void { lastAssistantText = value; }
export function resetUsageByModel(): void { usageByModel = {}; }

/** Fold the just-finished message's usage into the accumulator + persist. */
export function trackUsage(event: any, ctx: any): void {
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

export async function waitTurnComplete(ctx: ExtensionCommandContext, maxMs = 600000): Promise<void> {
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

export function setModeStatus(ctx: ExtensionCommandContext): void {
  const label = wf ? `WF:${wf.mode} ${wf.reqId}` : "WF:—";
  try { ctx.ui.setStatus("workflow", label); } catch (_e) { /* ignore */ }
}

/** Apply the capability boundary for the active workflow mode. */
export function applyModeTools(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  syncSubagentCapabilityCeiling(ctx, wf?.mode);
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

export function readJson(file: string): any | undefined {
  try { return JSON.parse(stripFence(fs.readFileSync(file, "utf8"))); }
  catch { return undefined; }
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256File(file: string): string | undefined {
  return fs.existsSync(file) ? sha256Text(fs.readFileSync(file, "utf8")) : undefined;
}

export function resolvedPath(value: unknown): string {
  return path.resolve(String(value || ""));
}

export function pathInside(child: string, parent: string): boolean {
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

export function bundledAgentsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".pi", "agents");
}

export function agentRuntimeName(file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, "utf8");
    const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fm) return undefined;
    const name = fm[1].match(/^name:\s*([^\n#]+)/m)?.[1]?.trim();
    const pkg = fm[1].match(/^package:\s*([^\n#]+)/m)?.[1]?.trim();
    return name ? (pkg ? `${pkg}.${name}` : name) : undefined;
  } catch { return undefined; }
}

export function markdownFiles(dir: string): string[] {
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
export function assertWorkflowAgentsUnshadowed(repo: string): void {
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

export const ADVISORY_AGENTS = ["researcher", "scout", "oracle"] as const;

export function advisoryRepoSnapshot(repo: string): { head: string | null; status: string } {
  const result = sh("git", ["status", "--porcelain=v1", "--untracked-files=all"], repo);
  const status = result.code === 0
    ? result.stdout.split("\n").filter((line) => line && !line.includes(".workflow/")).join("\n")
    : `ERROR:${result.stderr}`;
  return { head: gitHead(repo) ?? null, status };
}

export function advisoryOutputPath(agent: string): string {
  if (!wf) throw new Error("没有活动需求");
  if (agent === "researcher") return reqPath(wf, "results", "research.md");
  if (agent === "scout") return repoBriefPath(wf.repo);
  if (agent === "oracle") return reqPath(wf, "results", "prd-oracle.md");
  throw new Error(`未知 advisory agent:${agent}`);
}

export function nearestProjectSettings(repo: string): string | undefined {
  let current = path.resolve(repo);
  while (true) {
    const candidate = path.join(current, ".pi", "settings.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Fail closed if project/user definitions shadow builtin PLAN advisory roles. */
export function assertAdvisoryAgentsUnshadowed(repo: string): void {
  const required = new Set<string>(ADVISORY_AGENTS);
  const dirs = [
    path.join(repo, ".pi", "agents"), path.join(repo, ".agents"),
    path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "agents"),
    path.join(os.homedir(), ".agents"),
    ...(process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS || "").split(path.delimiter).filter(Boolean),
  ];
  for (const dir of dirs) {
    for (const file of markdownFiles(dir)) {
      const runtime = agentRuntimeName(file);
      if (runtime && required.has(runtime)) throw new Error(`builtin advisory agent 被高优先级定义覆盖:${runtime} (${file})`);
    }
  }
  const projectSettings = nearestProjectSettings(repo);
  for (const settingsPath of [
    path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "settings.json"),
    ...(projectSettings ? [projectSettings] : []),
  ]) {
    const settings = readJson(settingsPath);
    const subagents = settings?.subagents;
    if (Array.isArray(subagents?.defaultExtensions) && subagents.defaultExtensions.length > 0) {
      throw new Error(`builtin advisory agent 禁止 subagents.defaultExtensions (${settingsPath})`);
    }
    if (subagents?.disableBuiltins === true) throw new Error(`builtin advisory agents 已被禁用 (${settingsPath})`);
    const overrides = subagents?.agentOverrides;
    if (!overrides || typeof overrides !== "object") continue;
    for (const runtime of required) if (Object.prototype.hasOwnProperty.call(overrides, runtime)) {
      const override = overrides[runtime];
      const safeKeys = new Set(["model", "fallbackModels", "thinking"]);
      const unsafeKeys = !override || typeof override !== "object" || Array.isArray(override)
        ? ["invalid override"]
        : Object.keys(override).filter((key) => !safeKeys.has(key));
      if (unsafeKeys.length > 0) {
        throw new Error(`builtin advisory agent 存在不安全 settings override:${runtime} [${unsafeKeys.join(",")}] (${settingsPath})`);
      }
    }
  }
}

export function assertActiveChildIssue(taskId: string): bd.BdIssue {
  if (!wf?.epicId) throw new Error("没有活动 epic");
  const issue = bd.show(wf.repo, taskId);
  if (!issue || issue.parent !== wf.epicId || (issue.issue_type !== "task" && issue.issue_type !== "bug")) {
    throw new Error(`issue ${taskId} 不是活动 epic ${wf.epicId} 的直接 task/bug child`);
  }
  return issue;
}

export function validateSubagentCall(event: any): string | undefined {
  if (!wf) return undefined;
  try { assertWorkflowAgentsUnshadowed(wf.repo); }
  catch (e) { return (e as Error).message; }
  const input = event?.input ?? {};
  if (input.tasks || input.chain || input.worktree || input.async || input.count) {
    return "workflow 禁止 parallel/chain/worktree/async subagent 调用";
  }
  if (input.acceptance || input.outputSchema) {
    return "workflow 禁止覆盖 agent acceptance/output schema";
  }
  if (resolvedPath(input.cwd) !== path.resolve(wf.repo)) {
    return `subagent cwd 必须精确为当前 workflow repo:${wf.repo}`;
  }
  const agent = String(input.agent || "");
  const output = resolvedPath(input.output);

  if (wf.mode === "plan") {
    if ((ADVISORY_AGENTS as readonly string[]).includes(agent)) {
      const allowedKeys = new Set(["agent", "task", "context", "cwd", "output"]);
      const unsupportedKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
      if (unsupportedKeys.length > 0) return `advisory subagent 参数不允许:${unsupportedKeys.join(",")}`;
      try { assertAdvisoryAgentsUnshadowed(wf.repo); }
      catch (e) { return (e as Error).message; }
      const expectedContext = agent === "oracle" ? "fork" : "fresh";
      if (input.context !== expectedContext) return `${agent} 必须 context=${expectedContext}`;
      if (output !== path.resolve(advisoryOutputPath(agent))) return `${agent} output 路径错误`;
      return undefined;
    }
    if (agent !== "pi-workflow.prd-writer") return "plan 模式只允许 researcher/scout/oracle advisory 或 pi-workflow.prd-writer";
    const expected = workflowAgentConfig(agent);
    if (input.model !== expected.model) return `prd-writer model 必须是 active profile 配置:${expected.model}`;
    if (input.thinking !== expected.effort) return `prd-writer effort 必须是 active profile 配置:${expected.effort}`;
    if (input.context !== "fork") return "prd-writer 必须 context=fork";
    if (output !== path.resolve(reqPath(wf, "prd.md"))) return "prd-writer output 必须是当前 prd.md";
    return undefined;
  }

  const resultsDir = reqPath(wf, "results");
  if (!pathInside(output, resultsDir)) return `subagent output 必须位于 ${resultsDir}`;
  if (!["pi-workflow.dev", "pi-workflow.reviewer", "pi-workflow.final-reviewer"].includes(agent)) {
    return "build 模式只允许 pi-workflow.dev/reviewer/final-reviewer";
  }
  const expected = workflowAgentConfig(agent);
  if (input.model !== expected.model) return `${agent} model 必须是 active profile 配置:${expected.model}`;
  if (input.thinking !== expected.effort) return `${agent} effort 必须是 active profile 配置:${expected.effort}`;
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
export function listAllStates(repo: string): WorkflowState[] {
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

export function lockReadonly(pi: ExtensionAPI, allowSubagent = false): void {
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

export function readMcpServers(): Record<string, unknown> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [path.join(here, "..", "..", ".mcp.json"), path.join(here, "..", ".mcp.json")];
    for (const p of candidates) {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  } catch (_e) { /* ignore */ }
  return {};
}

export function extractAssistantText(messages: any[]): string {
  let out = "";
  for (const m of messages || []) {
    if (!m || m.role !== "assistant") continue;
    const c = m.content;
    if (typeof c === "string") out = c;
    else if (Array.isArray(c)) out = c.filter((p) => p && p.type === "text").map((p) => p.text).join("");
  }
  return out.trim();
}

export function stripFence(text: string): string {
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

export async function useRole(pi: ExtensionAPI, ctx: ExtensionCommandContext, role: RoleRef): Promise<boolean> {
  const model = ctx.modelRegistry.find(role.provider, role.model);
  if (!model) { ctx.ui.notify(`模型未找到:${role.provider}/${role.model}`, "error"); return false; }
  const ok = await pi.setModel(model);
  if (!ok) { ctx.ui.notify(`无法切换到 ${role.provider}/${role.model}:缺少 API key`, "error"); return false; }
  const resolvedModel = ctx.model;
  if (resolvedModel?.provider !== role.provider || resolvedModel?.id !== role.model) {
    ctx.ui.notify(`模型切换结果不匹配:请求 ${role.provider}/${role.model},实际 ${resolvedModel ? `${resolvedModel.provider}/${resolvedModel.id}` : "(无)"}`, "error");
    return false;
  }
  pi.setThinkingLevel(role.effort);
  const resolvedEffort = pi.getThinkingLevel();
  if (resolvedEffort !== role.effort) {
    ctx.ui.notify(`无法应用 effort=${role.effort} 到 ${role.provider}/${role.model}:实际为 ${resolvedEffort}`, "error");
    return false;
  }
  return true;
}

export async function runStageText(pi: ExtensionAPI, ctx: ExtensionCommandContext, role: RoleRef, prompt: string, attempts = 3): Promise<string | null> {
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

export function withBrief(repo: string, body: string): string {
  const brief = readRepoBrief(repo);
  if (!brief) return body;
  return [`以下是对目标仓库的分析简报(供你参考,不要重复分析仓库):`, `--- 仓库简报 开始 ---`, brief.trim(), `--- 仓库简报 结束 ---`, ``, body].join("\n");
}

export function analyzePrompt(): string {
  return [
    `你是资深技术负责人,第一次接触这个仓库。用只读工具(read/grep/find/ls)探查这个仓库,产出一份分析简报。`,
    `直接把简报的 Markdown 正文作为你的回答输出(不要用工具写文件,不要用代码块包裹,不要额外解释)。`,
    `简报需包含:## 技术栈、## 目录结构与关键模块、## 代码约定、## 相关已有模块、## 建议验证命令(以 \`建议命令:\` 开头)。`,
  ].join("\n");
}

export function extractSuggestedVerifyCommand(brief: string): string | undefined {
  const m = brief.match(/建议命令[:：]\s*`?([^\n`]+)`?/);
  if (!m) return undefined;
  const cmd = m[1].trim();
  if (!cmd || /未发现|建议留空|none|n\/a/i.test(cmd)) return undefined;
  return cmd;
}

