import { Agent, MaxTurnsExceededError, OpenAIProvider, retryPolicies, Runner, tool, type Model, type ModelProvider } from "@openai/agents";
import OpenAI from "openai";
import { z } from "zod";

import { defaultPricingRules, type AgentToolName, type AgentToolResult, type AgentTurn, type ClientData, type CurrentTurnDateCoordinate, type PricingRules, type SchedulingSemanticAction } from "@/lib/contracts/domain";
import type { StoredAvailabilityAttempt } from "@/lib/leads/repository";
import { isRussianLanguage, isSerbianCyrillic, isSerbianLanguage, type ReplyLanguage } from "@/lib/telegram/language";

export type AgentToolExecutor = (name: AgentToolName, argumentsJson: unknown) => Promise<Record<string, unknown>>;

/**
 * Safe, server-derived state supplied to the one scheduling agent. It has no
 * Calendar IDs, slot tokens or provider payloads: the agent can reason about
 * the customer-visible situation while the backend remains the source of
 * truth for the actual availability query and reservation.
 */
export type SchedulingSnapshot = {
  state: "intake" | "quoted" | "offered" | "reserved_pending_trello" | "booked" | "human_needed";
  /** Server-derived Europe/Belgrade date for relative-language interpretation. */
  currentDate: string;
  preferredDate?: string;
  preferredTimeWindow?: "morning" | "midday" | "evening";
  /** Current-message-only date; never a durable lead or Conversation fact. */
  currentTurnDateCoordinate?: CurrentTurnDateCoordinate;
  /** Current server-owned amount for a fresh post-availability Conversation. */
  activeQuoteAmountRsd?: number;
  lastOffer?: {
    dates: string[];
    labels: string[];
  };
  /** Latest validated Calendar search outcome. It is context only: every
   * later availability question must still invoke the Calendar tool. */
  lastAvailabilityAttempt?: StoredAvailabilityAttempt;
  policy: {
    timezone: "Europe/Belgrade";
    workingHours: "Mon-Sat 08:00-20:00; Sunday closed";
    searchHorizonDays: 14;
  };
};

export type AgentTurnInput = {
  conversationId: string;
  systemPrompt: string;
  message: string;
  replyLanguage: ReplyLanguage;
  knownClientData: ClientData;
  /**
   * The model may explain the currently active rules, but calculations remain
   * backend-owned through calculate_quote. Keeping the full rule snapshot in
   * the turn also makes a later date change (for example same-day +20%)
   * understandable without asking the customer to repeat their order.
   */
  pricingRules?: PricingRules;
  /** Backend-derived capabilities for this one customer turn. */
  allowedTools?: readonly AgentToolName[];
  /**
   * A quoted/offered turn must use either a semantic Calendar request or a
   * typed no-Calendar decision. The production SDK gateway enforces this
   * after the model run; injected deterministic test agents need not mimic
   * model-loop enforcement.
   */
  schedulingDecisionRequired?: boolean;
  /** Authoritative, privacy-safe scheduling context for this customer turn. */
  schedulingSnapshot?: SchedulingSnapshot;
  /** Evaluator-owned cancellation; production callers may omit it. */
  signal?: AbortSignal;
  executeTool: AgentToolExecutor;
};

export interface AgentGateway {
  createConversation(leadId: string, signal?: AbortSignal): Promise<{ id: string }>;
  runTurn(input: AgentTurnInput): Promise<AgentTurn>;
}

const updateClientDataParameters = z.object({
  patch: z.object({
    cleaningType: z.enum(["standard", "deep"]).nullable(),
    areaM2: z.number().positive().nullable(),
    rooms: z.number().int().positive().nullable(),
    bathrooms: z.number().int().positive().nullable(),
    heavyPetHair: z.boolean().nullable(),
    extras: z.array(z.enum(["windows", "oven_inside", "fridge_inside", "balcony_or_terrace"])).nullable(),
    addressOrDistrict: z.string().nullable(),
    preferredDate: z.string().nullable(),
  }).strict(),
}).strict();

const humanNeededParameters = z.object({
  reason: z.enum([
    "after_renovation",
    "commercial_property",
    "unusually_heavy_soiling",
    "unsupported_service",
    "scope_uncertain",
    "missing_required_data",
  ]),
}).strict();

const calculateQuoteParameters = z.object({}).strict();
const localTimeSchema = z.string().regex(/^(?:0[89]|1[0-9]):(?:00|30)$/u);
export const schedulingAvailabilityIntentSchema = z.object({
  dateReference: z.enum([
    "current_preferred_date",
    "today",
    "tomorrow",
    "same_day_as_last_offer",
    "day_after_last_offer",
    "exact_date",
  ]),
  exactDate: z.string().date().optional(),
  timePreference: z.enum([
    "any",
    "morning",
    "midday",
    "evening",
    "after",
    "before",
    "range",
  ]),
  /** A date-only follow-up may retain a previous time window. Explicit `any`
   * means the customer has removed that constraint. */
  timePreferenceMode: z.enum(["preserve", "explicit"]),
  relation: z.enum(["fresh", "later_than_last_offer"]).default("fresh"),
  /** The model owns whether an existing customer-visible offer is retained or
   * explicitly rejected. The backend verifies it against actual active tokens. */
  // Provider wire input is required by the strict schema below. This executor
  // seam also supports injected deterministic gateways, which predate V34;
  // resolver derives their only safe disposition from actual active tokens.
  existingOfferDisposition: z.enum(["none", "retain_until_replacement", "reject_now"]).optional(),
  afterLocalTime: localTimeSchema.optional(),
  beforeLocalTime: localTimeSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.timePreferenceMode === "preserve" && value.timePreference !== "any") {
    context.addIssue({ code: "custom", message: "preserve requires timePreference any" });
  }
  if (value.dateReference === "exact_date" && !value.exactDate) {
    context.addIssue({ code: "custom", message: "exactDate is required for exact_date" });
  }
  if (value.dateReference !== "exact_date" && value.exactDate) {
    context.addIssue({ code: "custom", message: "exactDate is only allowed for exact_date" });
  }
  if (value.timePreference === "after" && !value.afterLocalTime) {
    context.addIssue({ code: "custom", message: "afterLocalTime is required for after" });
  }
  if (value.timePreference === "before" && !value.beforeLocalTime) {
    context.addIssue({ code: "custom", message: "beforeLocalTime is required for before" });
  }
  if (value.timePreference === "range" && (!value.afterLocalTime || !value.beforeLocalTime || value.afterLocalTime >= value.beforeLocalTime)) {
    context.addIssue({ code: "custom", message: "range requires an ordered local time range" });
  }
  if (!["after", "range"].includes(value.timePreference) && value.afterLocalTime) {
    context.addIssue({ code: "custom", message: "afterLocalTime is not valid for this preference" });
  }
  if (!["before", "range"].includes(value.timePreference) && value.beforeLocalTime) {
    context.addIssue({ code: "custom", message: "beforeLocalTime is not valid for this preference" });
  }
  if (value.timePreferenceMode === "preserve" && (value.afterLocalTime || value.beforeLocalTime)) {
    context.addIssue({ code: "custom", message: "preserve cannot include an explicit time boundary" });
  }
});
export type SchedulingAvailabilityIntent = z.infer<typeof schedulingAvailabilityIntentSchema>;

const requestAvailableSlotsParameters = z.object({ intent: schedulingAvailabilityIntentSchema }).strict();
/**
 * Provider wire schema for availability is deliberately discriminated rather
 * than a collection of optional coordinates. A strict function schema then
 * makes impossible cross-shapes (for example, `preserve + evening` or an
 * exact date without its date) invalid before the deterministic executor.
 */
const providerAvailabilityDateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum([
      "current_preferred_date",
      "today",
      "tomorrow",
      "same_day_as_last_offer",
      "day_after_last_offer",
    ]),
  }).strict(),
  z.object({ kind: z.literal("exact_date"), exactDate: z.string().date() }).strict(),
]);
const providerAvailabilityTimeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preserve") }).strict(),
  z.object({ kind: z.literal("any") }).strict(),
  z.object({ kind: z.literal("morning") }).strict(),
  z.object({ kind: z.literal("midday") }).strict(),
  z.object({ kind: z.literal("evening") }).strict(),
  z.object({ kind: z.literal("after"), afterLocalTime: localTimeSchema }).strict(),
  z.object({ kind: z.literal("before"), beforeLocalTime: localTimeSchema }).strict(),
  z.object({ kind: z.literal("range"), afterLocalTime: localTimeSchema, beforeLocalTime: localTimeSchema }).strict(),
]);
const providerAvailabilityIntentSchema = z.object({
  date: providerAvailabilityDateSchema,
  time: providerAvailabilityTimeSchema,
  relation: z.enum(["fresh", "later_than_last_offer"]),
  existingOfferDisposition: z.enum(["none", "retain_until_replacement", "reject_now"]),
}).strict();
export const requestAvailableSlotsProviderParameters = z.object({ intent: providerAvailabilityIntentSchema }).strict();

