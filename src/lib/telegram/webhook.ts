import { z } from "zod";
import { randomUUID } from "node:crypto";

import { AgentTurnTechnicalError, schedulingAvailabilityIntentSchema, type AgentGateway, type SchedulingAvailabilityIntent, type SchedulingSnapshot } from "@/lib/agent/gateway";
import { CalendarReservationService } from "@/lib/calendar/reservation-service";
import type { AvailabilityResolution, DeferredSlotOffer, SlotOfferOptions } from "@/lib/calendar/reservation-service";
import { clientDataPatchSchema, humanNeededReasons, type AgentToolName, type AgentTurn, type AvailabilitySlot, type ClientData, type CurrentTurnDateCoordinate, type HumanNeededReason, type PricingRules, type Quote } from "@/lib/contracts/domain";
import type { LeadRepository, StoredAgentConfig, StoredAvailabilityAttempt, StoredCalendarSlotToken, StoredLead } from "@/lib/leads/repository";
import { calculatePricingDecision } from "@/lib/pricing/engine";
import { getEffectiveAgentConfig } from "@/lib/runtime-config/effective-agent-config";
import { TelegramDeliveryError, type TelegramGateway, type TelegramReplyMarkup } from "@/lib/telegram/gateway";
import {
  renderAgentReply,
  renderAvailabilityDateRequiredReply,
  renderAvailabilityRequestUnavailableReply,
  renderCalendarAvailabilityFailedReply,
  renderRetainedOfferRefreshFailedReply,
  renderCalendarReservationFailedReply,
  renderHumanNeededReply,
  renderHumanNeededAlreadyHandedOffReply,
  renderHumanNeededUpdateReply,
  renderReservedAcknowledgementReply,
  renderSchedulingConsentNeedsDateReply,
  renderNewAddressDivider,
  renderNoAvailabilityReply,
  renderRetainedOfferConstraintUnavailableReply,
  renderNearestSlotAlternativesReply,
  renderQuoteReply,
  renderReservationPendingReply,
  renderSlotOfferReply,
  renderStaleSlotReply,
  renderTechnicalResendReply,
  type TelegramRenderedReply,
} from "@/lib/telegram/renderer";
import { isReplyLanguageConfident, isRussianLanguage, isSerbianCyrillic, isSerbianLanguage, resolveReplyLanguage, type ReplyLanguage } from "@/lib/telegram/language";
import { isFocusedModelIntakeFollowup } from "@/lib/telegram/intake-focus";
import { TrelloSyncService } from "@/lib/trello/sync-service";
import { TrelloRecoveryService } from "@/lib/trello/recovery-service";

const telegramMessageSchema = z.object({
  message_id: z.number().int().nonnegative(),
  chat: z.object({ id: z.number().int() }),
  from: z.object({
    id: z.number().int().positive(),
    first_name: z.string().trim().min(1).max(64).optional(),
    last_name: z.string().trim().min(1).max(64).optional(),
    username: z.string().trim().regex(/^[A-Za-z0-9_]{5,32}$/).optional(),
  }).optional(),
  text: z.string().optional(),
}).passthrough();
const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: telegramMessageSchema.optional(),
  callback_query: z.object({
    id: z.string().min(1),
    data: z.string().min(1).max(64),
    message: telegramMessageSchema,
  }).passthrough().optional(),
}).passthrough();

const humanNeededSchema = z.object({ reason: z.enum(humanNeededReasons) });
const updateClientDataSchema = z.object({
  patch: z.object({
    cleaningType: z.unknown().optional(),
    areaM2: z.unknown().optional(),
    rooms: z.unknown().optional(),
    bathrooms: z.unknown().optional(),
    heavyPetHair: z.unknown().optional(),
    extras: z.unknown().optional(),
    addressOrDistrict: z.unknown().optional(),
    preferredDate: z.unknown().optional(),
    preferredTimeWindow: z.unknown().optional(),
    urgency: z.unknown().optional(),
  }).strict(),
}).strict();
const newAddressButtonText = "New address";
const newAddressKeyboard: TelegramReplyMarkup = {
  keyboard: [[{ text: newAddressButtonText }]],
  resize_keyboard: true,
  is_persistent: true,
};

const requestAvailableSlotsSchema = z.object({ intent: schedulingAvailabilityIntentSchema }).strict();
const schedulingDecisionSchema = z.object({
  reason: z.enum([
    "question_not_about_scheduling",
    "date_or_time_preference_missing",
    "awaiting_customer_choice",
    "already_reserved",
    "human_review_in_progress",
  ]),
}).strict();

/**
 * The model turn has produced a private offer, but the durable delivery
 * boundary could not be completed. It is a Calendar-operation handoff, not a
 * malformed Telegram update or an opaque processing error.
 */
class DeferredSlotOfferBoundaryError extends Error {
  constructor(
    readonly code: "calendar_slot_offer_persist_failed" | "agent_turn_operation_complete_failed" | "calendar_slot_offer_compensation_failed",
  ) {
    super(code);
  }
}

export type Stage2Dependencies = {
  repository: LeadRepository;
  agent: AgentGateway;
  telegram: TelegramGateway;
  calendarReservation?: CalendarReservationService;
  trelloSync?: TrelloSyncService;
  trelloRecovery?: TrelloRecoveryService;
  /** Injectable only for deterministic processing of one webhook turn. */
  now?: () => Date;
};

export type TelegramWebhookResult =
  | { kind: "processed" | "duplicate" | "ignored" }
  | { kind: "failed"; failureCode: string };

