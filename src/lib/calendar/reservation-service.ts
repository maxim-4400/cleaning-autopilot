import { randomUUID } from "node:crypto";

import type { AvailabilitySlot } from "@/lib/contracts/domain";
import type { CalendarGateway } from "@/lib/calendar/gateway";
import type { LeadRepository, StoredLead } from "@/lib/leads/repository";
import { SchedulingEngine } from "@/lib/scheduling/engine";
import { isRussianLanguage, isSerbianCyrillic, isSerbianLanguage, type ReplyLanguage } from "@/lib/telegram/language";

const tokenLifetimeMs = 30 * 60_000;

export class CalendarReservationService {
  constructor(
    private readonly repository: LeadRepository,
    private readonly calendar: CalendarGateway,
    private readonly scheduling = new SchedulingEngine(),
    private readonly now: () => Date = () => new Date(),
    private readonly onReservationPersisted?: (lead: StoredLead, replyLanguage: ReplyLanguage) => Promise<void>,
  ) {}

  async offerSlots(lead: StoredLead, replyLanguage: ReplyLanguage): Promise<{ ok: true; slots: AvailabilitySlot[] } | { ok: false; error: string }> {
    if (lead.status !== "qualified" || !lead.quote || lead.quoteValidity !== "active" || lead.humanNeeded) {
      return { ok: false, error: "active_qualified_quote_required" };
    }
    const now = this.now();
    if (!lead.clientData.preferredDate) return { ok: false, error: "preferred_date_required" };
    const { from, to } = availabilityWindow(lead.clientData.preferredDate);
    let teamA: Awaited<ReturnType<CalendarGateway["getBusyIntervals"]>>;
    let teamB: Awaited<ReturnType<CalendarGateway["getBusyIntervals"]>>;
    try {
      [teamA, teamB] = await Promise.all([
        this.calendar.getBusyIntervals({ team: "team_a", from, to }),
        this.calendar.getBusyIntervals({ team: "team_b", from, to }),
      ]);
    } catch {
      return { ok: false, error: "calendar_availability_failed" };
    }
    let rawSlots: Array<Omit<AvailabilitySlot, "token" | "offerId" | "displayOrder" | "label">>;
    try {
      rawSlots = this.scheduling.findSlots({ clientData: lead.clientData, now, busyByTeam: { team_a: teamA, team_b: teamB } });
    } catch (error) {
      if (error instanceof Error && error.message === "cleaning_duration_exceeds_workday") return { ok: false, error: "duration_exceeds_workday" };
      throw error;
    }
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + tokenLifetimeMs).toISOString();
    const offerId = randomUUID();
    const slots = rawSlots.map((slot, index) => ({
      ...slot,
      token: randomUUID(),
      offerId,
      displayOrder: index + 1,
      label: formatSlot(slot.team, slot.start, replyLanguage),
    }));
    const scheduleFingerprint = fingerprintSchedule(lead);
    try {
      await this.repository.saveCalendarSlotOffer({
        leadId: lead.id,
        offerId,
        issuedAt,
        tokens: slots.map((slot) => ({ ...slot, leadId: lead.id, expiresAt, scheduleFingerprint })),
      });
    } catch {
      return { ok: false, error: "calendar_slot_offer_persist_failed" };
    }
    if (slots.length === 0) return { ok: false, error: "no_available_slots" };
    return { ok: true, slots };
  }

  async reserveSlot(lead: StoredLead, token: string, replyLanguage: ReplyLanguage = "en"): Promise<{ ok: true; eventId: string } | { ok: false; error: string; ambiguous?: boolean }> {
    if (lead.calendarEventId) return { ok: true, eventId: lead.calendarEventId };
    if (lead.status !== "qualified" || !lead.quote || lead.quoteValidity !== "active" || lead.humanNeeded) {
      return { ok: false, error: "active_qualified_quote_required" };
    }
    const now = this.now().toISOString();
    const consumed = await this.repository.consumeCalendarSlotToken({ token, leadId: lead.id, now });
    const slot = consumed ?? await this.repository.getCalendarSlotToken({ token, leadId: lead.id });
    if (!slot) return { ok: false, error: "slot_token_invalid_or_expired" };
    if (slot.supersededAt) return { ok: false, error: "slot_offer_superseded" };
    const operationKey = `google_calendar:reservation:${lead.id}:${slot.token}`;
    if (slot.scheduleFingerprint !== fingerprintSchedule(lead)) return { ok: false, error: "slot_token_stale" };
    const existingOperation = await this.repository.getIntegrationOperation(operationKey);
    if (existingOperation?.status === "succeeded" && existingOperation.externalId) {
      await this.persistReservation(lead, slot, existingOperation.externalId, replyLanguage);
      return { ok: true, eventId: existingOperation.externalId };
    }
    if (existingOperation) return { ok: false, error: "calendar_operation_requires_manual_recovery", ambiguous: true };
    if (!consumed && slot.expiresAt <= now) return { ok: false, error: "slot_token_invalid_or_expired" };
    const operation = await this.repository.createIntegrationOperation({
      leadId: lead.id, idempotencyKey: operationKey, provider: "google_calendar", operationType: "create_event",
    });
    if (!operation.isNew) {
      if (operation.status === "succeeded" && operation.externalId) {
        await this.persistReservation(lead, slot, operation.externalId, replyLanguage);
        return { ok: true, eventId: operation.externalId };
      }
      return { ok: false, error: "calendar_operation_requires_manual_recovery", ambiguous: true };
    }

    let busy: Awaited<ReturnType<CalendarGateway["getBusyIntervals"]>>;
    try {
      busy = await this.calendar.getBusyIntervals({ team: slot.team, from: slot.start, to: slot.bufferEnd });
    } catch {
      try {
        await this.repository.failIntegrationOperation(operationKey, "calendar_recheck_failed");
      } catch {
        // The Calendar create operation has not been attempted. The caller still receives a fail-closed result.
      }
      return { ok: false, error: "calendar_availability_failed" };
    }
    const conflict = busy.some((interval) => new Date(slot.start) < new Date(interval.end) && new Date(interval.start) < new Date(slot.bufferEnd));
    if (conflict) {
      await this.repository.failIntegrationOperation(operationKey, "slot_no_longer_available");
      return { ok: false, error: "slot_no_longer_available" };
    }
    const created = await this.calendar.createEvent({
      team: slot.team, start: slot.start, end: slot.bufferEnd, leadId: lead.id, idempotencyKey: operationKey,
    });
    if (created.kind === "failed") {
      await this.repository.failIntegrationOperation(operationKey, created.code, created.ambiguous ? "ambiguous" : "failed");
      return { ok: false, error: created.code, ambiguous: created.ambiguous };
    }
    await this.repository.completeIntegrationOperation(operationKey, created.eventId);
    await this.persistReservation(lead, slot, created.eventId, replyLanguage);
    return { ok: true, eventId: created.eventId };
  }

  private async persistReservation(lead: StoredLead, slot: { team: StoredLead["assignedTeam"]; start: string; end: string }, eventId: string, replyLanguage: ReplyLanguage): Promise<void> {
    lead.assignedTeam = slot.team;
    lead.bookedStart = slot.start;
    lead.bookedEnd = slot.end;
    lead.calendarEventId = eventId;
    await this.repository.persistCalendarReservationWithTrelloJob({ lead, replyLanguage });
    // The durable reservation/outbox boundary remains the source of truth.  As
    // soon as it commits, make the first Trello reconciliation due instead of
    // waiting for the legacy recovery fallback.  This is deliberately a
    // separate, lease-fenced operation: a retry or concurrent worker can only
    // claim the one persisted job and never create another Calendar event.
    try {
      await this.repository.accelerateTrelloSyncJob({
        leadId: lead.id,
        now: this.now().toISOString(),
        replyLanguage,
      });
    } catch {
      // The reservation and durable outbox are already committed. The
      // recovery runner will claim this job on its regular fallback cadence.
    }
    await this.onReservationPersisted?.(lead, replyLanguage);
    await this.repository.appendActivity(lead.id, "calendar_reserved_pending_trello", { team: slot.team, calendar_event_id: eventId });
  }
}

