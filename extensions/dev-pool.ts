/**
 * dev-pool — manages per-developer omp subagent worktrees.
 *
 * Architecture (see DECISION_LOG.md):
 * - A "dev" is an omp native subagent run in ONE fixed worktree via `task`.
 * - Each task spawns a fresh omp `--print` subprocess in the dev's worktree:
 *   the dev reads the spec, implements, and self-verifies (write→verify→fix
 *   loop inside the dev task).
 * - Context reuse across tasks no longer relies on a resumed session
 *   (--continue, former reasonix mechanism). Instead, cache.ts freezes the
 *   system-prompt date so the prefix is byte-stable and DeepSeek's server-side
 *   prefix cache stays hot across tasks. bd comments carry cross-task state.
 *
 * The pool is module-level state, keyed by devId (1/2/3...). It is NOT exposed
 * to the manager LLM — the manager only passes a devId number; the tool layer
 * (assign_dev) resolves it here.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addWorktree,
  commitSubtask,
  gitHead,
  mergeWorktree,
  removeWorktree,
  resolveOmpBin,
  runVerify,
  sh,
  type Worktree,
  type WorkflowConfig,
  type WorkflowState,
} from "./lib.ts";
import type { BdExec } from "./bd.ts";
import * as bd from "./bd.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Dev {
  id: number;                  // 1/2/3... — the devId the manager passes
  worktree: Worktree;          // FIXED for the dev's lifetime (path never changes)
  issueCount: number;          // how many issues this dev has processed (for metrics/logs)
  commits: string[];           // sha of each merged commit (for metrics)
}

export interface DevTaskResult {
  ok: boolean;
  exitCode: number;
  noChange: boolean;
  commit?: string;
  merged: boolean;
  output: string;              // tail of dev-subagent/verify output for the manager
}

/** bd operations injectable for testing (defaults to the real bd module). */
export interface BdOps {
  show(repo: string, id: string): any;
  claim(repo: string, id: string, agent: string): boolean;
  close(repo: string, id: string, reason?: string): void;
  reopen(repo: string, id: string): void;
  comment(repo: string, id: string, text: string): void;
}

/** Default BdOps backed by the real bd CLI. */
export const realBdOps: BdOps = {
  show: (r, id) => bd.show(r, id),
  claim: (r, id, a) => bd.claim(r, id, a),
  close: (r, id, reason) => bd.close(r, id, reason),
  reopen: (r, id) => bd.reopen(r, id),
  comment: (r, id, t) => bd.comment(r, id, t),
};

// ---------------------------------------------------------------------------
// DevPool
// ---------------------------------------------------------------------------

export class DevPool {
  private devs = new Map<number, Dev>();
  private state: WorkflowState;
  private cfg: WorkflowConfig;
  private bdExec?: BdExec;
  private bdOps: BdOps;
  /** Path to the workflow extension .ts file — passed to `omp -e` so the dev
   *  subprocess loads it and registers the deepseek/gbgjxj provider. Without
   *  this, omp can't resolve the dev model. Set by workflow.ts when creating
   *  the pool; falls back to deriving from this module's URL. */
  devExtPath?: string;
  /** Merge serial lock: ensures only one dev branch merges into main at a time
   *  (avoids conflicts when multiple devs finish concurrently and touch shared
   *  files like extensions/workflow.ts). Dev subagent execution itself runs in
   *  parallel (each in its own isolated worktree); only the merge step serializes. */
  private mergeChain: Promise<unknown> = Promise.resolve();

  constructor(state: WorkflowState, cfg: WorkflowConfig, bdExec?: BdExec, bdOps?: BdOps) {
    this.state = state;
    this.cfg = cfg;
    this.bdExec = bdExec;
    this.bdOps = bdOps ?? realBdOps;
  }

