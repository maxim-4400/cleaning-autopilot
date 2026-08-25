import { z } from "zod";

export const cleaningTypes = ["standard", "deep"] as const;
export const extras = ["windows", "oven_inside", "fridge_inside", "balcony_or_terrace"] as const;
export const leadStatuses = ["new_lead", "qualified", "booked", "done", "lost"] as const;
export const integrationOperationStatuses = ["pending", "succeeded", "failed", "ambiguous"] as const;

export type CleaningType = (typeof cleaningTypes)[number];
export type Extra = (typeof extras)[number];
export type LeadStatus = (typeof leadStatuses)[number];
export type IntegrationOperationStatus = (typeof integrationOperationStatuses)[number];

export const clientDataSchema = z.object({
  cleaningType: z.enum(cleaningTypes).optional(),
  areaM2: z.number().positive().max(10_000).refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
    "Area must have no more than two decimal places",
  ).optional(),
  rooms: z.number().int().positive().max(100).optional(),
  bathrooms: z.number().int().positive().max(50).optional(),
  heavyPetHair: z.boolean().optional(),
  extras: z.array(z.enum(extras)).max(extras.length).optional(),
  addressOrDistrict: z.string().trim().min(2).max(300).optional(),
  preferredDate: z.string().date().optional(),
  urgency: z.enum(["standard", "same_day"]).optional(),
  preferredTimeWindow: z.enum(["morning", "midday", "evening"]).optional(),
});

export const clientDataPatchSchema = clientDataSchema.partial();

export type ClientData = z.infer<typeof clientDataSchema>;
export type ClientDataPatch = z.infer<typeof clientDataPatchSchema>;

export const humanNeededReasons = [
  "area_over_200_m2",
  "after_renovation",
  "commercial_property",
  "unusually_heavy_soiling",
  "unsupported_service",
  "scope_uncertain",
  "missing_required_data",
  "conversation_ambiguous",
  "delivery_failed",
  "delivery_ambiguous",
  "calendar_unavailable",
  "calendar_ambiguous",
  "trello_unavailable",
  "trello_ambiguous",
  "trello_terminal",
] as const;

export type HumanNeededReason = (typeof humanNeededReasons)[number];

export const pricingRulesSchema = z.object({
  version: z.number().int().positive(),
  standardRateRsdPerM2: z.number().int().positive(),
  standardMinimumRsd: z.number().int().positive(),
  deepRateRsdPerM2: z.number().int().positive(),
  deepMinimumRsd: z.number().int().positive(),
  extraBathroomRsd: z.number().int().nonnegative(),
  heavyPetHairRsd: z.number().int().nonnegative(),
  extrasRsd: z.object({
    windows: z.number().int().nonnegative(),
    oven_inside: z.number().int().nonnegative(),
    fridge_inside: z.number().int().nonnegative(),
    balcony_or_terrace: z.number().int().nonnegative(),
  }),
  sameDayMultiplierPercent: z.number().int().positive(),
  volumeDiscountPercent: z.object({
    upTo100: z.number().int().min(0).max(100),
    from101To150: z.number().int().min(0).max(100),
    from151To200: z.number().int().min(0).max(100),
  }),
}).strict();

export type PricingRules = z.infer<typeof pricingRulesSchema>;

export const defaultPricingRules: PricingRules = {
  version: 1,
  standardRateRsdPerM2: 80,
  standardMinimumRsd: 4_000,
  deepRateRsdPerM2: 160,
  deepMinimumRsd: 9_000,
  extraBathroomRsd: 500,
  heavyPetHairRsd: 900,
  extrasRsd: {
    windows: 900,
    oven_inside: 1_000,
    fridge_inside: 900,
    balcony_or_terrace: 1_000,
  },
  sameDayMultiplierPercent: 120,
  volumeDiscountPercent: {
    upTo100: 0,
    from101To150: 5,
    from151To200: 10,
  },
};

export const quoteSchema = z.object({
  amountRsd: z.number().int().positive(),
  baseRsd: z.number().positive(),
  volumeDiscountPercent: z.number().int().min(0).max(100),
  bathroomSurchargeRsd: z.number().int().nonnegative(),
  petHairSurchargeRsd: z.number().int().nonnegative(),
  extrasSurchargeRsd: z.number().int().nonnegative(),
  sameDayApplied: z.boolean(),
  pricingRulesVersion: z.number().int().positive(),
}).strict();

export type Quote = z.infer<typeof quoteSchema>;

export const cleaningTeams = ["team_a", "team_b"] as const;
export type CleaningTeam = (typeof cleaningTeams)[number];

export type AvailabilitySlot = {
  token: string;
  offerId: string;
  displayOrder: number;
  team: CleaningTeam;
  start: string;
  end: string;
  bufferEnd: string;
  label: string;
};

export type AgentToolName =
  | "update_client_data"
  | "calculate_quote"
  | "mark_human_needed"
  | "request_available_slots";

export type AgentToolResult = {
  name: AgentToolName;
  output: Record<string, unknown>;
};

export type AgentTurn = {
  reply: string;
  toolResults: AgentToolResult[];
  steps: number;
  /** Provider-reported aggregate only; it contains no response IDs or content. */
  usage?: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** SDK-provided input cache subtotal when the provider reports it. */
    cachedInputTokens: number;
  };
  /**
   * A run may have reached the provider before the SDK made its aggregate
   * usage available (for example, a turn-cap abort). Keep that uncertainty
   * explicit instead of treating an absent aggregate as zero usage.
   */
  usageUnreconciledReason?: string;
};

export type IntegrationOperation = {
  idempotencyKey: string;
  provider: "telegram" | "openai" | "google_calendar" | "trello";
  operationType: string;
  status: IntegrationOperationStatus;
  externalId?: string;
};
