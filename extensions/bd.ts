/**
 * bd — a thin wrapper over the beads (`bd`) CLI for scripting use.
 *
 * Design:
 * - Every call funnels through a single `bdExec` injection point, so tests
 *   can mock the whole layer by replacing one function.
 * - Reflects the REAL bd 1.1.0 interface (verified by experiment, see
 *   DECISION_LOG.md "bd 1.1.0 真实接口"). The official llms-full.txt docs
 *   describe `pin`/`hook`/`config.toml` which do NOT exist in 1.1.0; this
 *   module uses the verified commands: `assign`/`update --claim`/`comment`/
 *   `config.yaml`.
 * - `--dolt-auto-commit on` is ALWAYS passed: without it, Dolt writes live
 *   only in an in-memory working set and are invisible to other processes
 *   (including worktrees). This is mandatory for cross-worker visibility.
 * - `bd ready` includes the parent epic; callers MUST filter by
 *   issue_type === "task" to avoid dispatching the epic itself.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types — mirror the verified bd 1.1.0 JSON shapes
// ---------------------------------------------------------------------------

export type IssueType = "bug" | "feature" | "task" | "epic" | "chore";
export type IssueStatus = "open" | "in_progress" | "closed" | "deferred";

export interface BdIssue {
  id: string;
  title: string;
  status: IssueStatus;
  priority: number;
  issue_type: IssueType;
  owner: string | null;
  created_at: string;
  updated_at: string;
  parent?: string;
  description?: string;
  notes?: string;
  design?: string;
  acceptance?: string;
  // ready/list payload extras (counts):
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
  labels?: string[];
}

export interface CreateOpts {
  title: string;
  type?: IssueType;
  parent?: string;
  priority?: number;
  description?: string;
  design?: string;
  acceptance?: string;
  notes?: string;
  labels?: string[];
}

export interface BdExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// The single injection point
// ---------------------------------------------------------------------------

/**
 * Execute a bd command in `repo`. All other functions delegate here.
 * Override this in tests instead of spawning the real binary.
 *
 * `repo` is resolved via `-C <repo>` (like git -C), so the caller's cwd
 * doesn't matter. `--dolt-auto-commit on` is always prepended so writes are
 * durable and visible across processes/worktrees.
 */
export type BdExec = (
  repo: string,
  args: string[],
  opts?: { timeoutMs?: number; captureStderr?: boolean }
) => BdExecResult;

