import { AgentTurnTechnicalError, type AgentGateway, type AgentTurnInput, type AgentTurnTechnicalCode, type SchedulingAvailabilityIntent } from "@/lib/agent/gateway";
import { FakeCalendarGateway } from "@/lib/calendar/gateway";
import { CalendarReservationService } from "@/lib/calendar/reservation-service";
import { SchedulingEngine } from "@/lib/scheduling/engine";
import type { AgentToolName, AgentToolResult, ClientData, CurrentTurnDateCoordinate, PricingRules, SchedulingSemanticAction } from "@/lib/contracts/domain";
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
    /** Synthetic adapter failure, distinct from a successful fully-booked read. */
    calendarTransportFails?: boolean;
    /** Isolated fake-calendar capacity for the 90m² evening booking acceptance path. */
    evening90m2Slot?: boolean;
    /** Per-scenario synthetic clock; no external clock is consulted. */
    now?: string;
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
    schedulingActions?: SchedulingSemanticAction[];
    statelessRecovery?: "scheduling_omission_replay" | "provider_failure_replay";
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
  /** Each semantic availability query must read both Team A and Team B. */
  calendarAvailabilityQueries?: number;
  slotOffer: boolean;
  slotOfferCount: number;
  /** Ordered state/tool projection after each fully processed customer message. */
  messageEvidence: Array<{
    /** Only the post-webhook atomic checkpoint may produce this evidence. */
    provenance: "post_customer_message_checkpoint";
    customerMessageNumber: number;
    customer: string;
    semanticTools: AgentToolName[];
    /** Canonical, PII-free scheduling action(s) for this customer message. */
    schedulingActions?: SchedulingSemanticAction[];
    quoteAmountRsd?: number;
    quoteState: "active" | "superseded" | "none";
    preferredDate?: string;
    preferredTimeWindow?: "morning" | "midday" | "evening";
    humanNeeded: boolean;
    humanNeededReason?: string;
    calendarCreates: number;
    calendarAvailabilityQueries?: number;
    slotOfferCount: number;
    /** Sorted start instants only from current active fake slot tokens. */
    activeSlotStarts?: string[];
    /** Safe durable availability context only; never an activity, token or provider ID. */
    lastAvailabilityAttempt?: {
      result: "exact_offer" | "fallback_offer" | "no_slots" | "failure";
      candidateDate: string;
      timePreference: "any" | "morning" | "midday" | "evening" | "after" | "before" | "range";
      timePreferenceMode: "preserve" | "explicit";
      afterLocalTime?: string;
      beforeLocalTime?: string;
      relation: "fresh" | "later_than_last_offer";
    };
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
  /** A double provider failure has server recovery copy but not the lost model
   * response; live evaluation must stop rather than feed the next fixture line
   * into that changed state. */
  stopAfterTechnicalTurn?: boolean;
};

class ScriptedAgentGateway implements AgentGateway {
  readonly turns: SanitizedConversationArtifact["turns"] = [];
  private index = 0;

  constructor(private readonly script: SandboxAgentTurn[], private readonly turnLimit: number) {}

  async createConversation(): Promise<{ id: string }> {
    return { id: "sandbox-conversation" };
  }

