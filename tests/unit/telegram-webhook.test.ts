import { describe, expect, it, vi } from "vitest";

import { AgentTurnTechnicalError, FakeAgentGateway, type AgentGateway } from "@/lib/agent/gateway";
import { FakeCalendarGateway } from "@/lib/calendar/gateway";
import { CalendarReservationService } from "@/lib/calendar/reservation-service";
import { InMemoryLeadRepository } from "@/lib/leads/in-memory-repository";
import { FakeTelegramGateway } from "@/lib/telegram/gateway";
import { resolveReplyLanguage } from "@/lib/telegram/language";
import { processTelegramWebhook, resolveRelativePreferredDate } from "@/lib/telegram/webhook";
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

  it("keeps a natural Russian date after New address, quotes the completed request, then offers slots", async () => {
    const now = new Date("2026-08-24T10:00:00.000Z");
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    const calendarReservation = new CalendarReservationService(repository, calendar, undefined, () => now);
    const agent: AgentGateway = {
      async createConversation() { return { id: "named-russian-date" }; },
      async runTurn(input) {
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
    const deps = { ...base, agent: {
      async createConversation() { return { id: "over-200" }; },
      async runTurn(input: import("@/lib/agent/gateway").AgentTurnInput) {
        tools.push([...(input.allowedTools ?? [])]);
        if (turns++ > 0) return { reply: "Понял.", toolResults: [], steps: 0 };
        const saved = await input.executeTool("update_client_data", { patch: { areaM2: 240 } });
        expect(saved).toMatchObject({ ok: true, client_data: { areaM2: 240 } });
        return { reply: "Нужно проверить детали.", toolResults: [], steps: 1 };
      },
    } };
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
    const deps = { ...base, agent: {
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
    } };
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

  it("supersedes a base quote for today and waits for a later scheduling acceptance before slots", async () => {
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
          expect(input.knownClientData).toMatchObject({ preferredDate: "2026-08-24", urgency: "same_day" });
          await input.executeTool("calculate_quote", {});
          return { reply: "Today’s quote is ready.", toolResults: [], steps: 1 };
        }
        throw new Error("The explicit follow-up availability request must use the backend fast path");
      },
    };
    const deps = { repository, telegram, calendar, agent, calendarReservation: new CalendarReservationService(repository, calendar, undefined, () => now), now: () => now };
    await processTelegramWebhook(update(1913, "Standard 50 m2, one room, one bathroom, no pet hair or extras, Vracar."), deps);
    expect(repository.getLead(1001)?.quote).toMatchObject({ amountRsd: 4_000, sameDayApplied: false });
    await processTelegramWebhook(update(1914, "Today please."), deps);
    expect(repository.getLead(1001)?.quote).toMatchObject({ amountRsd: 4_800, sameDayApplied: true });
    expect(calendar.availabilityQueries).toHaveLength(0);
    await processTelegramWebhook(update(1915, "Yes, please show me available times."), deps);
    expect(calendar.availabilityQueries).toHaveLength(2);
    expect(telegram.messages.at(-1)?.text).toContain("Nearest available times");
  });

  it.each([
    ["en", "Please show available slots", "Nearest available times"],
    ["ru", "Покажи свободные слоты", "Ближайшее свободное время"],
    ["ru", "вечером", "Ближайшее свободное время"],
    ["ru", "а вечером?", "Ближайшее свободное время"],
    ["ru", "а в середине дня есть?", "Ближайшее свободное время"],
    ["en", "What about evening?", "Nearest available times"],
    ["sr-Latn", "Pokaži slobodne termine", "Najbliži slobodni termini"],
    ["sr-Latn", "A uveče?", "Najbliži slobodni termini"],
    ["sr-Cyrl", "Покажи слободне термине", "Најближи слободни термини"],
    ["sr-Cyrl", "А увече?", "Најближи слободни термини"],
  ] as const)("serves a strict %s availability request without an agent or Trello turn", async (_language, request, expectedReply) => {
    const repository = new InMemoryLeadRepository();
    const telegram = new FakeTelegramGateway();
    const calendar = new FakeCalendarGateway();
    let agentTurns = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: "availability-fast-path" }; },
      async runTurn(input) {
        agentTurns += 1;
        if (agentTurns > 1) throw new Error("availability request must not reach agent");
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

    expect(agentTurns).toBe(1);
    expect(telegram.messages.at(-1)?.text).toContain(expectedReply);
    expect(repository.trelloSyncJobs.get(repository.getLead(1001)?.id ?? "missing")).toMatchObject({ desiredLifecycle: "qualified" });
  });

  it.each(["show slots, 1 bathroom", "вечером, 2 санузла"])("does not fast-path availability wording mixed with new cleaning details: %s", async (message) => {
    const deps = dependencies();
    const runTurn = vi.spyOn(deps.agent, "runTurn");
    await processTelegramWebhook(update(1510, "standard cleaning, 75 m2, 3 rooms, 2 bathrooms, no pet hair, no extras, district: Vracar, 2026-09-03"), deps);
    await processTelegramWebhook(update(1511, message), deps);
    expect(runTurn).toHaveBeenCalledTimes(2);
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
      const agent: AgentGateway = {
        async createConversation() { return { id: "urgency-change" }; },
        async runTurn(input) {
          const preferredDate = input.message === "Move it to tomorrow" ? "2026-08-24" : "2026-08-23";
          await input.executeTool("update_client_data", { patch: {
            cleaningType: "standard", areaM2: 75, rooms: 3, bathrooms: 2,
            heavyPetHair: false, extras: [], addressOrDistrict: "Vracar", preferredDate,
          } });
          await input.executeTool("calculate_quote", {});
          return { reply: "Quote ready.", toolResults: [], steps: 2 };
        },
      };

      await processTelegramWebhook(update(1201, "Book today"), { repository, telegram, agent });
      expect(repository.getLead(1001)).toMatchObject({
        clientData: { preferredDate: "2026-08-23", urgency: "same_day" },
        quote: { amountRsd: 7800, sameDayApplied: true },
      });

      await processTelegramWebhook(update(1202, "Move it to tomorrow"), { repository, telegram, agent });
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

  it("does not erase pet hair or extras on later messages and derives urgency from the date", async () => {
    const deps = dependencies();
    await processTelegramWebhook(
      update(30, "deep cleaning, 120 m2, same day 2026-08-24, heavy pet hair, windows and oven"),
      deps,
    );
    await processTelegramWebhook(update(31, "3 rooms, 2 bathrooms, district: Zemun"), deps);

    expect(deps.repository.getLead(1001)).toMatchObject({
      status: "qualified",
      clientData: {
          urgency: "same_day",
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
    expect(deps.telegram.messages[0]?.text).toContain("передам заявку нашей команде");
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
    expect(telegram.messages.at(-1)?.text).toContain("передам заявку нашей команде");
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
        await input.executeTool("request_available_slots", {});
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

    await expect(processTelegramWebhook(callback(873, "callback-persist-failure", callbackData), deps)).resolves.toEqual({
      kind: "failed",
      failureCode: "processing_error",
    });
    const leadAfterFailure = repository.getLead(1001);
    const token = callbackData.split(":").at(-1);
    if (!leadAfterFailure || !token) throw new Error("lead or token missing after persistence failure");
    expect(calendar.creates).toHaveLength(1);
    expect(leadAfterFailure.calendarEventId).toBeUndefined();
    expect(repository.slotTokens.get(token)?.consumedAt).toBeDefined();
    expect(repository.operations.get(`google_calendar:reservation:${leadAfterFailure.id}:${token}`)).toMatchObject({
      status: "succeeded",
      externalId: "fake-calendar-event-1",
    });

    await expect(processTelegramWebhook(callback(873, "callback-persist-failure", callbackData), deps)).resolves.toEqual({ kind: "processed" });
    expect(calendar.creates).toHaveLength(1);
    expect(repository.getLead(1001)).toMatchObject({ status: "qualified", calendarEventId: "fake-calendar-event-1" });
    expect(telegram.messages.at(-1)?.text).toContain("<b>Your time is confirmed.</b>");
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
    expect(deps.telegram.messages.at(-1)?.text).toBe("There isn’t a suitable free time in the next two weeks. Our team will help find an alternative.");
    expect(deps.repository.getLead(1001)).toMatchObject({
      status: "qualified",
      quoteValidity: "active",
      humanNeeded: true,
      humanNeededReason: "calendar_unavailable",
    });
    expect(deps.repository.activities).toContainEqual(expect.objectContaining({ eventType: "calendar_no_availability" }));
    await expect(deps.repository.listActiveCalendarSlotTokens({ leadId: deps.repository.getLead(1001)?.id ?? "missing", now: new Date().toISOString() })).resolves.toEqual([]);
    if (!oldCallback) throw new Error("first slot callback missing");
    await expect(processTelegramWebhook(callback(821, "callback-no-availability", oldCallback), deps)).resolves.toEqual({ kind: "processed" });
    expect(deps.calendar.creates).toHaveLength(0);
  });

  it("keeps an English named date through a full-calendar handoff and directly confirms a request for a person", async () => {
    const base = dependencies();
    const seenTools: string[][] = [];
    const deps = { ...base, agent: {
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
        return { reply: "I can help.", toolResults: [], steps: 0 };
      },
    } };
    const fullyBooked = [{ start: "2026-08-24T06:00:00.000Z", end: "2026-09-10T18:00:00.000Z" }];
    deps.calendar.busyByTeam = { team_a: fullyBooked, team_b: fullyBooked };

    await processTelegramWebhook(update(8220, "Standard cleaning, 75 m2, 3 rooms, one bathroom, no pet hair or extras, Vracar, August 26."), deps);
    expect(deps.repository.getLead(1001)).toMatchObject({ clientData: { preferredDate: "2026-08-26" }, quoteValidity: "active" });
    expect(deps.telegram.messages.at(-1)?.text).not.toContain("today");
    await processTelegramWebhook(update(8221, "Please show available times."), deps);
    expect(deps.repository.getLead(1001)).toMatchObject({ humanNeeded: true, humanNeededReason: "calendar_unavailable", clientData: { preferredDate: "2026-08-26" } });
    expect(deps.repository.activities.filter((activity) => activity.eventType === "calendar_no_availability")).toHaveLength(1);
    await processTelegramWebhook(update(8222, "Can someone help find another date?"), deps);

    expect(seenTools).toEqual([["update_client_data", "mark_human_needed", "calculate_quote"], []]);
    expect(deps.telegram.messages.at(-1)?.text).toContain("already been passed to our team");
    expect(deps.telegram.messages.at(-1)?.text).not.toMatch(/added|recorded/i);
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
      payload: { error_code: "calendar_slot_offer_persist_failed" },
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
    expect(telegram.messages.at(-1)?.text).toContain("передам заявку нашей команде");
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
});
