import { createHash, randomUUID } from "node:crypto";

import { defaultPricingRules, type HumanNeededReason } from "@/lib/contracts/domain";
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

const defaultAgentConfig: StoredAgentConfig = {
  version: 5,
  systemPrompt:
    "Speak as a friendly, professional Sherlock Cleaning digital coordinator. Answer the customer's direct question first, then ask only one or two related missing details without stock thanks or a checklist.",
  pricingRules: defaultPricingRules,
};

const telegramUpdateLeaseMilliseconds = 300_000;

type InMemoryTelegramUpdate = {
  status: "received" | "processed" | "failed";
  telegramChatId?: number;
  processingLeaseExpiresAt?: number;
  failureCode?: string;
};

type InMemoryChatLease = {
  updateId: number;
  expiresAt: number;
};

export class InMemoryLeadRepository implements LeadRepository {
  readonly activities: Array<{ leadId: string; eventType: string; payload: Record<string, unknown> }> = [];
  readonly updates = new Map<number, InMemoryTelegramUpdate>();
  readonly operations = new Map<string, StoredIntegrationOperation>();
  private readonly operationsByProviderTypeAndKey = new Map<string, StoredIntegrationOperation>();
  readonly slotTokens = new Map<string, StoredCalendarSlotToken>();
  readonly trelloSyncJobs = new Map<string, StoredTrelloSyncJob>();
  private readonly leadsById = new Map<string, StoredLead>();
  private readonly activeLeadIdByChatId = new Map<number, string>();
  private readonly conversationsByLeadId = new Map<string, StoredConversation>();
  private readonly chatLeases = new Map<number, InMemoryChatLease>();

  async claimTelegramUpdate(update: TelegramUpdateRecord): Promise<TelegramUpdateClaim> {
    const now = Date.now();
    const leaseExpiresAt = now + telegramUpdateLeaseMilliseconds;
    const existing = this.updates.get(update.updateId);
    if (existing?.status === "processed") return "duplicate";
    if (existing?.status === "received" && hasLiveUpdateLease(existing, now)) return "in_progress";

    if (update.telegramChatId !== undefined) {
      const earlierUpdatePending = [...this.updates.entries()].some(([updateId, stored]) =>
        updateId < update.updateId &&
        stored.telegramChatId === update.telegramChatId &&
        hasLiveUpdateLease(stored, now)
      );
      if (earlierUpdatePending) return "in_progress";
      const chatLease = this.chatLeases.get(update.telegramChatId);
      if (chatLease && chatLease.updateId !== update.updateId && hasLiveChatLease(chatLease, this.updates, now)) {
        return "in_progress";
      }
      this.chatLeases.set(update.telegramChatId, { updateId: update.updateId, expiresAt: leaseExpiresAt });
    }

    this.updates.set(update.updateId, {
      status: "received",
      telegramChatId: update.telegramChatId,
      processingLeaseExpiresAt: leaseExpiresAt,
    });
    return "claimed";
  }

  async releaseTelegramChatLease(telegramChatId: number, updateId: number): Promise<void> {
    if (this.chatLeases.get(telegramChatId)?.updateId === updateId) this.chatLeases.delete(telegramChatId);
  }

  async markTelegramUpdateProcessed(updateId: number): Promise<void> {
    this.updates.set(updateId, {
      ...this.updates.get(updateId),
      status: "processed",
      processingLeaseExpiresAt: undefined,
      failureCode: undefined,
    });
  }

  async markTelegramUpdateFailed(updateId: number, failureCode: string): Promise<void> {
    this.updates.set(updateId, {
      ...this.updates.get(updateId),
      status: "failed",
      processingLeaseExpiresAt: undefined,
      failureCode,
    });
  }

  async findLeadByTelegramChatId(telegramChatId: number): Promise<StoredLead | null> {
    const id = this.activeLeadIdByChatId.get(telegramChatId);
    return id ? this.leadsById.get(id) ?? null : null;
  }

  async findLeadById(leadId: string): Promise<StoredLead | null> {
    const lead = this.leadsById.get(leadId);
    return lead ? structuredClone(lead) : null;
  }

