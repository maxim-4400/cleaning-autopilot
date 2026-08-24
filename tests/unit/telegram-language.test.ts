import { describe, expect, it } from "vitest";

import { resolveReplyLanguage } from "@/lib/telegram/language";
import { resolveRelativePreferredDate } from "@/lib/telegram/webhook";

describe("resolveReplyLanguage", () => {
  it("distinguishes Russian and Serbian Cyrillic from their strong and domain signals", () => {
    expect(resolveReplyLanguage("Нужна уборка квартиры, пожалуйста")).toBe("ru");
    expect(resolveReplyLanguage("Треба ми чишћење стана, хвала")).toBe("sr-Cyrl");
  });

  it("recognizes Serbian Latin while keeping English as the safe fallback", () => {
    expect(resolveReplyLanguage("Treba mi čišćenje stana, hvala")).toBe("sr-Latn");
    expect(resolveReplyLanguage("cleaning apartment available")).toBe("en");
  });

  it("uses English for mixed, numeric, empty, unsupported, and conflicting text", () => {
    expect(resolveReplyLanguage("Need cleaning")).toBe("en");
    expect(resolveReplyLanguage("Нужна cleaning")).toBe("en");
    expect(resolveReplyLanguage("треба уборка")).toBe("en");
    expect(resolveReplyLanguage("123")).toBe("en");
    expect(resolveReplyLanguage("   ")).toBe("en");
    expect(resolveReplyLanguage("こんにちは")).toBe("en");
  });

  it("keeps a dominant Russian message Russian when local intake notation is Latin", () => {
    expect(resolveReplyLanguage("Нужна стандартная уборка после ремонта: 55 m², 2 комнаты, 1 санузел, район Vračar")).toBe("ru");
  });

  it("requires at least two non-strong domain signals", () => {
    expect(resolveReplyLanguage("stan")).toBe("en");
    expect(resolveReplyLanguage("стан")).toBe("en");
    expect(resolveReplyLanguage("уборка")).toBe("en");
  });
});

describe("deterministic relative dates", () => {
  const now = new Date("2026-08-24T22:30:00.000Z"); // 25 Aug in Belgrade
  it("resolves supported Russian, English and Serbian phrases in Belgrade time", () => {
    expect(resolveRelativePreferredDate("через 2 дня", now)).toBe("2026-08-27");
    expect(resolveRelativePreferredDate("in two days", now)).toBe("2026-08-27");
    expect(resolveRelativePreferredDate("za 3 dana", now)).toBe("2026-08-28");
    expect(resolveRelativePreferredDate("послезавтра", now)).toBe("2026-08-27");
  });
  it("does not turn unsupported or negated language into a booking date", () => {
    expect(resolveRelativePreferredDate("not tomorrow", now)).toBeUndefined();
    expect(resolveRelativePreferredDate("some time next week", now)).toBeUndefined();
  });
});