/** Default real implementation. */
export const defaultBdExec: BdExec = (repo, args, opts = {}) => {
  const full = ["--dolt-auto-commit", "on", "-C", repo, ...args];
  const r = spawnSync("bd", full, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 120_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireOk(r: BdExecResult, label: string): void {
  if (r.code !== 0) {
    throw new Error(`bd ${label} failed (code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

function parseJson<T>(r: BdExecResult, label: string): T {
  requireOk(r, label);
  let out = r.stdout.trim();
  if (!out) return [] as unknown as T; // empty results
  // bd sometimes emits warnings (e.g. "warning: beads.role not configured") on
  // stdout before the JSON. Strip leading non-JSON lines so we parse robustly.
  // Find the first '[' or '{' that starts a JSON value.
  let start = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "[" || out[i] === "{") { start = i; break; }
  }
  if (start > 0) out = out.slice(start);
  try {
    return JSON.parse(out) as T;
  } catch (e) {
    throw new Error(`bd ${label} returned non-JSON (parse failed): ${(e as Error).message}\n--- stdout ---\n${out.slice(0, 500)}`);
  }
}

/** Quote a value for safe argv passing (spawn already handles argv arrays
 *  safely; this is a no-op kept for readability of the call sites). */
function arg(name: string, value?: string | number): string[] {
  if (value === undefined || value === null || value === "") return [];
  return [`--${name}`, String(value)];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True if `repo` has a `.beads/` workspace already. */
export function isInitialized(repo: string): boolean {
  return fs.existsSync(path.join(repo, ".beads", "metadata.json"));
}

/**
 * `bd init --quiet` — non-interactive. Idempotent if already initialized.
 *
 * NOTE: unlike other commands, this does NOT use the `-C <repo>` flag, because
 * `-C` requires the target to already be a beads project (chicken-and-egg:
 * init is what CREATES the project). Instead we spawn with `cwd: repo`.
 * This also means init bypasses the injected BdExec — it always runs the real
 * binary. (init is idempotent and only runs once per repo, so testability of
 * init itself is not valuable; tests skip init by creating `.beads/metadata.json`
 * directly or by pre-initializing the repo.)
 */
export function init(repo: string): void {
  if (isInitialized(repo)) return;
  // --quiet skips the wizard AND the metric-consent banner; it does NOT skip
  // editor-hook installation (Claude/Codex hooks are installed regardless).
  const r = spawnSync("bd", ["--dolt-auto-commit", "on", "init", "--quiet"], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  requireOk({ code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" }, "init");
  // Silence the "beads.role not configured" warning that pollutes stdout and
  // breaks JSON parsing. Set the default role after init succeeds.
  try { spawnSync("git", ["config", "beads.role", "maintainer"], { cwd: repo, encoding: "utf8" }); } catch (_e) { /* ignore */ }
}

export interface Created {
  id: string;
}

/** Create an issue. Returns its id. */
export function create(repo: string, opts: CreateOpts, exec: BdExec = defaultBdExec): string {
  const args = ["create", opts.title];
  if (opts.type) args.push("--type", opts.type);
  if (opts.parent) args.push("--parent", opts.parent);
  if (opts.priority !== undefined) args.push("--priority", String(opts.priority));
  if (opts.description) args.push("--description", opts.description);
  if (opts.design) args.push("--design", opts.design);
  if (opts.acceptance) args.push("--acceptance", opts.acceptance);
  if (opts.notes) args.push("--notes", opts.notes);
  if (opts.labels && opts.labels.length) args.push("--labels", opts.labels.join(","));
  args.push("--json");
  const r = exec(repo, args);
  const parsed = parseJson<Created>(r, "create");
  if (!parsed.id) throw new Error(`bd create returned no id: ${JSON.stringify(parsed)}`);
  return parsed.id;
}

/**
 * Add a dependency: `dependent` needs `dependency` (dependency blocks dependent).
 * Argument order matches `bd dep add <dependent> <dependency>`.
 */
export function depAdd(
  repo: string,
  dependent: string,
  dependency: string,
  type: "blocks" | "related" | "discovered-from" = "blocks",
  exec: BdExec = defaultBdExec
): void {
  requireOk(exec(repo, ["dep", "add", dependent, dependency, "--type", type]), "dep add");
}

/** List child issues of a parent (the subtasks of an epic). */
export function children(repo: string, parentId: string, exec: BdExec = defaultBdExec): BdIssue[] {
  return parseJson<BdIssue[]>(exec(repo, ["children", parentId, "--json"]), "children");
}

/**
 * Ready work: open tasks with no active blockers.
 * NOTE: includes the parent epic — filter by issue_type === "task" at the
 * call site unless you want to dispatch the epic too.
 */
export function ready(repo: string, exec: BdExec = defaultBdExec): BdIssue[] {
  return parseJson<BdIssue[]>(exec(repo, ["ready", "--json"]), "ready");
}

/** Ready tasks only (excludes epics and non-task types). */
export function readyTasks(repo: string, exec: BdExec = defaultBdExec): BdIssue[] {
  return ready(repo, exec).filter((i) => i.issue_type === "task");
}

export interface UpdateOpts {
  status?: IssueStatus;
  title?: string;
  priority?: number;
  assignee?: string;
  description?: string;
  addLabel?: string;
  removeLabel?: string;
}

/** Update an issue's fields. */
export function update(repo: string, id: string, opts: UpdateOpts, exec: BdExec = defaultBdExec): void {
  const args = ["update", id];
  if (opts.status) args.push("--status", opts.status);
  if (opts.title !== undefined) args.push("--title", opts.title);
  if (opts.priority !== undefined) args.push("--priority", String(opts.priority));
  if (opts.assignee !== undefined) args.push("--assignee", opts.assignee);
  if (opts.description !== undefined) args.push("--description", opts.description);
  if (opts.addLabel) args.push("--add-label", opts.addLabel);
  if (opts.removeLabel) args.push("--remove-label", opts.removeLabel);
  requireOk(exec(repo, args), "update");
}

/**
 * Atomically claim an issue for an agent: sets status=in_progress AND
 * assignee in one operation. This is the concurrency-safe primitive
 * (recommended by bd's own AGENTS.md template). Returns true if claimed
 * (bd update succeeds), false if someone else got there first.
 */
export function claim(repo: string, id: string, agent: string, exec: BdExec = defaultBdExec): boolean {
  const r = exec(repo, ["update", id, "--claim", "--assignee", agent]);
  return r.code === 0;
}

/** Assign an issue to an agent (shorthand for update --assignee). */
export function assign(repo: string, id: string, agent: string, exec: BdExec = defaultBdExec): void {
  requireOk(exec(repo, ["assign", id, agent]), "assign");
}

/** Close an issue. Optional reason is stored as a comment. */
export function close(repo: string, id: string, reason?: string, exec: BdExec = defaultBdExec): void {
  const args = ["close", id];
  if (reason) args.push("--reason", reason);
  requireOk(exec(repo, args), "close");
}

/** Reopen an issue (e.g. put a failed subtask back into the ready queue). */
export function reopen(repo: string, id: string, exec: BdExec = defaultBdExec): void {
  requireOk(exec(repo, ["reopen", id]), "reopen");
}

/** Add a comment (e.g. failure notes for a reopened subtask). */
export function comment(repo: string, id: string, text: string, exec: BdExec = defaultBdExec): void {
  requireOk(exec(repo, ["comment", id, text]), "comment");
}

/** Get the latest (most recent) comment body for an issue, or "" if none.
 *  Used by /wf status to show per-task progress. */
export function latestComment(repo: string, id: string, exec: BdExec = defaultBdExec): string {
  try {
    const r = exec(repo, ["comments", id, "--json"]);
    const parsed = parseJson<any[]>(r, "comments");
    if (!Array.isArray(parsed) || parsed.length === 0) return "";
    // Comments are returned oldest-first; take the last one. Body field varies
    // by bd version — try common names.
    const last = parsed[parsed.length - 1];
    return String(last.body ?? last.text ?? last.comment ?? last.content ?? "").trim();
  } catch (_e) { return ""; }
}

/** Show one issue's full detail.
 *  NOTE: `bd show --json` returns an ARRAY (one element per id); we take [0]. */
export function show(repo: string, id: string, exec: BdExec = defaultBdExec): BdIssue {
  const r = exec(repo, ["show", id, "--json"]);
  const parsed = parseJson<any>(r, "show");
  if (parsed && parsed.error) throw new Error(`bd show ${id}: ${parsed.error}`);
  // bd show returns an array; unwrap the single element.
  const issue = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!issue) throw new Error(`bd show ${id}: no issue returned`);
  return issue as BdIssue;
}

/** List issues, optionally filtered by parent / status / type. */
export interface ListOpts {
  parent?: string;
  status?: IssueStatus;
  type?: IssueType;
  /** Include closed issues; bd list defaults to open-only. */
  all?: boolean;
  /** Result limit; 0 means unlimited in bd. */
  limit?: number;
}
export function list(repo: string, opts: ListOpts = {}, exec: BdExec = defaultBdExec): BdIssue[] {
  const args = ["list", "--json"];
  if (opts.all) args.push("--all");
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
  if (opts.parent) args.push("--parent", opts.parent);
  if (opts.status) args.push("--status", opts.status);
  if (opts.type) args.push("--type", opts.type);
  return parseJson<BdIssue[]>(exec(repo, args), "list");
}

/** Show blocked issues and what blocks each. */
export interface BlockedEntry {
  id: string;
  title: string;
  blockers: string[];
}
export function blocked(repo: string, exec: BdExec = defaultBdExec): BlockedEntry[] {
  const raw = parseJson<any[]>(exec(repo, ["blocked", "--json"]), "blocked");
  // bd blocked JSON shape is not stable; normalize defensively.
  return (raw || []).map((e) => ({
    id: String(e.id ?? e.issue_id ?? ""),
    title: String(e.title ?? ""),
    blockers: Array.isArray(e.blockers) ? e.blockers.map(String) : Array.isArray(e.blocked_by) ? e.blocked_by.map(String) : [],
  }));
}
