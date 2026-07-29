import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CAPABILITY_REGISTRY_KEY = "pi-subagents.capability-ceiling.v1";
const PLAN_CEILING_SOURCE = "pi-workflow-plan";

export const PLAN_ADVISORY_TOOLS = [
  "read", "grep", "find", "ls",
  "web_search", "fetch_content", "get_search_content", "source_check",
] as const;

type Ceiling = { version: 1; allowedTools: string[]; denyExtensions: boolean; sources: string[] };
type Handle = { update(allowedTools: readonly string[]): void; dispose(): void };
type Registry = Map<string, Map<symbol, { source: string; ceiling: Ceiling }>>;

let ceilingHandle: Handle | undefined;
let ceilingSessionId: string | undefined;

function capabilityRegistry(): Registry | undefined {
  const key = Symbol.for(CAPABILITY_REGISTRY_KEY);
  const store = globalThis as typeof globalThis & { [key: symbol]: unknown };
  return store[key] instanceof Map ? store[key] as Registry : undefined;
}

/** Remove this extension's ceilings even when /reload discarded the local handle. */
export function clearWorkflowCapabilityCeilings(sessionIdValue?: string): number {
  const registry = capabilityRegistry();
  if (!registry) return 0;
  let removed = 0;
  const sessions = sessionIdValue
    ? [[sessionIdValue, registry.get(sessionIdValue)] as const]
    : [...registry.entries()];
  for (const [id, session] of sessions) {
    if (!session) continue;
    for (const [token, entry] of session) {
      if (entry.source !== PLAN_CEILING_SOURCE && !entry.ceiling.sources.includes(PLAN_CEILING_SOURCE)) continue;
      session.delete(token);
      removed++;
    }
    if (session.size === 0) registry.delete(id);
  }
  return removed;
}

function sessionId(ctx: any): string | undefined {
  try { return ctx?.sessionManager?.getSessionId?.() || undefined; }
  catch { return undefined; }
}

/** Registry-compatible adapter for pi-subagents' public capability-ceiling API. */
function registerCeiling(sessionIdValue: string, source: string, allowedTools: readonly string[]): Handle {
  const key = Symbol.for(CAPABILITY_REGISTRY_KEY);
  const store = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const registry = store[key] instanceof Map ? store[key] as Registry : new Map<string, Map<symbol, { source: string; ceiling: Ceiling }>>();
  store[key] = registry;
  let session = registry.get(sessionIdValue);
  if (!session) { session = new Map(); registry.set(sessionIdValue, session); }
  const token = Symbol(source);
  const set = (tools: readonly string[]) => session!.set(token, {
    source,
    ceiling: { version: 1, allowedTools: [...new Set(tools)].sort(), denyExtensions: false, sources: [source] },
  });
  set(allowedTools);
  let disposed = false;
  return {
    update(tools) {
      if (disposed) throw new Error("Cannot update disposed PLAN capability ceiling");
      set(tools);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      session!.delete(token);
      if (session!.size === 0) registry.delete(sessionIdValue);
    },
  };
}

/** Keep PLAN children under a monotonic read/search-only ceiling; BUILD is unrestricted. */
export function syncSubagentCapabilityCeiling(ctx: any, mode: "plan" | "build" | undefined): void {
  const currentSessionId = sessionId(ctx);
  if (mode !== "plan") {
    ceilingHandle?.dispose();
    ceilingHandle = undefined;
    ceilingSessionId = undefined;
    // Capability entries live in a global registry while the handle lives in
    // this module instance. /reload can therefore orphan an old PLAN token.
    // BUILD must remove every token owned by this extension, not just the one
    // reachable through the current module-local handle.
    clearWorkflowCapabilityCeilings();
    return;
  }
  if (!currentSessionId) throw new Error("无法建立 PLAN subagent capability ceiling:缺少 sessionId");
  // Remove both the current handle and orphaned tokens from previous extension
  // instances, then register one authoritative ceiling for this session.
  ceilingHandle?.dispose();
  ceilingHandle = undefined;
  ceilingSessionId = undefined;
  clearWorkflowCapabilityCeilings(currentSessionId);
  ceilingHandle = registerCeiling(currentSessionId, PLAN_CEILING_SOURCE, PLAN_ADVISORY_TOOLS);
  ceilingSessionId = currentSessionId;
}

async function importPiSubagentsApi(name: "capability-ceiling" | "preflight"): Promise<any> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const agentHome = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const fileName = name === "capability-ceiling" ? "capability-ceiling.ts" : "preflight.ts";
  const candidates = [
    `pi-subagents/${name}`,
    pathToFileURL(path.join(here, "..", "..", ".pi", "npm", "node_modules", "pi-subagents", "src", "api", fileName)).href,
    pathToFileURL(path.join(agentHome, "npm", "node_modules", "pi-subagents", "src", "api", fileName)).href,
  ];
  let lastError: unknown;
  for (const specifier of candidates) {
    try {
      if (specifier.startsWith("file:") && !fs.existsSync(fileURLToPath(specifier))) continue;
      return await import(specifier);
    } catch (error) { lastError = error; }
  }
  throw new Error(`无法加载 pi-subagents/${name};需要 pi-subagents v0.37.2+:${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Resolve the effective builtin exactly as pi-subagents will launch it. */
export async function validateAdvisoryLaunchContract(input: any, ctx: any): Promise<string | undefined> {
  const currentSessionId = sessionId(ctx);
  if (!currentSessionId) return "无法验证 builtin advisory launch contract:缺少 sessionId";
  const [{ resolveCurrentSubagentCapabilityCeiling }, { resolveSubagentLaunchContract }] = await Promise.all([
    importPiSubagentsApi("capability-ceiling"),
    importPiSubagentsApi("preflight"),
  ]);
  const capabilityCeiling = resolveCurrentSubagentCapabilityCeiling(currentSessionId);
  if (!capabilityCeiling?.allowedTools) return "PLAN advisory capability ceiling 未生效";
  const result = await resolveSubagentLaunchContract({
    agent: String(input?.agent || ""),
    cwd: String(input?.cwd || ""),
    task: typeof input?.task === "string" ? input.task : undefined,
    context: input?.context,
    output: input?.output,
    capabilityCeiling,
  });
  if (!result.ok) return `builtin advisory preflight 失败:${result.message}`;
  if (result.contract.agent.source !== "builtin") {
    return `advisory agent 必须解析为 builtin,实际来源:${result.contract.agent.source} (${result.contract.agent.filePath})`;
  }
  const forbidden = result.contract.tools.effectiveAllowlist.filter((tool: string) => ["write", "edit", "bash", "bd", "subagent"].includes(tool));
  if (forbidden.length > 0) return `advisory capability ceiling 泄漏危险工具:${forbidden.join(",")}`;
  if (result.contract.tools.configuredExtensions.length > 0) return "advisory agent 禁止 subagents.defaultExtensions/agent extensions";
  return undefined;
}