export async function processTelegramWebhook(
  payload: Record<string, unknown>,
  dependencies: Stage2Dependencies,
): Promise<TelegramWebhookResult> {
  const parsed = telegramUpdateSchema.safeParse(payload);
  if (!parsed.success) return { kind: "failed", failureCode: "invalid_update" };

  const update = parsed.data;
  // Do not let a webhook that crosses midnight observe more than one local
  // date. Every deterministic date/expiry decision below uses this snapshot.
  const turnNow = dependencies.now?.() ?? new Date();
  const claim = await dependencies.repository.claimTelegramUpdate({
    updateId: update.update_id,
    telegramChatId: update.message?.chat.id ?? update.callback_query?.message.chat.id,
    telegramMessageId: update.message?.message_id ?? update.callback_query?.message.message_id,
    payload,
  });
  if (claim === "duplicate") return { kind: "duplicate" };
  if (claim === "in_progress") return { kind: "failed", failureCode: "processing_in_progress" };

  try {
    const incomingMessage = update.message ?? update.callback_query?.message;
    if (!incomingMessage || (!update.callback_query && !incomingMessage.text?.trim())) {
      await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      return { kind: "ignored" };
    }

    // `New address` is an explicit backend-owned reset boundary. It must not
    // depend on reading or mapping the prior lead: a damaged historical row
    // must not prevent a customer from starting a fresh enquiry.
    let lead: StoredLead | null;
    if (update.message?.text?.trim() === newAddressButtonText) {
      const config = await dependencies.repository.getCurrentAgentConfig();
      lead = await dependencies.repository.startNewAddressLead({
        telegramChatId: incomingMessage.chat.id,
        firstMessageLanguage: "und",
        agentConfigVersion: config.version,
        ...telegramProfile(incomingMessage.from),
      });
      await dependencies.repository.appendActivity(lead.id, "new_address_started");
      const outcome = await deliverReply({
        updateId: update.update_id,
        lead,
        reply: renderNewAddressDivider("en"),
        dependencies,
      });
      if (outcome !== "succeeded") {
        await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed");
        return { kind: "failed", failureCode: "telegram_delivery_failed" };
      }
      await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      return { kind: "processed" };
    }

    lead = await dependencies.repository.findLeadByTelegramChatId(incomingMessage.chat.id);

    if (update.callback_query) {
      const callbackAcknowledged = await acknowledgeCallback(dependencies.telegram, update.callback_query.id);
      if (!callbackAcknowledged) await recordCallbackAcknowledgementFailure(lead, dependencies);
      const slotCallback = parseSlotCallbackData(update.callback_query.data);
      if (!lead || !slotCallback || !dependencies.calendarReservation) {
        await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
        return { kind: "ignored" };
      }
      const { slotToken, replyLanguage } = slotCallback;
      await sendTyping(dependencies.telegram, lead.telegramChatId);
      const callbackResult = await reserveSelectedSlot({
        updateId: update.update_id,
        lead,
        slotToken,
        dependencies,
        replyLanguage,
        now: turnNow,
      });
      if (callbackResult === "stale" || callbackResult === null) {
        await deliverStaleSlotReply({ lead, slotToken, replyLanguage, dependencies });
        await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
        return { kind: "processed" };
      }
      if (callbackResult.kind === "failed") {
        await dependencies.repository.markTelegramUpdateFailed(update.update_id, callbackResult.failureCode);
      } else {
        await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      }
      return callbackResult;
    }

    const messageText = incomingMessage.text?.trim() ?? "";
    const selectedSlot = parseSlotSelection(messageText);
    let replyLanguage = selectedSlot?.replyLanguage ?? resolveReplyLanguage(messageText);
    if (lead && selectedSlot && !selectedSlot.replyLanguage && isReplyLocale(lead.firstMessageLanguage)) {
      replyLanguage = lead.firstMessageLanguage;
    }
    if (lead && selectedSlot !== undefined && dependencies.calendarReservation) {
      if (lead.calendarEventId) {
        const delivered = await deliverReply({ updateId: update.update_id, lead, reply: renderReservedAcknowledgementReply(replyLanguage), dependencies });
        if (delivered !== "succeeded") { await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed"); return { kind: "failed", failureCode: "telegram_delivery_failed" }; }
        await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
        return { kind: "processed" };
      }
      const activeSlots = await dependencies.repository.listActiveCalendarSlotTokens({
        leadId: lead.id,
        now: turnNow.toISOString(),
      });
      const selectedSlotToken = lead.calendarEventId ? undefined : activeSlots[selectedSlot.index];
      if (selectedSlotToken || lead.calendarEventId) {
        await sendTyping(dependencies.telegram, lead.telegramChatId);
        const selectedSlotResult = selectedSlotToken
          ? await reserveSelectedSlot({
              updateId: update.update_id,
              lead,
              slotToken: selectedSlotToken.token,
              dependencies,
              replyLanguage,
              now: turnNow,
            })
          : await reserveSelectedSlot({
              updateId: update.update_id,
              lead,
              slotIndex: selectedSlot.index,
              dependencies,
              replyLanguage,
              now: turnNow,
            });
        if (selectedSlotResult === "stale" || selectedSlotResult === null) {
          await deliverStaleSlotReply({ lead, slotToken: selectedSlotToken?.token, replyLanguage, dependencies });
          await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
          return { kind: "processed" };
        }
        if (selectedSlotResult) {
          if (selectedSlotResult.kind === "failed") {
            await dependencies.repository.markTelegramUpdateFailed(update.update_id, selectedSlotResult.failureCode);
          } else {
            await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
          }
          return selectedSlotResult;
        }
      }
    }

    let config: StoredAgentConfig;
    if (!lead) {
      config = await dependencies.repository.getCurrentAgentConfig();
      lead = await dependencies.repository.createLead({
        telegramChatId: incomingMessage.chat.id,
        firstMessageLanguage: "und",
        agentConfigVersion: config.version,
        ...telegramProfile(incomingMessage.from),
      });
      await dependencies.repository.appendActivity(lead.id, "lead_created");
    } else {
      config = await dependencies.repository.getAgentConfig(lead.agentConfigVersion);
    }
    if (lead.firstMessageLanguage === "und" && isReplyLanguageConfident(messageText, replyLanguage)) {
      lead.firstMessageLanguage = replyLanguage;
      await dependencies.repository.saveLead(lead);
    }
    if ((!isReplyLanguageConfident(messageText, replyLanguage) || isAmbiguousMessage(messageText)) && isReplyLocale(lead.firstMessageLanguage)) {
      replyLanguage = lead.firstMessageLanguage;
    }
    if (lead.calendarEventId) {
      const delivered = await deliverReply({ updateId: update.update_id, lead, reply: renderReservedAcknowledgementReply(replyLanguage), dependencies });
      if (delivered !== "succeeded") { await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed"); return { kind: "failed", failureCode: "telegram_delivery_failed" }; }
      await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      return { kind: "processed" };
    }
    const now = turnNow;
    const hasPendingSchedulingConsent = hasActivePendingSchedulingConsent(lead);
    const bareSchedulingConsent = isBareSchedulingConsent(messageText);
    // A quote acceptance is valid for exactly the next customer turn. Any
    // other customer message consumes it before normal interpretation, so an
    // old affirmative cannot later become an implicit availability request.
    if (lead.pendingSchedulingConsentQuotedAt && (!hasPendingSchedulingConsent || !bareSchedulingConsent)) {
      clearPendingSchedulingConsent(lead);
      await dependencies.repository.saveLead(lead);
    }
    if (hasPendingSchedulingConsent && bareSchedulingConsent) {
      clearPendingSchedulingConsent(lead);
      await dependencies.repository.saveLead(lead);
      const reply = lead.clientData.preferredDate && dependencies.calendarReservation && isEligibleForSlotReservation(lead)
        ? await renderAvailabilityOffer({ lead, replyLanguage, dependencies, calendarReservation: dependencies.calendarReservation, pricingRules: config.pricingRules, now, options: { supersedeExisting: true } })
        : renderSchedulingConsentNeedsDateReply(replyLanguage);
      const delivered = await deliverReply({ updateId: update.update_id, lead, reply, dependencies });
      if (delivered !== "succeeded") {
        await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed");
        return { kind: "failed", failureCode: "telegram_delivery_failed" };
      }
      await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      return { kind: "processed" };
    }
    // Incidental time words in an unrelated question (for example, "what is
    // the weather today?") are not booking intent. Once the conversation has
    // established cleaning context, a short follow-up such as "tomorrow" is
    // still a valid date answer.
    const dateContext = hasCleaningOrSchedulingContext(messageText, lead);
    const hadActiveQualifiedQuoteBeforeDate = hasActiveQualifiedQuote(lead);
    const weekendDate = dateContext ? weekendProposalDate(messageText, now) : undefined;
    const resolvedDateCandidate = resolveRelativePreferredDate(messageText, now);
    const currentTurnDateCoordinate = (dateContext || hasStandaloneSchedulingDateIntent(messageText)) && !isIncidentalTimeQuestion(messageText)
      ? resolveCurrentTurnDateCoordinate(messageText, now)
      : undefined;
    const relativePreferredDate = (dateContext || hasStandaloneSchedulingDateIntent(messageText)) && !isIncidentalTimeQuestion(messageText)
      ? resolvedDateCandidate
      : undefined;
    // A named service district is a small, deterministic customer fact.  Once
    // a request has already been handed to a person, retain it before any
    // provider turn so the operator sees it even if that turn later fails.
    // This is deliberately limited to a known canonical district, not a
    // best-effort address parser.
    let backendHandoffLocationPersisted = false;
    const knownHandoffDistrict = resolveKnownHandoffDistrict(messageText);
    if (lead.humanNeeded && knownHandoffDistrict && lead.clientData.addressOrDistrict !== knownHandoffDistrict) {
      lead.clientData = { ...lead.clientData, addressOrDistrict: knownHandoffDistrict };
      backendHandoffLocationPersisted = true;
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "handoff_location_recorded", { district: knownHandoffDistrict });
    }
    const requestedTimeWindow = resolveTimeWindow(messageText);
    // Before a quote exists this is a harmless intake fact. Once there is an
    // active quote, scheduling language must be interpreted by the agent and
    // recorded through its typed semantic tool instead of this convenience
    // parser becoming a second routing authority.
    if (requestedTimeWindow && !hadActiveQualifiedQuoteBeforeDate && lead.clientData.preferredTimeWindow !== requestedTimeWindow) {
      lead.clientData = { ...lead.clientData, preferredTimeWindow: requestedTimeWindow };
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "time_window_requested", { window: requestedTimeWindow });
    }
    // The reply in this turn may be generated by the model, but this narrow
    // factual answer is not. Once the normal intake has reached its explicit
    // pet-hair question, a customer saying that a shedding pet is at home is
    // enough to record the surcharge input before the model can miss it.
    const backendPetHairAnswer = resolveActivePetHairAnswer(messageText, lead.clientData);
    if (backendPetHairAnswer !== undefined) {
      const nextClientData = mergeClientData(lead.clientData, { heavyPetHair: backendPetHairAnswer }, now);
      if (pricingInputsChanged(lead.clientData, nextClientData)) supersedeQuote(lead, now);
      lead.clientData = nextClientData;
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "pet_hair_recorded", { heavy_pet_hair: backendPetHairAnswer });
    }
    const hasActiveDateProposal = Boolean(lead.pendingPreferredDate && lead.dateProposalExpiresAt && new Date(lead.dateProposalExpiresAt).getTime() > now.getTime());
    if (hasActiveDateProposal && prefersSunday(messageText)) {
      // Sunday is not a working day. Keep a single persisted, confirmable
      // Saturday candidate rather than asking the customer to formulate it.
      const saturday = nearestSaturday(now);
      lead.pendingPreferredDate = saturday;
      lead.dateProposalExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      lead.dateProposalVersion = randomUUID().replaceAll("-", "");
      lead.dateProposalLocale = replyLanguage;
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "date_proposed", { candidate: saturday, version: lead.dateProposalVersion, sunday_unavailable: true });
      const delivered = await deliverReply({ updateId: update.update_id, lead, reply: renderWeekendProposal(replyLanguage, saturday, true), dependencies });
      if (delivered !== "succeeded") { await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed"); return { kind: "failed", failureCode: "telegram_delivery_failed" }; }
      await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      return { kind: "processed" };
    }
    if (lead.pendingPreferredDate && lead.dateProposalExpiresAt && new Date(lead.dateProposalExpiresAt).getTime() > now.getTime() && lead.dateProposalVersion && isProposalConfirmation(messageText)) {
      const nextClientData = mergeClientData(lead.clientData, { preferredDate: lead.pendingPreferredDate }, now);
      if (pricingInputsChanged(lead.clientData, nextClientData)) supersedeQuote(lead, now);
      lead.clientData = nextClientData;
      clearDateProposal(lead);
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "date_proposal_confirmed", { preferred_date: nextClientData.preferredDate });
      // The persisted date proposal is a typed, expiring and versioned
      // backend object. A bare "да" can only take this path, never infer an
      // availability promise from model prose or a Conversation id.
      const offerReply = dependencies.calendarReservation && isEligibleForSlotReservation(lead)
        ? await renderAvailabilityOffer({ lead, replyLanguage, dependencies, calendarReservation: dependencies.calendarReservation, pricingRules: config.pricingRules, now, options: { supersedeExisting: true } })
        : undefined;
      const delivered = await deliverReply({
        updateId: update.update_id,
        lead,
        reply: offerReply ?? renderWeekendConfirmation(replyLanguage, nextClientData.preferredDate!),
        dependencies,
      });
      if (delivered !== "succeeded") { await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed"); return { kind: "failed", failureCode: "telegram_delivery_failed" }; }
      await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      return { kind: "processed" };
    }
    // An already quoted customer may be asking to *check* a relative date.
    // Keep the deterministic parser as a date-format guard for intake, but
    // let the state-scoped agent choose the canonical availability intent so
    // it can immediately query real calendars rather than silently reciting
    // a re-priced quote.
    if (relativePreferredDate && !hadActiveQualifiedQuoteBeforeDate) {
      const nextClientData = mergeClientData(lead.clientData, { preferredDate: relativePreferredDate }, now);
      if (lead.clientData.preferredDate !== relativePreferredDate && pricingInputsChanged(lead.clientData, nextClientData)) supersedeQuote(lead, now);
      lead.clientData = nextClientData;
      clearDateProposal(lead);
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "relative_date_resolved", { preferred_date: relativePreferredDate });
    } else if (weekendDate) {
      // A weekend is an offer, not a silently confirmed date. It also replaces
      // any earlier requested date, because the latest customer intent wins.
      if (lead.clientData.preferredDate) {
        const nextClientData = { ...lead.clientData, preferredDate: undefined, urgency: undefined };
        if (pricingInputsChanged(lead.clientData, nextClientData)) supersedeQuote(lead, now);
        lead.clientData = nextClientData;
      }
      lead.pendingPreferredDate = weekendDate;
      lead.dateProposalExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      lead.dateProposalVersion = randomUUID().replaceAll("-", "");
      lead.dateProposalLocale = replyLanguage;
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "date_proposed", { candidate: weekendDate, version: lead.dateProposalVersion });
      const delivered = await deliverReply({ updateId: update.update_id, lead, reply: renderWeekendProposal(replyLanguage, weekendDate, prefersSunday(messageText)), dependencies });
      if (delivered !== "succeeded") { await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed"); return { kind: "failed", failureCode: "telegram_delivery_failed" }; }
      await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      return { kind: "processed" };
    }
    if (lead.pendingPreferredDate && (isProposalDecline(messageText) || (lead.dateProposalExpiresAt && new Date(lead.dateProposalExpiresAt).getTime() <= now.getTime()))) {
      clearDateProposal(lead);
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "date_proposal_cleared");
    }
    config = await getEffectiveAgentConfig(config);

    // Natural-language scheduling stays inside the one state-scoped agent.
    // Callback choices and the one-turn bare quote consent above are still
    // deterministic transport boundaries. All other availability requests,
    // changed dates and changed time preferences must become a typed semantic
    // tool decision below rather than matching an ever-growing phrase list.

    let conversation = await dependencies.repository.getConversation(lead.id);
    if (!conversation) {
      // Each invalidated provider Conversation gets one new, durable creation
      // operation. A terminal availability function call has no provider
      // closure message to make its function-output context safe to reuse, so
      // reusing the original succeeded idempotency key would put that protocol
      // state straight back into the next Runner turn.
      const recoveryOperation = await dependencies.repository.getIntegrationOperation(`openai:conversation_recovery:${lead.id}`);
      const initialConversationKey = `openai:conversation:${lead.id}:initial`;
      const initialConversationOperation = await dependencies.repository.getIntegrationOperation(initialConversationKey);
      const idempotencyKey = recoveryOperation?.status === "succeeded"
        ? `openai:conversation:${lead.id}:recovery:${update.update_id}`
        : initialConversationOperation?.status === "succeeded"
        ? `openai:conversation:${lead.id}:reset:${update.update_id}`
        : initialConversationKey;
      const operation = await dependencies.repository.createIntegrationOperation({
        leadId: lead.id,
        idempotencyKey,
        provider: "openai",
        operationType: "create_conversation",
      });
      let openAiConversationId: string;
      if (!operation.isNew) {
        if (operation.status !== "succeeded" || !operation.externalId) {
          lead.humanNeeded = true;
          lead.humanNeededReason = "conversation_ambiguous";
          clearPendingSchedulingConsent(lead);
          await dependencies.repository.saveLead(lead);
          throw new Error("OpenAI conversation creation requires manual recovery");
        }
        openAiConversationId = operation.externalId;
      } else {
        try {
          await sendTyping(dependencies.telegram, lead.telegramChatId);
          const created = await dependencies.agent.createConversation(lead.id);
          openAiConversationId = created.id;
          await dependencies.repository.completeIntegrationOperation(idempotencyKey, created.id);
        } catch (error) {
          // Evaluator limits are terminal control flow, not a disposable
          // provider Conversation. Preserve their exact typed fence for the
          // harness before any recovery/delivery side effect.
          if (isEvaluatorControlFence(error)) throw error;
          await dependencies.repository.failIntegrationOperation(idempotencyKey, "openai_conversation_create_failed", "ambiguous");
          if (isConversationTechnicalFailure(error)) {
            return recoverTechnicalConversationFailure({
              updateId: update.update_id,
              lead,
              replyLanguage,
              dependencies,
            });
          }
          throw error;
        }
      }
      conversation = {
        leadId: lead.id,
        telegramChatId: lead.telegramChatId,
        openAiConversationId,
      };
      await dependencies.repository.saveConversation(conversation);
    }

    // A quote calculated by this model turn is deliberately not sufficient to
    // open Calendar availability. The customer must see the quote first and
    // later make an explicit scheduling request. This protects the sequence
    // even if a model tries to call both tools in one turn.
    // QUOTED includes a date-less estimate. The agent must still make an
    // explicit semantic scheduling decision when the customer asks about
    // availability, because it can resolve a date such as “today” through
    // request_available_slots. Requiring a pre-existing date here recreated
    // the old dead-end where a compact time question never reached Calendar.
    const hadActiveQuoteBeforeTurn = hasActiveQualifiedQuote(lead);
    const wasHumanNeededBeforeTurn = lead.humanNeeded;
    const schedulingDecisionRequired = hadActiveQuoteBeforeTurn && !lead.calendarEventId;
    const allowedTools: AgentToolName[] = wasHumanNeededBeforeTurn
      ? hasHandoffFollowupFact(messageText, relativePreferredDate)
        ? ["update_client_data"]
        : []
      : schedulingDecisionRequired
      ? ["update_client_data", "mark_human_needed", "calculate_quote", "request_available_slots", "record_scheduling_decision"]
      : ["update_client_data", "mark_human_needed", "calculate_quote"];
    const schedulingSnapshot = await buildSchedulingSnapshot({
      lead,
      now,
      repository: dependencies.repository,
      currentTurnDateCoordinate,
    });
    // A provider error can occur after a semantic tool has returned. Restore
    // this exact snapshot before persisting recovery so partial quote/lifecycle
    // or Human Needed mutations never become a later customer fact.
    const persistedLeadBeforeTurn = structuredClone(lead);
    let quote: Quote | undefined;
    let humanNeededReason: HumanNeededReason | undefined;
    let updateClientDataCalls = 0;
    // In a quoted/offered turn a pricing-input patch immediately supersedes
    // the durable quote. Do not allow a later reset/deferred-offer boundary to
    // make that mutated state durable unless this same turn has produced a new
    // backend quote or a completed Human Needed result.
    let pricingInputChangedInSchedulingTurn = false;
    // Customer-facing Human Needed copy may claim a specific detail was saved
    // only after this turn has proved a persisted data change. A raw message
    // by itself is not such proof.
    let persistedHandoffFact = wasHumanNeededBeforeTurn && (backendHandoffLocationPersisted || (Boolean(relativePreferredDate) && lead.clientData.preferredDate === relativePreferredDate));
    let calendarFailure = false;
    // A Calendar-read transport fault can be reported honestly while a prior
    // customer-visible offer remains selectable.  It is deliberately not a
    // Human Needed lifecycle transition: that transition would invalidate the
    // retained callbacks we have just promised to keep.
    let calendarRetainedOfferFailure = false;
    let calendarRetainedOfferConstraintUnavailable = false;
    let calendarRetainedOfferConstraintKind: "after" | "before" | "range" | undefined;
    let noAvailableSlots = false;
    let noAvailableSlotsReason: "nonworking_day" | "requested_date_unavailable" | "requested_time_unavailable" | undefined;
    let offeredSlots: AvailabilitySlot[] | undefined;
    let deferredSlotOffer: DeferredSlotOffer | undefined;
    let deferredAvailabilityAttempt: {
      intent: SchedulingAvailabilityIntent;
      candidateDate: string;
      result: Extract<StoredAvailabilityAttempt["result"], "exact_offer" | "fallback_offer">;
    } | undefined;
    let offeredSlotsAreNearestAlternatives = false;
    let offeredSlotsAvailabilityReason: "requested_date_unavailable" | "requested_time_unavailable" | "nonworking_day" | undefined;
    /**
     * A terminal availability tool result cannot use SDK finalOutput: it is
     * serialized tool JSON. Keep only a safe backend-owned outcome for the
     * deterministic renderer below.
     */
    let availabilityTerminalFailure: "date_required" | "validation" | "business_refusal" | undefined;
    await sendTyping(dependencies.telegram, lead.telegramChatId);
    const agentTurnOperation = await dependencies.repository.createIntegrationOperation({
      leadId: lead.id,
      idempotencyKey: `openai:agent_turn:${lead.id}:${update.update_id}`,
      provider: "openai",
      operationType: "run_turn",
    });
    if (!agentTurnOperation.isNew && agentTurnOperation.status !== "succeeded") {
      // A failed or ambiguous technical turn is not a customer-supported
      // escalation reason. Do not reuse its server-managed Conversation and do
      // not manufacture a Human Needed label; recovery must start from a
      // separately diagnosed technical boundary.
      throw new Error("OpenAI agent turn is not reusable after technical failure");
    }
    let turn: AgentTurn;
    let quoteCalculatedThisTurn = false;
    try {
      turn = await dependencies.agent.runTurn({
      conversationId: conversation.openAiConversationId,
      systemPrompt: config.systemPrompt,
      replyLanguage,
      message: messageText,
      knownClientData: lead.clientData,
      pricingRules: config.pricingRules,
      allowedTools,
      schedulingDecisionRequired,
      schedulingSnapshot,
      executeTool: async (name, argumentsJson) => {
        if (quoteCalculatedThisTurn) {
          return { ok: false, error: "quote_is_terminal_for_customer_turn" };
        }
        if (!allowedTools.includes(name)) return { ok: false, error: "tool_not_available_for_customer_turn" };
        if (name === "update_client_data") {
          if (updateClientDataCalls >= 1) return { ok: false, error: "client_data_update_limit_reached" };
          updateClientDataCalls += 1;
          const updateData = updateClientDataSchema.safeParse(argumentsJson);
          if (!updateData.success) return { ok: false, error: "invalid_client_data_patch" };
          const patch = clientDataPatchSchema.safeParse(normalizeCustomerDatePatch(updateData.data.patch, now));
          if (!patch.success) return { ok: false, error: "invalid_client_data_patch" };
          // QUOTED/OFFERED date and time language is not ordinary client-data
          // intake.  It is a scheduling request whose only authority is the
          // typed availability tool, otherwise a model can silently re-quote
          // and never read the real calendars.  Keep unrelated price facts in
          // the same patch, but isolate these two fields from the mutation.
          const schedulingPatchRequested = schedulingDecisionRequired && (
            Object.hasOwn(patch.data, "preferredDate") || Object.hasOwn(patch.data, "preferredTimeWindow")
          );
          const patchWithoutSchedulingPreference = schedulingPatchRequested
            ? (() => {
                const isolated = { ...patch.data };
                delete isolated.preferredDate;
                delete isolated.preferredTimeWindow;
                return isolated;
              })()
            : patch.data;
          const previousClientData = lead.clientData;
          // A backend-confirmed answer from this exact customer message is
          // immutable for this turn. The model still receives the resulting
          // full data projection, but cannot overwrite the deterministic fact.
          const modelPatch = backendPetHairAnswer === undefined
            ? patchWithoutSchedulingPreference
            : (() => {
                const withoutPetHair = { ...patchWithoutSchedulingPreference };
                delete withoutPetHair.heavyPetHair;
                return withoutPetHair;
              })();
          const nextClientData = mergeClientData(lead.clientData, modelPatch, now);
          const pricingChanged = pricingInputsChanged(lead.clientData, nextClientData);
          if (pricingChanged) {
            supersedeQuote(lead, now);
            if (schedulingDecisionRequired) pricingInputChangedInSchedulingTurn = true;
          }
          lead.clientData = nextClientData;
          if (wasHumanNeededBeforeTurn && JSON.stringify(previousClientData) !== JSON.stringify(nextClientData)) {
            persistedHandoffFact = true;
          }
          return {
            ok: true,
            client_data: lead.clientData,
            ...(schedulingPatchRequested ? { scheduling_preference_requires_availability_tool: true } : {}),
          };
        }

        if (name === "mark_human_needed") {
          const result = humanNeededSchema.safeParse(argumentsJson);
          if (!result.success) return { ok: false, error: "invalid_human_needed_reason" };
          humanNeededReason = result.data.reason;
          return { ok: true, human_needed: true, reason: humanNeededReason };
        }

        if (name === "request_available_slots") {
          if (!dependencies.calendarReservation) {
            humanNeededReason = "calendar_unavailable";
            calendarFailure = true;
            await dependencies.repository.appendActivity(lead.id, "calendar_availability_failed", { error_code: "calendar_not_configured" });
            return { ok: false, error: "calendar_not_configured" };
          }
          if (!hadActiveQuoteBeforeTurn || lead.calendarEventId || lead.quoteValidity !== "active") {
            availabilityTerminalFailure = "business_refusal";
            return { ok: false, error: "availability_requires_prior_active_quote" };
          }
          const parsedIntent = requestAvailableSlotsSchema.safeParse(argumentsJson);
          if (!parsedIntent.success) {
            availabilityTerminalFailure = "validation";
            return { ok: false, error: "invalid_availability_intent" };
          }
          if (!availabilityIntentMatchesCurrentTurnCoordinate(parsedIntent.data.intent, schedulingSnapshot)) {
            const missingDate = parsedIntent.data.intent.dateReference === "current_preferred_date" &&
              !schedulingSnapshot.preferredDate && !schedulingSnapshot.currentTurnDateCoordinate;
            availabilityTerminalFailure = missingDate ? "date_required" : "validation";
            return { ok: false, error: missingDate ? "availability_date_required" : "availability_date_coordinate_mismatch" };
          }
          const resolved = await resolveSemanticAvailabilityIntent({
            intent: parsedIntent.data.intent,
            lead,
            now,
            repository: dependencies.repository,
          });
          if (!resolved.ok) {
            availabilityTerminalFailure = resolved.error === "availability_date_required" ? "date_required" : "validation";
            return { ok: false, error: resolved.error };
          }
          let availabilityQuote: Quote | undefined;
          const result = await dependencies.calendarReservation.offerSlots(resolved.candidateLead, replyLanguage, {
            ...resolved.offerOptions,
            // A live provider can fail after this semantic tool has returned
            // but before it produces final prose. Keep tokens private until
            // that final model boundary succeeds; direct backend paths still
            // commit immediately through renderAvailabilityOffer.
            deferTokenPersistence: true,
            onAvailabilityResolved: async (resolution) => {
              // No result means no authoritative scheduling mutation. On a
              // non-empty result this completes the candidate before the
              // reservation service derives the deferred-token fingerprint.
              if (resolution.slots.length === 0) return;
              availabilityQuote = await commitAvailabilityCandidateOffer({
                lead,
                candidateLead: resolved.candidateLead,
                persistedLeadBeforeTurn,
                resolution,
                now,
                pricingRules: config.pricingRules,
                repository: dependencies.repository,
              });
              if (availabilityQuote) quote = availabilityQuote;
            },
          });
          const retainsExistingOffer = resolved.offerOptions.existingOfferDisposition === "retain_until_replacement";
          if (!result.ok && (
            result.error === "calendar_availability_failed" ||
            result.error === "calendar_slot_offer_persist_failed"
          )) {
            if (result.error === "calendar_availability_failed" && retainsExistingOffer) {
              calendarRetainedOfferFailure = true;
              await dependencies.repository.appendActivity(lead.id, "calendar_availability_failed", {
                error_code: result.error,
                retained_offer: true,
              });
            } else {
              humanNeededReason = "calendar_unavailable";
              calendarFailure = true;
              await dependencies.repository.appendActivity(lead.id, "calendar_availability_failed", { error_code: result.error });
            }
          }
          if (!result.ok && result.error === "duration_exceeds_workday") {
            humanNeededReason = "duration_exceeds_workday";
            await dependencies.repository.appendActivity(lead.id, "duration_exceeds_workday");
          }
          if (!result.ok) {
            const attemptResult: StoredAvailabilityAttempt["result"] = result.error === "no_available_slots" ? "no_slots" : "failure";
            // An unavailable or technical result becomes durable evidence but
            // never commits the candidate scheduling coordinate. This write is
            // required: silently losing it would make the next stateless turn
            // reason from an invented offer history.
            await recordAvailabilityAttemptRequired({
              repository: dependencies.repository,
              leadId: lead.id,
              intent: parsedIntent.data.intent,
              candidateDate: resolved.candidateDate,
              result: attemptResult,
              now,
            });
            if (result.error === "no_available_slots") {
              noAvailableSlots = true;
              noAvailableSlotsReason = result.availabilityReason;
              calendarRetainedOfferConstraintUnavailable = retainsExistingOffer &&
                result.availabilityReason === "requested_time_unavailable";
              calendarRetainedOfferConstraintKind = calendarRetainedOfferConstraintUnavailable &&
                (parsedIntent.data.intent.timePreference === "after" ||
                  parsedIntent.data.intent.timePreference === "before" ||
                  parsedIntent.data.intent.timePreference === "range")
                ? parsedIntent.data.intent.timePreference
                : undefined;
              await dependencies.repository.appendActivity(lead.id, "calendar_no_availability", { error_code: result.error });
            } else if (!calendarFailure && !calendarRetainedOfferFailure && result.error !== "duration_exceeds_workday") {
              availabilityTerminalFailure = result.error === "preferred_date_required" ? "date_required" : "business_refusal";
            }
            // Keep a typed, bounded explanation available to the Agent audit
            // surface. It reports only the deterministic constraint that
            // failed and the two consented ways to broaden it; it never
            // converts an explicit after/before/range request into a hidden
            // backend fallback.
            if (result.error === "no_available_slots" && result.availabilityReason === "requested_time_unavailable") {
              const hardTimeConstraint = parsedIntent.data.intent.timePreference === "after"
                ? { kind: "after" as const, afterLocalTime: parsedIntent.data.intent.afterLocalTime }
                : parsedIntent.data.intent.timePreference === "before"
                ? { kind: "before" as const, beforeLocalTime: parsedIntent.data.intent.beforeLocalTime }
                : parsedIntent.data.intent.timePreference === "range"
                ? {
                    kind: "range" as const,
                    afterLocalTime: parsedIntent.data.intent.afterLocalTime,
                    beforeLocalTime: parsedIntent.data.intent.beforeLocalTime,
                  }
                : undefined;
              const allowedNextUserConsentPaths = hardTimeConstraint?.kind === "after"
                ? ["earlier_time", "different_date"] as const
                : hardTimeConstraint?.kind === "before"
                ? ["later_time", "different_date"] as const
                : hardTimeConstraint?.kind === "range"
                ? ["outside_requested_range", "different_date"] as const
                : ["different_time", "different_date"] as const;
              return {
                ok: false,
                error: result.error,
                availabilityReason: result.availabilityReason,
                existingOfferDisposition: resolved.offerOptions.existingOfferDisposition,
                ...(hardTimeConstraint ? { hardTimeConstraint } : {}),
                allowedNextUserConsentPaths,
              };
            }
            return { ok: false, error: result.error };
          }
          offeredSlots = result.slots;
          deferredSlotOffer = result.deferredOffer;
          offeredSlotsAreNearestAlternatives = result.match === "nearest_alternatives";
          offeredSlotsAvailabilityReason = result.availabilityReason === "exact" ? undefined : result.availabilityReason;
          // An exact/fallback attempt is true only after the private token
          // offer, operation acknowledgement and customer delivery boundary
          // have all succeeded.  Stage it here; the best-effort audit flush
          // below never survives a deferred-offer rollback as a false fact.
          deferredAvailabilityAttempt = {
            intent: parsedIntent.data.intent,
            candidateDate: resolved.candidateDate,
            result: result.match === "exact" ? "exact_offer" : "fallback_offer",
          };
          return {
            ok: true,
            options: result.slots.map((slot) => ({ option: slot.displayOrder, label: slot.label })),
          };
        }

        if (name === "record_scheduling_decision") {
          const decision = schedulingDecisionSchema.safeParse(argumentsJson);
          if (!decision.success) return { ok: false, error: "invalid_scheduling_decision" };
          if (!schedulingDecisionRequired) return { ok: false, error: "scheduling_decision_not_required" };
          await dependencies.repository.appendActivity(lead.id, "scheduling_no_calendar_decision", { reason: decision.data.reason });
          return { ok: true, decision: "no_calendar", reason: decision.data.reason };
        }

        if (hadActiveQuoteBeforeTurn && lead.quoteValidity === "active" && lead.quote) {
          return { ok: false, error: "active_quote_does_not_need_recalculation" };
        }
        const decision = calculatePricingDecision(lead.clientData, config.pricingRules);
        if (decision.kind === "quote") {
          quote = decision.quote;
          quoteCalculatedThisTurn = true;
          // A changed customer fact invalidated the previous quote. Rendering
          // the newly calculated quote is the authoritative no-Calendar
          // decision for this turn: a customer must see the revised amount
          // before a later availability search can be trusted.
          if (schedulingDecisionRequired) {
            await dependencies.repository.appendActivity(lead.id, "scheduling_quote_recalculated");
          }
          return { ok: true, kind: "quote", quote: { amountRsd: quote.amountRsd } };
        }
        if (decision.kind === "human_needed") {
          humanNeededReason = decision.reason;
          return { ok: true, kind: "human_needed", reason: decision.reason };
        }
        return { ok: true, kind: "missing_data", missing_fields: decision.missingFields };
      },
      });
      if (pricingInputChangedInSchedulingTurn && !quoteCalculatedThisTurn && !humanNeededReason) {
        throw new AgentTurnTechnicalError("agent_quote_recalculation_missing");
      }
      if (turn.conversationResetRequired) {
        // A stateless recovery or terminal availability function result cannot
        // be reused as durable customer context. Invalidate before any private
        // offer commit or turn acknowledgement so the next message starts from
        // the authoritative lead/offer snapshot instead of SDK tool output.
        try {
          await dependencies.repository.invalidateConversation(lead.id);
        } catch {
          // A repair result is not safe to continue with if its poisoned
          // Conversation cannot be invalidated. Supersede a private offer if
          // one exists, then let the existing technical recovery restore the
          // pre-turn lead projection and produce server-owned resend copy.
          if (deferredSlotOffer) {
            try {
              await dependencies.calendarReservation!.discardDeferredSlotOffer(deferredSlotOffer);
            } catch {
              throw new DeferredSlotOfferBoundaryError("calendar_slot_offer_compensation_failed");
            }
          }
          throw new AgentTurnTechnicalError("agent_provider_sdk_error");
        }
      }
      if (deferredSlotOffer) {
        try {
          await dependencies.calendarReservation!.commitDeferredSlotOffer(deferredSlotOffer);
        } catch {
          // `saveCalendarSlotOffer` is the atomically-authoritative token
          // lifecycle boundary. Compensate even when this write reports a
          // failure: a provider/database transport fault must not leave a
          // customer-invisible offer selectable on a later callback.
          try {
            await dependencies.calendarReservation!.discardDeferredSlotOffer(deferredSlotOffer);
          } catch {
            throw new DeferredSlotOfferBoundaryError("calendar_slot_offer_compensation_failed");
          }
          throw new DeferredSlotOfferBoundaryError("calendar_slot_offer_persist_failed");
        }
      }
      try {
        await dependencies.repository.completeIntegrationOperation(agentTurnOperation.idempotencyKey);
      } catch {
        // The token write may have succeeded while the agent-turn operation
        // acknowledgement failed. Supersede that new offer before rollback so
        // no OFFERED state exists without a successfully completed provider
        // turn and backend continuation boundary.
        if (deferredSlotOffer) {
          try {
            await dependencies.calendarReservation!.discardDeferredSlotOffer(deferredSlotOffer);
          } catch {
            throw new DeferredSlotOfferBoundaryError("calendar_slot_offer_compensation_failed");
          }
        }
        throw new DeferredSlotOfferBoundaryError("agent_turn_operation_complete_failed");
      }
    } catch (error) {
      if (isEvaluatorControlFence(error)) throw error;
      if (error instanceof DeferredSlotOfferBoundaryError) {
        // We have either confirmed the deferred write did not commit or
        // superseded it with an empty offer. Restore the pre-turn coordinate,
        // then use server-owned Calendar handoff copy rather than reporting an
        // opaque webhook failure. Existing tokens were superseded before the
        // new query and deliberately remain stale.
        await dependencies.repository.failIntegrationOperation(agentTurnOperation.idempotencyKey, error.code, "ambiguous");
        Object.assign(lead, persistedLeadBeforeTurn);
        await dependencies.repository.invalidateConversation(lead.id);
        return recoverDeferredSlotOfferBoundaryFailure({
          updateId: update.update_id,
          lead,
          replyLanguage,
          dependencies,
          now,
          errorCode: error.code,
        });
      }
      // If the provider failed after a terminal availability tool produced a
      // private deferred offer, its final customer-visible intent is unknown.
      // This is the deliberately conservative exception to retain-until-
      // replacement: invalidate every offer rather than leave an option whose
      // surrounding lead/quote rollback may no longer match.
      if (deferredSlotOffer) {
        try {
          await dependencies.calendarReservation!.discardDeferredSlotOffer(deferredSlotOffer);
        } catch {
          throw new DeferredSlotOfferBoundaryError("calendar_slot_offer_compensation_failed");
        }
      }
      await dependencies.repository.failIntegrationOperation(agentTurnOperation.idempotencyKey, "openai_agent_turn_failed", "ambiguous");
      Object.assign(lead, persistedLeadBeforeTurn);
      await dependencies.repository.saveLead(lead);
      if (isConversationTechnicalFailure(error)) {
        return recoverTechnicalConversationFailure({ updateId: update.update_id, lead, replyLanguage, dependencies });
      }
      throw error;
    }

    // A validated oversized area is a backend-owned boundary, independent of
    // whether the model chose to calculate a quote or ask for a handoff.
    // This runs only after a successful turn, so failed-turn rollback remains
    // authoritative.
    if (calendarFailure) {
      // `resolveSemanticAvailabilityIntent` temporarily applies the requested
      // date/window so the real Calendar query is meaningful. A transport or
      // persistence failure cannot leave that unverified coordinate beside an
      // earlier active quote, so retain the pre-turn scheduling/quote facts
      // and only add the separate technical Human Needed outcome below.
      restoreSchedulingSnapshot(lead, persistedLeadBeforeTurn);
    }
    const backendPricingDecision = calculatePricingDecision(lead.clientData, config.pricingRules);
    if (backendPricingDecision.kind === "human_needed") {
      humanNeededReason = backendPricingDecision.reason;
      quote = undefined;
    }

    const recoveryMarker = await dependencies.repository.getIntegrationOperation(`openai:conversation_recovery:${lead.id}`);
    if (recoveryMarker?.status === "succeeded") {
      // Existing durable operations provide the recovery fence without a new
      // schema field. A successful fresh turn resets the consecutive-failure
      // marker for a later independent incident.
      await dependencies.repository.failIntegrationOperation(recoveryMarker.idempotencyKey, "conversation_recovered", "failed");
    }

    if (humanNeededReason) {
      lead.humanNeeded = true;
      lead.humanNeededReason = humanNeededReason;
      clearPendingSchedulingConsent(lead);
      quote = undefined;
      // An exhausted scheduling horizon does not invalidate a previously
      // delivered price. The model may still explicitly flag it for a human.
      if (!calendarFailure && !noAvailableSlots) supersedeQuote(lead);
    } else if (quote) {
      activateQuote(lead, quote, config.pricingRules, now);
    }
    await dependencies.repository.saveLead(lead);

    // Pricing and side effects remain backend-owned, but ordinary intake must
    // stay conversational. Previously every incomplete turn was overwritten
    // with a full missing-field checklist, even when the agent had already
    // answered the customer's actual question. Use a deterministic prompt only
    // when model prose is absent, unsafe, or in the wrong locale.
    const conversationalReply = !wasHumanNeededBeforeTurn && !offeredSlots && !noAvailableSlots && !quote && !humanNeededReason
      ? normalIntakeReply(turn.reply, lead.clientData, config.pricingRules, replyLanguage)
      : undefined;
    const reply = offeredSlots
      ? offeredSlotsAreNearestAlternatives
        ? renderNearestSlotAlternativesReply(replyLanguage, offeredSlots, offeredSlotsAvailabilityReason ?? "requested_date_unavailable", lead.quote?.amountRsd)
        : renderSlotOfferReply(replyLanguage, offeredSlots, lead.quote?.amountRsd)
      : noAvailableSlots
      ? calendarRetainedOfferConstraintUnavailable
        ? renderRetainedOfferConstraintUnavailableReply(replyLanguage, calendarRetainedOfferConstraintKind ?? "after")
        : renderNoAvailabilityReply(replyLanguage, noAvailableSlotsReason)
      : calendarRetainedOfferFailure
      ? renderRetainedOfferRefreshFailedReply(replyLanguage)
      : availabilityTerminalFailure === "date_required"
      ? renderAvailabilityDateRequiredReply(replyLanguage)
      : availabilityTerminalFailure === "validation" || availabilityTerminalFailure === "business_refusal"
      ? renderAvailabilityRequestUnavailableReply(replyLanguage)
      : quote && !humanNeededReason
      ? renderQuoteReply(replyLanguage, quote.amountRsd, quoteReplyOptions(lead.clientData, config.pricingRules))
      : wasHumanNeededBeforeTurn
      ? isHumanHandoffQuestion(messageText)
        ? renderHumanNeededAlreadyHandedOffReply(replyLanguage)
        : renderHumanNeededUpdateReply(
          replyLanguage,
          humanNeededFollowupDetail(messageText, replyLanguage, relativePreferredDate),
          persistedHandoffFact,
        )
      : humanNeededReason
      ? calendarFailure
        ? renderCalendarAvailabilityFailedReply(replyLanguage)
        : renderHumanNeededReply(replyLanguage, humanNeededReason)
      : conversationalReply
      ?? renderAgentReply(turn.reply, replyLanguage);
    const deliveryOutcome = await deliverReply({
      updateId: update.update_id,
      lead,
      reply,
      dependencies,
    });
    if (deliveryOutcome !== "succeeded") {
      let confirmedOfferRollback = false;
      if (deferredSlotOffer && deliveryOutcome === "failed") {
        // A confirmed Telegram rejection means the customer did not receive
        // this private/new offer. Retire its tokens and restore the exact
        // pre-turn scheduling coordinate and aligned quote before recording
        // delivery Human Needed. This is intentionally distinct from an
        // ambiguous transport outcome below.
        try {
          await dependencies.calendarReservation!.discardDeferredSlotOffer(deferredSlotOffer);
          Object.assign(lead, persistedLeadBeforeTurn);
          confirmedOfferRollback = true;
        } catch {
          // If the token retirement itself is unknown, use the same
          // conservative ambiguous-delivery policy: retain state for audit,
          // block automatic reservation via Human Needed, and never claim a
          // rollback that was not confirmed.
        }
      }
      if (!lead.humanNeeded) {
        lead.humanNeeded = true;
        lead.humanNeededReason = deliveryOutcome === "ambiguous" || (deferredSlotOffer !== undefined && !confirmedOfferRollback)
          ? "delivery_ambiguous"
          : "delivery_failed";
        clearPendingSchedulingConsent(lead);
      }
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "telegram_delivery_failed", {
        outcome: deliveryOutcome,
        ...(deferredSlotOffer ? {
          // Ambiguous sends deliberately preserve the committed offer but
          // Human Needed prevents any callback from booking it automatically.
          availability_offer_policy: confirmedOfferRollback ? "rolled_back_after_confirmed_failure" : "preserved_and_blocked_after_ambiguous_delivery",
        } : {}),
      });
      await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed");
      return { kind: "failed", failureCode: "telegram_delivery_failed" };
    }

    // Success observability is intentionally outside the agent/deferred-token
    // transaction.  If any earlier boundary failed the catch path rolled the
    // lead back and this diagnostic is never written.
    if (deferredAvailabilityAttempt) {
      await recordAvailabilityAttemptBestEffort({
        repository: dependencies.repository,
        leadId: lead.id,
        intent: deferredAvailabilityAttempt.intent,
        candidateDate: deferredAvailabilityAttempt.candidateDate,
        result: deferredAvailabilityAttempt.result,
        now,
      });
    }

    if (quote && !humanNeededReason) {
      lead.status = "qualified";
      // This marker exists only after the customer has actually received the
      // typed quote. It also binds a bare next-turn confirmation to this exact
      // active quote instead of to model prose or a Conversation id.
      lead.pendingSchedulingConsentQuotedAt = lead.quoteValidity === "active" && lead.quotedAt
        ? lead.quotedAt
        : undefined;
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "quote_delivered", { amount_rsd: quote.amountRsd });
    }
    // The customer-facing reply is complete before a non-booked operational
    // projection is queued. Re-queueing also captures later Human Needed
    // changes without turning ordinary text into a Trello dependency.
    if (lead.status === "qualified") {
      await enqueueQualifiedTrelloProjection(lead, replyLanguage, now, dependencies);
    } else if (lead.status === "new_lead" && lead.humanNeeded) {
      // A first-turn escalation still needs an operational home. It cannot
      // enter the qualified outbox because that worker lifecycle would move
      // the card into the wrong Trello list. Keep this best-effort so a
      // Trello outage cannot rewrite a successfully delivered customer turn.
      await syncNewLeadHumanNeededProjection(lead, dependencies);
    }
    await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
    return { kind: "processed" };
  } catch (error) {
    // The local paid-evaluation harness has a typed resource fence. Do not
    // relabel a refused request as a Telegram processing error: the evaluator
    // must retain its checkpoint and mark the suite `incomplete`.
    if (isEvaluatorControlFence(error)) throw error;
    // The response must remain safe for Telegram, but production diagnostics
    // need a non-sensitive reason to distinguish a provider/configuration
    // failure from a delivery retry. Never log message text, customer data,
    // headers or credentials here.
    console.error("Telegram webhook processing failed", {
      updateId: update.update_id,
      updateKind: update.callback_query ? "callback" : "message",
      error: error instanceof Error ? error.message : "unknown_error",
    });
    await dependencies.repository.markTelegramUpdateFailed(update.update_id, "processing_error");
    return { kind: "failed", failureCode: "processing_error" };
  } finally {
    const incomingMessage = update.message ?? update.callback_query?.message;
    if (incomingMessage) {
      try {
        await dependencies.repository.releaseTelegramChatLease(incomingMessage.chat.id, update.update_id);
      } catch {
        // The database lease expires; a release failure must not rewrite a processed update as failed.
      }
    }
  }
}

