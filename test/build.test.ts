/**
 * @deprecated 这个测试针对的是已废弃的 runBuildPipelineBd 函数(v1 build pipeline)。
 * 该函数在 v2 经理驱动架构中已被移除(见 DevPool + manager.md)。此文件保留作历史参考,
 * 但无法运行(import 的 runBuildPipelineBd/execReasonix 已不存在)。
 * 当前的 dev 执行层测试见 dev-pool.test.ts(用 fake-omp 桩验证 spawnDevSubagent 路径)。
 *
 * 原说明:Integration test for the bd-driven build pipeline — no LLM, no real bd,
 * no real omp. Uses a real temp git repo (for worktree/merge) and an
 * in-memory fake bd state machine injected via BuildDeps.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runBuildPipelineBd,
  slug,
  nowStamp,
  type WorkflowConfig,
  type WorkflowState,
} from "../extensions/lib.ts";
import type { BdIssue, IssueStatus } from "../extensions/bd.ts";

function sh(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

const CONFIG: WorkflowConfig = {
  providers: {},
  roles: {
    discuss: { provider: "deepseek", model: "deepseek-v4-pro" },
    prd: { provider: "zai", model: "glm-5.2" },
    split: { provider: "deepseek", model: "deepseek-v4-pro" },
    review: { provider: "zai", model: "glm-5.2" },
  },
  dev: { provider: "deepseek", model: "deepseek-flash", timeoutMs: 1000 },
  build: { verifyCommand: "", commitPrefix: "subtask" },
  execute: { driver: "bd", maxParallel: 1, pollIntervalMs: 5 },
} as any;

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name} ${extra}`); failures++; }
}

// ---------------------------------------------------------------------------
// In-memory fake bd state machine
// ---------------------------------------------------------------------------

interface FakeIssue {
  id: string;
  title: string;
  status: IssueStatus;
  issue_type: "task" | "epic";
  parent?: string;
  dependsOn: string[];   // blockers (blocks deps)
  comments: string[];
}

/** A fake bd that tracks issue status and computes `ready` the same way real bd does:
 *  open + all blockers closed. in_progress / closed are NOT ready. */
class FakeBd {
  issues = new Map<string, FakeIssue>();
  private seq = 0;

  constructor(repo: string) { void repo; }

  create(title: string, type: "task" | "epic" = "task", parent?: string): string {
    this.seq++;
    const id = `bd-fake-${this.seq}`;
    this.issues.set(id, { id, title, status: "open", issue_type: type, parent, dependsOn: [], comments: [] });
    return id;
  }
  depAdd(dependent: string, dep: string): void {
    const d = this.issues.get(dependent);
    if (d) d.dependsOn.push(dep);
  }
  readyTasks(): BdIssue[] {
    const out: BdIssue[] = [];
    for (const i of this.issues.values()) {
      if (i.issue_type !== "task") continue;
      if (i.status !== "open") continue;
      const blocked = i.dependsOn.some((d) => {
        const dep = this.issues.get(d);
        return dep && dep.status !== "closed";
      });
      if (!blocked) out.push(this.toBdIssue(i));
    }
    return out;
  }
  children(parentId: string): BdIssue[] {
    return [...this.issues.values()].filter((i) => i.parent === parentId).map((i) => this.toBdIssue(i));
  }
  claim(id: string): boolean {
    const i = this.issues.get(id);
    if (!i || i.status !== "open") return false;
    i.status = "in_progress";
    return true;
  }
  close(id: string): void { const i = this.issues.get(id); if (i) i.status = "closed"; }
  reopen(id: string): void { const i = this.issues.get(id); if (i) i.status = "open"; }
  comment(id: string, text: string): void { const i = this.issues.get(id); if (i) i.comments.push(text); }
  private toBdIssue(i: FakeIssue): BdIssue {
    return {
      id: i.id, title: i.title, status: i.status, priority: 2, issue_type: i.issue_type,
      owner: null, created_at: "", updated_at: "", parent: i.parent,
    };
  }
}

// ---------------------------------------------------------------------------
// Worktree helpers against a REAL temp git repo (exercises merge/commit)
// ---------------------------------------------------------------------------

function makeRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-bd-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo, { recursive: true });
  sh("git", ["init", "-q"], repo);
  sh("git", ["config", "user.email", "t@t.dev"], repo);
  sh("git", ["config", "user.name", "test"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
  sh("git", ["add", "-A"], repo);
  sh("git", ["commit", "-qm", "seed"], repo);
  return repo;
}

let wtSeq = 0;
function addWt(repo: string, name: string, branch: string) {
  wtSeq++;
  const p = path.join(repo, name);
  const r = sh("git", ["worktree", "add", "-b", branch, p], repo);
  if (r.code !== 0) throw new Error(`worktree add failed: ${r.stderr}`);
  return { path: p, branch, name };
}
function removeWt(repo: string, wt: { path: string; branch: string }) {
  sh("git", ["worktree", "remove", "--force", wt.path], repo);
  sh("git", ["branch", "-D", wt.branch], repo);
}
function mergeWt(repo: string, branch: string) {
  const r = sh("git", ["merge", "--no-ff", branch, "-m", `merge: ${branch}`], repo);
  if (r.code === 0) return { ok: true, conflict: false, output: r.stdout };
  if (/CONFLICT/i.test(r.stdout + r.stderr)) return { ok: false, conflict: true, output: r.stderr };
  sh("git", ["merge", "--abort"], repo);
  return { ok: false, conflict: false, output: r.stderr };
}
function commitOn(cwd: string, id: string, title: string): { committed: boolean; sha?: string; empty?: boolean } {
  const st = sh("git", ["status", "--porcelain"], cwd).stdout.trim();
  if (!st) return { committed: false, empty: true };
  sh("git", ["add", "-A"], cwd);
  const c = sh("git", ["commit", "-m", `subtask ${id}: ${title}`], cwd);
  if (c.code !== 0) return { committed: false };
  return { committed: true, sha: sh("git", ["rev-parse", "HEAD"], cwd).stdout.trim() };
}

// ---------------------------------------------------------------------------
// Test 1: serial (maxParallel=1), dependency ordering, fail-fast, no-change
// ---------------------------------------------------------------------------

async function testSerialFailFast() {
  console.log("\nserial pipeline (maxParallel=1):");
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".workflow", "20260709-demo", "results"), { recursive: true });
  const fake = new FakeBd(repo);
  const epic = fake.create("demo", "epic");
  // 01 (no deps) → 02 (dep 01) → 03 (no dep). 04 (no dep, will fail). 05 (dep 04).
  const t1 = fake.create("scaffold", "task", epic);
  const t2 = fake.create("dep-on-1", "task", epic); fake.depAdd(t2, t1);
  const t3 = fake.create("feature", "task", epic);
  const t4 = fake.create("will-fail", "task", epic);
  const t5 = fake.create("dep-on-4", "task", epic); fake.depAdd(t5, t4);

  const state: WorkflowState = {
    reqId: "20260709-demo", name: "demo", repo, mode: "build",
    createdAt: new Date().toISOString(), epicId: epic,
    baseline: sh("git", ["rev-parse", "HEAD"], repo).stdout.trim(),
    subtaskIds: [t1, t2, t3, t4, t5],
  };

  const result = await runBuildPipelineBd(state, CONFIG, {
    readyTasks: () => fake.readyTasks(),
    claim: (_r, id) => fake.claim(id),
    close: (_r, id) => fake.close(id),
    reopen: (_r, id) => fake.reopen(id),
    comment: (_r, id, t) => fake.comment(id, t),
    children: (_r, p) => fake.children(p),
    execReasonix: async (t, cwd) => {
      // t4 fails; everything else writes a file.
      if (t.id === t4) return { code: 1 };
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", `${t.id}.txt`), `impl ${t.id}\n`);
      return { code: 0 };
    },
    verify: () => ({ ok: true, output: "" }),
    addWorktree: (_r, n, b) => addWt(repo, n, b),
    removeWorktree: (_r, wt) => removeWt(repo, wt),
    mergeWorktree: (_r, b) => mergeWt(repo, b),
    commitSubtask: (cwd, t) => commitOn(cwd, t.id, t.title),
    notify: () => {},
    save: () => {},
  });

  // t1 done; t2 done (dep satisfied); t3 done; t4 failed; t5 never reached (fail-fast).
  check("t1 closed (done)", fake.issues.get(t1)!.status === "closed");
  check("t2 closed (dep chain)", fake.issues.get(t2)!.status === "closed");
  check("t3 closed (done)", fake.issues.get(t3)!.status === "closed");
  check("t4 reopened (failed)", fake.issues.get(t4)!.status === "open");
  check("t4 has failure comment", (fake.issues.get(t4)!.comments.length > 0));
  check("t5 still open (never ran, fail-fast)", fake.issues.get(t5)!.status === "open");
  check("result: 3 ok, 1 fail, stopped", result.ok === 3 && result.fail === 1 && result.stopped === true,
    JSON.stringify({ ok: result.ok, fail: result.fail, stopped: result.stopped }));

  // 3 commits merged into main.
  const log = sh("git", ["log", "--oneline"], repo).stdout;
  const subtaskCommits = log.split("\n").filter((l) => l.includes("subtask "));
  check("3 subtask commits merged", subtaskCommits.length === 3, JSON.stringify(subtaskCommits.length));

  // No leftover worktrees.
  const wts = sh("git", ["worktree", "list"], repo).stdout;
  check("worktrees cleaned up", wts.split("\n").filter(Boolean).length === 1, wts);

  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 2: parallel (maxParallel=3), two independent tasks run concurrently
