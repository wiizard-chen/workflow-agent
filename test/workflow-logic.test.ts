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
  list as listIssues,
  reopen,
  type BdExec,
  type BdExecResult,
} from "../extensions/bd.ts";
import { ensureRequirementDirs, extractSubtasksJson, preservedBaseline, registerManagerTools, renderedToolName, splitDecision } from "../extensions/workflow.ts";
import {
  activeModelProfile, advisoryOutputPath, assertActiveProfileModelsAvailable,
  configuredActiveProfileName, currentWorkflow, loadConfig, loadPlanInterrogationPrompt, setWorkflow, suggestedVerifyCommandRisk, useRole,
  validateSubagentCall, withPlanInterrogationSystemPrompt, workflowAgentEffort, workflowAgentModel,
} from "../extensions/workflow/runtime.ts";
import { PLAN_ADVISORY_TOOLS, syncSubagentCapabilityCeiling } from "../extensions/workflow/capabilities.ts";
import { persistReviewerFeedback, reviewerRetryDecision } from "../extensions/workflow/tools/beads.ts";
import { confirmAndSaveSuggestedVerifyCommand } from "../extensions/workflow/commands/plan.ts";
import {
  addUsage,
  buildRunSummary,
  cacheHitRate,
  commitArtifacts,
  emptyUsageTotals,
  formatUsageLine,
  gitHead,
  isCommitIntegrated,
  validateIntegratedCommitRange,
  readRunSummary,
  runVerify,
  saveState,
  writeRunSummary,
  type WorkflowConfig,
  type WorkflowState,
} from "../extensions/lib.ts";

function workflowSource(): string {
  return [
    "runtime.ts", "capabilities.ts",
    "commands/plan.ts", "commands/lifecycle.ts", "commands/issues.ts", "commands/build.ts",
    "tools/split.ts", "tools/beads.ts", "tools/verification.ts",
    "manager-tools.ts", "index.ts",
  ]
    .map((file) => fs.readFileSync(new URL(`../extensions/workflow/${file}`, import.meta.url), "utf8"))
    .join("\n");
}

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
    "reopen() reopens and clears stale assignee for a retry",
    calls.length === 2
      && calls[0][0] === "reopen" && calls[0][1] === "bd-4"
      && JSON.stringify(calls[1]) === JSON.stringify(["update", "bd-4", "--assignee", ""]),
    JSON.stringify(calls),
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

{
  const calls: string[][] = [];
  const fakeExec: BdExec = (_repo, args): BdExecResult => {
    calls.push(args);
    return { code: 0, stdout: "[]", stderr: "" };
  };
  listIssues("/repo", { type: "epic", all: true, limit: 0 }, fakeExec);
  check(
    "list({all:true,limit:0}) passes --all/--limit 0 so resume includes every epic",
    calls[0].includes("--all") && calls[0][calls[0].indexOf("--limit") + 1] === "0" && calls[0].includes("--type") && calls[0].includes("epic"),
    JSON.stringify(calls[0]),
  );
}

// ===========================================================================
// 2. Behavioral helpers for runtime evidence/state decisions
// ===========================================================================

