import { describe, expect, it } from "vitest";

import { CachedLiveTrelloProjectionReader } from "@/lib/admin/live-trello-projection";
import type { TrelloBoardReader } from "@/lib/trello/gateway";

const boardCards = [
  { title: "New lead", lifecycle: "new_lead" as const, humanNeeded: false },
  { title: "Qualified lead", lifecycle: "qualified" as const, humanNeeded: true },
  { title: "Booked lead", lifecycle: "booked" as const, humanNeeded: false },
  { title: "Manual completed card", lifecycle: "done" as const, humanNeeded: false },
  { title: "Manual lost card", lifecycle: "lost" as const, humanNeeded: false },
];

describe("CachedLiveTrelloProjectionReader", () => {
  it("keeps all five lifecycle states from the live board, including cards created or moved manually", async () => {
    const reader = new CachedLiveTrelloProjectionReader({ async listBoardCards() { return boardCards; } });
    await expect(reader.read()).resolves.toMatchObject({ state: "fresh", cards: boardCards });
  });

  it("single-flights simultaneous refreshes and reuses a successful snapshot within the TTL", async () => {
    let now = 0;
    let resolveRead: ((cards: typeof boardCards) => void) | undefined;
    let calls = 0;
    const source: TrelloBoardReader = {
      async listBoardCards() {
        calls += 1;
        return new Promise<typeof boardCards>((resolve) => { resolveRead = resolve; });
      },
    };
    const reader = new CachedLiveTrelloProjectionReader(source, () => now, 30_000);
    const first = reader.read();
    const second = reader.read();
    expect(calls).toBe(1);
    resolveRead?.(boardCards);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { state: "fresh", cards: boardCards, observedAt: "1970-01-01T00:00:00.000Z" },
      { state: "fresh", cards: boardCards, observedAt: "1970-01-01T00:00:00.000Z" },
    ]);
    now = 10;
    await expect(reader.read()).resolves.toEqual({ state: "fresh", cards: boardCards, observedAt: "1970-01-01T00:00:00.000Z" });
    expect(calls).toBe(1);
  });

  it("keeps the last verified board as explicitly stale when a later provider read fails", async () => {
    let now = 0;
    let fail = false;
    const reader = new CachedLiveTrelloProjectionReader({
      async listBoardCards() {
        if (fail) throw new Error("provider unavailable");
        return boardCards;
      },
    }, () => now, 30_000);
    await reader.read();
    now = 30_001;
    fail = true;
    await expect(reader.read()).resolves.toEqual({ state: "stale", cards: boardCards, observedAt: "1970-01-01T00:00:00.000Z" });
  });

  it("does not invent an empty successful board when the first provider read fails", async () => {
    const reader = new CachedLiveTrelloProjectionReader({ async listBoardCards() { throw new Error("provider unavailable"); } });
    await expect(reader.read()).resolves.toEqual({ state: "unavailable", cards: [] });
  });
});
