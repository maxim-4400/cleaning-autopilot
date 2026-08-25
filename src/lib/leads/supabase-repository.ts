import "server-only";

import {
  clientDataSchema,
  humanNeededReasons,
  integrationOperationStatuses,
  leadStatuses,
  pricingRulesSchema,
  quoteSchema,
  type Quote,
} from "@/lib/contracts/domain";
import type {
  LeadRepository,
  StoredAgentConfig,
  StoredCalendarSlotToken,
  StoredConversation,
  StoredIntegrationOperation,
  StoredLead,
  StoredTrelloSyncJob,
  TelegramUpdateClaim,
  TelegramUpdateRecord,
} from "@/lib/leads/repository";

type SupabaseEnvironment = { url: string; secretKey: string };
const telegramUpdateLeaseSeconds = 300;

export class SupabaseLeadRepository implements LeadRepository {
  constructor(private readonly environment: SupabaseEnvironment) {}

  async claimTelegramUpdate(update: TelegramUpdateRecord): Promise<TelegramUpdateClaim> {
    const rows = await this.callRpc("claim_telegram_update", {
      p_update_id: update.updateId,
      p_telegram_chat_id: update.telegramChatId ?? null,
      p_telegram_message_id: update.telegramMessageId ?? null,
      p_payload: update.payload,
      p_lease_seconds: telegramUpdateLeaseSeconds,
    }, "claim Telegram update");
    const claimStatus = rows[0]?.claim_status;
    if (claimStatus === "claimed" || claimStatus === "duplicate" || claimStatus === "in_progress") return claimStatus;
    throw new Error("claim Telegram update returned an invalid status");
  }

  async releaseTelegramChatLease(telegramChatId: number, updateId: number): Promise<void> {
    await this.callRpc("release_telegram_chat_lease", {
      p_telegram_chat_id: telegramChatId,
      p_update_id: updateId,
    }, "release Telegram chat lease");
  }

  async markTelegramUpdateProcessed(updateId: number): Promise<void> {
    await this.patchOne(
      `telegram_updates?update_id=eq.${updateId}`,
      {
        processing_status: "processed",
        processed_at: new Date().toISOString(),
        processing_lease_expires_at: null,
        failure_code: null,
      },
      "mark Telegram update processed",
    );
  }

  async markTelegramUpdateFailed(updateId: number, failureCode: string): Promise<void> {
    await this.patchOne(
      `telegram_updates?update_id=eq.${updateId}`,
      { processing_status: "failed", processing_lease_expires_at: null, failure_code: failureCode },
      "mark Telegram update failed",
    );
  }

  async findLeadByTelegramChatId(telegramChatId: number): Promise<StoredLead | null> {
    const rows = await this.getRows(`leads?telegram_chat_id=eq.${telegramChatId}&active_in_chat=is.true&select=*`);
    return rows[0] ? mapLead(rows[0]) : null;
  }

  async findLeadById(leadId: string): Promise<StoredLead | null> {
    const rows = await this.getRows(`leads?id=eq.${encodeURIComponent(leadId)}&select=*`);
    return rows[0] ? mapLead(rows[0]) : null;
  }

  async createLead(input: Pick<StoredLead, "telegramChatId" | "firstMessageLanguage" | "agentConfigVersion" | "telegramUserId" | "customerDisplayName" | "telegramUsername">): Promise<StoredLead> {
    const rows = await this.postRows("leads", {
      telegram_chat_id: input.telegramChatId,
      active_in_chat: true,
      first_message_language: input.firstMessageLanguage,
      agent_config_version: input.agentConfigVersion,
      telegram_user_id: input.telegramUserId ?? null,
      customer_display_name: input.customerDisplayName ?? null,
      telegram_username: input.telegramUsername ?? null,
    });
    return mapLead(rows[0]);
  }