// ---------------------------------------------------------------------------

async function testParallel() {
  console.log("\nparallel pipeline (maxParallel=3):");
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".workflow", "20260709-par", "results"), { recursive: true });
  const fake = new FakeBd(repo);
  const epic = fake.create("par", "epic");
  const a = fake.create("task-a", "task", epic);
  const b = fake.create("task-b", "task", epic);
  const c = fake.create("task-c-joins", "task", epic); fake.depAdd(c, a); fake.depAdd(c, b);

  const state: WorkflowState = {
    reqId: "20260709-par", name: "par", repo, mode: "build",
    createdAt: new Date().toISOString(), epicId: epic,
    baseline: sh("git", ["rev-parse", "HEAD"], repo).stdout.trim(),
    subtaskIds: [a, b, c],
  };
  const parConfig = { ...CONFIG, execute: { driver: "bd" as const, maxParallel: 3, pollIntervalMs: 5 } };

  // Track concurrency: record overlapping intervals.
  let active = 0; let maxActive = 0;
  const startTimes: Record<string, number> = {};
  const endTimes: Record<string, number> = {};

  const result = await runBuildPipelineBd(state, parConfig, {
    readyTasks: () => fake.readyTasks(),
    claim: (_r, id) => fake.claim(id),
    close: (_r, id) => fake.close(id),
    reopen: (_r, id) => fake.reopen(id),
    comment: (_r, id, t) => fake.comment(id, t),
    children: (_r, p) => fake.children(p),
    execReasonix: async (t, cwd) => {
      active++; maxActive = Math.max(maxActive, active);
      startTimes[t.id] = Date.now();
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", `${t.id}.txt`), `impl ${t.id}\n`);
      // tiny delay so concurrency is observable
      await new Promise((r) => setTimeout(r, 30));
      endTimes[t.id] = Date.now();
      active--;
      return { code: 0 };
    },
    verify: () => ({ ok: true, output: "" }),
    addWorktree: (_r, n, b) => addWt(repo, n, b),
    removeWorktree: (_r, wt) => removeWt(repo, wt),
    mergeWorktree: (_r, b) => mergeWt(repo, b),
    commitSubtask: (cwd, t) => commitOn(cwd, t.id, t.title),
    notify: () => {},
    save: () => {},
  });

  check("a and b ran concurrently (maxActive >= 2)", maxActive >= 2, `maxActive=${maxActive}`);
  check("a closed", fake.issues.get(a)!.status === "closed");
  check("b closed", fake.issues.get(b)!.status === "closed");
  check("c closed (joined after a+b)", fake.issues.get(c)!.status === "closed");
  check("result 3 ok 0 fail", result.ok === 3 && result.fail === 0 && result.stopped === false,
    JSON.stringify({ ok: result.ok, fail: result.fail }));
  // c started after both a and b ended (fan-in respected).
  const cStartedAfterA = endTimes[a] <= startTimes[c];
  const cStartedAfterB = endTimes[b] <= startTimes[c];
  check("c started after both a and b finished", cStartedAfterA && cStartedAfterB,
    `aEnd=${endTimes[a]} bEnd=${endTimes[b]} cStart=${startTimes[c]}`);

  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 3: no-change (reasonix produces no code diff)
// ---------------------------------------------------------------------------

