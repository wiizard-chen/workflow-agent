/**
 * providers.ts — workflow model/provider registration shared by the main Pi
 * session and pi-subagents child sessions.
 *
 * Child agents do not automatically inherit providers registered in the
 * parent process. They use Pi's builtin provider registry with qualified model
 * IDs; this module bridges the workflow's legacy GLM5_2_API_KEY name to the
 * builtin ZAI_API_KEY before child processes are spawned.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowConfig } from "./lib.ts";

const DEFAULT_PROVIDER_CONFIG: Pick<WorkflowConfig, "providers" | "roles"> = {
  providers: {
    deepseek: {
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      api: "openai-completions",
      thinkingFormat: "deepseek",
    },
    zai: {
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      apiKeyEnv: "GLM5_2_API_KEY",
      api: "openai-completions",
      thinkingFormat: "zai",
    },
  },
  roles: {
    discuss: { provider: "deepseek", model: "deepseek-v4-pro" },
    prd: { provider: "zai", model: "glm-5.2" },
    split: { provider: "deepseek", model: "deepseek-v4-pro" },
    review: { provider: "zai", model: "glm-5.2" },
  },
};

function loadProviderConfig(): Pick<WorkflowConfig, "providers" | "roles"> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, "..", "workflow.config.json"),
      path.join(here, "workflow.config.json"),
      path.join(process.cwd(), "workflow.config.json"),
    ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
      return {
        providers: { ...DEFAULT_PROVIDER_CONFIG.providers, ...(raw.providers || {}) },
        roles: { ...DEFAULT_PROVIDER_CONFIG.roles, ...(raw.roles || {}) },
      };
    }
  } catch (_e) {
    // Fall back to the checked-in defaults. Missing credentials still fail
    // loudly when Pi attempts to select/use the model.
  }
  return DEFAULT_PROVIDER_CONFIG;
}

export function registerWorkflowProviders(
  pi: ExtensionAPI,
  config: Pick<WorkflowConfig, "providers" | "roles"> = loadProviderConfig(),
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
  for (const role of Object.values(config.roles)) {
    if (!byProvider.has(role.provider)) byProvider.set(role.provider, new Set());
    byProvider.get(role.provider)!.add(role.model);
  }

  // Models used only by child agent definitions still need to be present in
  // the registry even when they are not selected by a main-session role.
  const childModels: Record<string, string[]> = {
    deepseek: ["deepseek-v4-flash"],
  };
  for (const [provider, ids] of Object.entries(childModels)) {
    if (!byProvider.has(provider)) byProvider.set(provider, new Set());
    for (const id of ids) byProvider.get(provider)!.add(id);
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
