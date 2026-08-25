import { Agent, MaxTurnsExceededError, OpenAIProvider, retryPolicies, Runner, tool, type Model, type ModelProvider } from "@openai/agents";
import OpenAI from "openai";
import { z } from "zod";

import { defaultPricingRules, type AgentToolName, type AgentToolResult, type AgentTurn, type ClientData, type PricingRules } from "@/lib/contracts/domain";
import { isRussianLanguage, isSerbianCyrillic, isSerbianLanguage, type ReplyLanguage } from "@/lib/telegram/language";

export type AgentToolExecutor = (name: AgentToolName, argumentsJson: unknown) => Promise<Record<string, unknown>>;

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
const requestAvailableSlotsParameters = z.object({}).strict();

/** Never allow a customer turn to perform more than this many semantic tools. */
export const maxAgentToolSteps = 4;
/** Bound each Responses model turn; the evaluator records and enforces this cap. */
export const maxAgentOutputTokens = 1200;

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
    let modelToolSteps = 0;
    // `update_client_data` is an atomic, validated merge owned by the
    // webhook.  A second model request must not be invited to overwrite it;
    // other semantic tools can still close the same customer turn.
    let updateClientDataAttempted = false;
    const execute = async (name: AgentToolName, argumentsJson: unknown): Promise<Record<string, unknown>> => {
      throwIfAborted(input.signal);
      if (name === "update_client_data") {
        if (updateClientDataAttempted) {
          throw new AgentTurnTechnicalError("agent_duplicate_update_client_data");
        }
        updateClientDataAttempted = true;
      }
      if (modelToolSteps >= this.maxToolSteps) {
        return { ok: false, error: "tool_step_limit_reached" };
      }
      modelToolSteps += 1;
      try {
        const output = await input.executeTool(name, argumentsJson);
        throwIfAborted(input.signal);
        toolResults.push({ name, output });
        return output;
      } catch (error) {
        if (error instanceof AgentTurnTechnicalError) throw error;
        throwIfAborted(input.signal);
        const output = { ok: false, error: "invalid_tool_arguments" };
        toolResults.push({ name, output });
        return output;
      }
    };
    const toolsEnabled = (name: AgentToolName) => modelToolSteps < this.maxToolSteps &&
      (input.allowedTools?.includes(name) ?? true) &&
      (name !== "update_client_data" || !updateClientDataAttempted);
    const agent = new Agent({
      name: "Sherlock Cleaning Agent",
      model: this.model,
      instructions: `${input.systemPrompt}\n\n${languageInstruction}\n\n${conversationInstruction}\n\n${intakeInstruction}\n\n${dateIntakeInstruction}\n\n${pricingInstruction(input.pricingRules ?? defaultPricingRules)}\n\nThe backend derives urgency deterministically from the requested cleaning date in Europe/Belgrade. Do not ask the customer to choose standard versus same-day urgency, and do not send an urgency field in update_client_data.\n\nA quote is terminal for the current customer turn. After calculate_quote returns a quote, write the short customer-facing answer and do not request availability in that same turn. Only request_available_slots after the customer later expresses a clear scheduling intent and the backend confirms that a previously active quote exists.`,
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
          description: "Request up to three real, server-generated available time options after an active quote. The backend presents choices securely; never invent times or identifiers.",
          parameters: requestAvailableSlotsParameters,
          strict: true,
          isEnabled: () => toolsEnabled("request_available_slots"),
          execute: (argumentsJson) => execute("request_available_slots", argumentsJson),
        }),
      ],
      modelSettings: {
        ...(this.requestTimeoutMs ? { timeoutMs: this.requestTimeoutMs } : {}),
        toolChoice: "auto",
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

    try {
      const result = await this.runner.run(
        agent,
        `Known validated data: ${JSON.stringify(input.knownClientData)}\nCustomer message: ${input.message}`,
        {
          conversationId: input.conversationId,
          maxTurns: this.maxResponsesPerTurn,
          signal: input.signal,
          toolExecution: { maxFunctionToolConcurrency: 1 },
        },
      );
      return {
        reply: typeof result.finalOutput === "string" && result.finalOutput.trim().length > 0
          ? result.finalOutput
          : fallbackReply(input.replyLanguage),
        toolResults,
        steps: modelToolSteps,
        usage: {
          requests: result.runContext.usage.requests,
          inputTokens: result.runContext.usage.inputTokens,
          outputTokens: result.runContext.usage.outputTokens,
          totalTokens: result.runContext.usage.totalTokens,
          cachedInputTokens: cachedInputTokens(result.runContext.usage.inputTokensDetails),
        },
      };
    } catch (error) {
      // Evaluator control fences are not provider failures. Their exact typed
      // codes drive terminal incomplete/deadline reporting and must survive
      // unchanged through the SDK boundary.
      if (isEvaluatorControlError(error)) throw error;
      if (input.signal?.aborted && input.signal.reason) throw input.signal.reason;
      // The Agents SDK wraps a function-tool exception from a single model
      // response in ToolCallError. Keep our typed fail-closed cause intact so
      // callers never turn it into model-visible recovery output.
      const technicalToolCause = extractTechnicalToolCause(error);
      if (technicalToolCause) throw technicalToolCause;
      if (error instanceof MaxTurnsExceededError) {
        const partialUsage = usageFromMaxTurnsError(error);
        throw new AgentTurnTechnicalError(
          "agent_max_turns_exceeded",
          partialUsage,
          partialUsage ? undefined : "max_turns_usage_unavailable",
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
      throw new AgentTurnTechnicalError(
        normalizeProviderTechnicalCode(error),
        partialUsage,
        partialUsage ? undefined : "provider_turn_usage_unreconciled",
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

function extractTechnicalToolCause(error: unknown): AgentTurnTechnicalError | undefined {
  if (error instanceof AgentTurnTechnicalError) return error;
  if (typeof error === "object" && error !== null && "error" in error) {
    const cause = (error as { error?: unknown }).error;
    return cause instanceof AgentTurnTechnicalError ? cause : undefined;
  }
  return undefined;
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

    const updateOutput = await input.executeTool("update_client_data", { patch });
    toolResults.push({ name: "update_client_data", output: updateOutput });

    if (containsOutOfScopeSignal(input.message)) {
      const escalationOutput = await input.executeTool("mark_human_needed", { reason: inferOutOfScopeReason(input.message) });
      toolResults.push({ name: "mark_human_needed", output: escalationOutput });
      return {
        reply: replyForLanguage(input.replyLanguage, "human_needed"),
        toolResults,
        steps: 1,
      };
    }

    if (/\b(slots?|availability|available time|schedule)\b/i.test(input.message)) {
      const output = await input.executeTool("request_available_slots", {});
      toolResults.push({ name: "request_available_slots", output });
      return {
        reply: output.ok === true
          ? replyForLanguage(input.replyLanguage, "slots")
          : replyForLanguage(input.replyLanguage, "human_needed"),
        toolResults,
        steps: 1,
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

function pricingInstruction(pricingRules: PricingRules): string {
  return `Current deterministic pricing rules for explanation only: ${JSON.stringify(pricingRules)}. You may explain that the exact amount is confirmed by the backend, and that a same-day date applies the configured multiplier. Never do arithmetic, invent an amount, invent availability, or confirm a booking yourself. Use calculate_quote after the base cleaning inputs are available; a date and time window are not required for a first quote. Ask for a date before scheduling, or when a same-day price needs to be confirmed.`;
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
