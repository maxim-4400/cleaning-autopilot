import { describe, expect, it, vi } from "vitest";

import { AgentTurnTechnicalError, FakeAgentGateway, type AgentGateway } from "@/lib/agent/gateway";
import { FakeCalendarGateway } from "@/lib/calendar/gateway";
import { CalendarReservationService } from "@/lib/calendar/reservation-service";
import { SchedulingEngine } from "@/lib/scheduling/engine";
import { InMemoryLeadRepository } from "@/lib/leads/in-memory-repository";
import { storedAvailabilityAttemptSchema } from "@/lib/leads/repository";
import { FakeTelegramGateway } from "@/lib/telegram/gateway";
import { resolveReplyLanguage } from "@/lib/telegram/language";
import { processTelegramWebhook, resolveCurrentTurnDateCoordinate, resolveRelativePreferredDate } from "@/lib/telegram/webhook";
import { FakeTrelloGateway } from "@/lib/trello/gateway";
import { TrelloRecoveryService } from "@/lib/trello/recovery-service";
import { TrelloSyncService } from "@/lib/trello/sync-service";

const update = (updateId: number, text: string, chatId = 1001) => ({
  update_id: updateId,
  message: { message_id: updateId + 100, chat: { id: chatId }, text },
});

const callback = (updateId: number, callbackQueryId: string, data: string, chatId = 1001) => ({
  update_id: updateId,
  callback_query: { id: callbackQueryId, data, message: { message_id: updateId + 100, chat: { id: chatId } } },
});
const TEST_NOW = new Date("2026-08-24T10:00:00.000Z");
const testCalendarReservation = (repository: InMemoryLeadRepository, calendar: FakeCalendarGateway) =>
  new CalendarReservationService(repository, calendar, undefined, () => TEST_NOW);

function dependencies(now = new Date("2026-08-24T10:00:00.000Z")) {
  const repository = new InMemoryLeadRepository();
  const telegram = new FakeTelegramGateway();
  const calendar = new FakeCalendarGateway();
  return {
    repository,
    telegram,
    calendar,
    agent: new FakeAgentGateway(),
    calendarReservation: new CalendarReservationService(repository, calendar, undefined, () => now),
    now: () => now,
  };
}

/** A deterministic stand-in for the real state-scoped scheduling agent. */
function schedulingAgent(intent: { dateReference: "current_preferred_date" | "today" | "tomorrow" | "same_day_as_last_offer" | "day_after_last_offer" | "exact_date"; timePreference: "any" | "morning" | "midday" | "evening" | "after" | "before" | "range"; timePreferenceMode?: "preserve" | "explicit"; relation?: "fresh" | "later_than_last_offer"; afterLocalTime?: string; beforeLocalTime?: string; exactDate?: string }): AgentGateway {
  return {
    async createConversation() { return { id: "semantic-scheduling-agent" }; },
    async runTurn(input) {
      if (input.schedulingDecisionRequired) {
        // Model-facing schemas expose today/tomorrow only when the current
        // customer message carries that coordinate. Follow-up wording such as
        // "and in the evening?" must use the already-authoritative date.
        const dateReference = (
          (intent.dateReference === "today" || intent.dateReference === "tomorrow") &&
          !input.schedulingSnapshot?.currentTurnDateCoordinate &&
          input.schedulingSnapshot?.preferredDate
        ) ? "current_preferred_date" : intent.dateReference;
        const output = await input.executeTool("request_available_slots", { intent: { relation: "fresh", timePreferenceMode: intent.timePreference === "any" ? "preserve" : "explicit", ...intent, dateReference } });
        return { reply: output.ok === true ? "I found the available times." : "I could not find a suitable time.", toolResults: [{ name: "request_available_slots", output }], steps: 1 };
      }
      return { reply: "Could you tell me one more detail about the cleaning?", toolResults: [], steps: 0 };
    },
  };
}

