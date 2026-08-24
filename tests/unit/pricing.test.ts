import { describe, expect, it } from "vitest";

import { type ClientData, defaultPricingRules } from "@/lib/contracts/domain";
import { calculatePricingDecision, roundToNearestHundredHalfUp } from "@/lib/pricing/engine";

const completeClientData = (overrides: Partial<ClientData> = {}): ClientData => ({
  cleaningType: "standard",
  areaM2: 100,
  rooms: 3,
  bathrooms: 1,
  heavyPetHair: false,
  extras: [],
  addressOrDistrict: "Vracar",
  preferredDate: "2026-08-24",
  urgency: "standard",
  ...overrides,
});

function quotedAmount(overrides: Partial<ClientData> = {}): number {
  const result = calculatePricingDecision(completeClientData(overrides));
  expect(result.kind).toBe("quote");
  return result.kind === "quote" ? result.quote.amountRsd : 0;
}

describe("PricingEngine", () => {
  it("applies the standard minimum and deep minimum", () => {
    expect(quotedAmount({ cleaningType: "standard", areaM2: 40 })).toBe(4000);
    expect(quotedAmount({ cleaningType: "deep", areaM2: 40 })).toBe(9000);
  });

  it("adds bathrooms, pet hair, extras, discount, and same-day uplift deterministically", () => {
    expect(quotedAmount({
      areaM2: 151,
      bathrooms: 3,
      heavyPetHair: true,
      extras: ["windows", "oven_inside", "fridge_inside", "balcony_or_terrace"],
      urgency: "same_day",
    })).toBe(19_900);
  });

  it.each([
    ["windows", 900],
    ["oven_inside", 1000],
    ["fridge_inside", 900],
    ["balcony_or_terrace", 1000],
  ] as const)("prices the %s extra independently", (extra, surcharge) => {
    const result = calculatePricingDecision(completeClientData({ extras: [extra] }));
    expect(result).toMatchObject({ kind: "quote", quote: { extrasSurchargeRsd: surcharge } });
  });

  it("prices an extra bathroom and heavy pet hair independently", () => {
    expect(calculatePricingDecision(completeClientData({ bathrooms: 2 }))).toMatchObject({
      kind: "quote",
      quote: { bathroomSurchargeRsd: 500, petHairSurchargeRsd: 0 },
    });
    expect(calculatePricingDecision(completeClientData({ heavyPetHair: true }))).toMatchObject({
      kind: "quote",
      quote: { bathroomSurchargeRsd: 0, petHairSurchargeRsd: 900 },
    });
  });

  it.each([
    [100, 8000, 0],
    [101, 7700, 5],
    [150, 11_400, 5],
    [151, 10_900, 10],
    [200, 14_400, 10],
  ])("uses the contract discount boundary at %i m²", (areaM2, amountRsd, discount) => {
    const result = calculatePricingDecision(completeClientData({ areaM2 }));
    expect(result).toMatchObject({ kind: "quote", quote: { amountRsd, volumeDiscountPercent: discount } });
  });

  it("rounds positive midpoint values up and otherwise to the nearest hundred", () => {
    expect(roundToNearestHundredHalfUp(10_050)).toBe(10_100);
    expect(roundToNearestHundredHalfUp(10_049)).toBe(10_000);
    expect(roundToNearestHundredHalfUp(10_051)).toBe(10_100);
  });

  it("escalates over-200 m² work and preserves missing-data state", () => {
    expect(calculatePricingDecision(completeClientData({ areaM2: 200.01 }))).toEqual({
      kind: "human_needed",
      reason: "area_over_200_m2",
    });
    expect(calculatePricingDecision({ cleaningType: "standard" })).toMatchObject({ kind: "missing_data" });
  });

  it("honours a supplied versioned rule set", () => {
    const result = calculatePricingDecision(completeClientData(), { ...defaultPricingRules, version: 42 });
    expect(result).toMatchObject({ kind: "quote", quote: { pricingRulesVersion: 42 } });
  });
});
