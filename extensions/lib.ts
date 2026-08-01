/**
 * workflow lib — pure, omp-independent helpers (types, git/fs, verify).
 * The manager LLM drives execution via omp's native task tool + the bd_task
 * extension tool (see workflow.ts). Kept separate from the omp extension so
 * it can be unit-tested without a live model.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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
    /** Automatic dev repairs after reviewer failures, before asking the user. */
    maxReviewerAutoFixes?: number;
    /** Stop if the exact same normalized issue set repeats this many consecutive reviews. */
    sameIssueStopAfter?: number;
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
    // Keep mutable runtime state local even when the host repository has no
    // `.workflow` rule. Authoritative artifacts are force-added explicitly.
    if (!ensureWorkflowArtifactsIgnored(s).ok) return;
    fs.mkdirSync(reqDir(s), { recursive: true });
    fs.writeFileSync(reqPath(s, "state.json"), JSON.stringify(s, null, 2));
  } catch (_e) { /* best effort */ }
}

export function sh(cmd: string, args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function shWithEnv(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

export interface ArtifactCommitResult {
  ok: boolean;
  committed: boolean;
  sha?: string;
  error?: string;
}

export interface ArtifactDriftResult {
  ok: boolean;
  paths: string[];
  error?: string;
}

export interface ArtifactRestoreResult extends ArtifactDriftResult {
  restored: boolean;
  repairCommitSha?: string;
}

function workflowArtifactRelPath(s: WorkflowState, ...parts: string[]): string {
  return path.join(".workflow", s.reqId, ...parts);
}

/** Install repository-local ignore rules without changing the host's tracked
 *  `.gitignore`. Only mutable locations are ignored: canonical `prd.md` and
 *  `subtasks/` remain visible to normal Git status, while authoritative files
 *  under results are force-added explicitly by the narrow commit helpers. */
export function ensureWorkflowArtifactsIgnored(s: WorkflowState): { ok: boolean; error?: string } {
  const resolved = sh("git", ["rev-parse", "--git-path", "info/exclude"], s.repo);
  if (resolved.code !== 0) return { ok: false, error: resolved.stderr || resolved.stdout || "无法定位 .git/info/exclude" };
  const rawPath = resolved.stdout.trim();
  if (!rawPath) return { ok: false, error: "git rev-parse 返回空的 info/exclude 路径" };
  const excludePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(s.repo, rawPath);
  const begin = "# BEGIN pi-workflow generated runtime artifacts";
  const end = "# END pi-workflow generated runtime artifacts";
  const legacyMarker = "# pi-workflow generated artifacts; immutable files are force-added";
  const managedRules = [
    begin,
    "/.workflow/_repo-brief.md",
    "/.workflow/*/state.json",
    "/.workflow/*/results/",
    end,
  ];
  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    const lines = existing.split(/\r?\n/);
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === begin) {
        const close = lines.findIndex((candidate, index) => index > i && candidate.trim() === end);
        if (close >= 0) i = close;
        // If the block is malformed and has no end marker, remove only the
        // marker rather than swallowing unrelated user exclude rules.
        continue;
      }
      // Migrate the broad rule emitted by the short-lived previous version.
      if (line.trim() === legacyMarker) {
        if (lines[i + 1]?.trim() === "/.workflow/") i++;
        continue;
      }
      kept.push(line);
    }
    while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
    const next = [...kept, ...(kept.length > 0 ? [""] : []), ...managedRules, ""].join("\n");
    if (next !== existing) fs.writeFileSync(excludePath, next);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `无法写入 ${excludePath}:${(e as Error).message}` };
  }
}

function normalizeWorkflowArtifactPaths(s: WorkflowState, files: string[]): string[] {
  const root = path.normalize(workflowArtifactRelPath(s));
  const normalized = files.map((file) => path.normalize(path.isAbsolute(file) ? path.relative(s.repo, file) : file));
  for (const file of normalized) {
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
      throw new Error(`workflow 工件路径越界:${file}`);
    }
  }
  return [...new Set(normalized)].sort();
}

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(file));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

/** Immutable PLAN artifacts. The audit is included when present; external PRDs
 *  have no prd-writer audit but the imported PRD is still persisted. */
