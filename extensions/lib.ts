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

export interface RoleRef { provider: string; model: string; }

export interface WorkflowConfig {
  providers: Record<string, { baseUrl: string; apiKeyEnv: string; api: string; thinkingFormat?: string }>;
  roles: { discuss: RoleRef; prd: RoleRef; split: RoleRef; review: RoleRef };
  build: { verifyCommand: string; commitPrefix: string };
  /** Execution layer config (omp-native). dev/reviewer models live in .omp/agents/*.md frontmatter, not here. */
  execute?: {
    driver?: "bd";          // only "bd" supported; default "bd"
    maxParallel?: number;   // suggested parallel task(dev) calls for the manager prompt; default 1
    pollIntervalMs?: number; // unused in omp-native path; kept for compat
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

// ---------------------------------------------------------------------------
// dev subagent invocation
// ---------------------------------------------------------------------------

/** Resolve the pi binary path (the upstream pi-agent CLI). */
export function resolvePiBin(): string {
  const r = sh("which", ["pi"], process.cwd());
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  return "pi";
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
