import { afterEach, describe, expect, it, vi } from "vitest";

import { TelegramApiGateway } from "@/lib/telegram/gateway";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TelegramApiGateway", () => {
  it("uses Telegram HTML parse mode and supports typing and callback acknowledgement", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 42 } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new TelegramApiGateway("test-token");

    await expect(gateway.sendMessage({ chatId: 1001, text: "<b>Hello</b>" })).resolves.toEqual({ messageId: "42" });
    await gateway.sendTyping(1001);
    await gateway.answerCallbackQuery("callback-id");

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      chat_id: 1001,
      text: "<b>Hello</b>",
      parse_mode: "HTML",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ chat_id: 1001, action: "typing" });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ callback_query_id: "callback-id" });
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}
