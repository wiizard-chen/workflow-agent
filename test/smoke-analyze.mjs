// Live smoke for /wf analyze: new -> analyze -> draft (should skip auto-analyze,
// brief already exists) -> print notifies. No build (keep this cheap).
import { spawn } from "node:child_process";
import * as readline from "node:readline";

const repo = process.argv[2];
if (!repo) { console.error("need repo path"); process.exit(2); }

const child = spawn("pi", ["-e", "./extensions/workflow.ts", "--mode", "rpc", "--model", "deepseek/deepseek-v4-pro"], {
  cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"],
});
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notifies = [];
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let ev; try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === "extension_ui_request" && ev.method === "notify") {
    notifies.push(String(ev.message ?? ""));
    console.log(`[notify] ${String(ev.message).split("\n")[0]}`);
  }
});
readline.createInterface({ input: child.stderr }).on("line", (l) => { if (/error|exception/i.test(l)) console.log(`[stderr] ${l}`); });

(async () => {
  await sleep(2500);
  send({ type: "prompt", message: `/wf new smoke-analyze ${repo}` });
  await sleep(4000);
  console.log("\n== /wf analyze ==");
  send({ type: "prompt", message: "/wf analyze" });
  // wait for the "仓库简报已生成" notify
  const start = Date.now();
  while (Date.now() - start < 180000 && !notifies.some((m) => m.includes("仓库简报已生成"))) await sleep(500);

  console.log("\n== /wf analyze again (should say already exists) ==");
  send({ type: "prompt", message: "/wf analyze" });
  await sleep(3000);

  console.log("\n== /wf draft (brief already exists -> should NOT re-analyze) ==");
  send({ type: "prompt", message: "需求:给这个仓库加一句话说明(仅测试用,不真的执行到底)。" });
  await sleep(3000);
  send({ type: "prompt", message: "/wf draft" });
  await sleep(6000); // just enough to see whether it announces auto-analyze or not

  child.kill("SIGTERM");
  await sleep(300);
  process.exit(0);
})();