function requestAvailableSlotsProviderParametersForSnapshot(snapshot: SchedulingSnapshot | undefined) {
  const coordinate = snapshot?.currentTurnDateCoordinate;
  // A date said in this customer message is the exclusive coordinate for this
  // availability request. Never offer a stale preferred date or old offer as
  // an alternative in the same provider surface.
  if (coordinate) {
    const date = coordinate.recommendedDateReference === "today"
      ? z.object({ kind: z.literal("today") }).strict()
      : coordinate.recommendedDateReference === "tomorrow"
        ? z.object({ kind: z.literal("tomorrow") }).strict()
        : z.object({ kind: z.literal("exact_date"), exactDate: z.literal(coordinate.date) }).strict();
    return z.object({ intent: z.object({
      date,
      time: providerAvailabilityTimeSchema,
      relation: z.enum(["fresh", "later_than_last_offer"]),
      existingOfferDisposition: z.enum(["none", "retain_until_replacement", "reject_now"]),
    }).strict() }).strict();
  }

  const choices: z.ZodTypeAny[] = [];
  if (snapshot?.preferredDate) choices.push(z.object({ kind: z.literal("current_preferred_date") }).strict());
  if (snapshot?.lastOffer) {
    choices.push(z.object({ kind: z.literal("same_day_as_last_offer") }).strict());
    choices.push(z.object({ kind: z.literal("day_after_last_offer") }).strict());
  }
  // A safe attempt is not a durable preferred date, but its candidate is a
  // separately auditable exact coordinate. Keep it available alongside old
  // durable references so a time-only refinement after no-slots/failure can
  // re-read the date that was actually checked rather than drifting back.
  if (snapshot?.lastAvailabilityAttempt?.candidateDate) {
    choices.push(z.object({ kind: z.literal("exact_date"), exactDate: z.literal(snapshot.lastAvailabilityAttempt.candidateDate) }).strict());
  }
  const date = choices.length === 0
    // The tool is disabled below when no date coordinate exists. Keep this
    // fallback schema representable so the SDK can construct the Agent before
    // filtering disabled tools.
    ? providerAvailabilityDateSchema
    : choices.length === 1
    ? choices[0]!
    : z.union(choices as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  return z.object({ intent: z.object({
    date,
    time: providerAvailabilityTimeSchema,
    relation: z.enum(["fresh", "later_than_last_offer"]),
    existingOfferDisposition: z.enum(["none", "retain_until_replacement", "reject_now"]),
  }).strict() }).strict();
}

function hasAvailabilityDateCoordinate(snapshot: SchedulingSnapshot | undefined): boolean {
  return Boolean(snapshot?.preferredDate || snapshot?.lastOffer || snapshot?.currentTurnDateCoordinate || snapshot?.lastAvailabilityAttempt?.candidateDate);
}

/**
 * Evidence-bound provider contract for the only Calendar-search function.
 * The wire shape is intentionally more constrained than the canonical
 * backend intent; `normalizeProviderAvailabilityParameters` is its sole
 * adapter and the canonical schema remains the final authority.
 */
export const availabilityProviderEnvelopeConfig = {
  revision: "v36.2-current-turn-exclusive-last-attempt-exact-alongside-durable-refs",
  root: "{intent:{date,time,relation,existingOfferDisposition}}",
  strict: true,
  dateKinds: ["current_preferred_date", "today", "tomorrow", "same_day_as_last_offer", "day_after_last_offer", "exact_date"] as const,
  timeKinds: ["preserve", "any", "morning", "midday", "evening", "after", "before", "range"] as const,
  relationKinds: ["fresh", "later_than_last_offer"] as const,
  existingOfferDispositionKinds: ["none", "retain_until_replacement", "reject_now"] as const,
  preserveNormalization: "any_preserve",
  otherTimeNormalization: "explicit",
  canonicalValidation: "schedulingAvailabilityIntentSchema",
  currentTurnDateCoordinate: "exclusive_when_present",
  lastAvailabilityAttemptFallback: "exact_candidate_date_alongside_durable_refs_without_current_coordinate",
} as const;

function normalizeProviderAvailabilityIntent(intent: z.infer<typeof providerAvailabilityIntentSchema>): SchedulingAvailabilityIntent | undefined {
  const date = intent.date.kind === "exact_date"
    ? { dateReference: "exact_date" as const, exactDate: intent.date.exactDate }
    : { dateReference: intent.date.kind };
  const time = intent.time.kind === "preserve"
    ? { timePreference: "any" as const, timePreferenceMode: "preserve" as const }
    : intent.time.kind === "after"
      ? { timePreference: "after" as const, timePreferenceMode: "explicit" as const, afterLocalTime: intent.time.afterLocalTime }
      : intent.time.kind === "before"
        ? { timePreference: "before" as const, timePreferenceMode: "explicit" as const, beforeLocalTime: intent.time.beforeLocalTime }
        : intent.time.kind === "range"
          ? { timePreference: "range" as const, timePreferenceMode: "explicit" as const, afterLocalTime: intent.time.afterLocalTime, beforeLocalTime: intent.time.beforeLocalTime }
          : { timePreference: intent.time.kind, timePreferenceMode: "explicit" as const };
  const parsed = schedulingAvailabilityIntentSchema.safeParse({
    ...date,
    ...time,
    relation: intent.relation,
    existingOfferDisposition: intent.existingOfferDisposition,
  });
  return parsed.success ? parsed.data : undefined;
}

function normalizeProviderAvailabilityParameters(argumentsJson: unknown): z.infer<typeof requestAvailableSlotsParameters> | undefined {
  const parsed = requestAvailableSlotsProviderParameters.safeParse(argumentsJson);
  if (!parsed.success) return undefined;
  const intent = normalizeProviderAvailabilityIntent(parsed.data.intent);
  if (!intent) return undefined;
  const canonical = requestAvailableSlotsParameters.safeParse({ intent });
  return canonical.success ? canonical.data : undefined;
}
const schedulingDecisionParameters = z.object({
  reason: z.enum([
    "question_not_about_scheduling",
    "date_or_time_preference_missing",
    "awaiting_customer_choice",
    "already_reserved",
    "human_review_in_progress",
  ]),
}).strict();

/** Never allow a customer turn to perform more than this many semantic tools. */
export const maxAgentToolSteps = 4;
/** Bound each Responses model turn; the evaluator records and enforces this cap. */
export const maxAgentOutputTokens = 1200;
export const providerReplayInstructionRevision = "v23-stateless-full-primary-provider-replay";
/** The replay deliberately reuses the complete primary instruction verbatim. */
export const providerReplayPromptContract = "same_full_primary_instruction";
/** Canonical one-shot transport recovery boundary; no omission replay stacks on it. */
export const providerReplayConfig = {
  revision: providerReplayInstructionRevision,
  promptContract: providerReplayPromptContract,
  stateless: true,
  maxReplayAttempts: 1,
  primaryMaxDurationMs: 9_000,
  replayMaxDurationMs: 6_000,
  maxTurns: 4,
  parallelToolCalls: false,
  maxFunctionToolConcurrency: 1,
  noSchedulingOmissionReplayStacking: true,
} as const;
/**
 * A zero-tool required-state turn is a semantic omission, not a reason to
 * parse natural language in the backend. Re-run the complete primary agent
 * statelessly once, with the same full prompt and tool surface, so it can
 * update validated details, quote, or use the canonical scheduling tools.
 */
export const schedulingOmissionReplayInstructionRevision = "v30-stateless-full-primary-scheduling-omission-replay";
export const schedulingOmissionReplayPromptContract = "same_full_primary_instruction";
export const schedulingOmissionReplayConfig = {
  revision: schedulingOmissionReplayInstructionRevision,
  promptContract: schedulingOmissionReplayPromptContract,
  stateless: true,
  maxReplayAttempts: 1,
  maxDurationMs: 9_000,
  maxTurns: 4,
  parallelToolCalls: false,
  maxFunctionToolConcurrency: 1,
  noProviderFailureReplayStacking: true,
  noRecursion: true,
} as const;
/**
 * Calendar availability is rendered exclusively by the webhook after its
 * executor has produced a safe backend-owned result. Stopping only this tool
 * avoids an unnecessary model closure request while keeping every other tool
 * conversational.
 */
export const availabilityTerminalToolConfig = {
  toolName: "request_available_slots",
  toolUseBehavior: { stopAtToolNames: ["request_available_slots"] },
  terminalAfterSafeExecutorResult: true,
  resetConversationBeforeDeferredCommit: true,
} as const;

export type OpenAiAgentsGatewayOptions = {
  /** Production keeps one provider retry; a paid evaluator sets this to zero. */
  maxResponseRetries?: 0 | 1;
  /** Conversation creation is an external POST and has its own bounded retry policy. */
  maxConversationCreateAttempts?: 1 | 2;
  maxOutputTokens?: number;
  /** Optional bound for every provider request; only the evaluator sets it. */
  requestTimeoutMs?: number;
  /** Paid evaluator narrows this below the normal production tool-loop bound. */
  maxResponsesPerTurn?: number;
  /**
   * Optional evaluator-owned counter at the actual Responses model boundary.
   * It is intentionally not used by ordinary production traffic.
   */
  responseRequestCounter?: ResponseRequestCounter;
};

/** Counts actual SDK model requests, immediately before the provider call. */
export interface ResponseRequestCounter {
  beforeResponseRequest(): void;
}

/**
 * A model-loop ceiling is an operational failure, not evidence that this
 * customer needs a person. Callers must stop this Conversation and surface it
 * through their normal technical recovery path instead of creating a false
 * Human Needed handoff.
 */
export class AgentTurnTechnicalError extends Error {
  constructor(
    /**
     * Customer-safe operational category.  Never put provider messages,
     * request bodies or customer data in this value: it is retained by the
     * evaluator and may be shown in operational evidence.
     */
    readonly code: AgentTurnTechnicalCode,
    readonly usage?: AgentTurn["usage"],
    readonly usageUnreconciledReason?: string,
  ) {
    super(code);
  }
}

export type AgentTurnTechnicalCode =
  | "agent_max_turns_exceeded"
  | "agent_duplicate_update_client_data"
  | "agent_quote_recalculation_missing"
  | "agent_invalid_availability_arguments"
  | "agent_scheduling_decision_missing"
  | "agent_tool_execution_failed"
  | "agent_provider_timeout"
  | "agent_provider_http_error"
  | "agent_provider_transport_error"
  | "agent_provider_sdk_error";

export class OpenAiAgentsGateway implements AgentGateway {
  private readonly runner: Runner;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly reasoningEffort: "low" = "low",
    private readonly maxToolSteps = maxAgentToolSteps,
    options: OpenAiAgentsGatewayOptions = {},
  ) {
    if (!Number.isInteger(maxToolSteps) || maxToolSteps < 1 || maxToolSteps > maxAgentToolSteps) {
      throw new Error(`maxToolSteps must be between 1 and ${maxAgentToolSteps}`);
    }
    if (!Number.isInteger(options.maxOutputTokens ?? maxAgentOutputTokens) || (options.maxOutputTokens ?? maxAgentOutputTokens) < 1 || (options.maxOutputTokens ?? maxAgentOutputTokens) > maxAgentOutputTokens) {
      throw new Error(`maxOutputTokens must be between 1 and ${maxAgentOutputTokens}`);
    }
    if (options.requestTimeoutMs !== undefined && (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1 || options.requestTimeoutMs > 120_000)) {
      throw new Error("requestTimeoutMs must be between 1 and 120000");
    }
    const maxResponsesPerTurn = options.maxResponsesPerTurn ?? maxToolSteps + 1;
    if (maxResponsesPerTurn !== maxToolSteps + 1) {
      throw new Error(`maxResponsesPerTurn must equal ${maxToolSteps + 1} so every tool result gets a final closure response`);
    }
    this.maxOutputTokens = options.maxOutputTokens ?? maxAgentOutputTokens;
    this.maxResponseRetries = options.maxResponseRetries ?? 1;
    this.maxConversationCreateAttempts = options.maxConversationCreateAttempts ?? 2;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.maxResponsesPerTurn = maxResponsesPerTurn;
    const provider = new OpenAIProvider({
        openAIClient: new OpenAI({ apiKey, maxRetries: 0, ...(this.requestTimeoutMs ? { timeout: this.requestTimeoutMs } : {}) }),
        useResponses: true,
      });
    this.runner = new Runner({
      modelProvider: options.responseRequestCounter
        ? new CountingModelProvider(provider, options.responseRequestCounter)
        : provider,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
    });
  }

  private readonly maxOutputTokens: number;
  private readonly maxResponseRetries: 0 | 1;
  private readonly maxConversationCreateAttempts: 1 | 2;
  private readonly requestTimeoutMs: number | undefined;
  private readonly maxResponsesPerTurn: number;

  async createConversation(leadId: string, signal?: AbortSignal): Promise<{ id: string }> {
    const payload = await this.request("https://api.openai.com/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ metadata: { lead_id: leadId } }),
      signal,
    });

    if (!isObjectWithString(payload, "id")) throw new Error("OpenAI conversation response did not contain an id");
    return { id: payload.id };
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurn> {
    const languageInstruction = replyLanguageInstruction(input.replyLanguage);
    const toolResults: AgentToolResult[] = [];
    const schedulingActions: SchedulingSemanticAction[] = [];
    let modelToolSteps = 0;
    let schedulingDecisionRecorded = false;
    let executorTechnicalFailure = false;
    // `update_client_data` is an atomic, validated merge owned by the
    // webhook.  A second model request must not be invited to overwrite it;
    // other semantic tools can still close the same customer turn.
    let updateClientDataAttempted = false;
    let primaryUsage: AgentTurn["usage"] | undefined;
    let providerReplayUsage: AgentTurn["usage"] | undefined;
    let omissionReplayUsage: AgentTurn["usage"] | undefined;
    let providerReplayAttempted = false;
    let omissionReplayAttempted = false;
    /** SDK input validation rejects malformed function JSON before execute. */
    let invalidAvailabilityArguments = false;
    /** True as soon as any model-requested tool reaches the executor boundary. */
    let toolExecutionStarted = false;
    const execute = async (name: AgentToolName, argumentsJson: unknown): Promise<Record<string, unknown>> => {
      throwIfAborted(input.signal);
      toolExecutionStarted = true;
      if (name === "update_client_data") {
        if (updateClientDataAttempted) {
          throw new AgentTurnTechnicalError("agent_duplicate_update_client_data");
        }
        updateClientDataAttempted = true;
      }
      let schedulingAction: SchedulingSemanticAction | undefined;
      let executorArgumentsJson = argumentsJson;
      if (name === "request_available_slots") {
        const parsed = normalizeProviderAvailabilityParameters(argumentsJson);
        if (!parsed) throw new AgentTurnTechnicalError("agent_invalid_availability_arguments");
        executorArgumentsJson = parsed;
        schedulingAction = {
          kind: "availability",
          dateReference: parsed.intent.dateReference,
          timePreference: parsed.intent.timePreference,
          timePreferenceMode: parsed.intent.timePreferenceMode,
          relation: parsed.intent.relation,
          existingOfferDisposition: parsed.intent.existingOfferDisposition,
          ...(parsed.intent.afterLocalTime ? { afterLocalTime: parsed.intent.afterLocalTime } : {}),
          ...(parsed.intent.beforeLocalTime ? { beforeLocalTime: parsed.intent.beforeLocalTime } : {}),
        };
      }
      if (name === "record_scheduling_decision") {
        const parsed = schedulingDecisionParameters.safeParse(argumentsJson);
        if (!parsed.success) {
          const output = { ok: false, error: "invalid_tool_arguments" };
          toolResults.push({ name, output });
          return output;
        }
        schedulingAction = { kind: "no_calendar", reason: parsed.data.reason };
      }
      if (modelToolSteps >= this.maxToolSteps) {
        return { ok: false, error: "tool_step_limit_reached" };
      }
      modelToolSteps += 1;
      try {
        const output = await input.executeTool(name, executorArgumentsJson);
        throwIfAborted(input.signal);
        toolResults.push({ name, output });
        // An auditable scheduling action describes an executor that actually
        // ran, not a provider-proposed tool call.  A normal business outcome
        // such as no availability is still a real Calendar attempt; a tool
        // step refusal never reaches this point and is intentionally absent.
        // A no-Calendar action is only evidence when the deterministic
        // executor accepted it. Availability is different: a completed
        // Calendar read that returns `no_available_slots` is still the
        // customer-requested semantic action and must remain auditable.
        if (schedulingAction && (schedulingAction.kind === "availability" || output.ok === true)) {
          schedulingDecisionRecorded = true;
          schedulingActions.push(schedulingAction);
        }
        return output;
      } catch (error) {
        if (error instanceof AgentTurnTechnicalError) throw error;
        throwIfAborted(input.signal);
        // Executor/repository faults are not bad model JSON.  Fail the whole
        // turn closed after the SDK finishes this response. Returning a typed
        // internal sentinel here avoids the SDK reclassifying a tool exception
        // as a provider transport failure. It is never returned to the
        // webhook/customer: the post-run fence below throws a typed technical
        // error, which triggers snapshot rollback. No semantic action was
        // recorded because the executor did not complete.
        executorTechnicalFailure = true;
        const output = { ok: false, error: "tool_execution_failed" };
        toolResults.push({ name, output });
        return output;
      }
    };
    const toolsEnabled = (name: AgentToolName) => modelToolSteps < this.maxToolSteps &&
      (input.allowedTools?.includes(name) ?? true) &&
      (name !== "update_client_data" || !updateClientDataAttempted);
    const buildPrimaryTurnAgent = (timeoutMs: number) => new Agent({
      name: "Sherlock Cleaning Agent",
      model: this.model,
      instructions: `${input.systemPrompt}\n\n${languageInstruction}\n\n${conversationInstruction}\n\n${intakeInstruction}\n\n${dateIntakeInstruction}\n\n${pricingInstruction(input.pricingRules ?? defaultPricingRules)}\n\n${schedulingInstruction(input.schedulingSnapshot, input.schedulingDecisionRequired ?? false)}\n\nThe backend derives urgency deterministically from the requested cleaning date in Europe/Belgrade. Do not ask the customer to choose standard versus same-day urgency, and do not send an urgency field in update_client_data.\n\nA quote is terminal for the current customer turn. After calculate_quote returns a quote, write the short customer-facing answer and do not request availability in that same turn.`,
      tools: [
        tool({
          name: "update_client_data",
          description: "Save only validated cleaning details extracted from the customer's messages.",
          parameters: updateClientDataParameters,
          strict: true,
          // A duplicate update is a corrupted provider turn, not a model
          // recoverable tool result. Let AgentTurnTechnicalError escape the
          // SDK's default error-as-output wrapper so webhook recovery rolls
          // back the first in-memory mutation and invalidates Conversation.
          errorFunction: null,
          isEnabled: () => toolsEnabled("update_client_data"),
          execute: (argumentsJson) => execute("update_client_data", argumentsJson),
        }),
        tool({
          name: "mark_human_needed",
          description: "Stop automatic quoting and preserve a concrete reason for human review.",
          parameters: humanNeededParameters,
          strict: true,
          isEnabled: () => toolsEnabled("mark_human_needed"),
          execute: (argumentsJson) => execute("mark_human_needed", argumentsJson),
        }),
        tool({
          name: "calculate_quote",
          description: "Request the deterministic backend price after all required data is known.",
          parameters: calculateQuoteParameters,
          strict: true,
          isEnabled: () => toolsEnabled("calculate_quote"),
          execute: (argumentsJson) => execute("calculate_quote", argumentsJson),
        }),
        tool({
          name: "request_available_slots",
          description: "Search current real Team A/B availability. Submit exactly { intent: { date, time, relation, existingOfferDisposition } }: date.kind is current_preferred_date, today, tomorrow, same_day_as_last_offer, day_after_last_offer, or exact_date with exactDate; time.kind is preserve, any, morning, midday, evening, after with afterLocalTime, before with beforeLocalTime, or range with ordered afterLocalTime and beforeLocalTime. Use preserve only for a date-only follow-up that retains the current window; every other time kind is explicit. relation is fresh or later_than_last_offer. existingOfferDisposition is none with no active offer, retain_until_replacement to keep an old offer until fresh results, or reject_now when the customer rejects it. Use this whenever the customer asks about availability, another date/time, or changed scheduling preference. Never invent times or identifiers.",
          parameters: requestAvailableSlotsProviderParametersForSnapshot(input.schedulingSnapshot),
          strict: true,
          // SDK validation happens before execute. Return a private sentinel
          // so the terminal tool can end cleanly; the post-run fence below
          // turns it into our typed fail-closed protocol error.
          errorFunction: async () => {
            invalidAvailabilityArguments = true;
            return "invalid_tool_arguments";
          },
          isEnabled: () => toolsEnabled("request_available_slots") && hasAvailabilityDateCoordinate(input.schedulingSnapshot),
          execute: (argumentsJson) => execute("request_available_slots", argumentsJson),
        }),
        tool({
          name: "record_scheduling_decision",
          description: "Record the one reason a quoted/offered customer turn does not need a Calendar search. Use this only when the message is genuinely unrelated to availability, needs a date/time detail before any search, is just acknowledging an existing offer, is already reserved, or is already with a human. Never use it to defer an availability question or a changed scheduling preference.",
          parameters: schedulingDecisionParameters,
          strict: true,
          isEnabled: () => toolsEnabled("record_scheduling_decision"),
          execute: (argumentsJson) => execute("record_scheduling_decision", argumentsJson),
        }),
      ],
      // The SDK returns the function output as finalOutput for this one
      // terminal tool. Gateway never exposes that JSON as customer prose;
      // webhook selects the corresponding deterministic renderer only after
      // the executor has completed and its deferred write is safe to commit.
      toolUseBehavior: { stopAtToolNames: [...availabilityTerminalToolConfig.toolUseBehavior.stopAtToolNames] },
      modelSettings: {
        timeoutMs,
        // A scheduling-state turn must leave a typed decision. The SDK resets
        // this preference after the first tool call, so the final customer
        // prose remains possible after a semantic tool has returned.
        toolChoice: input.schedulingDecisionRequired ? "required" : "auto",
        parallelToolCalls: false,
        reasoning: { effort: this.reasoningEffort },
        maxTokens: this.maxOutputTokens,
        retry: {
          maxRetries: this.maxResponseRetries,
          policy: retryPolicies.all(
            retryPolicies.providerSuggested(),
            ({ normalized }) => normalized.statusCode === 429 || (normalized.statusCode !== undefined && normalized.statusCode >= 500),
          ),
        },
      },
    });
    const primaryTimeoutMs = Math.min(this.requestTimeoutMs ?? providerReplayConfig.primaryMaxDurationMs, providerReplayConfig.primaryMaxDurationMs);
    const agent = buildPrimaryTurnAgent(primaryTimeoutMs);

    try {
      const primaryMessage = `Known validated data: ${JSON.stringify(input.knownClientData)}\nCustomer message: ${input.message}`;
      let result: { finalOutput: unknown; runContext: { usage: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number; inputTokensDetails?: unknown } } };
      try {
        result = await this.runner.run(
          agent,
          primaryMessage,
          {
            conversationId: input.conversationId,
            maxTurns: this.maxResponsesPerTurn,
            signal: input.signal,
            toolExecution: { maxFunctionToolConcurrency: providerReplayConfig.maxFunctionToolConcurrency },
          },
        );
        primaryUsage = usageFromRunResult(result);
      } catch (primaryError) {
        if (!isEligibleProviderReplay(primaryError, { toolExecutionStarted, callerSignal: input.signal })) throw primaryError;
        providerReplayAttempted = true;
        primaryUsage = usageFromProviderFailure(primaryError);
        const replaySignal = composeAbortSignals(input.signal, AbortSignal.timeout(providerReplayConfig.replayMaxDurationMs));
        result = await this.runner.run(
          buildPrimaryTurnAgent(Math.min(this.requestTimeoutMs ?? providerReplayConfig.replayMaxDurationMs, providerReplayConfig.replayMaxDurationMs)),
          primaryMessage,
          {
            maxTurns: providerReplayConfig.maxTurns,
            signal: replaySignal,
            toolExecution: { maxFunctionToolConcurrency: providerReplayConfig.maxFunctionToolConcurrency },
          },
        );
        providerReplayUsage = usageFromRunResult(result);
      }
      if (executorTechnicalFailure) {
        throw new AgentTurnTechnicalError("agent_tool_execution_failed");
      }
      if (invalidAvailabilityArguments) {
        throw new AgentTurnTechnicalError("agent_invalid_availability_arguments");
      }
      const omissionReplayRequired = !providerReplayAttempted && input.schedulingDecisionRequired &&
        !toolExecutionStarted && toolResults.length === 0 &&
        !schedulingDecisionRecorded &&
        !toolResults.some((toolResult) => toolResult.name === "calculate_quote" && toolResult.output.kind === "quote");
      if (omissionReplayRequired) {
        omissionReplayAttempted = true;
        const omissionReplaySignal = composeAbortSignals(input.signal, AbortSignal.timeout(schedulingOmissionReplayConfig.maxDurationMs));
        // This is deliberately the *same* full primary Agent rather than a
        // scheduling parser. It receives the exact full prompt, authoritative
        // input and tool executor closure; only the durable Conversation is
        // omitted. A successful replay therefore remains governed by all
        // existing deterministic backend guards.
        result = await this.runner.run(
          buildPrimaryTurnAgent(Math.min(this.requestTimeoutMs ?? schedulingOmissionReplayConfig.maxDurationMs, schedulingOmissionReplayConfig.maxDurationMs)),
          primaryMessage,
          {
            maxTurns: schedulingOmissionReplayConfig.maxTurns,
            signal: omissionReplaySignal,
            toolExecution: { maxFunctionToolConcurrency: schedulingOmissionReplayConfig.maxFunctionToolConcurrency },
          },
        );
        omissionReplayUsage = usageFromRunResult(result);
        if (executorTechnicalFailure) {
          throw new AgentTurnTechnicalError("agent_tool_execution_failed");
        }
        if (invalidAvailabilityArguments) {
          throw new AgentTurnTechnicalError("agent_invalid_availability_arguments");
        }
      }
      const quoteRecalculatedInSchedulingState = toolResults.some((toolResult) =>
        toolResult.name === "calculate_quote" && toolResult.output.kind === "quote",
      );
      if (input.schedulingDecisionRequired && !schedulingDecisionRecorded && !quoteRecalculatedInSchedulingState) {
        throw new AgentTurnTechnicalError("agent_scheduling_decision_missing");
      }
      const terminalAvailabilityResult = toolResults.some((toolResult) => toolResult.name === availabilityTerminalToolConfig.toolName);
      return {
        reply: terminalAvailabilityResult
          ? fallbackReply(input.replyLanguage)
          : typeof result.finalOutput === "string" && result.finalOutput.trim().length > 0
          ? result.finalOutput
          : fallbackReply(input.replyLanguage),
        toolResults,
        ...(schedulingActions.length > 0 ? { schedulingActions } : {}),
        steps: modelToolSteps,
        usage: sumUsage(primaryUsage, providerReplayUsage, omissionReplayUsage),
        ...(providerReplayAttempted && !primaryUsage ? { usageUnreconciledReason: "primary_replay_leg_usage_unreconciled" } : {}),
        ...(terminalAvailabilityResult || omissionReplayAttempted || providerReplayAttempted ? { conversationResetRequired: true } : {}),
        ...(providerReplayAttempted
          ? { statelessRecovery: "provider_failure_replay" as const }
          : omissionReplayAttempted ? { statelessRecovery: "scheduling_omission_replay" as const } : {}),
      };
    } catch (error) {
      // Evaluator control fences are not provider failures. Their exact typed
      // codes drive terminal incomplete/deadline reporting and must survive
      // unchanged through the SDK boundary.
      if (isEvaluatorControlError(error)) throw error;
      if (input.signal?.aborted && input.signal.reason) throw input.signal.reason;
      if (error instanceof AgentTurnTechnicalError) {
        const completedUsage = sumUsage(primaryUsage, providerReplayUsage, omissionReplayUsage);
        const usage = aggregateLegFailureUsage(completedUsage, error.usage);
        throw new AgentTurnTechnicalError(
          error.code,
          usage,
          unreconciledLegReason({ providerReplayAttempted, primaryReplayUsage: primaryUsage, completedProviderReplayUsage: providerReplayUsage, omissionReplayAttempted, completedOmissionReplayUsage: omissionReplayUsage, completedUsage, currentLegUsage: error.usage, finalProviderFailure: isProviderTimeoutOrTransport(error), explicitReason: error.usageUnreconciledReason, fallbackReason: "provider_turn_usage_unreconciled" }),
        );
      }
      // The Agents SDK wraps a function-tool exception from a single model
      // response in ToolCallError. Keep our typed fail-closed cause intact so
      // callers never turn it into model-visible recovery output.
      const technicalToolCause = extractTechnicalToolCause(error);
      if (technicalToolCause) {
        const completedUsage = sumUsage(primaryUsage, providerReplayUsage, omissionReplayUsage);
        throw new AgentTurnTechnicalError(
          technicalToolCause.code,
          aggregateLegFailureUsage(completedUsage, technicalToolCause.usage),
          unreconciledLegReason({ providerReplayAttempted, primaryReplayUsage: primaryUsage, completedProviderReplayUsage: providerReplayUsage, omissionReplayAttempted, completedOmissionReplayUsage: omissionReplayUsage, completedUsage, currentLegUsage: technicalToolCause.usage, finalProviderFailure: isProviderTimeoutOrTransport(technicalToolCause), explicitReason: technicalToolCause.usageUnreconciledReason, fallbackReason: "provider_turn_usage_unreconciled" }),
        );
      }
      // Function-tool Zod validation happens in the SDK before `execute`.
      // Its typed error does not expose model prose or arguments here, but
      // the SDK state does retain the canonical function name. Treat only a
      // malformed availability call as our distinct safe protocol failure;
      // other function-input errors retain their existing fail-closed path.
      if (isInvalidAvailabilityToolInput(error)) {
        const completedUsage = sumUsage(primaryUsage, providerReplayUsage, omissionReplayUsage);
        throw new AgentTurnTechnicalError(
          "agent_invalid_availability_arguments",
          completedUsage,
        );
      }
      if (error instanceof MaxTurnsExceededError) {
        const partialUsage = usageFromMaxTurnsError(error);
        const completedUsage = sumUsage(primaryUsage, providerReplayUsage, omissionReplayUsage);
        throw new AgentTurnTechnicalError(
          "agent_max_turns_exceeded",
          aggregateLegFailureUsage(completedUsage, partialUsage),
          unreconciledLegReason({ providerReplayAttempted, primaryReplayUsage: primaryUsage, completedProviderReplayUsage: providerReplayUsage, omissionReplayAttempted, completedOmissionReplayUsage: omissionReplayUsage, completedUsage, currentLegUsage: partialUsage, finalProviderFailure: false, fallbackReason: "max_turns_usage_unavailable" }),
        );
      }
      // A provider may ignore the dynamically reduced tool surface and emit a
      // stale duplicate call. The SDK rejects that as ModelBehaviorError before
      // it reaches `execute`; expose the same fail-closed technical boundary.
      if (updateClientDataAttempted && error instanceof Error && /Tool update_client_data not found/u.test(error.message)) {
        throw new AgentTurnTechnicalError("agent_duplicate_update_client_data");
      }
      // A Responses/transport failure is operationally recoverable just like
      // MaxTurns.  Do not let a raw SDK/provider exception escape to the
      // webhook: that previously became `processing_error`, retained a
      // poisoned Conversation and leaked arbitrary error text into evaluator
      // evidence.  Preserve only a safe category plus any released aggregate
      // usage exposed by the SDK state.
      const partialUsage = usageFromSdkError(error);
      const completedUsage = sumUsage(primaryUsage, providerReplayUsage, omissionReplayUsage);
      throw new AgentTurnTechnicalError(
        normalizeProviderTechnicalCode(error),
        aggregateLegFailureUsage(completedUsage, partialUsage),
        unreconciledLegReason({ providerReplayAttempted, primaryReplayUsage: primaryUsage, completedProviderReplayUsage: providerReplayUsage, omissionReplayAttempted, completedOmissionReplayUsage: omissionReplayUsage, completedUsage, currentLegUsage: partialUsage, finalProviderFailure: isProviderTimeoutOrTransport(error), fallbackReason: "provider_turn_usage_unreconciled" }),
      );
    }
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; attempt < this.maxConversationCreateAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          signal: composeAbortSignals(init.signal, this.requestTimeoutMs ? AbortSignal.timeout(this.requestTimeoutMs) : undefined),
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            ...init.headers,
          },
        });
      } catch (error) {
        if (isEvaluatorControlError(error)) throw error;
        // A caller-owned evaluator deadline has precedence over a native
        // AbortError/TypeError produced by fetch.
        if (init.signal?.aborted && init.signal.reason) throw init.signal.reason;
        throw new AgentTurnTechnicalError(
          normalizeProviderTechnicalCode(error),
          undefined,
          "provider_conversation_create_usage_unreconciled",
        );
      }

      const payload: unknown = await response.json().catch(() => null);
      if (response.ok) return payload;
      if (attempt + 1 < this.maxConversationCreateAttempts && (response.status === 429 || response.status >= 500)) continue;
      throw new AgentTurnTechnicalError("agent_provider_http_error", undefined, "provider_conversation_create_usage_unreconciled");
    }

    throw new AgentTurnTechnicalError("agent_provider_http_error", undefined, "provider_conversation_create_usage_unreconciled");
  }
}

