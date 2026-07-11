// Live smoke driver for the bd-driven workflow extension over pi RPC.
// Usage: node test/smoke-bd.mjs
// Requires DEEPSEEK_API_KEY + GLM5_2_API_KEY in env (run under `zsh -ic`).
// Creates a fresh temp target repo under $HOME (bd rejects /tmp as unsafe),
// runs /wf new → discuss → /wf draft → /build, then verifies bd state + git.

import { spawn, spawnSync } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const WF_DIR = process.cwd();
// Target repo under $HOME so bd accepts the path (it rejects /tmp as unsafe).
const targetDir = fs.mkdtempSync(path.join(os.homedir(), ".smoke-bd-target-"));
const repo = path.join(targetDir, "repo");
fs.mkdirSync(repo, { recursive: true });
let sh = (c, a) => spawnSync(c, a, { cwd: repo, encoding: "utf8" });
sh("git", ["init", "-q"]);
sh("git", ["config", "user.email", "t@t.dev"]);
sh("git", ["config", "user.name", "smoke"]);
fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "smoke-target", version: "1.0.0" }) + "\n");
sh("git", ["add", "-A"]); sh("git", ["commit", "-qm", "init"]);

console.log(`target repo: ${repo}`);

const child = spawn("omp", ["-e", "./extensions/workflow.ts", "--mode", "rpc", "--model", "deepseek/deepseek-v4-pro"], {
  cwd: WF_DIR, env: process.env, stdio: ["pipe", "pipe", "pipe"],
});

const waiters = [];
let lastEvent = Date.now();
function send(obj) { child.stdin.write(JSON.stringify(obj) + "\n"); }
function onNotify(msg) {
  console.log(`[notify] ${msg.split("\n")[0]}`);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].pred(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1); }
  }
}
const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  lastEvent = Date.now();
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === "extension_ui_request") {
    if (ev.method === "notify") onNotify(String(ev.message ?? ""));
    // Auto-answer interactive: confirm=true (accept dirty tree / no-verify).
    if (ev.method === "confirm") send({ type: "extension_ui_response", id: ev.id, result: true });
    if (ev.method === "select") send({ type: "extension_ui_response", id: ev.id, result: undefined });
    if (ev.method === "input") send({ type: "extension_ui_response", id: ev.id, result: "" });
  }
});
readline.createInterface({ input: child.stderr }).on("line", (l) => { if (/error|exception|panic/i.test(l)) console.log(`[stderr] ${l}`); });

function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const w = { pred, resolve }; waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout: ${label}`)); } }, timeoutMs);
  });
}
async function waitQuiet(ms, label) {
  console.log(`… 等待 ${label} 静默 ${ms}ms`);
  while (Date.now() - lastEvent < ms) await new Promise((r) => setTimeout(r, 500));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, extra = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name} ${extra}`); } }

async function main() {
  await sleep(2500);

  console.log("\n== 1) /wf new ==");
  send({ type: "prompt", message: `/wf new smoke ${repo}` });
  await waitFor((m) => m.includes("新需求") || m.includes("bd epic"), 30000, "new");

  console.log("\n== 2) 讨论需求(deepseek-pro)==");
  send({ type: "prompt", message: "需求:在目标 repo 里创建 src/mathx.js 导出 add(a,b) 和 mul(a,b) 两个纯函数,以及 test/mathx.test.js 用 node:assert 测试。最简实现,不引第三方依赖。" });
  await sleep(3000);
  await waitQuiet(6000, "讨论");

  console.log("\n== 3) /wf draft ==");
  send({ type: "prompt", message: "/wf draft" });
  await Promise.race([
    waitFor((m) => m.includes("计划已生成"), 300000, "draft-done"),
    waitFor((m) => m.includes("失败") && m.includes("PRD") === false, 300000, "draft-fail").then(() => { throw new Error("draft failed"); }),
  ]);

  // Verify bd state after draft: epic + task children exist.
  const epicQuery = spawnSync("bd", ["--dolt-auto-commit", "on", "-C", repo, "list", "--type", "epic", "--json"], { encoding: "utf8" });
  let epic = "";
  try { const e = JSON.parse(epicQuery.stdout); epic = e[0]?.id ?? ""; } catch {}
  check("draft created bd epic", !!epic, epicQuery.stdout);
  if (epic) {
    const kidQuery = spawnSync("bd", ["--dolt-auto-commit", "on", "-C", repo, "children", epic, "--json"], { encoding: "utf8" });
    let kidCount = 0;
    try { kidCount = JSON.parse(kidQuery.stdout).length; } catch {}
    check("draft created bd task children", kidCount > 0, `children=${kidCount}`);
  }

  console.log("\n== 4) /build ==");
  send({ type: "prompt", message: "/build" });
  const done = await waitFor((m) => m.includes("BUILD 完成") || m.includes("BUILD 中止"), 1500000, "build-done");
  console.log(`\n== build 结束:${done.split("\n")[0]} ==`);

  // Verify bd final state: tasks closed.
  if (epic) {
    const kidQuery2 = spawnSync("bd", ["--dolt-auto-commit", "on", "-C", repo, "children", epic, "--json"], { encoding: "utf8" });
    try {
      const kids = JSON.parse(kidQuery2.stdout);
      const closed = kids.filter((k) => k.status === "closed").length;
      check("all task children closed (if build succeeded)", done.includes("BUILD 完成") ? closed === kids.length : true,
        `closed=${closed}/${kids.length}`);
    } catch (e) { check("children parse", false, e.message); }
  }

  // Verify git: subtask commits merged into main.
  const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" }).stdout;
  const subtaskCommits = log.split("\n").filter((l) => l.includes("subtask "));
  check("subtask commits in git history", subtaskCommits.length > 0, JSON.stringify(subtaskCommits.length));

  // Verify code actually written.
  check("src/mathx.js exists", fs.existsSync(path.join(repo, "src", "mathx.js")));

  await sleep(1500);
  send({ type: "abort" });
  child.kill("SIGTERM");
  await sleep(500);

  console.log(fail === 0 ? `\nSMOKE ALL PASS (${pass})` : `\n${fail} SMOKE FAILED, ${pass} passed`);
  // Clean up target repo.
  fs.rmSync(targetDir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e);
  child.kill("SIGTERM");
  fs.rmSync(targetDir, { recursive: true, force: true });
  process.exit(1);
});