  async createLead(input: Pick<StoredLead, "telegramChatId" | "firstMessageLanguage" | "agentConfigVersion" | "telegramUserId" | "customerDisplayName" | "telegramUsername">): Promise<StoredLead> {
    const lead: StoredLead = {
      id: randomUUID(),
      telegramChatId: input.telegramChatId,
      telegramUserId: input.telegramUserId,
      customerDisplayName: input.customerDisplayName,
      telegramUsername: input.telegramUsername,
      activeInChat: true,
      firstMessageLanguage: input.firstMessageLanguage,
      businessReference: businessReference(),
      status: "new_lead",
      clientData: {},
      agentConfigVersion: input.agentConfigVersion,
      humanNeeded: false,
    };
    this.leadsById.set(lead.id, lead);
    this.activeLeadIdByChatId.set(lead.telegramChatId, lead.id);
    return lead;
  }

  async startNewAddressLead(input: { telegramChatId: number; firstMessageLanguage: string; agentConfigVersion: number; telegramUserId?: number; customerDisplayName?: string; telegramUsername?: string }): Promise<StoredLead> {
    const current = await this.findLeadByTelegramChatId(input.telegramChatId);
    if (current && isPristineLead(current) && !this.conversationsByLeadId.has(current.id)) return current;
    if (current) {
      current.activeInChat = false;
      this.leadsById.set(current.id, current);
    }
    return this.createLead(input);
  }

  async saveLead(lead: StoredLead): Promise<void> {
    this.leadsById.set(lead.id, lead);
    if (lead.activeInChat) this.activeLeadIdByChatId.set(lead.telegramChatId, lead.id);
  }

  async persistCalendarReservationWithTrelloJob(input: { lead: StoredLead; replyLanguage: "en" | "ru" | "sr-Latn" | "sr-Cyrl" }): Promise<void> {
    // This in-memory operation mirrors the one RPC used in production.
    await this.saveLead(input.lead);
    const existing = this.trelloSyncJobs.get(input.lead.id);
    if (existing?.desiredLifecycle === "booked") return;
    if (existing && existing.desiredLifecycle === "qualified") {
      existing.desiredLifecycle = "booked";
      existing.replyLanguage = input.replyLanguage;
      existing.state = "pending";
      existing.nextAttemptAt = new Date().toISOString();
      existing.confirmationKey = input.lead.calendarEventId ? `telegram:booking_confirmed:${input.lead.id}:${input.lead.calendarEventId}` : existing.confirmationKey;
      existing.createdAt = new Date().toISOString();
      existing.attemptCount = 0;
      existing.humanNeededEscalated = false;
      existing.lastErrorCode = undefined;
      existing.leaseToken = undefined;
      existing.leaseExpiresAt = undefined;
      return;
    }
    await this.enqueueTrelloSyncJob({
      leadId: input.lead.id,
      desiredLifecycle: "booked",
      replyLanguage: input.replyLanguage,
      confirmationKey: input.lead.calendarEventId ? `telegram:booking_confirmed:${input.lead.id}:${input.lead.calendarEventId}` : undefined,
      now: new Date().toISOString(),
    });
  }

  async getConversation(leadId: string): Promise<StoredConversation | null> {
    return this.conversationsByLeadId.get(leadId) ?? null;
  }

  async saveConversation(conversation: StoredConversation): Promise<void> {
    this.conversationsByLeadId.set(conversation.leadId, conversation);
  }

  async invalidateConversation(leadId: string): Promise<void> {
    this.conversationsByLeadId.delete(leadId);
  }

  async getCurrentAgentConfig(): Promise<StoredAgentConfig> {
    return defaultAgentConfig;
  }

  async getAgentConfig(version: number): Promise<StoredAgentConfig> {
    if (version !== defaultAgentConfig.version) throw new Error(`Unknown agent config version ${version}`);
    return defaultAgentConfig;
  }

  async appendActivity(leadId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
    this.activities.push({ leadId, eventType, payload });
  }

  async createIntegrationOperation(input: {
    leadId: string;
    idempotencyKey: string;
    provider: "telegram" | "openai" | "google_calendar" | "trello";
    operationType: string;
  }): Promise<StoredIntegrationOperation> {
    const operationTuple = `${input.provider}\u0000${input.operationType}\u0000${input.idempotencyKey}`;
    const existing = this.operationsByProviderTypeAndKey.get(operationTuple);
    if (existing) {
      const retryableDesiredState = input.provider === "trello" && isTrelloDesiredStateOperation(input.operationType) &&
        (existing.status === "failed" || existing.status === "succeeded");
      const retryableBookingDelivery = input.provider === "telegram" && input.operationType === "send_message" &&
        input.idempotencyKey.startsWith("telegram:booking_confirmed:") && existing.status === "failed";
      const retryableAgentTurn = input.provider === "openai" && input.operationType === "run_turn" && existing.status === "failed";
      if (((existing.status !== "failed" || input.provider === "google_calendar") && !retryableBookingDelivery && !retryableAgentTurn) && !retryableDesiredState) {
        return { ...existing, isNew: false };
      }
      existing.status = "pending";
      return { ...existing, isNew: true };
    }

    const operation: StoredIntegrationOperation = { idempotencyKey: input.idempotencyKey, status: "pending", isNew: true };
    this.operationsByProviderTypeAndKey.set(operationTuple, operation);
    this.operations.set(input.idempotencyKey, operation);
    return operation;
  }