/** Shared direct-offer boundary for strict requests and typed pending `да`. */
async function renderAvailabilityOffer(input: {
  lead: StoredLead;
  replyLanguage: ReplyLanguage;
  dependencies: Stage2Dependencies;
  calendarReservation: CalendarReservationService;
  pricingRules: PricingRules;
  now: Date;
  options?: SlotOfferOptions;
  onAvailabilityResolved?: (resolution: AvailabilityResolution) => Promise<Quote | undefined>;
}): Promise<TelegramRenderedReply> {
  let availabilityQuote: Quote | undefined;
  const existingOnAvailabilityResolved = input.options?.onAvailabilityResolved;
  const offer = await input.calendarReservation.offerSlots(input.lead, input.replyLanguage, {
    ...input.options,
    // Every customer-visible direct offer must be homogeneous by day. This
    // shared boundary also covers bare quote consent and date-proposal `да`.
    singleOfferDate: true,
    onAvailabilityResolved: async (resolution) => {
      await existingOnAvailabilityResolved?.(resolution);
      availabilityQuote = await alignAvailabilityQuote({
        lead: input.lead,
        resolution,
        now: input.now,
        pricingRules: input.pricingRules,
        repository: input.dependencies.repository,
      });
      const externalQuote = await input.onAvailabilityResolved?.(resolution);
      if (externalQuote) availabilityQuote = externalQuote;
    },
  });
  if (offer.ok) return offer.match === "nearest_alternatives"
    ? renderNearestSlotAlternativesReply(input.replyLanguage, offer.slots, offer.availabilityReason === "exact" ? "requested_date_unavailable" : offer.availabilityReason, availabilityQuote?.amountRsd)
    : renderSlotOfferReply(input.replyLanguage, offer.slots, availabilityQuote?.amountRsd);
  if (offer.error === "no_available_slots") {
    await input.dependencies.repository.appendActivity(input.lead.id, "calendar_no_availability", { error_code: offer.error });
    return renderNoAvailabilityReply(input.replyLanguage, offer.availabilityReason);
  }
  if (offer.error === "duration_exceeds_workday") {
    input.lead.humanNeeded = true;
    input.lead.humanNeededReason = "duration_exceeds_workday";
    clearPendingSchedulingConsent(input.lead);
    await input.dependencies.repository.saveLead(input.lead);
    await input.dependencies.repository.appendActivity(input.lead.id, "duration_exceeds_workday");
    return renderHumanNeededReply(input.replyLanguage, "duration_exceeds_workday");
  }
  input.lead.humanNeeded = true;
  input.lead.humanNeededReason = "calendar_unavailable";
  clearPendingSchedulingConsent(input.lead);
  await input.dependencies.repository.saveLead(input.lead);
  await input.dependencies.repository.appendActivity(input.lead.id, "calendar_availability_failed", { error_code: offer.error });
  return renderCalendarAvailabilityFailedReply(input.replyLanguage);
}

