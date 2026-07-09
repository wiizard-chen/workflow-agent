// Live smoke driver for the workflow extension over pi RPC.
// Usage: node test/smoke.mjs <targetRepoAbsPath>
// Requires DEEPSEEK_API_KEY + GLM_API_KEY in env (run under `zsh -ic`).

import { spawn } from "node:child_process";
import * as readline from "node:readline";

const repo = process.argv[2];
if (!repo) { console.error("need repo path"); process.exit(2); }

const child = spawn("pi", ["-e", "./extensions/workflow.ts", "--mode", "rpc", "--model", "deepseek/deepseek-v4-pro"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

const notifies = [];
let lastEvent = Date.now();
const waiters = []; // {pred, resolve}

function send(obj) { child.stdin.write(JSON.stringify(obj) + "\n"); }

function onNotify(msg) {
  notifies.push(msg);
  const head = msg.split("\n")[0];
  console.log(`[notify] ${head}`);
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
    // Auto-answer interactive requests so we never hang.
    if (ev.method === "confirm") send({ type: "extension_ui_response", id: ev.id, result: true });
    if (ev.method === "select") send({ type: "extension_ui_response", id: ev.id, result: undefined });
    if (ev.method === "input") send({ type: "extension_ui_response", id: ev.id, result: "" });
  }
});
readline.createInterface({ input: child.stderr }).on("line", (l) => { if (/error|exception/i.test(l)) console.log(`[stderr] ${l}`); });

function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout waiting for ${label}`)); }
    }, timeoutMs);
  });
}
async function waitQuiet(ms, label) {
  console.log(`… 等待 ${label} 静默 ${ms}ms`);
  while (Date.now() - lastEvent < ms) await new Promise((r) => setTimeout(r, 500));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await sleep(2500); // let pi boot

  console.log("\n== 1) /wf new ==");
  send({ type: "prompt", message: `/wf new smoke ${repo}` });
  await waitFor((m) => m.includes("新需求"), 30000, "new");

  console.log("\n== 2) 讨论需求(deepseek-pro)==");
  send({ type: "prompt", message: "需求:在目标 repo 里创建一个 JS 模块 src/mathx.js,导出 add(a,b) 与 mul(a,b) 两个纯函数;再创建 test/mathx.test.js 用 node:assert 断言这两个函数。保持最简可用即可,不要引入任何第三方依赖。" });
  await sleep(3000);
  await waitQuiet(6000, "讨论回合");

  console.log("\n== 3) /wf draft ==");
  send({ type: "prompt", message: "/wf draft" });
  await Promise.race([
    waitFor((m) => m.includes("计划已生成"), 300000, "draft-done"),
    waitFor((m) => m.includes("未生成") || m.includes("为空"), 300000, "draft-fail").then(() => { throw new Error("draft failed"); }),
  ]);

  console.log("\n== 4) /build ==");
  send({ type: "prompt", message: "/build" });
  const done = await waitFor((m) => m.includes("BUILD 完成") || m.includes("BUILD 中止"), 1500000, "build-done");
  console.log(`\n== build 结束:${done.split("\n")[0]} ==`);

  await sleep(1500);
  send({ type: "abort" });
  child.kill("SIGTERM");
  await sleep(500);
  process.exit(0);
}

main().catch((e) => { console.error("SMOKE FAIL:", e.message); child.kill("SIGTERM"); process.exit(1); });
