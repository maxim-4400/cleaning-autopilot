import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const reconcileDueJobs = vi.fn();
vi.mock("@/lib/stage2/dependencies", () => ({
  getStage2Dependencies: () => ({ trelloRecovery: { reconcileDueJobs } }),
}));

import { POST } from "@/app/api/internal/trello-reconcile/route";

afterEach(() => {
  delete process.env.INTERNAL_RECONCILE_SECRET;
  reconcileDueJobs.mockReset();
});

describe("POST /api/internal/trello-reconcile", () => {
  it("rejects absent or malformed bearer credentials without revealing job data", async () => {
    process.env.INTERNAL_RECONCILE_SECRET = "test-reconcile-secret";
    const response = await POST(new Request("http://localhost/api/internal/trello-reconcile", { method: "POST" }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "unauthorized" });
    expect(reconcileDueJobs).not.toHaveBeenCalled();
  });

  it("bounds batch size and returns aggregate counts only", async () => {
    process.env.INTERNAL_RECONCILE_SECRET = "test-reconcile-secret";
    reconcileDueJobs.mockResolvedValue({ claimed: 2, completed: 1, retried: 1, manual: 0 });
    const response = await POST(new Request("http://localhost/api/internal/trello-reconcile?limit=2", {
      method: "POST",
      headers: { authorization: "Bearer test-reconcile-secret" },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, claimed: 2, completed: 1, retried: 1, manual: 0 });
    expect(reconcileDueJobs).toHaveBeenCalledWith(2);
  });

  it("rejects unbounded batch requests", async () => {
    process.env.INTERNAL_RECONCILE_SECRET = "test-reconcile-secret";
    const response = await POST(new Request("http://localhost/api/internal/trello-reconcile?limit=26", {
      method: "POST",
      headers: { authorization: "Bearer test-reconcile-secret" },
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "invalid_limit" });
  });
});