  async runTurn(input: AgentTurnInput) {
    const scripted = this.script[this.index++];
    if (!scripted) {
      // The deterministic suite is not a second production router.  It only
      // supplies a typed stand-in after its intake script deliberately ends,
      // so the real webhook/Calendar path remains covered while live
      // evaluation leaves semantic interpretation to OpenAI.
      if (!input.schedulingDecisionRequired) throw new Error("Scenario invoked the agent more times than its script allows");
      this.index -= 1;
      const acknowledgement = /(?:спасибо|жду|thanks|thank you|hvala|čekam|cekan)/iu.test(input.message);
      if (acknowledgement) {
        const output = await input.executeTool("record_scheduling_decision", { reason: "already_reserved" });
        const schedulingActions = [{ kind: "no_calendar" as const, reason: "already_reserved" as const }];
        this.turns.push({
          knownClientData: structuredClone(input.knownClientData),
          pricingRulesVersion: input.pricingRules?.version ?? 0,
          allowedTools: [...(input.allowedTools ?? [])],
          semanticTools: ["record_scheduling_decision"],
          schedulingActions,
        });
        return {
          reply: "The booking remains confirmed.",
          toolResults: [{ name: "record_scheduling_decision" as const, output }],
          schedulingActions,
          steps: 1,
        };
      }
      const intent = sandboxAvailabilityIntent(input.message, Boolean(input.schedulingSnapshot?.lastOffer), input.schedulingSnapshot?.currentTurnDateCoordinate);
      const output = await input.executeTool("request_available_slots", { intent });
      const toolResults: AgentToolResult[] = [{ name: "request_available_slots", output }];
      this.turns.push({
        knownClientData: structuredClone(input.knownClientData),
        pricingRulesVersion: input.pricingRules?.version ?? 0,
        allowedTools: [...(input.allowedTools ?? [])],
        semanticTools: ["request_available_slots"],
        schedulingActions: [{ kind: "availability", dateReference: intent.dateReference, timePreference: intent.timePreference, timePreferenceMode: intent.timePreferenceMode, relation: intent.relation, ...(intent.afterLocalTime ? { afterLocalTime: intent.afterLocalTime } : {}), ...(intent.beforeLocalTime ? { beforeLocalTime: intent.beforeLocalTime } : {}) }],
      });
      return {
        reply: "I am checking the current team availability.",
        toolResults,
        schedulingActions: [{ kind: "availability" as const, dateReference: intent.dateReference, timePreference: intent.timePreference, timePreferenceMode: intent.timePreferenceMode, relation: intent.relation, ...(intent.afterLocalTime ? { afterLocalTime: intent.afterLocalTime } : {}), ...(intent.beforeLocalTime ? { beforeLocalTime: intent.beforeLocalTime } : {}) }],
        steps: 1,
      };
    }
    if (this.index > this.turnLimit) throw new Error("Scenario exceeded its configured agent-turn limit");
    const semanticTools: AgentToolName[] = [];
    const toolResults: AgentToolResult[] = [];
    const schedulingActions: SchedulingSemanticAction[] = [];
    const execute = async (name: AgentToolName, argumentsJson: unknown) => {
      semanticTools.push(name);
      const output = await input.executeTool(name, argumentsJson);
      toolResults.push({ name, output });
      // A completed Calendar read is semantic evidence even when it returns
      // a normal no-slots business result. Only a refused no-Calendar action
      // is excluded from the audit surface.
      if (name === "request_available_slots") {
        const intent = (argumentsJson as { intent: SchedulingAvailabilityIntent }).intent;
        schedulingActions.push({ kind: "availability", ...intent });
      }
      return output;
    };

    const recordedTurn: SanitizedConversationArtifact["turns"][number] = {
      knownClientData: structuredClone(input.knownClientData),
      pricingRulesVersion: input.pricingRules?.version ?? 0,
      allowedTools: [...(input.allowedTools ?? [])],
      semanticTools,
    };
    this.turns.push(recordedTurn);

    const schedulingPatch = input.schedulingDecisionRequired && scripted.patch &&
      (Object.hasOwn(scripted.patch, "preferredDate") || Object.hasOwn(scripted.patch, "preferredTimeWindow"));
    if (schedulingPatch) {
      const timePreference = scripted.patch?.preferredTimeWindow ?? "any";
      const intent = {
        dateReference: scripted.patch?.preferredDate ? "exact_date" as const : "current_preferred_date" as const,
        ...(scripted.patch?.preferredDate ? { exactDate: scripted.patch.preferredDate } : {}),
        timePreference,
        timePreferenceMode: timePreference === "any" ? "preserve" as const : "explicit" as const,
        relation: "fresh" as const,
      };
      await execute("request_available_slots", { intent });
    } else if (scripted.patch) await execute("update_client_data", { patch: scripted.patch });
    if (scripted.action === "quote" && !schedulingPatch) await execute("calculate_quote", {});
    if (scripted.action === "slots") await execute("request_available_slots", {
      intent: { dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" },
    });
    if (scripted.action === "human") await execute("mark_human_needed", { reason: "scope_uncertain" });
    if (schedulingActions.length) recordedTurn.schedulingActions = schedulingActions;
    return { reply: scripted.reply, toolResults, ...(schedulingActions.length ? { schedulingActions } : {}), steps: semanticTools.length };
  }

  assertConsumed(): void {
    if (this.index !== this.script.length) throw new Error(`Scenario left ${this.script.length - this.index} scripted agent turns unused`);
  }
}

function sandboxAvailabilityIntent(
  message: string,
  hasActiveOffer = false,
  currentTurnDateCoordinate?: CurrentTurnDateCoordinate,
) {
  const normalized = message.toLocaleLowerCase();
  const timePreference = /(?:between\s+10:00\s+and\s+16:00|между\s+10:00\s+и\s+16:00)/u.test(normalized)
    ? "range" as const
    : /(?:после\s+19|after\s+19|после\s+19:00)/u.test(normalized)
    ? "after" as const
    : /(?:вечер|evening|uveče|uvece|вече)/u.test(normalized)
    ? "evening" as const
    : /(?:середине дня|midday|noon|подне)/u.test(normalized)
    ? "midday" as const
    : "any" as const;
  const coordinateDate = currentTurnDateCoordinate?.recommendedDateReference === "today"
    ? { dateReference: "today" as const }
    : currentTurnDateCoordinate?.recommendedDateReference === "tomorrow"
      ? { dateReference: "tomorrow" as const }
      : currentTurnDateCoordinate?.recommendedDateReference === "exact_date"
        ? { dateReference: "exact_date" as const, exactDate: currentTurnDateCoordinate.date }
        : undefined;
  const date = coordinateDate ?? (/(?:этот\s+же\s+день|same\s+day)/u.test(normalized)
    ? { dateReference: "same_day_as_last_offer" as const }
    : /(?:завтра|tomorrow)/u.test(normalized)
      ? { dateReference: "tomorrow" as const }
      : /(?:следующ|next day|sutra)/u.test(normalized)
        ? { dateReference: "day_after_last_offer" as const }
        : { dateReference: "current_preferred_date" as const });
  return {
    ...date,
    timePreference,
    timePreferenceMode: timePreference === "any" && !/(?:any\s+time|в\s+любое\s+время|bilo\s+koje\s+vreme)/u.test(normalized) ? "preserve" as const : "explicit" as const,
    relation: /(?:позже|later)/u.test(normalized) ? "later_than_last_offer" as const : "fresh" as const,
    existingOfferDisposition: /(?:none of those|не подходит)/u.test(normalized)
      ? "reject_now" as const
      : hasActiveOffer ? "retain_until_replacement" as const : "none" as const,
    ...(timePreference === "after" ? { afterLocalTime: "19:00" } : {}),
    ...(timePreference === "range" ? { afterLocalTime: "10:00", beforeLocalTime: "16:00" } : {}),
  };
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
        ...(result.schedulingActions?.length ? { schedulingActions: result.schedulingActions } : {}),
        ...(result.statelessRecovery ? { statelessRecovery: result.statelessRecovery } : {}),
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
        ...(technical?.usageUnreconciledReason
          ? { usageUnreconciledReason: technical.usageUnreconciledReason }
          : technical?.usage
            ? {}
            : { usageUnreconciledReason: "provider_turn_unreconciled" }),
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
  if (scenario.expected.calendarTransportFails) {
    calendar.getBusyIntervals = async () => { throw new Error("synthetic_calendar_transport_failure"); };
  }
  if (!options.agent && !scenario.agentTurns) throw new Error(`Scenario ${scenario.id} has no deterministic agent script`);
  const scriptedAgent = options.agent ? undefined : new ScriptedAgentGateway(scenario.agentTurns!, agentTurnLimit);
  const recordedAgent = options.agent ? new RecordingAgentGateway(options.agent) : undefined;
  const agent = recordedAgent ?? scriptedAgent!;
  const now = new Date(scenario.expected.now ?? "2026-08-24T10:00:00.000Z");
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
    const leadForEvidence = repository.getLead(70_000);
    if (!leadForEvidence) throw new Error(`Scenario ${scenario.id} lost its lead before evidence checkpoint`);
    // Audit only sorted start instants from currently active fake tokens. Do
    // not retain token, offer, provider or Calendar identifiers in evidence.
    const activeSlotStarts = (await repository.listActiveCalendarSlotTokens({
      leadId: leadForEvidence.id,
      now: now.toISOString(),
    })).map((token) => token.start).sort();
    const lastAvailabilityAttempt = await repository.getLastAvailabilityAttempt(leadForEvidence.id);
    messageEvidence.push({
      provenance: "post_customer_message_checkpoint",
      customerMessageNumber: index + 1,
      customer: text,
      semanticTools: newTurns.flatMap((turn) => turn.semanticTools),
      ...(newTurns.flatMap((turn) => turn.schedulingActions ?? []).length > 0
        ? { schedulingActions: newTurns.flatMap((turn) => turn.schedulingActions ?? []) }
        : {}),
      ...(snapshot.lead.quoteAmountRsd === undefined ? {} : { quoteAmountRsd: snapshot.lead.quoteAmountRsd }),
      quoteState: snapshot.lead.quoteState,
      ...(snapshot.lead.clientData.preferredDate ? { preferredDate: snapshot.lead.clientData.preferredDate } : {}),
      ...(snapshot.lead.clientData.preferredTimeWindow ? { preferredTimeWindow: snapshot.lead.clientData.preferredTimeWindow } : {}),
      humanNeeded: snapshot.lead.humanNeeded,
      ...(snapshot.lead.humanNeededReason ? { humanNeededReason: snapshot.lead.humanNeededReason } : {}),
      calendarCreates: snapshot.calendarCreates,
      calendarAvailabilityQueries: snapshot.calendarAvailabilityQueries,
      slotOfferCount: snapshot.slotOfferCount,
      activeSlotStarts,
      ...(lastAvailabilityAttempt ? {
        lastAvailabilityAttempt: {
          result: lastAvailabilityAttempt.result,
          candidateDate: lastAvailabilityAttempt.candidateDate,
          timePreference: lastAvailabilityAttempt.timePreference,
          timePreferenceMode: lastAvailabilityAttempt.timePreferenceMode,
          ...(lastAvailabilityAttempt.afterLocalTime ? { afterLocalTime: lastAvailabilityAttempt.afterLocalTime } : {}),
          ...(lastAvailabilityAttempt.beforeLocalTime ? { beforeLocalTime: lastAvailabilityAttempt.beforeLocalTime } : {}),
          relation: lastAvailabilityAttempt.relation,
        },
      } : {}),
    });
    if (options.afterCustomerMessage) {
      await options.afterCustomerMessage({
        artifact: snapshotArtifact(scenario.id, scenario.customerMessages.slice(0, index + 1), telegram, scriptedAgent, recordedAgent, repository, calendar, messageEvidence),
        customerMessagesCompleted: index + 1,
        customerMessageDurationMs: Date.now() - startedAt,
      });
    }
    if (options.stopAfterTechnicalTurn && newTurns.some((turn) => turn.technicalFailureCode !== undefined)) {
      throw new Error("provider_replay_double_failure_message_not_replayed");
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
  calendarAvailabilityQueries: calendar.availabilityQueries.length,
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