  async getIntegrationOperation(idempotencyKey: string): Promise<StoredIntegrationOperation | null> {
    const operation = this.operations.get(idempotencyKey);
    return operation ? { ...operation, isNew: false } : null;
  }

  async completeIntegrationOperation(idempotencyKey: string, externalId?: string): Promise<void> {
    const operation = this.operations.get(idempotencyKey);
    if (!operation) throw new Error(`Unknown operation ${idempotencyKey}`);
    operation.status = "succeeded";
    operation.externalId = externalId;
  }

  async failIntegrationOperation(
    idempotencyKey: string,
    errorCode: string,
    status: "failed" | "ambiguous" = "failed",
  ): Promise<void> {
    const operation = this.operations.get(idempotencyKey);
    if (!operation) throw new Error(`Unknown operation ${idempotencyKey}`);
    operation.status = status;
    void errorCode;
  }

  getLead(telegramChatId: number): StoredLead | null {
    const id = this.activeLeadIdByChatId.get(telegramChatId);
    return id ? this.leadsById.get(id) ?? null : null;
  }

  getLeadById(leadId: string): StoredLead | null { return this.leadsById.get(leadId) ?? null; }

  getHumanNeededReason(telegramChatId: number): HumanNeededReason | undefined {
    return this.getLead(telegramChatId)?.humanNeededReason;
  }

  async saveCalendarSlotOffer(input: { leadId: string; offerId: string; issuedAt: string; tokens: StoredCalendarSlotToken[] }): Promise<void> {
    for (const existing of this.slotTokens.values()) {
      if (existing.leadId === input.leadId && !existing.consumedAt && !existing.supersededAt) {
        existing.supersededAt = input.issuedAt;
      }
    }
    for (const token of input.tokens) this.slotTokens.set(token.token, { ...token, offerId: input.offerId });
  }

  async listActiveCalendarSlotTokens(input: { leadId: string; now: string }): Promise<StoredCalendarSlotToken[]> {
    return [...this.slotTokens.values()]
      .filter((token) => token.leadId === input.leadId && !token.consumedAt && !token.supersededAt && token.expiresAt > input.now)
      .sort((left, right) => left.displayOrder - right.displayOrder);
  }

  async consumeCalendarSlotToken(input: { token: string; leadId: string; now: string }): Promise<StoredCalendarSlotToken | null> {
    const token = this.slotTokens.get(input.token);
    if (!token || token.leadId !== input.leadId || token.consumedAt || token.supersededAt || token.expiresAt <= input.now) return null;
    token.consumedAt = input.now;
    return { ...token };
  }

  async getCalendarSlotToken(input: { token: string; leadId: string }): Promise<StoredCalendarSlotToken | null> {
    const token = this.slotTokens.get(input.token);
    return token?.leadId === input.leadId ? { ...token } : null;
  }

  async enqueueTrelloSyncJob(input: Omit<StoredTrelloSyncJob, "state" | "createdAt" | "attemptCount" | "humanNeededEscalated" | "nextAttemptAt" | "lastErrorCode" | "leaseToken" | "leaseExpiresAt"> & { now: string }): Promise<void> {
    const existing = this.trelloSyncJobs.get(input.leadId);
    const preservesBookedJob = existing?.desiredLifecycle === "booked" && input.desiredLifecycle === "qualified";
    this.trelloSyncJobs.set(input.leadId, {
      leadId: input.leadId,
      desiredLifecycle: input.desiredLifecycle === "booked" || existing?.desiredLifecycle === "booked" ? "booked" : "qualified",
      replyLanguage: existing?.desiredLifecycle === "booked" && input.desiredLifecycle === "qualified" ? existing.replyLanguage : input.replyLanguage,
      confirmationKey: input.confirmationKey ?? existing?.confirmationKey,
      state: preservesBookedJob ? existing.state : "pending",
      createdAt: preservesBookedJob ? existing.createdAt : input.now,
      attemptCount: preservesBookedJob ? existing.attemptCount : 0,
      humanNeededEscalated: preservesBookedJob ? existing.humanNeededEscalated : false,
      nextAttemptAt: preservesBookedJob ? existing.nextAttemptAt : input.now,
      lastErrorCode: preservesBookedJob ? existing.lastErrorCode : undefined,
      // Reopening a projection invalidates any worker which claimed its
      // previous epoch. It must claim again before it can complete the job.
      leaseToken: preservesBookedJob ? existing.leaseToken : undefined,
      leaseExpiresAt: preservesBookedJob ? existing.leaseExpiresAt : undefined,
    });
  }

