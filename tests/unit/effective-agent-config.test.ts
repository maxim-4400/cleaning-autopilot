import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { defaultPricingRules, type PricingRules } from "@/lib/contracts/domain";
import { getEffectiveAgentConfig } from "@/lib/runtime-config/effective-agent-config";

const legacy = {
  version: 5,
  systemPrompt: "Legacy database prompt",
  pricingRules: defaultPricingRules,
};

describe("effective agent configuration", () => {
  it("uses the active file configuration for new turns without changing the legacy lead version", async () => {
    const pricingRules: PricingRules = { ...defaultPricingRules, standardRateRsdPerM2: 90 };
    const effective = await getEffectiveAgentConfig(legacy, {
      async load() {
        return {
          source: "active" as const,
          systemPrompt: "Active file prompt",
          pricingRules,
          pricingRulesText: JSON.stringify(pricingRules),
          revision: "a".repeat(64),
          sections: {
            prompt: { mode: "custom" as const, semanticRevision: "custom", shippedBaselineRevision: "mvp-0.9.1", sha256: "b".repeat(64), revision: "c".repeat(64) },
            pricing: { mode: "custom" as const, semanticRevision: "custom", shippedBaselineRevision: "mvp-0.9.1", sha256: "d".repeat(64), revision: "e".repeat(64) },
          },
        };
      },
    });

    expect(effective).toMatchObject({
      version: 5,
      systemPrompt: "Active file prompt",
      pricingRules,
      runtimeConfigSource: "active",
    });
    expect(legacy).toMatchObject({ version: 5, systemPrompt: "Legacy database prompt" });
  });

  it("fails safely back to the immutable database configuration", async () => {
    const effective = await getEffectiveAgentConfig(legacy, {
      async load() {
        throw new Error("mounted file unavailable");
      },
    });

    expect(effective).toMatchObject({
      systemPrompt: "Legacy database prompt",
      pricingRules: defaultPricingRules,
      runtimeConfigSource: "legacy",
    });
  });
});