  async startNewAddressLead(input: { telegramChatId: number; firstMessageLanguage: string; agentConfigVersion: number; telegramUserId?: number; customerDisplayName?: string; telegramUsername?: string }): Promise<StoredLead> {
    const rows = await this.callRpc("start_new_address_lead", {
      p_telegram_chat_id: input.telegramChatId,
      p_first_message_language: input.firstMessageLanguage,
      p_agent_config_version: input.agentConfigVersion,
    }, "start new address lead");
    if (rows.length !== 1) throw new Error("start new address lead returned an invalid row count");
    const lead = mapLead(rows[0]);
    // The existing boundary RPC intentionally remains backward compatible.
    // Contact metadata is additive and is persisted separately after the new row exists.
    if (input.telegramUserId || input.customerDisplayName || input.telegramUsername) {
      lead.telegramUserId = input.telegramUserId;
      lead.customerDisplayName = input.customerDisplayName;
      lead.telegramUsername = input.telegramUsername;
      await this.saveLead(lead);
    }
    return lead;
  }

  async saveLead(lead: StoredLead): Promise<void> {
    const payload = {
      client_data: lead.clientData,
      first_message_language: lead.firstMessageLanguage,
      status: lead.status,
      agent_config_version: lead.agentConfigVersion,
      quoted_price_rsd: lead.quote?.amountRsd ?? null,
      quoted_at: lead.quotedAt ?? null,
      quote_details: lead.quote ?? null,
      quote_validity: lead.quote ? lead.quoteValidity ?? "active" : null,
      quote_invalidated_at: lead.quoteInvalidatedAt ?? null,
      pricing_rules_snapshot: lead.pricingRulesSnapshot ?? null,
      human_needed: lead.humanNeeded,
      human_needed_reason: lead.humanNeededReason ?? null,
      assigned_team: lead.assignedTeam ?? null,
      booked_start: lead.bookedStart ?? null,
      booked_end: lead.bookedEnd ?? null,
      calendar_event_id: lead.calendarEventId ?? null,
      trello_card_id: lead.trelloCardId ?? null,
      trello_card_url: lead.trelloCardUrl ?? null,
      telegram_user_id: lead.telegramUserId ?? null,
      customer_display_name: lead.customerDisplayName ?? null,
      telegram_username: lead.telegramUsername ?? null,
      pending_preferred_date: lead.pendingPreferredDate ?? null,
      date_proposal_expires_at: lead.dateProposalExpiresAt ?? null,
      date_proposal_version: lead.dateProposalVersion ?? null,
      date_proposal_locale: lead.dateProposalLocale ?? null,
    };
    await this.patchOne(`leads?id=eq.${encodeURIComponent(lead.id)}`, payload, "save lead");
  }

  async persistCalendarReservationWithTrelloJob(input: { lead: StoredLead; replyLanguage: "en" | "ru" | "sr-Latn" | "sr-Cyrl" }): Promise<void> {
    if (!input.lead.calendarEventId || !input.lead.assignedTeam || !input.lead.bookedStart || !input.lead.bookedEnd) {
      throw new Error("Calendar reservation is incomplete");
    }
    const rows = await this.callRpc("persist_calendar_reservation_with_trello_job", {
      p_lead_id: input.lead.id,
      p_assigned_team: input.lead.assignedTeam,
      p_booked_start: input.lead.bookedStart,
      p_booked_end: input.lead.bookedEnd,
      p_calendar_event_id: input.lead.calendarEventId,
      p_reply_language: input.replyLanguage,
      p_confirmation_key: `telegram:booking_confirmed:${input.lead.id}:${input.lead.calendarEventId}`,
    }, "persist Calendar reservation with Trello job");
    if (rows.length !== 1) throw new Error("persist Calendar reservation with Trello job affected an invalid row count");
  }

  async getConversation(leadId: string): Promise<StoredConversation | null> {
    const rows = await this.getRows(`conversations?lead_id=eq.${encodeURIComponent(leadId)}&select=*`);
    return rows[0] ? mapConversation(rows[0]) : null;
  }