/**
 * A Calendar search is authoritative about the date a customer can actually
 * select. Align the durable preferred date and quote after every successful
 * availability read, even when the semantic intent did not itself change an
 * input. This prevents a late same-day request from retaining a +20% quote
 * beside only future alternatives (and vice versa). The callback is awaited
 * before slot tokens are persisted.
 */
async function alignAvailabilityQuote(input: {
  lead: StoredLead;
  resolution: AvailabilityResolution;
  now: Date;
  pricingRules: PricingRules;
  repository: LeadRepository;
  /** Candidate commits compare to the durable coordinate they are replacing. */
  previousAuthoritativeDate?: string;
}): Promise<Quote | undefined> {
  if (input.resolution.slots.length === 0) return undefined;
  const firstOfferedDate = [...input.resolution.slots]
    .sort((left, right) => left.start.localeCompare(right.start))[0];
  if (!firstOfferedDate) return undefined;
  const offeredDate = belgradeDate(new Date(firstOfferedDate.start));
  const previousDate = input.previousAuthoritativeDate ?? input.lead.clientData.preferredDate;
  input.lead.clientData = mergeClientData(input.lead.clientData, { preferredDate: offeredDate }, input.now);
  const decision = calculatePricingDecision(input.lead.clientData, input.pricingRules);
  if (decision.kind !== "quote") return undefined;
  const quoteChanged = input.lead.quote?.amountRsd !== decision.quote.amountRsd ||
    input.lead.quote?.sameDayApplied !== decision.quote.sameDayApplied ||
    previousDate !== offeredDate;
  if (!quoteChanged && input.lead.quote) return input.lead.quote;
  activateQuote(input.lead, decision.quote, input.pricingRules, input.now);
  await input.repository.saveLead(input.lead);
  await input.repository.appendActivity(input.lead.id, "quote_recalculated", {
    amount_rsd: decision.quote.amountRsd,
    reason: decision.quote.sameDayApplied ? "same_day_availability" : "future_availability",
  });
  return decision.quote;
}

/**
 * Makes a previously private scheduling candidate authoritative only after
 * both Team calendars produced real selectable slots. For a nearest fallback
 * the actual offered date is saved, while an unmatched requested time window
 * stays non-authoritative: it must not turn a labelled alternative into a
 * customer preference on a later turn.
 */
async function commitAvailabilityCandidateOffer(input: {
  lead: StoredLead;
  candidateLead: StoredLead;
  persistedLeadBeforeTurn: StoredLead;
  resolution: AvailabilityResolution;
  now: Date;
  pricingRules: PricingRules;
  repository: LeadRepository;
}): Promise<Quote | undefined> {
  const firstSlot = [...input.resolution.slots].sort((left, right) => left.start.localeCompare(right.start))[0];
  if (!firstSlot) return undefined;
  const offeredDate = belgradeDate(new Date(firstSlot.start));
  if (input.resolution.match === "nearest_alternatives") {
    const retainedWindow = input.persistedLeadBeforeTurn.clientData.preferredTimeWindow;
    input.candidateLead.clientData = mergeClientData(
      { ...input.candidateLead.clientData, preferredTimeWindow: retainedWindow },
      { preferredDate: offeredDate },
      input.now,
    );
  }
  // Keep the candidate object and the reservation-service input aligned. The
  // service derives its slot fingerprint only after this callback returns.
  Object.assign(input.lead, structuredClone(input.candidateLead));
  const quote = await alignAvailabilityQuote({
    lead: input.lead,
    resolution: input.resolution,
    now: input.now,
    pricingRules: input.pricingRules,
    repository: input.repository,
    previousAuthoritativeDate: input.persistedLeadBeforeTurn.clientData.preferredDate,
  });
  input.candidateLead.clientData = structuredClone(input.lead.clientData);
  input.candidateLead.quote = input.lead.quote ? structuredClone(input.lead.quote) : undefined;
  input.candidateLead.quoteValidity = input.lead.quoteValidity;
  input.candidateLead.quoteInvalidatedAt = input.lead.quoteInvalidatedAt;
  input.candidateLead.quotedAt = input.lead.quotedAt;
  input.candidateLead.pricingRulesSnapshot = input.lead.pricingRulesSnapshot;
  return quote;
}

function availabilityAttemptFromIntent(input: {
  intent: SchedulingAvailabilityIntent;
  candidateDate: string;
  result: StoredAvailabilityAttempt["result"];
  now: Date;
}): StoredAvailabilityAttempt {
  return {
    result: input.result,
    candidateDate: input.candidateDate,
    timePreference: input.intent.timePreference,
    timePreferenceMode: input.intent.timePreferenceMode,
    ...(input.intent.afterLocalTime ? { afterLocalTime: input.intent.afterLocalTime } : {}),
    ...(input.intent.beforeLocalTime ? { beforeLocalTime: input.intent.beforeLocalTime } : {}),
    relation: input.intent.relation,
    checkedAt: input.now.toISOString(),
  };
}

async function recordAvailabilityAttemptRequired(input: {
  repository: LeadRepository;
  leadId: string;
  intent: SchedulingAvailabilityIntent;
  candidateDate: string;
  result: StoredAvailabilityAttempt["result"];
  now: Date;
}): Promise<void> {
  try {
    await input.repository.recordAvailabilityAttempt(input.leadId, availabilityAttemptFromIntent(input));
  } catch {
    throw new AgentTurnTechnicalError("agent_tool_execution_failed");
  }
}

async function recordAvailabilityAttemptBestEffort(input: {
  repository: LeadRepository;
  leadId: string;
  intent: SchedulingAvailabilityIntent;
  candidateDate: string;
  result: Extract<StoredAvailabilityAttempt["result"], "exact_offer" | "fallback_offer">;
  now: Date;
}): Promise<void> {
  try {
    await input.repository.recordAvailabilityAttempt(input.leadId, availabilityAttemptFromIntent(input));
  } catch {
    // A valid offer is already protected by its authoritative lead save and
    // deferred-token boundary. Activity evidence is intentionally best-effort.
  }
}

function telegramProfile(from: { id: number; first_name?: string; last_name?: string; username?: string } | undefined) {
  if (!from) return {};
  const customerDisplayName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim().slice(0, 120);
  return {
    telegramUserId: from.id,
    customerDisplayName: customerDisplayName || undefined,
    telegramUsername: from.username,
  };
}

