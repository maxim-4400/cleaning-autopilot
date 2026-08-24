import { z } from "zod";
import { randomUUID } from "node:crypto";

import type { AgentGateway } from "@/lib/agent/gateway";
import { CalendarReservationService } from "@/lib/calendar/reservation-service";
import { clientDataPatchSchema, humanNeededReasons, type AgentTurn, type AvailabilitySlot, type ClientData, type HumanNeededReason, type Quote } from "@/lib/contracts/domain";
import type { LeadRepository, StoredAgentConfig, StoredLead } from "@/lib/leads/repository";
import { calculatePricingDecision } from "@/lib/pricing/engine";
import { getEffectiveAgentConfig } from "@/lib/runtime-config/effective-agent-config";
import { TelegramDeliveryError, type TelegramGateway, type TelegramReplyMarkup } from "@/lib/telegram/gateway";
import {
  renderAgentReply,
  renderCalendarReservationFailedReply,
  renderHumanNeededReply,
  renderNewAddressDivider,
  renderNoAvailabilityReply,
  renderQuoteReply,
  renderBookingConfirmedReply,
  renderBookingManualReviewReply,
  renderReservationPendingReply,
  renderSlotOfferReply,
  renderStaleSlotReply,
  type TelegramRenderedReply,
} from "@/lib/telegram/renderer";
import { isReplyLanguageConfident, isRussianLanguage, isSerbianCyrillic, isSerbianLanguage, resolveReplyLanguage, type ReplyLanguage } from "@/lib/telegram/language";
import { TrelloSyncService } from "@/lib/trello/sync-service";
import { bookingConfirmationKey, TrelloRecoveryService } from "@/lib/trello/recovery-service";

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

    let lead = await dependencies.repository.findLeadByTelegramChatId(incomingMessage.chat.id);
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
    if (lead && selectedSlot !== undefined && dependencies.calendarReservation) {
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
    const now = turnNow;
    const weekendDate = weekendProposalDate(messageText, now);
    const relativePreferredDate = resolveRelativePreferredDate(messageText, now);
    const requestedTimeWindow = resolveTimeWindow(messageText);
    if (requestedTimeWindow && lead.clientData.preferredTimeWindow !== requestedTimeWindow) {
      lead.clientData = { ...lead.clientData, preferredTimeWindow: requestedTimeWindow };
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "time_window_requested", { window: requestedTimeWindow });
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
      const delivered = await deliverReply({ updateId: update.update_id, lead, reply: renderWeekendProposal(replyLanguage, weekendDate), dependencies });
      if (delivered !== "succeeded") { await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed"); return { kind: "failed", failureCode: "telegram_delivery_failed" }; }
      await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      return { kind: "processed" };
    }
    if (lead.pendingPreferredDate && lead.dateProposalExpiresAt && new Date(lead.dateProposalExpiresAt).getTime() > now.getTime() && isProposalConfirmation(messageText)) {
      const nextClientData = mergeClientData(lead.clientData, { preferredDate: lead.pendingPreferredDate }, now);
      if (pricingInputsChanged(lead.clientData, nextClientData)) supersedeQuote(lead, now);
      lead.clientData = nextClientData;
      clearDateProposal(lead);
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "date_proposal_confirmed", { preferred_date: nextClientData.preferredDate });
    } else if (lead.pendingPreferredDate && (isProposalDecline(messageText) || (lead.dateProposalExpiresAt && new Date(lead.dateProposalExpiresAt).getTime() <= now.getTime()))) {
      clearDateProposal(lead);
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "date_proposal_cleared");
    }
    config = await getEffectiveAgentConfig(config);

    // A time-window request is backend-owned scheduling intent. It always
    // creates a new bounded offer instead of re-labelling old earliest slots.
    if (requestedTimeWindow && dependencies.calendarReservation && lead.status === "qualified" && lead.quote && lead.quoteValidity === "active") {
      const offer = await dependencies.calendarReservation.offerSlots(lead, replyLanguage);
      const response = offer.ok
        ? renderSlotOfferReply(replyLanguage, offer.slots)
        : offer.error === "no_available_slots"
        ? renderNoAvailabilityReply(replyLanguage)
        : renderCalendarReservationFailedReply(replyLanguage);
      const delivered = await deliverReply({ updateId: update.update_id, lead, reply: response, dependencies });
      if (delivered !== "succeeded") { await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed"); return { kind: "failed", failureCode: "telegram_delivery_failed" }; }
      await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      return { kind: "processed" };
    }

    const initialTrelloSync = await syncTrelloLead(lead, dependencies);
    if (!initialTrelloSync.ok) {
      await recordTrelloSyncFailure(lead, initialTrelloSync, dependencies, replyLanguage);
    } else if (initialTrelloSync.terminalLifecycle) {
      const terminalReply = await deliverTerminalManualReply(update.update_id, lead, replyLanguage, dependencies);
      if (terminalReply.kind === "processed") await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      return terminalReply;
    }

    let conversation = await dependencies.repository.getConversation(lead.id);
    if (!conversation) {
      const idempotencyKey = `openai:conversation:${lead.id}`;
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
          await dependencies.repository.failIntegrationOperation(idempotencyKey, "openai_conversation_create_failed", "ambiguous");
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

    let quote: Quote | undefined;
    let humanNeededReason: HumanNeededReason | undefined;
    let calendarFailure = false;
    let noAvailableSlots = false;
    let offeredSlots: AvailabilitySlot[] | undefined;
    await sendTyping(dependencies.telegram, lead.telegramChatId);
    const agentTurnOperation = await dependencies.repository.createIntegrationOperation({
      leadId: lead.id,
      idempotencyKey: `openai:agent_turn:${lead.id}:${update.update_id}`,
      provider: "openai",
      operationType: "run_turn",
    });
    if (!agentTurnOperation.isNew && agentTurnOperation.status !== "succeeded") {
      lead.humanNeeded = true;
      lead.humanNeededReason = "conversation_ambiguous";
      await dependencies.repository.saveLead(lead);
      throw new Error("OpenAI agent turn requires manual recovery");
    }
    let turn: AgentTurn;
    try {
      turn = await dependencies.agent.runTurn({
      conversationId: conversation.openAiConversationId,
      systemPrompt: config.systemPrompt,
      replyLanguage,
      message: messageText,
      knownClientData: lead.clientData,
      executeTool: async (name, argumentsJson) => {
        if (name === "update_client_data") {
          const updateData = updateClientDataSchema.safeParse(argumentsJson);
          if (!updateData.success) return { ok: false, error: "invalid_client_data_patch" };
          const patch = clientDataPatchSchema.safeParse(dropNullValues(updateData.data.patch));
          if (!patch.success) return { ok: false, error: "invalid_client_data_patch" };
          const nextClientData = mergeClientData(lead.clientData, patch.data, now);
          if (pricingInputsChanged(lead.clientData, nextClientData)) supersedeQuote(lead, now);
          lead.clientData = nextClientData;
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
              humanNeededReason = "calendar_unavailable";
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
      await dependencies.repository.failIntegrationOperation(agentTurnOperation.idempotencyKey, "openai_agent_turn_failed", "ambiguous");
      throw error;
    }

    if (humanNeededReason) {
      lead.humanNeeded = true;
      lead.humanNeededReason = humanNeededReason;
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

    const currentTrelloSync = await syncTrelloLead(lead, dependencies);
    if (!currentTrelloSync.ok) {
      await recordTrelloSyncFailure(lead, currentTrelloSync, dependencies, replyLanguage);
    } else if (currentTrelloSync.terminalLifecycle) {
      // A human can move the card to Done/Lost while the agent turn is in
      // flight. That manual lifecycle is authoritative: do not deliver a
      // quote or slot offer, and never temporarily re-qualify the lead.
      const terminalReply = await deliverTerminalManualReply(update.update_id, lead, replyLanguage, dependencies);
      if (terminalReply.kind === "processed") await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
      return terminalReply;
    }

    // Lead completeness, not whether the model happened to call a pricing
    // tool, is authoritative. The model may persist a partial patch and then
    // emit generic prose; every non-terminal turn must still say exactly what
    // remains before a quote can be calculated.
    const deterministicMissingReply = !offeredSlots && !noAvailableSlots && !quote && !humanNeededReason
      ? missingDetailsReply(lead.clientData, config.pricingRules, replyLanguage, true)
      : undefined;
    const reply = offeredSlots
      ? renderSlotOfferReply(replyLanguage, offeredSlots)
      : noAvailableSlots
      ? renderNoAvailabilityReply(replyLanguage)
      : quote && !humanNeededReason
      ? renderQuoteReply(replyLanguage, quote.amountRsd)
      : humanNeededReason
      ? calendarFailure
        ? renderCalendarReservationFailedReply(replyLanguage)
        : renderHumanNeededReply(replyLanguage)
      : deterministicMissingReply
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
      }
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "telegram_delivery_failed", { outcome: deliveryOutcome });
      await dependencies.repository.markTelegramUpdateFailed(update.update_id, "telegram_delivery_failed");
      return { kind: "failed", failureCode: "telegram_delivery_failed" };
    }

    if (quote && !humanNeededReason) {
      lead.status = "qualified";
      await dependencies.repository.saveLead(lead);
      await dependencies.repository.appendActivity(lead.id, "quote_delivered", { amount_rsd: quote.amountRsd });
      const qualifiedTrelloSync = await syncTrelloLead(lead, dependencies);
      if (!qualifiedTrelloSync.ok) {
        await recordTrelloSyncFailure(lead, qualifiedTrelloSync, dependencies, replyLanguage);
      }
    }
    await dependencies.repository.markTelegramUpdateProcessed(update.update_id);
    return { kind: "processed" };
  } catch {
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
  const today = belgradeDate(now);
  const date = new Date(`${today}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const daysUntilSaturday = day === 6 ? 0 : (6 - day + 7) % 7;
  date.setUTCDate(date.getUTCDate() + daysUntilSaturday);
  return date.toISOString().slice(0, 10);
}

function isProposalConfirmation(message: string): boolean {
  return /^(?:yes|yeah|yep|да|ага|подходит|подойдет|može|moze|da|може|да)$/iu.test(message.trim());
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

function renderWeekendProposal(language: ReplyLanguage, date: string): TelegramRenderedReply {
  const formatted = new Intl.DateTimeFormat(isRussianLanguage(language) ? "ru-RU" : isSerbianLanguage(language) ? "sr-Latn-RS" : "en-GB", { timeZone: "Europe/Belgrade", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${date}T12:00:00.000Z`));
  if (isRussianLanguage(language)) return { text: `Ближайшая суббота, ${formatted}. Вам подойдет эта дата?` };
  if (isSerbianLanguage(language)) return { text: `Najbliža subota je ${formatted}. Da li vam odgovara?` };
  return { text: `The nearest Saturday is ${formatted}. Would that work for you?` };
}

function resolveTimeWindow(message: string): "morning" | "midday" | "evening" | undefined {
  const text = message.normalize("NFKC").toLocaleLowerCase();
  if (/(?:morning|утром|ujutru|ујутру)/u.test(text)) return "morning";
  if (/(?:midday|noon|afternoon|дн[её]м|в середине дня|popodne|oko podne|поподне|око подне)/u.test(text)) return "midday";
  if (/(?:evening|вечером|uveče|uvece|увече)/u.test(text)) return "evening";
  return undefined;
}

function missingDetailsReply(data: ClientData, pricingRules: StoredAgentConfig["pricingRules"], language: ReplyLanguage, didSaveData: boolean): TelegramRenderedReply | undefined {
  const decision = calculatePricingDecision(data, pricingRules);
  if (decision.kind !== "missing_data") return undefined;
  const fields = decision.missingFields.map((field) => missingFieldLabel(field, language));
  const requested = joinNatural(fields, language);
  if (isRussianLanguage(language)) return { text: `${didSaveData ? "Спасибо, я это отметил. " : ""}Ещё нужны ${requested}.` };
  if (isSerbianLanguage(language)) return { text: serbianMissingDetails(language, didSaveData, requested) };
  return { text: `${didSaveData ? "Thanks, I’ve noted that. " : ""}I still need ${requested}.` };
}

function missingFieldLabel(field: string, language: ReplyLanguage): string {
  const ru: Record<string, string> = { cleaningType: "тип уборки", areaM2: "площадь в м²", rooms: "количество комнат", bathrooms: "количество санузлов", addressOrDistrict: "адрес или район", preferredDate: "подходящая дата", heavyPetHair: "есть ли сильная шерсть животных", extras: "нужны ли дополнительные услуги" };
  const srLatin: Record<string, string> = { cleaningType: "vrsta čišćenja", areaM2: "površina u m²", rooms: "broj soba", bathrooms: "broj kupatila", addressOrDistrict: "adresa ili kraj", preferredDate: "željeni datum", heavyPetHair: "da li ima mnogo dlaka kućnih ljubimaca", extras: "dodatne usluge" };
  const srCyrl: Record<string, string> = { cleaningType: "врста чишћења", areaM2: "површина у м²", rooms: "број соба", bathrooms: "број купатила", addressOrDistrict: "адреса или крај", preferredDate: "жељени датум", heavyPetHair: "да ли има много длака кућних љубимаца", extras: "додатне услуге" };
  const en: Record<string, string> = { cleaningType: "the cleaning type", areaM2: "the area in m²", rooms: "the number of rooms", bathrooms: "the number of bathrooms", addressOrDistrict: "the address or district", preferredDate: "a preferred date", heavyPetHair: "whether there is heavy pet hair", extras: "any extra services" };
  return (isRussianLanguage(language) ? ru : isSerbianCyrillic(language) ? srCyrl : isSerbianLanguage(language) ? srLatin : en)[field] ?? field;
}

function joinNatural(values: string[], language: ReplyLanguage): string {
  if (values.length <= 1) return values[0] ?? "details";
  const conjunction = isRussianLanguage(language) ? "и" : isSerbianLanguage(language) ? "i" : "and";
  return values.length === 2 ? `${values[0]} ${conjunction} ${values[1]}` : `${values.slice(0, -1).join(", ")} ${conjunction} ${values.at(-1)}`;
}

function serbianMissingDetails(language: ReplyLanguage, didSaveData: boolean, requested: string): string {
  if (isSerbianCyrillic(language)) return `${didSaveData ? "Хвала, забележио сам то. " : ""}Још су ми потребни ${requested}.`;
  return `${didSaveData ? "Hvala, zabeležio sam to. " : ""}Još su mi potrebni ${requested}.`;
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

  const preCalendarTrelloSync = input.dependencies.trelloSync
    ? await input.dependencies.trelloSync.syncLead(input.lead, "qualified")
    : undefined;
  if (preCalendarTrelloSync?.ok && preCalendarTrelloSync.terminalLifecycle) {
    return deliverTerminalManualReply(input.updateId, input.lead, input.replyLanguage, input.dependencies);
  }
  if (preCalendarTrelloSync && !preCalendarTrelloSync.ok) {
    await recordTrelloSyncFailure(input.lead, preCalendarTrelloSync, input.dependencies, input.replyLanguage);
  }

  const reservation = await input.dependencies.calendarReservation.reserveSlot(input.lead, selectedSlot.token, input.replyLanguage);
  if (!reservation.ok) {
    if (isStaleSlotReservationError(reservation.error)) return "stale";
    input.lead.humanNeeded = true;
    input.lead.humanNeededReason = reservation.ambiguous ? "calendar_ambiguous" : "calendar_unavailable";
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
  if (!input.dependencies.trelloSync) {
    const pendingDelivery = await deliverReply({
      updateId: input.updateId,
      lead: input.lead,
      reply: renderReservationPendingReply(input.replyLanguage),
      kind: "reservation_pending",
      dependencies: input.dependencies,
    });
    if (pendingDelivery === "succeeded") return { kind: "processed" };
    await markReservationDeliveryFailure(input.lead, pendingDelivery, input.dependencies);
    return { kind: "failed", failureCode: "telegram_delivery_failed" };
  }
  if (input.lead.humanNeededReason === "trello_unavailable" || input.lead.humanNeededReason === "trello_ambiguous") {
    input.lead.humanNeeded = false;
    input.lead.humanNeededReason = undefined;
    await input.dependencies.repository.saveLead(input.lead);
  }
  const trelloResult = await input.dependencies.trelloSync.syncLead(input.lead, "booked");
  if (!trelloResult.ok) {
    await markTrelloNeeded(input.lead, trelloResult, input.dependencies);
    await input.dependencies.repository.accelerateTrelloSyncJob({ leadId: input.lead.id, now: (input.now ?? input.dependencies.now?.() ?? new Date()).toISOString(), replyLanguage: input.replyLanguage });
    const pendingDelivery = await deliverReply({
      updateId: input.updateId,
      lead: input.lead,
      reply: renderReservationPendingReply(input.replyLanguage),
      kind: "reservation_pending",
      dependencies: input.dependencies,
    });
    if (pendingDelivery === "succeeded") return { kind: "failed", failureCode: "trello_pending_recovery" };
    await markReservationDeliveryFailure(input.lead, pendingDelivery, input.dependencies);
    return { kind: "failed", failureCode: "telegram_delivery_failed" };
  }

  if (trelloResult.terminalLifecycle) {
    input.lead.status = trelloResult.terminalLifecycle;
    input.lead.humanNeeded = true;
    input.lead.humanNeededReason = "trello_terminal";
    await input.dependencies.repository.saveLead(input.lead);
    await input.dependencies.repository.appendActivity(input.lead.id, "booking_preserved_trello_terminal", {
      trello_card_id: trelloResult.cardId,
      lifecycle: trelloResult.terminalLifecycle,
    });
    const pendingDelivery = await deliverReply({
      updateId: input.updateId,
      lead: input.lead,
      reply: renderReservationPendingReply(input.replyLanguage),
      kind: "reservation_pending",
      dependencies: input.dependencies,
    });
    if (pendingDelivery === "succeeded") return { kind: "processed" };
    await markReservationDeliveryFailure(input.lead, pendingDelivery, input.dependencies);
    return { kind: "failed", failureCode: "telegram_delivery_failed" };
  }

  if (!input.lead.assignedTeam || !input.lead.bookedStart || !input.lead.quote) {
    input.lead.humanNeeded = true;
    input.lead.humanNeededReason = "missing_required_data";
    await input.dependencies.repository.saveLead(input.lead);
    await input.dependencies.repository.appendActivity(input.lead.id, "booking_confirmation_data_missing");
    const manualDelivery = await deliverReply({
      updateId: input.updateId,
      lead: input.lead,
      reply: renderBookingManualReviewReply(input.replyLanguage),
      kind: "reservation_manual",
      dependencies: input.dependencies,
    });
    if (manualDelivery === "succeeded") return { kind: "failed", failureCode: "booking_confirmation_data_missing" };
    await markReservationDeliveryFailure(input.lead, manualDelivery, input.dependencies);
    return { kind: "failed", failureCode: "telegram_delivery_failed" };
  }

  input.lead.status = "booked";
  await input.dependencies.repository.saveLead(input.lead);
  await input.dependencies.repository.appendActivity(input.lead.id, "booking_confirmed", { trello_card_id: trelloResult.cardId });
  const delivered = await deliverReply({
    updateId: input.updateId,
    lead: input.lead,
    reply: renderBookingConfirmedReply({
      language: input.replyLanguage,
      team: input.lead.assignedTeam,
      start: input.lead.bookedStart,
      quoteAmountRsd: input.lead.quote.amountRsd,
    }),
    kind: "booking_confirmed",
    idempotencyKey: bookingConfirmationKey(input.lead),
    dependencies: input.dependencies,
  });
  if (delivered !== "succeeded") {
    await markReservationDeliveryFailure(input.lead, delivered, input.dependencies);
    return { kind: "failed", failureCode: "telegram_delivery_failed" };
  }
  return { kind: "processed" };
}

async function syncTrelloLead(
  lead: StoredLead,
  dependencies: Stage2Dependencies,
): Promise<{ ok: true; cardId: string; terminalLifecycle?: "done" | "lost" } | { ok: false; code: string; ambiguous: boolean }> {
  if (!dependencies.trelloSync) return { ok: true, cardId: lead.trelloCardId ?? "not-configured-for-legacy-dependency" };
  if (lead.status !== "new_lead" && lead.status !== "qualified" && lead.status !== "booked") {
    return { ok: true, cardId: lead.trelloCardId ?? "not-syncable" };
  }
  return dependencies.trelloSync.syncLead(lead, lead.status);
}

async function markTrelloNeeded(
  lead: StoredLead,
  result: { ok: false; code: string; ambiguous: boolean },
  dependencies: Stage2Dependencies,
): Promise<void> {
  await dependencies.repository.appendActivity(lead.id, "trello_sync_failed", { error_code: result.code, ambiguous: result.ambiguous });
  // The persistent outbox escalates to Human Needed after 15 minutes; doing
  // it immediately would present a transient provider failure as a manual
  // customer case and makes the label race the recovery sync.
}

async function recordTrelloSyncFailure(inputLead: StoredLead,
  result: { ok: false; code: string; ambiguous: boolean },
  dependencies: Stage2Dependencies,
  replyLanguage: ReplyLanguage,
): Promise<void> {
  await dependencies.repository.appendActivity(inputLead.id, "trello_sync_failed", { error_code: result.code, ambiguous: result.ambiguous });
  if ((inputLead.status === "qualified" || inputLead.status === "booked") && dependencies.trelloRecovery) {
    await dependencies.trelloRecovery.enqueueLeadRecovery({
      lead: inputLead,
      desiredLifecycle: inputLead.status,
      replyLanguage,
    });
  }
}

async function deliverTerminalManualReply(
  updateId: number,
  lead: StoredLead,
  replyLanguage: ReplyLanguage,
  dependencies: Stage2Dependencies,
): Promise<TelegramWebhookResult> {
  const delivered = await deliverReply({
    updateId,
    lead,
    reply: renderBookingManualReviewReply(replyLanguage),
    kind: "reservation_manual",
    dependencies,
  });
  if (delivered === "succeeded") return { kind: "processed" };
  await dependencies.repository.markTelegramUpdateFailed(updateId, "telegram_delivery_failed");
  return { kind: "failed", failureCode: "telegram_delivery_failed" };
}

async function markReservationDeliveryFailure(
  lead: StoredLead,
  outcome: "failed" | "ambiguous",
  dependencies: Stage2Dependencies,
): Promise<void> {
  lead.humanNeeded = true;
  lead.humanNeededReason = outcome === "ambiguous" ? "delivery_ambiguous" : "delivery_failed";
  await dependencies.repository.saveLead(lead);
  await dependencies.repository.appendActivity(lead.id, "calendar_reservation_delivery_failed", { outcome });
}

function parseSlotSelection(message: string): { index: number; replyLanguage: ReplyLanguage } | undefined {
  const normalized = message.trim().toLowerCase();
  if (/^(?:1|one|first|option 1)$/.test(normalized)) return { index: 0, replyLanguage: "en" };
  if (/^(?:2|two|second|option 2)$/.test(normalized)) return { index: 1, replyLanguage: "en" };
  if (/^(?:3|three|third|option 3)$/.test(normalized)) return { index: 2, replyLanguage: "en" };
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
  if (!data.preferredDate || !isValidIsoDate(data.preferredDate)) return data;
  return {
    ...data,
    // The date is the only source of truth. This also repairs older leads
    // whose model patch left urgency empty and overwrites an outdated value
    // whenever the customer changes the requested date.
    urgency: data.preferredDate === belgradeDate(now) ? "same_day" : "standard",
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
    !lead.humanNeeded;
}

function pricingInputsChanged(current: ClientData, next: ClientData): boolean {
  return current.cleaningType !== next.cleaningType ||
    current.areaM2 !== next.areaM2 ||
    current.bathrooms !== next.bathrooms ||
    current.heavyPetHair !== next.heavyPetHair ||
    current.urgency !== next.urgency ||
    !sameExtras(current.extras, next.extras);
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
}

function dropNullValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null));
}