  async saveConversation(conversation: StoredConversation): Promise<void> {
    await this.postRows("conversations", {
      lead_id: conversation.leadId,
      telegram_chat_id: conversation.telegramChatId,
      openai_conversation_id: conversation.openAiConversationId,
    });
  }

  async invalidateConversation(leadId: string): Promise<void> {
    const rows = await this.expectRows(await this.request(`conversations?lead_id=eq.${encodeURIComponent(leadId)}`, { method: "DELETE" }), "invalidate conversation");
    if (rows.length > 1) throw new Error("invalidate conversation affected an invalid row count");
  }

  async getCurrentAgentConfig(): Promise<StoredAgentConfig> {
    const rows = await this.getRows("agent_config?select=*&order=version.desc&limit=1");
    if (!rows[0]) throw new Error("No agent configuration exists");
    return mapAgentConfig(rows[0]);
  }

  async getAgentConfig(version: number): Promise<StoredAgentConfig> {
    const rows = await this.getRows(`agent_config?version=eq.${version}&select=*&limit=1`);
    if (!rows[0]) throw new Error(`Agent configuration version ${version} does not exist`);
    return mapAgentConfig(rows[0]);
  }

  async appendActivity(leadId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.postRows("activity_log", { lead_id: leadId, event_type: eventType, payload });
  }

  async createIntegrationOperation(input: {
    leadId: string;
    idempotencyKey: string;
    provider: "telegram" | "openai" | "google_calendar" | "trello";
    operationType: string;
  }): Promise<StoredIntegrationOperation> {
    const response = await this.request("integration_operations", {
      method: "POST",
      body: JSON.stringify({
        lead_id: input.leadId,
        idempotency_key: input.idempotencyKey,
        provider: input.provider,
        operation_type: input.operationType,
        attempt_count: 1,
      }),
    });

    if (response.status === 409) {
      const rows = await this.getRows(
        `integration_operations?idempotency_key=eq.${encodeURIComponent(input.idempotencyKey)}&select=*`,
      );
      if (!rows[0]) throw new Error("Conflicting integration operation could not be read");
      const existing = mapOperation(rows[0]);
      const retryableDesiredState = input.provider === "trello" && isTrelloDesiredStateOperation(input.operationType) &&
        (existing.status === "failed" || existing.status === "succeeded");
      const retryableBookingDelivery = input.provider === "telegram" && input.operationType === "send_message" &&
        input.idempotencyKey.startsWith("telegram:booking_confirmed:") && existing.status === "failed";
      const retryableAgentTurn = input.provider === "openai" && input.operationType === "run_turn" && existing.status === "failed";
      if (((existing.status !== "failed" || input.provider === "google_calendar") && !retryableBookingDelivery && !retryableAgentTurn) && !retryableDesiredState) {
        return { ...existing, isNew: false };
      }

      const retried = await this.expectRows(await this.request(
        `integration_operations?provider=eq.${encodeURIComponent(input.provider)}&operation_type=eq.${encodeURIComponent(input.operationType)}&idempotency_key=eq.${encodeURIComponent(input.idempotencyKey)}&status=eq.${existing.status}`,
        { method: "PATCH", body: JSON.stringify({ status: "pending", last_error_code: null }) },
      ), "retry failed integration operation");
      if (retried.length === 1) return { ...mapOperation(retried[0]), isNew: true };

      const currentRows = await this.getRows(
        `integration_operations?provider=eq.${encodeURIComponent(input.provider)}&operation_type=eq.${encodeURIComponent(input.operationType)}&idempotency_key=eq.${encodeURIComponent(input.idempotencyKey)}&select=*`,
      );
      if (!currentRows[0]) throw new Error("Conflicting integration operation could not be re-read");
      return { ...mapOperation(currentRows[0]), isNew: false };
    }

    return { ...mapOperation((await this.expectRows(response, "create integration operation"))[0]), isNew: true };
  }