/** Strict, locale-neutral relative-date parser. Calendar arithmetic is in Belgrade time. */
export function resolveRelativePreferredDate(message: string, now: Date): string | undefined {
  const normalized = message.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  if (/\b(?:не|not|nije|није)\s+(?:сегодня|today|danas|данас|завтра|tomorrow|sutra|сутра)/u.test(normalized)) return undefined;
  const explicit = normalized.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})\b/u);
  if (explicit) {
    const [, dayText, monthText, yearText] = explicit;
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    const value = `${year.toString().padStart(4, "0")}-${monthText.padStart(2, "0")}-${dayText.padStart(2, "0")}`;
    if (isValidIsoDate(value) && value >= belgradeDate(now)) return value;
    return undefined;
  }
  const namedDate = resolveNamedDate(normalized, now);
  if (namedDate) return namedDate;
  const weekdayDate = resolveWeekdayDate(normalized, now);
  if (weekdayDate) return weekdayDate;
  const aliases: Array<[RegExp, number]> = [
    [/(?:^|\s)сегодня(?:$|\s|[,.!?])/u, 0], [/(?:^|\s)завтра(?:$|\s|[,.!?])/u, 1], [/(?:^|\s)послезавтра(?:$|\s|[,.!?])/u, 2],
    [/(?:^|\s)today(?:$|\s|[,.!?])/u, 0], [/(?:^|\s)tomorrow(?:$|\s|[,.!?])/u, 1], [/(?:^|\s)the day after tomorrow(?:$|\s|[,.!?])/u, 2],
    [/(?:^|\s)danas(?:$|\s|[,.!?])/u, 0], [/(?:^|\s)sutra(?:$|\s|[,.!?])/u, 1], [/(?:^|\s)prekosutra(?:$|\s|[,.!?])/u, 2],
    [/(?:^|\s)данас(?:$|\s|[,.!?])/u, 0], [/(?:^|\s)сутра(?:$|\s|[,.!?])/u, 1], [/(?:^|\s)прекосутра(?:$|\s|[,.!?])/u, 2],
  ];
  const alias = aliases.find(([expression]) => expression.test(normalized));
  const match = normalized.match(/(?:через\s+(\d+|один|одну|два|две|три)\s+(?:день|дня|дней)|in\s+(\d+|one|two|three)\s+days?|za\s+(\d+|jedan|dva|tri)\s+dana|за\s+(\d+|један|два|три)\s+дана)/u);
  const raw = match?.slice(1).find(Boolean);
  const days = alias?.[1] ?? (raw ? relativeDayCount(raw) : undefined);
  if (days === undefined) return undefined;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const base = new Date(Date.UTC(part("year"), part("month") - 1, part("day") + days));
  return base.toISOString().slice(0, 10);
}

/**
 * Resolve only an explicit date stated in this message into a transient
 * availability coordinate. Unlike intake date parsing it intentionally does
 * not include weekdays or inferred proposals, and callers must not persist it.
 */
export function resolveCurrentTurnDateCoordinate(message: string, now: Date): CurrentTurnDateCoordinate | undefined {
  const normalized = message.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const coordinate = (date: string, recommendedDateReference: CurrentTurnDateCoordinate["recommendedDateReference"], source: CurrentTurnDateCoordinate["source"]): CurrentTurnDateCoordinate => ({ date, recommendedDateReference, source, timezone: "Europe/Belgrade" });
  // A phrase such as "not tomorrow, but in two days" is not a single
  // coordinate. The agent must clarify rather than silently selecting one of
  // the competing dates. This deliberately covers RU, EN and both Serbian
  // scripts before candidate collection.
  const dateScopedNegation = /(?:^|[^\p{L}])(?:не|not|nije|није)\s+(?:(?:на|for|za)\s+)?(?:сегодня|today|danas|данас|завтра|tomorrow|sutra|сутра|послезавтра|the\s+day\s+after\s+tomorrow|prekosutra|прекосутра|через\s+[^\s]+\s+дн\p{L}*|in\s+[^\s]+\s+days?|za\s+[^\s]+\s+dana|за\s+[^\s]+\s+дана|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{2,4}|\d{1,2}\.?\s+\p{L}+|\p{L}+\s+\d{1,2})(?=$|[^\p{L}\d])/u;
  if (dateScopedNegation.test(normalized)) return undefined;

  const candidates: CurrentTurnDateCoordinate[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const add = (candidate: CurrentTurnDateCoordinate, start?: number, end?: number) => {
    if (start !== undefined && end !== undefined) {
      if (spans.some((span) => start < span.end && end > span.start)) return;
      spans.push({ start, end });
    }
    candidates.push(candidate);
  };
  // ISO is deliberately stricter than localized intake parsing. A stated ISO
  // date is either one valid current/future coordinate or no coordinate at
  // all; never reinterpret a malformed/past/multiple ISO message through a
  // looser date parser.
  const isoMatches = [...normalized.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)];
  if (isoMatches.length > 1) return undefined;
  if (isoMatches.length === 1) {
    const match = isoMatches[0]!;
    const date = match[0];
    if (!isValidIsoDate(date) || date < belgradeDate(now)) return undefined;
    add(coordinate(date, "exact_date", "absolute"), match.index, (match.index ?? 0) + date.length);
  }
  const aliases: Array<[RegExp, number, CurrentTurnDateCoordinate["source"]]> = [
    [/(?:^|[^\p{L}])the day after tomorrow(?=$|[^\p{L}])/gu, 2, "relative_day_after"], [/(?:^|[^\p{L}])послезавтра(?=$|[^\p{L}])/gu, 2, "relative_day_after"], [/(?:^|[^\p{L}])prekosutra(?=$|[^\p{L}])/gu, 2, "relative_day_after"], [/(?:^|[^\p{L}])прекосутра(?=$|[^\p{L}])/gu, 2, "relative_day_after"],
    [/(?:^|[^\p{L}])сегодня(?=$|[^\p{L}])/gu, 0, "relative_today"], [/(?:^|[^\p{L}])today(?=$|[^\p{L}])/gu, 0, "relative_today"], [/(?:^|[^\p{L}])danas(?=$|[^\p{L}])/gu, 0, "relative_today"], [/(?:^|[^\p{L}])данас(?=$|[^\p{L}])/gu, 0, "relative_today"],
    [/(?:^|[^\p{L}])завтра(?=$|[^\p{L}])/gu, 1, "relative_tomorrow"], [/(?:^|[^\p{L}])tomorrow(?=$|[^\p{L}])/gu, 1, "relative_tomorrow"], [/(?:^|[^\p{L}])sutra(?=$|[^\p{L}])/gu, 1, "relative_tomorrow"], [/(?:^|[^\p{L}])сутра(?=$|[^\p{L}])/gu, 1, "relative_tomorrow"],
  ];
  for (const [pattern, days, source] of aliases) {
    for (const match of normalized.matchAll(pattern)) {
      const start = match.index ?? 0;
      add(coordinate(addBelgradeDays(belgradeDate(now), days), days === 0 ? "today" : days === 1 ? "tomorrow" : "exact_date", source), start, start + match[0].length);
    }
  }
  const relative = /(?:через\s+(\d+|один|одну|два|две|три)\s+(?:день|дня|дней)|in\s+(\d+|one|two|three)\s+days?|za\s+(\d+|jedan|dva|tri)\s+dana|за\s+(\d+|један|два|три)\s+дана)/gu;
  for (const match of normalized.matchAll(relative)) {
    const days = relativeDayCount(match.slice(1).find(Boolean) ?? "");
    if (days !== undefined) add(coordinate(addBelgradeDays(belgradeDate(now), days), days === 0 ? "today" : days === 1 ? "tomorrow" : "exact_date", "relative_in_days"), match.index, (match.index ?? 0) + match[0].length);
  }
  for (const match of normalized.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})\b/gu)) {
    const [, day, month, yearText] = match;
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    const date = `${year.toString().padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    if (isValidIsoDate(date) && date >= belgradeDate(now)) add(coordinate(date, "exact_date", "absolute"), match.index, (match.index ?? 0) + match[0].length);
  }
  // resolveNamedDate retains its established locale/year behavior. Multiple
  // named date phrases are ambiguity, even if one parser branch would happen
  // to return the first one.
  const namedMentions = normalized.match(/(?:\d{1,2}\.?\s+[\p{L}]+|[\p{L}]+\s+\d{1,2})/gu) ?? [];
  if (namedMentions.filter((mention) => /\d/u.test(mention)).length > 1) return undefined;
  const named = resolveNamedDate(normalized, now);
  if (named) add(coordinate(named, "exact_date", "absolute"));

  const distinctDates = [...new Map(candidates.map((candidate) => [candidate.date, candidate])).values()];
  return distinctDates.length === 1 ? distinctDates[0] : undefined;
}

/** Resolve a named weekday to its next occurrence in Belgrade. */
function resolveWeekdayDate(normalized: string, now: Date): string | undefined {
  const weekdays: Array<[RegExp, number]> = [
    [/(?:^|\s)thursday(?:$|\s|[,.!])/u, 4], [/(?:^|\s)четверг(?:$|\s|[,.!])/u, 4], [/(?:^|\s)četvrtak(?:$|\s|[,.!])/u, 4], [/(?:^|\s)четвртак(?:$|\s|[,.!])/u, 4],
    [/(?:^|\s)monday(?:$|\s|[,.!])/u, 1], [/(?:^|\s)понедельник(?:$|\s|[,.!])/u, 1], [/(?:^|\s)ponedeljak(?:$|\s|[,.!])/u, 1],
    [/(?:^|\s)tuesday(?:$|\s|[,.!])/u, 2], [/(?:^|\s)вторник(?:$|\s|[,.!])/u, 2], [/(?:^|\s)utorak(?:$|\s|[,.!])/u, 2],
    [/(?:^|\s)wednesday(?:$|\s|[,.!])/u, 3], [/(?:^|\s)среда(?:$|\s|[,.!])/u, 3], [/(?:^|\s)sreda(?:$|\s|[,.!])/u, 3],
    [/(?:^|\s)friday(?:$|\s|[,.!])/u, 5], [/(?:^|\s)пятница(?:$|\s|[,.!])/u, 5], [/(?:^|\s)petak(?:$|\s|[,.!])/u, 5],
    [/(?:^|\s)saturday(?:$|\s|[,.!])/u, 6], [/(?:^|\s)суббота(?:$|\s|[,.!])/u, 6], [/(?:^|\s)subota(?:$|\s|[,.!])/u, 6],
  ];
  const target = weekdays.find(([pattern]) => pattern.test(normalized))?.[1];
  if (target === undefined) return undefined;
  const today = belgradeDate(now);
  const date = new Date(`${today}T00:00:00.000Z`);
  const delta = (target - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/**
 * Resolves a customer-facing Russian or Serbian date such as "26 августа"
 * or "26. avgusta" without
 * making a customer type an artificial year. An omitted year means the next
 * occurrence of that calendar date in Belgrade; an explicit past year is not
 * silently rewritten.
 */
function resolveNamedDate(normalized: string, now: Date): string | undefined {
  const months: Record<string, number> = {
    января: 1, январь: 1, янв: 1,
    февраля: 2, февраль: 2, фев: 2,
    марта: 3, март: 3, мар: 3,
    апреля: 4, апрель: 4, апр: 4,
    мая: 5, май: 5,
    июня: 6, июнь: 6, июн: 6,
    июля: 7, июль: 7, июл: 7,
    августа: 8, август: 8, авг: 8,
    сентября: 9, сентябрь: 9, сент: 9, сен: 9,
    октября: 10, октябрь: 10, окт: 10,
    ноября: 11, ноябрь: 11, ноя: 11,
    декабря: 12, декабрь: 12, дек: 12,
    januar: 1, januara: 1, јануар: 1, јануара: 1,
    februar: 2, februara: 2, фебруар: 2, фебруара: 2,
    mart: 3, marta: 3,
    april: 4, aprila: 4, април: 4, априла: 4,
    maj: 5, maja: 5, мај: 5, маја: 5,
    jun: 6, juna: 6, јун: 6, јуна: 6,
    jul: 7, jula: 7, јул: 7, јула: 7,
    avgust: 8, avgusta: 8,
    septembar: 9, septembra: 9, септембар: 9, септембра: 9,
    oktobar: 10, oktobra: 10, октобар: 10, октобра: 10,
    novembar: 11, novembra: 11, новембар: 11, новембра: 11,
    decembar: 12, decembra: 12, децембар: 12, децембра: 12,
    january: 1, february: 2, march: 3, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const monthTokens = Object.keys(months).join("|");
  const dayMonth = normalized.match(new RegExp(`(?:^|[^\\p{L}\\d])(\\d{1,2})\\.?\\s+(${monthTokens})(?:[,.]?\\s+(\\d{4})(?:\\s*г(?:ода)?\\.?)?)?(?=$|[^\\p{L}\\d])`, "u"));
  const monthDay = normalized.match(new RegExp(`(?:^|[^\\p{L}\\d])(${monthTokens})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?(?=$|[^\\p{L}\\d])`, "u"));
  if (!dayMonth && !monthDay) return undefined;

  const dayText = dayMonth?.[1] ?? monthDay?.[2];
  const monthText = dayMonth?.[2] ?? monthDay?.[1];
  const explicitYear = dayMonth?.[3] ?? monthDay?.[3];
  if (!dayText || !monthText) return undefined;
  const month = months[monthText];
  if (!month) return undefined;
  const today = belgradeDate(now);
  const currentYear = Number(today.slice(0, 4));
  let year = explicitYear ? Number(explicitYear) : currentYear;
  let value = toIsoDate(year, month, Number(dayText));
  if (!value) return undefined;
  if (!explicitYear && value < today) {
    year += 1;
    value = toIsoDate(year, month, Number(dayText));
  }
  return value && value >= today ? value : undefined;
}

function toIsoDate(year: number, month: number, day: number): string | undefined {
  const value = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  return isValidIsoDate(value) ? value : undefined;
}

function relativeDayCount(value: string): number | undefined {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 365) return parsed;
  return ({ один: 1, одну: 1, два: 2, две: 2, три: 3, one: 1, two: 2, three: 3, jedan: 1, dva: 2, tri: 3, један: 1 } as Record<string, number>)[value];
}

function isReplyLocale(value: string): value is ReplyLanguage {
  return value === "en" || value === "ru" || value === "sr-Latn" || value === "sr-Cyrl";
}

function isAmbiguousMessage(value: string): boolean {
  const normalized = value.normalize("NFKC").toLocaleLowerCase().trim();
  return !/[\p{L}]/u.test(value) || /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/u.test(normalized)
    || /^(?:да|ага|ок|okay|ok|хорошо|yes|yeah|yep|da|može|moze|може)$/u.test(normalized);
}

function weekendProposalDate(message: string, now: Date): string | undefined {
  const normalized = message.normalize("NFKC").toLocaleLowerCase();
  if (!/(?:на\s+выходных|weekend|za\s+vikend|за\s+викенд|за\s+викенд)/u.test(normalized)) return undefined;
  return nearestSaturday(now);
}

function nearestSaturday(now: Date): string {
  const today = belgradeDate(now);
  const date = new Date(`${today}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const daysUntilSaturday = day === 6 ? 0 : (6 - day + 7) % 7;
  date.setUTCDate(date.getUTCDate() + daysUntilSaturday);
  return date.toISOString().slice(0, 10);
}

function isProposalConfirmation(message: string): boolean {
  const normalized = message.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
  if (/^(?:yes|yeah|yep|да|ага|подходит|подойдет|može|moze|da|може)$/iu.test(normalized)) return true;
  return /(?:^|\s)(?:да|ага|yes|yeah|yep|da|može|moze|може)(?:\s|$)/iu.test(normalized) &&
    /(?:подходит|подойдет|works?|odgovara|подходи)/iu.test(normalized);
}

function isProposalDecline(message: string): boolean {
  return /^(?:no|nope|not that|нет|не подходит|ne|ne odgovara|не одговара)$/iu.test(message.trim());
}

