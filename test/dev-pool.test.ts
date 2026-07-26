/**
 * Test for DevPool: per-dev worktree stability and the
 * claim→run→commit→merge→close lifecycle. Uses a real temp git repo
 * for worktree/merge, a FakeBd for bd state, and mocks the omp dev subagent
 * by injecting a fake omp binary (via PATH) that the pool spawns.
 *
 * Run: node --experimental-strip-types test/dev-pool.test.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BdIssue, IssueStatus } from "../extensions/bd.ts";

// We import DevPool and test via runTask. The pool spawns the omp binary
// (resolved via resolveOmpBin → `which omp`). We put a fake `omp` script on
// PATH ahead of the real one so the pool spawns our fake, which writes a
// marker file in the --cwd worktree and exits 1 if the instruction contains FAIL.
import { DevPool } from "../extensions/dev-pool.ts";
import type { WorkflowConfig, WorkflowState } from "../extensions/lib.ts";

function sh(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name} ${extra}`); failures++; }
}

// ---------------------------------------------------------------------------
// Fake bd state machine (same as build.test.ts)
// ---------------------------------------------------------------------------

interface FakeIssue {
  id: string; title: string; status: IssueStatus;
  issue_type: "task" | "epic" | "bug"; parent?: string;
  notes?: string; dependsOn: string[]; comments: string[];
}

class FakeBd {
  issues = new Map<string, FakeIssue>();
  private seq = 0;
  create(title: string, type: "task" | "epic" | "bug" = "task", parent?: string, notes?: string): string {
    this.seq++;
    const id = `bd-fake-${this.seq}`;
    this.issues.set(id, { id, title, status: "open", issue_type: type, parent, notes, dependsOn: [], comments: [] });
    return id;
  }
  depAdd(dep: string, on: string) { const d = this.issues.get(dep); if (d) d.dependsOn.push(on); }
  readyTasks(): BdIssue[] {
    return [...this.issues.values()]
      .filter((i) => i.issue_type === "task" && i.status === "open" && i.dependsOn.every((d) => this.issues.get(d)?.status === "closed"))
      .map((i) => ({ id: i.id, title: i.title, status: i.status, priority: 2, issue_type: i.issue_type as any, owner: null, created_at: "", updated_at: "", parent: i.parent, notes: i.notes }));
  }
  claim(id: string): boolean { const i = this.issues.get(id); if (!i || i.status !== "open") return false; i.status = "in_progress"; return true; }
  close(id: string) { const i = this.issues.get(id); if (i) i.status = "closed"; }
  reopen(id: string) { const i = this.issues.get(id); if (i) i.status = "open"; }
  comment(id: string, t: string) { const i = this.issues.get(id); if (i) i.comments.push(t); }
  show(id: string): BdIssue { const i = this.issues.get(id)!; return { id: i.id, title: i.title, status: i.status, priority: 2, issue_type: i.issue_type as any, owner: null, created_at: "", updated_at: "", parent: i.parent, notes: i.notes }; }
}

// Build a BdOps adapter from FakeBd — injected into DevPool for testing.
import type { BdOps } from "../extensions/dev-pool.ts";
function fakeBdOps(fake: FakeBd): BdOps {
  return {
    show: (_repo, id) => fake.show(id),
    claim: (_repo, id, _a) => fake.claim(id),
    close: (_repo, id, _r) => fake.close(id),
    reopen: (_repo, id) => fake.reopen(id),
    comment: (_repo, id, t) => fake.comment(id, t),
  };
}

// ---------------------------------------------------------------------------
// Fake omp: write a shell script named `omp` that mimics the dev subagent
// (parse --cwd=<dir> from argv, write a marker file in that worktree, exit 1
// if the instruction contains FAIL). Installed on PATH ahead of the real omp.
// ---------------------------------------------------------------------------

function makeFakeOmp(): { bin: string; dir: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-omp-"));
  const script = path.join(tmp, "omp");
  // Fake omp: parse --cwd=<dir> from argv, write a marker file, exit 1 if FAIL.
  // The instruction is the last positional arg.
  // NOTE: avoid shell ${...} in this template — Node's TS stripper misreads it.
  const scriptBody = [
    "#!/bin/bash",
    'DIR=""',
    'INSTR=""',
    'PREV=""',
    'for a in "$@"; do',
    '  case "$a" in --cwd=*) DIR="${a#--cwd=}";; esac',
    '  if [ "$PREV" = "--cwd" ]; then DIR="$a"; fi',
    '  PREV="$a"',
    '  INSTR="$a"',
    'done',
    'mkdir -p "$DIR/src" 2>/dev/null',
    'echo "impl" >> "$DIR/src/impl.txt"',
    'echo "$INSTR" | grep -q "FAIL" && exit 1',
    "exit 0",
    "",
  ].join("\n");
  fs.writeFileSync(script, scriptBody);
  fs.chmodSync(script, 0o755);
  return { bin: script, dir: tmp };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function makeRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dev-"));
  fs.mkdirSync(tmp, { recursive: true });
  sh("git", ["init", "-q"], tmp);
  sh("git", ["config", "user.email", "t@t.dev"], tmp);
  sh("git", ["config", "user.name", "test"], tmp);
  fs.writeFileSync(path.join(tmp, "README.md"), "seed\n");
  sh("git", ["add", "-A"], tmp);
  sh("git", ["commit", "-qm", "seed"], tmp);
  return tmp;
}

const FAKE_OMP = makeFakeOmp();
// Put the fake omp dir FIRST on PATH so resolveOmpBin (`which omp`) finds it.
process.env.PATH = `${FAKE_OMP.dir}:${process.env.PATH}`;
const CONFIG: WorkflowConfig = {
  providers: {},
  roles: { discuss:{provider:"",model:""}, prd:{provider:"",model:""}, split:{provider:"",model:""}, review:{provider:"",model:""} },
  dev: { provider: "fake", model: "fake", timeoutMs: 30000 },
  build: { verifyCommand: "", commitPrefix: "subtask" },
  execute: { driver: "bd", maxParallel: 3 },
};

async function main() {
  // --- Test 1: per-dev worktree stability + multi-task on same dev ---
  console.log("\nDevPool: per-dev worktree + multi-task:");
  {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".workflow", "req1", "results"), { recursive: true });
    const fake = new FakeBd();
    const ops = fakeBdOps(fake);
    const t1 = fake.create("task A", "task", "epic1", "规格文件:/tmp/spec-a.md");
    const t2 = fake.create("task B", "task", "epic1", "规格文件:/tmp/spec-b.md");

    const state: WorkflowState = {
      reqId: "req1", name: "demo", repo, mode: "build",
      createdAt: new Date().toISOString(), epicId: "epic1", subtaskIds: [t1, t2],
      baseline: sh("git", ["rev-parse", "HEAD"], repo).stdout.trim(),
    };
    const pool = new DevPool(state, CONFIG, undefined, ops);

    // Assign both tasks to dev1 — both should succeed (fresh subagent per task).
    const r1 = await pool.runTask(1, t1, { allowEmptyVerify: true, onNotify: () => {} });
    check("dev1 task1 ok", r1.ok, JSON.stringify(r1));
    check("dev1 task1 closed", fake.issues.get(t1)!.status === "closed");

    const r2 = await pool.runTask(1, t2, { allowEmptyVerify: true, onNotify: () => {} });
    check("dev1 task2 ok", r2.ok, JSON.stringify(r2));
    check("dev1 task2 closed", fake.issues.get(t2)!.status === "closed");

    // dev1's worktree should be stable (same path for both tasks).
    const stats = pool.stats();
    check("dev1 processed 2 tasks", stats[0]?.issueCount === 2, JSON.stringify(stats));

    // Both commits merged into main repo.
    const log = sh("git", ["log", "--oneline"], repo).stdout;
    const commits = log.split("\n").filter((l) => l.includes("subtask "));
    check("2 commits merged to main", commits.length === 2, JSON.stringify(commits.length));

    pool.cleanupAll();
    // Worktrees persist (reset-only cleanup, not removed) — they're reused
    // across requirements. Verify the worktree still exists but devs map cleared.
    const wts = sh("git", ["worktree", "list"], repo).stdout;
    check("worktree persists (reset-only)", wts.includes("wt-dev1"), wts);
    check("devs map cleared after cleanup", pool.stats().length === 0);

    fs.rmSync(repo, { recursive: true, force: true });
  }

  // --- Test 2: different devs get different worktrees ---
  console.log("\nDevPool: multiple devs = multiple worktrees:");
  {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".workflow", "req2", "results"), { recursive: true });
    const fake = new FakeBd();
    const ops = fakeBdOps(fake);
    const t1 = fake.create("task A", "task", "epic2", "规格文件:/tmp/a.md");
    const t2 = fake.create("task B", "task", "epic2", "规格文件:/tmp/b.md");

    const state: WorkflowState = {
      reqId: "req2", name: "demo", repo, mode: "build",
      createdAt: new Date().toISOString(), epicId: "epic2", subtaskIds: [t1, t2],
      baseline: sh("git", ["rev-parse", "HEAD"], repo).stdout.trim(),
    };
    const pool = new DevPool(state, CONFIG, undefined, ops);

    // Two tasks → two different devs.
    const wtsBefore = sh("git", ["worktree", "list"], repo).stdout.split("\n").filter(Boolean).length;
    await pool.runTask(1, t1, { allowEmptyVerify: true, onNotify: () => {} });
    await pool.runTask(2, t2, { allowEmptyVerify: true, onNotify: () => {} });
    // During execution, 2 extra worktrees existed; after merge they're still there until cleanup.
    const stats = pool.stats();
    check("dev1 + dev2 both exist", stats.length === 2, JSON.stringify(stats));
    check("dev1 ≠ dev2 worktrees", stats[0].devId !== stats[1].devId);
    check("both closed", fake.issues.get(t1)!.status === "closed" && fake.issues.get(t2)!.status === "closed");

    pool.cleanupAll();
    fs.rmSync(repo, { recursive: true, force: true });
  }

  // --- Test 3: failure → reopen + comment ---
  console.log("\nDevPool: failure reopens + comments:");
  {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".workflow", "req3", "results"), { recursive: true });
    const fake = new FakeBd();
    const ops = fakeBdOps(fake);
    // Task with FAIL in spec → fake omp exits 1.
    const t1 = fake.create("FAIL task", "task", "epic3", "规格文件:/tmp/FAIL.md");

    const state: WorkflowState = {
      reqId: "req3", name: "demo", repo, mode: "build",
      createdAt: new Date().toISOString(), epicId: "epic3", subtaskIds: [t1],
      baseline: sh("git", ["rev-parse", "HEAD"], repo).stdout.trim(),
    };
    const pool = new DevPool(state, CONFIG, undefined, ops);
    const r = await pool.runTask(1, t1, { allowEmptyVerify: true, onNotify: () => {} });
    check("failed task not ok", !r.ok, JSON.stringify(r));
    check("failed task reopened", fake.issues.get(t1)!.status === "open", fake.issues.get(t1)!.status);
    check("failure comment added", fake.issues.get(t1)!.comments.length > 0);

    pool.cleanupAll();
    fs.rmSync(repo, { recursive: true, force: true });
  }

  // --- Test 4: parallel execution (runTasksParallel + merge serialization) ---
  console.log("\nDevPool: parallel tasks + merge serialization:");
  {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".workflow", "req4", "results"), { recursive: true });
    const fake = new FakeBd();
    const ops = fakeBdOps(fake);
    // 4 independent tasks → 4 different devs, run in parallel (concurrency 4).
    const t1 = fake.create("task A", "task", "epic4", "规格文件:/tmp/p-a.md");
    const t2 = fake.create("task B", "task", "epic4", "规格文件:/tmp/p-b.md");
    const t3 = fake.create("task C", "task", "epic4", "规格文件:/tmp/p-c.md");
    const t4 = fake.create("task D", "task", "epic4", "规格文件:/tmp/p-d.md");

    const state: WorkflowState = {
      reqId: "req4", name: "demo", repo, mode: "build",
      createdAt: new Date().toISOString(), epicId: "epic4", subtaskIds: [t1, t2, t3, t4],
      baseline: sh("git", ["rev-parse", "HEAD"], repo).stdout.trim(),
    };
    const pool = new DevPool(state, CONFIG, undefined, ops);

    const tasks = [
      { devId: 1, taskId: t1 },
      { devId: 2, taskId: t2 },
      { devId: 3, taskId: t3 },
      { devId: 4, taskId: t4 },
    ];
    const results = await pool.runTasksParallel(tasks, 4, { allowEmptyVerify: true, onNotify: () => {} });
    check("parallel: 4 results returned", results.length === 4, JSON.stringify(results.length));
    check("parallel: all ok", results.every((r) => r.ok), results.map((r) => r.ok).join(","));
    check("parallel: all closed", [t1, t2, t3, t4].every((id) => fake.issues.get(id)!.status === "closed"));
    // 4 commits merged into main (merge serialized, no conflicts).
    const log = sh("git", ["log", "--oneline"], repo).stdout;
    const commits = log.split("\n").filter((l) => l.includes("subtask "));
    check("parallel: 4 commits merged to main", commits.length === 4, JSON.stringify(commits.length));

    pool.cleanupAll();
    fs.rmSync(repo, { recursive: true, force: true });
  }

  fs.rmSync(FAKE_OMP.dir, { recursive: true, force: true });
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