  async getIntegrationOperation(idempotencyKey: string): Promise<StoredIntegrationOperation | null> {
    const rows = await this.getRows(
      `integration_operations?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=*`,
    );
    return rows[0] ? { ...mapOperation(rows[0]), isNew: false } : null;
  }

  async completeIntegrationOperation(idempotencyKey: string, externalId?: string): Promise<void> {
    await this.patchOne(
      `integration_operations?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`,
      { status: "succeeded", external_id: externalId ?? null, last_error_code: null },
      "complete integration operation",
    );
  }

  async failIntegrationOperation(
    idempotencyKey: string,
    errorCode: string,
    status: "failed" | "ambiguous" = "failed",
  ): Promise<void> {
    await this.patchOne(
      `integration_operations?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`,
      { status, last_error_code: errorCode },
      "fail integration operation",
    );
  }

  async saveCalendarSlotOffer(input: { leadId: string; offerId: string; issuedAt: string; tokens: StoredCalendarSlotToken[] }): Promise<void> {
    await this.callRpc("replace_calendar_slot_offer", {
      p_lead_id: input.leadId,
      p_offer_id: input.offerId,
      p_now: input.issuedAt,
      p_slots: input.tokens.map((token) => ({
        token: token.token,
        team: token.team,
        starts_at: token.start,
        ends_at: token.end,
        buffer_ends_at: token.bufferEnd,
        expires_at: token.expiresAt,
        schedule_fingerprint: token.scheduleFingerprint,
        display_order: token.displayOrder,
      })),
    }, "replace calendar slot offer");
  }

  async listActiveCalendarSlotTokens(input: { leadId: string; now: string }): Promise<StoredCalendarSlotToken[]> {
    const rows = await this.getRows(
      `calendar_slot_tokens?lead_id=eq.${encodeURIComponent(input.leadId)}&consumed_at=is.null&superseded_at=is.null&expires_at=gt.${encodeURIComponent(input.now)}&order=display_order.asc&select=*`,
    );
    return rows.map(mapCalendarSlotToken);
  }

  async consumeCalendarSlotToken(input: { token: string; leadId: string; now: string }): Promise<StoredCalendarSlotToken | null> {
    const rows = await this.callRpc("consume_calendar_slot_token", {
      p_token: input.token,
      p_lead_id: input.leadId,
      p_now: input.now,
    }, "consume calendar slot token");
    return rows[0] ? mapCalendarSlotToken(rows[0]) : null;
  }

  async getCalendarSlotToken(input: { token: string; leadId: string }): Promise<StoredCalendarSlotToken | null> {
    const rows = await this.getRows(
      `calendar_slot_tokens?token=eq.${encodeURIComponent(input.token)}&lead_id=eq.${encodeURIComponent(input.leadId)}&select=*`,
    );
    return rows[0] ? mapCalendarSlotToken(rows[0]) : null;
  }

  async enqueueTrelloSyncJob(input: Omit<StoredTrelloSyncJob, "state" | "createdAt" | "attemptCount" | "humanNeededEscalated" | "nextAttemptAt" | "lastErrorCode" | "leaseToken" | "leaseExpiresAt"> & { now: string }): Promise<void> {
    await this.callRpc("enqueue_trello_sync_job", {
      p_lead_id: input.leadId,
      p_desired_lifecycle: input.desiredLifecycle,
      p_reply_language: input.replyLanguage,
      p_confirmation_key: input.confirmationKey ?? null,
      p_now: input.now,
    }, "enqueue Trello sync job");
  }

  async accelerateTrelloSyncJob(input: { leadId: string; now: string; replyLanguage: "en" | "ru" | "sr-Latn" | "sr-Cyrl" }): Promise<void> {
    const rows = await this.callRpc("accelerate_trello_sync_job", { p_lead_id: input.leadId, p_now: input.now, p_reply_language: input.replyLanguage }, "accelerate Trello sync job");
    if (rows.length !== 1) throw new Error("accelerate Trello sync job affected an invalid row count");
  }