function clearDateProposal(lead: StoredLead): void {
  lead.pendingPreferredDate = undefined;
  lead.dateProposalExpiresAt = undefined;
  lead.dateProposalVersion = undefined;
  lead.dateProposalLocale = undefined;
}

function renderWeekendProposal(language: ReplyLanguage, date: string, sundayUnavailable = false): TelegramRenderedReply {
  const locale = isRussianLanguage(language) ? "ru-RU" : isSerbianLanguage(language) ? "sr-Latn-RS" : "en-GB";
  const formatted = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Belgrade", day: "numeric", month: "long" }).format(new Date(`${date}T12:00:00.000Z`));
  if (isRussianLanguage(language)) return { text: `${sundayUnavailable ? "В воскресенье мы не работаем. " : ""}Ближайшая суббота, ${formatted}. Вам подойдет эта дата?`, provenance: "template" };
  if (isSerbianLanguage(language)) return { text: `${sundayUnavailable ? "Nedeljom ne radimo. " : ""}Najbliža subota je ${formatted}. Da li vam odgovara?`, provenance: "template" };
  return { text: `${sundayUnavailable ? "We do not work on Sundays. " : ""}The nearest Saturday is ${formatted}. Would that work for you?`, provenance: "template" };
}

function renderWeekendConfirmation(language: ReplyLanguage, date: string): TelegramRenderedReply {
  const locale = isRussianLanguage(language) ? "ru-RU" : isSerbianLanguage(language) ? "sr-Latn-RS" : "en-GB";
  const formatted = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Belgrade", day: "numeric", month: "long" }).format(new Date(`${date}T12:00:00.000Z`));
  if (isRussianLanguage(language)) return { text: `Записал уборку на субботу, ${formatted}. Когда будете готовы, можно будет подобрать свободное время.`, provenance: "template" };
  if (isSerbianLanguage(language)) return { text: `Zabeležio sam čišćenje za subotu, ${formatted}. Kada budete spremni, možemo izabrati slobodan termin.`, provenance: "template" };
  return { text: `I have noted the cleaning for ${formatted}. When you are ready, we can choose a free time.`, provenance: "template" };
}

function prefersSunday(message: string): boolean {
  return /(?:воскресень|sunday|nedelj|недељ)/iu.test(message);
}

function resolveTimeWindow(message: string): "morning" | "midday" | "evening" | undefined {
  const text = message.normalize("NFKC").toLocaleLowerCase();
  if (/(?:morning|утром|ujutru|ујутру)/u.test(text)) return "morning";
  if (/(?:midday|noon|afternoon|дн[её]м|в середине дня|ближе к обеду|popodne|oko podne|поподне|око подне)/u.test(text)) return "midday";
  if (/(?:evening|вечером|после семи|после\s+19(?::00)?|uveče|uvece|увече)/u.test(text)) return "evening";
  return undefined;
}

/**
 * Recognise only an answer to the already due pet-hair question. Mentioning a
 * dog before the rest of the cleaning profile is known is not a pricing fact;
 * neither is wool/carpet vocabulary without an actual pet and hair context.
 */
function resolveActivePetHairAnswer(message: string, clientData: ClientData): boolean | undefined {
  if (clientData.heavyPetHair !== undefined || !clientData.cleaningType || !clientData.areaM2 || !clientData.rooms || !clientData.bathrooms) return undefined;
  const text = message.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
  // A wool carpet is not evidence of pet hair, even when a customer happens
  // to mention an animal elsewhere in the same sentence.
  if (/(?:ков[её]?р|carpet|wool)/u.test(text)) return undefined;
  const pet = "(?:собак|кошк|животн|питомц|dog|cat|pet|pas|mačk|mack|kućn(?:i|og) ljubim)";
  const hair = "(?:шерст|линя|волос(?:ы|ами)?|pet hair|fur|dlak)";
  const petLinkedHair = new RegExp(`${pet}.{0,80}${hair}|${hair}.{0,80}${pet}`, "u");
  if (!petLinkedHair.test(text)) return undefined;
  // JavaScript `\\b` is ASCII-only, so use Unicode letter delimiters. A
  // Cyrillic `нет`/`без` must be authoritative over any affirmative words.
  const negation = /(?:^|[^\p{L}])(?:нет|без|не|no|without|bez|ne)(?=$|[^\p{L}])/u;
  if (negation.test(text)) return false;
  if (/(?:^|[^\p{L}])(?:да|есть|сильн|много|hairy|shed)(?=$|[^\p{L}])|лин(?:яет|яют)|шерстян|dlak/u.test(text)) return true;
  return undefined;
}

/** Build the privacy-safe, durable scheduling coordinate system for the agent. */
async function buildSchedulingSnapshot(input: { lead: StoredLead; now: Date; repository: LeadRepository; currentTurnDateCoordinate?: CurrentTurnDateCoordinate }): Promise<SchedulingSnapshot> {
  const activeTokens = input.lead.calendarEventId || input.lead.humanNeeded
    ? []
    : await input.repository.listActiveCalendarSlotTokens({ leadId: input.lead.id, now: input.now.toISOString() });
  const state: SchedulingSnapshot["state"] = input.lead.humanNeeded
    ? "human_needed"
    : input.lead.status === "booked"
    ? "booked"
    : input.lead.calendarEventId
    ? "reserved_pending_trello"
    : activeTokens.length > 0
    ? "offered"
    : input.lead.quoteValidity === "active" && input.lead.quote
    ? "quoted"
    : "intake";
  // Availability attempts influence only the active quote/offer protocol.
  // An activity-log outage or malformed historical diagnostic must never
  // block intake, an already-booked lead, or an established Human Needed
  // handoff from receiving ordinary customer support.
  const lastAvailabilityAttempt = state === "quoted" || state === "offered"
    ? await input.repository.getLastAvailabilityAttempt(input.lead.id)
    : null;
  return {
    state,
    currentDate: belgradeDate(input.now),
    preferredDate: input.lead.clientData.preferredDate,
    preferredTimeWindow: input.lead.clientData.preferredTimeWindow,
    ...(input.currentTurnDateCoordinate ? { currentTurnDateCoordinate: input.currentTurnDateCoordinate } : {}),
    ...(input.lead.quoteValidity === "active" && input.lead.quote
      ? { activeQuoteAmountRsd: input.lead.quote.amountRsd }
      : {}),
    ...(activeTokens.length > 0 ? {
      lastOffer: {
        dates: [...new Set(activeTokens.map((token) => belgradeDate(new Date(token.start))))],
        labels: activeTokens.map((token) => token.label),
      },
    } : {}),
    ...(lastAvailabilityAttempt ? { lastAvailabilityAttempt } : {}),
    policy: { timezone: "Europe/Belgrade", workingHours: "Mon-Sat 08:00-20:00; Sunday closed", searchHorizonDays: 14 },
  };
}

/** The dynamic provider schema is the first fence; this executor check makes
 * direct/injected gateway calls equally unable to read Calendar on a stale or
 * invented current-message coordinate. */
function availabilityIntentMatchesCurrentTurnCoordinate(intent: SchedulingAvailabilityIntent, snapshot: SchedulingSnapshot): boolean {
  const coordinate = snapshot.currentTurnDateCoordinate;
  if (coordinate) {
    if (intent.dateReference === "today") return coordinate.recommendedDateReference === "today";
    if (intent.dateReference === "tomorrow") return coordinate.recommendedDateReference === "tomorrow";
    return intent.dateReference === "exact_date" && coordinate.recommendedDateReference === "exact_date" && intent.exactDate === coordinate.date;
  }
  if (intent.dateReference === "current_preferred_date") return Boolean(snapshot.preferredDate);
  if (intent.dateReference === "same_day_as_last_offer" || intent.dateReference === "day_after_last_offer") return Boolean(snapshot.lastOffer);
  return intent.dateReference === "exact_date" &&
    intent.exactDate === snapshot.lastAvailabilityAttempt?.candidateDate;
}

type SemanticAvailabilityResolution =
  | {
      ok: true;
      /** A private copy used for Calendar reads. It is persisted only after a
       * safe offer result has been aligned with the actual offered date. */
      candidateLead: StoredLead;
      candidateDate: string;
      offerOptions: SlotOfferOptions;
    }
  | { ok: false; error: string };

/**
 * Convert the agent's canonical intent into a private candidate and bounded
 * Calendar-search options. This boundary intentionally performs no lead save:
 * an unavailable/failed search is evidence about availability, not a durable
 * change of the customer's requested date, window, urgency or quote.
 */
async function resolveSemanticAvailabilityIntent(input: {
  intent: SchedulingAvailabilityIntent;
  lead: StoredLead;
  now: Date;
  repository: LeadRepository;
}): Promise<SemanticAvailabilityResolution> {
  const activeTokens = await input.repository.listActiveCalendarSlotTokens({ leadId: input.lead.id, now: input.now.toISOString() });
  const lastOfferDate = activeTokens.length > 0 ? earliestOfferedDate(activeTokens) : undefined;
  const hasActiveOffer = activeTokens.length > 0;
  const existingOfferDisposition = input.intent.existingOfferDisposition ??
    (hasActiveOffer ? "retain_until_replacement" : "none");
  if ((hasActiveOffer && existingOfferDisposition === "none") ||
    (!hasActiveOffer && existingOfferDisposition !== "none")) {
    return { ok: false, error: "availability_offer_disposition_invalid" };
  }
  let preferredDate: string | undefined;
  switch (input.intent.dateReference) {
    case "current_preferred_date": preferredDate = input.lead.clientData.preferredDate; break;
    case "today": preferredDate = belgradeDate(input.now); break;
    case "tomorrow": preferredDate = addBelgradeDays(belgradeDate(input.now), 1); break;
    case "same_day_as_last_offer": preferredDate = lastOfferDate; break;
    // This semantic reference is only meaningful relative to an actual,
    // still-active offer. A failed Calendar query never becomes a fake offer.
    case "day_after_last_offer": preferredDate = lastOfferDate ? addBelgradeDays(lastOfferDate, 1) : undefined; break;
    case "exact_date": preferredDate = input.intent.exactDate; break;
  }
  if (!preferredDate) return { ok: false, error: "availability_date_required" };
  if (preferredDate < belgradeDate(input.now)) return { ok: false, error: "availability_date_in_past" };
  if (input.intent.relation === "later_than_last_offer" && (!lastOfferDate || activeTokens.length === 0)) {
    return { ok: false, error: "later_than_last_offer_requires_active_offer" };
  }
  const timePatch: Partial<ClientData> = {};
  if (input.intent.timePreferenceMode !== "preserve") {
    if (input.intent.timePreference === "morning" || input.intent.timePreference === "midday" || input.intent.timePreference === "evening") {
      timePatch.preferredTimeWindow = input.intent.timePreference;
    } else {
      // Explicit `any` removes an earlier window. A date-only follow-up uses
      // `preserve` instead, so it does not silently widen the search.
      timePatch.preferredTimeWindow = undefined;
    }
  }
  const candidateLead = structuredClone(input.lead);
  candidateLead.clientData = mergeClientData(candidateLead.clientData, { preferredDate, ...timePatch }, input.now);
  clearDateProposal(candidateLead);
  const minimumLocalStartMinutes = input.intent.afterLocalTime ? localTimeMinutes(input.intent.afterLocalTime) : undefined;
  const maximumLocalStartMinutes = input.intent.beforeLocalTime ? localTimeMinutes(input.intent.beforeLocalTime) : undefined;
  const minimumStartOnPreferredDate = input.intent.relation === "later_than_last_offer"
    ? nextGridAfterLastOfferedStart(activeTokens, preferredDate)
    : undefined;
  return {
    ok: true,
    candidateLead,
    candidateDate: preferredDate,
    offerOptions: {
      ...(minimumLocalStartMinutes !== undefined ? { minimumLocalStartMinutes } : {}),
      ...(maximumLocalStartMinutes !== undefined ? { maximumLocalStartMinutes } : {}),
      ...(minimumStartOnPreferredDate ? { minimumStartOnPreferredDate } : {}),
      existingOfferDisposition,
      singleOfferDate: true,
    },
  };
}

function localTimeMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours! * 60 + minutes!;
}

function earliestOfferedDate(tokens: StoredCalendarSlotToken[]): string {
  return [...tokens]
    .sort((left, right) => left.start.localeCompare(right.start) || left.displayOrder - right.displayOrder)
    .map((token) => belgradeDate(new Date(token.start)))[0]!;
}

function nextGridAfterLastOfferedStart(tokens: StoredCalendarSlotToken[], preferredDate: string): string | undefined {
  const starts = tokens
    .filter((token) => belgradeDate(new Date(token.start)) === preferredDate)
    .map((token) => new Date(token.start).getTime());
  if (starts.length === 0) return undefined;
  return new Date(Math.max(...starts) + 30 * 60_000).toISOString();
}

function addBelgradeDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}


function normalIntakeReply(
  agentReply: string,
  data: ClientData,
  pricingRules: StoredAgentConfig["pricingRules"],
  language: ReplyLanguage,
): TelegramRenderedReply {
  if (isUsableAgentReply(agentReply, language)) return renderAgentReply(agentReply, language);
  return nextMissingDetailsReply(data, pricingRules, language);
}

function isUsableAgentReply(reply: string, language: ReplyLanguage): boolean {
  const normalized = reply.trim();
  if (normalized.length === 0 || normalized.length > 1_000 || !/[\p{L}]/u.test(normalized)) return false;
  // The renderer can safely strip isolated Markdown, HTML, UUIDs and internal
  // words while preserving useful prose. A stock acknowledgement, however,
  // makes the conversation feel like a form and has no customer value.
  if (/^(?:thanks|thank you|(?<!\p{L})спасибо(?!\p{L})|(?<!\p{L})хвала(?!\p{L})|hvala)/iu.test(normalized)) return false;
  const cyrillicLetters = (normalized.match(/[\u0400-\u052f]/g) ?? []).length;
  const latinLetters = (normalized.match(/[A-Za-zČĆŠŽĐčćšžđ]/g) ?? []).length;
  if (language === "en" || language === "sr-Latn") {
    if (cyrillicLetters > 0) return false;
  } else if (latinLetters > 0 && cyrillicLetters === 0) return false;
  return isFocusedModelIntakeFollowup(normalized);
}

