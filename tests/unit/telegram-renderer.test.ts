import { describe, expect, it } from "vitest";

import type { AvailabilitySlot } from "@/lib/contracts/domain";
import {
  renderAgentReply,
  renderBookingConfirmedReply,
  renderCalendarReservationFailedReply,
  renderHumanNeededReply,
  renderNewAddressDivider,
  renderNoAvailabilityReply,
  renderQuoteReply,
  renderReservationReply,
  renderSlotOfferReply,
  renderStaleSlotReply,
} from "@/lib/telegram/renderer";

describe("Telegram renderer", () => {
  it("falls back after unsafe-artifact filtering and caps ordinary agent prose at Telegram's text limit", () => {
    expect(renderAgentReply("Qualified", "en").text).toBe("Thanks. I’ve noted that. Could you share a little more detail?");

    const rendered = renderAgentReply("a".repeat(5000), "en");
    expect(Array.from(rendered.text)).toHaveLength(4096);
    expect(rendered.text.endsWith("…")).toBe(true);
  });

  it("falls back when ordinary agent prose is in a different script from the reply locale", () => {
    expect(renderAgentReply("Здравствуйте", "en").text).toContain("Thanks");
    expect(renderAgentReply("Hello", "ru").text).toContain("Спасибо");
    expect(renderAgentReply("Hello", "sr-Cyrl").text).toContain("Хвала");
    expect(renderAgentReply("Здраво", "sr-Latn").text).toContain("Hvala");
  });

  it("removes common raw Markdown forms before HTML escaping agent prose", () => {
    expect(renderAgentReply("# Hello\n> [Choose a slot](https://example.com)\n~~Ready~~ \\*now\\*", "en").text)
      .toBe("Hello\nChoose a slot\nReady now");
  });

  it("uses Russian backend copy for a BCP-47 Russian locale", () => {
    expect(renderQuoteReply("ru-RU", 8000).text).toContain("Уборка будет стоить");
    expect(renderNewAddressDivider("ru-RU").text).toBe("Новый адрес уборки");
    expect(renderSlotOfferReply("ru-RU", [{
      token: "11111111-1111-4111-8111-111111111111",
      offerId: "22222222-2222-4222-8222-222222222222",
      displayOrder: 1,
      team: "team_a",
      start: "2026-08-24T06:00:00.000Z",
      end: "2026-08-24T10:00:00.000Z",
      bufferEnd: "2026-08-24T10:30:00.000Z",
      label: "Команда A · пн, 24 авг., 08:00",
    }]).text).toContain("Ближайшее свободное время");
    expect(renderReservationReply("ru-RU").text).toContain("Время зарезервировано");
  });

  it("renders Russian slot and reservation templates without model markup", () => {
    const slot: AvailabilitySlot = {
      token: "11111111-1111-4111-8111-111111111111",
      offerId: "22222222-2222-4222-8222-222222222222",
      displayOrder: 1,
      team: "team_a",
      start: "2026-08-24T06:00:00.000Z",
      end: "2026-08-24T10:00:00.000Z",
      bufferEnd: "2026-08-24T10:30:00.000Z",
      label: "Команда A · пн, 24 авг., 08:00",
    };

    expect(renderSlotOfferReply("ru", [slot]).text).toBe(
      "<b>Ближайшее свободное время</b>\nВыберите кнопку ниже или ответьте номером варианта.\n\n1. Команда A · пн, 24 авг., 08:00",
    );
    expect(renderReservationReply("ru").text).toBe(
      "<b>Время зарезервировано.</b>\n\nМы подготовим финальное подтверждение и продолжим с уже согласованными деталями.",
    );
  });

  it("renders full Serbian templates in the current script", () => {
    const slot: AvailabilitySlot = {
      token: "11111111-1111-4111-8111-111111111111",
      offerId: "22222222-2222-4222-8222-222222222222",
      displayOrder: 1,
      team: "team_a",
      start: "2026-08-24T06:00:00.000Z",
      end: "2026-08-24T10:00:00.000Z",
      bufferEnd: "2026-08-24T10:30:00.000Z",
      label: "Tim A · pon, 24. avg., 08:00",
    };

    expect(renderQuoteReply("sr-Latn", 8000).text).toContain("Čišćenje bi koštalo");
    expect(renderSlotOfferReply("sr-Latn", [slot]).text).toContain("Najbliži slobodni termini");
    expect(renderReservationReply("sr-Cyrl").text).toContain("Ваш термин је резервисан");
    expect(renderCalendarReservationFailedReply("sr-Latn").text).toContain("Nismo mogli bezbedno");
    expect(renderHumanNeededReply("sr-Cyrl").text).toContain("Проследићу детаље");
    expect(renderStaleSlotReply("sr-Latn").text).toContain("više nije dostupna");
    expect(renderNoAvailabilityReply("sr-Cyrl").text).toContain("наредне две недеље");
    expect(renderAgentReply("", "sr-Latn").text).toContain("Hvala");
  });

  it("encodes a bounded reply locale in Calendar callbacks", () => {
    const slot: AvailabilitySlot = {
      token: "11111111-1111-4111-8111-111111111111", offerId: "22222222-2222-4222-8222-222222222222",
      displayOrder: 1, team: "team_a", start: "2026-08-24T06:00:00.000Z", end: "2026-08-24T10:00:00.000Z",
      bufferEnd: "2026-08-24T10:30:00.000Z", label: "Тим А · пон, 24. авг., 08:00",
    };
    const markup = renderSlotOfferReply("sr-Cyrl", [slot]).replyMarkup;
    const callbackData = markup && "inline_keyboard" in markup ? markup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    expect(callbackData).toBe(`slot:sr-Cyrl:${slot.token}`);
    expect(callbackData?.length).toBeLessThanOrEqual(64);
  });

  it.each([
    ["en", "Team B"], ["ru", "Команда Б"], ["sr-Latn", "Tim B"], ["sr-Cyrl", "Тим Б"],
  ] as const)("renders final booking details in %s", (language, team) => {
    const rendered = renderBookingConfirmedReply({
      language,
      team: "team_b",
      start: "2026-08-24T08:00:00+02:00",
      quoteAmountRsd: 8_000,
    }).text;

    expect(rendered).toContain(team);
    expect(rendered).toContain("RSD");
    expect(rendered).toMatch(/24/);
    expect(rendered).toMatch(/08:00/);
  });
});
