import { AgentTurnTechnicalError, type AgentGateway, type AgentTurnInput, type AgentTurnTechnicalCode } from "@/lib/agent/gateway";
import { FakeCalendarGateway } from "@/lib/calendar/gateway";
import { CalendarReservationService } from "@/lib/calendar/reservation-service";
import { SchedulingEngine } from "@/lib/scheduling/engine";
import type { AgentToolName, AgentToolResult, ClientData, PricingRules } from "@/lib/contracts/domain";
import { InMemoryLeadRepository } from "@/lib/leads/in-memory-repository";
import { FakeTelegramGateway } from "@/lib/telegram/gateway";
import { processTelegramWebhook } from "@/lib/telegram/webhook";
import { isFocusedModelIntakeFollowup } from "@/lib/telegram/intake-focus";
import { FakeTrelloGateway } from "@/lib/trello/gateway";
import { TrelloSyncService } from "@/lib/trello/sync-service";

export type SandboxAction = "quote" | "slots" | "human";

export type SandboxAgentTurn = {
  reply: string;
  patch?: ClientData;
  action?: SandboxAction;
};

export type ConversationScenario = {
  id: string;
  customerMessages: string[];
  /** Required for deterministic sandbox tests; a live evaluation injects its own gateway. */
  agentTurns?: SandboxAgentTurn[];
  /** Explicit cap for model invocations; strict transport fast-paths may use fewer turns. */
  agentTurnLimit: number;
  expected: {
    quote?: boolean;
    humanNeeded?: boolean;
    calendarCreates?: number;
    slotOffer?: boolean;
    replyLanguage?: "en" | "ru" | "sr-Latn" | "sr-Cyrl";
    checkpoints?: Array<"quote" | "slots" | "reservation" | "human_needed" | "same_day">;
    calendarFullyBooked?: boolean;
    /** Isolated fake-calendar capacity for the 90m² evening booking acceptance path. */
    evening90m2Slot?: boolean;
  };
};

export type SanitizedConversationArtifact = {
  scenarioId: string;
  transcript: Array<{
    customer: string;
    /** Exact sanitized Telegram transport payload, retained separately from visible prose. */
    transportText: string;
    /** Customer-visible normalized prose used by the conversational rubric. */
    visibleText: string;
    /** Only backend renderer templates may send raw Telegram HTML. */
    trustedTransport: boolean;
  }>;
  turns: Array<{
    /** Provider boundary which started; useful for a failed create with no model turn. */
    operation?: "conversation_create" | "run_turn";
    knownClientData: ClientData;
    pricingRulesVersion: number;
    /** Backend-derived SDK surface exposed for this exact customer turn. */
    allowedTools: AgentToolName[];
    semanticTools: AgentToolName[];
    /** Sanitized operational category only; no provider exception text. */
    technicalFailureCode?: AgentTurnTechnicalCode;
    /** Wall duration of this started SDK turn, including a failed turn. */
    elapsedMs?: number;
    usage?: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number };
    usageUnreconciledReason?: string;
  }>;
  lead: {
    status: string;
    clientData: ClientData;
    hasQuote: boolean;
    quoteAmountRsd?: number;
    quoteState: "active" | "superseded" | "none";
    humanNeeded: boolean;
    humanNeededReason?: string;
  };
  calendarCreates: number;
  slotOffer: boolean;
  slotOfferCount: number;
  /** Ordered state/tool projection after each fully processed customer message. */
  messageEvidence: Array<{
    /** Only the post-webhook atomic checkpoint may produce this evidence. */
    provenance: "post_customer_message_checkpoint";
    customerMessageNumber: number;
    customer: string;
    semanticTools: AgentToolName[];
    quoteAmountRsd?: number;
    quoteState: "active" | "superseded" | "none";
    preferredDate?: string;
    humanNeeded: boolean;
    humanNeededReason?: string;
    calendarCreates: number;
    slotOfferCount: number;
  }>;
};

