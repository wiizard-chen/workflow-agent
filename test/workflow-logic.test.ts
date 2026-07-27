/**
 * Unit tests for the v4 (manager-driven, bd-backed) pipeline's testable core
 * logic — no live LLM, no real bd binary. Five areas:
 *
 * 1. bd.ts: BdExec injection — verifies claim/close/reopen/comment/create
 *    build the exact argv bd 1.1.0 expects (see bd.ts's own design notes).
 * 2. extractSubtasksJson (workflow.ts): pure JSON validation/error paths.
 * 3. lib.ts: runVerify's P0 gate semantics (pass/fail/empty-command) and
 *    commitArtifacts/gitHead against a real temp git repo (mirrors the
 *    pattern the deprecated test/build.test.ts used before the v1 pipeline
 *    was removed).
 * 4. Regression guard: build-mode tool whitelist uses the real
 *    nicobailon/pi-subagents tool name `subagent`, not the incorrect
 *    `delegate` this project's docs/prompts used before the mismatch fix.
 * 5. Regression guard: PLAN-mode readonly lock whitelists nicobailon/
 *    pi-web-access's tools by name, alongside the existing MCP-prefix
 *    detection used for playwright-mcp (the two are complementary, not
 *    competing — see README.md's "PLAN 阶段联网" section).
 *
 * Run: node --experimental-strip-types test/workflow-logic.test.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  claim,
  close,
  comment,
  create,
  depAdd,
  reopen,
  type BdExec,
  type BdExecResult,
} from "../extensions/bd.ts";
import { extractSubtasksJson } from "../extensions/workflow.ts";
import {
  commitArtifacts,
  gitHead,
  runVerify,
  saveState,
  type WorkflowConfig,
  type WorkflowState,
} from "../extensions/lib.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name} ${extra}`); failures++; }
}

function sh(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// ===========================================================================
// 1. bd.ts — BdExec argv correctness (claim/close/reopen/comment/create)
// ===========================================================================

console.log("bd.ts — BdExec argv correctness:");

{
  const calls: { repo: string; args: string[] }[] = [];
  const fakeExec: BdExec = (repo, args): BdExecResult => {
    calls.push({ repo, args });
    return { code: 0, stdout: "", stderr: "" };
  };

  const ok = claim("/repo", "bd-1", "manager-req-1", fakeExec);
  check("claim() returns true on exit code 0", ok === true);
  check(
    "claim() calls bd update --claim --assignee <agent>",
    calls.length === 1 &&
      calls[0].args[0] === "update" &&
      calls[0].args[1] === "bd-1" &&
      calls[0].args.includes("--claim") &&
      calls[0].args.includes("--assignee") &&
      calls[0].args[calls[0].args.indexOf("--assignee") + 1] === "manager-req-1",
    JSON.stringify(calls[0]?.args),
  );
}

{
  const calls: string[][] = [];
  const fakeExec: BdExec = (_repo, args): BdExecResult => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };

  close("/repo", "bd-2", "all good", fakeExec);
  check(
    "close() calls bd close <id> --reason <text>",
    calls.length === 1 && calls[0][0] === "close" && calls[0][1] === "bd-2" &&
      calls[0].includes("--reason") && calls[0][calls[0].indexOf("--reason") + 1] === "all good",
    JSON.stringify(calls[0]),
  );
}

{
  const calls: string[][] = [];
  const fakeExec: BdExec = (_repo, args): BdExecResult => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
  close("/repo", "bd-3", undefined, fakeExec);
  check(
    "close() without reason omits --reason",
    calls.length === 1 && calls[0][0] === "close" && calls[0][1] === "bd-3" && !calls[0].includes("--reason"),
    JSON.stringify(calls[0]),
  );
}

{
  const calls: string[][] = [];
  const fakeExec: BdExec = (_repo, args): BdExecResult => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
  reopen("/repo", "bd-4", fakeExec);
  check(
    "reopen() calls bd reopen <id>",
    calls.length === 1 && calls[0][0] === "reopen" && calls[0][1] === "bd-4",
    JSON.stringify(calls[0]),
  );
}

{
  const calls: string[][] = [];
  const fakeExec: BdExec = (_repo, args): BdExecResult => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
  comment("/repo", "bd-5", "baseline=abc123", fakeExec);
  check(
    "comment() calls bd comment <id> <text> (singular, matches verified bd 1.1.0)",
    calls.length === 1 && calls[0][0] === "comment" && calls[0][1] === "bd-5" && calls[0][2] === "baseline=abc123",
    JSON.stringify(calls[0]),
  );
}

{
  const calls: string[][] = [];
  const fakeExec: BdExec = (_repo, args): BdExecResult => { calls.push(args); return { code: 0, stdout: JSON.stringify({ id: "bd-99" }), stderr: "" }; };
  const id = create("/repo", { title: "fix bug", type: "bug", parent: "bd-epic-1", notes: "spec here" }, fakeExec);
  check("create() returns the id from bd's JSON response", id === "bd-99", id);
  check(
    "create() passes --type/--parent/--notes/--json",
    calls[0].includes("--type") && calls[0][calls[0].indexOf("--type") + 1] === "bug" &&
      calls[0].includes("--parent") && calls[0][calls[0].indexOf("--parent") + 1] === "bd-epic-1" &&
      calls[0].includes("--notes") && calls[0].includes("--json"),
    JSON.stringify(calls[0]),
  );
}

{
  // Failure path: claim() must return false (not throw) when bd exits non-zero
  // (e.g. issue already claimed by someone else) — the manager relies on this
  // to move to the next ready task instead of crashing the tool call.
  const fakeExec: BdExec = (): BdExecResult => ({ code: 1, stdout: "", stderr: "already claimed" });
  const ok = claim("/repo", "bd-6", "manager-req-1", fakeExec);
  check("claim() returns false (not throw) on non-zero exit", ok === false);
}

{
  // depAdd argument order: `bd dep add <dependent> <dependency> --type <type>`
  const calls: string[][] = [];
  const fakeExec: BdExec = (_repo, args): BdExecResult => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
  depAdd("/repo", "bd-child", "bd-parent-blocker", "blocks", fakeExec);
  check(
    "depAdd() preserves dependent-then-dependency argument order",
    calls[0][0] === "dep" && calls[0][1] === "add" && calls[0][2] === "bd-child" && calls[0][3] === "bd-parent-blocker",
    JSON.stringify(calls[0]),
  );
}

// ===========================================================================
// 2. extractSubtasksJson — pure JSON validation/error paths
// ===========================================================================

console.log("\nextractSubtasksJson — validation/error paths:");

{
  const good = JSON.stringify({ subtasks: [{ id: "01", title: "A", depends_on: [], spec: "do A" }] });
  const parsed = extractSubtasksJson(good);
  check("parses a well-formed subtasks JSON", parsed.subtasks.length === 1 && parsed.subtasks[0].title === "A");
}

{
  const fenced = "```json\n" + JSON.stringify({ subtasks: [{ title: "B", spec: "do B" }] }) + "\n```";
  const parsed = extractSubtasksJson(fenced);
  check("strips markdown code fences before parsing", parsed.subtasks.length === 1 && parsed.subtasks[0].title === "B");
}

{
  const withPreamble = 'Here is the plan:\n' + JSON.stringify({ subtasks: [{ title: "C", spec: "do C" }] }) + '\nDone.';
  const parsed = extractSubtasksJson(withPreamble);
  check("recovers JSON object embedded in surrounding prose", parsed.subtasks.length === 1 && parsed.subtasks[0].title === "C");
}

{
  let threw = false;
  try { extractSubtasksJson("not json at all, no braces"); } catch (_e) { threw = true; }
  check("throws on completely unparseable text", threw);
}

{
  let threw = false;
  let msg = "";
  try { extractSubtasksJson(JSON.stringify({ notSubtasks: [] })); } catch (e) { threw = true; msg = (e as Error).message; }
  check("throws when subtasks array is missing", threw && /subtasks/i.test(msg), msg);
}

{
  let threw = false;
  try { extractSubtasksJson(JSON.stringify({ subtasks: [] })); } catch (_e) { threw = true; }
  check("throws when subtasks array is empty", threw);
}

{
  let threw = false;
  let msg = "";
  try { extractSubtasksJson(JSON.stringify({ subtasks: [{ spec: "no title" }] })); } catch (e) { threw = true; msg = (e as Error).message; }
  check("throws when a subtask is missing title", threw && /title/i.test(msg), msg);
}

{
  let threw = false;
  let msg = "";
  try { extractSubtasksJson(JSON.stringify({ subtasks: [{ title: "no spec" }] })); } catch (e) { threw = true; msg = (e as Error).message; }
  check("throws when a subtask is missing spec", threw && /spec/i.test(msg), msg);
}

// ===========================================================================
// 3. lib.ts — runVerify P0 gate + commitArtifacts/gitHead (real temp git repo)
// ===========================================================================

console.log("\nlib.ts — runVerify P0 gate + git helpers (real temp repo):");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-logic-test-"));
try {
  sh("git", ["init", "-q"], tmpRoot);
  sh("git", ["config", "user.email", "t@example.com"], tmpRoot);
  sh("git", ["config", "user.name", "Test"], tmpRoot);
  fs.writeFileSync(path.join(tmpRoot, "README.md"), "hello\n");
  sh("git", ["add", "-A"], tmpRoot);
  sh("git", ["commit", "-q", "-m", "init"], tmpRoot);

  const CONFIG: WorkflowConfig = {
    providers: {},
    roles: {
      discuss: { provider: "deepseek", model: "deepseek-v4-pro" },
      prd: { provider: "zai", model: "glm-5.2" },
      split: { provider: "deepseek", model: "deepseek-v4-pro" },
      review: { provider: "zai", model: "glm-5.2" },
    },
    build: { verifyCommand: "", commitPrefix: "subtask" },
  };

  const baseState: WorkflowState = {
    reqId: "req-1", name: "test req", repo: tmpRoot, mode: "build",
    createdAt: new Date().toISOString(), epicId: "bd-epic-1", subtaskIds: [],
  };

  {
    const s: WorkflowState = { ...baseState, verifyCommand: "" };
    const v = runVerify(CONFIG, s, false);
    check("runVerify: empty command + allowEmptyVerify=false => HARD FAIL (P0 gate)", v.ok === false, v.output);
  }

  {
    const s: WorkflowState = { ...baseState, verifyCommand: "" };
    const v = runVerify(CONFIG, s, true);
    check("runVerify: empty command + allowEmptyVerify=true => explicit pass", v.ok === true, v.output);
  }

  {
    const s: WorkflowState = { ...baseState, verifyCommand: "exit 0" };
    const v = runVerify(CONFIG, s, false);
    check("runVerify: verify command exits 0 => pass", v.ok === true, v.output);
  }

  {
    const s: WorkflowState = { ...baseState, verifyCommand: "exit 1" };
    const v = runVerify(CONFIG, s, false);
    check("runVerify: verify command exits nonzero => fail (this is bd_task(close)'s new recheck gate)", v.ok === false, v.output);
  }

  {
    const s: WorkflowState = { ...baseState };
    const before = gitHead(tmpRoot);
    check("gitHead() returns a real 40-char sha for HEAD", !!before && /^[0-9a-f]{40}$/.test(before!), before);
    saveState(s);
    const art = commitArtifacts(s);
    check("commitArtifacts() commits when .workflow/<reqId>/ has untracked content", art.committed === true, JSON.stringify(art));
    const after = gitHead(tmpRoot);
    check("commitArtifacts() advances HEAD", after !== before, `${before} -> ${after}`);
    const art2 = commitArtifacts(s);
    check("commitArtifacts() is a no-op (nothing to commit) on second call", art2.committed === false, JSON.stringify(art2));
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ===========================================================================

// ===========================================================================
// 4. Regression guard: build-mode tool whitelist must reference the real
//    nicobailon/pi-subagents tool name `subagent`, not `delegate` (the wrong
//    name this project's docs/prompts used before the tool-name mismatch was
//    fixed — see extensions/workflow.ts's top-of-file comment for context).
// ===========================================================================

console.log("\nregression guard — build-mode tool whitelist uses the real tool name:");

{
  const src = fs.readFileSync(new URL("../extensions/workflow.ts", import.meta.url), "utf8");
  const activeToolsBlock = src.match(/pi\.setActiveTools\(\[\s*"split_prd_to_tasks"[\s\S]*?\]\)/);
  check("applyModeTools()'s build-mode whitelist block exists", !!activeToolsBlock);
  if (activeToolsBlock) {
    check('build-mode whitelist includes "subagent"', activeToolsBlock[0].includes('"subagent"'), activeToolsBlock[0]);
    check('build-mode whitelist does NOT include "delegate" (wrong tool name)', !activeToolsBlock[0].includes('"delegate"'), activeToolsBlock[0]);
  }
}

// ===========================================================================
// 5. Regression guard: PLAN-mode readonly lock must whitelist pi-web-access's
//    tools by name (web_search/fetch_content/get_search_content/source_check),
//    on top of the existing MCP-prefix detection for playwright-mcp. The two
//    packages are complementary (playwright-mcp: live-browser frontend
//    debugging; pi-web-access: PLAN-stage research/fetch) and both must stay
//    reachable from PLAN mode's readonly lock.
// ===========================================================================

console.log("\nregression guard — lockReadonly() wires up pi-web-access tool names:");

{
  const src = fs.readFileSync(new URL("../extensions/workflow.ts", import.meta.url), "utf8");
  const lockReadonlyBlock = src.match(/function lockReadonly\([\s\S]*?\n}/);
  check("lockReadonly() function exists", !!lockReadonlyBlock);
  const webAccessConst = src.match(/const WEB_ACCESS_TOOLS = \[[^\]]*\]/);
  check("WEB_ACCESS_TOOLS constant is defined", !!webAccessConst, webAccessConst?.[0]);
  if (webAccessConst) {
    for (const tool of ["web_search", "fetch_content", "get_search_content", "source_check"]) {
      check(`WEB_ACCESS_TOOLS includes "${tool}"`, webAccessConst[0].includes(`"${tool}"`), webAccessConst[0]);
    }
  }
  if (lockReadonlyBlock) {
    check("lockReadonly() references WEB_ACCESS_TOOLS", lockReadonlyBlock[0].includes("WEB_ACCESS_TOOLS"), lockReadonlyBlock[0]);
    check("lockReadonly() still keeps the MCP-prefix detection for playwright-mcp", lockReadonlyBlock[0].includes("mcpServerNames"), lockReadonlyBlock[0]);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
