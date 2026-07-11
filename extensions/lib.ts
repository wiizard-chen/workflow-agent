/**
 * workflow lib — pure, pi-independent helpers (types, git/fs, reasonix/verify,
 * metrics). No scheduling logic lives here anymore — the manager LLM drives
 * execution via tools (see dev-pool.ts + workflow.ts). Kept separate from the
 * pi extension so it can be unit-tested without a live model.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BdExec, IssueStatus } from "./bd.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoleRef { provider: string; model: string; }

export interface WorkflowConfig {
  providers: Record<string, { baseUrl: string; apiKeyEnv: string; api: string; thinkingFormat?: string }>;
  roles: { discuss: RoleRef; prd: RoleRef; split: RoleRef; review: RoleRef };
  reasonix: { bin: string; model: string; maxSteps: number; timeoutMs: number };
  build: { verifyCommand: string; commitPrefix: string };
  /** bd-driven execution & parallel scheduling (v2). */
  execute?: {
    driver?: "bd";          // only "bd" supported in v2; default "bd"
    maxParallel?: number;   // concurrent workers; default 1 (= serial)
    pollIntervalMs?: number; // scheduler poll interval; default 2000
    worktreeDir?: string;   // where worktrees live (relative to repo); default "." (inside repo)
    bdBin?: string;         // bd binary; default "bd"
  };
}

export type Mode = "idle" | "plan" | "build";

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

// ---------------------------------------------------------------------------
// reasonix invocation
// ---------------------------------------------------------------------------

/** Build the argv for a headless reasonix subtask run in `cwd`. */
export function buildReasonixArgs(cfg: WorkflowConfig, s: WorkflowState, specPath: string, cwd: string): string[] {
  const instruction =
    `实现这个子任务。完整规格在文件:${specPath}(先读它)。` +
    `严格按其中的验收标准实现,只做这一个子任务,不要越界实现其他子任务。`;
  return [
    "run",
    "-dir", cwd,
    "-model", cfg.reasonix.model,
    "-max-steps", String(cfg.reasonix.maxSteps),
    instruction,
  ];
}

/** Run the configured/per-requirement verify command in the repo.
 *  P0 #1 fix: if no verify command is configured, this is treated as a
 *  HARD FAIL (not a silent pass) — see KNOWN_ISSUES.md. Callers that
 *  genuinely want "no verify" must pass allowEmptyVerify=true. */
export function runVerify(cfg: WorkflowConfig, s: WorkflowState, allowEmptyVerify = false): { ok: boolean; output: string } {
  const cmd = (s.verifyCommand ?? cfg.build.verifyCommand ?? "").trim();
  if (!cmd) {
    if (allowEmptyVerify) return { ok: true, output: "(无验证命令,已显式允许跳过)" };
    return { ok: false, output: "未配置验证命令。set /wf verify <cmd>,或在配置里设 allowEmptyVerify。这阻止了无验证的提交(P0 安全门)。" };
  }
  const r = sh("bash", ["-lc", cmd], s.repo);
  return { ok: r.code === 0, output: (r.stdout + r.stderr).slice(-4000) };
}

// ---------------------------------------------------------------------------
// git helpers (worktree, commit)
// ---------------------------------------------------------------------------

/** Git status of code files only (excludes the .workflow/ artifacts dir). */
export function codeStatus(repo: string): string {
  return sh("git", ["status", "--porcelain", "--", ".", ":!.workflow"], repo).stdout.trim();
}

/** Commit only the subtask's CODE changes (never the .workflow/ artifacts).
 *  Runs in `cwd` (a worktree) so the commit lands on the worktree's branch. */
export function commitSubtask(cfg: WorkflowConfig, cwd: string, t: { id: string; title: string }): { committed: boolean; sha?: string; empty?: boolean } {
  if (!codeStatus(cwd)) return { committed: false, empty: true };
  sh("git", ["add", "-A", "--", ".", ":!.workflow"], cwd);
  const msg = `${cfg.build.commitPrefix} ${t.id}: ${t.title}`;
  const c = sh("git", ["commit", "-m", msg], cwd);
  if (c.code !== 0) return { committed: false };
  return { committed: true, sha: gitHead(cwd) };
}

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

export interface Worktree {
  path: string;   // absolute path to the worktree
  branch: string; // branch name
  name: string;   // worktree name (for removal)
}

/** Create a worktree via `bd worktree create` (shares the beads db automatically)
 *  OR fall back to plain `git worktree add` if bd isn't initialized. */