export type ConversationScenarioRunOptions = {
  /**
   * Only the injected agent may be live. Every transport and operational
   * adapter remains in memory, so an evaluation cannot send Telegram,
   * create Calendar events, or write a Trello card.
   */
  agent?: AgentGateway;
  agentTurnLimit?: number;
  /** Evaluator deadline guard applied to the whole customer-message loop. */
  beforeCustomerMessage?: (checkpoint: { customerMessagesCompleted: number; customerMessagesTotal: number }) => Promise<void> | void;
  /** Awaited after every fully processed customer message for atomic evaluator checkpoints. */
  afterCustomerMessage?: (checkpoint: {
    artifact: SanitizedConversationArtifact;
    customerMessagesCompleted: number;
    customerMessageDurationMs: number;
  }) => Promise<void> | void;
};

class ScriptedAgentGateway implements AgentGateway {
  readonly turns: SanitizedConversationArtifact["turns"] = [];
  private index = 0;

  constructor(private readonly script: SandboxAgentTurn[], private readonly turnLimit: number) {}

  async createConversation(): Promise<{ id: string }> {
    return { id: "sandbox-conversation" };
  }

  async runTurn(input: AgentTurnInput) {
    if (this.index >= this.turnLimit) throw new Error("Scenario exceeded its configured agent-turn limit");
    const scripted = this.script[this.index++];
    if (!scripted) throw new Error("Scenario invoked the agent more times than its script allows");
    const semanticTools: AgentToolName[] = [];
    const toolResults: AgentToolResult[] = [];
    const execute = async (name: AgentToolName, argumentsJson: unknown) => {
      semanticTools.push(name);
      const output = await input.executeTool(name, argumentsJson);
      toolResults.push({ name, output });
      return output;
    };

    this.turns.push({
      knownClientData: structuredClone(input.knownClientData),
      pricingRulesVersion: input.pricingRules?.version ?? 0,
      allowedTools: [...(input.allowedTools ?? [])],
      semanticTools,
    });

    if (scripted.patch) await execute("update_client_data", { patch: scripted.patch });
    if (scripted.action === "quote") await execute("calculate_quote", {});
    if (scripted.action === "slots") await execute("request_available_slots", {});
    if (scripted.action === "human") await execute("mark_human_needed", { reason: "scope_uncertain" });
    return { reply: scripted.reply, toolResults, steps: semanticTools.length };
  }

  assertConsumed(): void {
    if (this.index !== this.script.length) throw new Error(`Scenario left ${this.script.length - this.index} scripted agent turns unused`);
  }
}

/** Captures only evaluator-safe metadata from an injected gateway's turn. */
class RecordingAgentGateway implements AgentGateway {
  readonly turns: SanitizedConversationArtifact["turns"] = [];

  constructor(private readonly delegate: AgentGateway) {}

  async createConversation(leadId: string, signal?: AbortSignal): Promise<{ id: string }> {
    const startedAt = performance.now();
    try {
      return await this.delegate.createConversation(leadId, signal);
    } catch (error) {
      const technical = error instanceof AgentTurnTechnicalError ? error : undefined;
      if (technical) {
        this.turns.push({
          operation: "conversation_create",
          knownClientData: {},
          pricingRulesVersion: 0,
          allowedTools: [],
          semanticTools: [],
          usage: technical.usage,
          usageUnreconciledReason: technical.usageUnreconciledReason ?? "provider_conversation_create_usage_unreconciled",
          technicalFailureCode: technical.code,
          elapsedMs: performance.now() - startedAt,
        });
      }
      throw error;
    }
  }

  async runTurn(input: AgentTurnInput) {
    const startedAt = performance.now();
    try {
      const result = await this.delegate.runTurn(input);
      this.turns.push({
        operation: "run_turn",
        knownClientData: structuredClone(input.knownClientData),
        pricingRulesVersion: input.pricingRules?.version ?? 0,
        allowedTools: [...(input.allowedTools ?? [])],
        semanticTools: result.toolResults.map((toolResult) => toolResult.name),
        usage: result.usage,
        usageUnreconciledReason: result.usageUnreconciledReason,
        elapsedMs: performance.now() - startedAt,
      });
      return result;
    } catch (error) {
      // Preserve only released aggregate usage on the partial checkpoint. A
      // thrown provider turn is not silently treated as zero-cost evidence.
      const technical = error instanceof AgentTurnTechnicalError ? error : undefined;
      this.turns.push({
        operation: "run_turn",
        knownClientData: structuredClone(input.knownClientData),
        pricingRulesVersion: input.pricingRules?.version ?? 0,
        allowedTools: [...(input.allowedTools ?? [])],
        semanticTools: [],
        usage: technical?.usage,
        usageUnreconciledReason: technical?.usageUnreconciledReason ?? "provider_turn_unreconciled",
        ...(technical ? { technicalFailureCode: technical.code } : {}),
        elapsedMs: performance.now() - startedAt,
      });
      throw error;
    }
  }
}

