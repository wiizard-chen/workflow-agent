/**
 * workflow lib — pure, pi-independent logic (types, git/fs helpers, and the
 * build pipeline as a dependency-injected function). Kept separate from the
 * pi extension so it can be unit/integration tested without a live model.
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
  reasonix: { bin: string; model: string; maxSteps: number; timeoutMs: number };
  build: { verifyCommand: string; commitPrefix: string };
}

export type Mode = "idle" | "plan" | "build";
export type SubtaskStatus = "pending" | "done" | "failed" | "skipped" | "no-change";

export interface SubtaskState {
  id: string;
  title: string;
  file: string; // relative to reqDir
  depends_on: string[];
  status: SubtaskStatus;
  commit?: string;
  note?: string;
}

export interface WorkflowState {
  reqId: string;
  name: string;
  repo: string;
  mode: Mode;
  createdAt: string;
  baseline?: string;
  verifyCommand?: string;
  subtasks: SubtaskState[];
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

export function readIndex(s: WorkflowState): SubtaskState[] | undefined {
  const idxPath = reqPath(s, "subtasks", "index.json");
  if (!fs.existsSync(idxPath)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(idxPath, "utf8"));
    const arr = Array.isArray(raw?.subtasks) ? raw.subtasks : [];
    return arr.map((t: any) => ({
      id: String(t.id),
      title: String(t.title ?? t.id),
      file: String(t.file ?? `subtasks/${t.id}.md`),
      depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(String) : [],
      status: "pending" as SubtaskStatus,
    }));
  } catch (_e) { return undefined; }
}

/** Build the argv for a headless reasonix subtask run. */
export function buildReasonixArgs(cfg: WorkflowConfig, s: WorkflowState, t: SubtaskState): string[] {
  const specPath = reqPath(s, t.file);
  const metricsPath = reqPath(s, "results", `${t.id}.metrics.json`);
  const instruction =
    `实现这个子任务。完整规格在文件:${specPath}(先读它)。` +
    `严格按其中的验收标准实现,只做这一个子任务,不要越界实现其他子任务。`;
  return [
    "run",
    "-dir", s.repo,
    "-model", cfg.reasonix.model,
    "-metrics", metricsPath,
    "-max-steps", String(cfg.reasonix.maxSteps),
    instruction,
  ];
}

/** Run the configured/per-requirement verify command in the repo. */
export function runVerify(cfg: WorkflowConfig, s: WorkflowState): { ok: boolean; output: string } {
  const cmd = (s.verifyCommand ?? cfg.build.verifyCommand ?? "").trim();
  if (!cmd) return { ok: true, output: "(无验证命令)" };
  const r = sh("bash", ["-lc", cmd], s.repo);
  return { ok: r.code === 0, output: (r.stdout + r.stderr).slice(-4000) };
}

/** Git status of code files only (excludes the .workflow/ artifacts dir). */
export function codeStatus(repo: string): string {
  return sh("git", ["status", "--porcelain", "--", ".", ":!.workflow"], repo).stdout.trim();
}

