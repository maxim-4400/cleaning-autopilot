import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { DemoConsoleConfigStore, RuntimeConfigConflictError, RuntimeConfigProvenanceError, RuntimeConfigValidationError } from "@/lib/runtime-config/demo-console-config";
import shippedHistoryJson from "../../runtime-config/demo-console.baseline-history.json";

const fixtures: string[] = [];
const baselinePrompt = "Current shipped prompt";
const oldBaselinePrompt = "Prior shipped prompt";
const earliestProductionPromptHash = "0f9d5e54b0bdf361ef83d932438bd0325c7494e8ac3968b813343bfa7bd9c53f";

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DemoConsoleConfigStore", () => {
  it("uses the current version-controlled baseline until a validated active file is saved", async () => {
    const { store, activePath } = await fixture();
    const baseline = await store.load();

    expect(baseline.source).toBe("baseline");
    expect(baseline.systemPrompt).toBe(baselinePrompt);
    expect(baseline.sections.prompt).toMatchObject({ mode: "baseline", semanticRevision: "v2" });

    const saved = await store.save({
      systemPrompt: "A concise prompt for the presentation.",
      pricingRulesText: baseline.pricingRulesText.replace('"standardRateRsdPerM2": 80', '"standardRateRsdPerM2": 90'),
    });

    expect(saved.source).toBe("active");
    expect(saved.sections.prompt).toMatchObject({ mode: "custom", semanticRevision: "custom" });
    expect(saved.pricingRules.standardRateRsdPerM2).toBe(90);
    expect(JSON.parse(await readFile(activePath, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("upgrades a known legacy prompt to the latest baseline without changing the persisted v1 file", async () => {
    const { activePath, baselineConfig, store } = await fixture();
    await writeFile(activePath, JSON.stringify({ ...baselineConfig, systemPrompt: oldBaselinePrompt }), "utf8");

    const resolved = await store.load();

    expect(resolved.source).toBe("active");
    expect(resolved.systemPrompt).toBe(baselinePrompt);
    expect(resolved.sections.prompt).toMatchObject({ mode: "baseline", semanticRevision: "v2" });
    expect(JSON.parse(await readFile(activePath, "utf8")).systemPrompt).toBe(oldBaselinePrompt);
    await expect(readFile(`${activePath}.provenance.json`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an explicitly saved prompt custom even when it is byte-identical to a historical baseline", async () => {
    const { provenancePath, store } = await fixture();
    const initial = await store.load();

    const saved = await store.saveSection({ section: "prompt", expectedRevision: initial.sections.prompt.revision, systemPrompt: oldBaselinePrompt });
    const reloaded = await store.load();

    expect(saved.sections.prompt).toMatchObject({ mode: "custom", semanticRevision: "custom", shippedBaselineRevision: "v2" });
    expect(reloaded.systemPrompt).toBe(oldBaselinePrompt);
    expect(reloaded.sections.prompt.mode).toBe("custom");
    expect(JSON.parse(await readFile(provenancePath, "utf8"))).toMatchObject({ schemaVersion: 1, sections: { prompt: { sha256: hash(oldBaselinePrompt) } } });
  });

  it("ignores an interrupted or stale sidecar marker unless it matches the complete active v1 content", async () => {
    const { activePath, baselineConfig, provenancePath, store } = await fixture();
    await writeFile(activePath, JSON.stringify(baselineConfig), "utf8");
    await writeFile(provenancePath, JSON.stringify({
      schemaVersion: 1,
      sections: { prompt: { sha256: hash(oldBaselinePrompt) } },
    }), "utf8");

    const resolved = await store.load();

    expect(resolved.systemPrompt).toBe(baselinePrompt);
    expect(resolved.sections.prompt.mode).toBe("baseline");
  });

  it("preserves an existing historical-equal explicit override when the next active rename fails", async () => {
    const { activePath, baselineHistoryPath, baselinePath, provenancePath, store } = await fixture();
    const initial = await store.load();
    await store.saveSection({ section: "prompt", expectedRevision: initial.sections.prompt.revision, systemPrompt: oldBaselinePrompt });
    const beforeFailure = await store.load();
    const failingStore = new DemoConsoleConfigStore({
      baselinePath,
      baselineHistoryPath,
      activePath,
      provenancePath,
      beforeActiveRename: () => { throw new Error("simulated active rename failure"); },
    });

    await expect(failingStore.saveSection({ section: "prompt", expectedRevision: beforeFailure.sections.prompt.revision, systemPrompt: "A later custom prompt" })).rejects.toThrow("simulated active rename failure");

    const preserved = await store.load();
    expect(preserved.systemPrompt).toBe(oldBaselinePrompt);
    expect(preserved.sections.prompt).toMatchObject({ mode: "custom", semanticRevision: "custom" });
    expect(JSON.parse(await readFile(provenancePath, "utf8"))).toMatchObject({ sections: { prompt: { sha256: hash(oldBaselinePrompt), pendingSha256: hash("A later custom prompt") } } });
  });

  it("fails closed for a corrupted existing sidecar while allowing a missing legacy sidecar", async () => {
    const { activePath, baselineConfig, provenancePath, store } = await fixture();
    await writeFile(activePath, JSON.stringify({ ...baselineConfig, systemPrompt: oldBaselinePrompt }), "utf8");
    await writeFile(provenancePath, "{broken", "utf8");

    await expect(store.load()).rejects.toBeInstanceOf(RuntimeConfigProvenanceError);
  });

  it("fails closed when an existing sidecar cannot be read", async () => {
    const { activePath, baselineConfig, provenancePath, store } = await fixture();
    await writeFile(activePath, JSON.stringify({ ...baselineConfig, systemPrompt: oldBaselinePrompt }), "utf8");
    await mkdir(provenancePath);

    await expect(store.load()).rejects.toBeInstanceOf(RuntimeConfigProvenanceError);
  });

  it("ships every distinct legacy prompt hash and does not invent a duplicate pricing revision for identical content", () => {
    expect(shippedHistoryJson.sections.prompt.history.some((entry) => entry.sha256 === earliestProductionPromptHash)).toBe(true);
    expect(shippedHistoryJson.sections.pricing.history).toEqual([]);
  });

  it("preserves an unknown admin prompt while independently following the new pricing baseline", async () => {
    const { activePath, baselineConfig, store } = await fixture();
    await writeFile(activePath, JSON.stringify({ ...baselineConfig, systemPrompt: "Admin-owned prompt" }), "utf8");

    const resolved = await store.load();

    expect(resolved.systemPrompt).toBe("Admin-owned prompt");
    expect(resolved.sections.prompt).toMatchObject({ mode: "custom", semanticRevision: "custom" });
    expect(resolved.sections.pricing).toMatchObject({ mode: "baseline", semanticRevision: "v2" });
  });

  it("allows independent prompt and pricing saves while rejecting a stale draft for the same section", async () => {
    const { store } = await fixture();
    const initial = await store.load();
    const promptSaved = await store.saveSection({ section: "prompt", expectedRevision: initial.sections.prompt.revision, systemPrompt: "Only this prompt changed" });
    const pricingSaved = await store.saveSection({ section: "pricing", expectedRevision: initial.sections.pricing.revision, pricingRules: { ...initial.pricingRules, standardRateRsdPerM2: 81 } });

    expect(promptSaved.sections.prompt.mode).toBe("custom");
    expect(pricingSaved).toMatchObject({ systemPrompt: "Only this prompt changed" });
    expect(pricingSaved.pricingRules.standardRateRsdPerM2).toBe(81);
    await expect(store.saveSection({ section: "prompt", expectedRevision: initial.sections.prompt.revision, systemPrompt: "Stale draft" })).rejects.toBeInstanceOf(RuntimeConfigConflictError);
  });

  it("uses the section mode, semantic revision and content hash in a compare-and-swap token", async () => {
    const { store } = await fixture();
    const initial = await store.load();
    const staleDifferentMode = initial.sections.prompt.revision.replace(/^./, initial.sections.prompt.revision.startsWith("0") ? "1" : "0");
    await expect(store.saveSection({ section: "prompt", expectedRevision: staleDifferentMode, systemPrompt: "No write" })).rejects.toBeInstanceOf(RuntimeConfigConflictError);
  });

  it("resets only the requested section to the latest baseline and keeps the other custom section", async () => {
    const { store } = await fixture();
    const initial = await store.load();
    const promptSaved = await store.saveSection({ section: "prompt", expectedRevision: initial.sections.prompt.revision, systemPrompt: "Custom prompt" });
    const pricingSaved = await store.saveSection({ section: "pricing", expectedRevision: initial.sections.pricing.revision, pricingRules: { ...initial.pricingRules, standardRateRsdPerM2: 91 } });
    const reset = await store.resetSection({ section: "prompt", expectedRevision: pricingSaved.sections.prompt.revision });

    expect(promptSaved.sections.prompt.mode).toBe("custom");
    expect(reset.systemPrompt).toBe(baselinePrompt);
    expect(reset.sections.prompt).toMatchObject({ mode: "baseline", semanticRevision: "v2" });
    expect(reset.pricingRules.standardRateRsdPerM2).toBe(91);
    expect(reset.sections.pricing.mode).toBe("custom");
  });

  it("rejects invalid pricing without replacing the last valid active configuration", async () => {
    const { store } = await fixture();
    const baseline = await store.load();
    await store.save({ systemPrompt: "Saved prompt", pricingRulesText: baseline.pricingRulesText });
    await expect(store.save({ systemPrompt: "Bad", pricingRulesText: "{not json}" })).rejects.toBeInstanceOf(RuntimeConfigValidationError);
    expect((await store.load()).systemPrompt).toBe("Saved prompt");
  });

  it("falls back to the baseline when an active file is malformed", async () => {
    const { store, activePath } = await fixture();
    await writeFile(activePath, "{broken", "utf8");
    await expect(store.load()).resolves.toMatchObject({ source: "baseline", systemPrompt: baselinePrompt });
  });

  it("guards a shipped baseline when its versioned history does not match", async () => {
    const { activePath, baselineHistoryPath, baselinePath } = await fixture({ historyCurrentPromptHash: "0".repeat(64) });
    const store = new DemoConsoleConfigStore({ baselinePath, baselineHistoryPath, activePath });
    await expect(store.load()).rejects.toBeInstanceOf(RuntimeConfigValidationError);
  });

  it("serializes concurrent same-section writes so exactly one current revision wins", async () => {
    const { store } = await fixture();
    const initial = await store.load();
    const attempts = await Promise.allSettled([
      store.saveSection({ section: "prompt", expectedRevision: initial.sections.prompt.revision, systemPrompt: "First writer" }),
      store.saveSection({ section: "prompt", expectedRevision: initial.sections.prompt.revision, systemPrompt: "Second writer" }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected").every((attempt) => attempt.status === "rejected" && attempt.reason instanceof RuntimeConfigConflictError)).toBe(true);
  });
});

async function fixture(options: { historyCurrentPromptHash?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cleaning-demo-config-"));
  fixtures.push(directory);
  const baselinePath = join(directory, "baseline.json");
  const baselineHistoryPath = join(directory, "baseline-history.json");
  const activePath = join(directory, "runtime", "active.json");
  const baselineConfig = {
    schemaVersion: 1,
    systemPrompt: baselinePrompt,
    pricingRules: pricingRules(),
  };
  await mkdir(join(directory, "runtime"), { recursive: true });
  await writeFile(baselinePath, JSON.stringify(baselineConfig), "utf8");
  await writeFile(baselineHistoryPath, JSON.stringify({
    schemaVersion: 1,
    sections: {
      prompt: {
        current: { semanticRevision: "v2", sha256: options.historyCurrentPromptHash ?? hash(baselinePrompt) },
        history: [{ semanticRevision: "v1", sha256: hash(oldBaselinePrompt) }],
      },
      pricing: {
        current: { semanticRevision: "v2", sha256: hash(baselineConfig.pricingRules) },
        history: [{ semanticRevision: "v1", sha256: hash(baselineConfig.pricingRules) }],
      },
    },
  }), "utf8");
  const provenancePath = `${activePath}.provenance.json`;
  return { store: new DemoConsoleConfigStore({ baselinePath, baselineHistoryPath, activePath, provenancePath }), activePath, provenancePath, baselinePath, baselineHistoryPath, baselineConfig };
}

function pricingRules() {
  return {
    version: 1,
    standardRateRsdPerM2: 80,
    standardMinimumRsd: 4000,
    deepRateRsdPerM2: 160,
    deepMinimumRsd: 9000,
    extraBathroomRsd: 500,
    heavyPetHairRsd: 900,
    extrasRsd: { windows: 900, oven_inside: 1000, fridge_inside: 900, balcony_or_terrace: 1000 },
    sameDayMultiplierPercent: 120,
    volumeDiscountPercent: { upTo100: 0, from101To150: 5, from151To200: 10 },
  };
}

function hash(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
