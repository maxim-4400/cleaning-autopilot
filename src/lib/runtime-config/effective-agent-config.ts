import "server-only";

import type { StoredAgentConfig } from "@/lib/leads/repository";
import { DemoConsoleConfigStore, getDemoConsoleConfigStore } from "@/lib/runtime-config/demo-console-config";

export type EffectiveAgentConfig = StoredAgentConfig & {
  runtimeConfigSource: "legacy" | "baseline" | "active";
};

/**
 * Applies the local presentation configuration to future agent turns only.
 * Existing lead records retain their legacy DB version and, once quoted, their
 * persisted `pricingRulesSnapshot`; neither historical reference is mutated.
 * A malformed or temporarily unavailable file fails safely back to the
 * immutable legacy configuration instead of interrupting customer handling.
 */
export async function getEffectiveAgentConfig(
  legacyConfig: StoredAgentConfig,
  store: Pick<DemoConsoleConfigStore, "load"> = getDemoConsoleConfigStore(),
): Promise<EffectiveAgentConfig> {
  try {
    const runtimeConfig = await store.load();
    return {
      ...legacyConfig,
      systemPrompt: runtimeConfig.systemPrompt,
      pricingRules: runtimeConfig.pricingRules,
      runtimeConfigSource: runtimeConfig.source,
    };
  } catch {
    return { ...legacyConfig, runtimeConfigSource: "legacy" };
  }
}
