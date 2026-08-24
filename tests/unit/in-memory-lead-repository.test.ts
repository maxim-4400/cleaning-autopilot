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
});