  async claimDueTrelloSyncJobs(input: { now: string; limit: number; leaseToken: string; leaseSeconds: number }): Promise<StoredTrelloSyncJob[]> {
    const rows = await this.callRpc("claim_due_trello_sync_jobs", {
      p_now: input.now,
      p_limit: input.limit,
      p_lease_token: input.leaseToken,
      p_lease_seconds: input.leaseSeconds,
    }, "claim due Trello sync jobs");
    return rows.map(mapTrelloSyncJob);
  }

  async completeTrelloSyncJob(input: { leadId: string; leaseToken: string }): Promise<void> {
    const rows = await this.callRpc("complete_trello_sync_job", { p_lead_id: input.leadId, p_lease_token: input.leaseToken }, "complete Trello sync job");
    if (rows.length !== 1) throw new Error("complete Trello sync job lost its lease");
  }

  async acknowledgeTrelloSyncJobEscalation(input: { leadId: string; leaseToken: string }): Promise<void> {
    const rows = await this.callRpc("acknowledge_trello_sync_job_escalation", { p_lead_id: input.leadId, p_lease_token: input.leaseToken }, "acknowledge Trello sync job escalation");
    if (rows.length !== 1) throw new Error("acknowledge Trello sync job escalation lost its lease");
  }

  async rescheduleTrelloSyncJob(input: { leadId: string; leaseToken: string; state: Exclude<import("@/lib/leads/repository").TrelloSyncJobState, "done">; nextAttemptAt: string; lastErrorCode: string }): Promise<void> {
    const rows = await this.callRpc("reschedule_trello_sync_job", {
      p_lead_id: input.leadId,
      p_lease_token: input.leaseToken,
      p_state: input.state,
      p_next_attempt_at: input.nextAttemptAt,
      p_last_error_code: input.lastErrorCode,
    }, "reschedule Trello sync job");
    if (rows.length !== 1) throw new Error("reschedule Trello sync job lost its lease");
  }

  private async getRows(path: string): Promise<Record<string, unknown>[]> {
    return this.expectRows(await this.request(path), `read ${path}`);
  }

  private async postRows(table: string, body: Record<string, unknown> | Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    return this.expectRows(await this.request(table, { method: "POST", body: JSON.stringify(body) }), `insert ${table}`);
  }

  private async callRpc(
    functionName: string,
    body: Record<string, unknown>,
    operation: string,
  ): Promise<Record<string, unknown>[]> {
    return this.expectRows(await this.request(`rpc/${functionName}`, { method: "POST", body: JSON.stringify(body) }), operation);
  }

  private async patchOne(path: string, body: Record<string, unknown>, operation: string): Promise<void> {
    const rows = await this.expectRows(await this.request(path, { method: "PATCH", body: JSON.stringify(body) }), operation);
    if (rows.length !== 1) throw new Error(`${operation} affected ${rows.length} rows`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.environment.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.environment.secretKey,
        authorization: `Bearer ${this.environment.secretKey}`,
        "content-type": "application/json",
        prefer: "return=representation",
        ...init.headers,
      },
    });
  }

  private async expectRows(response: Response, operation: string): Promise<Record<string, unknown>[]> {
    await this.expectOk(response, operation);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || !payload.every(isRecord)) throw new Error(`${operation} returned an invalid payload`);
    return payload;
  }

  private async expectOk(response: Response, operation: string): Promise<void> {
    if (response.ok) return;
    throw new Error(`${operation} failed with HTTP ${response.status}`);
  }
}

