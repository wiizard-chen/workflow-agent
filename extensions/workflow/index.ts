import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readRunSummary, formatUsageLine, readRepoBrief, reqPath, saveState } from "../lib.ts";
import * as bd from "../bd.ts";
import { registerWorkflowProviders } from "../providers.ts";
import { registerManagerTools } from "./manager-tools.ts";
import { validateAdvisoryLaunchContract } from "./capabilities.ts";
import {
  cmdAbort, cmdAnalyze, cmdBug, cmdDone, cmdExecute, cmdNew, cmdPlan,
  cmdPrd, cmdResearch, cmdOracle, cmdResume, cmdStatus, cmdTask,
} from "./commands.ts";
import {
  CONFIG, wf, baseActiveTools, activeDevToolCallId, mgrHasSplit, mgrTasksProcessed,
  lastAssistantText, usageByModel, loadConfig, setConfig, setWorkflow,
  setBaseActiveTools, setActiveDevToolCallId, setManagerSplit,
  setManagerTasksProcessed, incrementManagerTasksProcessed, setLastAssistantText,
  resetUsageByModel, trackUsage, setModeStatus, applyModeTools, readJson,
  sha256File, ensureRequirementDirs, preservedBaseline, splitDecision,
  validateSubagentCall, listAllStates, extractAssistantText, stripFence,
  extractSubtasksJson, useRole, runStageText, withBrief, analyzePrompt,
  extractSuggestedVerifyCommand, assertActiveChildIssue, assertWorkflowAgentsUnshadowed,
  advisoryOutputPath, advisoryRepoSnapshot, loadPlanInterrogationPrompt,
  withPlanInterrogationSystemPrompt, workflowAgentConfig, renderedToolName
} from "./runtime.ts";

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default function workflowExtension(pi: ExtensionAPI): void {
  setConfig(loadConfig());
  registerWorkflowProviders(pi, CONFIG);
  // Fail closed at extension load if the bundled PLAN policy is missing. The
  // full skill body is then appended deterministically on every PLAN turn.
  const planInterrogationPrompt = loadPlanInterrogationPrompt();

  pi.on("before_agent_start", async (event: any) => {
    const systemPrompt = withPlanInterrogationSystemPrompt(event.systemPrompt, wf, planInterrogationPrompt);
    if (systemPrompt !== event.systemPrompt) return { systemPrompt };
  });

  pi.on("session_start", async (_e, ctx) => {
    // No epic is auto-restored. Normal Pi is the default; /wf resume presents
    // the Beads epic picker. Capture the pre-workflow active tool set so /wf
    // done can restore it exactly.
    if (baseActiveTools.length === 0) setBaseActiveTools(pi.getActiveTools());
    setWorkflow(undefined);
    setActiveDevToolCallId(undefined);
    setModeStatus(ctx as any);
    registerManagerTools(pi, ctx as any);
    applyModeTools(pi, ctx as any);
  });

  pi.on("resources_discover", async () => {
    try {
      const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
      if (fs.existsSync(dir)) return { skillPaths: [dir] };
    } catch (_e) { /* ignore */ }
    return {};
  });

  // Cost/cache telemetry (P1): accumulate per-model token usage for the active
  // requirement and persist it to results/summary.json. This restores the
  // observability lost when the reasonix `-metrics` aggregation was removed.
  pi.on("message_end", async (event: any, ctx: any) => {
    try { trackUsage(event, ctx); } catch (_e) { /* never break a run over telemetry */ }
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event?.toolName !== "subagent") return;
    const reason = validateSubagentCall(event);
    if (reason) return { block: true, reason };
    if (["researcher", "scout", "oracle"].includes(String(event?.input?.agent || ""))) {
      const contractReason = await validateAdvisoryLaunchContract(event.input, ctx);
      if (contractReason) return { block: true, reason: contractReason };
    }
  });

  // Persist the resolved child model and child usage reported by pi-subagents.
  // The PRD/final-review output remains the child's raw artifact; this adjacent
  // envelope makes provider/model selection auditable without trusting text the
  // child wrote about itself.
  pi.on("tool_result", async (event: any) => {
    try {
      if (event?.toolName !== "subagent") return;
      const agent = String(event?.input?.agent || "");
      if (agent === "pi-workflow.dev" && activeDevToolCallId === String(event?.toolCallId || "")) setActiveDevToolCallId(undefined);
      if (!wf) return;
      const result = event?.details?.results?.[0];
      const usage = result?.usage ?? event?.details?.totalChildUsage ?? event?.usage ?? null;
      const inputOutput = String(event?.input?.output || "");
      if (["researcher", "scout", "oracle"].includes(agent)) {
        const expectedOutput = advisoryOutputPath(agent);
        const auditPath = agent === "researcher"
          ? reqPath(wf, "results", "research.audit.json")
          : agent === "scout"
            ? reqPath(wf, "results", "scout.audit.json")
            : reqPath(wf, "results", "prd-oracle.audit.json");
        const expectedContext = agent === "oracle" ? "fork" : "fresh";
        const launched = readJson(auditPath);
        const completedRepoSnapshot = advisoryRepoSnapshot(wf.repo);
        const repoUnchanged = !!launched?.repoSnapshot
          && launched.repoSnapshot.head === completedRepoSnapshot.head
          && launched.repoSnapshot.status === completedRepoSnapshot.status;
        const exactOutput = !!inputOutput && path.resolve(inputOutput) === path.resolve(expectedOutput)
          && (!result?.savedOutputPath || path.resolve(result.savedOutputPath) === path.resolve(expectedOutput));
        const context = result?.context ?? event?.details?.context ?? null;
        const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
        const mutationTools = toolCalls.map((call: any) => renderedToolName(call)).filter((name: string) => ["write", "edit", "bash"].includes(name));
        const capabilityAudit = result?.capabilityAudit ?? null;
        const effectiveTools = Array.isArray(capabilityAudit?.effectiveTools) ? capabilityAudit.effectiveTools : [];
        const capabilitySafe = capabilityAudit?.ceiling?.sources?.includes("pi-workflow-plan")
          && !effectiveTools.some((name: string) => ["write", "edit", "bash", "bd", "subagent"].includes(name));
        const ok = !event?.isError && result?.exitCode === 0 && !result?.outputSaveError
          && exactOutput && fs.existsSync(expectedOutput) && context === expectedContext && repoUnchanged
          && mutationTools.length === 0 && capabilitySafe;
        fs.writeFileSync(auditPath, JSON.stringify({
          status: ok ? "completed" : "failed",
          agent,
          authority: "advisory",
          resolvedModel: result?.model ?? null,
          attemptedModels: result?.attemptedModels ?? [],
          context,
          usage,
          output: expectedOutput,
          outputSha256: sha256File(expectedOutput) ?? null,
          outputExists: fs.existsSync(expectedOutput),
          exactOutput,
          mutationTools,
          toolsAdvisorySafe: mutationTools.length === 0,
          capabilitySafe,
          capabilityAudit,
          toolCalls,
          launchedRepoSnapshot: launched?.repoSnapshot ?? null,
          completedRepoSnapshot,
          repoUnchanged,
          excludedFromAuthoritativeEvidence: true,
          exitCode: result?.exitCode ?? null,
          error: result?.error ?? result?.outputSaveError ?? (event?.isError ? "subagent tool failed" : null),
          completedAt: new Date().toISOString(),
        }, null, 2) + "\n");
        return;
      }
      if (!["pi-workflow.prd-writer", "pi-workflow.dev", "pi-workflow.reviewer", "pi-workflow.final-reviewer"].includes(agent)) return;
      let expectedOutput: string;
      let auditPath: string;
      let expectedContext: "fork" | "fresh";
      if (agent === "pi-workflow.prd-writer") {
        expectedOutput = reqPath(wf, "prd.md");
        auditPath = reqPath(wf, "results", "prd-generation.json");
        expectedContext = "fork";
      } else if (agent === "pi-workflow.final-reviewer") {
        expectedOutput = reqPath(wf, "results", "final-review.json");
        auditPath = reqPath(wf, "results", "final-review.audit.json");
        expectedContext = "fresh";
      } else if (agent === "pi-workflow.dev") {
        expectedOutput = inputOutput;
        auditPath = inputOutput.replace(/\.json$/, ".audit.json");
        expectedContext = "fresh";
      } else {
        expectedOutput = inputOutput;
        auditPath = inputOutput.replace(/\.review\.json$/, ".review.audit.json");
        expectedContext = "fresh";
      }
      const exactOutput = !!inputOutput && path.resolve(inputOutput) === path.resolve(expectedOutput)
        && (!result?.savedOutputPath || path.resolve(result.savedOutputPath) === path.resolve(expectedOutput));
      const resolvedModel = result?.model ?? null;
      const resolvedEffort = result?.thinking ?? null;
      const context = result?.context ?? event?.details?.context ?? null;
      const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
      const allowedTools = agent === "pi-workflow.dev"
        ? new Set(["read", "write", "edit", "bash", "grep", "find"])
        : agent === "pi-workflow.reviewer"
          ? new Set(["read", "bash", "grep", "find", "ls"])
          : new Set(["read", "grep", "find", "ls"]);
      const toolsSafe = toolCalls.every((call: any) => {
        const toolName = renderedToolName(call);
        return allowedTools.has(toolName);
      });
      const verify = agent === "pi-workflow.final-reviewer" ? readJson(reqPath(wf, "results", "verify.json")) : undefined;
      const expected = workflowAgentConfig(agent);
      const ok = !event?.isError && result?.exitCode === 0 && !result?.outputSaveError
        && exactOutput && fs.existsSync(expectedOutput) && resolvedModel === expected.model
        && resolvedEffort === expected.effort
        && context === expectedContext && !!usage && toolsSafe;
      fs.writeFileSync(auditPath, JSON.stringify({
        status: ok ? "completed" : "failed",
        agent,
        requestedModel: expected.model,
        requestedEffort: expected.effort,
        profile: CONFIG.activeModelProfile,
        resolvedModel,
        resolvedEffort,
        attemptedModels: result?.attemptedModels ?? [],
        context,
        usage,
        output: expectedOutput,
        outputSha256: sha256File(expectedOutput) ?? null,
        outputExists: fs.existsSync(expectedOutput),
        exactOutput,
        toolsSafe,
        toolCalls,
        verifyRunId: verify?.runId ?? null,
        verifySha256: agent === "pi-workflow.final-reviewer" ? sha256File(reqPath(wf, "results", "verify.json")) ?? null : null,
        exitCode: result?.exitCode ?? null,
        error: result?.error ?? result?.outputSaveError ?? (event?.isError ? "subagent tool failed" : null),
        completedAt: new Date().toISOString(),
      }, null, 2) + "\n");
    } catch (_e) { /* audit must not alter the subagent tool result */ }
  });

  pi.on("agent_end", async (event: any) => {
    try { const t = extractAssistantText(event?.messages); if (t) setLastAssistantText(t); } catch (_e) { /* ignore */ }
    // In build mode, detect "did zero work" so we can warn instead of a false success.
    // Two signals: in-memory counters AND a bd reality check (task count under epic).
    if (wf && wf.mode === "build") {
      const memSaysNoop = !mgrHasSplit && mgrTasksProcessed === 0;
      if (memSaysNoop) {
        let bdTaskCount = 0;
        try {
          if (wf.epicId) {
            bdTaskCount = bd.children(wf.repo, wf.epicId).filter((i: any) => i.issue_type === "task").length;
          }
        } catch (_e) { /* if bd is unreachable, trust the memory signal */ }
        if (bdTaskCount === 0) {
          wf.managerNoop = true;
          saveState(wf);
        }
      }
    }
  });

  // Commands (always registered — there's only one session now, no WF_ROLE split).
  pi.registerCommand("wf", {
      description: "workflow 流水线:new / research / analyze / prd / oracle / status / verify / execute / resume / bug / task / done / abort",
      getArgumentCompletions: (prefix: string) => {
        const subs = ["new", "research", "analyze", "prd", "oracle", "status", "verify", "execute", "resume", "bug", "task", "done", "abort", "help"];
        const f = subs.filter((s) => s.startsWith(prefix));
        return f.length ? f.map((s) => ({ value: s, label: s })) : null;
      },
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const trimmed = args.trim();
        const sub = trimmed.split(/\s+/)[0] || "help";
        const rest = trimmed.slice(sub.length).trim();
        switch (sub) {
          case "new": await cmdNew(pi, ctx, rest); break;
          case "research": await cmdResearch(pi, ctx, rest); break;
          case "prd": await cmdPrd(pi, ctx); break;
          case "oracle": await cmdOracle(pi, ctx); break;
          case "analyze": {
            if (!wf) { ctx.ui.notify("无活动需求。", "warning"); break; }
            if (readRepoBrief(wf.repo) && rest !== "--refresh") { ctx.ui.notify(`简报已存在。/wf analyze --refresh 重析。`, "info"); break; }
            await cmdAnalyze(pi, ctx); break;
          }
          case "status": cmdStatus(ctx); break;
          case "resume": await cmdResume(pi, ctx, rest); break;
          case "bug": await cmdBug(pi, ctx, rest); break;
          case "task": await cmdTask(pi, ctx, rest); break;
          case "done": cmdDone(pi, ctx); break;
          case "abort": await cmdAbort(pi, ctx); break;
          case "execute": await cmdExecute(pi, ctx, rest); break;
          case "verify":
            if (!wf) { ctx.ui.notify("无活动需求。", "warning"); break; }
            if (!rest.trim()) { ctx.ui.notify("验证命令不能为空。用法:/wf verify <cmd>", "error"); break; }
            wf.verifyCommand = rest.trim(); saveState(wf);
            ctx.ui.notify(`验证命令:${wf.verifyCommand}`, "info"); break;
          default:
            ctx.ui.notify([
              "workflow 两模式:plan(讨论/PRD,代码只读) / build(manager 代码只读,委派执行)。无 active epic 时是普通 Pi。",
              "",
              "/wf new <名> [repo]     新建 Beads epic,进入 plan",
              "/wf resume [epicId]     从全部 Beads epic 选择;缺 state 时可重建",
              "/plan                   回 plan 模式讨论",
              "/wf analyze [--refresh] builtin scout 分析仓库,生成跨需求复用简报",
              "/wf research [主题]    builtin researcher 生成外部研究(advisory)",
              "/wf prd                 调用 fork 的 prd-writer(GLM-5.2)生成并展示 PRD",
              "/wf oracle              builtin oracle 可选审查 PRD 一致性(advisory)",
              "/execute [prd路径]      进入 build;要求非空验证命令",
              "/execute --dry-run      只拆 task + 汇报计划,不派 dev",
              "/wf status              查看当前 epic 任务和 token/cache 用量",
              "/wf done                退出当前 epic,恢复普通 Pi;之后可 resume",
              "/wf abort               回滚到 execute baseline,task reopen,回到 plan",
              "/wf bug <描述>          在当前 epic 创建 bug",
              "/wf task <描述>         在当前 epic 创建 task",
              "/wf verify <cmd>        设置强制验证命令;空命令直接报错",
            ].join("\n"), "info");
        }
      },
    });

  pi.registerCommand("plan", {
    description: "进入 PRD 模式(讨论需求,只读)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => { await cmdPlan(pi, ctx); },
  });

  pi.registerCommand("execute", {
    description: "进入执行模式(拆 task→派 dev/reviewer→测试);--dry-run 只拆分不实现",
    handler: async (args: string, ctx: ExtensionCommandContext) => { await cmdExecute(pi, ctx, args); },
  });

}
