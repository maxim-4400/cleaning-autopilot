import { describe, expect, it } from "vitest";

import { isFocusedModelIntakeFollowup } from "@/lib/telegram/intake-focus";
import { normalizeTelegramVisibleText } from "../support/conversation-sandbox";
import { renderQuoteReply } from "@/lib/telegram/renderer";

describe("model intake focus", () => {
  it("allows one topic or a related pair in independent transcript fixtures", () => {
    expect(isFocusedModelIntakeFollowup("Какая примерно площадь и какой тип уборки вам нужен?")).toBe(true);
    expect(isFocusedModelIntakeFollowup("Сколько комнат и санузлов в квартире?")).toBe(true);
    expect(isFocusedModelIntakeFollowup("Есть ли сильная шерсть животных или нужны окна?")).toBe(true);
    expect(isFocusedModelIntakeFollowup("What type of cleaning and approximate area do you need?")).toBe(true);
    expect(isFocusedModelIntakeFollowup("Koliko soba i kupatila ima stan?")).toBe(true);
  });

  it("rejects the real mixed service-and-layout smoke reply", () => {
    expect(isFocusedModelIntakeFollowup("Для расчёта уточните, нужна стандартная или генеральная уборка, и сколько комнат с санузлами в квартире?")).toBe(false);
  });

  it("rejects the original multi-topic intake dump without treating adjective forms as requests", () => {
    expect(isFocusedModelIntakeFollowup("Мне нужны тип уборки, площадь, комнаты, санузлы, шерсть животных, дополнительные услуги, район и дата.")).toBe(false);
    expect(isFocusedModelIntakeFollowup("С нужным типом уборки уже всё ясно.")).toBe(true);
  });

  it.each([
    "Осталось уточнить тип уборки, площадь, комнаты, санузлы, шерсть и дополнительные услуги.",
    "I need to clarify the cleaning type, area, rooms, bathrooms, pet hair and extras.",
    "Treba mi da razjasnim vrstu čišćenja, površinu, sobe, kupatila, dlake i dodatne usluge.",
  ])("rejects a form dump even when it is not phrased as a direct question: %s", (reply) => {
    expect(isFocusedModelIntakeFollowup(reply)).toBe(false);
  });

  it.each([
    "Тип уборки, площадь, комнаты, санузлы, шерсть животных и дополнительные услуги.",
    "Cleaning type, area, rooms, bathrooms, pet hair and extra services.",
    "Vrsta čišćenja, površina, sobe, kupatila, dlake i dodatne usluge.",
  ])("rejects a trigger-free enumerative form dump: %s", (reply) => {
    expect(isFocusedModelIntakeFollowup(reply)).toBe(false);
  });

  it("keeps short natural explanatory prose with no more than two intake topics", () => {
    expect(isFocusedModelIntakeFollowup("Могу помочь с типом уборки и примерной площадью.")).toBe(true);
    expect(isFocusedModelIntakeFollowup("I can explain whether windows are an extra service.")).toBe(true);
    expect(isFocusedModelIntakeFollowup("Mogu da objasnim cenu za dodatne usluge.")).toBe(true);
    expect(isFocusedModelIntakeFollowup("I have updated the area for your standard cleaning to 55 m2.")).toBe(true);
    expect(isFocusedModelIntakeFollowup(normalizeTelegramVisibleText(renderQuoteReply("ru", 4_000, { sameDayAmountRsd: 4_800 }).text))).toBe(true);
    expect(isFocusedModelIntakeFollowup(normalizeTelegramVisibleText(renderQuoteReply("en", 4_000, { sameDayAmountRsd: 4_800 }).text))).toBe(true);
  });
});
