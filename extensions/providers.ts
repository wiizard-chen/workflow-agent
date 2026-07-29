/**
 * providers.ts — workflow model/provider registration shared by the main Pi
 * session and pi-subagents child sessions.
 *
 * Child agents do not automatically inherit providers registered in the
 * parent process. They use Pi's builtin provider registry with qualified model
 * IDs; this module bridges the workflow's legacy GLM5_2_API_KEY name to the
 * builtin ZAI_API_KEY before child processes are spawned.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowConfig } from "./lib.ts";
import { loadConfig, parseProfileEntry, parseQualifiedModel } from "./workflow/runtime.ts";

function loadProviderConfig(): WorkflowConfig {
  return loadConfig();
}

export function registerWorkflowProviders(
  pi: ExtensionAPI,
  config: WorkflowConfig = loadProviderConfig(),
): void {
  // Pi's builtin Z.AI provider (used by fresh pi-subagents children) reads
  // ZAI_API_KEY. The workflow historically exposed GLM5_2_API_KEY instead.
  // Bridge the alias in the parent process before any child is spawned; child
  // processes inherit it, so package installs work in arbitrary target repos
  // without fragile relative extension paths in agent frontmatter.
  if (!process.env.ZAI_API_KEY && process.env.GLM5_2_API_KEY) {
    process.env.ZAI_API_KEY = process.env.GLM5_2_API_KEY;
  }

  const byProvider = new Map<string, Set<string>>();
  for (const [profileName, profile] of Object.entries(config.modelProfiles)) {
    for (const key of ["main", "prd", "dev", "reviewer", "finalReviewer"] as const) {
      const entry = parseProfileEntry(profile[key], key, profileName);
      const role = parseQualifiedModel(entry.model, entry.effort);
      if (!config.providers[role.provider]) continue; // builtin provider, e.g. codex2api
      if (!byProvider.has(role.provider)) byProvider.set(role.provider, new Set());
      byProvider.get(role.provider)!.add(role.model);
    }
  }

  for (const [providerName, modelIds] of byProvider) {
    const provider = config.providers[providerName];
    if (!provider) continue;
    const models = [...modelIds].map((id) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: id.startsWith("deepseek") ? 1_000_000 : 200_000,
      maxTokens: 8192,
      compat: provider.thinkingFormat
        ? ({ thinkingFormat: provider.thinkingFormat } as any)
        : undefined,
    }));
    pi.registerProvider(providerName, {
      baseUrl: provider.baseUrl,
      apiKey: `$${provider.apiKeyEnv}`,
      api: provider.api as any,
      models,
    });
  }
}

export default function providersExtension(pi: ExtensionAPI): void {
  registerWorkflowProviders(pi);
}
