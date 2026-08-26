import { describe, expect, it } from "vitest";

import {
  hasSemanticTool,
  hasStockFillerReply,
  isSafeCustomerReply,
  isFocusedIntakeReply,
  isTransportAndInternalSafeReply,
  isTrustedTelegramTransport,
  normalizeTelegramVisibleText,
  runConversationScenario,
  scenarioPricingRules,
  standardDetails,
  type ConversationScenario,
  type SandboxAgentTurn,
} from "../support/conversation-sandbox";
import { liveConversationScenarios } from "../support/conversation-live-scenarios";

const full = (patch = {}) => ({ ...standardDetails, ...patch });
const turn = (reply: string, patch?: SandboxAgentTurn["patch"], action?: SandboxAgentTurn["action"]): SandboxAgentTurn => ({ reply, patch, action });
const fixture = (id: string, customerMessages: string[], agentTurns: SandboxAgentTurn[], expected: ConversationScenario["expected"], agentTurnLimit = Math.min(8, Math.max(customerMessages.length, 1))): ConversationScenario => ({
  id, customerMessages, agentTurns, agentTurnLimit, expected,
});

const scenarios: ConversationScenario[] = [
  fixture("ru-price-no-booking", ["Привет, что вы умеете?", "Можно сначала узнать цену?", "Квартира в Врачаре, 50 м².", "Обычная уборка.", "Две комнаты.", "Один санузел.", "Кота нет.", "Без допуслуг."], [
    turn("Здравствуйте! Помогу рассчитать стоимость и подобрать время для уборки. Что именно хотите узнать?"),
    turn("Да, точную цену можно узнать до выбора времени. Какая уборка нужна и какая примерно площадь?"),
    turn("Для квартиры 50 м² в Врачаре уточните, пожалуйста, обычная это уборка или генеральная.", { areaM2: 50, addressOrDistrict: "Врачар" }), turn("Хорошо. Сколько комнат и санузлов в квартире?", { cleaningType: "standard" }),
    turn("Записал две комнаты. Сколько санузлов?", { rooms: 2 }), turn("Есть ли сильная шерсть животных или дополнительные услуги?", { bathrooms: 1 }),
    turn("Понял. Нужны ли окна, духовка, холодильник или балкон?", { heavyPetHair: false }), turn("Теперь могу посчитать точную стоимость.", { cleaningType: "standard", areaM2: 50, rooms: 2, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар" }, "quote"),
  ], { quote: true, calendarCreates: 0, replyLanguage: "ru", checkpoints: ["quote"] }),
  fixture("ru-correction-date-booking", ["Нужна обычная уборка 50 м² в Врачаре.", "Две комнаты, один санузел, без шерсти и допуслуг.", "Сколько получится?", "Стоп, площадь 90 м².", "Через два дня.", "А вечером есть?", "1", "Спасибо, жду."], [
    turn("Помогу. Уточню пару деталей и рассчитаю стоимость."),
    turn("Записал параметры квартиры и сразу посчитал стоимость.", { cleaningType: "standard", areaM2: 50, rooms: 2, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар" }, "quote"),
    turn("Да, базовая цена остаётся актуальной, пока параметры не изменятся."),
    turn("Исправляю площадь на 90 м² и пересчитываю сумму.", { areaM2: 90 }, "quote"),
    // A changed date invalidates the previous quote. The scripted deterministic
    // stand-in mirrors the allowed terminal re-quote; the following evening
    // question is then a typed semantic Calendar request.
    turn("Дата через два дня записана, пересчитываю сумму.", { preferredDate: "2026-08-26" }, "quote"),
  ], { quote: true, calendarCreates: 1, slotOffer: true, replyLanguage: "ru", checkpoints: ["quote", "slots", "reservation"], evening90m2Slot: true }, 8),
  fixture("ru-conversational-availability", ["Хочу уборку квартиры.", "Обычная, 75 м², Врачар.", "Три комнаты.", "Один санузел.", "Без шерсти и допуслуг, 26 августа.", "А в середине дня есть?", "А вечером?", "2"], [
    turn("Конечно. Это обычная или генеральная уборка, и какая примерно площадь?"), turn("Сколько комнат и санузлов в квартире?", { cleaningType: "standard", areaM2: 75, addressOrDistrict: "Врачар" }), turn("Сколько санузлов в квартире?", { rooms: 3 }), turn("Осталось уточнить шерсть и дополнительные услуги.", { bathrooms: 1 }), turn("Сейчас посчитаю точную стоимость.", full({ addressOrDistrict: "Врачар" }), "quote"),
  ], { quote: true, slotOffer: true, calendarCreates: 1, replyLanguage: "ru", checkpoints: ["quote", "slots", "reservation"] }),
  fixture("ru-renovation-human", ["Нужна уборка после ремонта, 80 м², Врачар.", "Три комнаты.", "Два санузла.", "На 26 августа.", "И нужны окна.", "Можете передать человеку?"], [
    turn("После ремонта нужен индивидуальный расчёт. Я сохраню известные детали и передам заявку команде.", { areaM2: 80, addressOrDistrict: "Врачар" }, "human"), turn("Добавлю три комнаты к заявке.", { rooms: 3 }), turn("Добавлю два санузла.", { bathrooms: 2 }), turn("Записал желаемую дату.", { preferredDate: "2026-08-26" }), turn("Отмечу окна для команды.", { extras: ["windows"] }), turn("Да, команда продолжит с уже сохранёнными деталями."),
  ], { humanNeeded: true, calendarCreates: 0, replyLanguage: "ru", checkpoints: ["human_needed"] }),
  fixture("sr-latn-booking", ["Treba mi čišćenje.", "Standardno, 70 m2 u Zemunu.", "Dve sobe.", "Jedno kupatilo.", "Nema mnogo dlaka.", "Bez dodataka, 26. avgusta.", "Pokaži slobodne termine.", "2"], [
    turn("Naravno. Da li vam treba standardno ili detaljno čišćenje i kolika je površina?"), turn("Za standardno čišćenje od 70 m² u Zemunu, koliko soba i kupatila ima stan?", { cleaningType: "standard", areaM2: 70, addressOrDistrict: "Zemun" }), turn("Koliko kupatila ima stan?", { rooms: 2 }), turn("Da li ima mnogo dlaka kućnih ljubimaca?", { bathrooms: 1 }), turn("Da li su potrebne dodatne usluge?", { heavyPetHair: false }), turn("Sada mogu da izračunam tačnu cenu.", full({ areaM2: 70, rooms: 2, bathrooms: 1, addressOrDistrict: "Zemun" }), "quote"),
  ], { quote: true, slotOffer: true, calendarCreates: 1, replyLanguage: "sr-Latn", checkpoints: ["quote", "slots", "reservation"] }),
  fixture("en-explore-correction-no-booking", ["What can you help with?", "Can I get a price before I choose a time?", "It is a 40 m2 flat in Dorcol.", "Standard cleaning.", "One room, one bathroom, no pet hair or extras, 26 August.", "Actually it is 55 m2.", "Why did the price change?"], [
    turn("I can estimate a one-time clean and find a time when you are ready. What would you like to arrange?"), turn("Yes, you can get the price before choosing a time. What type of cleaning and approximate area do you need?"), turn("For a 40 m² flat in Dorcol, is this a standard or deep clean?", { areaM2: 40, addressOrDistrict: "Dorcol" }), turn("How many rooms and bathrooms are there?", { cleaningType: "standard" }), turn("I have the details and will calculate the exact estimate.", full({ areaM2: 40, rooms: 1, bathrooms: 1, addressOrDistrict: "Dorcol" }), "quote"), turn("I’ll update the area to 55 m² and recalculate the exact amount.", { areaM2: 55 }, "quote"), turn("The backend recalculated the estimate because the area changed."),
  ], { quote: true, calendarCreates: 0, replyLanguage: "en", checkpoints: ["quote"] }),
  fixture("contextual-no", ["Do you also clean windows?", "No.", "A standard 50 m2 flat in Dorcol, one room, one bathroom, 26 August."], [turn("Yes, windows can be added. Would you like them included?"), turn("No problem, I’ll leave windows out. What type and size is the cleaning?", { extras: [] }), turn("I just need to know about pet hair before I calculate the estimate.", { cleaningType: "standard", areaM2: 50, rooms: 1, bathrooms: 1, addressOrDistrict: "Dorcol", preferredDate: "2026-08-26" })], { quote: false, calendarCreates: 0, replyLanguage: "en" }),
  fixture("repeat-known-facts", ["Standard 75 m2 in Vracar.", "It is still 75 m2, as I said.", "Three rooms, one bathroom, no pet hair or extras, 26 August."], [turn("How many rooms and bathrooms are there?", { cleaningType: "standard", areaM2: 75, addressOrDistrict: "Vracar" }), turn("You already told me the area, so I only need rooms and bathrooms."), turn("I’ll calculate the exact estimate now.", full(), "quote")], { quote: true, calendarCreates: 0, replyLanguage: "en", checkpoints: ["quote"] }),
  fixture("weekend-saturday-sunday", ["Хочу уборку на выходных.", "Воскресенье лучше.", "Да, суббота тоже подойдет."], [], { quote: false, calendarCreates: 0, replyLanguage: "ru" }),
  fixture("same-day", ["Нужна уборка сегодня.", "Обычная 50 м², одна комната, один санузел, Врачар, без шерсти и допуслуг.", "Почему цена выше?"], [turn("Помогу. Какая уборка нужна и какая примерно площадь?"), turn("Сейчас посчитаю стоимость на сегодня.", full({ areaM2: 50, rooms: 1, bathrooms: 1, addressOrDistrict: "Врачар", preferredDate: "2026-08-24" }), "quote"), turn("Для уборки сегодня действует срочная наценка 20 процентов, поэтому backend пересчитал сумму.")], { quote: true, calendarCreates: 0, replyLanguage: "ru", checkpoints: ["quote", "same_day"] }),
  fixture("sofa-carpet", ["Can you clean a sofa and carpet?", "It is in a 50 m2 flat in Dorcol.", "Thursday would suit me."], [turn("Sofa and carpet work needs a quick review from our team, so I’ll pass this on.", undefined, "human"), turn("I’ve added the flat and district.", { areaM2: 50, addressOrDistrict: "Dorcol" }), turn("I’ll add Thursday for the team to review.", { preferredDate: "2026-08-27" })], { humanNeeded: true, calendarCreates: 0, replyLanguage: "en", checkpoints: ["human_needed"] }),
  fixture("over-200-m2", ["Нужна уборка 240 м².", "Это квартира в Новом Белграде.", "На 26 августа."], [turn("Для такой площади нужен индивидуальный расчёт.", { areaM2: 240 }), turn("Район добавил к заявке.", { addressOrDistrict: "Новый Белград" }), turn("Дату добавил к заявке.", { preferredDate: "2026-08-26" })], { humanNeeded: true, calendarCreates: 0, replyLanguage: "ru", checkpoints: ["human_needed"] }),
  fixture("en-commercial", ["I need an office cleaned.", "It is 120 m2 in New Belgrade.", "Four rooms and two bathrooms."], [turn("Office cleaning needs a tailored plan, so a colleague will review it with you.", undefined, "human"), turn("I’ve added the size and district.", { areaM2: 120, addressOrDistrict: "New Belgrade" }), turn("I’ve added the room details for the team.", { rooms: 4, bathrooms: 2 })], { humanNeeded: true, calendarCreates: 0, replyLanguage: "en", checkpoints: ["human_needed"] }),
  fixture("ru-to-en-switch", ["Нужна обычная уборка 60 м² в Врачаре.", "I mean two rooms and one bathroom.", "Без шерсти и допуслуг, 26 августа."], [turn("Сколько комнат и санузлов в квартире?", { cleaningType: "standard", areaM2: 60, addressOrDistrict: "Врачар" }), turn("Комнаты и санузел записал. Есть ли сильная шерсть или дополнительные услуги?", { rooms: 2, bathrooms: 1 }), turn("Сейчас посчитаю стоимость.", full({ areaM2: 60, rooms: 2, bathrooms: 1, addressOrDistrict: "Врачар" }), "quote")], { quote: true, calendarCreates: 0, replyLanguage: "ru", checkpoints: ["quote"] }),
  fixture("sr-cyrillic", ["Треба ми чишћење.", "Стандардно, 60 m² у Земуну.", "Две собе, једно купатило, без додатака и много длака, 26. августа."], [turn("Наравно. Колика је приближно површина и која врста чишћења вам треба?"), turn("Колико соба и купатила има стан?", { cleaningType: "standard", areaM2: 60, addressOrDistrict: "Земун" }), turn("Сада могу да израчунам тачну цену.", full({ areaM2: 60, rooms: 2, bathrooms: 1, addressOrDistrict: "Земун" }), "quote")], { quote: true, calendarCreates: 0, replyLanguage: "sr-Cyrl", checkpoints: ["quote"] }),
  fixture("sr-latn-da", ["Treba mi čišćenje za vikend.", "Da.", "Standardno 50 m2, jedna soba, jedno kupatilo, Dorćol, bez dodataka."], [turn("Sada mogu da zabeležim detalje za procenu.")], { quote: false, calendarCreates: 0, replyLanguage: "sr-Latn" }),
  fixture("identity", ["Ты человек?", "Хорошо, нужна обычная уборка 50 м².", "Одна комната, один санузел, Дорчол, без шерсти и допуслуг, 26 августа."], [turn("Я цифровой помощник Sherlock Cleaning, но помогу оформить уборку. Какая площадь и тип уборки нужны?"), turn("Для 50 м² сколько комнат и санузлов?", { cleaningType: "standard", areaM2: 50 }), turn("Сейчас посчитаю точную стоимость.", full({ areaM2: 50, rooms: 1, bathrooms: 1, addressOrDistrict: "Дорчол" }), "quote")], { quote: true, calendarCreates: 0, replyLanguage: "ru", checkpoints: ["quote"] }),
  fixture("off-topic", ["Какая сегодня погода?", "Ладно, мне нужна уборка 50 м².", "Обычная, одна комната, один санузел, Врачар, без шерсти и допуслуг, 26 августа."], [turn("Я помогаю с уборкой и бронированием. Какой тип уборки и какая примерно площадь вам нужны?"), turn("Для 50 м² это обычная или генеральная уборка?", { areaM2: 50 }), turn("Сейчас посчитаю стоимость.", full({ areaM2: 50, rooms: 1, bathrooms: 1, addressOrDistrict: "Врачар" }), "quote")], { quote: true, calendarCreates: 0, replyLanguage: "ru", checkpoints: ["quote"] }),
  fixture("calendar-transport-failure", ["Standard 75 m2, 3 rooms, one bathroom, no pet hair or extras, Vracar, 26 August.", "Please show available times.", "Can someone help find another date?"], [turn("I’ll calculate the estimate first.", full(), "quote"), turn("I am checking the live calendar now.", undefined, "slots"), turn("The team has the request and will check another date.")], { quote: true, humanNeeded: true, calendarCreates: 0, replyLanguage: "en", checkpoints: ["quote", "human_needed"], calendarTransportFails: true }),
  fixture("provider-tool-limit", ["Нужна уборка 75 м² в Врачаре.", "Обычная, три комнаты, один санузел, без шерсти и допуслуг, 26 августа.", "Хорошо."], [turn("Сохраню детали и передам заявку команде, чтобы она продолжила без риска ошибки.", { areaM2: 75, addressOrDistrict: "Врачар" }, "human"), turn("Добавлю остальные детали для команды.", full({ addressOrDistrict: "Врачар" })), turn("Команда продолжит с сохранёнными деталями.")], { humanNeeded: true, calendarCreates: 0, replyLanguage: "ru", checkpoints: ["human_needed"] }),
];

function assertCheckpoints(scenario: ConversationScenario, artifact: Awaited<ReturnType<typeof runConversationScenario>>): void {
  for (const checkpoint of scenario.expected.checkpoints ?? []) {
    if (checkpoint === "quote") expect(artifact.lead.hasQuote).toBe(true);
    if (checkpoint === "slots") expect(artifact.slotOffer).toBe(true);
    if (checkpoint === "reservation") expect(artifact.calendarCreates).toBe(1);
    if (checkpoint === "human_needed") expect(artifact.lead.humanNeeded).toBe(true);
    if (checkpoint === "same_day") expect(artifact.lead.clientData.urgency).toBe("same_day");
  }
}

describe("conversation sandbox", () => {
  it("binds the shared S1 and S2 customer fixtures to the paid manifest", () => {
    for (const id of ["ru-price-no-booking", "ru-correction-date-booking"]) {
      const deterministic = scenarios.find((scenario) => scenario.id === id);
      const live = liveConversationScenarios.find((scenario) => scenario.id === id);
      expect(deterministic?.customerMessages).toEqual(live?.customerMessages);
      expect(deterministic?.agentTurnLimit).toBe(live?.agentTurnLimit);
      expect({
        hasQuote: deterministic?.expected.quote ?? false,
        humanNeeded: deterministic?.expected.humanNeeded ?? false,
        fakeCalendarCreates: deterministic?.expected.calendarCreates ?? 0,
        slotOffer: deterministic?.expected.slotOffer ?? false,
      }).toEqual(live?.expected);
      expect(deterministic?.expected.evening90m2Slot ?? false).toBe(live?.sandbox?.evening90m2Slot ?? false);
      if (id === "ru-correction-date-booking") expect(live?.checkpointExpectations).toHaveLength(8);
    }
  });
  it("rejects a model-style full intake checklist while allowing a focused paired question", () => {
    expect(isSafeCustomerReply("Какая примерно площадь и сколько комнат в квартире?")).toBe(true);
    expect(isSafeCustomerReply("Тип уборки: обычная\nПлощадь: 50 м²\nКомнаты: 2\nСанузлы: 1")).toBe(false);
    expect(isFocusedIntakeReply("Мне нужны тип уборки, площадь, комнаты, санузлы, шерсть животных, дополнительные услуги, район и дата.")).toBe(false);
    expect(isFocusedIntakeReply("Какая примерно площадь и сколько комнат в квартире?")).toBe(false);
    expect(isFocusedIntakeReply("Есть ли сильная шерсть животных или нужны окна?")).toBe(true);
    expect(isFocusedIntakeReply("Для обычной уборки 75 м² в Врачаре сколько комнат и санузлов?")).toBe(true);
    expect(isTransportAndInternalSafeReply("Коротко: помогу рассчитать цену и подобрать время." )).toBe(true);
    expect(hasStockFillerReply("Спасибо, я это отметил.")).toBe(true);
    expect(isTransportAndInternalSafeReply("# Internal\ncalculate_quote: 4000")).toBe(false);
  });

  it("accepts only typed renderer HTML and grades normalized visible text", () => {
    const typedQuote = "<b>Уборка будет стоить 4,000 RSD</b>\n\nЕсли всё подходит, я покажу ближайшее свободное время.";
    expect(isTrustedTelegramTransport(typedQuote, "template")).toBe(true);
    expect(normalizeTelegramVisibleText(typedQuote)).toBe("Уборка будет стоить 4,000 RSD Если всё подходит, я покажу ближайшее свободное время.");
    expect(isSafeCustomerReply(normalizeTelegramVisibleText(typedQuote))).toBe(true);
    expect(isTrustedTelegramTransport("<b>Я человек</b>", "agent")).toBe(false);
    expect(isSafeCustomerReply(normalizeTelegramVisibleText("&lt;b&gt;Я человек&lt;/b&gt;"))).toBe(false);
  });

  it("awaits an evaluator checkpoint after every processed customer message", async () => {
    const checkpoints: Array<{ completed: number; transcriptLength: number }> = [];
    await runConversationScenario({
      id: "atomic-checkpoints",
      customerMessages: ["Hello", "A 50 m2 flat", "Standard cleaning"],
      agentTurns: [turn("How can I help?"), turn("How many rooms are there?"), turn("How many bathrooms are there?")],
      agentTurnLimit: 3,
      expected: {},
    }, {
      afterCustomerMessage: async (checkpoint) => {
        checkpoints.push({ completed: checkpoint.customerMessagesCompleted, transcriptLength: checkpoint.artifact.transcript.length });
      },
    });
    expect(checkpoints).toEqual([{ completed: 1, transcriptLength: 1 }, { completed: 2, transcriptLength: 2 }, { completed: 3, transcriptLength: 3 }]);
  });

  it("runs the deadline guard before every customer message, not only inside the agent", async () => {
    const starts: number[] = [];
    await expect(runConversationScenario({
      id: "loop-deadline", customerMessages: ["Hello", "50 m2", "Standard cleaning"],
      agentTurns: [turn("How can I help?"), turn("How many rooms?"), turn("How many bathrooms?")], agentTurnLimit: 3, expected: {},
    }, {
      beforeCustomerMessage: ({ customerMessagesCompleted }) => {
        starts.push(customerMessagesCompleted);
        if (customerMessagesCompleted === 1) throw new Error("scenario_deadline_exceeded");
      },
    })).rejects.toThrow("scenario_deadline_exceeded");
    expect(starts).toEqual([0, 1]);
  });

  it("runs the 20-scenario manifest through real webhook orchestration without live adapters", async () => {
    const longScenarios = scenarios.filter((scenario) => scenario.customerMessages.length >= 6);
    const shortScenarios = scenarios.filter((scenario) => scenario.customerMessages.length < 6);
    expect(scenarios).toHaveLength(20);
    expect(longScenarios).toHaveLength(6);
    expect(shortScenarios).toHaveLength(14);
    expect(scenarios.every((scenario) => scenario.customerMessages.length >= 3 && scenario.customerMessages.length <= 8)).toBe(true);
    for (const scenario of scenarios) {
      const artifact = await runConversationScenario(scenario);
      expect(artifact.transcript).toHaveLength(scenario.customerMessages.length);
      const unsafeReply = artifact.transcript.find((item) => !item.trustedTransport || item.visibleText.length === 0 || !isSafeCustomerReply(item.visibleText));
      if (unsafeReply) throw new Error(`${scenario.id} produced an unsafe customer reply: ${unsafeReply.visibleText}`);
      expect(scenarioPricingRules(artifact).every((version) => version === 1)).toBe(true);
      expect(artifact.turns.length).toBeLessThanOrEqual(scenario.agentTurnLimit);
      expect(artifact.lead.hasQuote).toBe(scenario.expected.quote ?? false);
      expect(artifact.lead.humanNeeded, scenario.id).toBe(scenario.expected.humanNeeded ?? false);
      expect(artifact.calendarCreates, scenario.id).toBe(scenario.expected.calendarCreates ?? 0);
      assertCheckpoints(scenario, artifact);
    }
  });
  it("keeps S1 as a date-less base quote, discloses today pricing, and does not schedule", async () => {
    const artifact = await runConversationScenario(scenarios.find((scenario) => scenario.id === "ru-price-no-booking")!);
    expect(artifact.lead).toMatchObject({ hasQuote: true, quoteAmountRsd: 4_000, humanNeeded: false });
    expect(artifact.lead.clientData.preferredDate).toBeUndefined();
    expect(artifact.lead.clientData.urgency).toBeUndefined();
    expect(artifact.calendarCreates).toBe(0);
    expect(artifact.slotOffer).toBe(false);
    expect(artifact.transcript.at(-1)?.visibleText).toContain("4 000 RSD");
    expect(artifact.transcript.at(-1)?.visibleText).toContain("4 800 RSD");
    expect(artifact.transcript.at(-1)?.visibleText).toContain("Когда выберете дату");
  });
  it("binds all eight S2 checkpoints from quote through evening booking without a final side effect", async () => {
    const artifact = await runConversationScenario(scenarios.find((scenario) => scenario.id === "ru-correction-date-booking")!);
    expect(artifact.messageEvidence).toHaveLength(8);
    expect(artifact.messageEvidence[1]).toMatchObject({ quoteAmountRsd: 4_000, quoteState: "active", calendarCreates: 0, slotOfferCount: 0 });
    expect(artifact.messageEvidence[2]).toMatchObject({ quoteAmountRsd: 4_000, quoteState: "active", calendarCreates: 0, slotOfferCount: 0 });
    expect(artifact.messageEvidence[3]).toMatchObject({ quoteAmountRsd: 7_200, quoteState: "active", calendarCreates: 0, slotOfferCount: 0 });
    expect(artifact.messageEvidence[4]).toMatchObject({ preferredDate: "2026-08-26", calendarCreates: 0, calendarAvailabilityQueries: 2, slotOfferCount: 1, schedulingActions: [{ kind: "availability", dateReference: "exact_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" }] });
    expect(artifact.messageEvidence[5]).toMatchObject({ preferredDate: "2026-08-26", calendarCreates: 0, calendarAvailabilityQueries: 4, slotOfferCount: 2, schedulingActions: [{ kind: "availability", dateReference: "current_preferred_date", timePreference: "evening", timePreferenceMode: "explicit", relation: "fresh" }] });
    // Each semantic availability search reads Team A and Team B. Explicit
    // selection then rechecks the selected team's token before Calendar create.
    expect(artifact.messageEvidence[6]).toMatchObject({ calendarCreates: 1, calendarAvailabilityQueries: 5, slotOfferCount: 2 });
    expect(artifact.messageEvidence[7]).toMatchObject({ calendarCreates: 1, calendarAvailabilityQueries: 5, slotOfferCount: 2 });
    expect(artifact.turns[4]?.allowedTools).toContain("request_available_slots");
    expect(artifact.messageEvidence[4]?.semanticTools).toEqual(["request_available_slots"]);
    expect(artifact.messageEvidence[5]?.semanticTools).toEqual(["request_available_slots"]);
    expect(artifact.messageEvidence[6]?.semanticTools).toEqual([]);
    expect(artifact.messageEvidence[7]?.semanticTools).toEqual([]);
    expect(artifact.transcript[6]?.visibleText).toContain("26 августа");
    expect(artifact.transcript[6]?.visibleText).toContain("Команда А");
    expect(artifact.transcript[6]?.visibleText).toContain("7 200 RSD");
    expect(artifact.transcript[7]?.visibleText).toContain("уже зарезервировано");
  });
  it("requires the English 55 m² correction to replace the active quote before any booking flow", async () => {
    const artifact = await runConversationScenario(scenarios.find((scenario) => scenario.id === "en-explore-correction-no-booking")!);
    expect(artifact.messageEvidence[5]).toMatchObject({
      quoteAmountRsd: 4_400,
      quoteState: "active",
      calendarCreates: 0,
      slotOfferCount: 0,
      semanticTools: expect.toSatisfy((tools: string[]) =>
        JSON.stringify(tools) === JSON.stringify(["update_client_data", "calculate_quote"]) ||
        JSON.stringify(tools) === JSON.stringify(["update_client_data", "record_scheduling_decision", "calculate_quote"])),
    });
    expect(artifact.transcript[5]?.visibleText).toContain("4,400 RSD");
    expect(artifact.calendarCreates).toBe(0);
    expect(artifact.slotOffer).toBe(false);
  });
  it("retains only safe, sorted active slot starts while replacing prior availability generations", async () => {
    const laterSameDay = fixture("v33-later-same-day", [
      "Standard 75 m2, three rooms, one bathroom, no pet hair or extras, Vracar, 26 August, evening.",
      "Tomorrow.",
      "Tomorrow any time.",
      "None of those. Anything later on the same day?",
    ], [turn("I’ll calculate the estimate.", full({ preferredDate: "2026-08-26", preferredTimeWindow: "evening" }), "quote")], {
      quote: true, calendarCreates: 0, slotOffer: true, replyLanguage: "en",
    }, 4);
    const laterArtifact = await runConversationScenario(laterSameDay);
    expect(laterArtifact.calendarCreates).toBe(0);
    expect(laterArtifact.messageEvidence[3]).toMatchObject({
      calendarAvailabilityQueries: 6,
      schedulingActions: [{ kind: "availability", dateReference: "same_day_as_last_offer", timePreference: "any", timePreferenceMode: "preserve", relation: "later_than_last_offer" }],
    });
    expect(laterArtifact.messageEvidence[3]?.activeSlotStarts).toEqual([
      "2026-08-25T07:00:00.000Z", "2026-08-25T07:00:00.000Z", "2026-08-25T07:30:00.000Z",
    ]);
    expect(laterArtifact.messageEvidence[3]?.activeSlotStarts).toEqual([...laterArtifact.messageEvidence[3]?.activeSlotStarts ?? []].sort());
    expect(laterArtifact.messageEvidence[3]?.activeSlotStarts).not.toEqual(laterArtifact.messageEvidence[2]?.activeSlotStarts);
    expect(laterArtifact.messageEvidence[3]?.activeSlotStarts?.every((start) => !laterArtifact.messageEvidence[2]?.activeSlotStarts?.includes(start))).toBe(true);

    const afterHours = fixture("v33-after-hours", [
      "Нужна обычная уборка 50 м², одна комната, один санузел, Врачар, без шерсти и допуслуг, сегодня.",
      "Покажи свободные слоты сегодня.",
      "А если на завтра?",
      "А в этот же день после 19:00 есть?",
    ], [turn("Посчитаю стоимость.", full({ areaM2: 50, rooms: 1, bathrooms: 1, addressOrDistrict: "Врачар", preferredDate: "2026-08-24" }), "quote")], {
      quote: true, calendarCreates: 0, slotOffer: true, replyLanguage: "ru", now: "2026-08-24T19:42:00.000Z",
    }, 4);
    const afterArtifact = await runConversationScenario(afterHours);
    expect(afterArtifact.calendarCreates).toBe(0);
    expect(afterArtifact.messageEvidence[3]).toMatchObject({
      calendarAvailabilityQueries: 6,
      schedulingActions: [{ kind: "availability", dateReference: "same_day_as_last_offer", timePreference: "after", timePreferenceMode: "explicit", afterLocalTime: "19:00", relation: "fresh" }],
    });
    expect(afterArtifact.transcript[3]?.visibleText).toContain("В заданный промежуток в ближайшие две недели свободных слотов нет");
    // An explicit after-19 bound cannot fit this job. Keep the previously
    // offered generation selectable rather than silently substituting 17:30.
    expect(afterArtifact.messageEvidence[3]?.activeSlotStarts).toEqual(afterArtifact.messageEvidence[2]?.activeSlotStarts);

    const boundedRange = fixture("v33-bounded-range", [
      "Standard 55 m2, one room, one bathroom, no pet hair or extras, Dorcol, 26 August.",
      "What about between 10:00 and 16:00?",
      "No booking yet.",
    ], [turn("I’ll calculate the estimate.", full({ areaM2: 55, rooms: 1, bathrooms: 1, addressOrDistrict: "Dorcol", preferredDate: "2026-08-26" }), "quote")], {
      quote: true, calendarCreates: 0, slotOffer: true, replyLanguage: "en",
    }, 3);
    const rangeArtifact = await runConversationScenario(boundedRange);
    expect(rangeArtifact.calendarCreates).toBe(0);
    expect(rangeArtifact.messageEvidence[1]).toMatchObject({
      calendarAvailabilityQueries: 2,
      schedulingActions: [{ kind: "availability", dateReference: "current_preferred_date", timePreference: "range", timePreferenceMode: "explicit", afterLocalTime: "10:00", beforeLocalTime: "16:00", relation: "fresh" }],
    });
    expect(rangeArtifact.messageEvidence[1]?.activeSlotStarts).toEqual([
      "2026-08-26T08:00:00.000Z", "2026-08-26T08:00:00.000Z", "2026-08-26T08:30:00.000Z",
    ]);
    expect(rangeArtifact.messageEvidence[1]?.activeSlotStarts).toEqual([...rangeArtifact.messageEvidence[1]?.activeSlotStarts ?? []].sort());
    for (const evidence of rangeArtifact.messageEvidence) {
      expect(Object.keys(evidence).every((key) => [
        "provenance", "customerMessageNumber", "customer", "semanticTools", "schedulingActions", "quoteAmountRsd", "quoteState", "preferredDate", "preferredTimeWindow", "humanNeeded", "humanNeededReason", "calendarCreates", "calendarAvailabilityQueries", "slotOfferCount", "activeSlotStarts", "lastAvailabilityAttempt",
      ].includes(key))).toBe(true);
      expect(JSON.stringify(evidence.activeSlotStarts ?? [])).not.toMatch(/(?:token|offer|provider|payload|calendar[_-]?id)/iu);
    }
  });
  it("runs the typed scheduling-recovery matrix without losing quote facts or booking before final selection", async () => {
    const recovery = fixture("typed-recovery-matrix", [
      "Нужна обычная уборка 75 м² в Врачаре, 3 комнаты, 1 санузел, без шерсти и допуслуг, 26 августа.",
      "Покажи свободные слоты.",
      "А позже нет слотов?",
      "После 19:00.",
      "Тогда на следующий день вечером.",
      "1",
    ], [
      turn("Посчитаю точную стоимость и покажу время.", full({ addressOrDistrict: "Врачар" }), "quote"),
    ], { quote: true, slotOffer: true, calendarCreates: 1, replyLanguage: "ru", checkpoints: ["quote", "slots", "reservation"] });
    const artifact = await runConversationScenario(recovery);

    expect(artifact.turns).toHaveLength(5);
    expect(artifact.messageEvidence.slice(1, 5).every((evidence) => evidence.semanticTools.includes("request_available_slots"))).toBe(true);
    expect(artifact.lead.clientData).toMatchObject({
      cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1,
      heavyPetHair: false, extras: [], addressOrDistrict: "Врачар",
      preferredDate: "2026-08-27", preferredTimeWindow: "evening",
    });
    // New availability queries supersede old buttons, but none can create a
    // Calendar event until the customer explicitly selects the final option.
    expect(artifact.messageEvidence.slice(0, 5).map((evidence) => evidence.calendarCreates)).toEqual([0, 0, 0, 0, 0]);
    expect(artifact.messageEvidence.slice(0, 5).map((evidence) => evidence.slotOfferCount)).toEqual([0, 1, 2, 2, 3]);
    expect(artifact.messageEvidence[4]).toMatchObject({ preferredDate: "2026-08-27", calendarCreates: 0 });
    expect(artifact.messageEvidence[5]).toMatchObject({ calendarCreates: 1, preferredDate: "2026-08-27" });

    const pendingDate = fixture("typed-pending-date-yes", [
      "Нужна обычная уборка 75 м² в Врачаре, 3 комнаты, 1 санузел, без шерсти и допуслуг.",
      "Хочу уборку на выходных.",
      "Да.",
    ], [turn("Посчитаю стоимость и предложу время.", full({ addressOrDistrict: "Врачар" }), "quote")], {
      quote: true, slotOffer: true, calendarCreates: 0, replyLanguage: "ru", checkpoints: ["quote", "slots"],
    });
    const pendingArtifact = await runConversationScenario(pendingDate);
    expect(pendingArtifact.turns).toHaveLength(1);
    expect(pendingArtifact.lead.clientData).toMatchObject({ areaM2: 75, rooms: 3, bathrooms: 1, preferredDate: "2026-08-29" });
    expect(pendingArtifact.messageEvidence.map((evidence) => evidence.calendarCreates)).toEqual([0, 0, 0]);
    expect(pendingArtifact.messageEvidence.at(-1)).toMatchObject({ preferredDate: "2026-08-29", slotOfferCount: 1 });
  });
  it("retains useful later details after a Human Needed handoff without exposing another handoff tool or reply", async () => {
    const artifact = await runConversationScenario(scenarios.find((scenario) => scenario.id === "ru-renovation-human")!);
    expect(artifact.lead).toMatchObject({ humanNeeded: true, clientData: { rooms: 3, bathrooms: 2, extras: ["windows"] } });
    expect(artifact.turns.slice(1, -1).every((turn) => turn.allowedTools.length === 1 && turn.allowedTools[0] === "update_client_data")).toBe(true);
    expect(artifact.turns.at(-1)?.allowedTools).toEqual([]);
    expect(artifact.turns.slice(1).every((turn) => !turn.semanticTools.includes("mark_human_needed"))).toBe(true);
    expect(new Set(artifact.transcript.slice(1).map((line) => line.visibleText))).not.toContain(artifact.transcript[0]?.visibleText);
    expect(artifact.transcript.at(-1)?.visibleText).toContain("уже передали команде");
  });
  it("keeps sofa/carpet and commercial Human Needed follow-ups specific, bounded and non-repeating", async () => {
    const lateHandoffScenarios = [
      fixture("late-sofa-carpet", ["Can you clean a sofa and carpet?", "It is in a 50 m2 flat in Dorcol.", "The sofa has old stains.", "The carpet is wool.", "Can I get a rough price?", "Thursday would suit me."], [
        turn("Sofa and carpet work needs a review.", undefined, "human"), turn("I added the flat and district.", { areaM2: 50, addressOrDistrict: "Dorcol" }), turn("I noted the sofa condition."), turn("I noted the carpet material."), turn("Our team will prepare the price."), turn("I noted Thursday.", { preferredDate: "2026-08-27" }),
      ], { humanNeeded: true, calendarCreates: 0, replyLanguage: "en" }),
      fixture("late-commercial", ["I need an office cleaned.", "It is 120 m2 in New Belgrade.", "There are four rooms and two bathrooms.", "There is also a staff kitchen.", "Can you estimate the cost?", "Thursday afternoon would suit us."], [
        turn("Office cleaning needs a tailored plan.", undefined, "human"), turn("I added the size and district.", { areaM2: 120, addressOrDistrict: "New Belgrade" }), turn("I added the room details.", { rooms: 4, bathrooms: 2 }), turn("I noted the staff kitchen."), turn("Our team will prepare the price."), turn("I noted Thursday.", { preferredDate: "2026-08-27" }),
      ], { humanNeeded: true, calendarCreates: 0, replyLanguage: "en" }),
    ];
    for (const scenario of lateHandoffScenarios) {
      const artifact = await runConversationScenario(scenario);
      expect(artifact.lead).toMatchObject({ humanNeeded: true, clientData: { preferredDate: "2026-08-27" } });
      expect(artifact.messageEvidence.every((evidence) => evidence.semanticTools.filter((tool) => tool === "update_client_data").length <= 1)).toBe(true);
      expect(artifact.messageEvidence[4]?.semanticTools).toEqual([]);
      expect(artifact.transcript).toHaveLength(6);
      expect(artifact.transcript.every((line, index, transcript) => index === 0 || line.visibleText !== transcript[index - 1]?.visibleText)).toBe(true);
      expect(artifact.transcript[4]?.visibleText).toContain("automatic price");
      expect(artifact.transcript[5]?.visibleText).toContain("requested date");
    }
  });
  it("keeps Serbian named-date booking and a bare numeric slot confirmation in the session language", async () => {
    const artifact = await runConversationScenario(scenarios.find((scenario) => scenario.id === "sr-latn-booking")!);
    expect(artifact.lead.clientData.preferredDate).toBe("2026-08-26");
    expect(artifact.calendarCreates).toBe(1);
    expect(artifact.transcript.at(-1)?.visibleText).toContain("termin je potvrđen");
  });
  it("keeps history and pricing context across a long scenario, then performs backend-only same-day recalculation", async () => {
    const history = await runConversationScenario(scenarios.find((scenario) => scenario.id === "ru-conversational-availability")!);
    expect(history.turns[2]?.knownClientData).toMatchObject({ cleaningType: "standard", areaM2: 75, addressOrDistrict: "Врачар" });
    expect(history.turns[4]?.knownClientData).toMatchObject({ rooms: 3, bathrooms: 1 });
    expect(history.messageEvidence[5]).toMatchObject({
      semanticTools: ["request_available_slots"],
      schedulingActions: [{ kind: "availability", dateReference: "current_preferred_date", timePreference: "midday", timePreferenceMode: "explicit", relation: "fresh" }],
      calendarAvailabilityQueries: 2,
      calendarCreates: 0,
    });
    expect(history.messageEvidence[6]).toMatchObject({
      semanticTools: ["request_available_slots"],
      schedulingActions: [{ kind: "availability", dateReference: "current_preferred_date", timePreference: "evening", timePreferenceMode: "explicit", relation: "fresh" }],
      calendarAvailabilityQueries: 4,
      calendarCreates: 0,
    });
    const sameDay = await runConversationScenario(scenarios.find((scenario) => scenario.id === "same-day")!);
    expect(sameDay.lead.clientData).toMatchObject({ preferredDate: "2026-08-24", urgency: "same_day" });
    expect(hasSemanticTool(sameDay, "calculate_quote")).toBe(true);
    expect(sameDay.calendarCreates).toBe(0);
  });
});
