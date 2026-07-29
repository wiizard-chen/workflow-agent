/**
 * workflow lib — pure, omp-independent helpers (types, git/fs, verify).
 * The manager LLM drives execution via omp's native task tool + the bd_task
 * extension tool (see workflow.ts). Kept separate from the omp extension so
 * it can be unit-tested without a live model.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface RoleRef { provider: string; model: string; effort: ThinkingEffort; }
export interface ModelProfileEntry { model: string; effort: ThinkingEffort; }
export type ModelProfileValue = string | ModelProfileEntry;

export interface ModelProfile {
  /** Main PLAN discussion, issue analysis, splitting, and BUILD manager model. */
  main: ModelProfileValue;
  prd: ModelProfileValue;
  dev: ModelProfileValue;
  reviewer: ModelProfileValue;
  finalReviewer: ModelProfileValue;
}

export interface ResolvedModelProfile {
  main: ModelProfileEntry;
  prd: ModelProfileEntry;
  dev: ModelProfileEntry;
  reviewer: ModelProfileEntry;
  finalReviewer: ModelProfileEntry;
}

export interface WorkflowConfig {
  providers: Record<string, { baseUrl: string; apiKeyEnv: string; api: string; thinkingFormat?: string }>;
  activeModelProfile: string;
  modelProfiles: Record<string, ModelProfile>;
  /** Derived compatibility view used by existing main-session stage helpers. */
  roles: { discuss: RoleRef; prd: RoleRef; split: RoleRef; review: RoleRef };
  build: { verifyCommand: string; commitPrefix: string };
  /** Execution layer config. All role models are resolved from the active model profile. */
  execute?: {
    driver?: "bd";          // only "bd" supported; default "bd"
    maxParallel?: number;   // suggested parallel task(dev) calls for the manager prompt; default 1
    pollIntervalMs?: number; // unused in omp-native path; kept for compat
  };
}

export type Mode = "plan" | "build";

export interface WorkflowState {
  reqId: string;
  name: string;
  repo: string;
  mode: Mode;
  createdAt: string;
  baseline?: string;
  verifyCommand?: string;
  /** bd parent epic issue id for this requirement (v2). */
  epicId?: string;
  /** Ordered list of subtask ids (bd issue ids) under the epic, for display & metrics. */
  subtaskIds?: string[];
  /** Set by the manager process if it exited without calling any tools (split/assign).
   *  Read by cmdExecute to warn loudly instead of reporting success. */
  managerNoop?: boolean;
}

export type Notify = (msg: string, level?: "info" | "warning" | "error") => void;

// ---------------------------------------------------------------------------
// Constants & pure helpers
// ---------------------------------------------------------------------------

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "req";
}

export function nowStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function reqDir(s: WorkflowState): string { return path.join(s.repo, ".workflow", s.reqId); }
export function reqPath(s: WorkflowState, ...p: string[]): string { return path.join(reqDir(s), ...p); }

/** Repo-level (not per-requirement) steering artifact: shared across all requirements in this repo. */
export function repoBriefPath(repo: string): string { return path.join(repo, ".workflow", "_repo-brief.md"); }
export function readRepoBrief(repo: string): string | undefined {
  const p = repoBriefPath(repo);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
}

export function saveState(s: WorkflowState): void {
  try {
    fs.mkdirSync(reqDir(s), { recursive: true });
    fs.writeFileSync(reqPath(s, "state.json"), JSON.stringify(s, null, 2));
  } catch (_e) { /* best effort */ }
}

