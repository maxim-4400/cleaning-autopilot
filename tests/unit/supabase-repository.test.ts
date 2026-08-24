import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SupabaseLeadRepository } from "@/lib/leads/supabase-repository";
import type { StoredLead } from "@/lib/leads/repository";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SupabaseLeadRepository", () => {
  it("uses the replacement RPC even for an empty offer so prior choices are superseded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseLeadRepository({ url: "https://example.supabase.co", secretKey: "test-secret" });

    await repository.saveCalendarSlotOffer({
      leadId: "11111111-1111-4111-8111-111111111111",
      offerId: "22222222-2222-4222-8222-222222222222",
      issuedAt: "2026-08-24T06:00:00.000Z",
      tokens: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://example.supabase.co/rest/v1/rpc/replace_calendar_slot_offer");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ p_slots: [] });
  });

  it("persists the Trello card id through the server-side repository", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{}]), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseLeadRepository({ url: "https://example.supabase.co", secretKey: "test-secret" });
    const lead: StoredLead = {
      id: "11111111-1111-4111-8111-111111111111",
      telegramChatId: 1001,
      activeInChat: true,
      firstMessageLanguage: "und",
      businessReference: "SC-1234ABCDEF567890",
      status: "qualified",
      clientData: {},
      agentConfigVersion: 5,
      humanNeeded: false,
      trelloCardId: "trello-private-card-1",
    };

    await repository.saveLead(lead);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      trello_card_id: "trello-private-card-1",
    });
  });

  it("uses lease-fenced RPCs for the Trello recovery outbox", async () => {
    const responseBody = [{
      lead_id: "11111111-1111-4111-8111-111111111111",
      desired_lifecycle: "booked",
      reply_language: "en",
      confirmation_key: "telegram:booking_confirmed:lead:event",
      state: "pending",
      created_at: "2026-08-22T10:00:00.000Z",
      attempt_count: 0,
      human_needed_escalated: false,
      next_attempt_at: "2026-08-22T10:00:00.000Z",
      lease_token: "22222222-2222-4222-8222-222222222222",
      lease_expires_at: "2026-08-22T10:01:00.000Z",
    }];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(responseBody), {
      headers: { "content-type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const repository = new SupabaseLeadRepository({ url: "https://example.supabase.co", secretKey: "test-secret" });

    await repository.enqueueTrelloSyncJob({
      leadId: "11111111-1111-4111-8111-111111111111",
      desiredLifecycle: "booked",
      replyLanguage: "en",
      confirmationKey: "telegram:booking_confirmed:lead:event",
      now: "2026-08-22T10:00:00.000Z",
    });
    const jobs = await repository.claimDueTrelloSyncJobs({
      now: "2026-08-22T10:00:00.000Z", limit: 10, leaseToken: "22222222-2222-4222-8222-222222222222", leaseSeconds: 60,
    });

    expect(jobs).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("rpc/enqueue_trello_sync_job");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("rpc/claim_due_trello_sync_jobs");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ p_limit: 10, p_lease_seconds: 60 });
  });

  it("treats a zero-row completion RPC as a lost lease", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([]), {
      headers: { "content-type": "application/json" },
    })));
    const repository = new SupabaseLeadRepository({ url: "https://example.supabase.co", secretKey: "test-secret" });
    await expect(repository.completeTrelloSyncJob({
      leadId: "11111111-1111-4111-8111-111111111111",
      leaseToken: "22222222-2222-4222-8222-222222222222",
    })).rejects.toThrow(/lost its lease/i);
  });
});