export function prdArtifactPaths(s: WorkflowState): string[] {
  const paths = [workflowArtifactRelPath(s, "prd.md")];
  const audit = workflowArtifactRelPath(s, "results", "prd-generation.json");
  if (fs.existsSync(path.join(s.repo, audit))) paths.push(audit);
  return paths.filter((file) => fs.existsSync(path.join(s.repo, file)));
}

/** Immutable task-graph inputs. Runtime task results deliberately stay out. */
export function splitArtifactPaths(s: WorkflowState): string[] {
  const specsDir = reqPath(s, "subtasks");
  const specs = listFilesRecursive(specsDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => path.relative(s.repo, file));
  const manifest = workflowArtifactRelPath(s, "results", "split.json");
  if (fs.existsSync(path.join(s.repo, manifest))) specs.push(manifest);
  return normalizeWorkflowArtifactPaths(s, specs);
}

/** Every BUILD input that a dev must treat as immutable. */
export function authoritativeArtifactPaths(s: WorkflowState): string[] {
  return normalizeWorkflowArtifactPaths(s, [...prdArtifactPaths(s), ...splitArtifactPaths(s)]);
}

/** Final evidence worth keeping in Git. Mutable state/summary/per-task scratch
 *  remain ignored so /wf done and telemetry do not leave the repo dirty. */
export function finalEvidenceArtifactPaths(s: WorkflowState): string[] {
  const names = ["verify.json", "cumulative.diff", "final-review.json", "final-review.audit.json"];
  return names
    .map((name) => workflowArtifactRelPath(s, "results", name))
    .filter((file) => fs.existsSync(path.join(s.repo, file)));
}

function isPolicyTrackedArtifact(s: WorkflowState, file: string): boolean {
  const normalized = path.normalize(file);
  const root = path.normalize(workflowArtifactRelPath(s));
  if (normalized === path.join(root, "prd.md")) return true;
  if (normalized.startsWith(`${path.join(root, "subtasks")}${path.sep}`) && normalized.endsWith(".md")) return true;
  const keptResults = new Set([
    "prd-generation.json", "split.json", "verify.json", "cumulative.diff",
    "final-review.json", "final-review.audit.json",
  ].map((name) => path.join(root, "results", name)));
  return keptResults.has(normalized);
}

/** Dynamic-vs-authoritative is workflow policy, not host-ignore policy. An old
 *  repository may track summary/state even without a `.workflow` ignore rule;
 *  those files must still be migrated out of Git to avoid a telemetry loop. */
function trackedDynamicArtifactPaths(s: WorkflowState): string[] {
  const tracked = sh("git", ["ls-files", "-z", "--", workflowArtifactRelPath(s)], s.repo);
  if (tracked.code !== 0) return [];
  return tracked.stdout.split("\0").filter(Boolean)
    .filter((file) => !isPolicyTrackedArtifact(s, file));
}

function pathExistsOrTracked(repo: string, file: string): boolean {
  if (fs.existsSync(path.join(repo, file))) return true;
  return sh("git", ["ls-files", "--error-unmatch", "--", file], repo).code === 0;
}

/** Force-add and commit only explicitly selected workflow files. This works
 *  even when the host repository ignores `.workflow/*`; an alternate index
 *  prevents unrelated staged user changes from entering the artifact commit.
 *  Legacy dynamic artifacts tracked by the old whole-directory commit are
 *  removed from the index (not the worktree) in the same migration commit. */
