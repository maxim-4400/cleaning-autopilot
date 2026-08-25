import type {
  AvailabilitySlot,
  CleaningTeam,
  ClientData,
  HumanNeededReason,
  IntegrationOperationStatus,
  LeadStatus,
  PricingRules,
  Quote,
} from "@/lib/contracts/domain";

export type StoredLead = {
  id: string;
  telegramChatId: number;
  /** Operational contact metadata. It never enters the agent or public console DTO. */
  telegramUserId?: number;
  customerDisplayName?: string;
  telegramUsername?: string;
  pendingPreferredDate?: string;
  dateProposalExpiresAt?: string;
  /** Opaque proposal state; never included in the agent, Trello or console DTO. */
  dateProposalVersion?: string;
  dateProposalLocale?: "en" | "ru" | "sr-Latn" | "sr-Cyrl";
  activeInChat: boolean;
  firstMessageLanguage: string;
  businessReference: string;
  status: LeadStatus;
  clientData: ClientData;
  agentConfigVersion: number;
  quote?: Quote;
  quoteValidity?: "active" | "superseded";
  quoteInvalidatedAt?: string;
  quotedAt?: string;
  /**
   * A one-turn backend-owned consent marker. It is set only after the typed
   * quote template has been delivered and matches the currently active quote.
   */
  pendingSchedulingConsentQuotedAt?: string;
  pricingRulesSnapshot?: PricingRules;
  humanNeeded: boolean;
  humanNeededReason?: HumanNeededReason;
  assignedTeam?: CleaningTeam;
  bookedStart?: string;
  bookedEnd?: string;
  calendarEventId?: string;
  trelloCardId?: string;
  trelloCardUrl?: string;
};

export type StoredCalendarSlotToken = AvailabilitySlot & {
  leadId: string;
  expiresAt: string;
  scheduleFingerprint: string;
  consumedAt?: string;
  supersededAt?: string;
};

export type StoredConversation = {
  leadId: string;
  telegramChatId: number;
  openAiConversationId: string;
};

export type StoredAgentConfig = {
  version: number;
  systemPrompt: string;
  pricingRules: PricingRules;
};

export type StoredIntegrationOperation = {
  idempotencyKey: string;
  status: IntegrationOperationStatus;
  externalId?: string;
  isNew: boolean;
};

export const trelloSyncJobStates = ["pending", "calendar_pending", "confirmation_pending", "done", "manual"] as const;
export type TrelloSyncJobState = (typeof trelloSyncJobStates)[number];

export type StoredTrelloSyncJob = {
  leadId: string;
  desiredLifecycle: "qualified" | "booked";
  replyLanguage: "en" | "ru" | "sr-Latn" | "sr-Cyrl";
  confirmationKey?: string;
  state: TrelloSyncJobState;
  createdAt: string;
  attemptCount: number;
  humanNeededEscalated: boolean;
  nextAttemptAt: string;
  lastErrorCode?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
};

export type TelegramUpdateRecord = {
  updateId: number;
  telegramChatId?: number;
  telegramMessageId?: number;
  payload: Record<string, unknown>;
};

export type TelegramUpdateClaim = "claimed" | "duplicate" | "in_progress";

export interface LeadRepository {
  claimTelegramUpdate(update: TelegramUpdateRecord): Promise<TelegramUpdateClaim>;
  releaseTelegramChatLease(telegramChatId: number, updateId: number): Promise<void>;
  markTelegramUpdateProcessed(updateId: number): Promise<void>;
  markTelegramUpdateFailed(updateId: number, failureCode: string): Promise<void>;
  findLeadByTelegramChatId(telegramChatId: number): Promise<StoredLead | null>;
  findLeadById(leadId: string): Promise<StoredLead | null>;
  createLead(input: Pick<StoredLead, "telegramChatId" | "firstMessageLanguage" | "agentConfigVersion" | "telegramUserId" | "customerDisplayName" | "telegramUsername">): Promise<StoredLead>;
  startNewAddressLead(input: { telegramChatId: number; firstMessageLanguage: string; agentConfigVersion: number; telegramUserId?: number; customerDisplayName?: string; telegramUsername?: string }): Promise<StoredLead>;
  saveLead(lead: StoredLead): Promise<void>;
  persistCalendarReservationWithTrelloJob(input: { lead: StoredLead; replyLanguage: "en" | "ru" | "sr-Latn" | "sr-Cyrl" }): Promise<void>;
  getConversation(leadId: string): Promise<StoredConversation | null>;
  saveConversation(conversation: StoredConversation): Promise<void>;
  /** Removes only the local mapping after an ambiguous provider turn. */
  invalidateConversation(leadId: string): Promise<void>;
  getCurrentAgentConfig(): Promise<StoredAgentConfig>;
  getAgentConfig(version: number): Promise<StoredAgentConfig>;
  appendActivity(leadId: string, eventType: string, payload?: Record<string, unknown>): Promise<void>;
  createIntegrationOperation(input: {
    leadId: string;
    idempotencyKey: string;
    provider: "telegram" | "openai" | "google_calendar" | "trello";
    operationType: string;
  }): Promise<StoredIntegrationOperation>;
  getIntegrationOperation(idempotencyKey: string): Promise<StoredIntegrationOperation | null>;
  completeIntegrationOperation(idempotencyKey: string, externalId?: string): Promise<void>;
  failIntegrationOperation(idempotencyKey: string, errorCode: string, status?: IntegrationOperationStatus): Promise<void>;
  saveCalendarSlotOffer(input: {
    leadId: string;
    offerId: string;
    issuedAt: string;
    tokens: StoredCalendarSlotToken[];
  }): Promise<void>;
  listActiveCalendarSlotTokens(input: { leadId: string; now: string }): Promise<StoredCalendarSlotToken[]>;
  consumeCalendarSlotToken(input: { token: string; leadId: string; now: string }): Promise<StoredCalendarSlotToken | null>;
  getCalendarSlotToken(input: { token: string; leadId: string }): Promise<StoredCalendarSlotToken | null>;
  enqueueTrelloSyncJob(input: Omit<StoredTrelloSyncJob, "state" | "createdAt" | "attemptCount" | "humanNeededEscalated" | "nextAttemptAt" | "lastErrorCode" | "leaseToken" | "leaseExpiresAt"> & { now: string }): Promise<void>;
  accelerateTrelloSyncJob(input: { leadId: string; now: string; replyLanguage: "en" | "ru" | "sr-Latn" | "sr-Cyrl" }): Promise<void>;
  claimDueTrelloSyncJobs(input: { now: string; limit: number; leaseToken: string; leaseSeconds: number }): Promise<StoredTrelloSyncJob[]>;
  completeTrelloSyncJob(input: { leadId: string; leaseToken: string }): Promise<void>;
  acknowledgeTrelloSyncJobEscalation(input: { leadId: string; leaseToken: string }): Promise<void>;
  rescheduleTrelloSyncJob(input: { leadId: string; leaseToken: string; state: Exclude<TrelloSyncJobState, "done">; nextAttemptAt: string; lastErrorCode: string }): Promise<void>;
}