/**
 * The SDK resolves models lazily through a ModelProvider. Wrapping this seam
 * counts each Responses request actually started, rather than reserving a
 * pessimistic number per customer message.
 */
export class CountingModelProvider implements ModelProvider {
  constructor(private readonly delegate: ModelProvider, private readonly counter: ResponseRequestCounter) {}

  async getModel(modelName?: string): Promise<Model> {
    const model = await this.delegate.getModel(modelName);
    return {
      getResponse: (request) => {
        this.counter.beforeResponseRequest();
        return model.getResponse(request);
      },
      getStreamedResponse: (request) => {
        const stream = model.getStreamedResponse(request);
        let started = false;
        return {
          [Symbol.asyncIterator]: () => {
            const iterator = stream[Symbol.asyncIterator]();
            return {
              next: () => {
                if (!started) {
                  this.counter.beforeResponseRequest();
                  started = true;
                }
                return iterator.next();
              },
            };
          },
        };
      },
      ...(model.getRetryAdvice ? { getRetryAdvice: (args) => model.getRetryAdvice!(args) } : {}),
    };
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("agent_turn_aborted");
}

function composeAbortSignals(...signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return undefined;
  return active.length === 1 ? active[0] : AbortSignal.any(active);
}

/** Combine completed provider legs without inventing data. */
function sumUsage(...usages: Array<AgentTurn["usage"] | undefined>): AgentTurn["usage"] | undefined {
  const known = usages.filter((usage): usage is NonNullable<AgentTurn["usage"]> => usage !== undefined);
  if (known.length === 0) return undefined;
  return known.reduce((total, usage) => ({
    requests: total.requests + usage.requests,
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
    cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
  }), { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 });
}

/** A provider error belongs only to the currently executing leg. */
function aggregateLegFailureUsage(
  completedPrimaryUsage: AgentTurn["usage"] | undefined,
  currentLegUsage: AgentTurn["usage"] | undefined,
): AgentTurn["usage"] | undefined {
  return sumUsage(completedPrimaryUsage, currentLegUsage);
}

/**
 * A completed primary response is known evidence, never evidence that a
 * started recovery leg reconciled. Keep a specific unreconciled marker whenever
 * a recovery leg failed without published usage.
 */
function unreconciledLegReason(input: {
  providerReplayAttempted: boolean;
  /** Known aggregate released by the failed primary provider leg. */
  primaryReplayUsage: AgentTurn["usage"] | undefined;
  /** Usage from a completed replay; absent only while its provider leg failed. */
  completedProviderReplayUsage: AgentTurn["usage"] | undefined;
  omissionReplayAttempted: boolean;
  /** Usage from a completed full-primary omission replay. */
  completedOmissionReplayUsage?: AgentTurn["usage"];
  completedUsage?: AgentTurn["usage"];
  currentLegUsage: AgentTurn["usage"] | undefined;
  /** The last started leg threw timeout/transport rather than completing. */
  finalProviderFailure: boolean;
  explicitReason?: string;
  fallbackReason: string;
}): string | undefined {
  if (input.explicitReason) return input.explicitReason;
  // A thrown provider leg can expose partial or zero-valued SDK usage even
  // though the provider request started. It is never a completed usage
  // record: retain every released subtotal exactly once and mark this final
  // timeout/transport leg unreconciled rather than fabricating a full cost.
  if (input.finalProviderFailure) {
    if (input.providerReplayAttempted && !input.completedProviderReplayUsage) return "provider_replay_leg_usage_unreconciled";
    if (input.omissionReplayAttempted && !input.completedOmissionReplayUsage) return "scheduling_omission_replay_leg_usage_unreconciled";
    return input.fallbackReason;
  }
  // A transient primary failure may have started a provider request without
  // releasing usage. Never present a later replay subtotal as reconciliation
  // for that lost primary leg.
  if (input.providerReplayAttempted && !input.primaryReplayUsage) return "primary_replay_leg_usage_unreconciled";
  if (input.providerReplayAttempted && !input.completedProviderReplayUsage && !input.currentLegUsage) return "provider_replay_leg_usage_unreconciled";
  if (input.omissionReplayAttempted && !input.completedOmissionReplayUsage && !input.currentLegUsage) return "scheduling_omission_replay_leg_usage_unreconciled";
  if (!input.currentLegUsage && !input.completedUsage) return input.fallbackReason;
  return undefined;
}

function isProviderTimeoutOrTransport(error: unknown): boolean {
  const code = normalizeProviderTechnicalCode(error);
  return code === "agent_provider_timeout" || code === "agent_provider_transport_error";
}

/** The SDK keeps usage-detail keys provider-defined, so aggregate only cache-named fields. */
function cachedInputTokens(details: Array<Record<string, number>>): number {
  return details.reduce(
    (total, entry) => total + Object.entries(entry).reduce(
      (entryTotal, [key, value]) => entryTotal + (/cache/iu.test(key) && Number.isFinite(value) ? value : 0),
      0,
    ),
    0,
  );
}

/** Recover only released aggregate usage from an SDK turn-cap error. */
export function usageFromMaxTurnsError(error: MaxTurnsExceededError): AgentTurn["usage"] | undefined {
  return usageFromSdkError(error);
}

/** Extract only validated aggregate usage exposed by an SDK failure state. */
export function usageFromSdkError(error: unknown): AgentTurn["usage"] | undefined {
  const usage = typeof error === "object" && error !== null && "state" in error
    ? (error as { state?: { usage?: unknown } }).state?.usage
    : undefined;
  if (!usage) return undefined;
  if (typeof usage !== "object" || usage === null) return undefined;
  const candidate = usage as Record<string, unknown>;
  if (!["requests", "inputTokens", "outputTokens", "totalTokens"].every((key) =>
    typeof candidate[key] === "number" && Number.isFinite(candidate[key]))) return undefined;
  return {
    requests: candidate.requests as number,
    inputTokens: candidate.inputTokens as number,
    outputTokens: candidate.outputTokens as number,
    totalTokens: candidate.totalTokens as number,
    cachedInputTokens: cachedInputTokens(Array.isArray(candidate.inputTokensDetails)
      ? candidate.inputTokensDetails.filter((detail): detail is Record<string, number> => typeof detail === "object" && detail !== null)
      : []),
  };
}

/**
 * Classify provider/SDK failures without inspecting their message/body.  The
 * OpenAI client exposes concrete error names, while fetch/undici use native
 * TimeoutError/AbortError and TypeError.  Unknown SDK shapes stay safely
 * generic rather than becoming customer-visible text.
 */
export function normalizeProviderTechnicalCode(error: unknown): AgentTurnTechnicalCode {
  if (error instanceof AgentTurnTechnicalError) return error.code;
  const name = typeof error === "object" && error !== null && "name" in error && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "";
  if (error instanceof OpenAI.APIConnectionTimeoutError || /(?:timeout|timedout)/iu.test(name)) return "agent_provider_timeout";
  if (error instanceof OpenAI.APIConnectionError || /(?:connection|network|fetch|typeerror)/iu.test(name) || error instanceof TypeError) return "agent_provider_transport_error";
  if (error instanceof OpenAI.APIError || /(?:api|http|status)/iu.test(name)) return "agent_provider_http_error";
  return "agent_provider_sdk_error";
}

/** Only an unambiguous first provider leg is safe to replay statelessly. */
function isEligibleProviderReplay(
  error: unknown,
  input: { toolExecutionStarted: boolean; callerSignal?: AbortSignal },
): boolean {
  if (input.toolExecutionStarted || input.callerSignal?.aborted || isEvaluatorControlError(error)) return false;
  const code = normalizeProviderTechnicalCode(error);
  return code === "agent_provider_timeout" || code === "agent_provider_transport_error";
}

/** Provider failures expose only their own released partial usage. */
function usageFromProviderFailure(error: unknown): AgentTurn["usage"] | undefined {
  if (error instanceof AgentTurnTechnicalError) return error.usage;
  if (error instanceof MaxTurnsExceededError) return usageFromMaxTurnsError(error);
  return usageFromSdkError(error);
}

/** Local evaluator deadlines/resource caps must remain terminal control flow. */
function isEvaluatorControlError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "provider_response_budget_exceeded_before_request_221" ||
    code === "live_suite_deadline_exceeded" ||
    code === "scenario_deadline_exceeded" ||
    code === "customer_turn_deadline_exceeded" ||
    code === "input_token_cap_exceeded" ||
    code === "output_token_cap_exceeded" ||
    code === "total_token_cap_exceeded";
}

