import { z } from "zod";
import { randomUUID } from "node:crypto";

import { AgentTurnTechnicalError, type AgentGateway } from "@/lib/agent/gateway";
import { CalendarReservationService } from "@/lib/calendar/reservation-service";
import type { SlotOfferOptions } from "@/lib/calendar/reservation-service";
import { clientDataPatchSchema, humanNeededReasons, type AgentToolName, type AgentTurn, type AvailabilitySlot, type ClientData, type HumanNeededReason, type PricingRules, type Quote } from "@/lib/contracts/domain";
import type { LeadRepository, StoredAgentConfig, StoredCalendarSlotToken, StoredLead } from "@/lib/leads/repository";
import { calculatePricingDecision } from "@/lib/pricing/engine";
import { getEffectiveAgentConfig } from "@/lib/runtime-config/effective-agent-config";
import { TelegramDeliveryError, type TelegramGateway, type TelegramReplyMarkup } from "@/lib/telegram/gateway";
import {
  renderAgentReply,
  renderCalendarAvailabilityFailedReply,
  renderCalendarReservationFailedReply,
  renderHumanNeededReply,
  renderHumanNeededAlreadyHandedOffReply,
  renderHumanNeededUpdateReply,
  renderReservedAcknowledgementReply,
  renderSchedulingConsentNeedsDateReply,
  renderNewAddressDivider,
  renderNoAvailabilityReply,
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
    urgency: z.unknown().optional(),
  }).strict(),
}).strict();
const newAddressButtonText = "New address";
const newAddressKeyboard: TelegramReplyMarkup = {
  keyboard: [[{ text: newAddressButtonText }]],
  resize_keyboard: true,
  is_persistent: true,
};

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
        ? await renderAvailabilityOffer({ lead, replyLanguage, dependencies, calendarReservation: dependencies.calendarReservation, options: { supersedeExisting: true } })
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
    const weekendDate = dateContext ? weekendProposalDate(messageText, now) : undefined;
    const resolvedDateCandidate = resolveRelativePreferredDate(messageText, now);
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
    if (requestedTimeWindow && lead.clientData.preferredTimeWindow !== requestedTimeWindow) {
      lead.clientData = { ...lead.clientData, preferredTimeWindow: requestedTimeWindow };
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "time_window_requested", { window: requestedTimeWindow });
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
        ? await renderAvailabilityOffer({ lead, replyLanguage, dependencies, calendarReservation: dependencies.calendarReservation, options: { supersedeExisting: true } })
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
    if (relativePreferredDate) {
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

    // Availability is a backend-owned scheduling intent. Keep an unambiguous,
    // qualified availability-only request out of the OpenAI and Trello paths:
    // neither provider is needed to calculate the next offered slots.
    let scheduleRecovery = dependencies.calendarReservation && isEligibleForSlotReservation(lead)
      ? await resolveScheduleRecoveryRequest({ message: messageText, lead, now, repository: dependencies.repository })
      : undefined;
    if (scheduleRecovery?.clientDataChanged) {
      if (pricingInputsChanged(lead.clientData, scheduleRecovery.clientData)) {
        // A same-day request can become a later date (or the reverse), which
        // changes the deterministic price. Never offer a slot against that
        // stale quote; the normal quote path will show the new amount first.
        supersedeQuote(lead, now);
      }
      lead.clientData = scheduleRecovery.clientData;
      clearDateProposal(lead);
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "schedule_recovery_requested", { preferred_date: lead.clientData.preferredDate, preferred_window: lead.clientData.preferredTimeWindow, kind: scheduleRecovery.kind });
      if (!isEligibleForSlotReservation(lead)) scheduleRecovery = undefined;
    }
    const strictSchedulingIntent = Boolean(scheduleRecovery) || isStrictTimeWindowRequest(messageText) || isStrictAvailabilityRequest(messageText);
    const explicitSchedulingIntent = strictSchedulingIntent || hasExplicitSchedulingIntent(messageText);
    if (strictSchedulingIntent && dependencies.calendarReservation && isEligibleForSlotReservation(lead) && !lead.calendarEventId) {
      const response = await renderAvailabilityOffer({ lead, replyLanguage, dependencies, calendarReservation: dependencies.calendarReservation, options: scheduleRecovery?.offerOptions });
      const delivered = await deliverReply({ updateId: update.update_id, lead, reply: response, dependencies });
      if (delivered !== "succeeded") { await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed"); return { kind: "failed", failureCode: "telegram_delivery_failed" }; }
      await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      return { kind: "processed" };
    }

    let conversation = await dependencies.repository.getConversation(lead.id);
    if (!conversation) {
      // Each invalidated provider Conversation gets one new, durable creation
      // operation. Reusing the original succeeded idempotency key would put
      // the poisoned external id straight back into the next Runner turn.
      const recoveryOperation = await dependencies.repository.getIntegrationOperation(`openai:conversation_recovery:${lead.id}`);
      const idempotencyKey = recoveryOperation?.status === "succeeded"
        ? `openai:conversation:${lead.id}:recovery:${update.update_id}`
        : `openai:conversation:${lead.id}:initial`;
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
    const hadActiveQuoteBeforeTurn = isEligibleForSlotReservation(lead);
    const wasHumanNeededBeforeTurn = lead.humanNeeded;
    // Supplying a date after an already active base quote changes scheduling
    // readiness, not the price or booking state. Let the model save an
    // additional valid fact if needed, but keep quote/availability/handoff
    // tools out of this date-only turn.
    const isDateOnlyQuoteFollowup = hadActiveQuoteBeforeTurn && Boolean(relativePreferredDate) && !explicitSchedulingIntent;
    const allowedTools: AgentToolName[] = wasHumanNeededBeforeTurn
      ? hasHandoffFollowupFact(messageText, relativePreferredDate)
        ? ["update_client_data"]
        : []
      : isDateOnlyQuoteFollowup
      ? ["update_client_data"]
      : ["update_client_data", "mark_human_needed", "calculate_quote", ...(hadActiveQuoteBeforeTurn && explicitSchedulingIntent && !lead.calendarEventId ? ["request_available_slots" as const] : [])];
    // A provider error can occur after a semantic tool has returned. Restore
    // this exact snapshot before persisting recovery so partial quote/lifecycle
    // or Human Needed mutations never become a later customer fact.
    const persistedLeadBeforeTurn = structuredClone(lead);
    let quote: Quote | undefined;
    let humanNeededReason: HumanNeededReason | undefined;
    let updateClientDataCalls = 0;
    // Customer-facing Human Needed copy may claim a specific detail was saved
    // only after this turn has proved a persisted data change. A raw message
    // by itself is not such proof.
    let persistedHandoffFact = wasHumanNeededBeforeTurn && (backendHandoffLocationPersisted || (Boolean(relativePreferredDate) && lead.clientData.preferredDate === relativePreferredDate));
    let calendarFailure = false;
    let noAvailableSlots = false;
    let noAvailableSlotsReason: "nonworking_day" | "requested_date_unavailable" | "requested_time_unavailable" | undefined;
    let offeredSlots: AvailabilitySlot[] | undefined;
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
          const previousClientData = lead.clientData;
          const nextClientData = mergeClientData(lead.clientData, patch.data, now);
          if (pricingInputsChanged(lead.clientData, nextClientData)) supersedeQuote(lead, now);
          lead.clientData = nextClientData;
          if (wasHumanNeededBeforeTurn && JSON.stringify(previousClientData) !== JSON.stringify(nextClientData)) {
            persistedHandoffFact = true;
          }
          return { ok: true, client_data: lead.clientData };
        }

        if (name === "mark_human_needed") {
          const result = humanNeededSchema.safeParse(argumentsJson);
          if (!result.success) return { ok: false, error: "invalid_human_needed_reason" };
          humanNeededReason = result.data.reason;
          return { ok: true, human_needed: true, reason: humanNeededReason };
        }

        if (name === "request_available_slots") {
          if (!dependencies.calendarReservation) return { ok: false, error: "calendar_not_configured" };
          if (!hadActiveQuoteBeforeTurn || !explicitSchedulingIntent || lead.calendarEventId) {
            return { ok: false, error: "availability_requires_prior_active_quote_and_explicit_scheduling_intent" };
          }
          const result = await dependencies.calendarReservation.offerSlots(lead, replyLanguage);
          if (!result.ok && (
            result.error === "duration_exceeds_workday" ||
            result.error === "calendar_availability_failed" ||
            result.error === "calendar_slot_offer_persist_failed"
          )) {
            humanNeededReason = "calendar_unavailable";
            calendarFailure = true;
            await dependencies.repository.appendActivity(lead.id, "calendar_availability_failed", { error_code: result.error });
          }
          if (!result.ok) {
            if (result.error === "no_available_slots") {
              noAvailableSlots = true;
              noAvailableSlotsReason = result.availabilityReason;
              await dependencies.repository.appendActivity(lead.id, "calendar_no_availability", { error_code: result.error });
            }
            return { ok: false, error: result.error };
          }
          offeredSlots = result.slots;
          return {
            ok: true,
            options: result.slots.map((slot) => ({ option: slot.displayOrder, label: slot.label })),
          };
        }

        const decision = calculatePricingDecision(lead.clientData, config.pricingRules);
        if (decision.kind === "quote") {
          quote = decision.quote;
          quoteCalculatedThisTurn = true;
          return { ok: true, kind: "quote", quote: { amountRsd: quote.amountRsd } };
        }
        if (decision.kind === "human_needed") {
          humanNeededReason = decision.reason;
          return { ok: true, kind: "human_needed", reason: decision.reason };
        }
        return { ok: true, kind: "missing_data", missing_fields: decision.missingFields };
      },
      });
      await dependencies.repository.completeIntegrationOperation(agentTurnOperation.idempotencyKey);
    } catch (error) {
      if (isEvaluatorControlFence(error)) throw error;
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
      lead.quote = quote;
      lead.quoteValidity = "active";
      lead.quoteInvalidatedAt = undefined;
      lead.quotedAt = now.toISOString();
      lead.pricingRulesSnapshot = config.pricingRules;
      lead.humanNeeded = false;
      lead.humanNeededReason = undefined;
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
      ? renderSlotOfferReply(replyLanguage, offeredSlots)
      : noAvailableSlots
      ? renderNoAvailabilityReply(replyLanguage, noAvailableSlotsReason)
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
        : renderHumanNeededReply(replyLanguage)
      : conversationalReply
      ?? renderAgentReply(turn.reply, replyLanguage);
    const deliveryOutcome = await deliverReply({
      updateId: update.update_id,
      lead,
      reply,
      dependencies,
    });
    if (deliveryOutcome !== "succeeded") {
      if (!lead.humanNeeded) {
        lead.humanNeeded = true;
        lead.humanNeededReason = deliveryOutcome === "ambiguous" ? "delivery_ambiguous" : "delivery_failed";
        clearPendingSchedulingConsent(lead);
      }
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "telegram_delivery_failed", { outcome: deliveryOutcome });
      await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed");
      return { kind: "failed", failureCode: "telegram_delivery_failed" };
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
  options?: SlotOfferOptions;
}): Promise<TelegramRenderedReply> {
  const offer = await input.calendarReservation.offerSlots(input.lead, input.replyLanguage, input.options);
  if (offer.ok) return offer.match === "nearest_alternatives"
    ? renderNearestSlotAlternativesReply(input.replyLanguage, offer.slots, offer.availabilityReason === "exact" ? "requested_date_unavailable" : offer.availabilityReason)
    : renderSlotOfferReply(input.replyLanguage, offer.slots);
  if (offer.error === "no_available_slots") {
    await input.dependencies.repository.appendActivity(input.lead.id, "calendar_no_availability", { error_code: offer.error });
    return renderNoAvailabilityReply(input.replyLanguage, offer.availabilityReason);
  }
  input.lead.humanNeeded = true;
  input.lead.humanNeededReason = "calendar_unavailable";
  clearPendingSchedulingConsent(input.lead);
  await input.dependencies.repository.saveLead(input.lead);
  await input.dependencies.repository.appendActivity(input.lead.id, "calendar_availability_failed", { error_code: offer.error });
  return renderCalendarAvailabilityFailedReply(input.replyLanguage);
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
    [/(?:^|\s)сегодня(?:$|\s|[,.!])/u, 0], [/(?:^|\s)завтра(?:$|\s|[,.!])/u, 1], [/(?:^|\s)послезавтра(?:$|\s|[,.!])/u, 2],
    [/(?:^|\s)today(?:$|\s|[,.!])/u, 0], [/(?:^|\s)tomorrow(?:$|\s|[,.!])/u, 1], [/(?:^|\s)the day after tomorrow(?:$|\s|[,.!])/u, 2],
    [/(?:^|\s)danas(?:$|\s|[,.!])/u, 0], [/(?:^|\s)sutra(?:$|\s|[,.!])/u, 1], [/(?:^|\s)prekosutra(?:$|\s|[,.!])/u, 2],
    [/(?:^|\s)данас(?:$|\s|[,.!])/u, 0], [/(?:^|\s)сутра(?:$|\s|[,.!])/u, 1], [/(?:^|\s)прекосутра(?:$|\s|[,.!])/u, 2],
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

type ScheduleRecoveryRequest = {
  kind: "later" | "time_window" | "next_day";
  clientData: ClientData;
  clientDataChanged: boolean;
  offerOptions: SlotOfferOptions;
};

/**
 * A compact scheduling follow-up is resolved entirely by typed backend state.
 * It is intentionally available only after a qualified active quote; a model
 * cannot turn a conversational acknowledgement into a booking instruction.
 */
async function resolveScheduleRecoveryRequest(input: {
  message: string;
  lead: StoredLead;
  now: Date;
  repository: LeadRepository;
}): Promise<ScheduleRecoveryRequest | undefined> {
  const text = input.message.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
  // This fast path deliberately accepts only a whole, compact scheduling
  // follow-up. It must never try to prove the absence of every possible order
  // detail: any added fact belongs to the normal agent/data-validation path.
  if (!isSchedulingOnlyRecoveryMessage(text)) return undefined;
  const isLater = /(?:^|\s)(?:позже|попозже|later|kasnije)(?:$|\s|[?!.,])/u.test(text);
  const isNextDay = /(?:на\s+следующ(?:ий|его)\s+день|следующ(?:ий|его)\s+день|next day)/u.test(text);
  const window = resolveTimeWindow(text);
  const afterMinutes = resolveAfterLocalMinutes(text);
  const hasRecoveryPhrase = isLater || isNextDay || window !== undefined || afterMinutes !== undefined;
  if (!hasRecoveryPhrase) return undefined;

  const nowIso = input.now.toISOString();
  const activeTokens = await input.repository.listActiveCalendarSlotTokens({ leadId: input.lead.id, now: nowIso });
  // "Later" is relative to a displayed offer, so it must retain a durable
  // token. A standalone time window or "next day" is safe from the persisted
  // preferred date after an active quote, even if an old offer has expired.
  if (isLater && activeTokens.length === 0) return undefined;

  const offeredDate = activeTokens.length > 0 ? earliestOfferedDate(activeTokens) : undefined;
  const baseDate = offeredDate ?? input.lead.clientData.preferredDate;
  if (!baseDate) return undefined;
  const preferredDate = isNextDay ? addBelgradeDays(baseDate, 1) : (isLater ? offeredDate! : baseDate);
  const nextClientData = mergeClientData(input.lead.clientData, {
    preferredDate,
    ...(window ? { preferredTimeWindow: window } : {}),
  }, input.now);
  const minimumStartOnPreferredDate = isLater ? nextGridAfterLastOfferedStart(activeTokens, preferredDate) : undefined;
  return {
    kind: isLater ? "later" : isNextDay ? "next_day" : "time_window",
    clientData: nextClientData,
    clientDataChanged: JSON.stringify(nextClientData) !== JSON.stringify(input.lead.clientData),
    offerOptions: {
      ...(afterMinutes !== undefined ? { minimumLocalStartMinutes: afterMinutes } : {}),
      ...(minimumStartOnPreferredDate ? { minimumStartOnPreferredDate } : {}),
      supersedeExisting: true,
    },
  };
}

function isSchedulingOnlyRecoveryMessage(message: string): boolean {
  const text = message.replace(/[?!.,;]+$/gu, "").trim();
  return [
    // Russian: these are the customer phrases supported by the typed recovery
    // contract. Keep every expression bounded from ^ to $ so appended facts
    // such as "вечером, две комнаты" never reach Calendar directly.
    /^(?:а\s+)?(?:позже|попозже)(?:\s+(?:нет\s+)?слотов)?$/u,
    /^(?:(?:а|а как насч[её]т|есть ли|будет ли)\s+)?после\s+(?:19(?::00)?|семи)(?:\s+(?:есть|слоты|есть\s+слоты))?$/u,
    /^(?:(?:а|а как насч[её]т|есть ли|будет ли)\s+)?(?:утром|вечером|в середине дня|ближе к обеду)(?:\s+есть)?$/u,
    /^(?:тогда\s+)?на\s+следующ(?:ий|его)\s+день(?:\s+(?:утром|вечером|в середине дня|ближе к обеду))?$/u,
    // Equivalent compact English and Serbian time-only asks remain safe. They
    // share the same typed active-offer precondition below.
    /^(?:what about\s+)?later(?:\s+(?:slots?|times?))?$/u,
    /^(?:(?:what about|is there|any)\s+)?after\s+(?:7|19(?::00)?)(?:\s*(?:pm))?$/u,
    /^(?:(?:what about|is there|any)\s+)?(?:morning|midday|afternoon|evening|near noon)(?:\s+available)?$/u,
    /^(?:then\s+)?next day(?:\s+(?:morning|midday|afternoon|evening|near noon))?$/u,
    /^(?:a\s+)?kasnije(?:\s+(?:termini|vreme))?$/u,
    /^(?:(?:a šta je sa|ima li|da li ima)\s+)?(?:ujutru|popodne|oko podne|uveče|uvece)(?:\s+ima)?$/u,
  ].some((pattern) => pattern.test(text));
}

function resolveAfterLocalMinutes(text: string): number | undefined {
  if (/(?:после\s+семи|после\s+19(?::00)?|after\s+(?:7|19(?::00)?)(?:\s*pm)?)/u.test(text)) return 19 * 60;
  return undefined;
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

function isStrictTimeWindowRequest(message: string): boolean {
  const text = message.normalize("NFKC").trim().toLocaleLowerCase().replace(/[!?.,]+/gu, " ").replace(/\s+/gu, " ").trim();
  // This is intentionally a whole-message recognizer. Natural short follow-up
  // questions may use a small conversational wrapper, but cleaning details
  // (for example, "вечером, 2 санузла") remain on the normal agent path.
  if (!text || /\d|\bm\s*²?\b|комнат|сануз|квадрат|kupatil|soba|bathroom|rooms?/iu.test(text)) return false;
  return [
    /^(?:(?:and|what about|how about|is there(?: anything)?(?: available)?|any(?:thing)?) )?(?:morning|noon|afternoon|evening|in the morning|at noon|in the afternoon|in the evening)$/u,
    /^(?:(?:а|а как насч[её]т|есть ли(?: что[- ]?то)?|будет ли(?: что[- ]?то)?) )?(?:утром|дн[её]м|в середине дня|вечером)(?: есть)?$/u,
    /^(?:(?:a|a šta je sa|ima li(?: nešto)?|da li ima(?: nešto)?) )?(?:ujutru|popodne|oko podne|uveče|uvece)(?: ima)?$/u,
    /^(?:(?:а|а шта је са|има ли(?: нешто)?|да ли има(?: нешто)?) )?(?:ујутру|поподне|око подне|увече)(?: има)?$/u,
  ].some((pattern) => pattern.test(text));
}

/**
 * Fast-path only a standalone request to see availability. Messages that
 * include booking/pricing details deliberately stay on the normal agent path
 * so data collection remains deterministic.
 */
function isStrictAvailabilityRequest(message: string): boolean {
  const text = message.normalize("NFKC").trim().toLocaleLowerCase().replace(/[!?.,]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!text || /\d|\bm\s*²?\b|комнат|сануз|квадрат|kupatil|soba|bathroom|rooms?/iu.test(text)) return false;
  return [
    // A brief "yes" is a natural acceptance of the immediately preceding
    // quote. Keep it in the backend-only path when the rest is an otherwise
    // standalone availability request, so a customer does not need to repeat
    // their booking details just to proceed.
    /^(?:(?:yes|sure),? )?(?:please )?(?:show|see|check|find|what are|any|available|free|nearest)(?: me)? (?:the )?(?:available |free |nearest )?(?:slots?|times?|availability)(?: again)?$/iu,
    /^(?:покажи|покажите|провер[ья]й|какие|есть|свободн(?:ое|ые)|ближайш(?:ее|ие))(?: мне)? (?:свободн(?:ое|ые) |ближайш(?:ее|ие) )?(?:слоты|время|термины)$/iu,
    /^(?:pokaži|pokazite|proveri|koji su|ima li|slobodn(?:i|e)|najbliži) (?:mi )?(?:slobodn(?:i|e) |najbliži )?(?:termin(?:i|e|a)?|slotovi|vreme)$/iu,
    /^(?:покажи|покажите|провери|који су|има ли|слободн(?:и|е)|најближи) (?:ми )?(?:слободн(?:и|е) |најближи )?(?:термин(?:и|е|а)?|слотови|време)$/iu,
  ].some((pattern) => pattern.test(text));
}

/** A clear scheduling request may use a natural phrase that is too rich for the fast path. */
function hasExplicitSchedulingIntent(message: string): boolean {
  const text = message.normalize("NFKC").toLocaleLowerCase();
  return /(?:\b(?:slot|slots|availability|available time|free time|show .*time|schedule|book(?:ing)?|term(?:in|ini|ine|ina)?|termin|slobodno vreme|zakaz)\b|время|термин|слот|заброн|расписан)/iu.test(text)
    || /(?:утром|дн[её]м|вечером|morning|midday|afternoon|evening|ujutru|popodne|uveče|увече|поподне)/iu.test(text);
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