/** Commit only the subtask's CODE changes (never the .workflow/ artifacts). */
export function commitSubtask(cfg: WorkflowConfig, s: WorkflowState, t: SubtaskState): { committed: boolean; sha?: string; empty?: boolean } {
  if (!codeStatus(s.repo)) return { committed: false, empty: true };
  sh("git", ["add", "-A", "--", ".", ":!.workflow"], s.repo);
  const msg = `${cfg.build.commitPrefix} ${t.id}: ${t.title}`;
  const c = sh("git", ["commit", "-m", msg], s.repo);
  if (c.code !== 0) return { committed: false };
  return { committed: true, sha: gitHead(s.repo) };
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

/** Best-effort aggregation of reasonix -metrics JSON files (schema-tolerant). */
export function aggregateMetrics(s: WorkflowState): any {
  const resultsDir = reqPath(s, "results");
  const summary: any = { subtasks: [], totals: { cost: 0, cacheHitRates: [] as number[] }, raw: {} };
  for (const t of s.subtasks) {
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
    // reasonix reports token counts, not a rate: derive hit rate from hit/miss tokens.
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

// ---------------------------------------------------------------------------
// Build pipeline (dependency-injected, pi-independent)
// ---------------------------------------------------------------------------

export interface BuildDeps {
  /** Execute the subtask (real: reasonix via pi.exec; test: a fake). */
  execReasonix: (t: SubtaskState) => Promise<{ code: number }>;
  /** Verify gate (defaults to runVerify against the repo). */
  verify?: (s: WorkflowState) => { ok: boolean; output: string };
  notify: Notify;
  save?: (s: WorkflowState) => void;
}

export interface BuildResult {
  ok: number;
  fail: number;
  skip: number;
  noChange: number;
  stopped: boolean;
  summary: any;
}

/**
 * Execute the approved plan serially: dependency gate -> reasonix -> verify ->
 * commit; stop on first failure and skip everything downstream. Produces the
 * cumulative diff and the metrics summary. Real git ops run against s.repo.
 */
export async function runBuildPipeline(s: WorkflowState, cfg: WorkflowConfig, deps: BuildDeps): Promise<BuildResult> {
  const verify = deps.verify ?? ((st: WorkflowState) => runVerify(cfg, st));
  const save = deps.save ?? saveState;
  const done = new Set<string>();
  let stopped = false;

  for (const t of s.subtasks) {
    const blockedBy = t.depends_on.filter((d) => !done.has(d));
    if (stopped || blockedBy.length > 0) {
      t.status = "skipped";
      t.note = stopped ? "上游失败,流水线已停止" : `依赖未完成:${blockedBy.join(",")}`;
      save(s);
      continue;
    }

    deps.notify(`▶ ${t.id} ${t.title} — reasonix 实现中…`, "info");
    const { code } = await deps.execReasonix(t);
    if (code !== 0) {
      t.status = "failed"; t.note = `reasonix 退出码 ${code}`; stopped = true; save(s);
      deps.notify(`✖ ${t.id} 失败(reasonix code ${code})。流水线停止,后续跳过。`, "error");
      continue;
    }

    const v = verify(s);
    if (!v.ok) {
      t.status = "failed"; t.note = `验证失败:\n${v.output}`; stopped = true; save(s);
      deps.notify(`✖ ${t.id} 验证失败。流水线停止。\n${v.output.slice(-1200)}`, "error");
      continue;
    }

    const c = commitSubtask(cfg, s, t);
    if (c.empty) {
      t.status = "no-change"; t.note = "reasonix 未产生改动"; done.add(t.id); save(s);
      deps.notify(`⚠ ${t.id} 无代码改动(视为通过,未提交)。`, "warning");
      continue;
    }
    if (!c.committed) {
      t.status = "failed"; t.note = "git commit 失败"; stopped = true; save(s);
      deps.notify(`✖ ${t.id} git commit 失败。流水线停止。`, "error");
      continue;
    }
    t.status = "done"; t.commit = c.sha; done.add(t.id); save(s);
    deps.notify(`✔ ${t.id} 完成并提交 ${c.sha?.slice(0, 8)}`, "info");
  }

  // cumulative diff + metrics summary
  const diffBase = s.baseline || EMPTY_TREE;
  const diff = sh("git", ["diff", diffBase, "HEAD"], s.repo).stdout;
  try {
    fs.mkdirSync(reqPath(s, "results"), { recursive: true });
    fs.writeFileSync(reqPath(s, "results", "cumulative.diff"), diff);
  } catch (_e) { /* ignore */ }

  const summary = aggregateMetrics(s);
  try { fs.writeFileSync(reqPath(s, "results", "summary.json"), JSON.stringify(summary, null, 2)); } catch (_e) { /* ignore */ }

  return {
    ok: s.subtasks.filter((t) => t.status === "done").length,
    noChange: s.subtasks.filter((t) => t.status === "no-change").length,
    fail: s.subtasks.filter((t) => t.status === "failed").length,
    skip: s.subtasks.filter((t) => t.status === "skipped").length,
    stopped,
    summary,
  };
}
