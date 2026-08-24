import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { DemoConsoleReadError, getDemoConsoleReadModel, type DemoConsoleReadRepository } from "@/lib/admin/demo-console-read-model";
import type { LiveTrelloProjectionReader } from "@/lib/admin/live-trello-projection";

const env = { TELEGRAM_BOT_TOKEN: "x", TELEGRAM_WEBHOOK_SECRET: "x", OPENAI_API_KEY: "x", COMPOSIO_API_KEY: "x", COMPOSIO_GOOGLE_CALENDAR_USER_ID: "x", COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID: "x", COMPOSIO_GOOGLE_CALENDAR_TOOLKIT_VERSION: "x", TEAM_A_CALENDAR_ID: "x", TEAM_B_CALENDAR_ID: "x", COMPOSIO_TRELLO_USER_ID: "x", COMPOSIO_TRELLO_CONNECTED_ACCOUNT_ID: "x", COMPOSIO_TRELLO_TOOLKIT_VERSION: "x", TRELLO_BOARD_ID: "x", TRELLO_HUMAN_NEEDED_LABEL_ID: "x", NEXT_PUBLIC_TRELLO_BOARD_URL: "https://trello.com/b/demo" } as unknown as NodeJS.ProcessEnv;
const now = () => new Date("2026-08-23T10:00:00.000Z");