function mapLead(row: Record<string, unknown>): StoredLead {
  const telegramChatId = parseChatId(row.telegram_chat_id);
  const parsedClientData = clientDataSchema.safeParse(row.client_data);
  if (
    typeof row.id !== "string" || telegramChatId === null ||
    typeof row.first_message_language !== "string" || typeof row.business_reference !== "string" || row.business_reference.length === 0 || !isEnumValue(leadStatuses, row.status) ||
    !parsedClientData.success || typeof row.agent_config_version !== "number" ||
    typeof row.human_needed !== "boolean"
  ) {
    throw new Error("Invalid lead row");
  }

  const quote = quoteFromRow(row);
  const quoteValidity = quote
    ? row.quote_validity === "superseded" ? "superseded" : "active"
    : undefined;

  return {
    id: row.id,
    telegramChatId,
    telegramUserId: parseOptionalChatId(row.telegram_user_id),
    customerDisplayName: parseOptionalText(row.customer_display_name),
    telegramUsername: parseOptionalUsername(row.telegram_username),
    pendingPreferredDate: typeof row.pending_preferred_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.pending_preferred_date) ? row.pending_preferred_date : undefined,
    dateProposalExpiresAt: typeof row.date_proposal_expires_at === "string" ? row.date_proposal_expires_at : undefined,
    dateProposalVersion: typeof row.date_proposal_version === "string" && /^[A-Za-z0-9_-]{12,80}$/.test(row.date_proposal_version) ? row.date_proposal_version : undefined,
    dateProposalLocale: row.date_proposal_locale === "en" || row.date_proposal_locale === "ru" || row.date_proposal_locale === "sr-Latn" || row.date_proposal_locale === "sr-Cyrl" ? row.date_proposal_locale : undefined,
    activeInChat: row.active_in_chat === true,
    firstMessageLanguage: row.first_message_language,
    businessReference: row.business_reference,
    status: row.status,
    clientData: parsedClientData.data,
    agentConfigVersion: row.agent_config_version,
    quote,
    quoteValidity,
    quoteInvalidatedAt: quoteValidity === "superseded" && typeof row.quote_invalidated_at === "string"
      ? row.quote_invalidated_at
      : undefined,
    quotedAt: typeof row.quoted_at === "string" ? row.quoted_at : undefined,
    pricingRulesSnapshot: pricingRulesFromRow(row),
    humanNeeded: row.human_needed,
    humanNeededReason: isEnumValue(humanNeededReasons, row.human_needed_reason) ? row.human_needed_reason : undefined,
    assignedTeam: row.assigned_team === "team_a" || row.assigned_team === "team_b" ? row.assigned_team : undefined,
    bookedStart: typeof row.booked_start === "string" ? row.booked_start : undefined,
    bookedEnd: typeof row.booked_end === "string" ? row.booked_end : undefined,
    calendarEventId: typeof row.calendar_event_id === "string" ? row.calendar_event_id : undefined,
    trelloCardId: typeof row.trello_card_id === "string" ? row.trello_card_id : undefined,
    trelloCardUrl: typeof row.trello_card_url === "string" ? row.trello_card_url : undefined,
  };
}

function parseOptionalChatId(value: unknown): number | undefined {
  const parsed = parseChatId(value);
  return parsed === null ? undefined : parsed;
}

function parseOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseOptionalUsername(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_]{5,32}$/.test(value) ? value : undefined;
}

function mapCalendarSlotToken(row: Record<string, unknown>): StoredCalendarSlotToken {
  if (
    typeof row.token !== "string" || typeof row.lead_id !== "string" ||
    (row.team !== "team_a" && row.team !== "team_b") ||
    typeof row.starts_at !== "string" || typeof row.ends_at !== "string" ||
    typeof row.buffer_ends_at !== "string" || typeof row.expires_at !== "string" ||
    typeof row.schedule_fingerprint !== "string" || typeof row.offer_id !== "string" ||
    typeof row.display_order !== "number"
  ) throw new Error("Invalid calendar slot token row");
  return {
    token: row.token,
    leadId: row.lead_id,
    offerId: row.offer_id,
    displayOrder: row.display_order,
    team: row.team,
    start: row.starts_at,
    end: row.ends_at,
    bufferEnd: row.buffer_ends_at,
    expiresAt: row.expires_at,
    scheduleFingerprint: row.schedule_fingerprint,
    consumedAt: typeof row.consumed_at === "string" ? row.consumed_at : undefined,
    supersededAt: typeof row.superseded_at === "string" ? row.superseded_at : undefined,
    label: `${row.team} ${row.starts_at}`,
  };
}