/**
 * Exercises the real webhook orchestration with only in-memory adapters. It
 * deliberately has no Telegram, OpenAI, Supabase, Calendar or Trello network
 * path, so a scenario is safe to run in CI and leaves no external artefacts.
 */
export async function runConversationScenario(
  scenario: ConversationScenario,
  options: ConversationScenarioRunOptions = {},
): Promise<SanitizedConversationArtifact> {
  if (scenario.customerMessages.length < 3 || scenario.customerMessages.length > 8) {
    throw new Error(`Scenario ${scenario.id} must contain 3 to 8 customer messages`);
  }
  const agentTurnLimit = options.agentTurnLimit ?? scenario.agentTurnLimit;
  if (!Number.isInteger(agentTurnLimit) || agentTurnLimit < 1 || agentTurnLimit > 8) {
    throw new Error(`Scenario ${scenario.id} has an invalid agent-turn limit`);
  }
  if (scenario.agentTurns && scenario.agentTurns.length > agentTurnLimit) {
    throw new Error(`Scenario ${scenario.id} script exceeds its configured agent-turn limit`);
  }
  const repository = new InMemoryLeadRepository();
  const telegram = new FakeTelegramGateway();
  const calendar = new FakeCalendarGateway();
  if (scenario.expected.calendarFullyBooked) {
    const interval = { start: "2026-08-24T06:00:00.000Z", end: "2026-09-10T18:00:00.000Z" };
    calendar.busyByTeam = { team_a: [interval], team_b: [interval] };
  }
  if (!options.agent && !scenario.agentTurns) throw new Error(`Scenario ${scenario.id} has no deterministic agent script`);
  const scriptedAgent = options.agent ? undefined : new ScriptedAgentGateway(scenario.agentTurns!, agentTurnLimit);
  const recordedAgent = options.agent ? new RecordingAgentGateway(options.agent) : undefined;
  const agent = recordedAgent ?? scriptedAgent!;
  const now = new Date("2026-08-24T10:00:00.000Z");
  const reservation = new CalendarReservationService(repository, calendar, scenario.expected.evening90m2Slot ? new Evening90m2FixtureSchedulingEngine() : undefined, () => now);
  const trelloSync = new TrelloSyncService(repository, new FakeTrelloGateway());
  const messageEvidence: SanitizedConversationArtifact["messageEvidence"] = [];
  let priorTurnCount = 0;

  for (const [index, text] of scenario.customerMessages.entries()) {
    await options.beforeCustomerMessage?.({
      customerMessagesCompleted: index,
      customerMessagesTotal: scenario.customerMessages.length,
    });
    const startedAt = Date.now();
    const result = await processTelegramWebhook({
      update_id: 90_000 + index,
      message: { message_id: 80_000 + index, chat: { id: 70_000 }, text },
    }, { repository, telegram, agent, calendarReservation: reservation, trelloSync, now: () => now });
    if (result.kind !== "processed") throw new Error(`Scenario ${scenario.id} did not process message ${index + 1}`);
    const snapshot = snapshotArtifact(scenario.id, scenario.customerMessages.slice(0, index + 1), telegram, scriptedAgent, recordedAgent, repository, calendar, messageEvidence);
    const newTurns = snapshot.turns.slice(priorTurnCount);
    priorTurnCount = snapshot.turns.length;
    messageEvidence.push({
      provenance: "post_customer_message_checkpoint",
      customerMessageNumber: index + 1,
      customer: text,
      semanticTools: newTurns.flatMap((turn) => turn.semanticTools),
      ...(snapshot.lead.quoteAmountRsd === undefined ? {} : { quoteAmountRsd: snapshot.lead.quoteAmountRsd }),
      quoteState: snapshot.lead.quoteState,
      ...(snapshot.lead.clientData.preferredDate ? { preferredDate: snapshot.lead.clientData.preferredDate } : {}),
      humanNeeded: snapshot.lead.humanNeeded,
      ...(snapshot.lead.humanNeededReason ? { humanNeededReason: snapshot.lead.humanNeededReason } : {}),
      calendarCreates: snapshot.calendarCreates,
      slotOfferCount: snapshot.slotOfferCount,
    });
    if (options.afterCustomerMessage) {
      await options.afterCustomerMessage({
        artifact: snapshotArtifact(scenario.id, scenario.customerMessages.slice(0, index + 1), telegram, scriptedAgent, recordedAgent, repository, calendar, messageEvidence),
        customerMessagesCompleted: index + 1,
        customerMessageDurationMs: Date.now() - startedAt,
      });
    }
  }
  try {
    scriptedAgent?.assertConsumed();
  } catch (error) {
    throw new Error(`Scenario ${scenario.id}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return snapshotArtifact(scenario.id, scenario.customerMessages, telegram, scriptedAgent, recordedAgent, repository, calendar, messageEvidence);
}

/** Test-only availability adapter: no production hours or calendar state is changed. */
class Evening90m2FixtureSchedulingEngine extends SchedulingEngine {
  override findSlots(input: Parameters<SchedulingEngine["findSlots"]>[0]) {
    if (input.clientData.areaM2 === 90 && input.clientData.preferredDate === "2026-08-26" && input.clientData.preferredTimeWindow === "evening") {
      return [{ team: "team_a" as const, start: "2026-08-26T14:00:00.000Z", end: "2026-08-26T18:00:00.000Z", bufferEnd: "2026-08-26T18:30:00.000Z" }];
    }
    return super.findSlots(input);
  }
}

function snapshotArtifact(
  scenarioId: string,
  customerMessages: string[],
  telegram: FakeTelegramGateway,
  scriptedAgent: ScriptedAgentGateway | undefined,
  recordedAgent: RecordingAgentGateway | undefined,
  repository: InMemoryLeadRepository,
  calendar: FakeCalendarGateway,
  messageEvidence: SanitizedConversationArtifact["messageEvidence"] = [],
): SanitizedConversationArtifact {
  const lead = repository.getLead(70_000);
  if (!lead) throw new Error(`Scenario ${scenarioId} did not create a lead`);
  const transcript = customerMessages.map((customer, index) => {
    const transportText = telegram.messages[index]?.text ?? "";
    return {
      customer,
      transportText,
      visibleText: normalizeTelegramVisibleText(transportText),
      trustedTransport: isTrustedTelegramTransport(transportText, telegram.messages[index]?.provenance),
    };
  });
  return {
    scenarioId,
    transcript,
    turns: scriptedAgent?.turns ?? recordedAgent?.turns ?? [],
    lead: {
      status: lead.status,
      clientData: structuredClone(lead.clientData),
      hasQuote: Boolean(lead.quote && lead.quoteValidity === "active"),
      ...(lead.quote ? { quoteAmountRsd: lead.quote.amountRsd } : {}),
      quoteState: lead.quoteValidity === "active" ? "active" : lead.quoteValidity === "superseded" ? "superseded" : "none",
      humanNeeded: lead.humanNeeded,
      humanNeededReason: lead.humanNeededReason,
    },
    calendarCreates: calendar.creates.length,
    slotOffer: telegram.messages.some((message) => message.replyMarkup !== undefined && "inline_keyboard" in message.replyMarkup),
    slotOfferCount: telegram.messages.filter((message) => message.replyMarkup !== undefined && "inline_keyboard" in message.replyMarkup).length,
    messageEvidence: structuredClone(messageEvidence),
  };
}

export function scenarioPricingRules(artifact: SanitizedConversationArtifact): number[] {
  return artifact.turns.map((turn) => turn.pricingRulesVersion);
}

export function hasSemanticTool(artifact: SanitizedConversationArtifact, tool: AgentToolName): boolean {
  return artifact.turns.some((turn) => turn.semanticTools.includes(tool));
}

/** Transport and internal-syntax guard. This is deliberately separate from tone and intake scope. */
export function isTransportAndInternalSafeReply(reply: string): boolean {
  return !/\b(?:update_client_data|calculate_quote|mark_human_needed|request_available_slots|qualified|human needed|slot token|event id)\b/iu.test(reply)
    && !/[<>]/u.test(reply)
    && !/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i.test(reply)
    && !/^\s*(?:#{1,6}\s|[-*]\s)/u.test(reply)
    // Only list-like field labels are rejected. Natural prose such as
    // "Коротко: помогу рассчитать" is not a bot artefact.
    && !looksLikeLabelledChecklist(reply);
}

/** Stock acknowledgements are a product-tone concern, not a transport concern. */
export function hasStockFillerReply(reply: string): boolean {
  return /^\s*(?:thanks|thank you|спасибо|хвала|hvala)[,.! ]/iu.test(reply);
}

export function isSafeCustomerReply(reply: string): boolean {
  return isTransportAndInternalSafeReply(reply)
    && !hasStockFillerReply(reply)
    && !looksLikeFullIntakeChecklist(reply);
}

/** Product acceptance: one focused question or one related pair, never an intake dump. */
export function isFocusedIntakeReply(reply: string): boolean {
  return isFocusedModelIntakeFollowup(reply);
}

/**
 * The Telegram transport is HTML, but ordinary model prose is always escaped
 * by renderAgentReply. Treat raw markup as safe only for backend-owned typed
 * templates, then grade the text a customer can actually read.
 */
export function isTrustedTelegramTransport(transportText: string, provenance?: "agent" | "template"): boolean {
  // Renderer provenance is the authority. Agent prose must have been escaped
  // and template HTML is trusted only when the typed renderer supplied it.
  return provenance === "template" || (!transportText.includes("<") && !transportText.includes(">"));
}

export function normalizeTelegramVisibleText(transportText: string): string {
  return transportText
    .replace(/<b>/gu, "")
    .replace(/<\/b>/gu, "")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

/** A normal customer reply may ask one related pair, never dump an intake form. */
function looksLikeFullIntakeChecklist(reply: string): boolean {
  if (looksLikeLabelledChecklist(reply)) return true;
  // Reject the original bad behaviour even when it is written as prose rather
  // than labelled fields. Two related questions remain natural and allowed.
  const topicGroups = [
    /(?:тип уборки|standard|deep|обычн|генеральн)/iu,
    /(?:площад|m2|m²|метр)/iu,
    /(?:комнат|rooms?|сануз|bathrooms?|купатил)/iu,
    /(?:шерст|pet hair|dlak)/iu,
    /(?:окн|духовк|балкон|extras?|дополнительн)/iu,
    /(?:адрес|район|district|дата|date|сегодня|today)/iu,
  ];
  // Count only the part that asks for missing information. Existing facts in
  // a natural sentence must not make a focused follow-up look like a form.
  const request = reply.match(/(?:какая|какой|сколько|есть ли|нужны(?: ли)?|укажите|перечислите|подскажите(?: все)?|мне нужны|what|how many|is there|do you need|i need|we need|please (?:provide|share|tell me all))[\s\S]*$/iu);
  if (!request) return false;
  const requestedGroups = topicGroups.filter((pattern) => pattern.test(request[0])).length;
  if (requestedGroups < 3) return false;
  return true;
}

function looksLikeLabelledChecklist(reply: string): boolean {
  const fields = reply.match(/(?:cleaning type|area|rooms?|bathrooms?|date|service|тип уборки|площад[ьи]|комнат[ы]?|санузл[аов]?|дат[ауые])\s*[:：]/giu) ?? [];
  return fields.length >= 3;
}

export const standardDetails: ClientData = {
  cleaningType: "standard",
  areaM2: 75,
  rooms: 3,
  bathrooms: 1,
  heavyPetHair: false,
  extras: [],
  addressOrDistrict: "Vracar",
  preferredDate: "2026-08-26",
};

export const activePricingVersion = (rules: PricingRules): number => rules.version;
