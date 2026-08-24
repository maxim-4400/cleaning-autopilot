import { describe, expect, it } from "vitest";

import { FakeCalendarGateway } from "@/lib/calendar/gateway";
import { CalendarReservationService } from "@/lib/calendar/reservation-service";
import { InMemoryLeadRepository } from "@/lib/leads/in-memory-repository";
import { FakeTelegramGateway } from "@/lib/telegram/gateway";
import { FakeTrelloGateway } from "@/lib/trello/gateway";
import { bookingConfirmationKey, TrelloRecoveryService } from "@/lib/trello/recovery-service";
import { TrelloSyncService } from "@/lib/trello/sync-service";

describe("TrelloRecoveryService", () => {
  it("retries Trello only, never creates a Calendar event, then sends one booking-stable confirmation", async () => {
    let now = new Date("2026-08-22T10:00:00.000Z");
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 9001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    Object.assign(lead, {
      status: "qualified" as const,
      calendarEventId: "calendar-event-already-created",
      assignedTeam: "team_a" as const,
      bookedStart: "2026-08-24T08:00:00.000Z",
      bookedEnd: "2026-08-24T10:00:00.000Z",
      quote: { amountRsd: 6500, baseRsd: 6500, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 },
    });
    await repository.saveLead(lead);
    const trello = new FakeTrelloGateway();
    trello.nextCreateResult = { kind: "failed", code: "trello_503", ambiguous: false };
    const telegram = new FakeTelegramGateway();
    const service = new TrelloRecoveryService(repository, new TrelloSyncService(repository, trello), telegram, () => now);

    await service.enqueueBookingRecovery({ lead, replyLanguage: "en" });
    await expect(service.reconcileDueJobs(10)).resolves.toEqual({ claimed: 1, completed: 0, retried: 1, manual: 0 });
    expect(repository.trelloSyncJobs.get(lead.id)).toMatchObject({ state: "pending", attemptCount: 1, nextAttemptAt: "2026-08-22T10:01:00.000Z" });
    expect(lead.calendarEventId).toBe("calendar-event-already-created");
    expect(telegram.messages).toHaveLength(0);

    now = new Date("2026-08-22T10:01:00.000Z");
    trello.nextCreateResult = undefined;
    await expect(service.reconcileDueJobs(10)).resolves.toEqual({ claimed: 1, completed: 1, retried: 0, manual: 0 });
    expect(repository.getLead(9001)?.status).toBe("booked");
    expect(telegram.messages).toHaveLength(1);
    expect(repository.operations.get(bookingConfirmationKey(lead))).toMatchObject({ status: "succeeded" });

    now = new Date("2026-08-22T10:02:00.000Z");
    await expect(service.reconcileDueJobs(10)).resolves.toEqual({ claimed: 0, completed: 0, retried: 0, manual: 0 });
    expect(telegram.messages).toHaveLength(1);
  });

  it("uses 1m, 5m, 15m, 30m cadence and escalates to manual after one hour", async () => {
    let now = new Date("2026-08-22T10:00:00.000Z");
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 9002, firstMessageLanguage: "en", agentConfigVersion: 5 });
    Object.assign(lead, { status: "qualified" as const, calendarEventId: "event", assignedTeam: "team_a" as const, bookedStart: "2026-08-24T08:00:00.000Z", quote: { amountRsd: 6500, baseRsd: 6500, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 } });
    await repository.saveLead(lead);
    const trello = new FakeTrelloGateway();
    trello.nextCreateResult = { kind: "failed", code: "trello_503", ambiguous: false };
    const service = new TrelloRecoveryService(repository, new TrelloSyncService(repository, trello), new FakeTelegramGateway(), () => now);
    await service.enqueueBookingRecovery({ lead, replyLanguage: "en" });

    for (const expected of ["2026-08-22T10:01:00.000Z", "2026-08-22T10:06:00.000Z", "2026-08-22T10:21:00.000Z"]) {
      await service.reconcileDueJobs(1);
      expect(repository.trelloSyncJobs.get(lead.id)?.nextAttemptAt).toBe(expected);
      now = new Date(expected);
    }
    now = new Date("2026-08-22T10:15:00.000Z");
    await expect(service.reconcileDueJobs(1)).resolves.toEqual({ claimed: 1, completed: 0, retried: 1, manual: 0 });
    expect(repository.getLead(9002)).toMatchObject({ humanNeeded: true, humanNeededReason: "trello_ambiguous" });
    expect(repository.trelloSyncJobs.get(lead.id)?.nextAttemptAt).toBe("2026-08-22T10:21:00.000Z");
    now = new Date("2026-08-22T10:21:00.000Z");
    await service.reconcileDueJobs(1);
    expect(repository.trelloSyncJobs.get(lead.id)?.nextAttemptAt).toBe("2026-08-22T10:51:00.000Z");
    now = new Date("2026-08-22T11:01:00.000Z");
    await expect(service.reconcileDueJobs(1)).resolves.toEqual({ claimed: 1, completed: 0, retried: 0, manual: 1 });
    expect(repository.trelloSyncJobs.get(lead.id)).toMatchObject({ state: "manual" });
    expect(repository.getLead(9002)).toMatchObject({ humanNeeded: true, humanNeededReason: "trello_ambiguous" });
  });

  it("does not repeat an ambiguous Telegram confirmation", async () => {
    let now = new Date("2026-08-22T10:00:00.000Z");
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 9003, firstMessageLanguage: "en", agentConfigVersion: 5 });
    Object.assign(lead, { status: "qualified" as const, calendarEventId: "event", assignedTeam: "team_a" as const, bookedStart: "2026-08-24T08:00:00.000Z", quote: { amountRsd: 6500, baseRsd: 6500, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 } });
    await repository.saveLead(lead);
    const telegram = new FakeTelegramGateway();
    telegram.shouldFail = true;
    telegram.failureOutcome = "ambiguous";
    const service = new TrelloRecoveryService(repository, new TrelloSyncService(repository, new FakeTrelloGateway()), telegram, () => now);
    await service.enqueueBookingRecovery({ lead, replyLanguage: "en" });
    await expect(service.reconcileDueJobs(1)).resolves.toEqual({ claimed: 1, completed: 0, retried: 0, manual: 1 });
    expect(repository.operations.get(bookingConfirmationKey(lead))).toMatchObject({ status: "ambiguous" });
    now = new Date("2026-08-22T10:02:00.000Z");
    telegram.shouldFail = false;
    await service.reconcileDueJobs(1);
    expect(telegram.messages).toHaveLength(0);
  });

  it("retries a definite booking confirmation failure with the same stable tuple", async () => {
    let now = new Date("2026-08-22T10:00:00.000Z");
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 9010, firstMessageLanguage: "en", agentConfigVersion: 5 });
    Object.assign(lead, { status: "qualified" as const, calendarEventId: "event", assignedTeam: "team_a" as const, bookedStart: "2026-08-24T08:00:00.000Z", quote: { amountRsd: 6500, baseRsd: 6500, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 } });
    await repository.saveLead(lead);
    const telegram = new FakeTelegramGateway();
    telegram.shouldFail = true;
    const service = new TrelloRecoveryService(repository, new TrelloSyncService(repository, new FakeTrelloGateway()), telegram, () => now);
    await service.enqueueBookingRecovery({ lead, replyLanguage: "en" });
    await expect(service.reconcileDueJobs(1)).resolves.toMatchObject({ retried: 1 });
    now = new Date("2026-08-22T10:01:00.000Z");
    telegram.shouldFail = false;
    await expect(service.reconcileDueJobs(1)).resolves.toMatchObject({ completed: 1 });
    expect(telegram.messages).toHaveLength(1);
    expect(repository.operations.get(bookingConfirmationKey(lead))).toMatchObject({ status: "succeeded" });
  });

  it("clears a genuine temporary Trello flag and removes its label before Booked confirmation", async () => {
    const now = new Date("2026-08-22T10:00:00.000Z");
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 9004, firstMessageLanguage: "en", agentConfigVersion: 5 });
    Object.assign(lead, { status: "qualified" as const, calendarEventId: "event", assignedTeam: "team_a" as const, bookedStart: "2026-08-24T08:00:00.000Z", quote: { amountRsd: 6500, baseRsd: 6500, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 }, humanNeeded: true, humanNeededReason: "trello_unavailable" as const });
    await repository.saveLead(lead);
    const gateway = new FakeTrelloGateway();
    const sync = new TrelloSyncService(repository, gateway);
    // Model the first failed live path: a card exists and its temporary label is on.
    await sync.syncLead(lead, "qualified");
    await repository.saveLead({ ...lead, humanNeeded: true, humanNeededReason: "trello_unavailable" });
    const service = new TrelloRecoveryService(repository, sync, new FakeTelegramGateway(), () => now);
    await service.enqueueBookingRecovery({ lead, replyLanguage: "en" });
    await expect(service.reconcileDueJobs(1)).resolves.toMatchObject({ completed: 1 });
    expect(repository.getLead(9004)).toMatchObject({ status: "booked", humanNeeded: false, humanNeededReason: undefined });
    expect(gateway.labelUpdates.at(-1)).toMatchObject({ enabled: false });
  });

  it("uses the same Postgres uniqueness tuple as the webhook confirmation", async () => {
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 9005, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.calendarEventId = "event";
    const key = bookingConfirmationKey(lead);
    const first = await repository.createIntegrationOperation({ leadId: lead.id, provider: "telegram", operationType: "send_message", idempotencyKey: key });
    await repository.completeIntegrationOperation(key, "telegram-message-1");
    const sameTuple = await repository.createIntegrationOperation({ leadId: lead.id, provider: "telegram", operationType: "send_message", idempotencyKey: key });
    expect(first.isNew).toBe(true);
    expect(sameTuple).toMatchObject({ isNew: false, status: "succeeded" });
  });

  it.each(["pending", "done", "manual"] as const)("promotes qualified %s job into a fresh booked epoch", async (state) => {
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 9011, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    await repository.enqueueTrelloSyncJob({ leadId: lead.id, desiredLifecycle: "qualified", replyLanguage: "ru", now: "2026-08-22T08:00:00.000Z" });
    const job = repository.trelloSyncJobs.get(lead.id);
    if (!job) throw new Error("job missing");
    job.state = state;
    job.attemptCount = 4;
    job.humanNeededEscalated = true;
    job.lastErrorCode = "old_failure";
    job.leaseToken = "old-lease";
    job.leaseExpiresAt = "2026-08-22T09:00:00.000Z";
    lead.calendarEventId = "event";
    lead.assignedTeam = "team_a";
    lead.bookedStart = "2026-08-24T08:00:00.000Z";
    lead.bookedEnd = "2026-08-24T10:00:00.000Z";
    await repository.persistCalendarReservationWithTrelloJob({ lead, replyLanguage: "sr-Cyrl" });
    expect(repository.trelloSyncJobs.get(lead.id)).toMatchObject({
      desiredLifecycle: "booked", replyLanguage: "sr-Cyrl", state: "pending", attemptCount: 0,
      humanNeededEscalated: false, lastErrorCode: undefined, leaseToken: undefined, leaseExpiresAt: undefined,
    });
  });

  it.each(["done", "manual"] as const)("reopens a qualified %s job and lets a new worker sync and complete it", async (state) => {
    const now = new Date("2026-08-24T12:10:00.000Z");
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 9013, firstMessageLanguage: "en", agentConfigVersion: 5 });
    Object.assign(lead, {
      status: "qualified" as const,
      quoteValidity: "active" as const,
      quote: { amountRsd: 6500, baseRsd: 6500, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 },
    });
    await repository.saveLead(lead);
    await repository.enqueueTrelloSyncJob({ leadId: lead.id, desiredLifecycle: "qualified", replyLanguage: "en", now: "2026-08-24T12:00:00.000Z" });
    const stale = repository.trelloSyncJobs.get(lead.id);
    if (!stale) throw new Error("job missing");
    Object.assign(stale, {
      state,
      attemptCount: 4,
      humanNeededEscalated: true,
      lastErrorCode: "old_failure",
      leaseToken: "old-lease",
      leaseExpiresAt: "2026-08-24T12:05:00.000Z",
    });

    await repository.enqueueTrelloSyncJob({ leadId: lead.id, desiredLifecycle: "qualified", replyLanguage: "ru", now: now.toISOString() });
    expect(repository.trelloSyncJobs.get(lead.id)).toMatchObject({
      state: "pending", createdAt: now.toISOString(), attemptCount: 0, humanNeededEscalated: false,
      lastErrorCode: undefined, leaseToken: undefined, leaseExpiresAt: undefined,
    });

    const trello = new FakeTrelloGateway();
    const recovery = new TrelloRecoveryService(repository, new TrelloSyncService(repository, trello), new FakeTelegramGateway(), () => now);
    await expect(recovery.reconcileDueJobs(1)).resolves.toEqual({ claimed: 1, completed: 1, retried: 0, manual: 0 });
    expect(trello.creates).toHaveLength(1);
    expect(repository.trelloSyncJobs.get(lead.id)).toMatchObject({ state: "done" });
  });

  it.each(["pending", "done", "manual"] as const)("leaves existing booked %s job byte-for-byte unchanged", async (state) => {
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 9012, firstMessageLanguage: "en", agentConfigVersion: 5 });
    await repository.enqueueTrelloSyncJob({ leadId: lead.id, desiredLifecycle: "booked", replyLanguage: "ru", confirmationKey: "telegram:booking_confirmed:old", now: "2026-08-22T08:00:00.000Z" });
    const job = repository.trelloSyncJobs.get(lead.id);
    if (!job) throw new Error("job missing");
    Object.assign(job, { state, attemptCount: 3, humanNeededEscalated: true, lastErrorCode: "keep", leaseToken: "keep-lease", leaseExpiresAt: "2026-08-22T09:00:00.000Z", nextAttemptAt: "2026-08-22T08:30:00.000Z" });
    const snapshot = structuredClone(job);
    lead.calendarEventId = "new-event";
    lead.assignedTeam = "team_a";
    lead.bookedStart = "2026-08-24T08:00:00.000Z";
    lead.bookedEnd = "2026-08-24T10:00:00.000Z";
    await repository.persistCalendarReservationWithTrelloJob({ lead, replyLanguage: "sr-Latn" });
    expect(repository.trelloSyncJobs.get(lead.id)).toEqual(snapshot);
  });

  it("persists the recovery job at the Calendar boundary, so a webhook crash cannot lose an event", async () => {
    const now = new Date("2026-08-22T10:00:00.000Z");
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 9006, firstMessageLanguage: "en", agentConfigVersion: 5 });
    Object.assign(lead, { status: "qualified" as const, clientData: { cleaningType: "standard" as const, areaM2: 80, rooms: 2, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-24", urgency: "standard" as const }, quoteValidity: "active" as const, quote: { amountRsd: 6500, baseRsd: 6500, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 } });
    await repository.saveLead(lead);
    const trello = new FakeTrelloGateway();
    const telegram = new FakeTelegramGateway();
    const recovery = new TrelloRecoveryService(repository, new TrelloSyncService(repository, trello), telegram, () => now);
    const calendar = new FakeCalendarGateway();
    const reservation = new CalendarReservationService(repository, calendar, undefined, () => now,
      (savedLead, language) => recovery.enqueueLeadRecovery({ lead: savedLead, desiredLifecycle: "booked", replyLanguage: language }));
    const offer = await reservation.offerSlots(lead, "en");
    if (!offer.ok || !offer.slots[0]) throw new Error("expected fake slot");
    await reservation.reserveSlot(lead, offer.slots[0].token, "en");
    expect(calendar.creates).toHaveLength(1);
    expect(repository.trelloSyncJobs.get(lead.id)).toMatchObject({ desiredLifecycle: "booked", state: "pending" });
    // Model a process crash before finalizeReservationBooking: only recovery runs.
    await expect(recovery.reconcileDueJobs(1)).resolves.toMatchObject({ completed: 1 });
    expect(calendar.creates).toHaveLength(1);
    expect(telegram.messages).toHaveLength(1);
  });
});