function mapConversation(row: Record<string, unknown>): StoredConversation {
  const telegramChatId = parseChatId(row.telegram_chat_id);
  if (typeof row.lead_id !== "string" || telegramChatId === null || typeof row.openai_conversation_id !== "string") {
    throw new Error("Invalid conversation row");
  }
  return { leadId: row.lead_id, telegramChatId, openAiConversationId: row.openai_conversation_id };
}

function quoteFromRow(row: Record<string, unknown>): Quote | undefined {
  if (typeof row.quoted_price_rsd !== "number") return undefined;
  const parsed = quoteSchema.safeParse(row.quote_details);
  if (!parsed.success || parsed.data.amountRsd !== row.quoted_price_rsd) throw new Error("Invalid quote row");
  return parsed.data;
}

function pricingRulesFromRow(row: Record<string, unknown>) {
  if (row.pricing_rules_snapshot === null || row.pricing_rules_snapshot === undefined) return undefined;
  const parsed = pricingRulesSchema.safeParse(row.pricing_rules_snapshot);
  if (!parsed.success) throw new Error("Invalid pricing rules snapshot");
  return parsed.data;
}

function parseChatId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function mapOperation(row: Record<string, unknown>): StoredIntegrationOperation {
  if (typeof row.idempotency_key !== "string" || !isEnumValue(integrationOperationStatuses, row.status)) {
    throw new Error("Invalid integration operation row");
  }
  return {
    idempotencyKey: row.idempotency_key,
    status: row.status,
    externalId: typeof row.external_id === "string" ? row.external_id : undefined,
    isNew: false,
  };
}

function mapTrelloSyncJob(row: Record<string, unknown>): StoredTrelloSyncJob {
  if (
    typeof row.lead_id !== "string" ||
    (row.desired_lifecycle !== "qualified" && row.desired_lifecycle !== "booked") ||
    (row.reply_language !== "en" && row.reply_language !== "ru" && row.reply_language !== "sr-Latn" && row.reply_language !== "sr-Cyrl") ||
    (row.state !== "pending" && row.state !== "calendar_pending" && row.state !== "confirmation_pending" && row.state !== "done" && row.state !== "manual") ||
    typeof row.created_at !== "string" || typeof row.attempt_count !== "number" || typeof row.human_needed_escalated !== "boolean" || typeof row.next_attempt_at !== "string"
  ) throw new Error("Invalid Trello sync job row");
  return {
    leadId: row.lead_id,
    desiredLifecycle: row.desired_lifecycle,
    replyLanguage: row.reply_language,
    confirmationKey: typeof row.confirmation_key === "string" ? row.confirmation_key : undefined,
    state: row.state,
    createdAt: row.created_at,
    attemptCount: row.attempt_count,
    humanNeededEscalated: row.human_needed_escalated,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: typeof row.last_error_code === "string" ? row.last_error_code : undefined,
    leaseToken: typeof row.lease_token === "string" ? row.lease_token : undefined,
    leaseExpiresAt: typeof row.lease_expires_at === "string" ? row.lease_expires_at : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapAgentConfig(row: Record<string, unknown>): StoredAgentConfig {
  const pricingRules = pricingRulesSchema.safeParse(row.pricing_rules);
  if (typeof row.version !== "number" || typeof row.system_prompt !== "string" || !pricingRules.success) {
    throw new Error("Invalid agent configuration row");
  }
  return { version: row.version, systemPrompt: row.system_prompt, pricingRules: pricingRules.data };
}

function isEnumValue<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}

function isTrelloDesiredStateOperation(operationType: string): boolean {
  return operationType === "update_move_card" || operationType === "set_human_needed_label";
}