  async accelerateTrelloSyncJob(input: { leadId: string; now: string; replyLanguage: "en" | "ru" | "sr-Latn" | "sr-Cyrl" }): Promise<void> {
    const existing = this.trelloSyncJobs.get(input.leadId);
    if (!existing || existing.state === "done" || existing.state === "manual") throw new Error("accelerate Trello sync job affected an invalid row count");
    existing.nextAttemptAt = input.now;
    if (existing.desiredLifecycle !== "booked") existing.replyLanguage = input.replyLanguage;
  }

  async claimDueTrelloSyncJobs(input: { now: string; limit: number; leaseToken: string; leaseSeconds: number }): Promise<StoredTrelloSyncJob[]> {
    const leaseExpiresAt = new Date(new Date(input.now).getTime() + input.leaseSeconds * 1000).toISOString();
    return [...this.trelloSyncJobs.values()]
      .filter((job) => job.state !== "done" && job.state !== "manual" &&
        (job.nextAttemptAt <= input.now || (!job.humanNeededEscalated && new Date(job.createdAt).getTime() <= new Date(input.now).getTime() - 15 * 60_000)) &&
        (!job.leaseExpiresAt || job.leaseExpiresAt <= input.now))
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
      .slice(0, input.limit)
      .map((job) => {
        job.leaseToken = input.leaseToken;
        job.leaseExpiresAt = leaseExpiresAt;
        return structuredClone(job);
      });
  }

  async completeTrelloSyncJob(input: { leadId: string; leaseToken: string }): Promise<void> {
    const job = this.trelloSyncJobs.get(input.leadId);
    if (!job || job.leaseToken !== input.leaseToken) throw new Error("Trello sync job lease lost");
    job.state = "done";
    job.leaseToken = undefined;
    job.leaseExpiresAt = undefined;
    job.lastErrorCode = undefined;
  }

  async acknowledgeTrelloSyncJobEscalation(input: { leadId: string; leaseToken: string }): Promise<void> {
    const job = this.trelloSyncJobs.get(input.leadId);
    if (!job || job.leaseToken !== input.leaseToken) throw new Error("Trello sync job lease lost");
    job.humanNeededEscalated = true;
    job.leaseToken = undefined;
    job.leaseExpiresAt = undefined;
  }

  async rescheduleTrelloSyncJob(input: { leadId: string; leaseToken: string; state: Exclude<import("@/lib/leads/repository").TrelloSyncJobState, "done">; nextAttemptAt: string; lastErrorCode: string }): Promise<void> {
    const job = this.trelloSyncJobs.get(input.leadId);
    if (!job || job.leaseToken !== input.leaseToken) throw new Error("Trello sync job lease lost");
    job.state = input.state;
    job.attemptCount += 1;
    job.nextAttemptAt = input.nextAttemptAt;
    job.lastErrorCode = input.lastErrorCode;
    job.leaseToken = undefined;
    job.leaseExpiresAt = undefined;
  }
}

function hasLiveUpdateLease(update: InMemoryTelegramUpdate, now: number): boolean {
  return update.status === "received" && (update.processingLeaseExpiresAt ?? 0) > now;
}

function hasLiveChatLease(
  chatLease: InMemoryChatLease,
  updates: Map<number, InMemoryTelegramUpdate>,
  now: number,
): boolean {
  const update = updates.get(chatLease.updateId);
  return chatLease.expiresAt > now && !!update && hasLiveUpdateLease(update, now);
}

function isPristineLead(lead: StoredLead): boolean {
  return Object.keys(lead.clientData).length === 0 && !lead.quote && !lead.humanNeeded && !lead.calendarEventId;
}

function businessReference(): string {
  return `SC-${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16).toUpperCase()}`;
}

function isTrelloDesiredStateOperation(operationType: string): boolean {
  return operationType === "update_move_card" || operationType === "set_human_needed_label";
}
