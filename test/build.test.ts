/**
 * Integration test for the build pipeline — no LLM/API needed.
 * Uses a real temp git repo and a fake execReasonix.
 *
 * Run:  node --experimental-strip-types extensions/../test/build.test.ts
 *   (Node 24 strips TS types by default; the flag is harmless.)
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  aggregateMetrics,
  buildReasonixArgs,
  nowStamp,
  runBuildPipeline,
  slug,
  type SubtaskState,
  type WorkflowConfig,
  type WorkflowState,
} from "../extensions/lib.ts";

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
  reasonix: { bin: "reasonix", model: "deepseek-flash", maxSteps: 0, timeoutMs: 1000 },
  build: { verifyCommand: "", commitPrefix: "subtask" },
} as any;

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name} ${extra}`); failures++; }
}

// --- pure helper tests ------------------------------------------------------
console.log("pure helpers:");
check("slug ascii", slug("Add Login API!") === "add-login-api");
check("slug cjk fallback", slug("用户登录") .length > 0);
check("nowStamp format", /^\d{8}-\d{6}$/.test(nowStamp(new Date(2026, 6, 9, 10, 5, 3))));

// --- build pipeline integration --------------------------------------------
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-test-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo, { recursive: true });
  sh("git", ["init", "-q"], repo);
  sh("git", ["config", "user.email", "t@t.dev"], repo);
  sh("git", ["config", "user.name", "test"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
  sh("git", ["add", "-A"], repo);
  sh("git", ["commit", "-qm", "seed"], repo);

  const state: WorkflowState = {
    reqId: "20260709-100000-demo",
    name: "demo",
    repo,
    mode: "build",
    createdAt: new Date().toISOString(),
    baseline: sh("git", ["rev-parse", "HEAD"], repo).stdout.trim(),
    subtasks: [
      { id: "01", title: "scaffold", file: "subtasks/01.md", depends_on: [], status: "pending" },
      { id: "02", title: "nochange step", file: "subtasks/02.md", depends_on: ["01"], status: "pending" },
      { id: "03", title: "feature", file: "subtasks/03.md", depends_on: [], status: "pending" },
      { id: "04", title: "will fail", file: "subtasks/04.md", depends_on: [], status: "pending" },
      { id: "05", title: "depends on failed", file: "subtasks/05.md", depends_on: ["04"], status: "pending" },
      { id: "06", title: "after stop", file: "subtasks/06.md", depends_on: [], status: "pending" },
    ],
  };
  // reqDir exists for results/
  fs.mkdirSync(path.join(repo, ".workflow", state.reqId, "results"), { recursive: true });

  // buildReasonixArgs shape check
  const args = buildReasonixArgs(CONFIG, state, state.subtasks[0]);
  check("reasonix args start with run", args[0] === "run");
  check("reasonix args include -dir repo", args.includes("-dir") && args.includes(repo));
  check("reasonix args include -metrics", args.includes("-metrics"));
  check("reasonix args include -model", args[args.indexOf("-model") + 1] === "deepseek-flash");

  // fake reasonix: writes a metrics json for each run; changes files except "nochange"; fails on 04.
  const fakeReasonix = async (t: SubtaskState) => {
    const metricsPath = path.join(repo, ".workflow", state.reqId, "results", `${t.id}.metrics.json`);
    fs.writeFileSync(metricsPath, JSON.stringify({ cost: 0.01, cache_hit_tokens: 99, cache_miss_tokens: 1, steps: 3 }));
    if (t.id === "04") return { code: 1 }; // hard failure
    if (t.title.includes("nochange")) return { code: 0 }; // no repo change
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.appendFileSync(path.join(repo, "src", `${t.id}.txt`), `impl ${t.id}\n`);
    return { code: 0 };
  };

  const notes: string[] = [];
  const result = await runBuildPipeline(state, CONFIG, {
    execReasonix: fakeReasonix,
    verify: () => ({ ok: true, output: "" }),
    notify: (m) => notes.push(m),
    save: () => {},
  });

  console.log("build pipeline:");
  const byId = Object.fromEntries(state.subtasks.map((t) => [t.id, t]));
  check("01 done + committed", byId["01"].status === "done" && !!byId["01"].commit, byId["01"].status);
  check("02 no-change (dep satisfied)", byId["02"].status === "no-change", byId["02"].status);
  check("03 done + committed", byId["03"].status === "done" && !!byId["03"].commit, byId["03"].status);
  check("04 failed", byId["04"].status === "failed", byId["04"].status);
  check("05 skipped (dep 04 failed)", byId["05"].status === "skipped", byId["05"].status);
  check("06 skipped (pipeline stopped)", byId["06"].status === "skipped", byId["06"].status);
  check("result counts", result.ok === 2 && result.noChange === 1 && result.fail === 1 && result.skip === 2 && result.stopped === true,
    JSON.stringify({ ok: result.ok, noChange: result.noChange, fail: result.fail, skip: result.skip, stopped: result.stopped }));

  // exactly 2 subtask commits (01, 03) on top of seed
  const log = sh("git", ["log", "--oneline"], repo).stdout.trim().split("\n");
  const subtaskCommits = log.filter((l) => l.includes("subtask "));
  check("two subtask commits", subtaskCommits.length === 2, JSON.stringify(subtaskCommits));
  check("commit msg format", subtaskCommits.some((l) => l.includes("subtask 01: scaffold")), JSON.stringify(subtaskCommits));

  // artifacts
  const rdir = path.join(repo, ".workflow", state.reqId, "results");
  check("cumulative.diff written", fs.existsSync(path.join(rdir, "cumulative.diff")));
  check("summary.json written", fs.existsSync(path.join(rdir, "summary.json")));

  const summary = aggregateMetrics(state);
  check("metrics cost aggregated", summary.totals.cost > 0, String(summary.totals.cost));
  check("metrics avg cache hit ~0.99", Math.abs(summary.totals.avgCacheHit - 0.99) < 1e-6, String(summary.totals.avgCacheHit));

  // cleanup
  fs.rmSync(tmp, { recursive: true, force: true });

  // --- resumable build: pre-existing done/no-change subtasks are skipped, not re-run ---
  console.log("\nresumable build:");
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "wf-resume-"));
  const repo2 = path.join(tmp2, "repo");
  fs.mkdirSync(repo2, { recursive: true });
  sh("git", ["init", "-q"], repo2);
  sh("git", ["config", "user.email", "t@t.dev"], repo2);
  sh("git", ["config", "user.name", "test"], repo2);
  fs.writeFileSync(path.join(repo2, "README.md"), "seed\n");
  sh("git", ["add", "-A"], repo2);
  sh("git", ["commit", "-qm", "seed"], repo2);
  fs.mkdirSync(path.join(repo2, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo2, "src", "01.txt"), "impl 01\n"); // pretend subtask 01 already landed
  sh("git", ["add", "-A"], repo2);
  sh("git", ["commit", "-qm", "subtask 01: prior run"], repo2);

  const resumeState: WorkflowState = {
    reqId: "20260709-resume-demo",
    name: "resume-demo",
    repo: repo2,
    mode: "build",
    createdAt: new Date().toISOString(),
    baseline: sh("git", ["rev-parse", "HEAD"], repo2).stdout.trim(),
    subtasks: [
      { id: "01", title: "already done", file: "subtasks/01.md", depends_on: [], status: "done", commit: "deadbeef" },
      { id: "02", title: "already no-change", file: "subtasks/02.md", depends_on: ["01"], status: "no-change" },
      { id: "03", title: "still pending", file: "subtasks/03.md", depends_on: ["02"], status: "pending" },
    ],
  };
  fs.mkdirSync(path.join(repo2, ".workflow", resumeState.reqId, "results"), { recursive: true });

  let executedIds: string[] = [];
  const resumeResult = await runBuildPipeline(resumeState, CONFIG, {
    execReasonix: async (t) => {
      executedIds.push(t.id);
      fs.appendFileSync(path.join(repo2, "src", `${t.id}.txt`), `impl ${t.id}\n`);
      return { code: 0 };
    },
    verify: () => ({ ok: true, output: "" }),
    notify: () => {},
    save: () => {},
  });

  check("only pending subtask (03) executed", executedIds.length === 1 && executedIds[0] === "03", JSON.stringify(executedIds));
  check("01 remains done, untouched", resumeState.subtasks[0].status === "done" && resumeState.subtasks[0].commit === "deadbeef");
  check("02 remains no-change", resumeState.subtasks[1].status === "no-change");
  check("03 executed and committed", resumeState.subtasks[2].status === "done" && !!resumeState.subtasks[2].commit);
  check("resume result counts (2 done total incl. pre-existing + 03, 1 no-change, 0 fail/skip)",
    resumeResult.ok === 2 && resumeResult.noChange === 1 && resumeResult.fail === 0 && resumeResult.skip === 0 && resumeResult.stopped === false,
    JSON.stringify(resumeResult));

  fs.rmSync(tmp2, { recursive: true, force: true });

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