function extractTechnicalToolCause(error: unknown, seen = new Set<unknown>()): AgentTurnTechnicalError | undefined {
  if (error instanceof AgentTurnTechnicalError) return error;
  if (typeof error !== "object" || error === null || seen.has(error)) return undefined;
  seen.add(error);
  // The SDK has used both `error` and native `cause` wrappers across tool
  // paths. Inspect only their object linkage, never messages or payloads, so
  // an executor fault cannot be relabelled as a provider transport failure.
  for (const key of ["error", "cause"] as const) {
    if (key in error) {
      const technical = extractTechnicalToolCause((error as Record<string, unknown>)[key], seen);
      if (technical) return technical;
    }
  }
  return undefined;
}

/**
 * The Agents SDK rejects malformed function input before our executor runs.
 * Identify that typed boundary by its error class and the SDK-owned resolved
 * function name, never by customer/model text or raw tool arguments.
 */
function isInvalidAvailabilityToolInput(error: unknown): boolean {
  const seen = new Set<unknown>();
  let hasInvalidToolInput = false;
  let hasAvailabilityFunction = false;
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if ((value as { name?: unknown }).name === "InvalidToolInputError") hasInvalidToolInput = true;
    const record = value as Record<string, unknown>;
    if (record.name === "request_available_slots" && ("parameters" in record || "invoke" in record)) hasAvailabilityFunction = true;
    for (const key of ["error", "cause", "state", "lastProcessedResponse", "functions"] as const) {
      const child = record[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
    if (record.tool) visit(record.tool);
  };
  visit(error);
  return hasInvalidToolInput && hasAvailabilityFunction;
}

function isObjectWithString<K extends string>(value: unknown, key: K): value is Record<K, string> {
  return typeof value === "object" && value !== null && key in value &&
    typeof (value as Record<string, unknown>)[key] === "string";
}

export class FakeAgentGateway implements AgentGateway {
  private sequence = 0;

  async createConversation(leadId: string): Promise<{ id: string }> {
    void leadId;
    this.sequence += 1;
    return { id: `fake-conversation-${this.sequence}` };
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurn> {
    const patch = inferClientDataPatch(input.message);
    const toolResults: AgentToolResult[] = [];
    const allowed = new Set(input.allowedTools ?? ["update_client_data", "mark_human_needed", "calculate_quote", "request_available_slots", "record_scheduling_decision"] as const);

    if (allowed.has("update_client_data")) {
      const updateOutput = await input.executeTool("update_client_data", { patch });
      toolResults.push({ name: "update_client_data", output: updateOutput });
    }

    if (containsOutOfScopeSignal(input.message)) {
      if (allowed.has("mark_human_needed")) {
        const escalationOutput = await input.executeTool("mark_human_needed", { reason: inferOutOfScopeReason(input.message) });
        toolResults.push({ name: "mark_human_needed", output: escalationOutput });
      }
      return {
        reply: replyForLanguage(input.replyLanguage, "human_needed"),
        toolResults,
        steps: 1,
      };
    }

    if (allowed.has("request_available_slots") && /\b(slots?|availability|available time|schedule)\b/i.test(input.message)) {
      const output = await input.executeTool("request_available_slots", { intent: fakeAvailabilityIntent(input) });
      toolResults.push({ name: "request_available_slots", output });
      return {
        reply: output.ok === true
          ? replyForLanguage(input.replyLanguage, "slots")
          : replyForLanguage(input.replyLanguage, "human_needed"),
        toolResults,
        steps: 1,
      };
    }

    if (input.schedulingDecisionRequired && allowed.has("record_scheduling_decision")) {
      const output = await input.executeTool("record_scheduling_decision", { reason: "question_not_about_scheduling" });
      toolResults.push({ name: "record_scheduling_decision", output });
    }

    if (!allowed.has("calculate_quote")) {
      return {
        reply: replyForLanguage(input.replyLanguage, "missing"),
        toolResults,
        steps: toolResults.length,
      };
    }
    const quoteOutput = await input.executeTool("calculate_quote", {});
    toolResults.push({ name: "calculate_quote", output: quoteOutput });

    if (quoteOutput.kind === "quote" && isObjectWithNumber(quoteOutput.quote, "amountRsd")) {
      return {
        reply: replyForLanguage(input.replyLanguage, "quote", quoteOutput.quote.amountRsd),
        toolResults,
        steps: 2,
      };
    }

    if (quoteOutput.kind === "human_needed") {
      return { reply: replyForLanguage(input.replyLanguage, "human_needed"), toolResults, steps: 2 };
    }

    return {
      reply: replyForLanguage(
        input.replyLanguage,
        "missing",
        undefined,
        stringArray(quoteOutput.missing_fields),
      ),
      toolResults,
      steps: 2,
    };
  }
}

function inferClientDataPatch(message: string): Record<string, unknown> {
  const lower = message.toLowerCase();
  const patch: Record<string, unknown> = {};
  const area = lower.match(/(\d+(?:[.,]\d+)?)\s*(?:m²|m2|sqm)/i);
  const rooms = lower.match(/(\d+)\s*(?:rooms?|комнат)/i);
  const bathrooms = lower.match(/(\d+)\s*(?:bathrooms?|сануз)/i);
  const date = lower.match(/\b\d{4}-\d{2}-\d{2}\b/);
  const district = lower.match(/(?:district|address)\s*[:=-]\s*([^,.;]+)/i);

  if (lower.includes("deep cleaning") || lower.includes("генераль")) patch.cleaningType = "deep";
  if (lower.includes("standard cleaning") || lower.includes("standard") || lower.includes("обычн")) {
    patch.cleaningType = "standard";
  }
  if (area) patch.areaM2 = Number(area[1].replace(",", "."));
  if (rooms) patch.rooms = Number(rooms[1]);
  if (bathrooms) patch.bathrooms = Number(bathrooms[1]);
  if (date) {
    patch.preferredDate = date[0];
  }
  if (district) patch.addressOrDistrict = district[1].trim();

  if (/heavy pet hair|сильн.*шерст/.test(lower)) patch.heavyPetHair = true;
  if (/no pet hair|без шерст/.test(lower)) patch.heavyPetHair = false;
  const mentionedExtras = [
    lower.includes("windows") ? "windows" : null,
    lower.includes("oven") ? "oven_inside" : null,
    lower.includes("fridge") ? "fridge_inside" : null,
    lower.includes("balcony") || lower.includes("terrace") ? "balcony_or_terrace" : null,
  ].filter((extra): extra is string => extra !== null);
  if (mentionedExtras.length > 0) patch.extras = mentionedExtras;
  if (/no extras|без дополн/.test(lower)) patch.extras = [];

  return patch;
}

function fakeAvailabilityIntent(input: AgentTurnInput): SchedulingAvailabilityIntent {
  const lower = input.message.toLocaleLowerCase();
  const dateReference = /\btomorrow\b|завтра|sutra/u.test(lower)
    ? "tomorrow"
    : /\btoday\b|сегодня|danas/u.test(lower)
    ? "today"
    : "current_preferred_date";
  const timePreference = /evening|вечером|uveče|uvece/u.test(lower)
    ? "evening"
    : /midday|noon|дн[её]м|обед|podne/u.test(lower)
    ? "midday"
    : /morning|утром|ujutru/u.test(lower)
    ? "morning"
    : "any";
  const explicitAny = /(?:any\s+time|в\s+любое\s+время|bilo\s+koje\s+vreme)/u.test(lower);
  return {
    dateReference,
    timePreference,
    timePreferenceMode: timePreference === "any" && !explicitAny ? "preserve" : "explicit",
    relation: /later|позже|kasnije/u.test(lower) ? "later_than_last_offer" : "fresh",
    existingOfferDisposition: input.schedulingSnapshot?.lastOffer ? "retain_until_replacement" : "none",
  };
}

function containsOutOfScopeSignal(message: string): boolean {
  return /after renovation|construction cleaning|commercial|office|unusually dirty|сезон.*ремонт|после ремонта|коммерчес/.test(
    message.toLowerCase(),
  );
}

function inferOutOfScopeReason(message: string): string {
  const lower = message.toLowerCase();
  if (/renovation|construction|ремонт/.test(lower)) return "after_renovation";
  if (/commercial|office|коммерчес/.test(lower)) return "commercial_property";
  if (/unusually dirty/.test(lower)) return "unusually_heavy_soiling";
  return "scope_uncertain";
}

function replyForLanguage(
  language: ReplyLanguage,
  kind: "quote" | "missing" | "human_needed" | "slots" | "reserved",
  amount?: number,
  missingFields: string[] = [],
): string {
  const russian = isRussianLanguage(language);
  const serbian = isSerbianLanguage(language);
  if (russian) {
    if (kind === "quote") return `Уборка будет стоить ${amount} RSD. Если вам подходит, я подберу время.`;
    if (kind === "human_needed") return "Спасибо, я передам детали нашей команде, чтобы всё проверить внимательно.";
    if (kind === "slots") return "Сейчас покажу ближайшее свободное время.";
    if (kind === "reserved") return "Время зарезервировано.";
    return missingDetailsReply("ru", missingFields);
  }
  if (serbian) {
    if (kind === "quote") return serbianText(language, `Vaša procena za čišćenje je ${amount} RSD. Ako vam odgovara, mogu da pronađem odgovarajući termin.`, `Ваша процена за чишћење је ${amount} RSD. Ако вам одговара, могу да пронађем одговарајући термин.`);
    if (kind === "human_needed") return serbianText(language, "Hvala. Naš tim će pažljivo pregledati ovaj zahtev i nastaviti sa detaljima koje ste podelili.", "Хвала. Наш тим ће пажљиво прегледати овај захтев и наставити са детаљима које сте поделили.");
    if (kind === "slots") return serbianText(language, "Sada ću prikazati najbliže slobodne termine.", "Сада ћу приказати најближе слободне термине.");
    if (kind === "reserved") return serbianText(language, "Vaš termin je rezervisan.", "Ваш термин је резервисан.");
    return missingDetailsReply(language, missingFields);
  }
  if (kind === "quote") return `Your cleaning estimate is ${amount} RSD. If it works for you, I can look for a suitable time.`;
  if (kind === "human_needed") return "Thank you. Our team will take a careful look at this request and continue with the details you shared.";
  if (kind === "slots") return "I’ll show the nearest available times now.";
  if (kind === "reserved") return "Your time is reserved.";
  return missingDetailsReply("en", missingFields);
}

function missingDetailsReply(language: ReplyLanguage, missingFields: string[]): string {
  const missing = new Set(missingFields);
  const has = (field: string) => missing.has(field);
  if (isSerbianLanguage(language)) {
    if (has("cleaningType") || has("areaM2")) return serbianText(language, "Da li vam je potrebno standardno ili detaljno čišćenje, i kolika je približno površina stana?", "Да ли вам је потребно стандардно или детаљно чишћење, и колика је приближно површина стана?");
    if (has("rooms") && has("bathrooms")) return serbianText(language, "Koliko soba i kupatila ima stan?", "Колико соба и купатила има стан?");
    if (has("rooms")) return serbianText(language, "Koliko soba ima stan?", "Колико соба има стан?");
    if (has("bathrooms")) return serbianText(language, "Koliko kupatila ima stan?", "Колико купатила има стан?");
    if (has("addressOrDistrict") && has("preferredDate")) return serbianText(language, "U kom delu grada je stan i koji datum bi vam odgovarao za čišćenje?", "У ком делу града је стан и који датум би вам одговарао за чишћење?");
    if (has("addressOrDistrict")) return serbianText(language, "U kom delu grada se nalazi stan?", "У ком делу града се налази стан?");
    if (has("preferredDate") || has("urgency")) return serbianText(language, "Koji datum bi vam odgovarao za čišćenje?", "Који датум би вам одговарао за чишћење?");
    if (has("heavyPetHair") && has("extras")) return serbianText(language, "Da li treba da uzmemo u obzir mnogo dlaka kućnih ljubimaca ili dodatne usluge?", "Да ли треба да узмемо у обзир много длака кућних љубимаца или додатне услуге?");
    if (has("heavyPetHair")) return serbianText(language, "Da li treba da uzmemo u obzir mnogo dlaka kućnih ljubimaca?", "Да ли треба да узмемо у обзир много длака кућних љубимаца?");
    if (has("extras")) return serbianText(language, "Da li su vam potrebne dodatne usluge, kao što su prozori, rerna, frižider ili terasa?", "Да ли су вам потребне додатне услуге, као што су прозори, рерна, фрижидер или тераса?");
    return serbianText(language, "Recite nam još jedan ili dva detalja o čišćenju.", "Реците нам још један или два детаља о чишћењу.");
  }
  if (has("cleaningType") || has("areaM2")) {
    return isRussianLanguage(language)
      ? "Подскажите, пожалуйста, какой тип уборки нужен и примерно какая площадь квартиры?"
      : "Could you tell me whether you need a standard or deep cleaning, and roughly how many square metres it is?";
  }
  if (has("rooms") && has("bathrooms")) {
    return isRussianLanguage(language)
      ? "Сколько в квартире комнат и санузлов?"
      : "How many rooms and bathrooms are there?";
  }
  if (has("rooms")) return isRussianLanguage(language) ? "Сколько в квартире комнат?" : "How many rooms are there?";
  if (has("bathrooms")) return isRussianLanguage(language) ? "Сколько в квартире санузлов?" : "How many bathrooms are there?";
  if (has("addressOrDistrict") && has("preferredDate")) {
    return isRussianLanguage(language)
      ? "В каком районе находится квартира и на какую дату вам удобно запланировать уборку?"
      : "Which district is it in, and what date would suit you for the cleaning?";
  }
  if (has("addressOrDistrict")) return isRussianLanguage(language) ? "В каком районе находится квартира?" : "Which district is it in?";
  if (has("preferredDate") || has("urgency")) {
    return isRussianLanguage(language) ? "На какую дату вам удобно запланировать уборку?" : "What date would suit you for the cleaning?";
  }
  if (has("heavyPetHair") && has("extras")) {
    return isRussianLanguage(language)
      ? "Нужно ли учесть сильную шерсть животных или дополнительные услуги, например окна, духовку, холодильник или балкон?"
      : "Should we account for heavy pet hair or any extras, such as windows, oven, fridge or a balcony?";
  }
  if (has("heavyPetHair")) return isRussianLanguage(language) ? "Нужно ли учесть сильную шерсть животных?" : "Should we account for heavy pet hair?";
  if (has("extras")) return isRussianLanguage(language) ? "Нужны ли дополнительные услуги, например окна, духовка, холодильник или балкон?" : "Would you like any extras, such as windows, oven, fridge or a balcony?";
  return isRussianLanguage(language)
    ? "Подскажите, пожалуйста, ещё немного деталей об уборке."
    : "Could you share one or two more details about the cleaning?";
}

function fallbackReply(language: string): string {
  if (isSerbianLanguage(language)) return serbianText(language, "Nastavićemo zahtev sa detaljima koje ste podelili.", "Наставићемо захтев са детаљима које сте поделили.");
  return isRussianLanguage(language)
    ? "Продолжим заявку с деталями, которые вы уже сообщили."
    : "We’ll continue the request with the details you’ve already shared.";
}

function replyLanguageInstruction(language: ReplyLanguage): string {
  return replyLanguageInstructions[language];
}

const replyLanguageInstructions: Record<ReplyLanguage, string> = {
  en: "Reply only in English for this customer turn. Sound like a helpful local coordinator: use one or two short natural sentences, no em or en dashes, no headings, labels, raw Markdown, technical terms, or generic AI filler.",
  ru: "Reply only in Russian for this customer turn. Sound like a helpful local coordinator: use one or two short natural sentences, no em or en dashes, no headings, labels, raw Markdown, technical terms, or generic AI filler.",
  "sr-Latn": "Reply only in Serbian using the Latin script for this customer turn. Sound like a helpful local coordinator: use one or two short natural sentences, no em or en dashes, no headings, labels, raw Markdown, technical terms, or generic AI filler.",
  "sr-Cyrl": "Reply only in Serbian using the Cyrillic script for this customer turn. Sound like a helpful local coordinator: use one or two short natural sentences, no em or en dashes, no headings, labels, raw Markdown, technical terms, or generic AI filler.",
};

const conversationInstruction = "You are a friendly, professional local coordinator, not a form. The durable conversation contains the relevant history of this one cleaning request; the Known validated data is the current source of truth for facts already confirmed. First answer the customer's direct question in a natural sentence. Then, only if useful, make one small next step toward a quote or booking, asking at most one or two related details. Do not repeat facts already known. Do not start ordinary replies with Thanks, Thank you, I noted that, or their translations. Avoid headings, colon-led lists, long dashes, scripted filler, internal terms and meta-commentary. If directly asked whether you are human, answer truthfully that you are Sherlock Cleaning's digital assistant, then continue helping.";

const intakeInstruction = "Process facts in every customer message regardless of its script. A Cyrillic message may include Latin measurement notation such as m2 or m², a local district such as Vračar, or an ISO date; that does not make it English. Before replying or escalating, call update_client_data with every stated supported fact: cleaning type, area, rooms, bathrooms, pet hair, extras, address or district, and requested date. Use null only for a field that the customer did not state. For renovation, commercial or other human-review work, save the stated facts first, then call mark_human_needed. Never respond that details are missing when the current message already states them.";

const dateIntakeInstruction = "Treat customer-friendly date language as valid: a Russian date without a year such as \"26 августа\", relative phrases such as \"через 2 дня\", and a weekend request. Do not demand DD.MM.YYYY or another rigid format. Use YYYY-MM-DD only when you save a date in update_client_data; the backend may already have normalised the customer date. If a date phrase is genuinely ambiguous, propose one concrete local date and ask whether it works. A date is optional for an initial estimate and is needed before scheduling. Never ask about an internal urgency field.";

function schedulingInstruction(snapshot: SchedulingSnapshot | undefined, required: boolean): string {
  if (!snapshot) return "";
  const context = JSON.stringify(snapshot);
  if (!required) return `Authoritative scheduling state for context: ${context}`;
  return `Authoritative scheduling state: ${context}\n\nThis turn is in QUOTED or OFFERED scheduling state. Before writing your final reply, you MUST make one typed scheduling decision. For an availability question, any request for another date/time, or a changed time/date preference, call request_available_slots with exactly {intent:{date,time,relation,existingOfferDisposition}}. Select only a date.kind offered by the function schema. If currentTurnDateCoordinate is present, it is the exclusive current-message-only coordinate: choose only its date reference and do not use an older preferred date or offer in this request. Do not treat it as a durable lead fact. When it is absent, current_preferred_date exists only with a durable preferred date. Use day_after_last_offer only if snapshot.lastOffer contains an actual active offer. lastAvailabilityAttempt is an auditable prior Calendar check, not a durable preference: its candidate exact date remains selectable alongside older durable references. After a no_slots or failure result, a time-only refinement must select that exact candidate date and call Calendar again. time.kind must be preserve, any, morning, midday, evening, after with afterLocalTime, before with beforeLocalTime, or range with ordered afterLocalTime and beforeLocalTime. Use preserve only for a date-only follow-up that keeps the existing time window; use any when the customer explicitly removes that window. relation is fresh or later_than_last_offer. existingOfferDisposition is none only when snapshot has no lastOffer; retain_until_replacement keeps an existing offer until fresh results replace it; reject_now only when the customer clearly rejects the old options. Do not say that you will check later. If the customer's message is genuinely unrelated to availability or only acknowledges an existing offer, call record_scheduling_decision with the truthful reason. First save any new supported order facts with update_client_data. If that invalidates the quote, call calculate_quote and show the revised price; do not mix a new quote with a Calendar offer in the same customer turn.`;
}

function pricingInstruction(pricingRules: PricingRules): string {
  return `Current deterministic pricing rules for explanation only: ${JSON.stringify(pricingRules)}. You may explain that the exact amount is confirmed by the backend, and that a same-day date applies the configured multiplier. Never do arithmetic, invent an amount, invent availability, or confirm a booking yourself. Use calculate_quote after the base cleaning inputs are available; a date and time window are not required for a first quote. Ask for a date before scheduling, or when a same-day price needs to be confirmed.`;
}

function usageFromRunResult(result: { runContext: { usage: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number; inputTokensDetails?: unknown } } }): NonNullable<AgentTurn["usage"]> {
  return {
    requests: result.runContext.usage.requests,
    inputTokens: result.runContext.usage.inputTokens,
    outputTokens: result.runContext.usage.outputTokens,
    totalTokens: result.runContext.usage.totalTokens,
    cachedInputTokens: cachedInputTokens(Array.isArray(result.runContext.usage.inputTokensDetails)
      ? result.runContext.usage.inputTokensDetails.filter((detail): detail is Record<string, number> => typeof detail === "object" && detail !== null)
      : []),
  };
}

function serbianText(language: string, latin: string, cyrillic: string): string {
  return isSerbianCyrillic(language) ? cyrillic : latin;
}

function isObjectWithNumber<K extends string>(value: unknown, key: K): value is Record<K, number> {
  return typeof value === "object" && value !== null && key in value &&
    typeof (value as Record<string, unknown>)[key] === "number";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
