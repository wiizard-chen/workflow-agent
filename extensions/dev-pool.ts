/**
 * dev-pool — manages per-developer (reasonix session) worktrees and the
 * first-run-vs-continue distinction that enables context reuse across issues.
 *
 * Architecture (see DECISION_LOG.md):
 * - A "dev" is a persistent reasonix session tied to ONE fixed worktree.
 * - The worktree path is stable for the dev's lifetime → reasonix stores its
 *   session under ~/.reasonix/projects/<escaped-worktree-path>/sessions/ →
 *   `reasonix run --continue` resumes that exact session.
 * - The FIRST task a dev runs uses plain `run`; every subsequent task uses
 *   `run --continue`, so the dev carries project understanding + prior issue
 *   context forward. This is the context-reuse win.
 *
 * The pool is module-level state, keyed by devId (1/2/3). It is NOT exposed
 * to the manager LLM — the manager only passes a devId number; the tool layer
 * (assign_dev) resolves it here.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  addWorktree,
  commitSubtask,
  gitHead,
  mergeWorktree,
  removeWorktree,
  runVerify,
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
  id: number;                  // 1/2/3 — the devId the manager passes
  worktree: Worktree;          // FIXED for the dev's lifetime (path never changes)
  sessionStarted: boolean;     // false → first run (plain `run`); true → use `--continue`
  issueCount: number;          // how many issues this dev has processed (for metrics/logs)
  commits: string[];           // sha of each merged commit (for metrics)
}

export interface DevTaskResult {
  ok: boolean;
  exitCode: number;
  noChange: boolean;
  commit?: string;
  merged: boolean;
  output: string;              // tail of reasonix/verify output for the manager
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

  constructor(state: WorkflowState, cfg: WorkflowConfig, bdExec?: BdExec, bdOps?: BdOps) {
    this.state = state;
    this.cfg = cfg;
    this.bdExec = bdExec;
    this.bdOps = bdOps ?? realBdOps;
  }

  /**
   * Get an existing dev, or create one with a fresh worktree on first use.
   * Worktree path is deterministic: <repo>/wt-<reqId>-dev<id> — stable for the
   * dev's lifetime so reasonix's `-dir` never changes and --continue works.
   */
  getOrCreate(devId: number): Dev {
    let dev = this.devs.get(devId);
    if (dev) return dev;
    const name = `wt-${this.state.reqId}-dev${devId}`;
    const branch = `bd-${this.state.reqId}-dev${devId}`;
    const wt = addWorktree(this.state.repo, name, branch, this.bdExec);
    dev = { id: devId, worktree: wt, sessionStarted: false, issueCount: 0, commits: [] };
    this.devs.set(devId, dev);
    return dev;
  }

  /**
   * Build the reasonix argv for this dev's next task.
   * First task ever → plain `run`. Subsequent → `run --continue` (resume session).
   */
  private reasonixArgs(specPath: string, dev: Dev): string[] {
    // Prefix the dev's role positioning (see .omp/agents/dev.md) so reasonix
    // knows its single-responsibility boundary, then the task instruction.
    // The role block is kept short here; the full dev.md is the source of truth.
    const rolePrefix =
      `【角色】你是 pi-workflow 的开发执行者(dev),单一职责:只实现当前分配给你的这一个 task。` +
      `不拆分需求、不测试整体产出、不越界实现其他 task。先读规格,严守验收标准,过验证门。` +
      `阻碍建 bd bug(不要写本地 TODO);进度/失败写 bd comment(单数)。` +
      `【skill 白名单】你只能用 bd-work(核心)和 beads(速查);禁止用 bd-split/bd-plan/plan-interrogation——那些不归 dev。\n`;
    const instruction =
      rolePrefix +
      `实现这个子任务。完整规格在文件:${specPath}(先读它)。` +
      `严格按其中的验收标准实现,只做这一个子任务,不要越界实现其他子任务。`;
    const args = [
      "run",
      "-dir", dev.worktree.path,
      "-model", this.cfg.reasonix.model,
      "-max-steps", String(this.cfg.reasonix.maxSteps),
    ];
    if (dev.sessionStarted) {
      args.push("--continue");   // resume this dev's session → context reuse
    }
    args.push(instruction);
    return args;
  }

  /**
   * Run ONE task on this dev: reasonix → verify → commit → merge → bd close.
   * Synchronous: resolves only after reasonix exits.
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

    // 3. Run reasonix (first run vs --continue).
    notify(`▶ dev${devId} 开始 ${taskId}(session ${dev.sessionStarted ? "续跑" : "首次"})`, "info");
    const args = this.reasonixArgs(specPath || `(无规格,任务:${taskId})`, dev);
    const exitCode = await this.spawnReasonix(args, dev.worktree.path);

    if (exitCode !== 0) {
      this.bdOps.reopen(repo, taskId);
      this.bdOps.comment(repo, taskId, `dev${devId} reasonix 失败(退出码 ${exitCode})`);
      notify(`✖ ${taskId} reasonix 失败(code ${exitCode}),已放回 bd`, "error");
      return { ok: false, exitCode, noChange: false, merged: false, output: `reasonix 退出码 ${exitCode}` };
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

    // sessionStarted flips AFTER the first successful or attempted run — subsequent
    // tasks on this dev use --continue. (Flip here, before noChange early-return,
    // so even a no-change task counts as "session started".)
    dev.sessionStarted = true;
    dev.issueCount++;

    if (c.empty) {
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

    // 6. Merge the dev's branch back into main repo.
    const m = mergeWorktree(repo, dev.worktree.branch);
    if (!m.ok) {
      this.bdOps.reopen(repo, taskId);
      this.bdOps.comment(repo, taskId, `merge 失败${m.conflict ? "(冲突)" : ""}:\n${m.output}`);
      notify(`✖ ${taskId} merge 失败${m.conflict ? "(冲突)" : ""},已放回 bd`, "error");
      return { ok: false, exitCode: 0, noChange: false, merged: false, output: m.output.slice(-2000) };
    }

    this.bdOps.close(repo, taskId);
    if (c.sha) dev.commits.push(c.sha);
    notify(`✔ dev${devId} 完成 ${taskId} 并合并 ${c.sha?.slice(0, 8)} (第 ${dev.issueCount} 个任务,session ${dev.sessionStarted ? "已续跑" : "首次"})`, "info");
    return { ok: true, exitCode: 0, noChange: false, commit: c.sha, merged: true, output: `完成并合并 ${c.sha?.slice(0, 8)}` };
  }

  /** Spawn reasonix async, resolve on exit with the code. */
  private spawnReasonix(args: string[], cwd: string): Promise<number> {
    return new Promise((resolve) => {
      const proc = spawn(this.cfg.reasonix.bin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderrTail = "";
      proc.stderr?.on("data", (d) => { stderrTail += d.toString(); stderrTail = stderrTail.slice(-4000); });
      const timer = setTimeout(() => proc.kill("SIGTERM"), this.cfg.reasonix.timeoutMs);
      proc.on("exit", (code) => { clearTimeout(timer); resolve(code ?? -1); });
      proc.on("error", () => { clearTimeout(timer); resolve(-1); });
    });
  }

  /** Tear down all dev worktrees. Call when the manager finishes. */
  cleanupAll(onNotify?: (m: string) => void): void {
    for (const dev of this.devs.values()) {
      try {
        removeWorktree(this.state.repo, dev.worktree, this.bdExec);
        onNotify?.(`dev${dev.id} worktree 已清理(处理了 ${dev.issueCount} 个任务,${dev.commits.length} 次提交)`);
      } catch (_e) { /* best effort */ }
    }
    this.devs.clear();
  }

  /** Snapshot for metrics/status. */
  stats(): { devId: number; issueCount: number; commits: number; sessionStarted: boolean }[] {
    return [...this.devs.values()].map((d) => ({ devId: d.id, issueCount: d.issueCount, commits: d.commits.length, sessionStarted: d.sessionStarted }));
  }
}