export function commitArtifactPaths(
  s: WorkflowState,
  files: string[],
  message: string,
): ArtifactCommitResult {
  let paths: string[];
  try { paths = normalizeWorkflowArtifactPaths(s, files); }
  catch (e) { return { ok: false, committed: false, error: (e as Error).message }; }
  const ignored = ensureWorkflowArtifactsIgnored(s);
  if (!ignored.ok) return { ok: false, committed: false, error: ignored.error };
  if (paths.length === 0 && trackedDynamicArtifactPaths(s).length === 0) {
    return { ok: true, committed: false, sha: gitHead(s.repo) };
  }

  const legacyDynamic = trackedDynamicArtifactPaths(s);
  const selected = paths.filter((file) => pathExistsOrTracked(s.repo, file));
  const commitPaths = [...new Set([...selected, ...legacyDynamic])].sort();
  if (commitPaths.length === 0) return { ok: true, committed: false, sha: gitHead(s.repo) };

  // Use an alternate index seeded from HEAD. This creates a commit containing
  // only the selected workflow changes while the user's real index (including
  // unrelated staged work) remains untouched. After the commit, reset only our
  // paths in the real index to the new HEAD so its unrelated staged entries are
  // preserved exactly.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-index-"));
  const tempIndex = path.join(tempDir, "index");
  const env = { GIT_INDEX_FILE: tempIndex };
  try {
    const readTree = shWithEnv("git", ["read-tree", "HEAD"], s.repo, env);
    if (readTree.code !== 0) return { ok: false, committed: false, error: readTree.stderr || readTree.stdout || "git read-tree failed" };
    if (selected.length > 0) {
      const add = shWithEnv("git", ["add", "-f", "-A", "--", ...selected], s.repo, env);
      if (add.code !== 0) return { ok: false, committed: false, error: add.stderr || add.stdout || "git add failed" };
    }
    if (legacyDynamic.length > 0) {
      const untrack = shWithEnv("git", ["rm", "-r", "--cached", "--ignore-unmatch", "--", ...legacyDynamic], s.repo, env);
      if (untrack.code !== 0) return { ok: false, committed: false, error: untrack.stderr || untrack.stdout || "git rm --cached failed" };
    }
    const staged = shWithEnv("git", ["diff", "--cached", "--quiet", "--", ...commitPaths], s.repo, env);
    if (staged.code === 0) return { ok: true, committed: false, sha: gitHead(s.repo) };
    if (staged.code !== 1) return { ok: false, committed: false, error: staged.stderr || staged.stdout || "git diff --cached failed" };
    const commit = shWithEnv("git", ["commit", "-m", message], s.repo, env);
    if (commit.code !== 0) return { ok: false, committed: false, error: commit.stderr || commit.stdout || "git commit failed" };
    const syncRealIndex = sh("git", ["reset", "-q", "HEAD", "--", ...commitPaths], s.repo);
    if (syncRealIndex.code !== 0) {
      return { ok: false, committed: true, sha: gitHead(s.repo), error: syncRealIndex.stderr || syncRealIndex.stdout || "artifact commit succeeded but real index sync failed" };
    }
    return { ok: true, committed: true, sha: gitHead(s.repo) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function commitPrdArtifacts(s: WorkflowState): ArtifactCommitResult {
  if (!fs.existsSync(reqPath(s, "prd.md"))) return { ok: false, committed: false, error: "canonical PRD 不存在" };
  return commitArtifactPaths(s, prdArtifactPaths(s), `workflow: ${s.reqId} PRD 审计`);
}

export function commitSplitArtifacts(s: WorkflowState): ArtifactCommitResult {
  return commitArtifactPaths(s, splitArtifactPaths(s), `workflow: ${s.reqId} task 规格`);
}

export function commitAuthoritativeArtifacts(s: WorkflowState): ArtifactCommitResult {
  return commitArtifactPaths(s, authoritativeArtifactPaths(s), `workflow: ${s.reqId} 权威输入`);
}

/** Finalization commits only frozen inputs + final evidence. Per-task results,
 *  state.json and summary.json remain ignored and cannot create later noise. */
export function commitArtifacts(s: WorkflowState): ArtifactCommitResult {
  return commitArtifactPaths(
    s,
    [...authoritativeArtifactPaths(s), ...finalEvidenceArtifactPaths(s)],
    `workflow: ${s.reqId} 最终工件`,
  );
}

function protectedArtifactRoots(s: WorkflowState): string[] {
  return [
    workflowArtifactRelPath(s, "prd.md"),
    workflowArtifactRelPath(s, "results", "prd-generation.json"),
    workflowArtifactRelPath(s, "results", "split.json"),
    workflowArtifactRelPath(s, "subtasks"),
  ];
}

interface GitArtifactEntry { path: string; mode: string; oid: string; }
interface GitArtifactEntriesResult { ok: boolean; entries: GitArtifactEntry[]; error?: string; }

function artifactEntriesAtRevision(s: WorkflowState, revision: string): GitArtifactEntriesResult {
  const tree = sh("git", ["ls-tree", "-r", "-z", revision, "--", ...protectedArtifactRoots(s)], s.repo);
  if (tree.code !== 0) return { ok: false, entries: [], error: tree.stderr || tree.stdout || `无法读取 revision ${revision}` };
  const entries: GitArtifactEntry[] = [];
  for (const line of tree.stdout.split("\0").filter(Boolean)) {
    const match = line.match(/^(\d+)\s+\w+\s+([0-9a-f]+)\t(.*)$/);
    if (!match) return { ok: false, entries: [], error: `无法解析 git ls-tree:${line}` };
    entries.push({ mode: match[1], oid: match[2], path: path.normalize(match[3]) });
  }
  return { ok: true, entries };
}

function artifactIndexEntries(s: WorkflowState): GitArtifactEntriesResult {
  const index = sh("git", ["ls-files", "--stage", "-z", "--", ...protectedArtifactRoots(s)], s.repo);
  if (index.code !== 0) return { ok: false, entries: [], error: index.stderr || index.stdout || "无法读取 Git index" };
  const entries: GitArtifactEntry[] = [];
  for (const line of index.stdout.split("\0").filter(Boolean)) {
    const match = line.match(/^(\d+)\s+([0-9a-f]+)\s+(\d+)\t(.*)$/);
    if (!match) return { ok: false, entries: [], error: `无法解析 git ls-files --stage:${line}` };
    if (match[3] !== "0") return { ok: false, entries: [], error: `权威工件存在未解决 index stage:${line}` };
    entries.push({ mode: match[1], oid: match[2], path: path.normalize(match[4]) });
  }
  return { ok: true, entries };
}

function artifactPathsAtRevision(s: WorkflowState, revision: string): ArtifactDriftResult {
  const result = artifactEntriesAtRevision(s, revision);
  return result.ok
    ? { ok: true, paths: result.entries.map((entry) => entry.path).sort() }
    : { ok: false, paths: [], error: result.error };
}

function actualArtifactMatches(s: WorkflowState, entry: GitArtifactEntry): boolean {
  const absolute = path.join(s.repo, entry.path);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(absolute); } catch { return false; }
  if (!stat.isFile() || !entry.mode.startsWith("100")) return false;
  const expectedExecutable = entry.mode === "100755";
  const actualExecutable = (stat.mode & 0o111) !== 0;
  if (expectedExecutable !== actualExecutable) return false;
  const hashed = sh("git", ["hash-object", "--no-filters", "--", entry.path], s.repo);
  return hashed.code === 0 && hashed.stdout.trim() === entry.oid;
}

/** Compare baseline blobs against HEAD, the real index, and actual filesystem
 *  bytes. This intentionally does not trust `git diff`: a dev with bash can set
 *  assume-unchanged/skip-worktree bits, but raw blob hashing still detects the
 *  mutation. Path-set comparison also catches ignored untracked specs. */
export function authoritativeArtifactDrift(s: WorkflowState, baseline: string): ArtifactDriftResult {
  const baselineResult = artifactEntriesAtRevision(s, baseline);
  if (!baselineResult.ok) return { ok: false, paths: [], error: baselineResult.error };
  const headResult = artifactEntriesAtRevision(s, "HEAD");
  if (!headResult.ok) return { ok: false, paths: [], error: headResult.error };
  const indexResult = artifactIndexEntries(s);
  if (!indexResult.ok) return { ok: false, paths: [], error: indexResult.error };

  const baselineEntries = new Map(baselineResult.entries.map((entry) => [entry.path, entry]));
  const headEntries = new Map(headResult.entries.map((entry) => [entry.path, entry]));
  const indexEntries = new Map(indexResult.entries.map((entry) => [entry.path, entry]));
  const currentPaths = new Set(authoritativeArtifactPaths(s));
  const allPaths = new Set([...baselineEntries.keys(), ...headEntries.keys(), ...indexEntries.keys(), ...currentPaths]);
  const drift: string[] = [];
  for (const file of allPaths) {
    const baselineEntry = baselineEntries.get(file);
    const headEntry = headEntries.get(file);
    const indexEntry = indexEntries.get(file);
    const sameEntry = (candidate: GitArtifactEntry | undefined) => !!baselineEntry && !!candidate
      && candidate.mode === baselineEntry.mode && candidate.oid === baselineEntry.oid;
    if (!baselineEntry || !sameEntry(headEntry) || !sameEntry(indexEntry) || !currentPaths.has(file) || !actualArtifactMatches(s, baselineEntry)) {
      drift.push(file);
    }
  }
  return { ok: true, paths: drift.sort() };
}

/** Restore frozen BUILD inputs from the task's claim baseline. If a dev put the
 *  mutation in its code commit, create a narrow repair commit; if it was only a
 *  working-tree edit, restoration leaves no extra commit. The caller must still
 *  mark the dev audit failed so the task cannot close on a violating run. */
export function restoreAuthoritativeArtifacts(s: WorkflowState, baseline: string): ArtifactRestoreResult {
  const drift = authoritativeArtifactDrift(s, baseline);
  if (!drift.ok || drift.paths.length === 0) return { ...drift, restored: drift.ok };
  const atBaseline = artifactPathsAtRevision(s, baseline);
  if (!atBaseline.ok) return { ...atBaseline, restored: false };
  const baselineSet = new Set(atBaseline.paths);
  const headEntries = artifactEntriesAtRevision(s, "HEAD");
  const indexEntries = artifactIndexEntries(s);
  if (!headEntries.ok || !indexEntries.ok) {
    return { ok: false, paths: drift.paths, restored: false, error: headEntries.error || indexEntries.error || "无法读取当前 Git 工件状态" };
  }
  const trackedPaths = [...new Set([...headEntries.entries.map((entry) => entry.path), ...indexEntries.entries.map((entry) => entry.path)])];
  if (trackedPaths.length > 0) {
    const clearFlags = sh("git", ["update-index", "--no-assume-unchanged", "--no-skip-worktree", "--", ...trackedPaths], s.repo);
    if (clearFlags.code !== 0) return { ok: false, paths: drift.paths, restored: false, error: clearFlags.stderr || clearFlags.stdout || "无法清理 index 隐藏标记" };
  }
  const currentPaths = [...new Set([...authoritativeArtifactPaths(s), ...trackedPaths])];

  for (const file of currentPaths) {
    if (!baselineSet.has(file)) fs.rmSync(path.join(s.repo, file), { force: true });
  }
  if (atBaseline.paths.length > 0) {
    const restored = sh("git", ["restore", `--source=${baseline}`, "--staged", "--worktree", "--", ...atBaseline.paths], s.repo);
    if (restored.code !== 0) return { ok: false, paths: drift.paths, restored: false, error: restored.stderr || restored.stdout || "git restore failed" };
  }

  const repair = commitArtifactPaths(s, drift.paths, `workflow: ${s.reqId} 恢复被 dev 修改的权威输入`);
  if (!repair.ok) return { ok: false, paths: drift.paths, restored: false, error: repair.error };
  const remaining = authoritativeArtifactDrift(s, baseline);
  if (!remaining.ok || remaining.paths.length > 0) {
    return { ok: false, paths: remaining.paths, restored: false, repairCommitSha: repair.sha, error: remaining.error || "恢复后权威输入仍与 baseline 不一致" };
  }
  return { ok: true, paths: drift.paths, restored: true, repairCommitSha: repair.committed ? repair.sha : undefined };
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

/** Persist the summary to `.workflow/<reqId>/results/summary.json`. Best effort.
 *  A legacy tracked summary is deliberately not rewritten: the next artifact
 *  migration commit will untrack it, after which telemetry resumes locally. */
export function writeRunSummary(s: WorkflowState, summary: RunSummary): void {
  try {
    if (!ensureWorkflowArtifactsIgnored(s).ok) return;
    const relative = workflowArtifactRelPath(s, "results", "summary.json");
    if (sh("git", ["ls-files", "--error-unmatch", "--", relative], s.repo).code === 0) return;
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