console.log("\nworkflow runtime helpers:");
check("renderedToolName parses pi-subagents 0.37 {text,expandedText} shape", renderedToolName({ text: "read /tmp/a" }) === "read");
check("renderedToolName maps pi-subagents shell '$ ' summary to bash", renderedToolName({ text: "$ npm test" }) === "bash");
check("renderedToolName still accepts named shape", renderedToolName({ toolName: "bash" }) === "bash");
check("preservedBaseline keeps original resume baseline", preservedBaseline("old-sha", "new-sha") === "old-sha");
check("preservedBaseline initializes a new run", preservedBaseline(undefined, "new-sha") === "new-sha");
check("splitDecision creates only with no tasks/manifest", splitDecision([], undefined, "hash") === "create");
check("splitDecision reuses matching complete manifest", splitDecision(["a", "b"], { status: "complete", prdSha256: "hash", created: [{ id: "b" }, { id: "a" }] }, "hash") === "reuse");
check("splitDecision rejects partial split", splitDecision(["a"], { status: "failed", prdSha256: "hash", created: [{ id: "a" }] }, "hash") === "reject");
check("splitDecision rejects complete manifest with missing task", splitDecision(["a"], { status: "complete", prdSha256: "hash", created: [{ id: "a" }, { id: "b" }] }, "hash") === "reject");
check("splitDecision rejects complete manifest with missing Beads tasks", splitDecision([], { status: "complete", prdSha256: "hash", created: [{ id: "a" }] }, "hash") === "reject");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dirs-"));
  try {
    ensureRequirementDirs({ reqId: "external", name: "x", repo: root, mode: "plan", createdAt: "now", epicId: "e", subtaskIds: [] });
    check("ensureRequirementDirs initializes external PRD results/subtasks", fs.existsSync(path.join(root, ".workflow", "external", "results")) && fs.existsSync(path.join(root, ".workflow", "external", "subtasks")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
{
  const planState: WorkflowState = { reqId: "plan", name: "x", repo: "/tmp", mode: "plan", createdAt: "now" };
  const buildState: WorkflowState = { ...planState, mode: "build" };
  const skillPrompt = loadPlanInterrogationPrompt();
  const injected = withPlanInterrogationSystemPrompt("BASE", planState, skillPrompt);
  check("PLAN main system prompt auto-loads full plan-interrogation", injected.includes("<pi-workflow-plan-interrogation>") && injected.includes("一次只问一个问题") && injected.includes("能查证的先查证"));
  check("ordinary Pi does not receive plan-interrogation", withPlanInterrogationSystemPrompt("BASE", undefined, skillPrompt) === "BASE");
  check("BUILD does not receive plan-interrogation", withPlanInterrogationSystemPrompt("BASE", buildState, skillPrompt) === "BASE");
  check("PLAN injection is idempotent", withPlanInterrogationSystemPrompt(injected, planState, skillPrompt) === injected);
}

console.log("\nmodel profile availability guard:");
{
  const profile = activeModelProfile(loadConfig());
  const models = Object.values(profile)
    .map((entry) => { const [provider, ...rest] = entry.model.split("/"); return { provider, id: rest.join("/") }; });
  const find = (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id);
  let rejected = false;
  try {
    await assertActiveProfileModelsAvailable({ modelRegistry: { find, getAvailable: async () => [] } } as any);
  } catch { rejected = true; }
  check("registered but unauthenticated/unavailable profile model is rejected", rejected);
  let accepted = true;
  try {
    await assertActiveProfileModelsAvailable({ modelRegistry: { find, getAvailable: async () => models } } as any);
  } catch { accepted = false; }
  check("fully available active profile is accepted", accepted);

  let selectedEffort = "off";
  const fakeCtx = { model: undefined as any, modelRegistry: { find: () => ({ provider: "codex2api", id: "gpt-5.6-sol" }) }, ui: { notify: () => {} } } as any;
  const fakePi = {
    setModel: async (model: any) => { fakeCtx.model = model; return true; },
    setThinkingLevel: (effort: string) => { selectedEffort = effort; },
    getThinkingLevel: () => selectedEffort,
  } as any;
  check("main role applies configured xhigh effort", await useRole(fakePi, fakeCtx, { provider: "codex2api", model: "gpt-5.6-sol", effort: "xhigh" }) && selectedEffort === "xhigh");
  const wrongModelCtx = { ...fakeCtx, model: { provider: "other", id: "wrong" } } as any;
  const wrongModelPi = { ...fakePi, setModel: async () => true } as any;
  check("main role fails closed when resolved model drifts", !(await useRole(wrongModelPi, wrongModelCtx, { provider: "codex2api", model: "gpt-5.6-sol", effort: "xhigh" })));
  const clampedPi = { ...fakePi, getThinkingLevel: () => "high" } as any;
  check("main role fails closed when effort is clamped", !(await useRole(clampedPi, fakeCtx, { provider: "codex2api", model: "gpt-5.6-sol", effort: "xhigh" })));
}

console.log("\nPLAN builtin advisory capability guard:");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wf-advisory-"));
  const state: WorkflowState = { reqId: "req", name: "x", repo, mode: "plan", createdAt: "now", epicId: "e", subtaskIds: [] };
  try {
    const sessionId = "wf-advisory-capability-test";
    const ceilingCtx = { sessionManager: { getSessionId: () => sessionId } };
    syncSubagentCapabilityCeiling(ceilingCtx, "plan");
    const registry = (globalThis as any)[Symbol.for("pi-subagents.capability-ceiling.v1")] as Map<string, Map<symbol, any>>;
    const registration = [...(registry.get(sessionId)?.values() || [])][0]?.ceiling;
    check("PLAN capability ceiling is registered out-of-band", registration?.sources?.includes("pi-workflow-plan"));
    check("PLAN capability ceiling removes bash/write/edit", !PLAN_ADVISORY_TOOLS.some((tool) => ["bash", "write", "edit"].includes(tool)));
    check("PLAN capability ceiling preserves researcher web tools", PLAN_ADVISORY_TOOLS.includes("web_search"));
    setWorkflow(state);
    check("runtime accessor returns the latest workflow instead of a Jiti-stale named export", currentWorkflow() === state);
    ensureRequirementDirs(state);
    const call = (agent: string, context: string, output: string, model?: string, thinking?: string) => validateSubagentCall({
      toolCallId: "advisory-test",
      input: { agent, context, cwd: state.repo, output, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) },
    });
    check("researcher exact fresh/output call is allowed", call("researcher", "fresh", advisoryOutputPath("researcher")) === undefined);
    check("scout exact fresh/output call is allowed", call("scout", "fresh", advisoryOutputPath("scout")) === undefined);
    check("oracle exact fork/output call is allowed", call("oracle", "fork", advisoryOutputPath("oracle")) === undefined);
    check("advisory wrong context is rejected", /context=fresh/.test(call("researcher", "fork", advisoryOutputPath("researcher")) || ""));
    check("advisory wrong output is rejected", /output 路径错误/.test(call("scout", "fresh", path.join(repo, "wrong.md")) || ""));
    const prdOutput = path.join(repo, ".workflow", "req", "prd.md");
    const prdModel = workflowAgentModel("pi-workflow.prd-writer");
    const prdEffort = workflowAgentEffort("pi-workflow.prd-writer");
    check("PRD writer exact active-profile model/effort is allowed", call("pi-workflow.prd-writer", "fork", prdOutput, prdModel, prdEffort) === undefined);
    check("PRD writer model drift is rejected", /active profile 配置/.test(call("pi-workflow.prd-writer", "fork", prdOutput, "zai/glm-5.2", prdEffort) || ""));
    check("PRD writer effort drift is rejected", /effort 必须/.test(call("pi-workflow.prd-writer", "fork", prdOutput, prdModel, "low") || ""));
    fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { researcher: { model: "test/model", thinking: "low" } } } }));
    check("model/thinking-only builtin override remains allowed", call("researcher", "fresh", advisoryOutputPath("researcher")) === undefined);
    fs.writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { researcher: { tools: ["bash"] } } } }));
    check("capability-changing builtin override is rejected", /不安全 settings override/.test(call("researcher", "fresh", advisoryOutputPath("researcher")) || ""));
    fs.rmSync(path.join(repo, ".pi", "settings.json"), { force: true });
    const nestedRepo = path.join(repo, "packages", "target");
    fs.mkdirSync(nestedRepo, { recursive: true });
    state.repo = nestedRepo;
    fs.writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({ subagents: { defaultExtensions: ["unsafe-extension"] } }));
    check("nearest ancestor defaultExtensions is rejected", /禁止 subagents.defaultExtensions/.test(call("scout", "fresh", advisoryOutputPath("scout")) || ""));
    fs.rmSync(path.join(repo, ".pi", "settings.json"), { force: true });
    state.repo = repo;
    state.mode = "build";
    const orphanSession = new Map<symbol, any>();
    orphanSession.set(Symbol("stale-plan-ceiling"), {
      source: "pi-workflow-plan",
      ceiling: { version: 1, allowedTools: ["read"], denyExtensions: false, sources: ["pi-workflow-plan"] },
    });
    registry.set("session-from-before-reload", orphanSession);
    syncSubagentCapabilityCeiling(ceilingCtx, "build");
    const stalePlanCeilings = [...registry.values()].flatMap((session) => [...session.values()])
      .filter((entry) => entry.source === "pi-workflow-plan" || entry.ceiling?.sources?.includes("pi-workflow-plan"));
    check("BUILD removes orphaned PLAN ceilings left by /reload", stalePlanCeilings.length === 0);
    check("builtin advisory agents cannot enter BUILD", /build 模式只允许/.test(call("oracle", "fresh", path.join(repo, ".workflow", "req", "results", "x.md")) || ""));
    fs.writeFileSync(path.join(repo, ".workflow", "req", "results", "verify.json"), "{}\n");
    const finalOutput = path.join(repo, ".workflow", "req", "results", "final-review.json");
    const finalModel = workflowAgentModel("pi-workflow.final-reviewer");
    const finalEffort = workflowAgentEffort("pi-workflow.final-reviewer");
    check("final reviewer exact active-profile model/effort is allowed", call("pi-workflow.final-reviewer", "fresh", finalOutput, finalModel, finalEffort) === undefined);
    check("final reviewer model drift is rejected", /active profile 配置/.test(call("pi-workflow.final-reviewer", "fresh", finalOutput, "zai/glm-5.2", finalEffort) || ""));
    check("final reviewer effort drift is rejected", /effort 必须/.test(call("pi-workflow.final-reviewer", "fresh", finalOutput, finalModel, "low") || ""));
  } finally {
    syncSubagentCapabilityCeiling({ sessionManager: { getSessionId: () => "wf-advisory-capability-test" } }, undefined);
    setWorkflow(undefined);
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

console.log("\nAI verify command safety:");
{
  check("normal chained quality gates are accepted", suggestedVerifyCommandRisk("npm test && npx tsc --noEmit && npm run build") === undefined);
  check("AI verify suggestion rejects destructive commands", /写入、网络/.test(suggestedVerifyCommandRisk("rm -rf . && npm test") || ""));
  check("AI verify suggestion rejects failure-masking shell operators", /shell 控制符/.test(suggestedVerifyCommandRisk("npm test || true") || ""));
  check("AI verify suggestion must contain a recognizable quality gate", /未包含可识别/.test(suggestedVerifyCommandRisk("node scripts/report.js") || ""));
}

console.log("\nAI verify command confirmation:");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ai-verify-"));
  const state: WorkflowState = { reqId: "req", name: "x", repo, mode: "plan", createdAt: "now", epicId: "e", subtaskIds: [] };
  try {
    ensureRequirementDirs(state);
    setWorkflow(state);
    let confirms = 0;
    const ctx = { ui: {
      confirm: async () => { confirms++; return true; },
      notify: () => {},
    } } as any;
    const accepted = await confirmAndSaveSuggestedVerifyCommand(ctx, "npm test && npx tsc --noEmit", "test-scout");
    const audit = JSON.parse(fs.readFileSync(path.join(repo, ".workflow", "req", "results", "verify-command-suggestion.json"), "utf8"));
    check("confirmed AI verify command is written directly to workflow state", accepted && state.verifyCommand === "npm test && npx tsc --noEmit");
    check("AI verify confirmation writes provenance", audit.status === "accepted" && audit.source === "test-scout" && confirms === 1);
    const rejected = await confirmAndSaveSuggestedVerifyCommand(ctx, "rm -rf . && npm test", "unsafe-scout");
    check("unsafe AI verify command is rejected before user confirmation", rejected === false && confirms === 1 && state.verifyCommand === "npm test && npx tsc --noEmit");
  } finally {
    setWorkflow(undefined);
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

console.log("\nreviewer retry feedback persistence:");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wf-review-feedback-"));
  const state: WorkflowState = { reqId: "req", name: "x", repo, mode: "build", createdAt: "now", epicId: "e", subtaskIds: ["e.1"] };
  try {
    const results = path.join(repo, ".workflow", "req", "results");
    fs.mkdirSync(results, { recursive: true });
    fs.writeFileSync(path.join(results, "e.1.review.json"), JSON.stringify({
      taskId: "e.1", baseline: "base", commitSha: "commit-1", verdict: "fail",
      issues: [{ severity: "major", desc: "fix me" }], summary: "failed review",
    }));
    const feedbackPath = persistReviewerFeedback(state, "e.1");
    const feedback = JSON.parse(fs.readFileSync(feedbackPath!, "utf8"));
    check("reviewer fail is preserved as non-authoritative retry context", feedback.authoritative === false && feedback.reviews.length === 1);
    persistReviewerFeedback(state, "e.1");
    const deduped = JSON.parse(fs.readFileSync(feedbackPath!, "utf8"));
    check("identical reviewer feedback is not duplicated", deduped.reviews.length === 1);
    fs.writeFileSync(path.join(results, "e.1.review.json"), JSON.stringify({
      taskId: "e.1", baseline: "base", commitSha: "commit-2", verdict: "fail",
      issues: [{ severity: "major", desc: "fix another" }], summary: "failed again",
    }));
    persistReviewerFeedback(state, "e.1");
    const accumulated = JSON.parse(fs.readFileSync(feedbackPath!, "utf8"));
    check("later reviewer failures accumulate for the next fresh dev", accumulated.reviews.length === 2);
    const distinctDecision = reviewerRetryDecision(accumulated, 3, 2);
    check("manager may auto-fix distinct actionable reviews within budget", distinctDecision.autoRetryAllowed === true && distinctDecision.failedReviews === 2);
    accumulated.reviews.push({ ...accumulated.reviews.at(-1) });
    const repeatedDecision = reviewerRetryDecision(accumulated, 3, 2);
    check("identical consecutive issue sets stop the automatic loop", repeatedDecision.autoRetryAllowed === false && repeatedDecision.reason === "same-issues-repeated");
    const budgetDecision = reviewerRetryDecision({ reviews: [
      { issues: [{ desc: "a" }] }, { issues: [{ desc: "b" }] },
      { issues: [{ desc: "c" }] }, { issues: [{ desc: "d" }] },
    ] }, 3, 2);
    check("automatic reviewer repair stops after configured budget", budgetDecision.autoRetryAllowed === false && budgetDecision.reason === "auto-fix-budget-exhausted");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

// ===========================================================================
// 3. extractSubtasksJson — pure JSON validation/error paths
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
    const v = runVerify(CONFIG, s);
    check("runVerify: empty command always HARD FAIL", v.ok === false && v.code === -1, v.output);
  }

  {
    const s: WorkflowState = { ...baseState, verifyCommand: "exit 0" };
    const v = runVerify(CONFIG, s);
    check("runVerify: verify command exits 0 => pass", v.ok === true, v.output);
  }

  {
    const s: WorkflowState = { ...baseState, verifyCommand: "exit 1" };
    const v = runVerify(CONFIG, s);
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
    check("isCommitIntegrated() accepts a commit reachable from HEAD", !!after && isCommitIntegrated(tmpRoot, after!));
    check("isCommitIntegrated() rejects an unknown commit", !isCommitIntegrated(tmpRoot, "0000000000000000000000000000000000000000"));
    check("validateIntegratedCommitRange() accepts a real post-baseline diff", !!before && !!after && validateIntegratedCommitRange(tmpRoot, before!, after!).ok);
    check("validateIntegratedCommitRange() rejects baseline reused as commit", !!after && validateIntegratedCommitRange(tmpRoot, after!, after!).reason === "no-new-commit");
    check("validateIntegratedCommitRange() rejects an unknown commit", !!before && validateIntegratedCommitRange(tmpRoot, before!, "0000000000000000000000000000000000000000").ok === false);
    const art2 = commitArtifacts(s);
    check("commitArtifacts() is a no-op (nothing to commit) on second call", art2.committed === false, JSON.stringify(art2));
  }

  // --- cost/cache telemetry (P1: restored observability) -------------------
  console.log("\nlib.ts — cost/cache telemetry (summary.json):");

  {
    const t = emptyUsageTotals();
    check("emptyUsageTotals() starts at zero", t.turns === 0 && t.input === 0 && t.cacheRead === 0 && t.cost === 0);

    addUsage(t, { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: 0.0012 });
    check("addUsage() folds one message's usage", t.turns === 1 && t.input === 100 && t.output === 20 && t.cacheRead === 900);
    check("addUsage() accumulates cost", Math.abs(t.cost - 0.0012) < 1e-9, String(t.cost));

    addUsage(t, { input: 50, output: 10, cacheRead: 450 });
    check("addUsage() is cumulative across messages", t.turns === 2 && t.input === 150 && t.cacheRead === 1350);

    addUsage(t, undefined);
    check("addUsage(undefined) is a no-op (doesn't inflate turns)", t.turns === 2);

    addUsage(t, { input: "bogus" as unknown as number, output: NaN });
    check("addUsage() ignores non-finite/non-numeric fields", t.input === 150 && t.output === 30, JSON.stringify(t));
  }

  {
    // cacheHitRate = cacheRead / (cacheRead + input)
    const t = emptyUsageTotals();
    check("cacheHitRate() is null with no tokens", cacheHitRate(t) === null);
    t.cacheRead = 900; t.input = 100;
    const rate = cacheHitRate(t);
    check("cacheHitRate() computes cacheRead/(cacheRead+input)", rate !== null && Math.abs(rate - 0.9) < 1e-9, String(rate));
  }

  {
    const s: WorkflowState = { ...baseState };
    const byModel: Record<string, ReturnType<typeof emptyUsageTotals>> = {
      "deepseek/deepseek-v4-pro": emptyUsageTotals(),
      "zai/glm-5.2": emptyUsageTotals(),
    };
    addUsage(byModel["deepseek/deepseek-v4-pro"], { input: 100, output: 50, cacheRead: 900, cost: 0.001 });
    addUsage(byModel["zai/glm-5.2"], { input: 200, output: 80, cacheRead: 0, cost: 0.002 });

    const summary = buildRunSummary(s, byModel);
    check("buildRunSummary() sums totals across models", summary.totals.input === 300 && summary.totals.output === 130 && summary.totals.cacheRead === 900, JSON.stringify(summary.totals));
    check("buildRunSummary() sums turns across models", summary.totals.turns === 2, String(summary.totals.turns));
    check("buildRunSummary() keeps the per-model breakdown", Object.keys(summary.byModel).length === 2);
    check("buildRunSummary() carries reqId/epicId", summary.reqId === s.reqId && summary.epicId === s.epicId);
    check(
      "buildRunSummary() computes overall cacheHitRate (900/(900+300))",
      summary.cacheHitRate !== null && Math.abs(summary.cacheHitRate - 0.75) < 1e-9,
      String(summary.cacheHitRate),
    );

    // Roundtrip through disk.
    writeRunSummary(s, summary);
    const readBack = readRunSummary(s);
    check("writeRunSummary()/readRunSummary() roundtrip", !!readBack && readBack.totals.input === 300, JSON.stringify(readBack?.totals));
    check("summary.json lands in results/", fs.existsSync(path.join(tmpRoot, ".workflow", s.reqId, "results", "summary.json")));

    const line = formatUsageLine(summary);
    check("formatUsageLine() mentions turns/in/out/cacheRead", /turns/.test(line) && /in 300/.test(line) && /out 130/.test(line) && /cacheRead 900/.test(line), line);
    check("formatUsageLine() includes the hit rate", /hit 75\.0%/.test(line), line);
    check("formatUsageLine() includes cost when nonzero", /cost 0\.0030/.test(line), line);
  }

  {
    // readRunSummary on a requirement that never wrote one returns undefined
    // (not a throw) — /wf status relies on this to degrade quietly.
    const s: WorkflowState = { ...baseState, reqId: "req-never-written" };
    check("readRunSummary() returns undefined when absent", readRunSummary(s) === undefined);
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ===========================================================================

console.log("\nregression guard — modular workflow layout:");
{
  const entry = fs.readFileSync(new URL("../extensions/workflow.ts", import.meta.url), "utf8");
  const requiredModules = [
    "runtime.ts", "capabilities.ts", "index.ts", "commands.ts", "manager-tools.ts",
    "commands/plan.ts", "commands/lifecycle.ts", "commands/issues.ts", "commands/build.ts",
    "tools/split.ts", "tools/beads.ts", "tools/verification.ts",
  ];
  check("workflow.ts remains a thin compatibility entry", entry.split("\n").length <= 15 && /workflow\/index\.ts/.test(entry) && !/registerCommand|registerTool/.test(entry), entry);
  for (const module of requiredModules) {
    check(`modular workflow file exists: ${module}`, fs.existsSync(new URL(`../extensions/workflow/${module}`, import.meta.url)));
  }
}

// ===========================================================================
// 4. Regression guard: build-mode tool whitelist must reference the real
//    nicobailon/pi-subagents tool name `subagent`, not `delegate` (the wrong
//    name this project's docs/prompts used before the tool-name mismatch was
//    fixed — see extensions/workflow.ts's top-of-file comment for context).
// ===========================================================================

console.log("\nregression guard — build-mode tool whitelist uses the real tool name:");

{
  const registered: string[] = [];
  const fakePi = {
    registerTool(tool: { name: string }) { registered.push(tool.name); },
  };
  registerManagerTools(fakePi as any, {} as any);
  check(
    "fresh repo registers all manager tools before wf exists",
    ["split_prd_to_tasks", "bd_query", "bd_task", "run_verify", "finalize_test"].every((name) => registered.includes(name)),
    JSON.stringify(registered),
  );
}

{
  const src = workflowSource();
  const activeToolsBlock = src.match(/pi\.setActiveTools\(\[\s*"split_prd_to_tasks"[\s\S]*?\]\)/);
  check("applyModeTools()'s build-mode whitelist block exists", !!activeToolsBlock);
  if (activeToolsBlock) {
    check('build-mode whitelist includes "subagent"', activeToolsBlock[0].includes('"subagent"'), activeToolsBlock[0]);
    check('build-mode whitelist excludes unrestricted "bash"', !activeToolsBlock[0].includes('"bash"'), activeToolsBlock[0]);
    check('build-mode whitelist includes deterministic test tools', activeToolsBlock[0].includes('"run_verify"') && activeToolsBlock[0].includes('"finalize_test"'));
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
  const src = workflowSource();
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

// ===========================================================================
// 6. Regression guards for the P0/P1 fixes: maxParallel must actually be
//    injected into the manager prompt (it used to be dead config), /execute
//    must support --dry-run, /wf abort must exist and use wf.baseline, and
//    .pi/settings.json must list pi-subagents (the core dependency that was
//    missing, breaking fresh-machine reproducibility).
// ===========================================================================

console.log("\nregression guards — P0/P1 fixes stay wired:");

{
  const src = workflowSource();

  // P0-1: maxParallel is read from config AND injected into the prompt context.
  const loadMgr = src.match(/function loadManagerPrompt\([\s\S]*?\n}/);
  check("loadManagerPrompt() exists", !!loadMgr);
  if (loadMgr) {
    check("loadManagerPrompt() injects writer ceiling 1", /writer 并行上限:1/.test(loadMgr[0]));
    check("loadManagerPrompt() injects active profile role models", /模型 profile:[\s\S]*dev model:[\s\S]*reviewer model:[\s\S]*final reviewer model:/.test(loadMgr[0]));
    check("loadManagerPrompt() supports a dryRun branch", /dryRun/.test(loadMgr[0]));
    check("dry-run branch forbids dispatching dev", /不要派 dev|绝对不要派 dev/.test(loadMgr[0]));
  }
  // Worktree writers are disabled until deterministic patch integration exists.
  check("DEFAULT_CONFIG.execute.maxParallel is 1 (safe serial writer)", /execute:\s*\{[^}]*maxParallel:\s*1/.test(src));

  // manager-prompt.md must no longer contain the never-substituted "N 个开发".
  const mgrPrompt = fs.readFileSync(new URL("../.pi/manager-prompt.md", import.meta.url), "utf8");
  check('manager-prompt.md no longer says the placeholder "N 个开发"', !/N 个开发/.test(mgrPrompt));
  check("manager-prompt.md documents writer ceiling", /writer 上限固定为 1/.test(mgrPrompt));
  check("manager-prompt.md forbids worktree writers", /禁止 `tasks:\[\.\.\.\]`、`worktree:true`/.test(mgrPrompt));
  check("manager-prompt.md requires configured model/effort on every authoritative child", (mgrPrompt.match(/model: "<运行上下文中的/g) || []).length === 3
    && (mgrPrompt.match(/thinking: "<运行上下文中的/g) || []).length === 3);
  check("manager-prompt.md uses deterministic verify + final reviewer", /run_verify[\s\S]*final-reviewer[\s\S]*finalize_test/.test(mgrPrompt));
  check("manager-prompt.md does not grant bash", !/开放[^\n]*bash|工具集[^\n]*bash/.test(mgrPrompt));
  check("bd_task close validates a claim-bound integrated commit range", /validateIntegratedCommitRange/.test(src) && /\.claim\.json/.test(src));

  // Fresh repositories have no wf during session_start. Manager tools must be
  // registered anyway, with active-workflow checks inside each execute handler.
  const registerTools = src.match(/function registerManagerTools\([\s\S]*?\n}/);
  check("registerManagerTools() does not return early when wf is absent", !!registerTools && !/if \(!wf\) return/.test(registerTools[0]));
  check("manager tool handlers fail safely without an active workflow", (src.match(/错误:没有活动\s*(?:需求|epic)/g) || []).length >= 4);
  check("empty verify command is rejected before build", /无法进入 build:未配置验证命令/.test(src));
  check("run_test and allowEmptyVerify are removed", !/name: "run_test"|allowEmptyVerify/.test(src));
  check("resume uses Beads epic picker and reconstructs state", /bd\.list\(ctx\.cwd, \{ type: "epic", all: true, limit: 0 \}\)/.test(src) && /ui\.select\("选择要恢复的 Beads epic"/.test(src) && /重建 workflow 上下文/.test(src));
  check("cross-module workflow reads use runtime accessor instead of Jiti-stale named export", !/CONFIG,\s*wf,\s*baseActiveTools/.test(src)
    && (src.match(/currentWorkflow\(\)/g) || []).length >= 15);
  check("idle command is removed", !/case "idle"|cmdIdle|\/wf idle/.test(src));
  check("PRD command delegates to forked namespaced prd-writer", /agent: "pi-workflow\.prd-writer"[\s\S]*context: "fork"[\s\S]*cwd:/.test(src));
  check("subagent capability guard rejects parallel/worktree/async and binds model/effort to active profile", /function validateSubagentCall[\s\S]*input\.tasks[\s\S]*input\.worktree[\s\S]*input\.async[\s\S]*workflowAgentConfig\(agent\)[\s\S]*input\.thinking/.test(src));
  check("authoritative direct subagents apply effort through a post-validation model suffix", /validateSubagentCall\(event\)[\s\S]*event\.input\.model = `\$\{expected\.model\}:\$\{expected\.effort\}`/.test(src)
    && /resolvedModelRaw === `\$\{expected\.model\}:\$\{expected\.effort\}` \? expected\.model/.test(src));
  check("BUILD child launch self-heals orphaned PLAN capability ceilings", /currentWorkflow\(\)\?\.mode === "build"\) syncSubagentCapabilityCeiling\(ctx, "build"\)/.test(src));
  check("reviewer failures are persisted and mandatory in retry dev prompts", /review-feedback\.json/.test(src)
    && /dev 重试必须在 task 中引用并逐项处理 reviewer 反馈/.test(src)
    && /存在时必须先读取，逐项修复全部 reviewer issues/.test(mgrPrompt));
  check("manager automatically repairs actionable reviewer failures inside the same execute run", /retryDecision\.autoRetryAllowed === true/.test(mgrPrompt)
    && /不得递归调用 `\/execute`/.test(mgrPrompt)
    && /需求歧义、PRD\/架构冲突/.test(mgrPrompt)
    && /maxReviewerAutoFixes:\s*3/.test(src)
    && /sameIssueStopAfter:\s*2/.test(src));
  check("/wf verify without args uses AI suggestion plus explicit user confirmation", /case "verify": await cmdVerify/.test(src)
    && /采用 AI 建议的验证命令/.test(src)
    && /verify-command-suggestion\.json/.test(src)
    && /suggestedVerifyCommandRisk/.test(src));
  check("subagent capability guard restricts plan/build roles", /plan 模式只允许 researcher\/scout\/oracle advisory 或 pi-workflow\.prd-writer[\s\S]*build 模式只允许 pi-workflow\.dev\/reviewer\/final-reviewer/.test(src));
  check("PLAN main prompt deterministically injects bundled plan-interrogation", /before_agent_start[\s\S]*withPlanInterrogationSystemPrompt\(event\.systemPrompt, wf, planInterrogationPrompt\)/.test(src)
    && /loadPlanInterrogationPrompt[\s\S]*skills[\s\S]*plan-interrogation[\s\S]*SKILL\.md/.test(src));
  check("PLAN builtin advisory calls are context/output bound", /ADVISORY_AGENTS[\s\S]*agent === "oracle" \? "fork" : "fresh"[\s\S]*advisoryOutputPath\(agent\)/.test(src));
  check("PLAN advisory children have an out-of-band capability ceiling", /pi-subagents\.capability-ceiling\.v1[\s\S]*PLAN_ADVISORY_TOOLS[\s\S]*validateAdvisoryLaunchContract/.test(src));
  check("advisory call arguments use a strict allowlist", /allowedKeys = new Set\(\["agent", "task", "context", "cwd", "output"\]\)/.test(src));
  check("research/scout/oracle commands are wired", /case "research": await cmdResearch/.test(src) && /case "oracle": await cmdOracle/.test(src) && /agent: "scout"/.test(src));
  check("advisory evidence is explicitly non-authoritative and detects repo mutation", /authority: "advisory"[\s\S]*repoUnchanged[\s\S]*excludedFromAuthoritativeEvidence: true/.test(src));
  check("builtin advisory shadow/override fails closed", /function assertAdvisoryAgentsUnshadowed[\s\S]*builtin advisory agent 被高优先级定义覆盖[\s\S]*settings override/.test(src));
  check("subagent capability guard enforces workflow cwd and serial dev lease", /cwd 必须精确[\s\S]*activeDevToolCallId/.test(src));
  check("workflow fails closed on higher-precedence agent shadow/override", /function assertWorkflowAgentsUnshadowed[\s\S]*workflow agent 被高优先级定义覆盖[\s\S]*settings override/.test(src));
  check("PRD child model/usage is persisted from subagent tool details", /pi\.on\("tool_result"[\s\S]*prd-generation\.json[\s\S]*resolvedModel[\s\S]*usage/.test(src));
  check("final reviewer has a separate actual-model audit envelope", /final-review\.audit\.json/.test(src));
  check("final evidence is bound to runId/head/command/hashes and configured reviewer audit", /randomUUID\(\)[\s\S]*prdSha256[\s\S]*diffSha256[\s\S]*expectedFinal[\s\S]*resolvedEffort[\s\S]*verifyRunId/.test(src));
  check("bd_task mutations are scoped to active epic children", /assertActiveChildIssue\(taskId\)/.test(src));
  check("task close requires commit-bound reviewer pass + audit", /review\?\.taskId === taskId[\s\S]*review\?\.baseline === baseline[\s\S]*review\?\.commitSha === commitSha/.test(src));
  check("external PRD switches authoritative epic and isolates a new req directory", /wf\.reqId = `\$\{nowStamp\(\)\}-\$\{slug\(epicTitle\)\}`[\s\S]*wf\.epicId = epicIdOverride[\s\S]*resetUsageByModel\(\)[\s\S]*ensureRequirementDirs\(wf\)[\s\S]*fs\.copyFileSync\(originalPath, canonicalPrdPath\)/.test(src));
  check("split ignores env overrides and only uses active epic/canonical PRD", !/WF_EPIC_ID|WF_PRD_PATH/.test(src) && /parent: wf\.epicId/.test(src) && /split 只允许当前 canonical PRD/.test(src));
  check("split is manifest-backed and fails closed on partial creation", /manifestPath = reqPath\(wf, "results", "split\.json"\)/.test(src) && /status: "creating"[\s\S]*status: "complete"[\s\S]*status: "failed"/.test(src) && /拒绝自动重试以避免重复/.test(src));
  check("split tool no longer recursively calls the parent model", !/const splitPromptText = withBrief\(wf!\.repo/.test(src));
  check("main-model selection fails closed before workflow state mutation",
    /function cmdNew[\s\S]*?if \(!\(await useRole[\s\S]*?bd\.init/.test(src)
    && /function cmdPlan[\s\S]*?if \(!\(await useRole[\s\S]*?wf\.mode = "plan"/.test(src)
    && /function cmdResume[\s\S]*?if \(!\(await useRole[\s\S]*?setWorkflow\(target\)/.test(src)
    && /function cmdExecute[\s\S]*?if \(!\(await useRole[\s\S]*?wf\.mode = "build"/.test(src));
  check("execute preserves the original baseline across resume", /wf\.baseline = preservedBaseline\(wf\.baseline, gitHead/.test(src));

  // P1-7: /execute --dry-run parsing.
  check("cmdExecute() parses --dry-run", /--dry-run/.test(src));

  // P1-8: /wf abort exists, uses baseline, and confirms before resetting.
  const abort = src.match(/async function cmdAbort\([\s\S]*?\n}/);
  check("cmdAbort() exists", !!abort);
  if (abort) {
    check("cmdAbort() uses wf.baseline", /wf\.baseline/.test(abort[0]));
    check("cmdAbort() asks for confirmation before resetting", /ui\.confirm/.test(abort[0]));
    check("cmdAbort() runs git reset --hard", /"reset",\s*"--hard"/.test(abort[0]));
    check("cmdAbort() reopens bd tasks", /bd\.reopen/.test(abort[0]));
    check("cmdAbort() preserves .workflow artifacts by committing them first", /commitArtifacts/.test(abort[0]));
  }
  check('"abort" is wired into the /wf dispatcher', /case "abort":/.test(src));

  // P1-9: /wf status degrades when bd is unreachable.
  const status = src.match(/function cmdStatus\([\s\S]*?\n}/);
  check("cmdStatus() exists", !!status);
  if (status) {
    check("cmdStatus() falls back to state.json subtaskIds when bd fails", /subtaskIds/.test(status[0]));
    check("cmdStatus() surfaces the cost/cache summary", /readRunSummary|formatUsageLine/.test(status[0]));
  }

  // P1-6: telemetry hook is registered.
  check("message_end telemetry hook is registered", /pi\.on\("message_end"/.test(src));
  check("trackUsage() persists via writeRunSummary", /writeRunSummary\(wf, buildRunSummary\(wf, usageByModel\)\)/.test(src));
}

{
  // P0-4: .pi/settings.json must list pi-subagents — README calls this list the
  // key to fresh-machine reproducibility, and it was missing the one package
  // the whole build mode depends on.
  const settings = JSON.parse(fs.readFileSync(new URL("../.pi/settings.json", import.meta.url), "utf8"));
  const pkgs: string[] = settings.packages ?? [];
  check(".pi/settings.json has a packages array", Array.isArray(pkgs) && pkgs.length > 0, JSON.stringify(settings));
  check(".pi/settings.json lists pi-subagents", pkgs.some((p) => p.includes("pi-subagents")), JSON.stringify(pkgs));
  check(".pi/settings.json lists pi-web-access", pkgs.some((p) => p.includes("pi-web-access")), JSON.stringify(pkgs));

  const devAgent = fs.readFileSync(new URL("../.pi/agents/dev.md", import.meta.url), "utf8");
  const reviewerAgent = fs.readFileSync(new URL("../.pi/agents/reviewer.md", import.meta.url), "utf8");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  check("package exposes bundled pi-subagents agents", pkg.pi?.subagents?.agents?.includes("./.pi/agents"), JSON.stringify(pkg.pi));
  const wfpi = fs.readFileSync(new URL("../scripts/wfpi", import.meta.url), "utf8");
  check("wfpi exposes bundled agents in local-source mode", /PI_SUBAGENT_EXTRA_AGENT_DIRS/.test(wfpi));
  const providerSource = fs.readFileSync(new URL("../extensions/providers.ts", import.meta.url), "utf8");
  const finalReviewerAgent = fs.readFileSync(new URL("../.pi/agents/final-reviewer.md", import.meta.url), "utf8");
  const prdWriterAgent = fs.readFileSync(new URL("../.pi/agents/prd-writer.md", import.meta.url), "utf8");
  check("provider bridge maps GLM5_2_API_KEY for builtin Z.AI children", /ZAI_API_KEY[\s\S]*GLM5_2_API_KEY/.test(providerSource));
  check("workflow agents leave model selection to workflow.config.json", [devAgent, reviewerAgent, prdWriterAgent, finalReviewerAgent].every((text) => !/^model:/m.test(text)));
  check("final-reviewer remains shell-free", !/tools:.*bash/.test(finalReviewerAgent));
  for (const [name, text] of [["dev", devAgent], ["reviewer", reviewerAgent], ["prd-writer", prdWriterAgent], ["final-reviewer", finalReviewerAgent]] as const) {
    check(`${name} disables inferred acceptance for raw artifact output`, /acceptance:\s*\{level:\s*none/.test(text));
  }
}

{
  // P0-3: workflow.config.json comments must not describe the removed
  // omp-subprocess architecture or the wrong .omp/agents path.
  const cfgRaw = fs.readFileSync(new URL("../workflow.config.json", import.meta.url), "utf8");
  check("workflow.config.json is valid JSON", (() => { try { JSON.parse(cfgRaw); return true; } catch { return false; } })());
  const parsed = JSON.parse(cfgRaw);
  check("gpt56 profile maps Sol/Terra/Luna roles and confirmed efforts", parsed.activeModelProfile === "gpt56"
    && parsed.modelProfiles?.gpt56?.main?.model === "codex2api/gpt-5.6-sol" && parsed.modelProfiles?.gpt56?.main?.effort === "xhigh"
    && parsed.modelProfiles?.gpt56?.prd?.model === "codex2api/gpt-5.6-sol" && parsed.modelProfiles?.gpt56?.prd?.effort === "high"
    && parsed.modelProfiles?.gpt56?.dev?.model === "codex2api/gpt-5.6-terra" && parsed.modelProfiles?.gpt56?.dev?.effort === "high"
    && parsed.modelProfiles?.gpt56?.reviewer?.model === "codex2api/gpt-5.6-luna" && parsed.modelProfiles?.gpt56?.reviewer?.effort === "xhigh"
    && parsed.modelProfiles?.gpt56?.finalReviewer?.model === "codex2api/gpt-5.6-luna" && parsed.modelProfiles?.gpt56?.finalReviewer?.effort === "xhigh");
  check("legacy DeepSeek/GLM profile remains available with high effort", parsed.modelProfiles?.["deepseek-glm"]?.main?.model === "deepseek/deepseek-v4-pro"
    && parsed.modelProfiles?.["deepseek-glm"]?.dev?.model === "deepseek/deepseek-v4-flash"
    && parsed.modelProfiles?.["deepseek-glm"]?.prd?.model === "zai/glm-5.2"
    && Object.values(parsed.modelProfiles?.["deepseek-glm"] || {}).filter((entry: any) => entry?.model).every((entry: any) => entry.effort === "high"));
  const loaded = loadConfig();
  check("runtime resolves active profile model and effort centrally", activeModelProfile(loaded).dev.model === "codex2api/gpt-5.6-terra"
    && activeModelProfile(loaded).main.effort === "xhigh"
    && workflowAgentModel("pi-workflow.reviewer", loaded) === "codex2api/gpt-5.6-luna"
    && workflowAgentEffort("pi-workflow.reviewer", loaded) === "xhigh");
  check("legacy string-form gpt56 receives confirmed role defaults", (() => {
    const profile = activeModelProfile({ ...loaded, modelProfiles: { gpt56: {
      main: "codex2api/gpt-5.6-sol", prd: "codex2api/gpt-5.6-sol", dev: "codex2api/gpt-5.6-terra",
      reviewer: "codex2api/gpt-5.6-luna", finalReviewer: "codex2api/gpt-5.6-luna",
    } }, activeModelProfile: "gpt56" });
    return profile.main.effort === "xhigh" && profile.prd.effort === "high" && profile.dev.effort === "high"
      && profile.reviewer.effort === "xhigh" && profile.finalReviewer.effort === "xhigh";
  })());
  check("legacy string-form deepseek-glm remains high for every role", (() => {
    const profile = activeModelProfile({ ...loaded, modelProfiles: { "deepseek-glm": {
      main: "deepseek/deepseek-v4-pro", prd: "zai/glm-5.2", dev: "deepseek/deepseek-v4-flash",
      reviewer: "zai/glm-5.2", finalReviewer: "zai/glm-5.2",
    } }, activeModelProfile: "deepseek-glm" });
    return Object.values(profile).every((entry) => entry.effort === "high");
  })());
  check("unknown active profile fails closed", (() => {
    try { activeModelProfile({ ...loaded, activeModelProfile: "missing" }); return false; } catch { return true; }
  })());
  check("missing profile selector uses the default", configuredActiveProfileName({}, "gpt56") === "gpt56");
  check("explicit empty/non-string profile selectors fail closed", ["", false, null].every((value) => {
    try { configuredActiveProfileName({ activeModelProfile: value }, "gpt56"); return false; } catch { return true; }
  }));
  check("unqualified profile model fails closed", (() => {
    try {
      activeModelProfile({ ...loaded, modelProfiles: { ...loaded.modelProfiles, broken: { ...activeModelProfile(loaded), dev: "gpt-5.6-terra" } }, activeModelProfile: "broken" });
      return false;
    } catch { return true; }
  })());
  check("invalid profile effort fails closed", (() => {
    try {
      activeModelProfile({ ...loaded, modelProfiles: { ...loaded.modelProfiles, broken: { ...loaded.modelProfiles.gpt56, main: { model: "codex2api/gpt-5.6-sol", effort: "ultra" as any } } }, activeModelProfile: "broken" });
      return false;
    } catch { return true; }
  })());
  check("workflow.config.json no longer references .omp/agents", !/\.omp\/agents/.test(cfgRaw));
  check("workflow.config.json no longer claims /execute spawns an omp process", !/启动经理 omp 进程/.test(cfgRaw));
  check("workflow.config.json marks pollIntervalMs as dead config", /死字段/.test(cfgRaw));
}

{
  // P0-2: README must not advertise the nonexistent `dev: {model, timeoutMs}`
  // config field as currently settable.
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  check("README documents centralized activeModelProfile switching", /activeModelProfile[\s\S]*modelProfiles/.test(readme));
  check("README no longer shows the removed NN.metrics.json artifact", !/NN\.metrics\.json/.test(readme));
  check("README documents /execute --dry-run", /--dry-run/.test(readme));
  check("README documents /wf abort", /\/wf abort/.test(readme));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
