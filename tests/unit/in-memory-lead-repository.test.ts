import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryLeadRepository } from "@/lib/leads/in-memory-repository";

const update = (updateId: number, telegramChatId = 1001) => ({
  updateId,
  telegramChatId,
  telegramMessageId: updateId + 100,
  payload: {},
});

describe("InMemoryLeadRepository Telegram claims", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets N+1 claim when the older update failed, even if its chat lease was not released", async () => {
    const repository = new InMemoryLeadRepository();

    await expect(repository.claimTelegramUpdate(update(100))).resolves.toBe("claimed");
    await repository.markTelegramUpdateFailed(100, "processing_error");

    await expect(repository.claimTelegramUpdate(update(101))).resolves.toBe("claimed");
  });

  it("lets N+1 claim when the older update was processed but its chat lease was not released", async () => {
    const repository = new InMemoryLeadRepository();

    await expect(repository.claimTelegramUpdate(update(150))).resolves.toBe("claimed");
    await repository.markTelegramUpdateProcessed(150);

    await expect(repository.claimTelegramUpdate(update(151))).resolves.toBe("claimed");
  });

  it("lets N+1 claim when the older received update and its chat lease expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T10:00:00.000Z"));
    const repository = new InMemoryLeadRepository();

    await expect(repository.claimTelegramUpdate(update(200))).resolves.toBe("claimed");
    vi.advanceTimersByTime(300_000);

    await expect(repository.claimTelegramUpdate(update(201))).resolves.toBe("claimed");
  });

  it("keeps N+1 in progress while the older received update has a live lease", async () => {
    const repository = new InMemoryLeadRepository();

    await expect(repository.claimTelegramUpdate(update(300))).resolves.toBe("claimed");
    await expect(repository.claimTelegramUpdate(update(301))).resolves.toBe("in_progress");
  });

  it("reclaims the same update after its processing lease expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T10:00:00.000Z"));
    const repository = new InMemoryLeadRepository();

    await expect(repository.claimTelegramUpdate(update(400))).resolves.toBe("claimed");
    vi.advanceTimersByTime(300_000);

    await expect(repository.claimTelegramUpdate(update(400))).resolves.toBe("claimed");
  });

  it("fences an older Trello worker when a later webhook turn reopens its projection", async () => {
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 5001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    const firstNow = "2026-08-24T12:00:00.000Z";
    await repository.enqueueTrelloSyncJob({ leadId: lead.id, desiredLifecycle: "qualified", replyLanguage: "en", now: firstNow });
    const firstClaim = await repository.claimDueTrelloSyncJobs({
      now: firstNow,
      limit: 1,
      leaseToken: "worker-old",
      leaseSeconds: 300,
    });
    expect(firstClaim).toHaveLength(1);

    const reopenedNow = "2026-08-24T12:00:01.000Z";
    await repository.enqueueTrelloSyncJob({ leadId: lead.id, desiredLifecycle: "qualified", replyLanguage: "ru", now: reopenedNow });
    expect(repository.trelloSyncJobs.get(lead.id)).toMatchObject({
      state: "pending",
      replyLanguage: "ru",
      createdAt: reopenedNow,
      attemptCount: 0,
      humanNeededEscalated: false,
      lastErrorCode: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    await expect(repository.completeTrelloSyncJob({ leadId: lead.id, leaseToken: "worker-old" })).rejects.toThrow(/lease lost/i);

    const freshClaim = await repository.claimDueTrelloSyncJobs({
      now: reopenedNow,
      limit: 1,
      leaseToken: "worker-new",
      leaseSeconds: 300,
    });
    expect(freshClaim).toHaveLength(1);
    await expect(repository.completeTrelloSyncJob({ leadId: lead.id, leaseToken: "worker-new" })).resolves.toBeUndefined();
  });

  it.each(["done", "manual"] as const)("reopens a %s qualified projection as a fresh worker epoch", async (state) => {
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 5002, firstMessageLanguage: "en", agentConfigVersion: 5 });
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

    const reopenedNow = "2026-08-24T12:10:00.000Z";
    await repository.enqueueTrelloSyncJob({ leadId: lead.id, desiredLifecycle: "qualified", replyLanguage: "ru", now: reopenedNow });
    expect(repository.trelloSyncJobs.get(lead.id)).toMatchObject({
      desiredLifecycle: "qualified",
      replyLanguage: "ru",
      state: "pending",
      createdAt: reopenedNow,
      attemptCount: 0,
      humanNeededEscalated: false,
      lastErrorCode: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
  });

  it("does not downgrade or reset an existing booked job when qualified is requeued", async () => {
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 5003, firstMessageLanguage: "en", agentConfigVersion: 5 });
    await repository.enqueueTrelloSyncJob({
      leadId: lead.id,
      desiredLifecycle: "booked",
      replyLanguage: "sr-Cyrl",
      confirmationKey: "telegram:booking_confirmed:kept",
      now: "2026-08-24T12:00:00.000Z",
    });
    const booked = repository.trelloSyncJobs.get(lead.id);
    if (!booked) throw new Error("job missing");
    Object.assign(booked, {
      state: "confirmation_pending" as const,
      attemptCount: 3,
      humanNeededEscalated: true,
      nextAttemptAt: "2026-08-24T12:30:00.000Z",
      lastErrorCode: "telegram_confirmation_retryable",
      leaseToken: "booked-worker",
      leaseExpiresAt: "2026-08-24T12:35:00.000Z",
    });
    const snapshot = structuredClone(booked);

    await repository.enqueueTrelloSyncJob({ leadId: lead.id, desiredLifecycle: "qualified", replyLanguage: "ru", now: "2026-08-24T12:10:00.000Z" });
    expect(repository.trelloSyncJobs.get(lead.id)).toEqual(snapshot);
  });
});
