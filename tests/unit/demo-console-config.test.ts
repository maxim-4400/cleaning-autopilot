import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { DemoConsoleConfigStore, RuntimeConfigConflictError, RuntimeConfigValidationError } from "@/lib/runtime-config/demo-console-config";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DemoConsoleConfigStore", () => {
  it("uses the version-controlled baseline until a validated active file is saved", async () => {
    const { store, activePath } = await fixture();

    const baseline = await store.load();
    expect(baseline.source).toBe("baseline");
    expect(baseline.pricingRules.standardRateRsdPerM2).toBe(80);

    const saved = await store.save({
      systemPrompt: "A concise prompt for the presentation.",
      pricingRulesText: baseline.pricingRulesText.replace('"standardRateRsdPerM2": 80', '"standardRateRsdPerM2": 90'),
    });

    expect(saved.source).toBe("active");
    expect(saved.systemPrompt).toBe("A concise prompt for the presentation.");
    expect(saved.pricingRules.standardRateRsdPerM2).toBe(90);
    expect(JSON.parse(await readFile(activePath, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("rejects invalid pricing without replacing the last valid active configuration", async () => {
    const { store } = await fixture();
    const baseline = await store.load();
    await store.save({ systemPrompt: "Saved prompt", pricingRulesText: baseline.pricingRulesText });

    await expect(store.save({ systemPrompt: "Bad", pricingRulesText: "{not json}" })).rejects.toBeInstanceOf(RuntimeConfigValidationError);

    expect((await store.load()).systemPrompt).toBe("Saved prompt");
  });

  it("writes the baseline atomically when reset is requested", async () => {
    const { store } = await fixture();
    const baseline = await store.load();
    await store.save({ systemPrompt: "Temporary prompt", pricingRulesText: baseline.pricingRulesText });

    const reset = await store.resetToBaseline();

    expect(reset.source).toBe("active");
    expect(reset.systemPrompt).toBe(baseline.systemPrompt);
    expect(reset.pricingRulesText).toBe(baseline.pricingRulesText);
  });

  it("falls back to the baseline when an active file is corrupted", async () => {
    const { store, activePath } = await fixture();
    const baseline = await store.load();
    await store.save({ systemPrompt: "Valid first", pricingRulesText: baseline.pricingRulesText });
    await writeFile(activePath, "{broken", "utf8");
    expect(await store.load()).toMatchObject({ source: "baseline", systemPrompt: "Baseline prompt" });
  });

  it("saves one section atomically without overwriting the other and rejects a stale draft", async () => {
    const { store } = await fixture();
    const baseline = await store.load();
    const promptSaved = await store.saveSection({ section: "prompt", expectedRevision: baseline.revision, systemPrompt: "Only this prompt changed" });
    expect(promptSaved.systemPrompt).toBe("Only this prompt changed");
    expect(promptSaved.pricingRules).toEqual(baseline.pricingRules);
    await expect(store.saveSection({ section: "pricing", expectedRevision: baseline.revision, pricingRules: baseline.pricingRules })).rejects.toBeInstanceOf(RuntimeConfigConflictError);
    await expect(store.saveSection({ section: "pricing", expectedRevision: promptSaved.revision, pricingRules: { ...baseline.pricingRules, standardRateRsdPerM2: -1 } })).rejects.toBeInstanceOf(RuntimeConfigValidationError);
    expect((await store.load()).systemPrompt).toBe("Only this prompt changed");
  });

  it("serializes simultaneous compare-and-swap writes so only one stale revision wins", async () => {
    const { store } = await fixture();
    const baseline = await store.load();
    const attempts = await Promise.allSettled([
      store.saveSection({ section: "prompt", expectedRevision: baseline.revision, systemPrompt: "First writer" }),
      store.saveSection({ section: "pricing", expectedRevision: baseline.revision, pricingRules: { ...baseline.pricingRules, standardRateRsdPerM2: 81 } }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected").every((attempt) => attempt.status === "rejected" && attempt.reason instanceof RuntimeConfigConflictError)).toBe(true);
    const active = await store.load();
    expect(active.systemPrompt === "First writer" || active.pricingRules.standardRateRsdPerM2 === 81).toBe(true);
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cleaning-demo-config-"));
  fixtures.push(directory);
  const baselinePath = join(directory, "baseline.json");
  const activePath = join(directory, "runtime", "active.json");
  await writeFile(baselinePath, JSON.stringify({
    schemaVersion: 1,
    systemPrompt: "Baseline prompt",
    pricingRules: {
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
    },
  }), "utf8");
  return { store: new DemoConsoleConfigStore({ baselinePath, activePath }), activePath };
}
