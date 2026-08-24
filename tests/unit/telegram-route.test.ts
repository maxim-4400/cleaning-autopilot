import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dependencies: {},
  processTelegramWebhook: vi.fn(),
}));

vi.mock("@/lib/env/server", () => ({
  IntegrationConfigurationError: class IntegrationConfigurationError extends Error {},
  getTelegramEnvironment: () => ({ TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret" }),
}));

vi.mock("@/lib/stage2/dependencies", () => ({
  getStage2Dependencies: () => mocks.dependencies,
}));

vi.mock("@/lib/telegram/webhook", () => ({
  processTelegramWebhook: mocks.processTelegramWebhook,
}));

import { POST } from "@/app/api/webhooks/telegram/route";

describe("POST /api/webhooks/telegram", () => {
  it("returns 200 when stale callback containment is processed", async () => {
    mocks.processTelegramWebhook.mockResolvedValueOnce({ kind: "processed" });

    const response = await POST(new Request("https://example.test/api/webhooks/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 901,
        callback_query: {
          id: "stale-callback",
          data: "slot:en:11111111-1111-4111-8111-111111111111",
          message: { message_id: 902, chat: { id: 903 } },
        },
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, result: "processed" });
  });
});
