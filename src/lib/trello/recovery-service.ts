import { randomUUID } from "node:crypto";

import type { LeadRepository, StoredLead, StoredTrelloSyncJob } from "@/lib/leads/repository";
import { renderBookingConfirmedReply } from "@/lib/telegram/renderer";
import { TelegramDeliveryError, type TelegramGateway } from "@/lib/telegram/gateway";
import { TrelloSyncService } from "@/lib/trello/sync-service";

const retryDelaysMilliseconds = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
const manualAfterMilliseconds = 60 * 60_000;
const jobLeaseSeconds = 300;

export type TrelloReconcileCounts = { claimed: number; completed: number; retried: number; manual: number };

/**
 * Database-backed, lease-fenced recovery for a booking whose Calendar event
 * already exists. It deliberately has no Calendar dependency: a scheduler
 * must never manufacture a booking or repeat a Calendar write.
 */
export class TrelloRecoveryService {
  constructor(
    private readonly repository: LeadRepository,
    private readonly trelloSync: TrelloSyncService,
    private readonly telegram: TelegramGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueueLeadRecovery(input: { lead: StoredLead; desiredLifecycle: "qualified" | "booked"; replyLanguage: StoredTrelloSyncJob["replyLanguage"] }): Promise<void> {
    if (input.desiredLifecycle === "booked" && !input.lead.calendarEventId) return;
    await this.repository.enqueueTrelloSyncJob({
      leadId: input.lead.id,
      desiredLifecycle: input.desiredLifecycle,
      replyLanguage: input.replyLanguage,
      confirmationKey: input.desiredLifecycle === "booked" ? bookingConfirmationKey(input.lead) : undefined,
      now: this.now().toISOString(),
    });
  }

  async enqueueBookingRecovery(input: { lead: StoredLead; replyLanguage: StoredTrelloSyncJob["replyLanguage"] }): Promise<void> {
    await this.enqueueLeadRecovery({ ...input, desiredLifecycle: "booked" });
  }

  async reconcileDueJobs(limit: number): Promise<TrelloReconcileCounts> {
    const now = this.now();
    const jobs = await this.repository.claimDueTrelloSyncJobs({
      now: now.toISOString(),
      limit: Math.max(1, Math.min(limit, 25)),
      leaseToken: randomUUID(),
      leaseSeconds: jobLeaseSeconds,
    });
    const counts: TrelloReconcileCounts = { claimed: jobs.length, completed: 0, retried: 0, manual: 0 };
    for (const job of jobs) {
      const outcome = await this.reconcileOne(job, now);
      counts[outcome] += 1;
    }
    return counts;
  }

  private async reconcileOne(job: StoredTrelloSyncJob, now: Date): Promise<"completed" | "retried" | "manual"> {
    if (!job.leaseToken) throw new Error("Claimed Trello sync job is missing a lease token");
    const lead = await this.repository.findLeadById(job.leadId);
    if (!lead) {
      return this.rescheduleOrManual(job, now, "trello_recovery_lead_missing", "manual");
    }
    if (job.desiredLifecycle === "booked" && (!lead.calendarEventId || !lead.assignedTeam || !lead.bookedStart || !lead.quote)) {
      return this.rescheduleOrManual(job, now, "trello_recovery_booking_data_missing", "calendar_pending");
    }
    if (lead.status === "done" || lead.status === "lost") {
      return this.rescheduleOrManual(job, now, "trello_recovery_terminal_lifecycle", "manual");
    }

    const elapsed = Math.max(0, now.getTime() - new Date(job.createdAt).getTime());
    if (elapsed >= manualAfterMilliseconds) {
      return this.rescheduleOrManual(job, now, "trello_recovery_sla_manual", "manual");
    }
    if (!job.humanNeededEscalated && elapsed >= 15 * 60_000) {
      lead.humanNeeded = true;
      lead.humanNeededReason = "trello_ambiguous";
      await this.repository.saveLead(lead);
      await this.repository.appendActivity(lead.id, "trello_recovery_human_needed", {});
      const labelled = await this.trelloSync.syncLead(lead, job.desiredLifecycle);
      if (!labelled.ok) {
        await this.repository.appendActivity(lead.id, "trello_recovery_human_label_sync_failed", { error_code: labelled.code });
      }
      await this.repository.acknowledgeTrelloSyncJobEscalation({ leadId: job.leadId, leaseToken: job.leaseToken });
      return "retried";
    }

    const temporaryTrelloFlag = lead.humanNeeded && (lead.humanNeededReason === "trello_unavailable" || lead.humanNeededReason === "trello_ambiguous");
    if (temporaryTrelloFlag) {
      lead.humanNeeded = false;
      lead.humanNeededReason = undefined;
      await this.repository.saveLead(lead);
    }
    const trello = await this.trelloSync.syncLead(lead, job.desiredLifecycle);
    if (!trello.ok || (trello.ok && trello.terminalLifecycle)) {
      if (temporaryTrelloFlag && job.humanNeededEscalated) {
        lead.humanNeeded = true;
        lead.humanNeededReason = "trello_ambiguous";
        await this.repository.saveLead(lead);
      }
      return this.rescheduleOrManual(
        job,
        now,
        !trello.ok ? trello.code : "trello_recovery_terminal_lifecycle",
        trello.ok && trello.terminalLifecycle ? "manual" : "pending",
      );
    }

    if (job.desiredLifecycle === "qualified") {
      await this.repository.completeTrelloSyncJob({ leadId: job.leadId, leaseToken: job.leaseToken });
      return "completed";
    }
    lead.status = "booked";
    await this.repository.saveLead(lead);
    const confirmation = await this.sendConfirmation(lead, job);
    if (confirmation === "succeeded") {
      await this.repository.appendActivity(lead.id, "booking_confirmation_recovered", { trello_card_id: trello.cardId });
      await this.repository.completeTrelloSyncJob({ leadId: job.leadId, leaseToken: job.leaseToken });
      return "completed";
    }
    if (confirmation === "retryable") return this.rescheduleOrManual(job, now, "telegram_confirmation_retryable", "confirmation_pending");
    // A non-successful Telegram operation cannot be safely repeated from a
    // worker: ambiguous delivery may already have reached the customer.
    return this.rescheduleOrManual(job, now, "telegram_confirmation_not_repeatable", "manual");
  }

  private async sendConfirmation(lead: StoredLead, job: StoredTrelloSyncJob): Promise<"succeeded" | "retryable" | "not_repeatable"> {
    if (!job.confirmationKey || !lead.assignedTeam || !lead.bookedStart || !lead.quote) return "not_repeatable";
    const operation = await this.repository.createIntegrationOperation({
      leadId: lead.id,
      idempotencyKey: job.confirmationKey,
      provider: "telegram",
      operationType: "send_message",
    });
    if (!operation.isNew) return operation.status === "succeeded" ? "succeeded" : "not_repeatable";
    try {
      const reply = renderBookingConfirmedReply({
        language: job.replyLanguage,
        team: lead.assignedTeam,
        start: lead.bookedStart,
        quoteAmountRsd: lead.quote.amountRsd,
      });
      const sent = await this.telegram.sendMessage({ chatId: lead.telegramChatId, text: reply.text, replyMarkup: reply.replyMarkup });
      await this.repository.completeIntegrationOperation(job.confirmationKey, sent.messageId);
      return "succeeded";
    } catch (error) {
      await this.repository.failIntegrationOperation(
        job.confirmationKey,
        "telegram_delivery_failed",
        error instanceof TelegramDeliveryError && error.outcome === "failed" ? "failed" : "ambiguous",
      );
      return error instanceof TelegramDeliveryError && error.outcome === "failed" ? "retryable" : "not_repeatable";
    }
  }

  private async rescheduleOrManual(
    job: StoredTrelloSyncJob,
    now: Date,
    errorCode: string,
    requestedState: Exclude<StoredTrelloSyncJob["state"], "done">,
  ): Promise<"retried" | "manual"> {
    if (!job.leaseToken) throw new Error("Claimed Trello sync job is missing a lease token");
    const elapsed = Math.max(0, now.getTime() - new Date(job.createdAt).getTime());
    const terminal = requestedState === "manual" || elapsed >= manualAfterMilliseconds;
    if (terminal) {
      const lead = await this.repository.findLeadById(job.leadId);
      if (lead) {
        lead.humanNeeded = true;
        lead.humanNeededReason = "trello_ambiguous";
        await this.repository.saveLead(lead);
        await this.trelloSync.syncHumanNeededLabelOnly(lead);
      }
    }
    const delay = retryDelaysMilliseconds[Math.min(job.attemptCount, retryDelaysMilliseconds.length - 1)];
    const state = terminal ? "manual" : requestedState;
    await this.repository.rescheduleTrelloSyncJob({
      leadId: job.leadId,
      leaseToken: job.leaseToken,
      state,
      nextAttemptAt: terminal ? now.toISOString() : new Date(Math.min(now.getTime() + delay, new Date(job.createdAt).getTime() + manualAfterMilliseconds)).toISOString(),
      lastErrorCode: errorCode,
    });
    const lead = await this.repository.findLeadById(job.leadId);
    if (lead && terminal) await this.repository.appendActivity(lead.id, "trello_recovery_manual", { error_code: errorCode });
    return terminal ? "manual" : "retried";
  }
}

export function bookingConfirmationKey(lead: Pick<StoredLead, "id" | "calendarEventId">): string {
  if (!lead.calendarEventId) throw new Error("Booking confirmation requires a Calendar event id");
  return `telegram:booking_confirmed:${lead.id}:${lead.calendarEventId}`;
}