function fingerprintSchedule(lead: StoredLead): string {
  const { cleaningType, areaM2, preferredDate, preferredTimeWindow, urgency } = lead.clientData;
  return JSON.stringify({ cleaningType, areaM2, preferredDate, preferredTimeWindow, urgency });
}

function formatSlot(team: "team_a" | "team_b", start: string, language: string): string {
  const russian = isRussianLanguage(language);
  const serbian = isSerbianLanguage(language);
  const when = new Intl.DateTimeFormat(russian ? "ru-RU" : isSerbianCyrillic(language) ? "sr-Cyrl-RS" : serbian ? "sr-Latn-RS" : "en-GB", {
    timeZone: "Europe/Belgrade", weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(start));
  const teamName = russian ? "Команда" : isSerbianCyrillic(language) ? "Тим" : serbian ? "Tim" : "Team";
  const teamLetter = isSerbianCyrillic(language) ? (team === "team_a" ? "А" : "Б") : team === "team_a" ? "A" : "B";
  return `${teamName} ${teamLetter} · ${when}`;
}

function availabilityWindow(preferredDate: string): { from: string; to: string } {
  const [year, month, day] = preferredDate.split("-").map(Number);
  if (!year || !month || !day) throw new Error("Invalid preferred date");
  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const end = new Date(start.getTime() + 14 * 24 * 60 * 60_000);
  return { from: start.toISOString(), to: end.toISOString() };
}