describe("Demo Console dashboard snapshot", () => {
  it("builds activity and integration evidence only for the selected latest lead", async () => {
    const calls: string[] = [];
    const repo: DemoConsoleReadRepository = { async latestLead() { return lead; }, async activityForLead(id) { calls.push(`activity:${id}`); return [{ event_type: "booking_confirmed", created_at: "2026-08-23T09:00:00.000Z" }]; }, async operationsForLead(id) { calls.push(`operations:${id}`); return [{ provider: "openai", status: "succeeded", updated_at: "2026-08-23T09:00:00.000Z" }]; }, async trelloSyncForLead(id) { calls.push(`sync:${id}`); return null; } };
    const model = await getDemoConsoleReadModel(repo, env, now, liveTrello());
    expect(calls).toEqual(["activity:11111111-1111-4111-8111-111111111111", "operations:11111111-1111-4111-8111-111111111111", "sync:11111111-1111-4111-8111-111111111111"]);
    expect(model).toMatchObject({ snapshotKind: "application_snapshot", providerState: "not_live_checked", currentStatus: "terminal", latestLead: { businessReference: "SC-0001", cleaningType: "standard", areaM2: 75, customerLabel: "Mila Petrović", locationLabel: "Belgrade" } });
    expect(model.latestLead).not.toHaveProperty("id"); expect(model.latestLead).not.toHaveProperty("addressOrDistrict"); expect(model.latestLead?.trelloCardUrl).toBe("https://trello.com/c/abc123"); expect(JSON.stringify(model)).not.toContain("calendar-private-id"); expect(JSON.stringify(model)).not.toContain("12 Test Street"); expect(JSON.stringify(model)).not.toContain("telegram-user-name");
    expect(model.trelloBoard.cards).toEqual([{ title: "Mila Petrović · Belgrade · 75 m²", lifecycle: "booked", humanNeeded: false, cardUrl: "https://trello.com/c/abc123" }]);
  });
  it("distinguishes a new booking finalization from a real Trello retry", async () => {
    const finalizing = await getDemoConsoleReadModel(repository({ ...lead, status: "qualified", trello_card_id: null }), env, now, liveTrello());
    expect(finalizing.currentStatus).toBe("pending");
    expect(finalizing.currentStatusDetail).toBe("Finalizing booking in Trello");
    const recovery = await getDemoConsoleReadModel(repository({ ...lead, status: "qualified", trello_card_id: null }, { desired_lifecycle: "booked", state: "pending", attempt_count: 1, next_attempt_at: "2026-08-23T10:00:00.000Z", updated_at: "2026-08-23T09:00:00.000Z" }), env, now, liveTrello());
    expect(recovery.currentStatus).toBe("recovery");
    expect(recovery.currentStatusDetail).toBe("Retrying Trello sync");
    const waiting = await getDemoConsoleReadModel(repository({ ...lead, status: "new_lead", calendar_event_id: null, trello_card_id: null }, null), env, now, liveTrello());
    expect(waiting.currentStatus).toBe("waiting_customer");
  });
  it("does not turn a read failure into an empty successful snapshot", async () => {
    const unavailable: DemoConsoleReadRepository = { async latestLead() { throw new Error("network"); }, async activityForLead() { return []; }, async operationsForLead() { return []; }, async trelloSyncForLead() { return null; } };
    await expect(getDemoConsoleReadModel(unavailable, env, now)).rejects.toBeInstanceOf(DemoConsoleReadError);
  });
  it("keeps Human Needed above an otherwise terminal lifecycle", async () => {
    const model = await getDemoConsoleReadModel(repository({ ...lead, human_needed: true, human_needed_reason: "trello_unavailable" }, null), env, now, liveTrello());
    expect(model.currentStatus).toBe("human_needed");
  });
  it("marks an old pending provider operation for review instead of claiming it is live", async () => {
    const repo: DemoConsoleReadRepository = { async latestLead() { return { ...lead, status: "qualified", calendar_event_id: null, trello_card_id: null }; }, async activityForLead() { return []; }, async operationsForLead() { return [{ provider: "openai", status: "pending", updated_at: "2026-08-23T09:00:00.000Z" }]; }, async trelloSyncForLead() { return null; } };
    const model = await getDemoConsoleReadModel(repo, env, now, liveTrello());
    expect(model.currentStatusDetail).toBe("Operation needs review");
    expect(model.integrations.find((item) => item.id === "openai")).toMatchObject({ readiness: "attention", detail: "Operation needs review" });
  });
  it("does not report a booked lead as confirmed until its durable booking job finishes", async () => {
    const model = await getDemoConsoleReadModel(repository(lead, { desired_lifecycle: "booked", state: "confirmation_pending", attempt_count: 1, next_attempt_at: "2026-08-23T10:05:00.000Z", updated_at: "2026-08-23T09:59:00.000Z" }), env, now, liveTrello());
    expect(model.currentStatus).toBe("recovery");
    expect(model.currentStatusDetail).toBe("Retrying Trello sync");
    expect(model.latestLead?.bookingConfirmed).toBe(false);
  });
  it("treats a legacy booked lead without a job as confirmed", async () => {
    const model = await getDemoConsoleReadModel(repository(lead, null), env, now, liveTrello());
    expect(model.currentStatus).toBe("terminal");
    expect(model.currentStatusDetail).toContain("Booking confirmed");
    expect(model.latestLead?.bookingConfirmed).toBe(true);
  });
  it("uses the configured canonical Trello board URL for the dashboard action", async () => {
    const model = await getDemoConsoleReadModel(repository(lead), { ...env, TRELLO_BOARD_URL: "https://www.trello.com/b/fQIYMJl9/cleaning-autopilot-demo/" } as NodeJS.ProcessEnv, now, liveTrello());
    expect(model.trelloBoard.boardUrl).toBe("https://trello.com/b/fQIYMJl9/cleaning-autopilot-demo");
  });
  it("keeps direct Trello cards and all canonical columns independent from the Supabase lead lifecycle", async () => {
    const model = await getDemoConsoleReadModel(repository(lead), env, now, {
      async read() {
        return {
          state: "fresh",
          observedAt: "2026-08-23T10:00:00.000Z",
          cards: [
            { title: "Manual Done card", lifecycle: "done", humanNeeded: false },
            { title: "Manual Lost card", lifecycle: "lost", humanNeeded: false },
          ],
        };
      },
    });
    expect(model.trelloBoard).toMatchObject({ kind: "projection", freshness: "fresh", cards: [
      { title: "Manual Done card", lifecycle: "done" },
      { title: "Manual Lost card", lifecycle: "lost" },
    ] });
    expect(JSON.stringify(model.trelloBoard)).not.toContain("calendar-private-id");
  });
});
type TestLead = { id: string; business_reference: string; status: "new_lead" | "qualified" | "booked" | "done" | "lost"; client_data: { cleaningType?: "standard" | "deep"; areaM2?: number; rooms?: number; bathrooms?: number; preferredDate?: string; addressOrDistrict?: string }; customer_display_name?: string | null; human_needed: boolean; human_needed_reason: string | null; quoted_price_rsd: number | null; assigned_team: "team_a" | "team_b" | null; booked_start: string | null; calendar_event_id: string | null; trello_card_id: string | null; trello_card_url?: string | null; updated_at: string };
const lead: TestLead = { id: "11111111-1111-4111-8111-111111111111", business_reference: "SC-0001", status: "booked", client_data: { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 2, preferredDate: "2026-08-24", addressOrDistrict: "12 Test Street, Belgrade" }, customer_display_name: "Mila Petrović", human_needed: false, human_needed_reason: null, quoted_price_rsd: 6500, assigned_team: "team_a", booked_start: "2026-08-24T08:00:00.000Z", calendar_event_id: "calendar-private-id", trello_card_id: "trello-private-id", trello_card_url: "https://trello.com/c/abc123/card-slug", updated_at: "2026-08-23T09:00:00.000Z" };
function repository(row: TestLead, sync: { desired_lifecycle: "qualified" | "booked"; state: "pending" | "calendar_pending" | "confirmation_pending" | "done" | "manual"; attempt_count: number; next_attempt_at: string; updated_at: string } | null = { desired_lifecycle: "booked", state: "pending", attempt_count: 0, next_attempt_at: "2026-08-23T10:00:00.000Z", updated_at: "2026-08-23T09:00:00.000Z" }): DemoConsoleReadRepository { return { async latestLead() { return row; }, async activityForLead() { return []; }, async operationsForLead() { return []; }, async trelloSyncForLead() { return sync; } }; }
function liveTrello(): LiveTrelloProjectionReader { return { async read() { return { state: "fresh", observedAt: "2026-08-23T10:00:00.000Z", cards: [{ title: "Mila Petrović · Belgrade · 75 m²", lifecycle: "booked", humanNeeded: false, directUrl: "https://trello.com/c/abc123" }] }; } }; }