export function addWorktree(repo: string, name: string, branch: string, exec?: BdExec): Worktree {
  const bdInitialized = fs.existsSync(path.join(repo, ".beads", "metadata.json"));
  if (bdInitialized && exec) {
    // Prefer bd worktree: it wires up the shared beads db automatically.
    const r = exec(repo, ["worktree", "create", name, "--branch", branch]);
    if (r.code === 0) {
      // bd worktree create puts it at <repo>/<name>
      const wtPath = path.join(repo, name);
      return { path: wtPath, branch, name };
    }
    // fall through to git on failure
  }
  // Plain git fallback (e.g. in tests without bd).
  const wtPath = path.join(repo, name);
  const r = sh("git", ["worktree", "add", "-b", branch, wtPath], repo);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr}`);
  return { path: wtPath, branch, name };
}

/** Remove a worktree (best-effort; tries bd first, then git). */
export function removeWorktree(repo: string, wt: Worktree, exec?: BdExec): void {
  try {
    const bdInitialized = fs.existsSync(path.join(repo, ".beads", "metadata.json"));
    if (bdInitialized && exec) {
      const r = exec(repo, ["worktree", "remove", wt.name]);
      if (r.code === 0) return;
    }
    sh("git", ["worktree", "remove", "--force", wt.path], repo);
    sh("git", ["branch", "-D", wt.branch], repo);
  } catch (_e) { /* best effort */ }
}

/** Merge a worktree's branch back into the current branch of `repo`.
 *  Returns {ok, conflict}. On conflict, the caller decides (abort or resolve). */
export function mergeWorktree(repo: string, branch: string): { ok: boolean; conflict: boolean; output: string } {
  const r = sh("git", ["merge", "--no-ff", branch, "-m", `merge: ${branch}`], repo);
  if (r.code === 0) return { ok: true, conflict: false, output: r.stdout };
  // Detect conflict: merge conflict markers in status, or "CONFLICT" in output.
  const conflict = /CONFLICT|Merge conflict/i.test(r.stdout + r.stderr);
  if (conflict) {
    // Leave the merge in-progress so the caller can inspect; they must abort.
    return { ok: false, conflict: true, output: (r.stdout + r.stderr).slice(-2000) };
  }
  // Non-conflict failure: abort to leave the tree clean.
  sh("git", ["merge", "--abort"], repo);
  return { ok: false, conflict: false, output: (r.stdout + r.stderr).slice(-2000) };
}

// ---------------------------------------------------------------------------
// metrics aggregation (unchanged from v1 — reads reasonix -metrics JSON)
// ---------------------------------------------------------------------------

export interface SubtaskMeta { id: string; status: IssueStatus; commit?: string }

/** Best-effort aggregation of reasonix -metrics JSON files (schema-tolerant). */
export function aggregateMetrics(s: WorkflowState, subtasks: SubtaskMeta[]): any {
  const resultsDir = reqPath(s, "results");
  const summary: any = { subtasks: [], totals: { cost: 0, cacheHitRates: [] as number[] }, raw: {} };
  for (const t of subtasks) {
    const f = path.join(resultsDir, `${t.id}.metrics.json`);
    if (!fs.existsSync(f)) continue;
    let data: any;
    try { data = JSON.parse(fs.readFileSync(f, "utf8")); } catch (_e) { continue; }
    summary.raw[t.id] = data;
    const found = { cost: undefined as number | undefined, cacheHit: undefined as number | undefined,
                    hitTok: undefined as number | undefined, missTok: undefined as number | undefined };
    const walk = (o: any, parentKey = "") => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        const key = k.toLowerCase();
        if (typeof v === "number") {
          if (found.cost === undefined && (key === "cost" || key === "total_cost" || key.endsWith("_cost") || key === "usd")) found.cost = v;
          const cacheCtx = key.includes("cache") || parentKey.includes("cache");
          if (found.cacheHit === undefined && cacheCtx && (key.includes("rate") || key.includes("ratio"))) found.cacheHit = v;
          if (found.hitTok === undefined && key.includes("cache") && key.includes("hit") && key.includes("token")) found.hitTok = v;
          if (found.missTok === undefined && key.includes("cache") && key.includes("miss") && key.includes("token")) found.missTok = v;
        } else if (v && typeof v === "object") walk(v, key);
      }
    };
    walk(data);
    if (found.cacheHit === undefined && found.hitTok !== undefined) {
      const denom = found.hitTok + (found.missTok ?? 0);
      if (denom > 0) found.cacheHit = found.hitTok / denom;
    }
    if (found.cost !== undefined) summary.totals.cost += found.cost;
    if (found.cacheHit !== undefined) summary.totals.cacheHitRates.push(found.cacheHit);
    summary.subtasks.push({ id: t.id, status: t.status, commit: t.commit, cost: found.cost, cacheHit: found.cacheHit });
  }
  const rates = summary.totals.cacheHitRates;
  summary.totals.avgCacheHit = rates.length ? rates.reduce((a: number, b: number) => a + b, 0) / rates.length : null;
  return summary;
}