export function sh(cmd: string, args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

export function isGitRepo(dir: string): boolean {
  return sh("git", ["rev-parse", "--is-inside-work-tree"], dir).stdout.trim() === "true";
}

export function gitHead(dir: string): string | undefined {
  const r = sh("git", ["rev-parse", "HEAD"], dir);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export interface CommitRangeValidation {
  ok: boolean;
  reason?: "missing-sha" | "no-new-commit" | "baseline-not-ancestor" | "commit-not-integrated" | "empty-diff" | "git-error";
}

/** Validate that a task produced a real commit range and it is integrated. */
export function validateIntegratedCommitRange(
  dir: string,
  baseline: string,
  commit: string,
): CommitRangeValidation {
  const base = baseline.trim();
  const sha = commit.trim();
  if (!base || !sha) return { ok: false, reason: "missing-sha" };
  if (base === sha) return { ok: false, reason: "no-new-commit" };
  if (sh("git", ["merge-base", "--is-ancestor", base, sha], dir).code !== 0) {
    return { ok: false, reason: "baseline-not-ancestor" };
  }
  if (!isCommitIntegrated(dir, sha)) return { ok: false, reason: "commit-not-integrated" };
  const diff = sh("git", ["diff", "--quiet", base, sha], dir).code;
  if (diff === 0) return { ok: false, reason: "empty-diff" };
  if (diff !== 1) return { ok: false, reason: "git-error" };
  return { ok: true };
}

/** True only when `commit` is already reachable from the target repo's HEAD. */
export function isCommitIntegrated(dir: string, commit: string): boolean {
  const sha = commit.trim();
  if (!sha) return false;
  return sh("git", ["merge-base", "--is-ancestor", sha, "HEAD"], dir).code === 0;
}

// ---------------------------------------------------------------------------
// dev subagent invocation
// ---------------------------------------------------------------------------

/** Resolve the pi binary path (the upstream pi-agent CLI). */
export function resolvePiBin(): string {
  const r = sh("which", ["pi"], process.cwd());
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  return "pi";
}

/** Resolve the mandatory verification command for a workflow. */
export function getVerifyCommand(cfg: WorkflowConfig, s: WorkflowState): string {
  return (s.verifyCommand ?? cfg.build.verifyCommand ?? "").trim();
}

/** Run the configured/per-requirement verify command in the repo.
 *  An empty command is always a hard configuration error. */
export function runVerify(cfg: WorkflowConfig, s: WorkflowState): { ok: boolean; output: string; command: string; code: number } {
  const cmd = getVerifyCommand(cfg, s);
  if (!cmd) {
    return {
      ok: false,
      command: "",
      code: -1,
      output: "未配置验证命令。请先执行 /wf verify <cmd>;空验证命令禁止进入或完成 build。",
    };
  }
  const r = sh("bash", ["-lc", cmd], s.repo);
  return { ok: r.code === 0, command: cmd, code: r.code, output: (r.stdout + r.stderr).slice(-4000) };
}

// ---------------------------------------------------------------------------
// git helpers (worktree, commit)
// ---------------------------------------------------------------------------

/** Commit the .workflow/<reqId>/ artifacts (PRD, subtasks, results, review) in one commit. */
export function commitArtifacts(s: WorkflowState): { committed: boolean; sha?: string } {
  const rel = path.join(".workflow", s.reqId);
  const status = sh("git", ["status", "--porcelain", "--", rel], s.repo).stdout.trim();
  if (!status) return { committed: false };
  sh("git", ["add", "-A", "--", rel], s.repo);
  const c = sh("git", ["commit", "-m", `workflow: ${s.reqId} 计划/构建工件`], s.repo);
  if (c.code !== 0) return { committed: false };
  return { committed: true, sha: gitHead(s.repo) };
}

// ---------------------------------------------------------------------------
// Cost / cache telemetry (P1: restore observability)
//
// The v1 pipeline aggregated `reasonix -metrics` JSON files; reasonix is gone
// and that aggregation was removed, which left the project with no way to see
// what a run cost — even though DeepSeek prefix-cache savings are one of its
// headline claims. These helpers re-establish it from pi's own per-message
// usage data (accumulated via a `message_end` hook in workflow.ts) and persist
// it to `.workflow/<reqId>/results/summary.json`.
// ---------------------------------------------------------------------------

/** Per-model token/cost rollup. All fields are cumulative for one requirement. */
export interface UsageTotals {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Provider-reported cost when available (often 0 for self-registered providers). */
  cost: number;
}

export interface RunSummary {
  reqId: string;
  epicId?: string;
  updatedAt: string;
  /** Rollup across every model used in this requirement. */
  totals: UsageTotals;
  /** Per-model breakdown, keyed by "provider/model". */
  byModel: Record<string, UsageTotals>;
  /** cacheRead / (cacheRead + input), 0..1, or null when no tokens seen yet. */
  cacheHitRate: number | null;
}

export function emptyUsageTotals(): UsageTotals {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** Fold one message's usage into a totals accumulator (mutates and returns it). */
export function addUsage(into: UsageTotals, usage: Record<string, unknown> | undefined): UsageTotals {
  if (!usage) return into;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  into.turns += 1;
  into.input += n(usage.input);
  into.output += n(usage.output);
  into.cacheRead += n(usage.cacheRead);
  into.cacheWrite += n(usage.cacheWrite);
  into.cost += n((usage as any).cost);
  return into;
}

/** cacheRead / (cacheRead + input). Null when there's nothing to divide. */
export function cacheHitRate(t: UsageTotals): number | null {
  const denom = t.cacheRead + t.input;
  return denom > 0 ? t.cacheRead / denom : null;
}

/** Build the serializable summary from an accumulator map. */
export function buildRunSummary(
  s: WorkflowState,
  byModel: Record<string, UsageTotals>,
): RunSummary {
  const totals = emptyUsageTotals();
  for (const t of Object.values(byModel)) {
    totals.turns += t.turns;
    totals.input += t.input;
    totals.output += t.output;
    totals.cacheRead += t.cacheRead;
    totals.cacheWrite += t.cacheWrite;
    totals.cost += t.cost;
  }
  return {
    reqId: s.reqId,
    epicId: s.epicId,
    updatedAt: new Date().toISOString(),
    totals,
    byModel,
    cacheHitRate: cacheHitRate(totals),
  };
}

/** Persist the summary to `.workflow/<reqId>/results/summary.json`. Best effort. */
export function writeRunSummary(s: WorkflowState, summary: RunSummary): void {
  try {
    const dir = reqPath(s, "results");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  } catch (_e) { /* best effort — never break a run over telemetry */ }
}

/** Read back a previously written summary, if any. */
export function readRunSummary(s: WorkflowState): RunSummary | undefined {
  try {
    const p = reqPath(s, "results", "summary.json");
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf8")) as RunSummary;
  } catch (_e) { return undefined; }
}

/** One-line human-readable rollup for /wf status and build-completion notices. */
export function formatUsageLine(summary: RunSummary): string {
  const t = summary.totals;
  const rate = summary.cacheHitRate;
  const parts = [
    `${t.turns} turns`,
    `in ${t.input.toLocaleString()}`,
    `out ${t.output.toLocaleString()}`,
    `cacheRead ${t.cacheRead.toLocaleString()}`,
  ];
  if (rate != null) parts.push(`hit ${(rate * 100).toFixed(1)}%`);
  if (t.cost > 0) parts.push(`cost ${t.cost.toFixed(4)}`);
  return parts.join(" | ");
}
