import {
  type ClientData,
  type Extra,
  type HumanNeededReason,
  type PricingRules,
  type Quote,
  defaultPricingRules,
} from "@/lib/contracts/domain";

export type PricingDecision =
  | { kind: "quote"; quote: Quote }
  | { kind: "human_needed"; reason: HumanNeededReason }
  | { kind: "missing_data"; missingFields: Array<keyof ClientData> };

const requiredQuoteFields: Array<keyof ClientData> = [
  "cleaningType",
  "areaM2",
  "rooms",
  "bathrooms",
  "heavyPetHair",
  "extras",
  "addressOrDistrict",
  "preferredDate",
  "urgency",
];

type CompleteClientData = ClientData & Required<Pick<ClientData, (typeof requiredQuoteFields)[number]>>;

function hasValue<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function discountForArea(areaM2: number, rules: PricingRules): number {
  if (areaM2 <= 100) return rules.volumeDiscountPercent.upTo100;
  if (areaM2 <= 150) return rules.volumeDiscountPercent.from101To150;
  return rules.volumeDiscountPercent.from151To200;
}

function extrasSurcharge(selectedExtras: Extra[], rules: PricingRules): number {
  return selectedExtras.reduce((total, extra) => total + rules.extrasRsd[extra], 0);
}

export function roundToNearestHundredHalfUp(numerator: number, denominator = 1): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error("Pricing arithmetic must use positive safe integers");
  }

  return Math.floor((numerator + denominator * 50) / (denominator * 100)) * 100;
}

export function calculatePricingDecision(
  clientData: ClientData,
  rules: PricingRules = defaultPricingRules,
): PricingDecision {
  const missingFields = requiredQuoteFields.filter((field) => !hasValue(clientData[field]));

  if (missingFields.length > 0) {
    return { kind: "missing_data", missingFields };
  }

  const completeData = clientData as CompleteClientData;
  const { areaM2, cleaningType, bathrooms, heavyPetHair, extras: selectedExtras, urgency } = completeData;

  if (areaM2 > 200) {
    return { kind: "human_needed", reason: "area_over_200_m2" };
  }

  const areaHundredths = Math.round(areaM2 * 100);
  if (!Number.isSafeInteger(areaHundredths) || Math.abs(areaM2 * 100 - areaHundredths) >= 1e-7) {
    throw new Error("Area must have no more than two decimal places");
  }

  const rate = cleaningType === "standard" ? rules.standardRateRsdPerM2 : rules.deepRateRsdPerM2;
  const minimum = cleaningType === "standard" ? rules.standardMinimumRsd : rules.deepMinimumRsd;
  const baseHundredthsRsd = Math.max(areaHundredths * rate, minimum * 100);
  const baseRsd = baseHundredthsRsd / 100;
  const volumeDiscountPercent = discountForArea(areaM2, rules);
  const bathroomSurchargeRsd = (bathrooms - 1) * rules.extraBathroomRsd;
  const petHairSurchargeRsd = heavyPetHair ? rules.heavyPetHairRsd : 0;
  const extrasSurchargeRsd = extrasSurcharge(selectedExtras, rules);

  // Keep values as a rational number until the single contractually-defined rounding step.
  let numerator = baseHundredthsRsd * (100 - volumeDiscountPercent) +
    (bathroomSurchargeRsd + petHairSurchargeRsd + extrasSurchargeRsd) * 10_000;
  let denominator = 10_000;

  if (urgency === "same_day") {
    numerator *= rules.sameDayMultiplierPercent;
    denominator *= 100;
  }

  return {
    kind: "quote",
    quote: {
      amountRsd: roundToNearestHundredHalfUp(numerator, denominator),
      baseRsd,
      volumeDiscountPercent,
      bathroomSurchargeRsd,
      petHairSurchargeRsd,
      extrasSurchargeRsd,
      sameDayApplied: urgency === "same_day",
      pricingRulesVersion: rules.version,
    },
  };
}