  /** Serialize an async operation (used to make merges mutually exclusive). */
  private async serialMerge<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the tail of the previous merge; each merge waits for the prior to settle.
    let resolve!: (v: T | PromiseLike<T>) => void;
    const slot = new Promise<T>((r) => { resolve = r; });
    const prev = this.mergeChain;
    this.mergeChain = slot;
    await prev;          // wait for the previous merge to finish
    try {
      resolve(await fn());
    } catch (e) {
      resolve(e as T);   // propagate by settling; caller sees the rejection via fn's own promise
      throw e;
    }
    return slot;
  }

  /**
   * Get an existing dev, or create one with a fresh worktree on first use.
   * Worktree path is deterministic: <repo>/wt-dev<id> — STABLE ACROSS REQUIREMENTS
   * so the dev subagent always runs in the same worktree. Worktrees are
   * persistent: created once, reused for every requirement, reset to main on cleanup.
   */
  getOrCreate(devId: number): Dev {
    let dev = this.devs.get(devId);
    if (dev) return dev;
    const name = `wt-dev${devId}`;
    const branch = `dev${devId}`;
    // If the worktree already exists (persistent across requirements), reuse it
    // without re-creating. Only create on first-ever use.
    const wtPath = path.join(this.state.repo, name);
    let wt: Worktree;
    if (fs.existsSync(wtPath) && fs.existsSync(path.join(wtPath, ".git"))) {
      wt = { path: wtPath, branch, name };
    } else {
      wt = addWorktree(this.state.repo, name, branch, this.bdExec);
    }
    dev = { id: devId, worktree: wt, issueCount: 0, commits: [] };
    this.devs.set(devId, dev);
    return dev;
  }

  /**
   * Load the dev agent role prompt from .omp/agents/dev.md (strips YAML
   * frontmatter). The full dev.md is the source of truth for the dev's
   * single-responsibility boundary, skill whitelist, and bd interface notes.
   * Cached after first load (the file doesn't change during a run).
   */
  private static devRoleCache: string | null = null;
  private loadDevRole(): string {
    if (DevPool.devRoleCache !== null) return DevPool.devRoleCache;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, "..", ".omp", "agents", "dev.md"),
      path.join(here, ".omp", "agents", "dev.md"),
      path.join(process.cwd(), ".omp", "agents", "dev.md"),
    ];
    let template = "";
    for (const c of candidates) {
      if (fs.existsSync(c)) { template = fs.readFileSync(c, "utf8"); break; }
    }
    if (!template) {
      // Fallback inline role if dev.md is missing (shouldn't happen in normal use).
      template =
        `你是 pi-workflow 的开发执行者(dev),单一职责:只实现当前分配给你的这一个 task。` +
        `不拆分需求、不测试整体产出、不越界实现其他 task。先读规格,严守验收标准,过验证门。` +
        `阻碍建 bd bug(不要写本地 TODO);进度/失败写 bd comment(单数)。`;
    }
    DevPool.devRoleCache = template.replace(/^---\n[\s\S]*?\n---\n/, "");
    return DevPool.devRoleCache;
  }

  /**
   * Build the instruction for the dev subagent: the dev role (from dev.md) +
   * the task spec path + the verify command (so the dev can self-verify in its
   * internal write→verify→fix loop before yielding).
   */
  private buildDevInstruction(specPath: string, taskId: string): string {
    const role = this.loadDevRole();
    const verifyCmd = (this.state.verifyCommand ?? this.cfg.build.verifyCommand ?? "").trim();
    const verifyLine = verifyCmd
      ? `\n【验证命令】实现后自己跑这个验证命令,不过就改到过:\n  ${verifyCmd}`
      : `\n【验证】未配置验证命令——按规格的验收标准自检。`;
    return [
      role,
      ``,
      `--- 当前任务 ---`,
      `task id: ${taskId}`,
      `完整规格在文件:${specPath}(先 read 它)。`,
      `严格按其中的验收标准实现,只做这一个子任务,不要越界实现其他子任务。`,
      verifyLine,
      `完成后报告:改了哪些文件、验证是否通过。`,
      `------------------`,
    ].join("\n");
  }

  /**
   * Run ONE task on this dev: dev subagent → verify → commit → merge → bd close.
   * Synchronous: resolves only after the dev subagent exits.
   *
   * On failure: bd reopen + comment, returns { ok: false } — the manager
   * decides whether to retry, switch dev, or skip.
   */
  async runTask(
    devId: number,
    taskId: string,
    opts: { allowEmptyVerify?: boolean; onNotify?: (m: string, level?: "info" | "warning" | "error") => void } = {},
  ): Promise<DevTaskResult> {
    const dev = this.getOrCreate(devId);
    const notify = opts.onNotify ?? (() => {});
    const repo = this.state.repo;

    // 0. Verify the worktree exists — if addWorktree failed silently or the
    // path is stale, the dev subagent would write to the wrong cwd and we'd lose the
    // code. Fail loud BEFORE claiming.
    if (!fs.existsSync(dev.worktree.path)) {
      notify(`✖ ${taskId} worktree 不存在:${dev.worktree.path}(可能创建失败)。已跳过,不 claim。`, "error");
      return { ok: false, exitCode: -1, noChange: false, merged: false, output: `worktree 不存在:${dev.worktree.path}` };
    }

    // 1. Resolve the spec path from the issue's notes.
    let specPath = "";
    try {
      const issue = this.bdOps.show(repo, taskId);
      const m = (issue.notes || "").match(/规格文件:(.+)/);
      if (m) specPath = m[1].trim();
    } catch (_e) { /* ignore */ }
    if (!specPath) {
      // Fallback: no spec note — use the issue title as a minimal instruction.
      notify(`⚠ ${taskId} 无规格文件备注,用 title 兜底`, "warning");
    }

    // 2. Claim the issue (concurrency-safe).
    const agent = `dev${devId}-${this.state.reqId}`;
    if (!this.bdOps.claim(repo, taskId, agent)) {
      return { ok: false, exitCode: -1, noChange: false, merged: false, output: `认领失败(已被占用或状态非 open):${taskId}` };
    }

    // 3. Run the dev subagent (omp native, --print non-interactive).
    notify(`▶ dev${devId} 开始 ${taskId}(omp subagent)`, "info");
    const instruction = this.buildDevInstruction(specPath || `(无规格,任务:${taskId})`, taskId);
    const exitCode = await this.spawnDevSubagent(instruction, dev.worktree.path);

    if (exitCode !== 0) {
      this.bdOps.reopen(repo, taskId);
      this.bdOps.comment(repo, taskId, `dev${devId} omp subagent 失败(退出码 ${exitCode})`);
      notify(`✖ ${taskId} dev subagent 失败(code ${exitCode}),已放回 bd`, "error");
      return { ok: false, exitCode, noChange: false, merged: false, output: `dev subagent 退出码 ${exitCode}` };
    }

    // 4. Verify gate.
    const v = runVerify(this.cfg, this.state, opts.allowEmptyVerify);
    if (!v.ok) {
      this.bdOps.reopen(repo, taskId);
      this.bdOps.comment(repo, taskId, `验证失败:\n${v.output}`);
      notify(`✖ ${taskId} 验证失败,已放回 bd`, "error");
      return { ok: false, exitCode: 0, noChange: false, merged: false, output: v.output.slice(-2000) };
    }

    // 5. Commit on the dev's worktree branch.
    let issueTitle = taskId;
    try { issueTitle = this.bdOps.show(repo, taskId).title || taskId; } catch (_e) { /* fallback */ }
    const c = commitSubtask(this.cfg, dev.worktree.path, { id: taskId, title: issueTitle });

    // Track that this dev processed another issue.
    dev.issueCount++;

    if (c.empty) {
      // dev subagent ran (exitCode 0) but no code changes in the worktree. This is
      // suspicious: the dev may have written to the wrong dir. Before treating
      // as pass, check whether the MAIN repo has untracked code (wrong-dir signal).
      const mainRepoDirty = sh("git", ["status", "--porcelain", "--", ".", ":!.workflow"], repo).stdout.trim();
      if (mainRepoDirty) {
        this.bdOps.reopen(repo, taskId);
        this.bdOps.comment(repo, taskId, `worktree 无改动但主仓库有未跟踪文件:\n${mainRepoDirty.slice(0, 500)}\ndev subagent 可能写错目录。请检查 worktree 路径。`);
        notify(`✖ ${taskId} worktree 为空但主仓库有改动——dev subagent 可能写错目录,已放回 bd`, "error");
        return { ok: false, exitCode: 0, noChange: false, merged: false, output: `worktree 空,主仓库有改动:\n${mainRepoDirty.slice(0, 1500)}` };
      }
      this.bdOps.close(repo, taskId, "无代码改动");
      notify(`⚠ ${taskId} 无代码改动(视为通过)`, "warning");
      return { ok: true, exitCode: 0, noChange: true, merged: false, output: "(无代码改动)" };
    }
    if (!c.committed) {
      this.bdOps.reopen(repo, taskId);
      this.bdOps.comment(repo, taskId, "git commit 失败");
      notify(`✖ ${taskId} commit 失败,已放回 bd`, "error");
      return { ok: false, exitCode: 0, noChange: false, merged: false, output: "git commit 失败" };
    }

    // 6. Merge the dev's branch back into main repo — SERIALIZED so concurrent
    //    devs (parallel execution) don't race on the shared main branch. Dev
    //    subagent execution ran in parallel in isolated worktrees; only this
    //    merge step is mutually exclusive.
    const m = await this.serialMerge(() => Promise.resolve(mergeWorktree(repo, dev.worktree.branch)));
    if (!m.ok) {
      this.bdOps.reopen(repo, taskId);
      this.bdOps.comment(repo, taskId, `merge 失败${m.conflict ? "(冲突)" : ""}:\n${m.output}`);
      notify(`✖ ${taskId} merge 失败${m.conflict ? "(冲突)" : ""},已放回 bd`, "error");
      return { ok: false, exitCode: 0, noChange: false, merged: false, output: m.output.slice(-2000) };
    }

    // 7. Close + link the commit sha in bd (so bd show <id> can find the code).
    if (c.sha) {
      try { this.bdOps.comment(repo, taskId, `代码提交:${c.sha.slice(0, 8)}(分支 ${dev.worktree.branch})`); } catch (_e) { /* best effort */ }
    }
    this.bdOps.close(repo, taskId);
    if (c.sha) dev.commits.push(c.sha);
    notify(`✔ dev${devId} 完成 ${taskId} 并合并 ${c.sha?.slice(0, 8)} (第 ${dev.issueCount} 个任务)`, "info");
    return { ok: true, exitCode: 0, noChange: false, commit: c.sha, merged: true, output: `完成并合并 ${c.sha?.slice(0, 8)}` };
  }

  /** Spawn an omp dev subagent in --print (non-interactive) mode, resolve on
   *  exit with the code. Replaces the former spawnReasonix. The dev role is
   *  injected via --system-prompt (from .omp/agents/dev.md); the instruction
   *  is the final positional arg. The dev runs in `cwd` (the worktree).
   *
   *  MUST load the workflow extension (-e) so the deepseek/gbgjxj provider is
   *  registered — otherwise omp can't resolve the model. Same pattern as the
   *  manager process spawn in workflow.ts cmdExecute. */
  private spawnDevSubagent(instruction: string, cwd: string): Promise<number> {
    return new Promise((resolve) => {
      const ompBin = resolveOmpBin();
      const role = this.loadDevRole();
      const extPath = fileURLToPath(import.meta.url);  // this extension file (workflow.ts path via dev-pool)
      const args = [
        "-e", this.devExtPath ?? extPath,  // load extension to register the dev provider
        "--print",
        "--model", `${this.cfg.dev.provider}/${this.cfg.dev.model}`,
        "--system-prompt", role,
        "--cwd", cwd,
        instruction,
      ];
      const proc = spawn(ompBin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env as Record<string, string> },
      });
      let stderrTail = "";
      proc.stderr?.on("data", (d) => { stderrTail += d.toString(); stderrTail = stderrTail.slice(-4000); });
      const timer = setTimeout(() => proc.kill("SIGTERM"), this.cfg.dev.timeoutMs);
      proc.on("exit", (code) => { clearTimeout(timer); resolve(code ?? -1); });
      proc.on("error", () => { clearTimeout(timer); resolve(-1); });
    });
  }

  /**
   * Run MULTIPLE independent tasks in parallel, each on its own dev subagent.
   * Used by the `assign_devs_batch` tool when the manager has a set of
   * independent (no mutual dependency) tasks ready at once.
   *
   * - Concurrency is capped at `concurrency` (from execute.maxParallel, up to 20).
   * - Each task runs the full runTask lifecycle (claim→subagent→verify→commit→merge→close).
   * - Dev subagent execution overlaps in time (isolated worktrees); only the
   *   merge step serializes (serialMerge lock inside runTask).
   * - bd claim is atomic, so two tasks racing for the same id self-resolve.
   * - Results returned in the SAME ORDER as the input array (for stable mapping).
   */
  async runTasksParallel(
    tasks: { devId: number; taskId: string }[],
    concurrency: number,
    opts: { allowEmptyVerify?: boolean; onNotify?: (m: string, level?: "info" | "warning" | "error") => void } = {},
  ): Promise<DevTaskResult[]> {
    if (tasks.length === 0) return [];
    const limit = Math.max(1, concurrency);
    const results: DevTaskResult[] = new Array(tasks.length);
    let next = 0;
    // Worker pool: up to `limit` workers pull indices from the shared cursor.
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= tasks.length) return;
        const { devId, taskId } = tasks[i];
        results[i] = await this.runTask(devId, taskId, opts);
      }
    };
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  /** Reset all dev worktrees to the main branch tip (persistent: worktrees
   *  stay for the next requirement, just synced to latest main). Does NOT
   *  remove them — that's the point of persistent worktrees. */
  cleanupAll(onNotify?: (m: string) => void): void {
    const repo = this.state.repo;
    const mainBranch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo).stdout.trim() || "main";
    for (const dev of this.devs.values()) {
      try {
        // Reset the dev's worktree to main tip so it's clean for the next req.
        // fetch main into the worktree, then reset --hard.
        sh("git", ["fetch", "origin", `${mainBranch}:${mainBranch}`], dev.worktree.path);
        sh("git", ["reset", "--hard", mainBranch], dev.worktree.path);
        onNotify?.(`dev${dev.id} worktree 已 reset 到 ${mainBranch}(处理了 ${dev.issueCount} 个任务,${dev.commits.length} 次提交)`);
      } catch (e) {
        // If reset fails (e.g. mainBranch fetch issue), best-effort clean status.
        onNotify?.(`dev${dev.id} worktree reset 失败(${(e as Error).message}),保留现状`);
      }
    }
    this.devs.clear();
  }

  /** Snapshot for metrics/status. */
  stats(): { devId: number; issueCount: number; commits: number }[] {
    return [...this.devs.values()].map((d) => ({ devId: d.id, issueCount: d.issueCount, commits: d.commits.length }));
  }
}