describe("Telegram webhook", () => {
  it("recognises standalone Russian and Serbian Cyrillic availability requests", () => {
    expect(resolveReplyLanguage("Покажи свободные слоты")).toBe("ru");
    expect(resolveReplyLanguage("Покажи слободне термине")).toBe("sr-Cyrl");
  });

  it("resolves exact and relative Belgrade dates before the agent and replaces an earlier request", async () => {
    const now = new Date("2026-08-24T21:30:00.000Z"); // 23:30 Belgrade, still 24 Aug
    expect(resolveRelativePreferredDate("через 2 дня", now)).toBe("2026-08-26");
    expect(resolveRelativePreferredDate("26.08.26", now)).toBe("2026-08-26");
    expect(resolveRelativePreferredDate("26 августа", now)).toBe("2026-08-26");
    expect(resolveRelativePreferredDate("26. avgusta", now)).toBe("2026-08-26");
    expect(resolveRelativePreferredDate("26. августа", now)).toBe("2026-08-26");
    expect(resolveRelativePreferredDate("26 августа 2026 года", now)).toBe("2026-08-26");
    expect(resolveRelativePreferredDate("26 August", now)).toBe("2026-08-26");
    expect(resolveRelativePreferredDate("August 26, 2026", now)).toBe("2026-08-26");
    expect(resolveRelativePreferredDate("August 23", now)).toBe("2027-08-23");
    expect(resolveRelativePreferredDate("August 26, 2025", now)).toBeUndefined();
    expect(resolveRelativePreferredDate("2 января", now)).toBe("2027-01-02");
    const deps = dependencies();
    await processTelegramWebhook(update(0, "26.08.26"), deps);
    await processTelegramWebhook(update(1, "in two days"), deps);
    expect(deps.repository.getLead(1001)?.clientData.preferredDate).toBe("2026-08-26");
  });

  it("derives only explicit current-message RU/EN/SR date coordinates without persisting them", () => {
    const now = new Date("2026-08-24T21:30:00.000Z"); // 23:30 Belgrade
    expect(resolveCurrentTurnDateCoordinate("Сегодня вечером?", now)).toEqual({
      date: "2026-08-24", recommendedDateReference: "today", source: "relative_today", timezone: "Europe/Belgrade",
    });
    expect(resolveCurrentTurnDateCoordinate("Tomorrow.", now)).toEqual({
      date: "2026-08-25", recommendedDateReference: "tomorrow", source: "relative_tomorrow", timezone: "Europe/Belgrade",
    });
    expect(resolveCurrentTurnDateCoordinate("Через два дня.", now)).toEqual({
      date: "2026-08-26", recommendedDateReference: "exact_date", source: "relative_in_days", timezone: "Europe/Belgrade",
    });
    expect(resolveCurrentTurnDateCoordinate("За два дана.", now)).toEqual({
      date: "2026-08-26", recommendedDateReference: "exact_date", source: "relative_in_days", timezone: "Europe/Belgrade",
    });
    expect(resolveCurrentTurnDateCoordinate("26 августа.", now)).toEqual({
      date: "2026-08-26", recommendedDateReference: "exact_date", source: "absolute", timezone: "Europe/Belgrade",
    });
    expect(resolveCurrentTurnDateCoordinate("2026-08-26.", now)).toEqual({
      date: "2026-08-26", recommendedDateReference: "exact_date", source: "absolute", timezone: "Europe/Belgrade",
    });
    expect(resolveCurrentTurnDateCoordinate("The weather today?", now)).toEqual({
      date: "2026-08-24", recommendedDateReference: "today", source: "relative_today", timezone: "Europe/Belgrade",
    });
    expect(resolveCurrentTurnDateCoordinate("Not today.", now)).toBeUndefined();
    expect(resolveCurrentTurnDateCoordinate("Не завтра, а через два дня.", now)).toBeUndefined();
    expect(resolveCurrentTurnDateCoordinate("Not tomorrow, but in two days.", now)).toBeUndefined();
    expect(resolveCurrentTurnDateCoordinate("Nije sutra, za dva dana.", now)).toBeUndefined();
    expect(resolveCurrentTurnDateCoordinate("Није сутра, за два дана.", now)).toBeUndefined();
    expect(resolveCurrentTurnDateCoordinate("Сегодня или завтра?", now)).toBeUndefined();
    expect(resolveCurrentTurnDateCoordinate("26 August or 27 August?", now)).toBeUndefined();
    expect(resolveCurrentTurnDateCoordinate("Not 2026-08-26.", now)).toBeUndefined();
    expect(resolveCurrentTurnDateCoordinate("2026-08-23.", now)).toBeUndefined();
    expect(resolveCurrentTurnDateCoordinate("2026-02-30.", now)).toBeUndefined();
    expect(resolveCurrentTurnDateCoordinate("2026-08-26 or 2026-08-27?", now)).toBeUndefined();
    expect(resolveCurrentTurnDateCoordinate("2026/08/26.", now)).toBeUndefined();
  });

  it("keeps a natural Russian date after New address, quotes the completed request, then offers slots", async () => {
    const now = new Date("2026-08-24T10:00:00.000Z");
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const calendarReservation = new CalendarReservationService(repository, calendar, undefined, () => now);
    const agent: AgentGateway = {
      async createConversation() { return { id: "named-russian-date" }; },
      async runTurn(input) {
        if (input.schedulingDecisionRequired) {
          const output = await input.executeTool("request_available_slots", { intent: { dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" } });
          return { reply: "Покажу варианты.", toolResults: [{ name: "request_available_slots", output }], steps: 1 };
        }
        expect(input.replyLanguage).toBe("ru");
        // The date was supplied only as natural Russian customer text, so the
        // backend must resolve it before a model has a chance to omit it.
        expect(input.knownClientData.preferredDate).toBe("2026-08-26");
        const saved = await input.executeTool("update_client_data", { patch: {
          cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 2,
          heavyPetHair: false, extras: [], addressOrDistrict: "Врачар",
          // A stale model ISO value must not overwrite the backend-resolved
          // future customer date.
          preferredDate: "2025-08-26",
        } });
        expect(saved).toMatchObject({ ok: true, client_data: { preferredDate: "2026-08-26" } });
        const quote = await input.executeTool("calculate_quote", {});
        return { reply: "Готово.", toolResults: [], steps: quote.ok === true ? 2 : 1 };
      },
    };
    const deps = { repository, telegram, calendar, agent, calendarReservation, now: () => now };

    await processTelegramWebhook(update(4, "New address"), deps);
    await expect(processTelegramWebhook(
      update(5, "Нужна стандартная уборка, 75 m², 3 комнаты, 2 санузла, без сильной шерсти, без дополнительных услуг, район Врачар, 26 августа"),
      deps,
    )).resolves.toEqual({ kind: "processed" });

    expect(repository.getLead(1001)).toMatchObject({
      status: "qualified",
      firstMessageLanguage: "ru",
      clientData: {
        cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 2,
        heavyPetHair: false, extras: [], addressOrDistrict: "Врачар",
        preferredDate: "2026-08-26",
      },
    });
    expect(repository.getLead(1001)?.pendingSchedulingConsentQuotedAt).toBe(repository.getLead(1001)?.quotedAt);
    expect(telegram.messages.at(-1)?.text).toContain("Стоимость уборки: 6 500 RSD");

    await expect(processTelegramWebhook(update(6, "покажи свободное время"), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(telegram.messages.at(-1)?.text).toContain("Ближайшее свободное время");
  });

  it("keeps Serbian Latin 26. avgusta after a stale model ISO patch", async () => {
    const now = new Date("2026-08-24T10:00:00.000Z");
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const agent: AgentGateway = {
      async createConversation() { return { id: "serbian-date" }; },
      async runTurn(input) {
        expect(input.knownClientData.preferredDate).toBe("2026-08-26");
        await input.executeTool("update_client_data", { patch: { preferredDate: "2025-08-26" } });
        return { reply: "U redu.", toolResults: [], steps: 1 };
      },
    };
    await processTelegramWebhook(update(7, "Treba mi čišćenje 26. avgusta."), { repository, telegram, agent, now: () => now });
    expect(repository.getLead(1001)?.clientData.preferredDate).toBe("2026-08-26");
  });

  it("starts a new address without reading a malformed prior active lead", async () => {
    const deps = dependencies();
    const repository = new Proxy(deps.repository, {
      get(target, property, receiver) {
        if (property === "findLeadByTelegramChatId") {
          return async () => { throw new Error("simulated historical lead mapping failure"); };
        }
        const value = Reflect.get(target, property, receiver);
        // Keep the boundary operation on its real repository instance. Its
        // own internal bookkeeping is unrelated to the read that the
        // webhook must deliberately bypass.
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(processTelegramWebhook(update(7, "New address"), { ...deps, repository })).resolves.toEqual({ kind: "processed" });

    expect(deps.telegram.messages.at(-1)?.text).toContain("New cleaning location");
    expect(deps.repository.updates.get(7)).toMatchObject({ status: "processed" });
  });

  it("handles Sunday as unavailable, keeps one Saturday candidate, and confirms it without asking again", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-24T10:00:00.000Z"));
    try {
      const deps = dependencies();
      await processTelegramWebhook(update(2, "Хочу уборку на выходных"), deps);
      expect(deps.repository.getLead(1001)).toMatchObject({ pendingPreferredDate: "2026-08-29", firstMessageLanguage: "ru", clientData: {} });
      expect(deps.telegram.messages.at(-1)?.text).toContain("Ближайшая суббота");
      expect(deps.telegram.messages.at(-1)?.text).not.toContain("суббота, суббота");
      await processTelegramWebhook(update(3, "Воскресенье лучше."), deps);
      expect(deps.repository.getLead(1001)).toMatchObject({ pendingPreferredDate: "2026-08-29", clientData: {} });
      expect(deps.telegram.messages.at(-1)?.text).toContain("В воскресенье мы не работаем");
      await processTelegramWebhook(update(4, "Да, суббота тоже подойдет."), deps);
      expect(deps.repository.getLead(1001)).toMatchObject({ pendingPreferredDate: undefined, clientData: { preferredDate: "2026-08-29" } });
      expect(deps.telegram.messages.at(-1)?.text).toContain("Записал уборку");
      expect(deps.telegram.messages.at(-1)?.text).toContain("на субботу");
    } finally { vi.useRealTimers(); }
  });

  it("confirms a Serbian weekend proposal with punctuated Da.", async () => {
    const deps = dependencies();
    await processTelegramWebhook(update(5, "Treba mi čišćenje za vikend."), deps);
    expect(deps.repository.getLead(1001)).toMatchObject({ pendingPreferredDate: "2026-08-29", firstMessageLanguage: "sr-Latn" });
    await processTelegramWebhook(update(6, "Da."), deps);
    expect(deps.repository.getLead(1001)).toMatchObject({ pendingPreferredDate: undefined, clientData: { preferredDate: "2026-08-29" } });
    expect(deps.telegram.messages.at(-1)?.text).toContain("Zabeležio sam čišćenje");
    expect(deps.telegram.messages.at(-1)?.text).toContain("za subotu");
  });

  it("does not turn an incidental weather-today question into a booking date", async () => {
    const deps = dependencies();
    await processTelegramWebhook(update(8, "Какая сегодня погода?"), deps);
    expect(deps.repository.getLead(1001)?.clientData.preferredDate).toBeUndefined();
  });

  it("escalates an oversized area immediately after the sole validated data update", async () => {
    const base = dependencies();
    const tools: string[][] = [];
    let turns = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: "over-200" }; },
      async runTurn(input: import("@/lib/agent/gateway").AgentTurnInput) {
        tools.push([...(input.allowedTools ?? [])]);
        if (turns++ > 0) return { reply: "Понял.", toolResults: [], steps: 0 };
        const saved = await input.executeTool("update_client_data", { patch: { areaM2: 240 } });
        expect(saved).toMatchObject({ ok: true, client_data: { areaM2: 240 } });
        return { reply: "Нужно проверить детали.", toolResults: [], steps: 1 };
      },
    };
    const deps = { ...base, agent };
    await expect(processTelegramWebhook(update(9, "Нужна уборка 240 м²."), deps)).resolves.toEqual({ kind: "processed" });
    expect(tools).toEqual([["update_client_data", "mark_human_needed", "calculate_quote"]]);
    expect(deps.repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "area_over_200_m2", clientData: { areaM2: 240 } });
    expect(deps.repository.getLead(1001)?.quote).toBeUndefined();
    expect(deps.telegram.messages).toHaveLength(1);

    await processTelegramWebhook(update(10, "Это квартира в Новом Белграде."), deps);
    expect(tools).toEqual([["update_client_data", "mark_human_needed", "calculate_quote"], []]);
    expect(deps.repository.getLead(1001)?.clientData.addressOrDistrict).toBe("New Belgrade");
    expect(deps.telegram.messages.at(-1)?.text).toContain("Новый Белград добавил");
  });

  it("keeps post-handoff replies contextual while pure questions expose no tool", async () => {
    const base = dependencies();
    const allowedTools: string[][] = [];
    let turn = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: "handoff-context" }; },
      async runTurn(input: import("@/lib/agent/gateway").AgentTurnInput) {
        allowedTools.push([...(input.allowedTools ?? [])]);
        if (turn++ === 0) {
          await input.executeTool("mark_human_needed", { reason: "commercial_property" });
          return { reply: "Команда посмотрит заявку.", toolResults: [], steps: 1 };
        }
        if (turn === 2) {
          await input.executeTool("update_client_data", { patch: { preferredDate: "2026-08-26" } });
          return { reply: "Дату добавил.", toolResults: [], steps: 1 };
        }
        return { reply: "Понял.", toolResults: [], steps: 1 };
      },
    };
    const deps = { ...base, agent };
    await processTelegramWebhook(update(10, "Нужна коммерческая уборка."), deps);
    await processTelegramWebhook(update(11, "26 августа."), deps);
    await processTelegramWebhook(update(12, "А цену можно узнать?"), deps);
    await processTelegramWebhook(update(13, "Можно поговорить с человеком?"), deps);
    expect(allowedTools).toEqual([
      ["update_client_data", "mark_human_needed", "calculate_quote"],
      ["update_client_data"],
      [],
      [],
    ]);
    expect(deps.repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "commercial_property", clientData: { preferredDate: "2026-08-26" } });
    const visible = deps.telegram.messages.map((message) => message.text);
    expect(new Set(visible).size).toBe(visible.length);
    expect(visible[1]).toContain("Желаемую дату записал");
    expect(visible[2]).toContain("Автоматически точную цену");
    expect(visible[3]).toContain("уже передали команде");
  });

  it("keeps punctuation-free Human Needed questions tool-free but saves factual window details", async () => {
    const base = dependencies();
    const allowedTools: string[][] = [];
    let turn = 0;
    const deps = { ...base, agent: {
      async createConversation() { return { id: "handoff-punctuationless-question" }; },
      async runTurn(input: import("@/lib/agent/gateway").AgentTurnInput) {
        allowedTools.push([...(input.allowedTools ?? [])]);
        if (turn++ === 0) {
          await input.executeTool("mark_human_needed", { reason: "commercial_property" });
          return { reply: "Our team will review the request.", toolResults: [], steps: 1 };
        }
        if (turn === 2) {
          // The customer omitted the question mark.  It must still have no
          // data-update capability despite containing the word "windows".
          return { reply: "The request is already with our team.", toolResults: [], steps: 1 };
        }
        const saved = await input.executeTool("update_client_data", { patch: { extras: ["windows"] } });
        expect(saved).toMatchObject({ ok: true, client_data: { extras: ["windows"] } });
        return { reply: "I added window cleaning to the request.", toolResults: [], steps: 1 };
      },
    } };

    await processTelegramWebhook(update(14, "I need commercial cleaning."), deps);
    await processTelegramWebhook(update(15, "Can you clean windows"), deps);
    await processTelegramWebhook(update(16, "Windows would be useful."), deps);

    expect(allowedTools).toEqual([
      ["update_client_data", "mark_human_needed", "calculate_quote"],
      [],
      ["update_client_data"],
    ]);
    expect(deps.repository.getLead(1001)?.clientData.extras).toEqual(["windows"]);
  });

  it("stores a validated update, persists a conversation, and qualifies only after reply delivery", async () => {
    const deps = dependencies();
    const payload = update(1, "standard cleaning, 100 m2, 3 rooms, 2 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24");

    await expect(processTelegramWebhook(payload, deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.repository.getLead(1001)).toMatchObject({ status: "qualified", firstMessageLanguage: "en", agentConfigVersion: 5 });
    expect(deps.telegram.messages).toHaveLength(1);
    expect(deps.repository.updates.get(1)).toMatchObject({ status: "processed" });
  });

  it("returns success for a duplicate update without sending another reply", async () => {
    const deps = dependencies();
    const payload = update(2, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24");

    await processTelegramWebhook(payload, deps);
    await expect(processTelegramWebhook(payload, deps)).resolves.toEqual({ kind: "duplicate" });
    expect(deps.telegram.messages).toHaveLength(1);
  });

  it("keeps one lead and one conversation through a fake multi-message quote flow", async () => {
    const deps = dependencies();
    await processTelegramWebhook(update(20, "standard cleaning, 100 m2"), deps);
    expect(deps.telegram.messages[0]?.text).toBe("How many rooms and bathrooms are there?");
    await processTelegramWebhook(update(21, "3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"), deps);

    const lead = deps.repository.getLead(1001);
    expect(lead).toMatchObject({ status: "qualified", quote: { amountRsd: 9600 } });
    await expect(deps.repository.getConversation(lead?.id ?? "missing")).resolves.toMatchObject({
      openAiConversationId: "fake-conversation-1",
    });
    expect(deps.telegram.messages).toHaveLength(2);
  });

  it("invalidates a poisoned Conversation, preserves prior facts and escalates only after a consecutive fresh failure", async () => {
    const base = dependencies();
    const created: string[] = [];
    const deps = { ...base, agent: {
      async createConversation() { const id = `conversation-${created.length + 1}`; created.push(id); return { id }; },
      async runTurn(input: import("@/lib/agent/gateway").AgentTurnInput) {
        if (input.conversationId === "conversation-1") {
          await input.executeTool("update_client_data", { patch: { areaM2: 50 } });
          throw new AgentTurnTechnicalError("agent_max_turns_exceeded");
        }
        if (input.conversationId === "conversation-2") {
          expect(input.knownClientData.areaM2).toBeUndefined();
          await input.executeTool("update_client_data", { patch: { areaM2: 50 } });
          return { reply: "What type of cleaning do you need?", toolResults: [], steps: 1 };
        }
        throw new AgentTurnTechnicalError("agent_max_turns_exceeded");
      },
    } };
    await expect(processTelegramWebhook(update(1900, "Нужна уборка"), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.telegram.messages.at(-1)?.text).toContain("Последнее сообщение не удалось");
    const lead = deps.repository.getLead(1001);
    expect(lead).toMatchObject({ humanNeeded: false, clientData: {} });
    await expect(deps.repository.getConversation(lead?.id ?? "missing")).resolves.toBeNull();
    await expect(processTelegramWebhook(update(1901, "50 м²"), deps)).resolves.toEqual({ kind: "processed" });
    expect(created).toEqual(["conversation-1", "conversation-2"]);
    expect(deps.repository.getLead(1001)).toMatchObject({ clientData: { areaM2: 50 }, humanNeeded: false });
  });

  it("recovers an ambiguous agent operation before runTurn and records the update-owned recovery marker", async () => {
    const base = dependencies();
    const lead = await base.repository.createLead({ telegramChatId: 1770, firstMessageLanguage: "en", agentConfigVersion: 5 });
    await base.repository.saveConversation({ leadId: lead.id, telegramChatId: 1770, openAiConversationId: "ambiguous-provider-turn" });
    const agentTurnKey = `openai:agent_turn:${lead.id}:17701`;
    await base.repository.createIntegrationOperation({ leadId: lead.id, idempotencyKey: agentTurnKey, provider: "openai", operationType: "run_turn" });
    await base.repository.failIntegrationOperation(agentTurnKey, "agent_provider_timeout", "ambiguous");
    const agent: AgentGateway = {
      async createConversation() { throw new Error("ambiguous turn recovery must not create a provider Conversation"); },
      async runTurn() { throw new Error("ambiguous turn recovery must not replay the model"); },
    };
    const deps = { ...base, agent };

    await expect(processTelegramWebhook(update(17701, "Need cleaning", 1770), deps)).resolves.toEqual({ kind: "processed" });

    expect(base.telegram.messages).toHaveLength(1);
    expect(base.telegram.messages[0]?.text).toContain("last message could not be processed safely");
    expect(await base.repository.getIntegrationOperation(agentTurnKey)).toMatchObject({ status: "ambiguous" });
    expect(await base.repository.getIntegrationOperation(`openai:conversation_recovery:${lead.id}`)).toMatchObject({
      status: "succeeded", externalId: "17701",
    });
    expect(await base.repository.getIntegrationOperation("telegram:reply:17701")).toMatchObject({ status: "succeeded" });
    await expect(base.repository.getConversation(lead.id)).resolves.toBeNull();
    expect(base.calendar.availabilityQueries).toHaveLength(0);
    expect(base.calendar.creates).toHaveLength(0);
    expect(base.repository.getLead(1770)).toMatchObject({ humanNeeded: false, clientData: {} });
  });

  it("resumes the same update-owned technical resend without a second model call or Human Needed", async () => {
    const base = dependencies();
    const lead = await base.repository.createLead({ telegramChatId: 1771, firstMessageLanguage: "en", agentConfigVersion: 5 });
    await base.repository.saveConversation({ leadId: lead.id, telegramChatId: 1771, openAiConversationId: "same-update-recovery" });
    const updateId = 17711;
    const agentTurnKey = `openai:agent_turn:${lead.id}:${updateId}`;
    await base.repository.createIntegrationOperation({ leadId: lead.id, idempotencyKey: agentTurnKey, provider: "openai", operationType: "run_turn" });
    await base.repository.failIntegrationOperation(agentTurnKey, "agent_provider_timeout", "ambiguous");
    const recoveryKey = `openai:conversation_recovery:${lead.id}`;
    await base.repository.createIntegrationOperation({ leadId: lead.id, idempotencyKey: recoveryKey, provider: "openai", operationType: "conversation_recovery_marker" });
    await base.repository.completeIntegrationOperation(recoveryKey, String(updateId));
    const deliveryKey = `telegram:reply:${updateId}`;
    await base.repository.createIntegrationOperation({ leadId: lead.id, idempotencyKey: deliveryKey, provider: "telegram", operationType: "send_message" });
    await base.repository.completeIntegrationOperation(deliveryKey, "already-delivered");
    const agent: AgentGateway = {
      async createConversation() { throw new Error("same update recovery must not create a provider Conversation"); },
      async runTurn() { throw new Error("same update recovery must not replay the model"); },
    };

    await expect(processTelegramWebhook(update(updateId, "Need cleaning", 1771), { ...base, agent })).resolves.toEqual({ kind: "processed" });

    expect(base.telegram.messages).toEqual([]);
    expect(base.repository.getLead(1771)).toMatchObject({ humanNeeded: false });
    expect(base.repository.updates.get(updateId)).toMatchObject({ status: "processed" });
    expect(await base.repository.getIntegrationOperation(deliveryKey)).toMatchObject({ status: "succeeded", externalId: "already-delivered" });
  });

  it("retries a confirmed-failed technical resend with the same delivery key and no provider turn", async () => {
    const base = dependencies();
    const lead = await base.repository.createLead({ telegramChatId: 17711, firstMessageLanguage: "en", agentConfigVersion: 5 });
    const updateId = 177111;
    const agentTurnKey = `openai:agent_turn:${lead.id}:${updateId}`;
    const recoveryKey = `openai:conversation_recovery:${lead.id}`;
    const deliveryKey = `telegram:reply:${updateId}`;
    await base.repository.createIntegrationOperation({ leadId: lead.id, idempotencyKey: agentTurnKey, provider: "openai", operationType: "run_turn" });
    await base.repository.failIntegrationOperation(agentTurnKey, "agent_provider_timeout", "ambiguous");
    await base.repository.createIntegrationOperation({ leadId: lead.id, idempotencyKey: recoveryKey, provider: "openai", operationType: "conversation_recovery_marker" });
    await base.repository.completeIntegrationOperation(recoveryKey, String(updateId));
    await base.repository.createIntegrationOperation({ leadId: lead.id, idempotencyKey: deliveryKey, provider: "telegram", operationType: "send_message" });
    await base.repository.failIntegrationOperation(deliveryKey, "telegram_delivery_failed", "failed");
    const agent: AgentGateway = {
      async createConversation() { throw new Error("same-update recovery must not create a Conversation"); },
      async runTurn() { throw new Error("same-update recovery must not run the model"); },
    };

    await expect(processTelegramWebhook(update(updateId, "2 and 1", 17711), { ...base, agent })).resolves.toEqual({ kind: "processed" });

    expect(base.telegram.messages).toHaveLength(1);
    expect(base.telegram.messages[0]?.text).toContain("last message could not be processed safely");
    expect(await base.repository.getIntegrationOperation(deliveryKey)).toMatchObject({ status: "succeeded" });
    expect(base.repository.updates.get(updateId)).toMatchObject({ status: "processed" });
    await expect(base.repository.getConversation(lead.id)).resolves.toBeNull();
    expect(base.calendar.availabilityQueries).toHaveLength(0);
    expect(base.calendar.creates).toHaveLength(0);
  });

  it("delivers one degraded message for an unexpected application error without replaying business work", async () => {
    const base = dependencies();
    let turns = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: "unexpected-app-error" }; },
      async runTurn() {
        turns += 1;
        throw new Error("synthetic application failure");
      },
    };

    await expect(processTelegramWebhook(update(17712, "2 и 1"), { ...base, agent })).resolves.toEqual({ kind: "processed" });

    const lead = base.repository.getLead(1001);
    expect(turns).toBe(1);
    expect(base.telegram.messages.at(-1)?.text).toContain("last message could not be processed safely");
    expect(await base.repository.getIntegrationOperation("telegram:degraded:17712")).toMatchObject({ status: "succeeded" });
    expect(await base.repository.getIntegrationOperation(`openai:agent_turn:${lead?.id}:17712`)).toMatchObject({ status: "ambiguous" });
    expect(base.calendar.availabilityQueries).toHaveLength(0);
    expect(base.calendar.creates).toHaveLength(0);
    expect(base.repository.updates.get(17712)).toMatchObject({ status: "processed" });
  });

  it("uses the separate reservation-safe degraded copy after a callback application error", async () => {
    const base = dependencies();
    const lead = await base.repository.createLead({ telegramChatId: 17713, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vračar", preferredDate: "2026-08-26" };
    await base.repository.saveLead(lead);
    base.repository.getCalendarSlotToken = async () => { throw new Error("synthetic callback repository failure"); };

    await expect(processTelegramWebhook(callback(17713, "callback-degraded", "slot:ru:00000000-0000-4000-8000-000000000001", 17713), base)).resolves.toEqual({ kind: "processed" });

    expect(base.telegram.messages).toHaveLength(1);
    expect(base.telegram.messages[0]?.text).toContain("нельзя безопасно подтвердить");
    expect(await base.repository.getIntegrationOperation("telegram:degraded:17713")).toMatchObject({ status: "succeeded" });
    expect(base.calendar.creates).toHaveLength(0);
    expect(base.repository.updates.get(17713)).toMatchObject({ status: "processed" });
    expect(base.repository.getLead(17713)).toMatchObject({ id: lead.id, humanNeeded: true, humanNeededReason: "calendar_ambiguous" });
  });

  it("retries a confirmed-failed callback degraded reply before slot reservation", async () => {
    const base = dependencies();
    const lead = await base.repository.createLead({ telegramChatId: 17715, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vračar", preferredDate: "2026-08-26" };
    await base.repository.saveLead(lead);
    let slotLookups = 0;
    base.repository.getCalendarSlotToken = async () => {
      slotLookups += 1;
      throw new Error("synthetic callback repository failure");
    };
    base.telegram.shouldFail = true;
    base.telegram.failureOutcome = "failed";
    const input = callback(17715, "callback-degraded-failed", "slot:ru:00000000-0000-4000-8000-000000000002", 17715);

    await expect(processTelegramWebhook(input, base)).resolves.toEqual({ kind: "failed", failureCode: "processing_error" });
    expect(slotLookups).toBe(1);
    expect(base.calendar.creates).toHaveLength(0);

    base.telegram.shouldFail = false;
    await expect(processTelegramWebhook(input, base)).resolves.toEqual({ kind: "processed" });

    expect(slotLookups).toBe(1);
    expect(base.calendar.creates).toHaveLength(0);
    expect(base.telegram.messages.at(-1)?.text).toContain("нельзя безопасно подтвердить");
    expect(await base.repository.getIntegrationOperation("telegram:degraded:17715")).toMatchObject({ status: "succeeded" });
  });

  it("does not repeat a callback reservation after an ambiguous degraded delivery", async () => {
    const base = dependencies();
    const lead = await base.repository.createLead({ telegramChatId: 17716, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vračar", preferredDate: "2026-08-26" };
    await base.repository.saveLead(lead);
    let slotLookups = 0;
    base.repository.getCalendarSlotToken = async () => {
      slotLookups += 1;
      throw new Error("synthetic callback repository failure");
    };
    base.telegram.shouldFail = true;
    base.telegram.failureOutcome = "ambiguous";
    const input = callback(17716, "callback-degraded-ambiguous", "slot:en:00000000-0000-4000-8000-000000000003", 17716);

    await expect(processTelegramWebhook(input, base)).resolves.toEqual({ kind: "failed", failureCode: "processing_error" });
    expect(slotLookups).toBe(1);
    expect(base.calendar.creates).toHaveLength(0);

    base.telegram.shouldFail = false;
    await expect(processTelegramWebhook(input, base)).resolves.toEqual({ kind: "failed", failureCode: "telegram_delivery_failed" });

    expect(slotLookups).toBe(1);
    expect(base.calendar.creates).toHaveLength(0);
    expect(base.telegram.messages).toHaveLength(0);
    expect(await base.repository.getIntegrationOperation("telegram:degraded:17716")).toMatchObject({ status: "ambiguous" });
    expect(base.repository.getLead(17716)).toMatchObject({ id: lead.id, humanNeeded: true, humanNeededReason: "calendar_ambiguous" });
  });

  it("does not send a resend when a generic message failure cannot invalidate its Conversation", async () => {
    const base = dependencies();
    const agent: AgentGateway = {
      async createConversation() { return { id: "unresettable-conversation" }; },
      async runTurn() { throw new Error("synthetic application failure"); },
    };
    base.repository.invalidateConversation = async () => { throw new Error("synthetic invalidation failure"); };

    await expect(processTelegramWebhook(update(17717, "2 и 1"), { ...base, agent })).resolves.toEqual({ kind: "processed" });

    expect(base.telegram.messages.at(-1)?.text).toContain("team");
    expect(base.telegram.messages.at(-1)?.text).not.toContain("last message could not");
    expect(base.repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "conversation_ambiguous" });
    expect(await base.repository.getIntegrationOperation("telegram:degraded:17717")).toMatchObject({ status: "succeeded" });
  });

  it("does not add a degraded reply after the ordinary response was already delivered", async () => {
    const base = dependencies();
    const markProcessed = base.repository.markTelegramUpdateProcessed.bind(base.repository);
    let processedCalls = 0;
    base.repository.markTelegramUpdateProcessed = async (updateId) => {
      processedCalls += 1;
      if (processedCalls === 1) throw new Error("synthetic post-delivery update write failure");
      await markProcessed(updateId);
    };
    const agent: AgentGateway = {
      async createConversation() { return { id: "delivered-before-late-error" }; },
      async runTurn() { return { reply: "One more detail, please.", toolResults: [], steps: 1 }; },
    };

    await expect(processTelegramWebhook(update(17718, "Need cleaning"), { ...base, agent })).resolves.toEqual({ kind: "processed" });

    expect(base.telegram.messages).toHaveLength(1);
    expect(await base.repository.getIntegrationOperation("telegram:reply:17718")).toMatchObject({ status: "succeeded" });
    expect(await base.repository.getIntegrationOperation("telegram:degraded:17718")).toBeNull();
    expect(base.repository.updates.get(17718)).toMatchObject({ status: "processed" });
  });

  it("leaves a degraded reply retryable after a confirmed delivery failure without creating another key", async () => {
    const base = dependencies();
    base.telegram.shouldFail = true;
    base.telegram.failureOutcome = "failed";
    const agent: AgentGateway = {
      async createConversation() { return { id: "degraded-delivery-failure" }; },
      async runTurn() { throw new Error("synthetic application failure"); },
    };

    await expect(processTelegramWebhook(update(17714, "2 и 1"), { ...base, agent })).resolves.toEqual({ kind: "failed", failureCode: "processing_error" });

    expect(await base.repository.getIntegrationOperation("telegram:degraded:17714")).toMatchObject({ status: "failed" });
    expect(await base.repository.getIntegrationOperation("telegram:reply:17714")).toBeNull();
    expect(base.repository.updates.get(17714)).toMatchObject({ status: "failed", failureCode: "processing_error" });
  });

  it.each([
    ["a different update", "17720"],
    ["a legacy marker without an update id", undefined],
  ] as const)("keeps the existing consecutive-error Human Needed boundary for %s", async (_label, markerUpdateId) => {
    const base = dependencies();
    const lead = await base.repository.createLead({ telegramChatId: 1772, firstMessageLanguage: "en", agentConfigVersion: 5 });
    await base.repository.saveConversation({ leadId: lead.id, telegramChatId: 1772, openAiConversationId: "consecutive-error-recovery" });
    const updateId = 17721;
    const agentTurnKey = `openai:agent_turn:${lead.id}:${updateId}`;
    await base.repository.createIntegrationOperation({ leadId: lead.id, idempotencyKey: agentTurnKey, provider: "openai", operationType: "run_turn" });
    await base.repository.failIntegrationOperation(agentTurnKey, "agent_provider_timeout", "ambiguous");
    const recoveryKey = `openai:conversation_recovery:${lead.id}`;
    await base.repository.createIntegrationOperation({ leadId: lead.id, idempotencyKey: recoveryKey, provider: "openai", operationType: "conversation_recovery_marker" });
    await base.repository.completeIntegrationOperation(recoveryKey, markerUpdateId);
    const agent: AgentGateway = {
      async createConversation() { throw new Error("consecutive-error boundary must not create a provider Conversation"); },
      async runTurn() { throw new Error("consecutive-error boundary must not replay the model"); },
    };

    await expect(processTelegramWebhook(update(updateId, "Need cleaning", 1772), { ...base, agent })).resolves.toEqual({ kind: "processed" });

    expect(base.repository.getLead(1772)).toMatchObject({ humanNeeded: true, humanNeededReason: "conversation_ambiguous" });
    expect(base.telegram.messages.at(-1)?.text).toContain("check a couple of details with the team");
    expect(base.calendar.availabilityQueries).toHaveLength(0);
    expect(base.calendar.creates).toHaveLength(0);
  });

  it("keeps an ambiguous update failed when Conversation invalidation cannot be proven", async () => {
    const base = dependencies();
    const lead = await base.repository.createLead({ telegramChatId: 1773, firstMessageLanguage: "en", agentConfigVersion: 5 });
    await base.repository.saveConversation({ leadId: lead.id, telegramChatId: 1773, openAiConversationId: "must-be-deleted" });
    const updateId = 17731;
    const agentTurnKey = `openai:agent_turn:${lead.id}:${updateId}`;
    await base.repository.createIntegrationOperation({ leadId: lead.id, idempotencyKey: agentTurnKey, provider: "openai", operationType: "run_turn" });
    await base.repository.failIntegrationOperation(agentTurnKey, "agent_provider_timeout", "ambiguous");
    base.repository.invalidateConversation = async () => { throw new Error("synthetic invalidation failure"); };
    const agent: AgentGateway = {
      async createConversation() { throw new Error("must not create a provider Conversation"); },
      async runTurn() { throw new Error("must not replay the model"); },
    };

    await expect(processTelegramWebhook(update(updateId, "Need cleaning", 1773), { ...base, agent })).resolves.toEqual({ kind: "failed", failureCode: "processing_error" });

    expect(base.telegram.messages).toEqual([]);
    expect(base.repository.updates.get(updateId)).toMatchObject({ status: "failed", failureCode: "processing_error" });
    expect(await base.repository.getIntegrationOperation(`openai:conversation_recovery:${lead.id}`)).toBeNull();
  });

  it("rolls back the one update from a duplicate provider tool call and invalidates its Conversation", async () => {
    const base = dependencies();
    const deps = { ...base, agent: {
      async createConversation() { return { id: "duplicate-update-conversation" }; },
      async runTurn(input: import("@/lib/agent/gateway").AgentTurnInput) {
        await input.executeTool("update_client_data", { patch: { areaM2: 50 } });
        throw new AgentTurnTechnicalError("agent_duplicate_update_client_data");
      },
    } };

    await expect(processTelegramWebhook(update(1905, "Need cleaning, 50 m2."), deps)).resolves.toEqual({ kind: "processed" });
    const lead = deps.repository.getLead(1001);
    expect(lead).toMatchObject({ clientData: {}, humanNeeded: false });
    await expect(deps.repository.getConversation(lead?.id ?? "missing")).resolves.toBeNull();
    expect(deps.telegram.messages.at(-1)?.text).toContain("last message could not be processed safely");
    expect(deps.repository.updates.get(1905)).toMatchObject({ status: "processed" });
  });

  it.each([
    "agent_provider_timeout",
    "agent_provider_http_error",
    "agent_provider_transport_error",
  ] as const)("recovers a %s turn without losing pre-turn commercial scheduling facts", async (code) => {
    const base = dependencies();
    const created: string[] = [];
    const deps = { ...base, agent: {
      async createConversation() { const id = `provider-recovery-${created.length + 1}`; created.push(id); return { id }; },
      async runTurn(input: import("@/lib/agent/gateway").AgentTurnInput) {
        if (input.conversationId === "provider-recovery-1" && input.message.includes("Commercial")) {
          await input.executeTool("mark_human_needed", { reason: "commercial_property" });
          return { reply: "Our team will review this commercial request.", toolResults: [], steps: 1 };
        }
        if (input.conversationId === "provider-recovery-1") {
          if (input.knownClientData.preferredDate !== "2026-08-27" || input.knownClientData.preferredTimeWindow !== "midday") throw new Error(`unexpected recovery facts: ${JSON.stringify(input.knownClientData)}`);
          await input.executeTool("update_client_data", { patch: { rooms: 8 } });
          throw new AgentTurnTechnicalError(code);
        }
        expect(input.conversationId).toBe("provider-recovery-2");
        expect(input.knownClientData).toMatchObject({ preferredDate: "2026-08-27", preferredTimeWindow: "midday" });
        expect(input.knownClientData.rooms).toBeUndefined();
        return { reply: "A team member already has your commercial request.", toolResults: [], steps: 0 };
      },
    } };

    await processTelegramWebhook(update(1906, "Commercial office cleaning."), deps);
    expect(resolveRelativePreferredDate("Thursday afternoon would suit us.", TEST_NOW)).toBe("2026-08-27");
    await expect(processTelegramWebhook(update(1907, "Thursday afternoon would suit us."), deps)).resolves.toEqual({ kind: "processed" });
    const afterFailure = deps.repository.getLead(1001);
    expect(afterFailure).toMatchObject({ humanNeeded: true, humanNeededReason: "commercial_property", clientData: { preferredDate: "2026-08-27", preferredTimeWindow: "midday" } });
    expect(afterFailure?.clientData.rooms).toBeUndefined();
    await expect(deps.repository.getConversation(afterFailure?.id ?? "missing")).resolves.toBeNull();
    expect(deps.telegram.messages.at(-1)?.text).toContain("last message could not be processed safely");
    expect(deps.telegram.messages.at(-1)?.text).not.toContain("sk-secret");
    expect(deps.repository.updates.get(1907)).toMatchObject({ status: "processed" });

    await expect(processTelegramWebhook(update(1908, "Thursday afternoon would suit us."), deps)).resolves.toEqual({ kind: "processed" });
    expect(created).toEqual(["provider-recovery-1", "provider-recovery-2"]);
    expect(deps.repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "commercial_property", clientData: { preferredDate: "2026-08-27", preferredTimeWindow: "midday" } });
  });

  it("isolates a QUOTED date patch until the semantic availability tool performs the real Calendar read", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    let turn = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: "isolated-scheduling-patch" }; },
      async runTurn(input) {
        turn += 1;
        if (turn === 1) {
          await input.executeTool("update_client_data", { patch: {
            cleaningType: "standard", areaM2: 50, rooms: 1, bathrooms: 1,
            heavyPetHair: false, extras: [], addressOrDistrict: "Dorcol", preferredDate: "2026-08-26",
          } });
          await input.executeTool("calculate_quote", {});
          return { reply: "Your estimate is ready.", toolResults: [], steps: 2 };
        }
        const isolated = await input.executeTool("update_client_data", { patch: { preferredDate: "2026-08-27" } });
        expect(isolated).toMatchObject({ ok: true, scheduling_preference_requires_availability_tool: true, client_data: { preferredDate: "2026-08-26" } });
        const output = await input.executeTool("request_available_slots", {
          intent: { dateReference: "exact_date", exactDate: "2026-08-27", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" },
        });
        return { reply: "I checked 27 August.", toolResults: [{ name: "request_available_slots", output }], steps: 2 };
      },
    };
    const deps = { repository, telegram, calendar, agent, calendarReservation: testCalendarReservation(repository, calendar), now: () => TEST_NOW };
    await processTelegramWebhook(update(15201, "Standard 50 m2, one room, one bathroom, no pet hair or extras, Dorcol, 26 August."), deps);
    await processTelegramWebhook(update(15202, "Actually 27 August please."), deps);
    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(repository.getLead(1001)?.clientData.preferredDate).toBe("2026-08-27");
  });

  it("makes an explicit correction exclusive over a stale preferred date and active offer", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6_000, baseRsd: 6_000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vračar", preferredDate: "2026-08-24" };
    await repository.saveLead(lead);
    const reservation = testCalendarReservation(repository, calendar);
    const oldOffer = await reservation.offerSlots(lead, "ru");
    if (!oldOffer.ok) throw new Error(oldOffer.error);
    const oldTokens = await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() });
    expect(oldTokens).not.toHaveLength(0);
    const readsBeforeCorrection = calendar.availabilityQueries.length;
    let turns = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: `coordinate-mismatch-${turns}` }; },
      async runTurn(input) {
        turns += 1;
        expect(input.schedulingSnapshot).toMatchObject({
          preferredDate: "2026-08-24",
          lastOffer: { dates: ["2026-08-24"] },
          currentTurnDateCoordinate: { date: "2026-08-26", recommendedDateReference: "exact_date" },
        });
        const output = await input.executeTool("request_available_slots", { intent: turns === 1 ? {
          dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "retain_until_replacement",
        } : {
          dateReference: "exact_date", exactDate: "2026-08-26", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "reject_now",
        } });
        if (turns === 1) expect(output).toEqual({ ok: false, error: "availability_date_coordinate_mismatch" });
        else expect(output).toMatchObject({ ok: true });
        return { reply: "{}", toolResults: [{ name: "request_available_slots", output }], steps: 1, conversationResetRequired: true };
      },
    };

    await expect(processTelegramWebhook(update(152025, "Через два дня есть слоты?"), {
      repository, telegram, calendarReservation: reservation, agent, now: () => TEST_NOW,
    })).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(readsBeforeCorrection);
    expect(calendar.creates).toHaveLength(0);
    expect(await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() })).toEqual(oldTokens);
    expect(repository.getLead(1001)?.clientData.preferredDate).toBe("2026-08-24");
    expect(repository.getLead(1001)).toMatchObject({ quote: { amountRsd: 6_000 }, quoteValidity: "active" });

    await expect(processTelegramWebhook(update(152026, "Через два дня есть слоты?"), {
      repository, telegram, calendarReservation: reservation, agent, now: () => TEST_NOW,
    })).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(readsBeforeCorrection + 2);
    expect(calendar.creates).toHaveLength(0);
    expect(repository.getLead(1001)?.clientData.preferredDate).toBe("2026-08-26");
    expect((await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() })).every((token) => token.start.startsWith("2026-08-26"))).toBe(true);
  });

  it("uses a stated date once, then makes the next availability turn rely only on the durable offer", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6_000, baseRsd: 6_000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vračar" };
    await repository.saveLead(lead);
    let turns = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: `coordinate-fresh-${turns}` }; },
      async runTurn(input) {
        turns += 1;
        if (turns === 1) {
          expect(input.knownClientData.preferredDate).toBeUndefined();
          expect(input.schedulingSnapshot).toMatchObject({ currentTurnDateCoordinate: { date: "2026-08-26", recommendedDateReference: "exact_date" } });
          const output = await input.executeTool("request_available_slots", { intent: {
            dateReference: "exact_date", exactDate: "2026-08-26", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "none",
          } });
          return { reply: "{}", toolResults: [{ name: "request_available_slots", output }], steps: 1, conversationResetRequired: true };
        }
        expect(input.schedulingSnapshot?.preferredDate).toBe("2026-08-26");
        expect(input.schedulingSnapshot?.currentTurnDateCoordinate).toBeUndefined();
        const output = await input.executeTool("request_available_slots", { intent: {
          dateReference: "current_preferred_date", timePreference: "evening", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "retain_until_replacement",
        } });
        return { reply: "{}", toolResults: [{ name: "request_available_slots", output }], steps: 1, conversationResetRequired: true };
      },
    };
    const deps = { repository, telegram, calendar, calendarReservation: testCalendarReservation(repository, calendar), agent, now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(152026, "Через два дня есть слоты?"), deps)).resolves.toEqual({ kind: "processed" });
    await expect(processTelegramWebhook(update(152027, "А вечером?"), deps)).resolves.toEqual({ kind: "processed" });

    expect(turns).toBe(2);
    expect(calendar.availabilityQueries).toHaveLength(4);
    expect(calendar.creates).toHaveLength(0);
    expect(repository.getLead(1001)).toMatchObject({ clientData: { preferredDate: "2026-08-26", preferredTimeWindow: "evening" }, quoteValidity: "active" });
  });

  it("routes an infeasible cleaning duration to business review, not a Calendar outage", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 32_000, baseRsd: 32_000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "deep", areaM2: 200, rooms: 4, bathrooms: 2, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар", preferredDate: "2026-08-26" };
    await repository.saveLead(lead);
    const deps = { repository, telegram, calendar, agent: schedulingAgent({ dateReference: "current_preferred_date", timePreference: "any" }), calendarReservation: testCalendarReservation(repository, calendar), now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(15203, "Покажи свободные слоты"), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "duration_exceeds_workday" });
    expect(telegram.messages.at(-1)?.text).toContain("не получится безопасно выполнить за один рабочий слот");
  });

  it.each([
    "agent_provider_timeout",
    "agent_provider_http_error",
    "agent_provider_transport_error",
  ] as const)("safely resends after %s while creating a fresh Conversation", async (code) => {
    const base = dependencies();
    const deps = { ...base, agent: {
      async createConversation() { throw new AgentTurnTechnicalError(code); },
      async runTurn() { throw new Error("a failed Conversation creation must not run a turn"); },
    } };

    await expect(processTelegramWebhook(update(1909, "Need standard cleaning."), deps)).resolves.toEqual({ kind: "processed" });
    const lead = deps.repository.getLead(1001);
    expect(lead).toMatchObject({ humanNeeded: false, clientData: {} });
    await expect(deps.repository.getConversation(lead?.id ?? "missing")).resolves.toBeNull();
    expect(deps.telegram.messages).toHaveLength(1);
    expect(deps.telegram.messages[0]?.text).toContain("last message could not be processed safely");
    expect(deps.repository.updates.get(1909)).toMatchObject({ status: "processed" });
  });

  it.each([
    "provider_response_budget_exceeded_before_request_221",
    "customer_turn_deadline_exceeded",
  ] as const)("propagates evaluator control fence %s without a technical resend", async (code) => {
    const base = dependencies();
    const fence = Object.assign(new Error("evaluator fence"), { code });
    const deps = { ...base, agent: {
      async createConversation() { throw fence; },
      async runTurn() { throw new Error("run must not happen"); },
    } };
    await expect(processTelegramWebhook(update(1911, "Need cleaning."), deps)).rejects.toBe(fence);
    expect(deps.telegram.messages).toHaveLength(0);
    expect(deps.repository.getLead(1001)).toMatchObject({ humanNeeded: false, clientData: {} });
  });

  it("persists a late New Belgrade detail after an over-200m² handoff before composing a truthful reply", async () => {
    const base = dependencies();
    const deps = { ...base, agent: {
      async createConversation() { return { id: "over-200-location" }; },
      async runTurn(input: import("@/lib/agent/gateway").AgentTurnInput) {
        if (!input.knownClientData.areaM2) {
          await input.executeTool("update_client_data", { patch: { cleaningType: "standard", areaM2: 240 } });
          return { reply: "Our team will review the request.", toolResults: [], steps: 1 };
        }
        expect(input.knownClientData.addressOrDistrict).toBe("New Belgrade");
        return { reply: "Acknowledged.", toolResults: [], steps: 0 };
      },
    } };
    await processTelegramWebhook(update(1909, "Standard cleaning, 240 m2."), deps);
    expect(deps.repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "area_over_200_m2" });

    await processTelegramWebhook(update(1910, "Новый Белград."), deps);
    expect(deps.repository.getLead(1001)?.clientData.addressOrDistrict).toBe("New Belgrade");
    expect(deps.telegram.messages.at(-1)?.text).toContain("Новый Белград добавил");
  });

  it("recovers an accepted MaxTurns fixture without restarting known facts or duplicating the resent bathroom", async () => {
    const base = dependencies();
    const created: string[] = [];
    const deps = { ...base, agent: {
      async createConversation() { const id = `recovery-${created.length + 1}`; created.push(id); return { id }; },
      async runTurn(input: import("@/lib/agent/gateway").AgentTurnInput) {
        if (input.conversationId === "recovery-1" && input.message.includes("50")) {
          await input.executeTool("update_client_data", { patch: { cleaningType: "standard", areaM2: 50, rooms: 2, addressOrDistrict: "Vracar" } });
          return { reply: "How many bathrooms are there?", toolResults: [], steps: 1 };
        }
        if (input.conversationId === "recovery-1") throw new AgentTurnTechnicalError("agent_max_turns_exceeded");
        expect(input.conversationId).toBe("recovery-2");
        expect(input.knownClientData).toMatchObject({ cleaningType: "standard", areaM2: 50, rooms: 2, addressOrDistrict: "Vracar" });
        expect(input.knownClientData.bathrooms).toBeUndefined();
        await input.executeTool("update_client_data", { patch: { bathrooms: 1 } });
        return { reply: "Any heavy pet hair or extra services?", toolResults: [], steps: 1 };
      },
    } };
    await processTelegramWebhook(update(1902, "Standard cleaning, 50 m2 in Vracar, two rooms."), deps);
    await processTelegramWebhook(update(1903, "One bathroom."), deps);
    expect(deps.telegram.messages.at(-1)?.text).toContain("last message could not be processed safely");
    const lead = deps.repository.getLead(1001);
    await expect(deps.repository.getConversation(lead?.id ?? "missing")).resolves.toBeNull();
    await processTelegramWebhook(update(1904, "One bathroom."), deps);
    expect(created).toEqual(["recovery-1", "recovery-2"]);
    expect(deps.repository.getLead(1001)).toMatchObject({
      clientData: { cleaningType: "standard", areaM2: 50, rooms: 2, bathrooms: 1, addressOrDistrict: "Vracar" },
      humanNeeded: false,
    });
    expect(deps.repository.getLead(1001)?.quote).toBeUndefined();
    expect(deps.calendar.availabilityQueries).toHaveLength(0);
    expect(deps.telegram.messages.at(-1)?.text).toBe("Any heavy pet hair or extra services?");
  });

  it("hands off only when the freshly created replacement Conversation also fails technically", async () => {
    const base = dependencies();
    let creates = 0;
    const deps = { ...base, agent: {
      async createConversation() { creates += 1; return { id: `technical-${creates}` }; },
      async runTurn() { throw new AgentTurnTechnicalError("agent_max_turns_exceeded"); },
    } };
    await expect(processTelegramWebhook(update(1910, "Need cleaning"), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.repository.getLead(1001)).toMatchObject({ humanNeeded: false });
    await expect(processTelegramWebhook(update(1911, "50 m2"), deps)).resolves.toEqual({ kind: "processed" });
    expect(creates).toBe(2);
    expect(deps.repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "conversation_ambiguous" });
  });

  it("makes a successful quote terminal for its customer turn", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const agent: AgentGateway = {
      async createConversation() { return { id: "quote-terminal" }; },
      async runTurn(input) {
        await input.executeTool("update_client_data", { patch: {
          cleaningType: "standard", areaM2: 40, rooms: 1, bathrooms: 1,
          heavyPetHair: false, extras: [], addressOrDistrict: "Dorcol",
        } });
        const quote = await input.executeTool("calculate_quote", {});
        expect(quote).toMatchObject({ ok: true, kind: "quote" });
        expect(await input.executeTool("request_available_slots", {})).toMatchObject({ ok: false, error: "quote_is_terminal_for_customer_turn" });
        expect(await input.executeTool("mark_human_needed", { reason: "scope_uncertain" })).toMatchObject({ ok: false, error: "quote_is_terminal_for_customer_turn" });
        return { reply: "Your estimate is ready.", toolResults: [], steps: 3 };
      },
    };
    await expect(processTelegramWebhook(update(1912, "Price first please"), {
      repository, telegram, agent, calendarReservation: new CalendarReservationService(repository, calendar),
    })).resolves.toEqual({ kind: "processed" });
    const lead = repository.getLead(1001);
    expect(lead).toMatchObject({ status: "qualified", quote: { amountRsd: 4000, sameDayApplied: false }, humanNeeded: false });
    expect(lead?.clientData.preferredDate).toBeUndefined();
    expect(lead?.clientData.urgency).toBeUndefined();
    expect(calendar.availabilityQueries).toHaveLength(0);
  });

  it("checks real availability and aligns a same-day quote for a compact today request", async () => {
    const now = new Date("2026-08-24T10:00:00.000Z");
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    let turn = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: "base-to-today" }; },
      async runTurn(input) {
        turn += 1;
        if (turn === 1) {
          await input.executeTool("update_client_data", { patch: { cleaningType: "standard", areaM2: 50, rooms: 1, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar" } });
          await input.executeTool("calculate_quote", {});
          return { reply: "Your base quote is ready.", toolResults: [], steps: 2 };
        }
        if (turn === 2) {
          expect(input.schedulingDecisionRequired).toBe(true);
          const output = await input.executeTool("request_available_slots", {
            intent: { dateReference: "today", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" },
          });
          return { reply: "Here are today's options.", toolResults: [{ name: "request_available_slots", output }], steps: 1 };
        }
        throw new Error("unexpected extra scheduling turn");
      },
    };
    const deps = { repository, telegram, calendar, agent, calendarReservation: new CalendarReservationService(repository, calendar, undefined, () => now), now: () => now };
    await processTelegramWebhook(update(1913, "Standard 50 m2, one room, one bathroom, no pet hair or extras, Vracar."), deps);
    expect(repository.getLead(1001)?.quote).toMatchObject({ amountRsd: 4_000, sameDayApplied: false });
    await processTelegramWebhook(update(1914, "Today please."), deps);
    expect(repository.getLead(1001)?.quote).toMatchObject({ amountRsd: 4_800, sameDayApplied: true });
    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(telegram.messages.at(-1)?.text).toContain("Nearest available times");
  });

  it("renders a backend-owned date-required reply instead of terminal availability tool JSON", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar" };
    await repository.saveLead(lead);
    const agent: AgentGateway = {
      async createConversation() { return { id: "terminal-date-required" }; },
      async runTurn(input) {
        const output = await input.executeTool("request_available_slots", {
          intent: { dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" },
        });
        expect(output).toEqual({ ok: false, error: "availability_date_required" });
        return { reply: '{"ok":false,"error":"availability_date_required"}', toolResults: [{ name: "request_available_slots", output }], steps: 1, conversationResetRequired: true };
      },
    };

    await expect(processTelegramWebhook(update(1915, "Please show free times."), {
      repository, telegram, calendarReservation: testCalendarReservation(repository, calendar), agent, now: () => TEST_NOW,
    })).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(0);
    expect(calendar.creates).toHaveLength(0);
    expect(telegram.messages.at(-1)?.text).toContain("specific future date");
    expect(telegram.messages.at(-1)?.text).not.toContain("availability_date_required");
    await expect(repository.getConversation(lead.id)).resolves.toBeNull();
  });

  it("resets a no-slots terminal result without exposing tool JSON or creating a booking", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    calendar.busyByTeam = {
      team_a: [{ start: "2026-08-26T00:00:00.000Z", end: "2026-09-10T00:00:00.000Z" }],
      team_b: [{ start: "2026-08-26T00:00:00.000Z", end: "2026-09-10T00:00:00.000Z" }],
    };
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-26" };
    await repository.saveLead(lead);
    await repository.saveConversation({ leadId: lead.id, telegramChatId: 1001, openAiConversationId: "terminal-no-slots" });
    const agent: AgentGateway = {
      async createConversation() { throw new Error("terminal no-slots turn must use existing Conversation"); },
      async runTurn(input) {
        const output = await input.executeTool("request_available_slots", {
          intent: { dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" },
        });
        expect(output).toMatchObject({ ok: false, error: "no_available_slots" });
        return { reply: '{"ok":false,"error":"no_available_slots"}', toolResults: [{ name: "request_available_slots", output }], steps: 1, conversationResetRequired: true };
      },
    };

    await expect(processTelegramWebhook(update(19155, "Show slots."), {
      repository, telegram, calendarReservation: testCalendarReservation(repository, calendar), agent, now: () => TEST_NOW,
    })).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(calendar.creates).toHaveLength(0);
    expect(telegram.messages.at(-1)?.text).toContain("no free slots");
    expect(telegram.messages.at(-1)?.text).not.toContain("no_available_slots");
    await expect(repository.getConversation(lead.id)).resolves.toBeNull();
  });

  it("resets the terminal-tool Conversation so the next turn starts fresh from the offered snapshot", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-26" };
    await repository.saveLead(lead);
    let turns = 0;
    const createdConversations: string[] = [];
    const agent: AgentGateway = {
      async createConversation() {
        const id = turns === 0 ? "terminal-offered-context" : "fresh-offered-context";
        createdConversations.push(id);
        return { id };
      },
      async runTurn(input) {
        turns += 1;
        if (turns === 1) {
          const output = await input.executeTool("request_available_slots", {
            intent: { dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" },
          });
          return { reply: '{"ok":true,"options":[1]}', toolResults: [{ name: "request_available_slots", output }], steps: 1, conversationResetRequired: true };
        }
        expect(input.conversationId).toBe("fresh-offered-context");
        expect(input.schedulingSnapshot).toMatchObject({ state: "offered", lastOffer: { labels: expect.any(Array) }, activeQuoteAmountRsd: 6000 });
        const output = await input.executeTool("record_scheduling_decision", { reason: "awaiting_customer_choice" });
        return { reply: "Please choose an option.", toolResults: [{ name: "record_scheduling_decision", output }], steps: 1 };
      },
    };
    const deps = { repository, telegram, calendar, calendarReservation: testCalendarReservation(repository, calendar), agent, now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(1916, "Show slots."), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(calendar.creates).toHaveLength(0);
    expect(await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() })).toHaveLength(3);
    expect(repository.activities).toContainEqual(expect.objectContaining({
      eventType: "calendar_availability_attempted",
      payload: expect.objectContaining({ result: "exact_offer" }),
    }));
    expect(telegram.messages.at(-1)?.text).toContain("Nearest available times");
    await expect(repository.getConversation(lead.id)).resolves.toBeNull();

    await expect(processTelegramWebhook(update(1916, "Show slots."), deps)).resolves.toEqual({ kind: "duplicate" });
    expect(createdConversations).toEqual(["terminal-offered-context"]);
    expect(calendar.availabilityQueries).toHaveLength(2);

    await expect(processTelegramWebhook(update(1917, "Thanks."), deps)).resolves.toEqual({ kind: "processed" });
    expect(turns).toBe(2);
    expect(createdConversations).toEqual(["terminal-offered-context", "fresh-offered-context"]);
    expect(calendar.creates).toHaveLength(0);
  });

  it.each([
    ["en", "Please show available slots", "Nearest available times"],
    ["ru", "Покажи свободные слоты", "Ближайшее свободное время"],
    ["sr-Latn", "Pokaži slobodne termine", "Najbliži slobodni termini"],
    ["sr-Cyrl", "Покажи слободне термине", "Најближи слободни термини"],
  ] as const)("routes a %s availability request through the state-scoped agent", async (_language, request, expectedReply) => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    let agentTurns = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: "availability-fast-path" }; },
      async runTurn(input) {
        agentTurns += 1;
        if (input.schedulingDecisionRequired) {
          const output = await input.executeTool("request_available_slots", { intent: { dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" } });
          return { reply: "Here are the real times.", toolResults: [{ name: "request_available_slots", output }], steps: 1 };
        }
        await input.executeTool("update_client_data", { patch: {
          cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 2,
          heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-09-03",
        } });
        await input.executeTool("calculate_quote", {});
        return { reply: "quote", toolResults: [], steps: 2 };
      },
    };
    const deps = { repository, telegram, calendar, agent, calendarReservation: testCalendarReservation(repository, calendar), now: () => TEST_NOW };

    await processTelegramWebhook(update(1500, "Full cleaning fixture"), deps);
    if (_language === "ru") {
      const lead = repository.getLead(1001);
      if (!lead) throw new Error("lead missing");
      lead.firstMessageLanguage = "ru";
      await repository.saveLead(lead);
    }
    await expect(processTelegramWebhook(update(1501, request), deps)).resolves.toEqual({ kind: "processed" });

    expect(agentTurns).toBe(2);
    expect(telegram.messages.at(-1)?.text).toContain(expectedReply);
    expect(repository.trelloSyncJobs.get(repository.getLead(1001)?.id ?? "missing")).toMatchObject({ desiredLifecycle: "qualified" });
  });

  it("renders requested-date alternatives and only next-day buttons when the requested weekday is full", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар", preferredDate: "2026-08-24" };
    await repository.saveLead(lead);
    const requestedDayBusy = [{ start: "2026-08-24T06:00:00.000Z", end: "2026-08-24T18:00:00.000Z" }];
    calendar.busyByTeam = { team_a: requestedDayBusy, team_b: requestedDayBusy };
    const agent = schedulingAgent({ dateReference: "current_preferred_date", timePreference: "any" });
    const deps = { repository, telegram, calendar, agent, calendarReservation: testCalendarReservation(repository, calendar), now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(15190, "Покажи свободные слоты"), deps)).resolves.toEqual({ kind: "processed" });

    expect(telegram.messages.at(-1)?.text).toContain("На выбранную дату свободных слотов нет");
    const markup = telegram.messages.at(-1)?.replyMarkup;
    if (!markup || !("inline_keyboard" in markup)) throw new Error("slot keyboard missing");
    expect(markup.inline_keyboard.flat().map((button) => button.text)).toHaveLength(3);
    expect(markup.inline_keyboard.flat().every((button) => button.text.includes("25"))).toBe(true);
    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(calendar.creates).toHaveLength(0);
    expect(repository.getLead(1001)).toMatchObject({ status: "qualified", humanNeeded: false, quoteValidity: "active" });
  });

  it("downgrades an already-correct same-day quote when an after-hours today check yields only genuine future alternatives", async () => {
    const now = new Date("2026-08-24T19:42:00.000Z"); // 21:42 Europe/Belgrade
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 7200, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: true, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар", preferredDate: "2026-08-24", urgency: "same_day" };
    await repository.saveLead(lead);
    const agent = schedulingAgent({ dateReference: "today", timePreference: "any" });
    const deps = { repository, telegram, calendar, agent, calendarReservation: new CalendarReservationService(repository, calendar, undefined, () => now), now: () => now };

    await expect(processTelegramWebhook(update(15191, "А сегодня разве есть слоты?"), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(calendar.creates).toHaveLength(0);
    expect(repository.getLead(1001)).toMatchObject({
      status: "qualified",
      quoteValidity: "active",
      quote: { sameDayApplied: false, amountRsd: 6000 },
      clientData: { preferredDate: "2026-08-25" },
    });
    const offered = await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: now.toISOString() });
    expect(offered).not.toHaveLength(0);
    expect(offered.every((slot) => !slot.start.startsWith("2026-08-24"))).toBe(true);
    expect(telegram.messages.at(-1)?.text).toContain("На выбранную дату свободных слотов нет");
    expect(telegram.messages.at(-1)?.text).toContain("Стоимость для этих вариантов: <b>6 000 RSD</b>");

    await expect(processTelegramWebhook(callback(15192, "future-book", `slot:ru:${offered[0]!.token}`), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.creates).toHaveLength(1);
    expect(repository.getLead(1001)).toMatchObject({ calendarEventId: expect.any(String), quote: { amountRsd: 6000, sameDayApplied: false } });
  });

  it("persists the same-day quote before tokens when a compact today question has a real today slot, then creates exactly one event after selection", async () => {
    const now = new Date("2026-08-24T06:00:00.000Z"); // 08:00 Europe/Belgrade
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар" };
    await repository.saveLead(lead);
    const agent = schedulingAgent({ dateReference: "today", timePreference: "any" });
    const deps = { repository, telegram, calendar, agent, calendarReservation: new CalendarReservationService(repository, calendar, undefined, () => now), now: () => now };

    await expect(processTelegramWebhook(update(15193, "А есть ли окна на сегодня?"), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(calendar.creates).toHaveLength(0);
    expect(repository.getLead(1001)).toMatchObject({
      status: "qualified",
      quoteValidity: "active",
      quote: { sameDayApplied: true, amountRsd: 7200 },
      clientData: { preferredDate: "2026-08-24", urgency: "same_day" },
    });
    const tokens = await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: now.toISOString() });
    expect(tokens).not.toHaveLength(0);
    expect(tokens.every((slot) => slot.start.startsWith("2026-08-24"))).toBe(true);
    expect(telegram.messages.at(-1)?.text).toContain("Стоимость для этих вариантов: <b>7 200 RSD</b>");

    await expect(processTelegramWebhook(callback(15194, "today-book", `slot:ru:${tokens[0]!.token}`), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.creates).toHaveLength(1);
    expect(repository.getLead(1001)).toMatchObject({ calendarEventId: expect.any(String), quote: { amountRsd: 7200, sameDayApplied: true } });
  });

  it("keeps a mixed today-plus-future availability scan price-homogeneous by exposing only the today candidates", async () => {
    const now = new Date("2026-08-24T13:15:00.000Z"); // 15:15 Europe/Belgrade
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 4000, baseRsd: 4000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    // At 15:15, a 25m² same-day job has two 17:30 Team candidates and the
    // engine's unfiltered third candidate would be on the next working day.
    lead.clientData = { cleaningType: "standard", areaM2: 25, rooms: 1, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар" };
    await repository.saveLead(lead);
    const agent = schedulingAgent({ dateReference: "today", timePreference: "any" });
    const deps = { repository, telegram, calendar, agent, calendarReservation: new CalendarReservationService(repository, calendar, undefined, () => now), now: () => now };

    await expect(processTelegramWebhook(update(15195, "Есть что-то на сегодня?"), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(calendar.creates).toHaveLength(0);
    const tokens = await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: now.toISOString() });
    expect(tokens).toHaveLength(2);
    expect(tokens.every((slot) => slot.start.startsWith("2026-08-24"))).toBe(true);
    expect(repository.getLead(1001)).toMatchObject({ quote: { amountRsd: 4800, sameDayApplied: true }, clientData: { preferredDate: "2026-08-24", urgency: "same_day" } });
    expect(telegram.messages.at(-1)?.text).toContain("Стоимость для этих вариантов: <b>4 800 RSD</b>");

    await expect(processTelegramWebhook(callback(15196, "mixed-book", `slot:ru:${tokens[0]!.token}`), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.creates).toHaveLength(1);
    expect(repository.getLead(1001)).toMatchObject({ calendarEventId: expect.any(String), quote: { amountRsd: 4800, sameDayApplied: true } });
  });

  it("re-queries both calendars for compact Russian and English today questions during working hours", async () => {
    const now = new Date("2026-08-24T06:00:00.000Z"); // 08:00 Europe/Belgrade
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар" };
    await repository.saveLead(lead);
    const agent = schedulingAgent({ dateReference: "today", timePreference: "any" });
    const deps = { repository, telegram, calendar, agent, calendarReservation: new CalendarReservationService(repository, calendar, undefined, () => now), now: () => now };

    for (const [index, message] of [
      "А сегодня разве есть слоты?",
      "А есть ли окна на сегодня?",
      "Какие окна есть сегодня?",
      "Есть что-то на сегодня?",
      "Можно сегодня?",
      "А вечером есть слоты?",
      "Are there any slots today?",
    ].entries()) {
      await expect(processTelegramWebhook(update(15194 + index, message), deps)).resolves.toEqual({ kind: "processed" });
    }

    expect(calendar.availabilityQueries).toHaveLength(14);
    expect(calendar.creates).toHaveLength(0);
    expect(repository.getLead(1001)).toMatchObject({ status: "qualified", quoteValidity: "active", quote: { sameDayApplied: true, amountRsd: 7200 } });
    const tokens = await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: now.toISOString() });
    expect(tokens).not.toHaveLength(0);
    expect(tokens.every((slot) => slot.start.startsWith("2026-08-24"))).toBe(true);
  });

  it("records an explicit pet-hair answer before the model turn and prevents that turn from overwriting it", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.clientData = { cleaningType: "standard", areaM2: 50, rooms: 2, bathrooms: 1, extras: [], addressOrDistrict: "Врачар" };
    await repository.saveLead(lead);
    const agent: AgentGateway = {
      async createConversation() { return { id: "pet-hair-fact" }; },
      async runTurn(input) {
        expect(input.knownClientData.heavyPetHair).toBe(true);
        const saved = await input.executeTool("update_client_data", { patch: { heavyPetHair: false } });
        expect(saved.ok).toBe(true);
        expect(saved.client_data).toMatchObject({ heavyPetHair: true });
        await input.executeTool("calculate_quote", {});
        return { reply: "Учту сильную шерсть.", toolResults: [], steps: 2 };
      },
    };

    await expect(processTelegramWebhook(update(15192, "Да, шерсть есть, собака дома шерстяная"), { repository, telegram, agent, now: () => TEST_NOW })).resolves.toEqual({ kind: "processed" });

    expect(repository.getLead(1001)).toMatchObject({ clientData: { heavyPetHair: true }, quote: { petHairSurchargeRsd: 900 } });
    expect(repository.activities).toContainEqual(expect.objectContaining({ eventType: "pet_hair_recorded", payload: { heavy_pet_hair: true } }));
  });

  it("does not convert a pet-only message into a pricing fact before the pet-hair question is due", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const agent: AgentGateway = {
      async createConversation() { return { id: "pet-not-context" }; },
      async runTurn(input) {
        expect(input.knownClientData.heavyPetHair).toBeUndefined();
        return { reply: "Какая примерно площадь квартиры?", toolResults: [], steps: 0 };
      },
    };
    await processTelegramWebhook(update(15193, "У меня дома собака"), { repository, telegram, agent, now: () => TEST_NOW });
    expect(repository.getLead(1001)?.clientData.heavyPetHair).toBeUndefined();
  });

  it("makes a Cyrillic pet-hair negation authoritative and ignores a wool-carpet statement", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.clientData = { cleaningType: "standard", areaM2: 50, rooms: 2, bathrooms: 1, extras: [], addressOrDistrict: "Врачар" };
    await repository.saveLead(lead);
    const observed: Array<boolean | undefined> = [];
    const agent: AgentGateway = {
      async createConversation() { return { id: "pet-negation" }; },
      async runTurn(input) { observed.push(input.knownClientData.heavyPetHair); return { reply: "Записал.", toolResults: [], steps: 0 }; },
    };
    const deps = { repository, telegram, agent, now: () => TEST_NOW };

    await processTelegramWebhook(update(15197, "Нет, собака дома, сильной шерсти нет"), deps);
    expect(repository.getLead(1001)?.clientData.heavyPetHair).toBe(false);
    const second = repository.getLead(1001);
    if (!second) throw new Error("lead missing");
    second.clientData = { ...second.clientData, heavyPetHair: undefined };
    await repository.saveLead(second);
    await processTelegramWebhook(update(15198, "Собака лежит на шерстяном ковре"), deps);
    expect(observed).toEqual([false, undefined]);
    expect(repository.getLead(1001)?.clientData.heavyPetHair).toBeUndefined();
  });

  it.each(["show slots, 1 bathroom", "вечером, 2 санузла"])("does not fast-path availability wording mixed with new cleaning details: %s", async (message) => {
    const deps = dependencies();
    const runTurn = vi.spyOn(deps.agent, "runTurn");
    await processTelegramWebhook(update(1510, "standard cleaning, 75 m2, 3 rooms, 2 bathrooms, no pet hair, no extras, district: Vracar, 2026-09-03"), deps);
    await processTelegramWebhook(update(1511, message), deps);
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it("keeps word-number and positive customer facts on the agent path even when a durable slot offer is active", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const calendarReservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар", preferredDate: "2026-08-29" };
    await repository.saveLead(lead);
    await calendarReservation.offerSlots(lead, "ru");
    const received: string[] = [];
    const agent: AgentGateway = {
      async createConversation() { return { id: "mixed-active-offer" }; },
      async runTurn(input) {
        received.push(input.message);
        if (input.message.includes("две комнаты")) {
          await input.executeTool("update_client_data", { patch: { rooms: 2 } });
          return { reply: "Записал две комнаты.", toolResults: [], steps: 1 };
        }
        if (input.message.includes("кот сильно линяет")) {
          await input.executeTool("update_client_data", { patch: { heavyPetHair: true } });
          await input.executeTool("calculate_quote", {});
          return { reply: "Учту сильную шерсть.", toolResults: [], steps: 1 };
        }
        await input.executeTool("mark_human_needed", { reason: "unsupported_service" });
        return { reply: "Проверю глажку с командой.", toolResults: [], steps: 1 };
      },
    };
    const deps = { repository, telegram, calendar, agent, calendarReservation, now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(15115, "вечером, две комнаты"), deps)).resolves.toEqual({ kind: "processed" });
    await expect(processTelegramWebhook(update(15116, "вечером, кот сильно линяет"), deps)).resolves.toEqual({ kind: "processed" });
    await expect(processTelegramWebhook(update(15117, "вечером, нужна глажка"), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(2); // the original offer only
    expect(received).toEqual(["вечером, две комнаты", "вечером, кот сильно линяет", "вечером, нужна глажка"]);
    expect(repository.getLead(1001)).toMatchObject({
      clientData: { rooms: 2, heavyPetHair: true, preferredDate: "2026-08-29" },
      humanNeeded: true,
      humanNeededReason: "unsupported_service",
    });
  });

  it("re-queries a durable Russian offer through semantic agent decisions", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const calendarReservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар", preferredDate: "2026-08-29" };
    await repository.saveLead(lead);
    const firstOffer = await calendarReservation.offerSlots(lead, "ru");
    if (!firstOffer.ok) throw new Error(firstOffer.error);
    const oldToken = firstOffer.slots[0]!.token;
    const lastInitialStart = Math.max(...firstOffer.slots.map((slot) => new Date(slot.start).getTime()));
    const availabilityOutputs: Array<Record<string, unknown>> = [];
    const agent: AgentGateway = {
      async createConversation() { return { id: "semantic-followup" }; },
      async runTurn(input) {
        const lower = input.message.toLocaleLowerCase();
        const intent = lower.includes("позже")
          ? { dateReference: "same_day_as_last_offer" as const, timePreference: "any" as const, timePreferenceMode: "preserve" as const, relation: "later_than_last_offer" as const }
          : lower.includes("19")
          ? { dateReference: "same_day_as_last_offer" as const, timePreference: "after" as const, timePreferenceMode: "explicit" as const, afterLocalTime: "19:00", relation: "fresh" as const }
          : lower.includes("до 12")
          ? { dateReference: "current_preferred_date" as const, timePreference: "before" as const, timePreferenceMode: "explicit" as const, beforeLocalTime: "12:00", relation: "fresh" as const }
          : lower.includes("середине")
          ? { dateReference: "current_preferred_date" as const, timePreference: "midday" as const, timePreferenceMode: "explicit" as const, relation: "fresh" as const }
          : { dateReference: "day_after_last_offer" as const, timePreference: "evening" as const, timePreferenceMode: "explicit" as const, relation: "fresh" as const };
        const output = await input.executeTool("request_available_slots", { intent });
        availabilityOutputs.push(output);
        return { reply: "Проверяю доступные варианты.", toolResults: [{ name: "request_available_slots", output }], steps: 1 };
      },
    };
    const deps = { repository, telegram, calendar, agent, calendarReservation, now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(1512, "Не подходит, а позже?"), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(4);
    const later = await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() });
    expect(later).not.toHaveLength(0);
    expect(later.every((slot) => new Date(slot.start).getTime() >= lastInitialStart + 30 * 60_000)).toBe(true);
    expect(repository.getLead(1001)?.clientData.preferredDate).toBe("2026-08-29");
    await expect(processTelegramWebhook(callback(1513, "stale-later", `slot:ru:${oldToken}`), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.creates).toHaveLength(0);

    const timeWindowBeforeAfter19 = repository.getLead(1001)?.clientData.preferredTimeWindow;
    await expect(processTelegramWebhook(update(1514, "после 19:00"), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(6);
    expect(telegram.messages.at(-1)?.text).toContain("В заданный промежуток");
    const after19 = await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() });
    // The 75m² job cannot begin after 19:00. The request is a hard bound,
    // so the old offer remains selectable until the customer gives fresh
    // consent for another time/day instead of receiving a 17:30 substitute.
    expect(after19.map((slot) => slot.start)).toEqual(later.map((slot) => slot.start));
    expect(availabilityOutputs[1]).toMatchObject({
      ok: false,
      error: "no_available_slots",
      availabilityReason: "requested_time_unavailable",
      existingOfferDisposition: "retain_until_replacement",
      hardTimeConstraint: { kind: "after", afterLocalTime: "19:00" },
      allowedNextUserConsentPaths: ["earlier_time", "different_date"],
    });
    expect(repository.getLead(1001)).toMatchObject({ humanNeeded: false, clientData: { preferredDate: "2026-08-29" } });
    expect(repository.getLead(1001)?.clientData.preferredTimeWindow).toBe(timeWindowBeforeAfter19);

    await expect(processTelegramWebhook(update(1515, "в середине дня"), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(8);
    expect(repository.getLead(1001)?.clientData.preferredTimeWindow).toBe("midday");
    expect(telegram.messages.at(-1)?.text).toContain("Ближайшее свободное время");

    await expect(processTelegramWebhook(update(1516, "тогда на следующий день вечером"), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(10);
    // The preceding midday read returned the next actual offered day. The
    // semantic "next day" therefore advances from that durable offer, never
    // from the webhook's current day (24th) or stale original preference.
    expect(repository.getLead(1001)?.clientData.preferredDate).toBe("2026-08-31");

    // A bounded "before" request still invokes the same Team A/B snapshot
    // executor once (two reads); it is not diverted into a backend router.
    await expect(processTelegramWebhook(update(1517, "до 12:00"), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(12);
  });

  it("resets the disposable Conversation and replies when a retained offer is refined to after 15:00", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const calendarReservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1550, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар", preferredDate: "2026-08-27" };
    await repository.saveLead(lead);
    const firstOffer = await calendarReservation.offerSlots(lead, "ru");
    if (!firstOffer.ok) throw new Error(firstOffer.error);
    const activeStartsBefore = (await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() })).map((slot) => slot.start);
    await repository.saveConversation({ leadId: lead.id, telegramChatId: 1550, openAiConversationId: "terminal-availability-follow-up" });
    // The hard bound is evaluated across the bounded availability horizon.
    // It must retain the displayed 12:00/12:30-style offer rather than
    // silently substitute an earlier time or silently drop the reply.
    const allHorizonBusy = [{ start: "2026-08-24T06:00:00.000Z", end: "2026-09-12T18:00:00.000Z" }];
    calendar.busyByTeam = { team_a: allHorizonBusy, team_b: allHorizonBusy };
    const agent: AgentGateway = {
      async createConversation() { throw new Error("must use the saved Conversation for this follow-up"); },
      async runTurn(input) {
        const output = await input.executeTool("request_available_slots", { intent: {
          dateReference: "same_day_as_last_offer", timePreference: "after", timePreferenceMode: "explicit",
          afterLocalTime: "15:00", relation: "fresh", existingOfferDisposition: "retain_until_replacement",
        } });
        return {
          reply: "Проверяю варианты после 15:00.",
          toolResults: [{ name: "request_available_slots", output }],
          steps: 1,
          conversationResetRequired: true,
        };
      },
    };

    await expect(processTelegramWebhook(update(1551, "А после 15 часов есть?", 1550), {
      repository, telegram, calendarReservation, agent, now: () => TEST_NOW,
    })).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(4); // original Team A+B offer plus this re-read
    expect(calendar.creates).toHaveLength(0);
    await expect(repository.getConversation(lead.id)).resolves.toBeNull();
    expect((await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() })).map((slot) => slot.start)).toEqual(activeStartsBefore);
    expect(telegram.messages.at(-1)?.text).toContain("свободных слотов нет");
  });

  it.each([
    ["after", { timePreference: "after" as const, afterLocalTime: "19:00" }, { kind: "after", afterLocalTime: "19:00" }, ["earlier_time", "different_date"], "более раннее время"],
    ["before", { timePreference: "before" as const, beforeLocalTime: "12:00" }, { kind: "before", beforeLocalTime: "12:00" }, ["later_time", "different_date"], "более позднее время"],
    ["range", { timePreference: "range" as const, afterLocalTime: "10:00", beforeLocalTime: "16:00" }, { kind: "range", afterLocalTime: "10:00", beforeLocalTime: "16:00" }, ["outside_requested_range", "different_date"], "расширить этот диапазон времени"],
  ] as const)("keeps a retained offer and returns typed %s constraint consent when the bounded horizon is full", async (_kind, time, hardTimeConstraint, allowedNextUserConsentPaths, copy) => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const calendarReservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1610, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified"; lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар", preferredDate: "2026-08-29" };
    await repository.saveLead(lead);
    const firstOffer = await calendarReservation.offerSlots(lead, "ru");
    if (!firstOffer.ok) throw new Error(firstOffer.error);
    const oldToken = firstOffer.slots[0]!.token;
    const startsBefore = (await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() })).map((slot) => slot.start);
    const allHorizonBusy = [{ start: "2026-08-24T06:00:00.000Z", end: "2026-09-12T18:00:00.000Z" }];
    calendar.busyByTeam = { team_a: allHorizonBusy, team_b: allHorizonBusy };
    let availabilityOutput: Record<string, unknown> | undefined;
    const agent: AgentGateway = {
      async createConversation() { return { id: "bounded-no-slots" }; },
      async runTurn(input) {
        availabilityOutput = await input.executeTool("request_available_slots", { intent: {
          dateReference: "same_day_as_last_offer", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "retain_until_replacement", ...time,
        } });
        return { reply: "Проверяю.", toolResults: [{ name: "request_available_slots", output: availabilityOutput }], steps: 1 };
      },
    };
    const deps = { repository, telegram, calendar, agent, calendarReservation, now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(1611, "Покажи свободные слоты", 1610), deps)).resolves.toEqual({ kind: "processed" });
    expect(availabilityOutput).toMatchObject({
      ok: false, error: "no_available_slots", availabilityReason: "requested_time_unavailable",
      existingOfferDisposition: "retain_until_replacement", hardTimeConstraint, allowedNextUserConsentPaths,
    });
    expect(telegram.messages.at(-1)?.text).toContain(copy);
    expect(calendar.availabilityQueries).toHaveLength(4);
    expect((await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() })).map((slot) => slot.start)).toEqual(startsBefore);
    expect(repository.getLead(1610)).toMatchObject({ humanNeeded: false, clientData: { preferredDate: "2026-08-29" } });

    calendar.busyByTeam = { team_a: [], team_b: [] };
    await expect(processTelegramWebhook(callback(1612, `retained-${_kind}`, `slot:ru:${oldToken}`, 1610), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.creates).toHaveLength(1);
  });

  it("uses a versioned, unexpired pending date proposal for a bare Russian yes and then queries slots", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const calendarReservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар" };
    await repository.saveLead(lead);
    const agent: AgentGateway = { async createConversation() { throw new Error("pending schedule acceptance is backend-owned"); }, async runTurn() { throw new Error("pending schedule acceptance is backend-owned"); } };
    const deps = { repository, telegram, calendar, agent, calendarReservation, now: () => TEST_NOW };

    await processTelegramWebhook(update(1517, "хочу уборку на выходных"), deps);
    expect(repository.getLead(1001)).toMatchObject({ pendingPreferredDate: "2026-08-29", dateProposalVersion: expect.any(String), dateProposalExpiresAt: expect.any(String) });
    await expect(processTelegramWebhook(update(1518, "да"), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(repository.getLead(1001)).toMatchObject({ pendingPreferredDate: undefined, clientData: { preferredDate: "2026-08-29" } });
    expect(telegram.messages.at(-1)?.text).toContain("Ближайшее свободное время");
  });

  it("uses bare post-quote Russian yes only for the matching delivered active quote", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quotedAt = TEST_NOW.toISOString();
    lead.pendingSchedulingConsentQuotedAt = TEST_NOW.toISOString();
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар", preferredDate: "2026-08-29" };
    await repository.saveLead(lead);
    const agent: AgentGateway = { async createConversation() { throw new Error("quote consent is backend-owned"); }, async runTurn() { throw new Error("quote consent is backend-owned"); } };
    const deps = { repository, telegram, calendar, agent, calendarReservation: testCalendarReservation(repository, calendar), now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(15185, "Да."), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(calendar.creates).toHaveLength(0);
    expect(repository.getLead(1001)?.pendingSchedulingConsentQuotedAt).toBeUndefined();
    expect(telegram.messages.at(-1)?.text).toContain("Ближайшее свободное время");
  });

  it("asks for date and time after bare quote consent when the quote has no preferred date", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quotedAt = TEST_NOW.toISOString();
    lead.pendingSchedulingConsentQuotedAt = TEST_NOW.toISOString();
    lead.quote = { amountRsd: 4000, baseRsd: 4000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 50, rooms: 2, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар" };
    await repository.saveLead(lead);
    const agent: AgentGateway = { async createConversation() { throw new Error("quote consent is backend-owned"); }, async runTurn() { throw new Error("quote consent is backend-owned"); } };
    const deps = { repository, telegram, calendar, agent, calendarReservation: testCalendarReservation(repository, calendar), now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(15186, "да"), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(0);
    expect(calendar.creates).toHaveLength(0);
    expect(repository.getLead(1001)?.pendingSchedulingConsentQuotedAt).toBeUndefined();
    expect(telegram.messages.at(-1)?.text).toContain("На какой день и какое время");
  });

  it("does not fast-path an unbound bare yes and clears the stale consent marker", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quotedAt = TEST_NOW.toISOString();
    lead.pendingSchedulingConsentQuotedAt = "2026-08-24T09:59:59.000Z";
    lead.quote = { amountRsd: 4000, baseRsd: 4000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 50, rooms: 2, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар", preferredDate: "2026-08-29" };
    await repository.saveLead(lead);
    let turns = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: "stale-consent" }; },
      async runTurn() { turns += 1; return { reply: "Уточню, что вам удобнее.", toolResults: [], steps: 1 }; },
    };
    const deps = { repository, telegram, calendar, agent, calendarReservation: testCalendarReservation(repository, calendar), now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(15187, "да"), deps)).resolves.toEqual({ kind: "processed" });

    expect(turns).toBe(1);
    expect(calendar.availabilityQueries).toHaveLength(0);
    expect(repository.getLead(1001)?.pendingSchedulingConsentQuotedAt).toBeUndefined();
  });

  it("records a no-calendar decision for later without an offer and queries a standalone time window", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар", preferredDate: "2026-08-29" };
    await repository.saveLead(lead);
    let turns = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: "window-no-offer" }; },
      async runTurn(input) {
        turns += 1;
        if (input.message === "позже") {
          const output = await input.executeTool("record_scheduling_decision", { reason: "awaiting_customer_choice" });
          return { reply: "Сначала выберем один из уже предложенных вариантов.", toolResults: [{ name: "record_scheduling_decision", output }], steps: 1 };
        }
        const output = await input.executeTool("request_available_slots", { intent: { dateReference: "current_preferred_date", timePreference: "evening", timePreferenceMode: "explicit", relation: "fresh" } });
        return { reply: "Проверяю вечерние варианты.", toolResults: [{ name: "request_available_slots", output }], steps: 1 };
      },
    };
    const deps = { repository, telegram, calendar, agent, calendarReservation: testCalendarReservation(repository, calendar), now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(15188, "позже"), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(0);
    expect(turns).toBe(1);

    await expect(processTelegramWebhook(update(15189, "вечером"), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(turns).toBe(2);
  });

  it("uses the same safe failure path when a typed pending-date yes cannot query Calendar", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const calendarReservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар" };
    await repository.saveLead(lead);
    const agent: AgentGateway = { async createConversation() { throw new Error("typed date acceptance is backend-owned"); }, async runTurn() { throw new Error("typed date acceptance is backend-owned"); } };
    const deps = { repository, telegram, calendar, agent, calendarReservation, now: () => TEST_NOW };

    await processTelegramWebhook(update(15181, "хочу уборку на выходных"), deps);
    calendar.getBusyIntervals = async () => { throw new Error("simulated Calendar failure"); };
    await expect(processTelegramWebhook(update(15182, "да"), deps)).resolves.toEqual({ kind: "processed" });

    expect(repository.getLead(1001)).toMatchObject({
      pendingPreferredDate: undefined,
      clientData: { preferredDate: "2026-08-29" },
      humanNeeded: true,
      humanNeededReason: "calendar_unavailable",
    });
    expect(repository.activities).toContainEqual(expect.objectContaining({ eventType: "calendar_availability_failed", payload: { error_code: "calendar_availability_failed" } }));
    expect(telegram.messages.at(-1)?.text).toContain("не получилось безопасно проверить свободное время");
    expect(calendar.creates).toHaveLength(0);
  });

  it("keeps a typed pending-date no-slots result queryable without Human Needed", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const calendarReservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар" };
    await repository.saveLead(lead);
    const agent: AgentGateway = { async createConversation() { throw new Error("typed date acceptance is backend-owned"); }, async runTurn() { throw new Error("typed date acceptance is backend-owned"); } };
    const deps = { repository, telegram, calendar, agent, calendarReservation, now: () => TEST_NOW };

    await processTelegramWebhook(update(15183, "хочу уборку на выходных"), deps);
    const busy = [{ start: "2026-08-29T00:00:00.000Z", end: "2026-09-12T00:00:00.000Z" }];
    calendar.busyByTeam = { team_a: busy, team_b: busy };
    await expect(processTelegramWebhook(update(15184, "да"), deps)).resolves.toEqual({ kind: "processed" });

    expect(repository.getLead(1001)).toMatchObject({ clientData: { preferredDate: "2026-08-29" }, humanNeeded: false });
    expect(repository.activities).toContainEqual(expect.objectContaining({ eventType: "calendar_no_availability" }));
    expect(calendar.creates).toHaveLength(0);
  });

  it("keeps a prior callback selectable when a retained replacement Calendar read fails", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const calendarReservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "ru", agentConfigVersion: 5 });
    lead.status = "qualified"; lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар", preferredDate: "2026-08-29" };
    await repository.saveLead(lead);
    const firstOffer = await calendarReservation.offerSlots(lead, "ru");
    if (!firstOffer.ok) throw new Error(firstOffer.error);
    const originalGetBusyIntervals = calendar.getBusyIntervals.bind(calendar);
    calendar.getBusyIntervals = async () => { throw new Error("simulated Calendar failure"); };
    const agent = schedulingAgent({ dateReference: "same_day_as_last_offer", timePreference: "evening" });
    const deps = { repository, telegram, calendar, agent, calendarReservation, now: () => TEST_NOW };
    await expect(processTelegramWebhook(update(1519, "вечером"), deps)).resolves.toEqual({ kind: "processed" });
    expect(telegram.messages.at(-1)?.text).toContain("Ранее предложенные варианты всё ещё доступны");
    expect(telegram.messages.at(-1)?.text).not.toMatch(/команд|свяж/u);
    expect(repository.getLead(1001)).toMatchObject({ humanNeeded: false, quoteValidity: "active" });
    expect(await repository.getCalendarSlotToken({ leadId: lead.id, token: firstOffer.slots[0]!.token })).not.toHaveProperty("supersededAt");
    calendar.getBusyIntervals = originalGetBusyIntervals;
    await expect(processTelegramWebhook(callback(1520, "stale-calendar-failure", `slot:ru:${firstOffer.slots[0]!.token}`), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.creates).toHaveLength(1);
  });

  it("retires an explicitly rejected callback when its replacement Calendar read fails", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const calendarReservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified"; lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-29" };
    await repository.saveLead(lead);
    const firstOffer = await calendarReservation.offerSlots(lead, "en");
    if (!firstOffer.ok) throw new Error(firstOffer.error);
    const originalGetBusyIntervals = calendar.getBusyIntervals.bind(calendar);
    calendar.getBusyIntervals = async () => { throw new Error("simulated Calendar failure"); };
    const agent: AgentGateway = {
      async createConversation() { return { id: "reject-old-offer" }; },
      async runTurn(input) {
        const output = await input.executeTool("request_available_slots", { intent: {
          dateReference: "same_day_as_last_offer", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "reject_now",
        } });
        return { reply: "I checked the calendar.", toolResults: [{ name: "request_available_slots", output }], steps: 1 };
      },
    };
    const deps = { repository, telegram, calendar, agent, calendarReservation, now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(1521, "None of those, please find a later one."), deps)).resolves.toEqual({ kind: "processed" });
    expect(repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "calendar_unavailable" });
    expect(await repository.getCalendarSlotToken({ leadId: lead.id, token: firstOffer.slots[0]!.token })).toMatchObject({ supersededAt: expect.any(String) });
    calendar.getBusyIntervals = originalGetBusyIntervals;
    await expect(processTelegramWebhook(callback(1522, "rejected-calendar-failure", `slot:en:${firstOffer.slots[0]!.token}`), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.creates).toHaveLength(0);
  });

  it("does not persist a synthetic standard urgency for a future preferred date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    try {
      const repository = new InMemoryLeadRepository();
      const telegram = new FakeTelegramGateway();
      const agent: AgentGateway = {
        async createConversation() { return { id: "urgency-future" }; },
        async runTurn(input) {
          await input.executeTool("update_client_data", {
            patch: {
              cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 2,
              heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-24", urgency: null,
            },
          });
          await input.executeTool("calculate_quote", {});
          return { reply: "Quote ready.", toolResults: [], steps: 2 };
        },
      };

      await expect(processTelegramWebhook(update(1200, "Full cleaning fixture"), { repository, telegram, agent }))
        .resolves.toEqual({ kind: "processed" });

      expect(repository.getLead(1001)).toMatchObject({
        status: "qualified",
        clientData: { preferredDate: "2026-08-24" },
        quote: { amountRsd: 6500, sameDayApplied: false },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives same-day urgency and overwrites it when the preferred date changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T10:00:00.000Z"));
    try {
      const repository = new InMemoryLeadRepository();
      const telegram = new FakeTelegramGateway();
      const calendar = new FakeCalendarGateway();
      const calendarReservation = new CalendarReservationService(repository, calendar);
      const agent: AgentGateway = {
        async createConversation() { return { id: "urgency-change" }; },
        async runTurn(input) {
          if (input.schedulingDecisionRequired) {
            const output = await input.executeTool("request_available_slots", {
              intent: { dateReference: "tomorrow", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" },
            });
            return { reply: "I will check tomorrow's real availability.", toolResults: [{ name: "request_available_slots", output }], steps: 1 };
          }
          const preferredDate = input.message === "Move it to tomorrow" ? "2026-08-24" : "2026-08-23";
          await input.executeTool("update_client_data", { patch: {
            cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 2,
            heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate,
          } });
          await input.executeTool("calculate_quote", {});
          return { reply: "Quote ready.", toolResults: [], steps: 2 };
        },
      };

      await processTelegramWebhook(update(1201, "Book today"), { repository, telegram, calendarReservation, agent });
      expect(repository.getLead(1001)).toMatchObject({
        clientData: { preferredDate: "2026-08-23", urgency: "same_day" },
        quote: { amountRsd: 7800, sameDayApplied: true },
      });

      await processTelegramWebhook(update(1202, "Move it to tomorrow"), { repository, telegram, calendarReservation, agent });
      expect(repository.getLead(1001)).toMatchObject({
        status: "qualified",
        clientData: { preferredDate: "2026-08-24" },
        quote: { amountRsd: 6500, sameDayApplied: false },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the Europe/Belgrade calendar date at midnight when deriving urgency", async () => {
    vi.useFakeTimers();
    try {
      const repository = new InMemoryLeadRepository();
      const telegram = new FakeTelegramGateway();
      const agent: AgentGateway = {
        async createConversation() { return { id: "urgency-midnight" }; },
        async runTurn(input) {
          await input.executeTool("update_client_data", { patch: {
            cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 2,
            heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-23",
          } });
          await input.executeTool("calculate_quote", {});
          return { reply: "Quote ready.", toolResults: [], steps: 2 };
        },
      };

      vi.setSystemTime(new Date("2026-08-22T21:59:59.000Z"));
      await processTelegramWebhook(update(1203, "Before midnight"), { repository, telegram, agent });
      expect(repository.getLead(1001)?.clientData.urgency).toBeUndefined();

      vi.setSystemTime(new Date("2026-08-22T22:00:00.000Z"));
      await processTelegramWebhook(update(1204, "After midnight"), { repository, telegram, agent });
      expect(repository.getLead(1001)?.clientData.urgency).toBe("same_day");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves reply language independently for EN to RU to EN on one lead", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const replyLanguages: string[] = [];
    const agent: AgentGateway = {
      async createConversation() { return { id: "per-message-language" }; },
      async runTurn(input) {
        replyLanguages.push(input.replyLanguage);
        return { reply: input.replyLanguage === "ru" ? "Здравствуйте" : "Hello", toolResults: [], steps: 0 };
      },
    };

    await processTelegramWebhook(update(22, "Hello"), { repository, telegram, agent });
    await processTelegramWebhook(update(23, "Нужна уборка"), { repository, telegram, agent });
    await processTelegramWebhook(update(24, "Thanks"), { repository, telegram, agent });

    expect(replyLanguages).toEqual(["en", "ru", "en"]);
    expect(repository.getLead(1001)?.firstMessageLanguage).toBe("en");
  });

  it("resolves RU to Serbian Cyrillic to English without a prior-turn fallback", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const replyLanguages: string[] = [];
    const agent: AgentGateway = {
      async createConversation() { return { id: "ru-serbian-english" }; },
      async runTurn(input) {
        replyLanguages.push(input.replyLanguage);
        return { reply: "ok", toolResults: [], steps: 0 };
      },
    };

    await processTelegramWebhook(update(25, "Нужна уборка"), { repository, telegram, agent });
    await processTelegramWebhook(update(26, "Треба ми чишћење стана"), { repository, telegram, agent });
    await processTelegramWebhook(update(27, "Thanks"), { repository, telegram, agent });
    expect(replyLanguages).toEqual(["ru", "sr-Cyrl", "en"]);
  });

  it("keeps the current lead language for short Russian and Serbian follow-ups", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const replyLanguages: string[] = [];
    const agent: AgentGateway = {
      async createConversation() { return { id: "durable-locale" }; },
      async runTurn(input) { replyLanguages.push(input.replyLanguage); return { reply: "Noted", toolResults: [], steps: 0 }; },
    };

    await processTelegramWebhook(update(271, "Нужна уборка"), { repository, telegram, agent });
    await processTelegramWebhook(update(272, "а вечером?"), { repository, telegram, agent });
    await processTelegramWebhook(update(273, "ок"), { repository, telegram, agent });
    await processTelegramWebhook(update(274, "26.08.26"), { repository, telegram, agent });
    await processTelegramWebhook(update(275, "Треба ми чишћење стана", 2002), { repository, telegram, agent });
    await processTelegramWebhook(update(276, "да", 2002), { repository, telegram, agent });

    expect(replyLanguages).toEqual(["ru", "ru", "ru", "ru", "sr-Cyrl", "sr-Cyrl"]);
  });

  it("captures one deterministic clock for a whole relative-date turn", async () => {
    const deps = dependencies();
    const clock = vi.fn(() => new Date("2026-08-24T21:30:00.000Z"));
    await expect(processTelegramWebhook(update(277, "через 2 дня"), { ...deps, now: clock })).resolves.toEqual({ kind: "processed" });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(deps.repository.getLead(1001)?.clientData.preferredDate).toBe("2026-08-26");
  });

  it("falls back to one related question when an incomplete agent reply is only stock acknowledgement", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const agent: AgentGateway = {
      async createConversation() { return { id: "missing-fields" }; },
      async runTurn(input) {
        await input.executeTool("update_client_data", { patch: { cleaningType: "standard", areaM2: 75 } });
        return { reply: "Thanks, I've noted that. Could you share a little more detail?", toolResults: [], steps: 1 };
      },
    };
    await processTelegramWebhook(update(278, "standard cleaning, 75 m2"), { repository, telegram, agent });
    const reply = telegram.messages.at(-1)?.text ?? "";
    expect(reply).toBe("How many rooms and bathrooms are there?");
    expect(reply).not.toContain("heavy pet hair");
    expect(reply).not.toContain("extra services");
    expect(reply).not.toContain("Could you share a little more detail");
  });

  it.each([
    ["service and area are both unknown", ["cleaningType", "areaM2"], "Какой тип уборки нужен и какая примерно площадь?"],
    ["only service is unknown", ["cleaningType"], "Какой тип уборки нужен?"],
    ["only area is unknown", ["areaM2"], "Какая примерно площадь квартиры?"],
    ["rooms and bathrooms are both unknown", ["rooms", "bathrooms"], "Сколько комнат и санузлов в квартире?"],
    ["only bathrooms are unknown after S1 room detail", ["bathrooms"], "Сколько санузлов в квартире?"],
    ["pet hair and extras are both unknown", ["heavyPetHair", "extras"], "Есть ли сильная шерсть животных или нужны дополнительные услуги?"],
    ["only extras are unknown", ["extras"], "Нужны дополнительные услуги?"],
    ["only location is unknown", ["addressOrDistrict"], "В каком районе квартира?"],
  ] as const)("asks only the next missing field or related pair when %s", async (_caseName, omitted, expectedReply) => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const runTurn = vi.fn(async (input: Parameters<AgentGateway["runTurn"]>[0]) => {
      const patch: Record<string, unknown> = {
        cleaningType: "standard", areaM2: 75, rooms: 2, bathrooms: 1,
        heavyPetHair: false, extras: [], addressOrDistrict: "Врачар",
      };
      for (const field of omitted) delete patch[field];
      await input.executeTool("update_client_data", { patch });
      return { reply: "Спасибо, я это отметил.", toolResults: [], steps: 1 };
    });
    const agent: AgentGateway = { async createConversation() { return { id: `next-missing-${_caseName}` }; }, runTurn };
    await processTelegramWebhook(update(2_000, "Нужна уборка"), { repository, telegram, agent, now: () => TEST_NOW });
    expect(telegram.messages.at(-1)?.text).toBe(expectedReply);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps a focused model reply but replaces the original multi-topic intake dump without a second model call", async () => {
    const acceptedRepository = new InMemoryLeadRepository();
    const acceptedTelegram = new FakeTelegramGateway();
    const acceptedRunTurn = vi.fn(async () => ({
      reply: "Какая примерно площадь и какой тип уборки вам нужен?",
      toolResults: [],
      steps: 0,
    }));
    const acceptedAgent: AgentGateway = {
      async createConversation() { return { id: "focused-reply-2" }; },
      runTurn: acceptedRunTurn,
    };
    await processTelegramWebhook(update(279, "Хочу уборку"), { repository: acceptedRepository, telegram: acceptedTelegram, agent: acceptedAgent, now: () => TEST_NOW });
    expect(acceptedTelegram.messages.at(-1)?.text).toBe("Какая примерно площадь и какой тип уборки вам нужен?");
    expect(acceptedRunTurn).toHaveBeenCalledTimes(1);

    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const runTurn = vi.fn(async (input: Parameters<AgentGateway["runTurn"]>[0]) => {
      await input.executeTool("update_client_data", { patch: { cleaningType: "standard", areaM2: 75 } });
      return {
        reply: "Мне нужны тип уборки, площадь, комнаты, санузлы, шерсть животных, дополнительные услуги, район и дата.",
        toolResults: [],
        steps: 1,
      };
    });
    const agent: AgentGateway = {
      async createConversation() { return { id: "smoke-reply-5-dump" }; },
      runTurn,
    };
    await processTelegramWebhook(update(280, "стандартная уборка 75 м²"), { repository, telegram, agent, now: () => TEST_NOW });
    expect(telegram.messages.at(-1)?.text).toBe("Сколько комнат и санузлов в квартире?");
    expect(telegram.messages.at(-1)?.text).not.toContain("Мне нужны тип уборки");
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("replaces the mixed service-and-layout smoke reply with only the next S1 field", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const runTurn = vi.fn(async (input: Parameters<AgentGateway["runTurn"]>[0]) => {
      await input.executeTool("update_client_data", { patch: { areaM2: 50, addressOrDistrict: "Врачар" } });
      return {
        reply: "Для расчёта уточните, нужна стандартная или генеральная уборка, и сколько комнат с санузлами в квартире?",
        toolResults: [],
        steps: 1,
      };
    });
    const agent: AgentGateway = { async createConversation() { return { id: "s1-partial-service-only" }; }, runTurn };
    await processTelegramWebhook(update(281, "Нужна уборка квартиры 50 м² в Врачаре"), { repository, telegram, agent, now: () => TEST_NOW });
    expect(telegram.messages.at(-1)?.text).toBe("Какой тип уборки нужен?");
    expect(telegram.messages.at(-1)?.text).not.toContain("комнат");
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps a quote from becoming Qualified when Telegram delivery fails", async () => {
    const deps = dependencies();
    deps.telegram.shouldFail = true;

    await expect(processTelegramWebhook(
      update(3, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    )).resolves.toEqual({ kind: "failed", failureCode: "telegram_delivery_failed" });
    expect(deps.repository.getLead(1001)).toMatchObject({ status: "new_lead" });
    expect(deps.repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "delivery_failed" });
    expect(deps.repository.getLead(1001)?.pendingSchedulingConsentQuotedAt).toBeUndefined();
    expect(deps.repository.updates.get(3)).toMatchObject({ status: "failed" });
  });

  it("reclaims a failed Telegram update and retries a known failed delivery", async () => {
    const deps = dependencies();
    const payload = update(6, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24");
    deps.telegram.shouldFail = true;

    await expect(processTelegramWebhook(payload, deps)).resolves.toEqual({ kind: "failed", failureCode: "telegram_delivery_failed" });
    deps.telegram.shouldFail = false;

    await expect(processTelegramWebhook(payload, deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.repository.updates.get(6)).toMatchObject({ status: "processed" });
    expect(deps.telegram.messages).toHaveLength(1);
  });

  it("returns in-progress for a concurrent message in the same chat and processes it after the lease releases", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    let startFirstTurn: (() => void) | undefined;
    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnStarted = new Promise<void>((resolve) => { startFirstTurn = resolve; });
    const firstTurnRelease = new Promise<void>((resolve) => { releaseFirstTurn = resolve; });
    const agent: AgentGateway = {
      async createConversation() {
        return { id: "serialized-conversation" };
      },
      async runTurn(input) {
        if (input.message === "first message") {
          startFirstTurn?.();
          await firstTurnRelease;
        }
        return { reply: `Reply to ${input.message}`, toolResults: [], steps: 0 };
      },
    };
    const deps = { repository, telegram, agent };

    const first = processTelegramWebhook(update(40, "first message"), deps);
    await firstTurnStarted;
    await expect(processTelegramWebhook(update(41, "second message"), deps))
      .resolves.toEqual({ kind: "failed", failureCode: "processing_in_progress" });

    releaseFirstTurn?.();
    await expect(first).resolves.toEqual({ kind: "processed" });
    await expect(processTelegramWebhook(update(41, "second message"), deps)).resolves.toEqual({ kind: "processed" });
    expect(telegram.messages).toHaveLength(2);
    expect(telegram.messages.map((message) => message.text)).toEqual(["Reply to first message", "Reply to second message"]);
  });

  it("does not erase pet hair or extras on later messages, and does not apply a same-day uplift once the full job cannot fit", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(30, "deep cleaning, 120 m2, same day 2026-08-24, heavy pet hair, windows and oven"),
      deps,
    );
    await processTelegramWebhook(update(31, "3 rooms, 2 bathrooms, district: Zemun"), deps);

    expect(deps.repository.getLead(1001)).toMatchObject({
      status: "qualified",
      clientData: {
        heavyPetHair: true,
        extras: ["windows", "oven_inside"],
      },
    });
  });

  it("accepts null placeholders required by strict OpenAI tool schemas without erasing known data", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const agent: AgentGateway = {
      async createConversation() {
        return { id: "strict-schema-conversation" };
      },
      async runTurn(input) {
        const output = await input.executeTool("update_client_data", {
          patch: {
            cleaningType: "standard",
            areaM2: 75,
            rooms: null,
            bathrooms: null,
            heavyPetHair: null,
            extras: null,
            addressOrDistrict: null,
            preferredDate: null,
            urgency: null,
          },
        });
        expect(output).toMatchObject({ ok: true, client_data: { cleaningType: "standard", areaM2: 75 } });
        return { reply: "Please share the remaining details.", toolResults: [], steps: 1 };
      },
    };

    await expect(processTelegramWebhook(update(32, "standard cleaning, 75 m2"), { repository, telegram, agent }))
      .resolves.toEqual({ kind: "processed" });
    expect(repository.getLead(1001)?.clientData).toEqual({ cleaningType: "standard", areaM2: 75 });
  });

  it("routes out-of-scope work to Human Needed without a quote", async () => {
    const deps = dependencies();
    await processTelegramWebhook(update(4, "после ремонта, 100 m2, 3 комнат, 1 санузел, 2026-08-24"), deps);

    expect(deps.repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "after_renovation" });
    expect(deps.repository.getLead(1001)?.quote).toBeUndefined();
    expect(deps.telegram.messages[0]?.text).toContain("передам заявку специалисту");
  });

  it("keeps Qualified and records a superseded quote when a later request needs a human", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(50, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );

    await expect(processTelegramWebhook(update(51, "commercial renovation cleaning"), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.repository.getLead(1001)).toMatchObject({
      status: "qualified",
      humanNeeded: true,
      quote: { amountRsd: 9600 },
      quoteValidity: "superseded",
    });
  });

  it("keeps an active quote when only non-pricing client data changes", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const now = () => new Date("2026-08-24T10:00:00.000Z");
    const initialAgent = new FakeAgentGateway();
    await processTelegramWebhook(
      update(60, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      { repository, telegram, agent: initialAgent, now },
    );
    const agent: AgentGateway = {
      async createConversation() {
        throw new Error("existing conversation must be reused");
      },
      async runTurn(input) {
        await input.executeTool("update_client_data", { patch: { rooms: 4 } });
        return { reply: "Updated the room count.", toolResults: [], steps: 1 };
      },
    };

    await expect(processTelegramWebhook(update(61, "Actually it is 4 rooms"), { repository, telegram, agent, now }))
      .resolves.toEqual({ kind: "processed" });
    expect(repository.getLead(1001)).toMatchObject({
      status: "qualified",
      quote: { amountRsd: 9600 },
      quoteValidity: "active",
      clientData: { rooms: 4 },
    });
  });

  it("offers numbered slots and persists one fake Calendar reservation after the customer chooses the first slot", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(80, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(81, "Please show available slots"), deps);
    expect(deps.repository.getLead(1001)).toMatchObject({ status: "qualified", quoteValidity: "active", humanNeeded: false });
    expect(deps.telegram.messages.at(-1)?.text).toMatch(/1\. Team A/);
    await expect(processTelegramWebhook(update(82, "first"), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.calendar.creates).toHaveLength(1);
    expect(deps.repository.getLead(1001)).toMatchObject({
      status: "qualified",
      calendarEventId: "fake-calendar-event-1",
      assignedTeam: "team_a",
    });
    expect(deps.telegram.messages.at(-1)?.text).toContain("confirmed");
  });

  it("renders an HTML slot offer with inline buttons and no visible token", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(801, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(802, "Please show available slots"), deps);

    const reply = deps.telegram.messages.at(-1);
    expect(reply).toMatchObject({ parseMode: "HTML" });
    expect(reply?.text).toMatch(/<b>Nearest available times<\/b>/);
    expect(reply?.text).not.toMatch(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i);
    expect(reply?.text).not.toContain("slot token");
    expect(reply?.replyMarkup).toMatchObject({ inline_keyboard: expect.any(Array) });
    const keyboard = reply?.replyMarkup;
    expect(keyboard && "inline_keyboard" in keyboard ? keyboard.inline_keyboard : []).toHaveLength(3);
  });

  it("escapes agent prose rather than rendering raw Markdown or HTML", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.clientData = {
      cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1,
      heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-09-03", urgency: "standard",
    };
    await repository.saveLead(lead);
    const agent: AgentGateway = {
      async createConversation() { return { id: "renderer-conversation" }; },
      async runTurn() { return { reply: "**Hello** <Vracar & friends> 6fbbf68d-90b2-4f09-bf56-95d9cd685aab request_available_slots", toolResults: [], steps: 0 }; },
    };

    await expect(processTelegramWebhook(update(803, "hello"), { repository, telegram, agent }))
      .resolves.toEqual({ kind: "processed" });
    expect(telegram.messages[0]).toMatchObject({
      parseMode: "HTML",
      text: "Hello &lt;Vracar &amp; friends&gt;",
    });
  });

  it("uses the authoritative quote renderer in English and Russian", async () => {
    const english = dependencies();
    await processTelegramWebhook(
      update(804, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      english,
    );
    expect(english.telegram.messages[0]?.text).toBe("<b>Your cleaning would cost: 9,600 RSD</b>\n\nIf that works for you, I can show the nearest available times.");

    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const now = () => new Date("2026-08-24T10:00:00.000Z");
    const russianAgent: AgentGateway = {
      async createConversation() { return { id: "russian-renderer-conversation" }; },
      async runTurn(input) {
        await input.executeTool("update_client_data", {
          patch: {
            cleaningType: "standard", areaM2: 100, rooms: 3, bathrooms: 1, heavyPetHair: false,
            extras: [], addressOrDistrict: "Врачар", preferredDate: "2026-08-24", urgency: "standard",
          },
        });
        await input.executeTool("calculate_quote", {});
        return { reply: "**другая сумма**", toolResults: [], steps: 2 };
      },
    };
    await processTelegramWebhook(update(805, "Нужна уборка"), { repository, telegram, agent: russianAgent, now });
    expect(telegram.messages[0]?.text).toBe("<b>Стоимость уборки: 9 600 RSD</b>\n\nЕсли всё подходит, я покажу ближайшее свободное время.");
  });

  it("uses the current message language for a quote, slot labels, and escalation", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const russianQuoteAgent: AgentGateway = {
      async createConversation() { return { id: "adaptive-renderer-conversation" }; },
      async runTurn(input) {
        await input.executeTool("update_client_data", {
          patch: {
            cleaningType: "standard", areaM2: 100, rooms: 3, bathrooms: 1, heavyPetHair: false,
            extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-24", urgency: "standard",
          },
        });
        await input.executeTool("calculate_quote", {});
        return { reply: "", toolResults: [], steps: 2 };
      },
    };
    const deps = { repository, telegram, agent: russianQuoteAgent, calendarReservation: testCalendarReservation(repository, calendar), now: () => TEST_NOW };

    await processTelegramWebhook(update(850, "Нужна уборка"), deps);
    expect(telegram.messages.at(-1)?.text).toContain("Стоимость уборки:");

    await processTelegramWebhook(update(851, "Please show available slots"), { ...deps, agent: new FakeAgentGateway() });
    expect(telegram.messages.at(-1)?.text).toContain("Nearest available times");
    expect(telegram.messages.at(-1)?.text).toContain("Team A");

    await processTelegramWebhook(update(852, "после ремонта"), { ...deps, agent: new FakeAgentGateway() });
    expect(telegram.messages.at(-1)?.text).toContain("передам заявку специалисту");
  });

  it("uses an inline callback once, acknowledges it, and never sends the callback token to the agent", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(806, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(807, "Please show available slots"), deps);
    const markup = deps.telegram.messages.at(-1)?.replyMarkup;
    const callbackData = markup && "inline_keyboard" in markup ? markup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    if (!callbackData) throw new Error("slot callback missing");
    const agentMustNotRun: AgentGateway = {
      async createConversation() { throw new Error("agent must not create a conversation for a slot callback"); },
      async runTurn() { throw new Error("agent must not run for a slot callback"); },
    };

    await expect(processTelegramWebhook(callback(808, "callback-808", callbackData), { ...deps, agent: agentMustNotRun }))
      .resolves.toEqual({ kind: "processed" });
    expect(deps.telegram.answeredCallbackQueryIds).toEqual(["callback-808"]);
    expect(deps.calendar.creates).toHaveLength(1);
    expect(deps.telegram.messages.at(-1)?.text).toContain("<b>Your time is confirmed.</b>");
    await expect(processTelegramWebhook(callback(808, "callback-808", callbackData), { ...deps, agent: agentMustNotRun }))
      .resolves.toEqual({ kind: "duplicate" });
    expect(deps.calendar.creates).toHaveLength(1);
  });

  it("uses the locale encoded by new and legacy slot callbacks", async () => {
    const russian = dependencies();
    const quoteAgent = (language: "ru" | "sr-Cyrl"): AgentGateway => ({
      async createConversation() { return { id: `${language}-callback-conversation` }; },
      async runTurn(input) {
        await input.executeTool("update_client_data", {
          patch: {
            cleaningType: "standard", areaM2: 100, rooms: 3, bathrooms: 1, heavyPetHair: false,
            extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-24", urgency: "standard",
          },
        });
        await input.executeTool("calculate_quote", {});
        return { reply: "", toolResults: [], steps: 2 };
      },
    });
    const slotsAgent: AgentGateway = {
      async createConversation() { throw new Error("existing conversation must be reused"); },
      async runTurn(input) {
        await input.executeTool("request_available_slots", { intent: { dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" } });
        return { reply: "", toolResults: [], steps: 1 };
      },
    };

    await processTelegramWebhook(update(860, "Нужна уборка"), { ...russian, agent: quoteAgent("ru") });
    await processTelegramWebhook(update(861, "покажите время"), { ...russian, agent: slotsAgent });
    const russianMarkup = russian.telegram.messages.at(-1)?.replyMarkup;
    const russianCallback = russianMarkup && "inline_keyboard" in russianMarkup ? russianMarkup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    if (!russianCallback) throw new Error("Russian callback missing");
    expect(russianCallback).toMatch(/^slot:ru:/);
    await processTelegramWebhook(callback(862, "callback-ru", russianCallback), { ...russian, agent: slotsAgent });
    expect(russian.telegram.messages.at(-1)?.text).toContain("Время подтверждено");

    const serbian = dependencies();
    await processTelegramWebhook(update(863, "Треба ми чишћење стана"), { ...serbian, agent: quoteAgent("sr-Cyrl") });
    await processTelegramWebhook(update(864, "Покажите термине"), { ...serbian, agent: slotsAgent });
    const serbianMarkup = serbian.telegram.messages.at(-1)?.replyMarkup;
    const serbianCallback = serbianMarkup && "inline_keyboard" in serbianMarkup ? serbianMarkup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    if (!serbianCallback) throw new Error("Serbian callback missing");
    expect(serbianCallback).toMatch(/^slot:sr-Cyrl:/);
    await processTelegramWebhook(callback(865, "callback-sr", serbianCallback), { ...serbian, agent: slotsAgent });
    expect(serbian.telegram.messages.at(-1)?.text).toContain("Ваш термин је потврђен");

    const legacy = russianCallback.replace(/^slot:ru:/, "slot:");
    await processTelegramWebhook(callback(866, "callback-legacy", legacy), { ...russian, agent: slotsAgent });
    expect(russian.telegram.messages.at(-1)?.text).toContain("Your time is confirmed");
  });

  it("supersedes a previous offer and fails a stale or wrong-lead callback closed", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(809, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(810, "Please show available slots"), deps);
    const firstMarkup = deps.telegram.messages.at(-1)?.replyMarkup;
    const firstCallback = firstMarkup && "inline_keyboard" in firstMarkup ? firstMarkup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    await processTelegramWebhook(update(811, "Please show available slots again"), deps);
    if (!firstCallback) throw new Error("first slot callback missing");
    await expect(processTelegramWebhook(callback(812, "callback-stale", firstCallback), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.calendar.creates).toHaveLength(0);
    expect(deps.telegram.messages.at(-1)?.text).toContain("no longer available");

    await processTelegramWebhook(
      update(813, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Zemun, 2026-08-24", 2002),
      deps,
    );
    await expect(processTelegramWebhook(callback(814, "callback-wrong-lead", firstCallback, 2002), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.calendar.creates).toHaveLength(0);
    expect(deps.telegram.answeredCallbackQueryIds).toContain("callback-wrong-lead");
  });

  it("contains an expired callback without escalating Human Needed or creating a Calendar event", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const trello = new FakeTrelloGateway();
    const deps = {
      repository,
      telegram,
      agent: new FakeAgentGateway(),
      calendarReservation: new CalendarReservationService(repository, calendar, undefined, () => TEST_NOW),
      trelloSync: new TrelloSyncService(repository, trello),
      now: () => TEST_NOW,
    };
    await processTelegramWebhook(
      update(822, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(823, "Please show available slots"), deps);
    const markup = deps.telegram.messages.at(-1)?.replyMarkup;
    const callbackData = markup && "inline_keyboard" in markup ? markup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    if (!callbackData) throw new Error("slot callback missing");
    const token = callbackData.split(":").at(-1);
    if (!token) throw new Error("slot token missing");
    const storedToken = deps.repository.slotTokens.get(token);
    if (!storedToken) throw new Error("stored slot token missing");
    storedToken.expiresAt = "2000-01-01T00:00:00.000Z";
    const trelloWritesBefore = { creates: trello.creates.length, updates: trello.updates.length, labels: trello.labelUpdates.length };

    await expect(processTelegramWebhook(callback(824, "callback-expired", callbackData), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.creates).toHaveLength(0);
    expect({ creates: trello.creates.length, updates: trello.updates.length, labels: trello.labelUpdates.length }).toEqual(trelloWritesBefore);
    expect(deps.repository.getLead(1001)).toMatchObject({ status: "qualified", humanNeeded: false });
    expect(deps.repository.updates.get(824)).toMatchObject({ status: "processed" });
    expect(deps.telegram.messages.at(-1)?.text).toContain("no longer available");
  });

  it("acknowledges each repeated stale callback but sends one idempotent stale reply", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(825, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(826, "Please show available slots"), deps);
    const markup = deps.telegram.messages.at(-1)?.replyMarkup;
    const callbackData = markup && "inline_keyboard" in markup ? markup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    if (!callbackData) throw new Error("slot callback missing");
    const token = callbackData.split(":").at(-1);
    if (!token) throw new Error("slot token missing");
    const storedToken = deps.repository.slotTokens.get(token);
    if (!storedToken) throw new Error("stored slot token missing");
    storedToken.expiresAt = "2000-01-01T00:00:00.000Z";

    await expect(processTelegramWebhook(callback(827, "callback-expired-a", callbackData), deps)).resolves.toEqual({ kind: "processed" });
    await expect(processTelegramWebhook(callback(828, "callback-expired-b", callbackData), deps)).resolves.toEqual({ kind: "processed" });

    expect(deps.telegram.answeredCallbackQueryIds).toEqual(["callback-expired-a", "callback-expired-b"]);
    expect(deps.telegram.messages.filter((message) => message.text.includes("no longer available"))).toHaveLength(1);
    expect(deps.repository.operations.get(`telegram:slot_stale:${deps.repository.getLead(1001)?.id}:${token}`)?.status).toBe("succeeded");
    expect(deps.repository.updates.get(827)).toMatchObject({ status: "processed" });
    expect(deps.repository.updates.get(828)).toMatchObject({ status: "processed" });
  });

  it.each(["done", "lost"] as const)("contains an old slot callback after the lead is locally marked %s", async (status) => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const trello = new FakeTrelloGateway();
    const deps = {
      repository,
      telegram,
      agent: new FakeAgentGateway(),
      calendarReservation: testCalendarReservation(repository, calendar),
      trelloSync: new TrelloSyncService(repository, trello),
      now: () => TEST_NOW,
    };
    await processTelegramWebhook(
      update(1210, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(1211, "Please show available slots"), deps);
    const markup = telegram.messages.at(-1)?.replyMarkup;
    const callbackData = markup && "inline_keyboard" in markup ? markup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    if (!callbackData) throw new Error("slot callback missing");
    const lead = repository.getLead(1001);
    if (!lead) throw new Error("lead missing");
    lead.status = status;
    lead.humanNeeded = true;
    lead.humanNeededReason = "trello_terminal";
    await repository.saveLead(lead);
    const trelloWritesBefore = { creates: trello.creates.length, updates: trello.updates.length, labels: trello.labelUpdates.length };

    await expect(processTelegramWebhook(callback(1212, `callback-${status}-a`, callbackData), deps)).resolves.toEqual({ kind: "processed" });
    await expect(processTelegramWebhook(callback(1213, `callback-${status}-b`, callbackData), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.creates).toHaveLength(0);
    expect({ creates: trello.creates.length, updates: trello.updates.length, labels: trello.labelUpdates.length }).toEqual(trelloWritesBefore);
    expect(repository.getLead(1001)).toMatchObject({ status, humanNeeded: true, humanNeededReason: "trello_terminal" });
    expect(telegram.messages.filter((message) => message.text.includes("no longer available"))).toHaveLength(1);
  });

  it("contains repeated callbacks for terminal Human Needed and a qualified lead that is no longer booking-eligible", async () => {
    for (const [chatId, reason] of [[1001, "after_renovation"], [2002, "calendar_unavailable"]] as const) {
      const repository = new InMemoryLeadRepository();
      const telegram = new FakeTelegramGateway();
      const calendar = new FakeCalendarGateway();
      const trello = new FakeTrelloGateway();
      const deps = {
        repository,
        telegram,
        agent: new FakeAgentGateway(),
        calendarReservation: new CalendarReservationService(repository, calendar, undefined, () => TEST_NOW),
        trelloSync: new TrelloSyncService(repository, trello),
        now: () => TEST_NOW,
      };
      await processTelegramWebhook(
        update(chatId + 300, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24", chatId),
        deps,
      );
      await processTelegramWebhook(update(chatId + 301, "Please show available slots", chatId), deps);
      const markup = telegram.messages.at(-1)?.replyMarkup;
      const callbackData = markup && "inline_keyboard" in markup ? markup.inline_keyboard[0]?.[0]?.callback_data : undefined;
      if (!callbackData) throw new Error("slot callback missing");
      const lead = repository.getLead(chatId);
      if (!lead) throw new Error("lead missing");
      lead.humanNeeded = true;
      lead.humanNeededReason = reason;
      await repository.saveLead(lead);
      const trelloWritesBefore = { creates: trello.creates.length, updates: trello.updates.length, labels: trello.labelUpdates.length };

      await expect(processTelegramWebhook(callback(chatId + 302, `callback-${reason}-a`, callbackData, chatId), deps)).resolves.toEqual({ kind: "processed" });
      await expect(processTelegramWebhook(callback(chatId + 303, `callback-${reason}-b`, callbackData, chatId), deps)).resolves.toEqual({ kind: "processed" });

      expect(calendar.creates).toHaveLength(0);
      expect({ creates: trello.creates.length, updates: trello.updates.length, labels: trello.labelUpdates.length }).toEqual(trelloWritesBefore);
      expect(repository.getLead(chatId)).toMatchObject({ status: "qualified", humanNeeded: true, humanNeededReason: reason });
      expect(telegram.messages.filter((message) => message.text.includes("no longer available"))).toHaveLength(1);
    }
  });

  it("processes a stale callback when callback acknowledgement fails", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(829, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(830, "Please show available slots"), deps);
    const markup = deps.telegram.messages.at(-1)?.replyMarkup;
    const callbackData = markup && "inline_keyboard" in markup ? markup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    if (!callbackData) throw new Error("slot callback missing");
    const token = callbackData.split(":").at(-1);
    if (!token) throw new Error("slot token missing");
    const storedToken = deps.repository.slotTokens.get(token);
    if (!storedToken) throw new Error("stored slot token missing");
    storedToken.expiresAt = "2000-01-01T00:00:00.000Z";
    deps.telegram.shouldFailCallbackAnswer = true;

    await expect(processTelegramWebhook(callback(831, "callback-ack-failure", callbackData), deps)).resolves.toEqual({ kind: "processed" });

    expect(deps.telegram.answeredCallbackQueryIds).toEqual([]);
    expect(deps.repository.updates.get(831)).toMatchObject({ status: "processed" });
    expect(deps.repository.activities).toContainEqual(expect.objectContaining({
      eventType: "telegram_callback_ack_failed",
      payload: { outcome: "failed" },
    }));
  });

  it("acknowledges a fresh callback after Calendar persistence and leaves final confirmation to the worker", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const trello = new FakeTrelloGateway();
    const trelloSync = new TrelloSyncService(repository, trello);
    const deps = {
      repository,
      telegram,
      agent: new FakeAgentGateway(),
      calendarReservation: testCalendarReservation(repository, calendar),
      trelloSync,
      now: () => TEST_NOW,
    };
    await processTelegramWebhook(
      update(832, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(833, "Please show available slots"), deps);
    const markup = telegram.messages.at(-1)?.replyMarkup;
    const callbackData = markup && "inline_keyboard" in markup ? markup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    if (!callbackData) throw new Error("slot callback missing");

    await expect(processTelegramWebhook(callback(834, "callback-fresh", callbackData), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.creates).toHaveLength(1);
    expect(repository.getLead(1001)).toMatchObject({ status: "qualified", calendarEventId: "fake-calendar-event-1", humanNeeded: false });
    expect(repository.trelloSyncJobs.get(repository.getLead(1001)?.id ?? "missing")).toMatchObject({ desiredLifecycle: "booked" });
    expect(trello.creates).toHaveLength(0);
    expect(telegram.messages.at(-1)?.text).toContain("<b>Your time is confirmed.</b>");
    expect(repository.updates.get(834)).toMatchObject({ status: "processed" });

    await repository.accelerateTrelloSyncJob({ leadId: repository.getLead(1001)?.id ?? "missing", now: new Date().toISOString(), replyLanguage: "en" });
    await new TrelloRecoveryService(repository, trelloSync, telegram).reconcileDueJobs(1);
    expect(repository.getLead(1001)).toMatchObject({ status: "booked", humanNeeded: false });
    expect(telegram.messages.at(-1)?.text).toContain("<b>Your cleaning is confirmed.</b>");
  });

  it("recovers an existing reservation only from its original consumed callback token", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const trello = new FakeTrelloGateway();
    const deps = {
      repository,
      telegram,
      agent: new FakeAgentGateway(),
      calendarReservation: testCalendarReservation(repository, calendar),
      trelloSync: new TrelloSyncService(repository, trello),
      now: () => TEST_NOW,
    };
    await processTelegramWebhook(
      update(835, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(836, "Please show available slots"), deps);
    const markup = telegram.messages.at(-1)?.replyMarkup;
    const originalCallback = markup && "inline_keyboard" in markup ? markup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    if (!originalCallback) throw new Error("slot callback missing");
    trello.nextCreateResult = { kind: "failed", code: "trello_create_failed", ambiguous: false };

    await expect(processTelegramWebhook(callback(837, "callback-first-reservation", originalCallback), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.creates).toHaveLength(1);
    expect(repository.getLead(1001)).toMatchObject({ status: "qualified", calendarEventId: "fake-calendar-event-1" });

    trello.nextCreateResult = undefined;
    const trelloWritesBeforeTypedRetry = { creates: trello.creates.length, updates: trello.updates.length, labels: trello.labelUpdates.length };
    await expect(processTelegramWebhook(update(838, "1"), deps)).resolves.toEqual({ kind: "processed" });
    expect(repository.getLead(1001)).toMatchObject({ status: "qualified", calendarEventId: "fake-calendar-event-1" });
    expect({ creates: trello.creates.length, updates: trello.updates.length, labels: trello.labelUpdates.length }).toEqual(trelloWritesBeforeTypedRetry);

    await expect(processTelegramWebhook(callback(839, "callback-recover-original", originalCallback), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.creates).toHaveLength(1);
    expect(repository.getLead(1001)).toMatchObject({ status: "qualified", calendarEventId: "fake-calendar-event-1" });
    expect(telegram.messages.at(-1)?.text).toContain("<b>Your time is confirmed.</b>");
  });

  it("recovers the original callback after Calendar create succeeds but atomic reservation persistence fails once", async () => {
    const repository = new InMemoryLeadRepository();
    // Supabase returns a fresh record, unlike the in-memory helper's normal
    // reference. This makes the injected persistence failure represent the
    // real boundary: the Calendar operation is complete but no lead fields
    // or outbox job have yet been committed.
    const findLeadByTelegramChatId = repository.findLeadByTelegramChatId.bind(repository);
    repository.findLeadByTelegramChatId = async (telegramChatId) => {
      const lead = await findLeadByTelegramChatId(telegramChatId);
      return lead ? structuredClone(lead) : null;
    };
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const trello = new FakeTrelloGateway();
    const deps = {
      repository,
      telegram,
      agent: new FakeAgentGateway(),
      calendarReservation: testCalendarReservation(repository, calendar),
      trelloSync: new TrelloSyncService(repository, trello),
      now: () => TEST_NOW,
    };
    await processTelegramWebhook(
      update(871, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(872, "Please show available slots"), deps);
    const markup = telegram.messages.at(-1)?.replyMarkup;
    const callbackData = markup && "inline_keyboard" in markup ? markup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    if (!callbackData) throw new Error("slot callback missing");

    const persist = repository.persistCalendarReservationWithTrelloJob.bind(repository);
    let failOnce = true;
    repository.persistCalendarReservationWithTrelloJob = async (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated atomic reservation persistence failure");
      }
      await persist(input);
    };

    await expect(processTelegramWebhook(callback(873, "callback-persist-failure", callbackData), deps)).resolves.toEqual({ kind: "processed" });
    const leadAfterFailure = repository.getLead(1001);
    const token = callbackData.split(":").at(-1);
    if (!leadAfterFailure || !token) throw new Error("lead or token missing after persistence failure");
    expect(calendar.creates).toHaveLength(1);
    expect(leadAfterFailure.calendarEventId).toBeUndefined();
    expect(leadAfterFailure).toMatchObject({ humanNeeded: true, humanNeededReason: "calendar_ambiguous" });
    expect(repository.slotTokens.get(token)?.consumedAt).toBeDefined();
    expect(repository.operations.get(`google_calendar:reservation:${leadAfterFailure.id}:${token}`)).toMatchObject({
      status: "succeeded",
      externalId: "fake-calendar-event-1",
    });

    await expect(processTelegramWebhook(callback(873, "callback-persist-failure", callbackData), deps)).resolves.toEqual({ kind: "duplicate" });
    expect(calendar.creates).toHaveLength(1);
    expect(repository.getLead(1001)).toMatchObject({ status: "qualified", humanNeeded: true, humanNeededReason: "calendar_ambiguous" });
    expect(telegram.messages.at(-1)?.text).toContain("could not safely confirm");
  });

  it("contains a syntactically valid token from a different lead before any Trello or booking work", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const trello = new FakeTrelloGateway();
    const deps = {
      repository,
      telegram,
      agent: new FakeAgentGateway(),
      calendarReservation: testCalendarReservation(repository, calendar),
      trelloSync: new TrelloSyncService(repository, trello),
      now: () => TEST_NOW,
    };
    await processTelegramWebhook(
      update(839, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(840, "Please show available slots"), deps);
    const firstMarkup = telegram.messages.at(-1)?.replyMarkup;
    const firstCallback = firstMarkup && "inline_keyboard" in firstMarkup ? firstMarkup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    if (!firstCallback) throw new Error("first slot callback missing");
    await processTelegramWebhook(
      update(841, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Zemun, 2026-08-24", 2002),
      deps,
    );
    const trelloWritesBefore = { creates: trello.creates.length, updates: trello.updates.length, labels: trello.labelUpdates.length };

    await expect(processTelegramWebhook(callback(842, "callback-wrong-lead-production", firstCallback, 2002), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.creates).toHaveLength(0);
    expect({ creates: trello.creates.length, updates: trello.updates.length, labels: trello.labelUpdates.length }).toEqual(trelloWritesBefore);
    expect(repository.getLead(2002)).toMatchObject({ status: "qualified", humanNeeded: false });
    expect(repository.getLead(2002)?.calendarEventId).toBeUndefined();
    expect(telegram.messages.at(-1)?.text).toContain("no longer available");
  });

  it("does not treat another valid offer token as a booking recovery after one slot is reserved", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const trello = new FakeTrelloGateway();
    const deps = {
      repository,
      telegram,
      agent: new FakeAgentGateway(),
      calendarReservation: testCalendarReservation(repository, calendar),
      trelloSync: new TrelloSyncService(repository, trello),
      now: () => TEST_NOW,
    };
    await processTelegramWebhook(
      update(843, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(844, "Please show available slots"), deps);
    const markup = telegram.messages.at(-1)?.replyMarkup;
    const callbacks = markup && "inline_keyboard" in markup ? markup.inline_keyboard.map((row) => row[0]?.callback_data) : [];
    const originalCallback = callbacks[0];
    const otherCallback = callbacks[1];
    if (!originalCallback || !otherCallback) throw new Error("two slot callbacks are required");

    await expect(processTelegramWebhook(callback(845, "callback-book-original", originalCallback), deps)).resolves.toEqual({ kind: "processed" });
    const trelloWritesBefore = { creates: trello.creates.length, updates: trello.updates.length, labels: trello.labelUpdates.length };
    const confirmationCount = telegram.messages.filter((message) => message.text.includes("<b>Your cleaning is confirmed.</b>")).length;

    await expect(processTelegramWebhook(callback(846, "callback-other-after-booking", otherCallback), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.creates).toHaveLength(1);
    expect({ creates: trello.creates.length, updates: trello.updates.length, labels: trello.labelUpdates.length }).toEqual(trelloWritesBefore);
    expect(telegram.messages.filter((message) => message.text.includes("<b>Your cleaning is confirmed.</b>"))).toHaveLength(confirmationCount);
    expect(telegram.messages.at(-1)?.text).toContain("no longer available");
  });

  it("replaces an earlier offer with a clear no-availability reply when both teams are busy", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(818, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(819, "Please show available slots"), deps);
    const oldMarkup = deps.telegram.messages.at(-1)?.replyMarkup;
    const oldCallback = oldMarkup && "inline_keyboard" in oldMarkup ? oldMarkup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    const allHorizonBusy = [{ start: "2026-08-24T00:00:00.000Z", end: "2026-09-08T00:00:00.000Z" }];
    deps.calendar.busyByTeam = { team_a: allHorizonBusy, team_b: allHorizonBusy };

    await expect(processTelegramWebhook(update(820, "Please show available slots again"), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.telegram.messages.at(-1)?.text).toBe("There are no free slots on that requested date over the next two weeks. We can check another date.");
    expect(deps.repository.getLead(1001)).toMatchObject({
      status: "qualified",
      quoteValidity: "active",
      humanNeeded: false,
      humanNeededReason: undefined,
    });
    expect(deps.repository.activities).toContainEqual(expect.objectContaining({ eventType: "calendar_no_availability" }));
    await expect(deps.repository.listActiveCalendarSlotTokens({ leadId: deps.repository.getLead(1001)?.id ?? "missing", now: new Date().toISOString() })).resolves.toEqual([]);
    if (!oldCallback) throw new Error("first slot callback missing");
    await expect(processTelegramWebhook(callback(821, "callback-no-availability", oldCallback), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.calendar.creates).toHaveLength(0);
  });

  it("keeps an English named date queryable when the Calendar horizon is full", async () => {
    const base = dependencies();
    const seenTools: string[][] = [];
    const agent: AgentGateway = {
      async createConversation() { return { id: "english-calendar-failure" }; },
      async runTurn(input: import("@/lib/agent/gateway").AgentTurnInput) {
        seenTools.push([...(input.allowedTools ?? [])]);
        if (seenTools.length === 1) {
          expect(input.knownClientData.preferredDate).toBe("2026-08-26");
          await input.executeTool("update_client_data", { patch: {
            cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1,
            heavyPetHair: false, extras: [], addressOrDistrict: "Vracar",
          } });
          await input.executeTool("calculate_quote", {});
          return { reply: "The estimate is ready.", toolResults: [], steps: 1 };
        }
        const output = await input.executeTool("request_available_slots", { intent: { dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" } });
        return { reply: "I can help.", toolResults: [{ name: "request_available_slots", output }], steps: 1 };
      },
    };
    const deps = { ...base, agent };
    const fullyBooked = [{ start: "2026-08-24T06:00:00.000Z", end: "2026-09-10T18:00:00.000Z" }];
    deps.calendar.busyByTeam = { team_a: fullyBooked, team_b: fullyBooked };

    await processTelegramWebhook(update(8220, "Standard cleaning, 75 m2, 3 rooms, one bathroom, no pet hair or extras, Vracar, August 26."), deps);
    expect(deps.repository.getLead(1001)).toMatchObject({ clientData: { preferredDate: "2026-08-26" }, quoteValidity: "active" });
    expect(deps.telegram.messages.at(-1)?.text).not.toContain("today");
    await processTelegramWebhook(update(8221, "Please show available times."), deps);
    expect(deps.repository.getLead(1001)).toMatchObject({ humanNeeded: false, clientData: { preferredDate: "2026-08-26" } });
    expect(deps.repository.activities.filter((activity) => activity.eventType === "calendar_no_availability")).toHaveLength(1);
    await processTelegramWebhook(update(8222, "Can someone help find another date?"), deps);

    expect(seenTools).toEqual([
      ["update_client_data", "mark_human_needed", "calculate_quote"],
      ["update_client_data", "mark_human_needed", "calculate_quote", "request_available_slots", "record_scheduling_decision"],
      ["update_client_data", "mark_human_needed", "calculate_quote", "request_available_slots", "record_scheduling_decision"],
    ]);
    expect(deps.telegram.messages.at(-1)?.text).not.toMatch(/already been passed/i);
  });

  it("accepts a natural Russian typed choice and ignores a typing-indicator failure", async () => {
    const deps = dependencies();
    deps.telegram.shouldFailTyping = true;
    await processTelegramWebhook(
      update(815, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(816, "Please show available slots"), deps);
    await expect(processTelegramWebhook(update(817, "второй вариант"), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.calendar.creates).toHaveLength(1);
    expect(deps.calendar.creates[0]?.team).toBe("team_b");
    expect(deps.telegram.messages.at(-1)?.text).toContain("Время подтверждено");
  });

  it("accepts Serbian Latin and Cyrillic typed slot choices in their own scripts", async () => {
    const latin = dependencies();
    await processTelegramWebhook(
      update(830, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      latin,
    );
    await processTelegramWebhook(update(831, "Please show available slots"), latin);
    await expect(processTelegramWebhook(update(832, "drugi"), latin)).resolves.toEqual({ kind: "processed" });
    expect(latin.calendar.creates[0]?.team).toBe("team_b");
    expect(latin.telegram.messages.at(-1)?.text).toContain("Vaš termin je potvrđen");

    const cyrillic = dependencies();
    await processTelegramWebhook(
      update(833, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      cyrillic,
    );
    await processTelegramWebhook(update(834, "Please show available slots"), cyrillic);
    await expect(processTelegramWebhook(update(835, "други"), cyrillic)).resolves.toEqual({ kind: "processed" });
    expect(cyrillic.calendar.creates[0]?.team).toBe("team_b");
    expect(cyrillic.telegram.messages.at(-1)?.text).toContain("Ваш термин је потврђен");
  });

  it("keeps the active qualified quote when Calendar creation fails", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(83, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(84, "Please show available slots"), deps);
    deps.calendar.nextCreateResult = { kind: "failed", code: "calendar_conflict", ambiguous: false };
    await expect(processTelegramWebhook(update(85, "1"), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.repository.getLead(1001)).toMatchObject({
      status: "qualified",
      quoteValidity: "active",
      humanNeeded: true,
      humanNeededReason: "calendar_unavailable",
    });
  });

  it("resolves a numbered stored slot selection before invoking the agent", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(185, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(186, "Please show available slots"), deps);
    const agentMustNotRun: AgentGateway = {
      async createConversation() { throw new Error("agent must not create a conversation for a numbered choice"); },
      async runTurn() { throw new Error("agent must not run for a numbered choice"); },
    };

    await expect(processTelegramWebhook(update(187, "1"), { ...deps, agent: agentMustNotRun })).resolves.toEqual({ kind: "processed" });
    expect(deps.calendar.creates).toHaveLength(1);
    expect(deps.repository.getLead(1001)).toMatchObject({ calendarEventId: "fake-calendar-event-1", status: "qualified" });
  });

  it("passes a bare number to the agent when there is no active slot offer", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const receivedMessages: string[] = [];
    const agent: AgentGateway = {
      async createConversation() { return { id: "intake-number-conversation" }; },
      async runTurn(input) {
        receivedMessages.push(input.message);
        if (input.message === "1") {
          await input.executeTool("update_client_data", { patch: { bathrooms: 1 } });
          return { reply: "Thanks, noted.", toolResults: [], steps: 1 };
        }
        await input.executeTool("update_client_data", {
          patch: { cleaningType: "standard", areaM2: 100, rooms: 3 },
        });
        return { reply: "How many bathrooms are there?", toolResults: [], steps: 1 };
      },
    };
    const deps = {
      repository,
      telegram,
      calendarReservation: new CalendarReservationService(repository, calendar),
      agent,
    };

    await processTelegramWebhook(update(188, "standard cleaning, 100 m2"), deps);
    await expect(processTelegramWebhook(update(189, "1"), deps)).resolves.toEqual({ kind: "processed" });

    expect(receivedMessages).toEqual(["standard cleaning, 100 m2", "1"]);
    expect(repository.getLead(1001)?.clientData.bathrooms).toBe(1);
    expect(calendar.creates).toHaveLength(0);
  });

  it("keeps the quote and records Human Needed when Calendar availability fails", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(86, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    deps.calendar.getBusyIntervals = async () => { throw new Error("simulated Composio availability failure"); };
    await expect(processTelegramWebhook(update(87, "Please show available slots"), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.repository.getLead(1001)).toMatchObject({ status: "qualified", quoteValidity: "active", humanNeeded: true, humanNeededReason: "calendar_unavailable" });
    expect(deps.repository.activities).toContainEqual(expect.objectContaining({ eventType: "calendar_availability_failed", payload: { error_code: "calendar_availability_failed" } }));
  });

  it("keeps an unavailable semantic candidate private, then records only its safe attempt evidence", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const now = new Date("2026-08-24T10:00:00.000Z");
    const reservation = new CalendarReservationService(repository, calendar, undefined, () => now);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6_000, baseRsd: 6_000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-26" };
    await repository.saveLead(lead);
    const fullyBusy = { start: "2026-08-24T06:00:00.000Z", end: "2026-09-12T18:00:00.000Z" };
    calendar.busyByTeam = { team_a: [fullyBusy], team_b: [fullyBusy] };
    const datesVisibleToCalendar: string[] = [];
    const originalGetBusyIntervals = calendar.getBusyIntervals.bind(calendar);
    calendar.getBusyIntervals = async (input) => {
      datesVisibleToCalendar.push(repository.getLead(1001)?.clientData.preferredDate ?? "missing");
      return originalGetBusyIntervals(input);
    };
    const agent = schedulingAgent({ dateReference: "tomorrow", timePreference: "any" });

    await expect(processTelegramWebhook(update(879, "Could you check tomorrow?"), {
      repository, telegram, calendarReservation: reservation, agent, now: () => now,
    })).resolves.toEqual({ kind: "processed" });

    expect(datesVisibleToCalendar).toEqual(["2026-08-26", "2026-08-26"]);
    expect(repository.getLead(1001)).toMatchObject({
      clientData: { preferredDate: "2026-08-26" },
      quote: { amountRsd: 6_000 }, quoteValidity: "active", humanNeeded: false,
    });
    expect(await repository.getLastAvailabilityAttempt(lead.id)).toEqual(expect.objectContaining({
      result: "no_slots", candidateDate: "2026-08-25", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh",
    }));
    expect(await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: now.toISOString() })).toEqual([]);

    const nextAgent: AgentGateway = {
      async createConversation() { return { id: "fresh-attempt-snapshot" }; },
      async runTurn(input) {
        expect(input.schedulingSnapshot?.lastAvailabilityAttempt).toMatchObject({ result: "no_slots", candidateDate: "2026-08-25" });
        const output = await input.executeTool("request_available_slots", { intent: {
          dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "none",
        } });
        return { reply: "I checked the actual calendar again.", toolResults: [{ name: "request_available_slots", output }], steps: 1 };
      },
    };
    await expect(processTelegramWebhook(update(880, "Could you check the nearest date again?"), {
      repository, telegram, calendarReservation: reservation, agent: nextAgent, now: () => now,
    })).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(4);
  });

  it("uses the last no-slots candidate only as an exact fallback for a later time-only re-read", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const now = new Date("2026-08-24T10:00:00.000Z");
    const reservation = new CalendarReservationService(repository, calendar, undefined, () => now);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6_000, baseRsd: 6_000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar" };
    await repository.saveLead(lead);
    calendar.busyByTeam = {
      team_a: [{ start: "2026-08-24T06:00:00.000Z", end: "2026-09-12T18:00:00.000Z" }],
      team_b: [{ start: "2026-08-24T06:00:00.000Z", end: "2026-09-12T18:00:00.000Z" }],
    };
    let turns = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: `attempt-fallback-${turns}` }; },
      async runTurn(input) {
        turns += 1;
        if (turns === 1) {
          expect(input.schedulingSnapshot).toMatchObject({ currentTurnDateCoordinate: { date: "2026-08-25", recommendedDateReference: "tomorrow" }, preferredDate: undefined });
          const output = await input.executeTool("request_available_slots", { intent: {
            dateReference: "tomorrow", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "none",
          } });
          return { reply: "{}", toolResults: [{ name: "request_available_slots", output }], steps: 1, conversationResetRequired: true };
        }
        expect(input.schedulingSnapshot?.preferredDate).toBeUndefined();
        expect(input.schedulingSnapshot?.currentTurnDateCoordinate).toBeUndefined();
        expect(input.schedulingSnapshot?.lastAvailabilityAttempt).toMatchObject({ result: "no_slots", candidateDate: "2026-08-25" });
        const output = await input.executeTool("request_available_slots", { intent: {
          dateReference: "exact_date", exactDate: "2026-08-25", timePreference: "evening", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "none",
        } });
        return { reply: "{}", toolResults: [{ name: "request_available_slots", output }], steps: 1, conversationResetRequired: true };
      },
    };
    const deps = { repository, telegram, calendar, calendarReservation: reservation, agent, now: () => now };

    await expect(processTelegramWebhook(update(8791, "Tomorrow."), deps)).resolves.toEqual({ kind: "processed" });
    await expect(processTelegramWebhook(update(8792, "And in the evening?"), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(4);
    expect(calendar.creates).toHaveLength(0);
    expect(await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: now.toISOString() })).toEqual([]);
    expect(repository.getLead(1001)?.clientData.preferredDate).toBeUndefined();
    expect(repository.getLead(1001)).toMatchObject({ quote: { amountRsd: 6_000 }, quoteValidity: "active", humanNeeded: false });
  });

  it("keeps an old offer authoritative while an explicit no-slots date is retried by its exact attempt coordinate", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const now = new Date("2026-08-24T10:00:00.000Z");
    const reservation = new CalendarReservationService(repository, calendar, undefined, () => now);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6_000, baseRsd: 6_000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-25" };
    await repository.saveLead(lead);
    const oldOffer = await reservation.offerSlots(lead, "en");
    if (!oldOffer.ok) throw new Error(oldOffer.error);
    const oldTokens = await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: now.toISOString() });
    calendar.busyByTeam = {
      team_a: [{ start: "2026-08-26T06:00:00.000Z", end: "2026-09-12T18:00:00.000Z" }],
      team_b: [{ start: "2026-08-26T06:00:00.000Z", end: "2026-09-12T18:00:00.000Z" }],
    };
    const readsBefore = calendar.availabilityQueries.length;
    let turns = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: `attempt-alongside-durable-${turns}` }; },
      async runTurn(input) {
        turns += 1;
        if (turns === 1) {
          expect(input.schedulingSnapshot).toMatchObject({
            preferredDate: "2026-08-25",
            lastOffer: { dates: ["2026-08-25"] },
            currentTurnDateCoordinate: { date: "2026-08-26", recommendedDateReference: "exact_date" },
          });
        } else {
          expect(input.schedulingSnapshot).toMatchObject({
            preferredDate: "2026-08-25",
            lastOffer: { dates: ["2026-08-25"] },
            lastAvailabilityAttempt: { result: "no_slots", candidateDate: "2026-08-26" },
          });
          expect(input.schedulingSnapshot?.currentTurnDateCoordinate).toBeUndefined();
        }
        const output = await input.executeTool("request_available_slots", { intent: {
          dateReference: "exact_date", exactDate: "2026-08-26",
          timePreference: turns === 1 ? "any" : "evening",
          timePreferenceMode: turns === 1 ? "preserve" : "explicit",
          relation: "fresh", existingOfferDisposition: "retain_until_replacement",
        } });
        expect(output).toMatchObject({ ok: false, error: "no_available_slots" });
        return { reply: "{}", toolResults: [{ name: "request_available_slots", output }], steps: 1, conversationResetRequired: true };
      },
    };
    const deps = { repository, telegram, calendar, calendarReservation: reservation, agent, now: () => now };

    await expect(processTelegramWebhook(update(8793, "Could you check 2026-08-26?"), deps)).resolves.toEqual({ kind: "processed" });
    await expect(processTelegramWebhook(update(8794, "And in the evening?"), deps)).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(readsBefore + 4);
    expect(calendar.creates).toHaveLength(0);
    expect(await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: now.toISOString() })).toEqual(oldTokens);
    expect(repository.getLead(1001)).toMatchObject({
      clientData: { preferredDate: "2026-08-25" }, quote: { amountRsd: 6_000 }, quoteValidity: "active", humanNeeded: false,
    });
  });

  it("ignores malformed historical availability activity instead of exposing it to a fresh scheduling snapshot", async () => {
    const repository = new InMemoryLeadRepository();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    repository.activities.push({ leadId: lead.id, eventType: "calendar_availability_attempted", payload: { result: "no_slots", provider_payload: "must never surface" } });
    expect(await repository.getLastAvailabilityAttempt(lead.id)).toBeNull();
  });

  it("accepts only canonical bounded availability attempts and does not read them during intake", async () => {
    expect(storedAvailabilityAttemptSchema.safeParse({
      result: "no_slots", candidateDate: "2026-08-26", timePreference: "after", timePreferenceMode: "explicit", afterLocalTime: "99:99", relation: "fresh", checkedAt: TEST_NOW.toISOString(),
    }).success).toBe(false);
    expect(storedAvailabilityAttemptSchema.safeParse({
      result: "no_slots", candidateDate: "2026-08-26", timePreference: "range", timePreferenceMode: "explicit", afterLocalTime: "12:00", beforeLocalTime: "10:00", relation: "fresh", checkedAt: TEST_NOW.toISOString(),
    }).success).toBe(false);
    expect(storedAvailabilityAttemptSchema.safeParse({
      result: "no_slots", candidateDate: "2026-08-26", timePreference: "any", timePreferenceMode: "preserve", afterLocalTime: "10:00", relation: "fresh", checkedAt: TEST_NOW.toISOString(),
    }).success).toBe(false);

    const deps = dependencies();
    deps.repository.getLastAvailabilityAttempt = async () => { throw new Error("activity log is unavailable"); };
    await expect(processTelegramWebhook(update(8801, "Hello, I need a cleaning quote."), deps)).resolves.toEqual({ kind: "processed" });
  });

  it("keeps the quote and records Human Needed when saving a generated slot offer fails", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(880, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    deps.repository.saveCalendarSlotOffer = async () => { throw new Error("simulated Supabase RPC failure"); };

    await expect(processTelegramWebhook(update(881, "Please show available slots"), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.repository.getLead(1001)).toMatchObject({ status: "qualified", quoteValidity: "active", humanNeeded: true, humanNeededReason: "calendar_unavailable" });
    expect(deps.repository.activities).toContainEqual(expect.objectContaining({
      eventType: "calendar_availability_failed",
      payload: { error_code: "calendar_slot_offer_compensation_failed" },
    }));
  });

  it("flags an ambiguous reservation confirmation delivery for manual follow-up", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(882, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    await processTelegramWebhook(update(883, "Please show available slots"), deps);
    deps.telegram.shouldFail = true;
    deps.telegram.failureOutcome = "ambiguous";

    await expect(processTelegramWebhook(update(884, "1"), deps)).resolves.toEqual({ kind: "failed", failureCode: "telegram_delivery_failed" });
    expect(deps.calendar.creates).toHaveLength(1);
    expect(deps.repository.getLead(1001)).toMatchObject({
      calendarEventId: "fake-calendar-event-1",
      humanNeeded: true,
      humanNeededReason: "delivery_ambiguous",
    });
    expect(deps.repository.activities).toContainEqual(expect.objectContaining({
      eventType: "calendar_reservation_delivery_failed",
      payload: { outcome: "ambiguous" },
    }));
  });

  it("starts a clean active lead on New address without calling OpenAI and preserves the previous lead as history", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(90, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );
    const previous = deps.repository.getLead(1001);
    if (!previous) throw new Error("missing previous lead");
    const conversation = await deps.repository.getConversation(previous.id);

    const agentMustNotRun: AgentGateway = {
      async createConversation() { throw new Error("New address must not create a conversation"); },
      async runTurn() { throw new Error("New address must not call the agent"); },
    };
    await expect(processTelegramWebhook(update(91, "New address"), { ...deps, agent: agentMustNotRun })).resolves.toEqual({ kind: "processed" });
    const current = deps.repository.getLead(1001);
    expect(current).toMatchObject({ activeInChat: true, firstMessageLanguage: "und", clientData: {}, humanNeeded: false });
    expect(current?.id).not.toBe(previous.id);
    expect(deps.repository.getLeadById(previous.id)).toMatchObject({ activeInChat: false, clientData: { addressOrDistrict: "vracar" } });
    await expect(deps.repository.getConversation(current?.id ?? "missing")).resolves.toBeNull();
    expect(conversation).toMatchObject({ leadId: previous.id });
    expect(deps.telegram.messages.at(-1)).toMatchObject({ text: "New cleaning location", replyMarkup: { keyboard: [[{ text: "New address" }]] } });

    await processTelegramWebhook(update(92, "standard cleaning, 75 m2"), deps);
    await expect(deps.repository.getConversation(current?.id ?? "missing")).resolves.toMatchObject({ openAiConversationId: "fake-conversation-2" });
  });

  it("does not create another empty lead when New address is pressed twice", async () => {
    const deps = dependencies();
    await processTelegramWebhook(update(93, "New address"), deps);
    const first = deps.repository.getLead(1001);
    await processTelegramWebhook(update(94, "New address"), deps);
    expect(deps.repository.getLead(1001)?.id).toBe(first?.id);
    expect(deps.repository.activities.filter((activity) => activity.eventType === "new_address_started")).toHaveLength(2);
  });

  it("does not carry a prior Russian turn over New address and uses an English divider", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const firstAgent: AgentGateway = {
      async createConversation() { return { id: "old-language-conversation" }; },
      async runTurn() { return { reply: "Здравствуйте", toolResults: [], steps: 0 }; },
    };
    await processTelegramWebhook(update(95, "Нужна уборка"), { repository, telegram, agent: firstAgent });
    const noAgent: AgentGateway = {
      async createConversation() { throw new Error("reset must not create a conversation"); },
      async runTurn() { throw new Error("reset must not call the agent"); },
    };
    await processTelegramWebhook(update(96, "New address"), { repository, telegram, agent: noAgent });
    expect(repository.getLead(1001)).toMatchObject({ firstMessageLanguage: "und", agentConfigVersion: 5 });
    expect(telegram.messages.at(-1)?.text).toBe("New cleaning location");
  });

  it("starts a Russian post-renovation request after New address in Russian and preserves its supplied facts", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const agent: AgentGateway = {
      async createConversation() { return { id: "russian-post-renovation" }; },
      async runTurn(input) {
        expect(input.replyLanguage).toBe("ru");
        await input.executeTool("update_client_data", { patch: {
          cleaningType: "standard", areaM2: 55, rooms: 2, bathrooms: 1,
          heavyPetHair: false, extras: [], addressOrDistrict: "Vračar", preferredDate: "2026-08-26",
        } });
        await input.executeTool("mark_human_needed", { reason: "after_renovation" });
        return { reply: "Спасибо, я передам детали команде.", toolResults: [], steps: 2 };
      },
    };

    await processTelegramWebhook(update(97, "New address"), { repository, telegram, agent });
    await expect(processTelegramWebhook(
      update(98, "Нужна стандартная уборка после ремонта: 55 m², 2 комнаты, 1 санузел, без шерсти, без дополнительных услуг, район Vračar, 26.08.2026"),
      { repository, telegram, agent },
    )).resolves.toEqual({ kind: "processed" });

    expect(repository.getLead(1001)).toMatchObject({
      firstMessageLanguage: "ru",
      humanNeeded: true,
      humanNeededReason: "after_renovation",
      clientData: {
        cleaningType: "standard", areaM2: 55, rooms: 2, bathrooms: 1,
        heavyPetHair: false, extras: [], addressOrDistrict: "Vračar", preferredDate: "2026-08-26",
      },
    });
    expect(telegram.messages.at(-1)?.text).toContain("передам заявку специалисту");
  });

  it("does not synchronously mutate Trello for an ordinary text turn", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const trello = new FakeTrelloGateway();
    const deps = { repository, telegram, agent: new FakeAgentGateway(), trelloSync: new TrelloSyncService(repository, trello) };

    await processTelegramWebhook(
      update(1002, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"),
      deps,
    );

    expect(trello.creates).toHaveLength(0);
    expect(trello.updates).toHaveLength(0);
    expect(repository.trelloSyncJobs.get(repository.getLead(1001)?.id ?? "missing")).toMatchObject({ desiredLifecycle: "qualified", state: "pending" });
  });

  it("keeps booking pending through a Trello worker failure, then confirms once without another Calendar event", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const trello = new FakeTrelloGateway();
    const trelloSync = new TrelloSyncService(repository, trello);
    const deps = { repository, telegram, agent: new FakeAgentGateway(), calendarReservation: testCalendarReservation(repository, calendar), trelloSync, now: () => TEST_NOW };

    await processTelegramWebhook(update(1010, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"), deps);
    await processTelegramWebhook(update(1011, "Please show available slots"), deps);
    const markup = telegram.messages.at(-1)?.replyMarkup;
    const callbackData = markup && "inline_keyboard" in markup ? markup.inline_keyboard[0]?.[0]?.callback_data : undefined;
    if (!callbackData) throw new Error("slot callback missing");

    await expect(processTelegramWebhook(callback(1012, "callback-pending-recovery", callbackData), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.creates).toHaveLength(1);
    expect(telegram.messages.at(-1)?.text).toContain("<b>Your time is confirmed.</b>");
    expect(repository.updates.get(1012)).toMatchObject({ status: "processed" });

    const lead = repository.getLead(1001);
    if (!lead) throw new Error("lead missing");
    await repository.accelerateTrelloSyncJob({ leadId: lead.id, now: new Date().toISOString(), replyLanguage: "en" });
    trello.nextCreateResult = { kind: "failed", code: "trello_create_failed", ambiguous: false };
    const recovery = new TrelloRecoveryService(repository, trelloSync, telegram);
    await expect(recovery.reconcileDueJobs(1)).resolves.toMatchObject({ claimed: 1, retried: 1 });
    expect(repository.getLead(1001)).toMatchObject({ status: "qualified", calendarEventId: "fake-calendar-event-1" });
    expect(telegram.messages.filter((message) => message.text.includes("cleaning is confirmed"))).toHaveLength(0);

    trello.nextCreateResult = undefined;
    await repository.accelerateTrelloSyncJob({ leadId: lead.id, now: new Date().toISOString(), replyLanguage: "en" });
    await expect(recovery.reconcileDueJobs(1)).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(calendar.creates).toHaveLength(1);
    expect(repository.getLead(1001)).toMatchObject({ status: "booked" });
    expect(telegram.messages.filter((message) => message.text.includes("cleaning is confirmed"))).toHaveLength(1);
  });

  it("creates and labels a New Lead Trello card for an unqualified Human Needed lead", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const trello = new FakeTrelloGateway();
    const deps = { repository, telegram, agent: new FakeAgentGateway(), trelloSync: new TrelloSyncService(repository, trello) };

    await expect(processTelegramWebhook(update(1030, "commercial renovation cleaning"), deps)).resolves.toEqual({ kind: "processed" });
    const lead = repository.getLead(1001);
    expect(lead).toMatchObject({ status: "new_lead", humanNeeded: true, humanNeededReason: "after_renovation" });
    expect(trello.creates).toHaveLength(1);
    if (!lead) throw new Error("lead missing");
    await expect(trello.findCardByBusinessReference(lead.businessReference)).resolves.toMatchObject({
      lifecycle: "new_lead",
      humanNeeded: true,
    });
  });

  it("keeps a delivered Human Needed turn processed when its first Trello projection fails", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const trello = new FakeTrelloGateway();
    trello.nextCreateResult = { kind: "failed", code: "trello_unavailable", ambiguous: false };
    const deps = { repository, telegram, agent: new FakeAgentGateway(), trelloSync: new TrelloSyncService(repository, trello) };

    await expect(processTelegramWebhook(update(1031, "commercial renovation cleaning"), deps)).resolves.toEqual({ kind: "processed" });
    expect(repository.getLead(1001)).toMatchObject({ status: "new_lead", humanNeeded: true, humanNeededReason: "after_renovation" });
    expect(telegram.messages).toHaveLength(1);
    expect(trello.creates).toHaveLength(1);
  });

  it("requeues an existing Qualified projection when a later turn needs Human Needed", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const trello = new FakeTrelloGateway();
    const trelloSync = new TrelloSyncService(repository, trello);
    const deps = { repository, telegram, agent: new FakeAgentGateway(), trelloSync };
    const recovery = new TrelloRecoveryService(repository, trelloSync, telegram);

    await processTelegramWebhook(update(1040, "standard cleaning, 100 m2, 3 rooms, 1 bathrooms, no pet hair, no extras, district: Vracar, 2026-08-24"), deps);
    const lead = repository.getLead(1001);
    if (!lead) throw new Error("lead missing");
    await recovery.reconcileDueJobs(1);
    await processTelegramWebhook(update(1041, "commercial renovation cleaning"), deps);
    await recovery.reconcileDueJobs(1);

    expect(repository.getLead(1001)).toMatchObject({ status: "qualified", humanNeeded: true, humanNeededReason: "after_renovation" });
    await expect(trello.findCardByBusinessReference(lead.businessReference)).resolves.toMatchObject({ lifecycle: "qualified", humanNeeded: true });
  });

  it("does not commit an invisible slot offer when the provider fails after a successful availability tool", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const reservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-26" };
    await repository.saveLead(lead);
    const initial = await reservation.offerSlots(lead, "en");
    if (!initial.ok) throw new Error(initial.error);
    const agent: AgentGateway = {
      async createConversation() { return { id: "provider-final-failure" }; },
      async runTurn(input) {
        await input.executeTool("request_available_slots", { intent: { dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh" } });
        throw new AgentTurnTechnicalError("agent_provider_timeout");
      },
    };

    await expect(processTelegramWebhook(update(2101, "Show slots again"), { repository, telegram, calendarReservation: reservation, agent, now: () => TEST_NOW })).resolves.toEqual({ kind: "processed" });
    const active = await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() });
    expect(active).toEqual([]);
    expect(repository.getLead(1001)).toMatchObject({ clientData: { preferredDate: "2026-08-26" }, quoteValidity: "active", humanNeeded: false });
    expect(calendar.availabilityQueries).toHaveLength(4);
    expect(calendar.creates).toHaveLength(0);
    expect(repository.activities.filter((activity) => activity.eventType === "calendar_availability_attempted")).toHaveLength(0);
  });

  it("rolls back a newly committed availability offer after confirmed Telegram delivery failure", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    telegram.shouldFail = true;
    telegram.failureOutcome = "failed";
    const calendar = new FakeCalendarGateway();
    const reservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-26" };
    await repository.saveLead(lead);

    await expect(processTelegramWebhook(update(21011, "Could you show tomorrow instead?"), {
      repository, telegram, calendarReservation: reservation,
      agent: schedulingAgent({ dateReference: "tomorrow", timePreference: "any", timePreferenceMode: "explicit" }), now: () => TEST_NOW,
    })).resolves.toEqual({ kind: "failed", failureCode: "telegram_delivery_failed" });

    expect(await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() })).toEqual([]);
    expect(repository.getLead(1001)).toMatchObject({
      clientData: { preferredDate: "2026-08-26" }, quote: { amountRsd: 6000 }, quoteValidity: "active",
      humanNeeded: true, humanNeededReason: "delivery_failed",
    });
    expect(repository.activities.filter((activity) => activity.eventType === "calendar_availability_attempted")).toHaveLength(0);
    expect(repository.activities).toContainEqual(expect.objectContaining({
      eventType: "telegram_delivery_failed",
      payload: { outcome: "failed", availability_offer_policy: "rolled_back_after_confirmed_failure" },
    }));
    expect(calendar.creates).toHaveLength(0);
  });

  it("keeps an ambiguously delivered availability offer but blocks its callback conservatively", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    telegram.shouldFail = true;
    telegram.failureOutcome = "ambiguous";
    const calendar = new FakeCalendarGateway();
    const reservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-26" };
    await repository.saveLead(lead);

    await expect(processTelegramWebhook(update(21012, "Could you show tomorrow instead?"), {
      repository, telegram, calendarReservation: reservation,
      agent: schedulingAgent({ dateReference: "tomorrow", timePreference: "any", timePreferenceMode: "explicit" }), now: () => TEST_NOW,
    })).resolves.toEqual({ kind: "failed", failureCode: "telegram_delivery_failed" });

    const active = await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() });
    expect(active).toHaveLength(3);
    expect(repository.getLead(1001)).toMatchObject({
      clientData: { preferredDate: "2026-08-25" }, humanNeeded: true, humanNeededReason: "delivery_ambiguous",
    });
    expect(repository.activities).toContainEqual(expect.objectContaining({
      eventType: "telegram_delivery_failed",
      payload: { outcome: "ambiguous", availability_offer_policy: "preserved_and_blocked_after_ambiguous_delivery" },
    }));
    telegram.shouldFail = false;
    await expect(processTelegramWebhook(callback(21013, "ambiguous-offer-callback", `slot:en:${active[0]!.token}`), {
      repository, telegram, calendarReservation: reservation, agent: new FakeAgentGateway(), now: () => TEST_NOW,
    })).resolves.toEqual({ kind: "processed" });
    expect(calendar.creates).toHaveLength(0);
  });

  it("compensates a failed deferred slot-token commit and makes a safe Calendar handoff", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const reservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-26" };
    await repository.saveLead(lead);
    const oldOffer = await reservation.offerSlots(lead, "en");
    if (!oldOffer.ok) throw new Error(oldOffer.error);
    const oldToken = oldOffer.slots[0]!.token;
    const originalSave = repository.saveCalendarSlotOffer.bind(repository);
    let saveCallsInTurn = 0;
    repository.saveCalendarSlotOffer = async (input) => {
      saveCallsInTurn += 1;
      if (saveCallsInTurn === 1) throw new Error("synthetic deferred offer RPC failure");
      return originalSave(input);
    };

    await expect(processTelegramWebhook(update(21015, "Show slots again"), {
      repository, telegram, calendarReservation: reservation,
      agent: schedulingAgent({ dateReference: "current_preferred_date", timePreference: "any" }), now: () => TEST_NOW,
    })).resolves.toEqual({ kind: "processed" });

    expect(saveCallsInTurn).toBe(2); // deferred commit failure → conservative compensation
    expect(await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() })).toEqual([]);
    expect(await repository.getCalendarSlotToken({ leadId: lead.id, token: oldToken })).toMatchObject({ supersededAt: expect.any(String) });
    expect(repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "calendar_unavailable", quoteValidity: "active" });
    expect(repository.activities).toContainEqual(expect.objectContaining({ eventType: "calendar_availability_failed", payload: { error_code: "calendar_slot_offer_persist_failed" } }));
    expect(repository.activities.filter((activity) => activity.eventType === "calendar_availability_attempted")).toHaveLength(0);
    expect(telegram.messages.at(-1)?.text).toContain("safely check free times");
  });

  it("supersedes a committed deferred offer if agent-turn completion cannot be recorded", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const reservation = testCalendarReservation(repository, calendar);
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-26" };
    await repository.saveLead(lead);
    const oldOffer = await reservation.offerSlots(lead, "en");
    if (!oldOffer.ok) throw new Error(oldOffer.error);
    const oldToken = oldOffer.slots[0]!.token;
    const originalComplete = repository.completeIntegrationOperation.bind(repository);
    repository.completeIntegrationOperation = async (key, externalId) => {
      if (key.startsWith("openai:agent_turn:")) throw new Error("synthetic operation completion failure");
      return originalComplete(key, externalId);
    };

    await expect(processTelegramWebhook(update(21016, "Show slots again"), {
      repository, telegram, calendarReservation: reservation,
      agent: schedulingAgent({ dateReference: "current_preferred_date", timePreference: "any" }), now: () => TEST_NOW,
    })).resolves.toEqual({ kind: "processed" });

    expect(await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() })).toEqual([]);
    expect(await repository.getCalendarSlotToken({ leadId: lead.id, token: oldToken })).toMatchObject({ supersededAt: expect.any(String) });
    expect(repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "calendar_unavailable", quoteValidity: "active" });
    expect(repository.activities).toContainEqual(expect.objectContaining({ eventType: "calendar_availability_failed", payload: { error_code: "agent_turn_operation_complete_failed" } }));
    expect(repository.activities.filter((activity) => activity.eventType === "calendar_availability_attempted")).toHaveLength(0);
    expect(telegram.messages.at(-1)?.text).toContain("safely check free times");
  });

  it("invalidates a stateless provider-replay Conversation before committing its deferred availability offer", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const events: string[] = [];
    const originalInvalidate = repository.invalidateConversation.bind(repository);
    const originalSaveOffer = repository.saveCalendarSlotOffer.bind(repository);
    const originalComplete = repository.completeIntegrationOperation.bind(repository);
    repository.invalidateConversation = async (leadId) => { events.push("invalidate"); await originalInvalidate(leadId); };
    repository.saveCalendarSlotOffer = async (input) => {
      if (input.tokens.length > 0) events.push("commit_deferred_offer");
      await originalSaveOffer(input);
    };
    repository.completeIntegrationOperation = async (key, externalId) => {
      if (key.startsWith("openai:agent_turn:")) events.push("complete_agent_turn");
      await originalComplete(key, externalId);
    };
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-26" };
    await repository.saveLead(lead);
    await repository.saveConversation({ leadId: lead.id, telegramChatId: 1001, openAiConversationId: "stale-primary-conversation" });
    const agent: AgentGateway = {
      async createConversation() { throw new Error("existing conversation must be used for this turn"); },
      async runTurn(input) {
        const output = await input.executeTool("request_available_slots", { intent: { dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh" } });
        return { reply: "I checked the latest options.", toolResults: [{ name: "request_available_slots", output }], steps: 1, conversationResetRequired: true, statelessRecovery: "provider_failure_replay" };
      },
    };

    await expect(processTelegramWebhook(update(21017, "Show the real times"), { repository, telegram, calendarReservation: testCalendarReservation(repository, calendar), agent, now: () => TEST_NOW })).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(calendar.creates).toHaveLength(0);
    await expect(repository.getConversation(lead.id)).resolves.toBeNull();
    expect(events.indexOf("invalidate")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("commit_deferred_offer")).toBeGreaterThan(events.indexOf("invalidate"));
    expect(events.indexOf("complete_agent_turn")).toBeGreaterThan(events.indexOf("commit_deferred_offer"));
  });

  it("discards a repaired deferred offer and rolls back when mapping invalidation first fails", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const events: string[] = [];
    const originalInvalidate = repository.invalidateConversation.bind(repository);
    const originalSaveOffer = repository.saveCalendarSlotOffer.bind(repository);
    const originalComplete = repository.completeIntegrationOperation.bind(repository);
    let invalidations = 0;
    repository.invalidateConversation = async (leadId) => {
      invalidations += 1;
      events.push(`invalidate_${invalidations}`);
      if (invalidations === 1) throw new Error("synthetic mapping invalidation failure");
      await originalInvalidate(leadId);
    };
    repository.saveCalendarSlotOffer = async (input) => {
      events.push(input.tokens.length > 0 ? "commit_deferred_offer" : "discard_deferred_offer");
      await originalSaveOffer(input);
    };
    repository.completeIntegrationOperation = async (key, externalId) => {
      if (key.startsWith("openai:agent_turn:")) events.push("complete_agent_turn");
      await originalComplete(key, externalId);
    };
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-26" };
    await repository.saveLead(lead);
    await repository.saveConversation({ leadId: lead.id, telegramChatId: 1001, openAiConversationId: "failed-primary-reset" });
    const agent: AgentGateway = {
      async createConversation() { throw new Error("existing conversation must be used for this turn"); },
      async runTurn(input) {
        const output = await input.executeTool("request_available_slots", { intent: { dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh" } });
        return { reply: "I checked the latest options.", toolResults: [{ name: "request_available_slots", output }], steps: 1, conversationResetRequired: true };
      },
    };

    await expect(processTelegramWebhook(update(21018, "Show the real times"), { repository, telegram, calendarReservation: testCalendarReservation(repository, calendar), agent, now: () => TEST_NOW })).resolves.toEqual({ kind: "processed" });

    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(calendar.creates).toHaveLength(0);
    expect(await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: TEST_NOW.toISOString() })).toEqual([]);
    expect(events).toContain("discard_deferred_offer");
    expect(events).not.toContain("commit_deferred_offer");
    expect(events).not.toContain("complete_agent_turn");
    expect(events.indexOf("invalidate_1")).toBeLessThan(events.lastIndexOf("discard_deferred_offer"));
    await expect(repository.getConversation(lead.id)).resolves.toBeNull();
  });

  it("does not read Calendar for a repaired no-Calendar decision", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-26" };
    await repository.saveLead(lead);
    await repository.saveConversation({ leadId: lead.id, telegramChatId: 1001, openAiConversationId: "no-calendar-primary-reset" });
    const agent: AgentGateway = {
      async createConversation() { throw new Error("existing conversation must be used for this turn"); },
      async runTurn(input) {
        const output = await input.executeTool("record_scheduling_decision", { reason: "awaiting_customer_choice" });
        return { reply: "Choose one of the already shown options when you are ready.", toolResults: [{ name: "record_scheduling_decision", output }], steps: 1, conversationResetRequired: true };
      },
    };

    await expect(processTelegramWebhook(update(21019, "Thanks"), { repository, telegram, calendarReservation: testCalendarReservation(repository, calendar), agent, now: () => TEST_NOW })).resolves.toEqual({ kind: "processed" });
    expect(calendar.availabilityQueries).toHaveLength(0);
    expect(calendar.creates).toHaveLength(0);
    await expect(repository.getConversation(lead.id)).resolves.toBeNull();
  });

  it("rolls back a quoted pricing correction that omits recalculation before a no-Calendar reset", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 4000, baseRsd: 4000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 50, rooms: 1, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar" };
    await repository.saveLead(lead);
    await repository.saveConversation({ leadId: lead.id, telegramChatId: 1001, openAiConversationId: "quoted-correction-primary" });
    const agent: AgentGateway = {
      async createConversation() { throw new Error("existing conversation must be used"); },
      async runTurn(input) {
        await input.executeTool("update_client_data", { patch: { cleaningType: null, areaM2: 55, rooms: null, bathrooms: null, heavyPetHair: null, extras: null, addressOrDistrict: null, preferredDate: null } });
        const output = await input.executeTool("record_scheduling_decision", { reason: "question_not_about_scheduling" });
        return { reply: "I updated that.", toolResults: [{ name: "record_scheduling_decision", output }], steps: 2, conversationResetRequired: true };
      },
    };

    await expect(processTelegramWebhook(update(21020, "Actually it is 55 m2."), { repository, telegram, calendarReservation: testCalendarReservation(repository, calendar), agent, now: () => TEST_NOW })).resolves.toEqual({ kind: "processed" });

    expect(repository.getLead(1001)).toMatchObject({ clientData: { areaM2: 50 }, quoteValidity: "active", quote: { amountRsd: 4000 } });
    expect(calendar.availabilityQueries).toHaveLength(0);
    expect(calendar.creates).toHaveLength(0);
    expect(repository.activities).toContainEqual(expect.objectContaining({ eventType: "conversation_invalidated_after_technical_turn" }));
  });

  it("commits a quoted pricing correction only after calculate_quote and resets the Conversation", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 4000, baseRsd: 4000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 50, rooms: 1, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar" };
    await repository.saveLead(lead);
    await repository.saveConversation({ leadId: lead.id, telegramChatId: 1001, openAiConversationId: "quoted-correction-replay" });
    const agent: AgentGateway = {
      async createConversation() { throw new Error("existing conversation must be used"); },
      async runTurn(input) {
        await input.executeTool("update_client_data", { patch: { cleaningType: null, areaM2: 55, rooms: null, bathrooms: null, heavyPetHair: null, extras: null, addressOrDistrict: null, preferredDate: null } });
        const quote = await input.executeTool("calculate_quote", {});
        return { reply: "The updated quote is 4,400 RSD.", toolResults: [{ name: "calculate_quote", output: quote }], steps: 2, conversationResetRequired: true, statelessRecovery: "scheduling_omission_replay" };
      },
    };

    await expect(processTelegramWebhook(update(21021, "Actually it is 55 m2."), { repository, telegram, calendarReservation: testCalendarReservation(repository, calendar), agent, now: () => TEST_NOW })).resolves.toEqual({ kind: "processed" });

    expect(repository.getLead(1001)).toMatchObject({ clientData: { areaM2: 55 }, quoteValidity: "active", quote: { amountRsd: 4400 } });
    await expect(repository.getConversation(lead.id)).resolves.toBeNull();
    expect(calendar.availabilityQueries).toHaveLength(0);
    expect(calendar.creates).toHaveLength(0);
    expect(await repository.getIntegrationOperation(`openai:agent_turn:${lead.id}:21021`)).toMatchObject({ status: "succeeded" });
  });

  it("restores the prior date and same-day quote when a changed-date Calendar read fails", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    calendar.getBusyIntervals = async () => { throw new Error("synthetic Calendar transport failure"); };
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 4800, baseRsd: 4000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: true, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 50, rooms: 1, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-24", urgency: "same_day" };
    await repository.saveLead(lead);
    const agent = schedulingAgent({ dateReference: "tomorrow", timePreference: "any", timePreferenceMode: "explicit" });

    await expect(processTelegramWebhook(update(2102, "Could tomorrow work?"), { repository, telegram, calendarReservation: testCalendarReservation(repository, calendar), agent, now: () => TEST_NOW })).resolves.toEqual({ kind: "processed" });
    expect(repository.getLead(1001)).toMatchObject({
      humanNeeded: true,
      humanNeededReason: "calendar_unavailable",
      clientData: { preferredDate: "2026-08-24", urgency: "same_day" },
      quote: { amountRsd: 4800, sameDayApplied: true },
    });
  });

  it("keeps the shared bare-consent offer to one actual day and aligns its quote", async () => {
    class MixedFutureSchedulingEngine extends SchedulingEngine {
      override findSlots() {
        return [
          { team: "team_a" as const, start: "2026-08-25T06:00:00.000Z", end: "2026-08-25T08:00:00.000Z", bufferEnd: "2026-08-25T08:30:00.000Z" },
          { team: "team_b" as const, start: "2026-08-26T06:00:00.000Z", end: "2026-08-26T08:00:00.000Z", bufferEnd: "2026-08-26T08:30:00.000Z" },
        ];
      }
    }
    const now = new Date("2026-08-24T19:42:00.000Z");
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quotedAt = now.toISOString();
    lead.pendingSchedulingConsentQuotedAt = now.toISOString();
    lead.quote = { amountRsd: 4800, baseRsd: 4000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: true, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 50, rooms: 1, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-24", urgency: "same_day" };
    await repository.saveLead(lead);
    const reservation = new CalendarReservationService(repository, calendar, new MixedFutureSchedulingEngine(), () => now);
    const agent: AgentGateway = { async createConversation() { throw new Error("bare consent is backend-owned"); }, async runTurn() { throw new Error("bare consent is backend-owned"); } };

    await expect(processTelegramWebhook(update(21025, "yes"), { repository, telegram, calendarReservation: reservation, agent, now: () => now })).resolves.toEqual({ kind: "processed" });
    const active = await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: now.toISOString() });
    expect(active).toHaveLength(1);
    expect(active.every((slot) => slot.start.startsWith("2026-08-25"))).toBe(true);
    expect(repository.getLead(1001)).toMatchObject({
      clientData: { preferredDate: "2026-08-25" },
      quote: { amountRsd: 4000, sameDayApplied: false },
    });
    expect(repository.getLead(1001)?.clientData.urgency).toBeUndefined();
  });

  it("preserves a previous time window for a date-only intent and clears it for explicit any time", async () => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const lead = await repository.createLead({ telegramChatId: 1001, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quoteValidity = "active";
    lead.quote = { amountRsd: 6000, baseRsd: 6000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate: "2026-08-26", preferredTimeWindow: "evening" };
    await repository.saveLead(lead);
    const agent: AgentGateway = {
      async createConversation() { return { id: "time-preference-mode" }; },
      async runTurn(input) {
        const explicit = input.message.includes("any time");
        const output = await input.executeTool("request_available_slots", { intent: { dateReference: "tomorrow", timePreference: "any", timePreferenceMode: explicit ? "explicit" : "preserve", relation: "fresh" } });
        return { reply: "I checked the current times.", toolResults: [{ name: "request_available_slots", output }], steps: 1 };
      },
    };
    const deps = { repository, telegram, calendar, calendarReservation: testCalendarReservation(repository, calendar), agent, now: () => TEST_NOW };

    await expect(processTelegramWebhook(update(2103, "Tomorrow"), deps)).resolves.toEqual({ kind: "processed" });
    expect(repository.getLead(1001)?.clientData).toMatchObject({ preferredDate: "2026-08-25", preferredTimeWindow: "evening" });
    await expect(processTelegramWebhook(update(2104, "Tomorrow any time"), deps)).resolves.toEqual({ kind: "processed" });
    expect(repository.getLead(1001)?.clientData.preferredTimeWindow).toBeUndefined();
    expect(calendar.availabilityQueries).toHaveLength(4);
  });
});