function nextMissingDetailsReply(data: ClientData, pricingRules: StoredAgentConfig["pricingRules"], language: ReplyLanguage): TelegramRenderedReply {
  const decision = calculatePricingDecision(data, pricingRules);
  if (decision.kind !== "missing_data") return renderAgentReply("Could you tell me a little more about the cleaning?", language);
  const missing = new Set<string>(decision.missingFields);
  const has = (field: string) => missing.has(field);
  if (isSerbianLanguage(language)) {
    const text = has("cleaningType") && has("areaM2")
      ? ["Da li vam treba standardno ili detaljno čišćenje, i kolika je približno površina?", "Да ли вам треба стандардно или детаљно чишћење, и колика је приближно површина?"]
      : has("cleaningType")
      ? ["Koja vrsta čišćenja vam treba?", "Која врста чишћења вам треба?"]
      : has("areaM2")
      ? ["Kolika je približno površina stana?", "Колика је приближно површина стана?"]
      : has("rooms") && has("bathrooms")
      ? ["Koliko soba i kupatila ima stan?", "Колико соба и купатила има стан?"]
      : has("rooms")
      ? ["Koliko soba ima stan?", "Колико соба има стан?"]
      : has("bathrooms")
      ? ["Koliko kupatila ima stan?", "Колико купатила има стан?"]
      : has("heavyPetHair") && has("extras")
      ? ["Da li ima mnogo dlaka kućnih ljubimaca ili su potrebne dodatne usluge?", "Да ли има много длака кућних љубимаца или су потребне додатне услуге?"]
      : has("heavyPetHair")
      ? ["Da li ima mnogo dlaka kućnih ljubimaca?", "Да ли има много длака кућних љубимаца?"]
      : has("extras")
      ? ["Da li su potrebne dodatne usluge?", "Да ли су потребне додатне услуге?"]
      : has("addressOrDistrict") && has("preferredDate")
      ? ["U kom delu grada je stan i koji datum bi vam odgovarao?", "У ком делу града је стан и који датум би вам одговарао?"]
      : has("addressOrDistrict")
      ? ["U kom delu grada je stan?", "У ком делу града је стан?"]
      : ["Koji datum bi vam odgovarao?", "Који датум би вам одговарао?"];
    return { text: isSerbianCyrillic(language) ? text[1] : text[0], provenance: "template" };
  }
  if (has("cleaningType") && has("areaM2")) return { text: isRussianLanguage(language) ? "Какой тип уборки нужен и какая примерно площадь?" : "What type of cleaning do you need, and roughly how large is the place?", provenance: "template" };
  if (has("cleaningType")) return { text: isRussianLanguage(language) ? "Какой тип уборки нужен?" : "What type of cleaning do you need?", provenance: "template" };
  if (has("areaM2")) return { text: isRussianLanguage(language) ? "Какая примерно площадь квартиры?" : "Roughly how large is the place?", provenance: "template" };
  if (has("rooms") && has("bathrooms")) return { text: isRussianLanguage(language) ? "Сколько комнат и санузлов в квартире?" : "How many rooms and bathrooms are there?", provenance: "template" };
  if (has("rooms")) return { text: isRussianLanguage(language) ? "Сколько комнат в квартире?" : "How many rooms are there?", provenance: "template" };
  if (has("bathrooms")) return { text: isRussianLanguage(language) ? "Сколько санузлов в квартире?" : "How many bathrooms are there?", provenance: "template" };
  if (has("heavyPetHair") && has("extras")) return { text: isRussianLanguage(language) ? "Есть ли сильная шерсть животных или нужны дополнительные услуги?" : "Is there heavy pet hair, or would you like any extra services?", provenance: "template" };
  if (has("heavyPetHair")) return { text: isRussianLanguage(language) ? "Есть ли сильная шерсть животных?" : "Is there heavy pet hair?", provenance: "template" };
  if (has("extras")) return { text: isRussianLanguage(language) ? "Нужны дополнительные услуги?" : "Would you like any extra services?", provenance: "template" };
  if (has("addressOrDistrict") && has("preferredDate")) return { text: isRussianLanguage(language) ? "В каком районе квартира и на какую дату вам удобно запланировать уборку?" : "Which district is it in, and what date would suit you for the cleaning?", provenance: "template" };
  if (has("addressOrDistrict")) return { text: isRussianLanguage(language) ? "В каком районе квартира?" : "Which district is the apartment in?", provenance: "template" };
  return { text: isRussianLanguage(language) ? "На какую дату вам удобно запланировать уборку?" : "What date would suit you for the cleaning?", provenance: "template" };
}

async function reserveSelectedSlot(input: {
  updateId: number;
  lead: StoredLead;
  slotIndex?: number;
  slotToken?: string;
  replyLanguage: ReplyLanguage;
  dependencies: Stage2Dependencies;
  now: Date;
}): Promise<TelegramWebhookResult | "stale" | null> {
  if (!input.dependencies.calendarReservation) return null;
  // An offer is only actionable while the active quote is still eligible.
  // Check this before any Trello or Calendar work: a late inline button must
  // not re-open a Done/Lost/manual case or create a second side effect.
  if (!isEligibleForSlotReservation(input.lead)) return "stale";
  // A typed retry carries no opaque token. It may resume a previously stored
  // offer before a reservation exists, but only the original consumed opaque
  // token can resume a reservation which was persisted before booking.
  if (!input.slotToken && input.lead.calendarEventId) return "stale";
  const now = input.now.toISOString();
  const selectedSlot = input.slotToken
    ? await input.dependencies.repository.getCalendarSlotToken({ token: input.slotToken, leadId: input.lead.id })
    : (await input.dependencies.repository.listActiveCalendarSlotTokens({
      leadId: input.lead.id,
      now,
    }))[input.slotIndex ?? -1];
  if (!selectedSlot || selectedSlot.supersededAt) return "stale";

  if (input.lead.calendarEventId) {
    const reservationOperation = await input.dependencies.repository.getIntegrationOperation(
      `google_calendar:reservation:${input.lead.id}:${selectedSlot.token}`,
    );
    if (!selectedSlot.consumedAt || reservationOperation?.status !== "succeeded" || reservationOperation.externalId !== input.lead.calendarEventId) {
      return "stale";
    }
    return finalizeReservationBooking(input);
  }
  if (selectedSlot.consumedAt) {
    // A prior attempt can create the Calendar event and complete its
    // idempotency operation just before the atomic lead/outbox persistence
    // fails. Only this original opaque callback may resume that exact
    // succeeded operation; a typed choice cannot reach this branch.
    const reservationOperation = await input.dependencies.repository.getIntegrationOperation(
      `google_calendar:reservation:${input.lead.id}:${selectedSlot.token}`,
    );
    if (reservationOperation?.status !== "succeeded" || !reservationOperation.externalId) return "stale";
  } else if (selectedSlot.expiresAt <= now) {
    return "stale";
  }

  if (input.lead.pendingSchedulingConsentQuotedAt) {
    clearPendingSchedulingConsent(input.lead);
    await input.dependencies.repository.saveLead(input.lead);
  }
  const reservation = await input.dependencies.calendarReservation.reserveSlot(input.lead, selectedSlot.token, input.replyLanguage);
  if (!reservation.ok) {
    if (isStaleSlotReservationError(reservation.error)) return "stale";
    input.lead.humanNeeded = true;
    input.lead.humanNeededReason = reservation.ambiguous ? "calendar_ambiguous" : "calendar_unavailable";
    clearPendingSchedulingConsent(input.lead);
    await input.dependencies.repository.saveLead(input.lead);
    await input.dependencies.repository.appendActivity(input.lead.id, "calendar_reservation_failed", { error_code: reservation.error });
    const delivered = await deliverReply({
      updateId: input.updateId,
      lead: input.lead,
      reply: renderCalendarReservationFailedReply(input.replyLanguage),
      dependencies: input.dependencies,
    });
    if (delivered === "succeeded") return { kind: "processed" };
    await markReservationDeliveryFailure(input.lead, delivered, input.dependencies);
    return { kind: "failed", failureCode: "telegram_delivery_failed" };
  }

  return finalizeReservationBooking(input);
}

async function finalizeReservationBooking(input: {
  updateId: number;
  lead: StoredLead;
  replyLanguage: ReplyLanguage;
  dependencies: Stage2Dependencies;
  now?: Date;
}): Promise<TelegramWebhookResult> {
  // CalendarReservationService atomically persists the Calendar event and a
  // Booked outbox job. The webhook acknowledges only that durable boundary;
  // the recovery worker alone moves Trello and sends final confirmation.
  const delivered = await deliverReply({
    updateId: input.updateId,
    lead: input.lead,
    reply: renderReservationPendingReply(input.replyLanguage, input.lead.assignedTeam && input.lead.bookedStart && input.lead.quote
      ? { team: input.lead.assignedTeam, start: input.lead.bookedStart, quoteAmountRsd: input.lead.quote.amountRsd }
      : undefined),
    kind: "reservation_pending",
    dependencies: input.dependencies,
  });
  if (delivered !== "succeeded") {
    await markReservationDeliveryFailure(input.lead, delivered, input.dependencies);
    return { kind: "failed", failureCode: "telegram_delivery_failed" };
  }
  return { kind: "processed" };
}

async function enqueueQualifiedTrelloProjection(
  lead: StoredLead,
  replyLanguage: ReplyLanguage,
  now: Date,
  dependencies: Stage2Dependencies,
): Promise<void> {
  await dependencies.repository.enqueueTrelloSyncJob({
    leadId: lead.id,
    desiredLifecycle: "qualified",
    replyLanguage,
    now: now.toISOString(),
  });
}

async function syncNewLeadHumanNeededProjection(
  lead: StoredLead,
  dependencies: Stage2Dependencies,
): Promise<void> {
  if (!dependencies.trelloSync) return;
  try {
    await dependencies.trelloSync.syncLead(lead, "new_lead");
  } catch {
    // The customer has already received the escalation reply. Do not turn a
    // best-effort Trello projection failure into a failed Telegram update.
  }
}

async function markReservationDeliveryFailure(
  lead: StoredLead,
  outcome: "failed" | "ambiguous",
  dependencies: Stage2Dependencies,
): Promise<void> {
  lead.humanNeeded = true;
  lead.humanNeededReason = outcome === "ambiguous" ? "delivery_ambiguous" : "delivery_failed";
  clearPendingSchedulingConsent(lead);
  await dependencies.repository.saveLead(lead);
  await dependencies.repository.appendActivity(lead.id, "calendar_reservation_delivery_failed", { outcome });
}

function parseSlotSelection(message: string): { index: number; replyLanguage?: ReplyLanguage } | undefined {
  const normalized = message.trim().toLowerCase();
  if (/^1$/.test(normalized)) return { index: 0 };
  if (/^2$/.test(normalized)) return { index: 1 };
  if (/^3$/.test(normalized)) return { index: 2 };
  if (/^(?:one|first|option 1)$/.test(normalized)) return { index: 0, replyLanguage: "en" };
  if (/^(?:two|second|option 2)$/.test(normalized)) return { index: 1, replyLanguage: "en" };
  if (/^(?:three|third|option 3)$/.test(normalized)) return { index: 2, replyLanguage: "en" };
  if (/^(?:первый|первая|первую|первый вариант|вариант 1)$/.test(normalized)) return { index: 0, replyLanguage: "ru" };
  if (/^(?:второй|вторая|вторую|второй вариант|вариант 2)$/.test(normalized)) return { index: 1, replyLanguage: "ru" };
  if (/^(?:третий|третья|третью|третий вариант|вариант 3)$/.test(normalized)) return { index: 2, replyLanguage: "ru" };
  if (/^(?:prvi|prva|prvu|opcija 1)$/.test(normalized)) return { index: 0, replyLanguage: "sr-Latn" };
  if (/^(?:drugi|druga|drugu|opcija 2)$/.test(normalized)) return { index: 1, replyLanguage: "sr-Latn" };
  if (/^(?:treći|treca|treća|trecu|treću|opcija 3)$/.test(normalized)) return { index: 2, replyLanguage: "sr-Latn" };
  if (/^(?:први|прва|прву|опција 1)$/.test(normalized)) return { index: 0, replyLanguage: "sr-Cyrl" };
  if (/^(?:други|друга|другу|опција 2)$/.test(normalized)) return { index: 1, replyLanguage: "sr-Cyrl" };
  if (/^(?:трећи|трећа|трећу|опција 3)$/.test(normalized)) return { index: 2, replyLanguage: "sr-Cyrl" };
  return undefined;
}

function parseSlotCallbackData(value: string): { slotToken: string; replyLanguage: ReplyLanguage } | undefined {
  const uuid = "([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})";
  const localized = new RegExp(`^slot:(en|ru|sr-Latn|sr-Cyrl):${uuid}$`, "i").exec(value);
  if (localized) return { slotToken: localized[2], replyLanguage: normalizeReplyLocale(localized[1]) };
  const legacy = new RegExp(`^slot:${uuid}$`, "i").exec(value);
  return legacy ? { slotToken: legacy[1], replyLanguage: "en" } : undefined;
}

function normalizeReplyLocale(value: string): ReplyLanguage {
  if (value === "ru") return "ru";
  if (value.toLowerCase() === "sr-latn") return "sr-Latn";
  if (value.toLowerCase() === "sr-cyrl") return "sr-Cyrl";
  return "en";
}

async function sendTyping(telegram: TelegramGateway, chatId: number): Promise<void> {
  await telegram.sendTyping(chatId).catch(() => undefined);
}

const staleSlotReservationErrors = new Set([
  "slot_token_invalid_or_expired",
  "slot_offer_superseded",
  "slot_token_stale",
  "slot_no_longer_available",
]);

function isStaleSlotReservationError(error: string): boolean {
  return staleSlotReservationErrors.has(error);
}

async function acknowledgeCallback(telegram: TelegramGateway, callbackQueryId: string): Promise<boolean> {
  try {
    await telegram.answerCallbackQuery(callbackQueryId);
    return true;
  } catch {
    return false;
  }
}

async function recordCallbackAcknowledgementFailure(
  lead: StoredLead | null,
  dependencies: Stage2Dependencies,
): Promise<void> {
  if (!lead) {
    console.warn("Telegram callback acknowledgement failed");
    return;
  }
  try {
    await dependencies.repository.appendActivity(lead.id, "telegram_callback_ack_failed", { outcome: "failed" });
  } catch {
    console.warn("Telegram callback acknowledgement failure could not be recorded");
  }
}

async function deliverStaleSlotReply(input: {
  lead: StoredLead;
  slotToken?: string;
  replyLanguage: ReplyLanguage;
  dependencies: Stage2Dependencies;
}): Promise<void> {
  const delivered = await deliverReply({
    updateId: 0,
    lead: input.lead,
    reply: renderStaleSlotReply(input.replyLanguage),
    kind: "slot_stale",
    idempotencyKey: `telegram:slot_stale:${input.lead.id}:${input.slotToken ?? "unknown"}`,
    dependencies: input.dependencies,
  });
  if (delivered === "succeeded") return;
  try {
    await input.dependencies.repository.appendActivity(input.lead.id, "slot_stale_reply_delivery_not_confirmed", { outcome: delivered });
  } catch {
    console.warn("Stale slot reply delivery outcome could not be recorded");
  }
}

async function deliverReply(input: {
  updateId: number;
  lead: StoredLead;
  reply: TelegramRenderedReply;
  kind?: "reply" | "reservation_pending" | "booking_confirmed" | "reservation_manual" | "slot_stale";
  idempotencyKey?: string;
  dependencies: Stage2Dependencies;
}): Promise<"succeeded" | "failed" | "ambiguous"> {
  const idempotencyKey = input.idempotencyKey ?? `telegram:${input.kind ?? "reply"}:${input.updateId}`;
  const operation = await input.dependencies.repository.createIntegrationOperation({
    leadId: input.lead.id,
    idempotencyKey,
    provider: "telegram",
    operationType: "send_message",
  });

  if (!operation.isNew) {
    if (operation.status === "succeeded") return "succeeded";
    return operation.status === "failed" ? "failed" : "ambiguous";
  }
  try {
    const sent = await input.dependencies.telegram.sendMessage({
      chatId: input.lead.telegramChatId,
      text: input.reply.text,
      replyMarkup: input.reply.replyMarkup ?? newAddressKeyboard,
      provenance: input.reply.provenance,
    });
    await input.dependencies.repository.completeIntegrationOperation(idempotencyKey, sent.messageId);
    return "succeeded";
  } catch (error) {
    const outcome = error instanceof TelegramDeliveryError ? error.outcome : "ambiguous";
    await input.dependencies.repository.failIntegrationOperation(
      idempotencyKey,
      "telegram_delivery_failed",
      outcome === "ambiguous" ? "ambiguous" : "failed",
    );
    return outcome;
  }
}

function mergeClientData(current: ClientData, patch: ClientData, now: Date): ClientData {
  return normalizeUrgency({
    ...current,
    ...patch,
    extras: patch.extras ?? current.extras,
  }, now);
}

function normalizeUrgency(data: ClientData, now: Date): ClientData {
  if (!data.preferredDate || !isValidIsoDate(data.preferredDate)) {
    const withoutUrgency = { ...data };
    delete withoutUrgency.urgency;
    return withoutUrgency;
  }
  if (data.preferredDate !== belgradeDate(now)) {
    const withoutUrgency = { ...data };
    delete withoutUrgency.urgency;
    return withoutUrgency;
  }
  return {
    ...data,
    // The date is the only source of truth. This also repairs older leads
    // whose model patch left urgency empty and overwrites an outdated value
    // whenever the customer changes the requested date.
    urgency: "same_day",
  };
}

function belgradeDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) throw new Error("Unable to resolve Europe/Belgrade date");
  return `${year}-${month}-${day}`;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isEligibleForSlotReservation(lead: StoredLead): boolean {
  return lead.status === "qualified" &&
    lead.quote !== undefined &&
    lead.quoteValidity === "active" &&
    !lead.humanNeeded &&
    typeof lead.clientData.preferredDate === "string";
}

function isHumanHandoffQuestion(message: string): boolean {
  return /(?:человек|команд[ае]|переда[йт]|(?<!\p{L})(?:human|person|someone|team|osob[au]|tim)(?!\p{L}))/iu.test(message);
}

function hasCleaningOrSchedulingContext(message: string, lead: StoredLead): boolean {
  if (lead.clientData.cleaningType || lead.clientData.areaM2 || lead.clientData.addressOrDistrict || lead.clientData.rooms || lead.clientData.bathrooms || lead.quote) return true;
  return /(?:уборк|clean(?:ing)?|čišćen|ciscen|чи[шш]ћењ|чишћ|booking|book|schedule|termin|zakaz|слот|термин|время|дата)/iu.test(message);
}

function isIncidentalTimeQuestion(message: string): boolean {
  return /(?:погод|weather|vreme|време)/iu.test(message) && /(?:сегодня|today|danas|данас)/iu.test(message);
}

function hasStandaloneSchedulingDateIntent(message: string): boolean {
  return /(?:\b\d{1,2}\.\d{1,2}\.\d{2,4}\b|\b(?:in\s+(?:\d+|one|two|three)\s+days?|thursday)\b|через\s+(?:\d+|один|одну|два|две|три)\s+дн|\d{1,2}\.?\s+(?:январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр|avgust|septembar|january|february|march|april|may|june|july|august|september|october|november|december)|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2})/iu.test(message);
}

/** A Human Needed follow-up may update one concrete fact, never run tools for a pure question. */
function hasHandoffFollowupFact(message: string, resolvedDate: string | undefined): boolean {
  if (resolvedDate) return true;
  if (/[0-9]+\s*(?:m2|m²|м²|метр|kvadrat)/iu.test(message)) return true;
  if (isLikelyPunctuationlessQuestion(message)) return false;
  return /(?:комнат|сануз|площад|район|адрес|окн|духовк|балкон|террас|шерст|after renovation|office|commercial|sofa|carpet|stains?|wool|staff kitchen|rooms?|bathrooms?|area|district|window|oven|balcony|pet hair|soba|kupatil|površin|dodatn|dlak)/iu.test(message) && !/\?\s*$/u.test(message.trim());
}

function resolveKnownHandoffDistrict(message: string): "New Belgrade" | undefined {
  return /(?:\bnew\s+belgrade\b|нов(?:ый|ом)\s+белград(?:у|а)?)/iu.test(message)
    ? "New Belgrade"
    : undefined;
}

/** Customer questions often omit a question mark in chat; do not expose an update tool for them. */
function isLikelyPunctuationlessQuestion(message: string): boolean {
  const normalized = message.normalize("NFKC").trim().toLocaleLowerCase();
  return /^(?:can|could|do|does|is|are|what|which|how)\b/u.test(normalized)
    || /^(?:можете|можешь|есть\s+ли|нужны\s+ли|какой|какие|сколько|подскажите|будет\s+ли)/u.test(normalized)
    || /^(?:da\s+li|možete|mozes|imate\s+li|koji|koliko)/u.test(normalized);
}

function humanNeededFollowupDetail(message: string, language: ReplyLanguage, resolvedDate: string | undefined): string | undefined {
  const lower = message.toLocaleLowerCase();
  const russian = isRussianLanguage(language);
  const serbian = isSerbianLanguage(language);
  if (/(?:цен|стоим|price|cost|cena|цена)/u.test(lower)) {
    return russian ? "Автоматически точную цену для такой заявки не считаю, команда подготовит её вручную"
      : serbian ? "Automatski obračun nije dostupan za ovakav zahtev; tim će pripremiti cenu ručno"
      : "An automatic price is not available for this request; our team will prepare it manually";
  }
  if (resolvedDate || /(?:август|сентябр|январ|феврал|март|апрел|мая|июн|июл|октябр|ноябр|декабр|avgust|septembar|januar|februar|mart|april|maj|jun|jul|oktobar|novembar|decembar)/u.test(lower)) {
    return russian ? "Желаемую дату записал в заявку"
      : serbian ? "Željeni datum sam zabeležio uz zahtev"
      : "I have recorded the requested date on your request";
  }
  if (resolveKnownHandoffDistrict(message)) {
    return russian ? "Район Новый Белград добавил к заявке"
      : serbian ? "Novi Beograd sam dodao uz zahtev"
      : "I have added New Belgrade to your request";
  }
  if (/(?:sofa|диван|stains?|пятн)/u.test(lower) && !/(?:carpet|ков[её]р|wool|шерстян)/u.test(lower)) {
    return russian ? "Состояние дивана и пятна добавил к заявке"
      : serbian ? "Stanje sofe i fleke sam dodao uz zahtev"
      : "I have added the sofa condition and stains to your request";
  }
  if (/(?:carpet|ков[её]р|wool|шерстян)/u.test(lower) && !/(?:sofa|диван|stains?|пятн)/u.test(lower)) {
    return russian ? "Материал ковра добавил к заявке"
      : serbian ? "Materijal tepiha sam dodao uz zahtev"
      : "I have added the carpet material to your request";
  }
  if (/(?:sofa|carpet|диван|ков[её]р)/u.test(lower)) {
    return russian ? "Состояние дивана и ковра добавил к заявке"
      : serbian ? "Stanje sofe i tepiha sam dodao uz zahtev"
      : "I have added the sofa and carpet condition to your request";
  }
  if (/(?:staff kitchen|office|commercial|офис|коммерческ|кухн(?:я|и) для сотрудников)/u.test(lower)) {
    return russian ? "Детали коммерческого помещения добавил к заявке"
      : serbian ? "Detalje poslovnog prostora sam dodao uz zahtev"
      : "I have added the commercial space details to your request";
  }
  if (/(?:комнат|сануз|rooms?|bathrooms?|soba|kupatil)/u.test(lower)) {
    return russian ? "Количество комнат и санузлов добавил к заявке"
      : serbian ? "Broj soba i kupatila sam dodao uz zahtev"
      : "I have added the room and bathroom details to your request";
  }
  if (/(?:окн|духовк|балкон|террас|шерст|window|oven|balcony|pet hair|dodatn|dlak)/u.test(lower)) {
    return russian ? "Дополнительные услуги и особенности уборки добавил к заявке"
      : serbian ? "Dodatne usluge i posebnosti čišćenja sam dodao uz zahtev"
      : "I have added the extra services and cleaning details to your request";
  }
  if (/(?:площад|район|адрес|area|district|address|površin|deo grada|kraj grada)/u.test(lower)) {
    return russian ? "Площадь и адрес добавил к заявке"
      : serbian ? "Površinu i lokaciju sam dodao uz zahtev"
      : "I have added the area and location to your request";
  }
  return undefined;
}

function pricingInputsChanged(current: ClientData, next: ClientData): boolean {
  return current.cleaningType !== next.cleaningType ||
    current.areaM2 !== next.areaM2 ||
    current.bathrooms !== next.bathrooms ||
    current.heavyPetHair !== next.heavyPetHair ||
    current.urgency !== next.urgency ||
    !sameExtras(current.extras, next.extras);
}

function hasActiveQualifiedQuote(lead: StoredLead): boolean {
  return lead.status === "qualified" && lead.quoteValidity === "active" && lead.quote !== undefined && !lead.humanNeeded;
}

function activateQuote(lead: StoredLead, quote: Quote, pricingRules: PricingRules, now: Date): void {
  lead.quote = quote;
  lead.quoteValidity = "active";
  lead.quoteInvalidatedAt = undefined;
  lead.quotedAt = now.toISOString();
  lead.pricingRulesSnapshot = pricingRules;
  lead.humanNeeded = false;
  lead.humanNeededReason = undefined;
}

/** A date-less quote is a standard-price estimate, not a scheduling offer. */
function quoteReplyOptions(clientData: ClientData, pricingRules: PricingRules): { sameDayAmountRsd?: number } {
  if (clientData.preferredDate) return {};
  const sameDay = calculatePricingDecision({ ...clientData, urgency: "same_day" }, pricingRules);
  return sameDay.kind === "quote" ? { sameDayAmountRsd: sameDay.quote.amountRsd } : {};
}

/**
 * A provider Conversation is disposable after any typed technical failure,
 * including creation. This first recovery changes no customer business state:
 * the deterministic resend is marked processed only after Telegram delivery.
 */
async function recoverTechnicalConversationFailure(input: {
  updateId: number;
  lead: StoredLead;
  replyLanguage: ReplyLanguage;
  dependencies: Stage2Dependencies;
}): Promise<TelegramWebhookResult> {
  const { updateId, lead, replyLanguage, dependencies } = input;
  await dependencies.repository.invalidateConversation(lead.id);
  const recoveryKey = `openai:conversation_recovery:${lead.id}`;
  const previousRecovery = await dependencies.repository.getIntegrationOperation(recoveryKey);
  if (previousRecovery?.status === "succeeded") {
    lead.humanNeeded = true;
    lead.humanNeededReason = "conversation_ambiguous";
    clearPendingSchedulingConsent(lead);
    await dependencies.repository.saveLead(lead);
    const delivered = await deliverReply({ updateId, lead, reply: renderHumanNeededReply(replyLanguage), dependencies });
    if (delivered === "succeeded") {
      await dependencies.repository.markTelegramUpdateProcessed(updateId);
      return { kind: "processed" };
    }
    await dependencies.repository.markTelegramUpdateFailed(updateId, "telegram_delivery_failed");
    return { kind: "failed", failureCode: "telegram_delivery_failed" };
  }
  const recoveryMarker = await dependencies.repository.createIntegrationOperation({
    leadId: lead.id,
    idempotencyKey: recoveryKey,
    provider: "openai",
    operationType: "conversation_recovery_marker",
  });
  if (recoveryMarker.isNew || recoveryMarker.status !== "succeeded") {
    await dependencies.repository.completeIntegrationOperation(recoveryKey);
  }
  await dependencies.repository.appendActivity(lead.id, "conversation_invalidated_after_technical_turn", { outcome: "first_recovery" });
  await dependencies.repository.saveLead(lead);
  const delivered = await deliverReply({ updateId, lead, reply: renderTechnicalResendReply(replyLanguage), dependencies });
  if (delivered === "succeeded") {
    await dependencies.repository.markTelegramUpdateProcessed(updateId);
    return { kind: "processed" };
  }
  await dependencies.repository.markTelegramUpdateFailed(updateId, "telegram_delivery_failed");
  return { kind: "failed", failureCode: "telegram_delivery_failed" };
}

/**
 * A deferred offer is never customer-visible until its token write and the
 * agent-turn operation acknowledgement complete. If either boundary fails we
 * have already superseded the offer, restore the prior lead projection and
 * make the operationally meaningful Calendar handoff durable.
 */
async function recoverDeferredSlotOfferBoundaryFailure(input: {
  updateId: number;
  lead: StoredLead;
  replyLanguage: ReplyLanguage;
  dependencies: Stage2Dependencies;
  now: Date;
  errorCode: DeferredSlotOfferBoundaryError["code"];
}): Promise<TelegramWebhookResult> {
  const { updateId, lead, replyLanguage, dependencies, now, errorCode } = input;
  lead.humanNeeded = true;
  lead.humanNeededReason = "calendar_unavailable";
  clearPendingSchedulingConsent(lead);
  await dependencies.repository.saveLead(lead);
  await dependencies.repository.appendActivity(lead.id, "calendar_availability_failed", { error_code: errorCode });
  const delivered = await deliverReply({
    updateId,
    lead,
    reply: renderCalendarAvailabilityFailedReply(replyLanguage),
    dependencies,
  });
  if (delivered !== "succeeded") {
    await dependencies.repository.markTelegramUpdateFailed(updateId, "telegram_delivery_failed");
    return { kind: "failed", failureCode: "telegram_delivery_failed" };
  }
  if (lead.status === "qualified") {
    await enqueueQualifiedTrelloProjection(lead, replyLanguage, now, dependencies);
  }
  await dependencies.repository.markTelegramUpdateProcessed(updateId);
  return { kind: "processed" };
}

function isConversationTechnicalFailure(error: unknown): boolean {
  return error instanceof AgentTurnTechnicalError ||
    (error instanceof Error && /(?:max_turns|customer_turn_deadline|scenario_deadline|agent_turn_aborted)/iu.test(error.message));
}

/** Evaluator limits must never become a customer-visible recovery resend. */
function isEvaluatorControlFence(error: unknown): boolean {
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

function sameExtras(current: ClientData["extras"], next: ClientData["extras"]): boolean {
  if (current === next) return true;
  if (!current || !next || current.length !== next.length) return false;
  return [...current].sort().every((extra, index) => extra === [...next].sort()[index]);
}

function supersedeQuote(lead: StoredLead, now: Date = new Date()): void {
  if (!lead.quote) return;
  lead.quoteValidity = "superseded";
  lead.quoteInvalidatedAt = now.toISOString();
  clearPendingSchedulingConsent(lead);
}

/** Revert only the schedule-defining facts after an unavailable Calendar. */
function restoreSchedulingSnapshot(lead: StoredLead, snapshot: StoredLead): void {
  lead.clientData = {
    ...lead.clientData,
    preferredDate: snapshot.clientData.preferredDate,
    preferredTimeWindow: snapshot.clientData.preferredTimeWindow,
    urgency: snapshot.clientData.urgency,
  };
  lead.quote = snapshot.quote ? structuredClone(snapshot.quote) : undefined;
  lead.quoteValidity = snapshot.quoteValidity;
  lead.quoteInvalidatedAt = snapshot.quoteInvalidatedAt;
  lead.quotedAt = snapshot.quotedAt;
  lead.pendingSchedulingConsentQuotedAt = snapshot.pendingSchedulingConsentQuotedAt;
}

function hasActivePendingSchedulingConsent(lead: StoredLead): boolean {
  return Boolean(
    lead.pendingSchedulingConsentQuotedAt &&
    lead.quote &&
    lead.quoteValidity === "active" &&
    lead.quotedAt === lead.pendingSchedulingConsentQuotedAt &&
    !lead.humanNeeded &&
    !lead.calendarEventId,
  );
}

function clearPendingSchedulingConsent(lead: StoredLead): void {
  lead.pendingSchedulingConsentQuotedAt = undefined;
}

function isBareSchedulingConsent(message: string): boolean {
  const normalized = message.normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return /^(?:yes|yeah|yep|sure|да|ага|давай|može|moze|da|може)$/iu.test(normalized);
}

function dropNullValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null));
}

/**
 * The agent receives natural customer text, so it may echo a human date such
 * as "26 августа" in its strict tool payload. Keep the already-normalised
 * backend date and the rest of the valid patch instead of rejecting every
 * supplied detail because of that single presentation-format value.
 */
function normalizeCustomerDatePatch(patch: Record<string, unknown>, now: Date): Record<string, unknown> {
  const normalized = dropNullValues(patch);
  if (typeof normalized.preferredDate === "string") {
    if (isValidIsoDate(normalized.preferredDate)) {
      // A model may echo a stale ISO date even after the webhook already
      // resolved today's or a future requested date. Never let that overwrite
      // validated current/future customer intent.
      if (normalized.preferredDate < belgradeDate(now)) delete normalized.preferredDate;
    } else {
      const resolved = resolveRelativePreferredDate(normalized.preferredDate, now);
      if (resolved) normalized.preferredDate = resolved;
      else delete normalized.preferredDate;
    }
  }
  return normalized;
}
