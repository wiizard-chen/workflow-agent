import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { CreateAgentSessionOptions, ExtensionRuntime, ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { LeadSession, LeadSessionContext, LeadSessionFactory } from "./types.js";

function createStrictResourceLoader(context: LeadSessionContext, createExtensionRuntime: () => ExtensionRuntime): ResourceLoader {
  const systemPrompt = [
    "You are the V2 Engineering Lead diagnostic session.",
    "This session is diagnostic-only. You have no tools and must not propose or perform repository, shell, Git, Beads, network, or subagent mutations.",
    `Approved runtime resource identifiers: ${context.resources.map((resource) => resource.id).join(", ")}`,
  ].join("\n");
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

function assistantText(event: unknown): string {
  if (event === null || typeof event !== "object") return "";
  const value = event as { type?: unknown; assistantMessageEvent?: { type?: unknown; delta?: unknown } };
  return value.type === "message_update" && value.assistantMessageEvent?.type === "text_delta" && typeof value.assistantMessageEvent.delta === "string"
    ? value.assistantMessageEvent.delta
    : "";
}

export type PiLeadSessionOptions = Readonly<{
  readonly model?: CreateAgentSessionOptions["model"];
  readonly modelRuntime?: CreateAgentSessionOptions["modelRuntime"];
  readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
}>;

/**
 * Build a real Pi SDK Lead factory. Discovery is deliberately bypassed: the
 * worker owns a literal ResourceLoader and starts with an empty tool allowlist.
 */
export function createPiLeadSessionFactory(options: PiLeadSessionOptions = {}): LeadSessionFactory {
  return async (context: LeadSessionContext): Promise<LeadSession> => {
    const {
      createAgentSession,
      createExtensionRuntime,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const sessionDirectory = dirname(context.sessionFile);
    if (context.resume && !existsSync(context.sessionFile)) throw new Error("worker_session_file_missing");
    const sessionManager = context.resume
      ? SessionManager.open(context.sessionFile, sessionDirectory, context.cwd)
      : SessionManager.create(context.cwd, sessionDirectory);
    const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
      authPath: `${context.runtimeRoot}/.pi-agent/auth.json`,
      modelsPath: null,
      allowModelNetwork: false,
    });
    const created = await createAgentSession({
      cwd: context.cwd,
      agentDir: `${context.runtimeRoot}/.pi-agent`,
      ...(options.model ? { model: options.model } : {}),
      modelRuntime,
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      resourceLoader: createStrictResourceLoader(context, createExtensionRuntime),
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
      noTools: "all",
      tools: [],
    });
    const session = created.session;
    return Object.freeze({
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? context.sessionFile,
      prompt: async (text: string): Promise<string> => {
        let output = "";
        const unsubscribe = session.subscribe((event) => { output += assistantText(event); });
        try {
          await session.prompt(text, { expandPromptTemplates: false });
          await session.waitForIdle();
          return output;
        } finally {
          unsubscribe();
        }
      },
      abort: async (): Promise<void> => { await session.abort(); },
      dispose: (): void => { session.dispose(); },
    });
  };
}