async function testNoChange() {
  console.log("\nno-change subtask:");
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".workflow", "20260709-nc", "results"), { recursive: true });
  const fake = new FakeBd(repo);
  const epic = fake.create("nc", "epic");
  const t = fake.create("no-change", "task", epic);

  const state: WorkflowState = {
    reqId: "20260709-nc", name: "nc", repo, mode: "build",
    createdAt: new Date().toISOString(), epicId: epic,
    baseline: sh("git", ["rev-parse", "HEAD"], repo).stdout.trim(),
    subtaskIds: [t],
  };

  const result = await runBuildPipelineBd(state, CONFIG, {
    readyTasks: () => fake.readyTasks(),
    claim: (_r, id) => fake.claim(id),
    close: (_r, id) => fake.close(id),
    reopen: (_r, id) => fake.reopen(id),
    comment: (_r, id, x) => fake.comment(id, x),
    children: (_r, p) => fake.children(p),
    execReasonix: async () => ({ code: 0 }), // succeeds but writes nothing
    verify: () => ({ ok: true, output: "" }),
    addWorktree: (_r, n, b) => addWt(repo, n, b),
    removeWorktree: (_r, wt) => removeWt(repo, wt),
    mergeWorktree: (_r, b) => mergeWt(repo, b),
    commitSubtask: (cwd, t2) => commitOn(cwd, t2.id, t2.title),
    notify: () => {},
    save: () => {},
  });

  check("no-change task closed", fake.issues.get(t)!.status === "closed");
  check("result noChange=1, ok=0", result.noChange === 1 && result.ok === 0,
    JSON.stringify({ ok: result.ok, noChange: result.noChange }));

  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 4: resumable — reopen a previously-failed task, re-run picks it up
// ---------------------------------------------------------------------------

async function testResumable() {
  console.log("\nresumable (reopen + re-run):");
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".workflow", "20260709-res", "results"), { recursive: true });
  const fake = new FakeBd(repo);
  const epic = fake.create("res", "epic");
  const t = fake.create("retry-me", "task", epic);

  const state: WorkflowState = {
    reqId: "20260709-res", name: "res", repo, mode: "build",
    createdAt: new Date().toISOString(), epicId: epic,
    baseline: sh("git", ["rev-parse", "HEAD"], repo).stdout.trim(),
    subtaskIds: [t],
  };

  // First run: fails.
  await runBuildPipelineBd(state, CONFIG, {
    readyTasks: () => fake.readyTasks(),
    claim: (_r, id) => fake.claim(id),
    close: (_r, id) => fake.close(id),
    reopen: (_r, id) => fake.reopen(id),
    comment: (_r, id, x) => fake.comment(id, x),
    children: (_r, p) => fake.children(p),
    execReasonix: async () => ({ code: 1 }),
    verify: () => ({ ok: true, output: "" }),
    addWorktree: (_r, n, b) => addWt(repo, n, b),
    removeWorktree: (_r, wt) => removeWt(repo, wt),
    mergeWorktree: (_r, b) => mergeWt(repo, b),
    commitSubtask: (cwd, t2) => commitOn(cwd, t2.id, t2.title),
    notify: () => {},
    save: () => {},
  });
  check("after fail: task reopened (open)", fake.issues.get(t)!.status === "open");

  // Second run: succeeds.
  const result2 = await runBuildPipelineBd(state, CONFIG, {
    readyTasks: () => fake.readyTasks(),
    claim: (_r, id) => fake.claim(id),
    close: (_r, id) => fake.close(id),
    reopen: (_r, id) => fake.reopen(id),
    comment: (_r, id, x) => fake.comment(id, x),
    children: (_r, p) => fake.children(p),
    execReasonix: async (_t, cwd) => {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "done.txt"), "ok\n");
      return { code: 0 };
    },
    verify: () => ({ ok: true, output: "" }),
    addWorktree: (_r, n, b) => addWt(repo, n, b),
    removeWorktree: (_r, wt) => removeWt(repo, wt),
    mergeWorktree: (_r, b) => mergeWt(repo, b),
    commitSubtask: (cwd, t2) => commitOn(cwd, t2.id, t2.title),
    notify: () => {},
    save: () => {},
  });
  check("after retry: task closed", fake.issues.get(t)!.status === "closed");
  check("retry result ok=1 fail=0", result2.ok === 1 && result2.fail === 0,
    JSON.stringify({ ok: result2.ok, fail: result2.fail }));

  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------

console.log("pure helpers:");
check("slug ascii", slug("Add Login API!") === "add-login-api");
check("slug cjk fallback", slug("用户登录").length > 0);
check("nowStamp format", /^\d{8}-\d{6}$/.test(nowStamp(new Date(2026, 6, 9, 10, 5, 3))));

async function main() {
  await testSerialFailFast();
  await testParallel();
  await testNoChange();
  await testResumable();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
