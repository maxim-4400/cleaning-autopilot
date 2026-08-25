import { describe, expect, it } from "vitest";

import { calendarIdForTeam, ComposioCalendarGateway, FakeCalendarGateway, parseComposioBusyIntervals } from "@/lib/calendar/gateway";
import { CalendarReservationService } from "@/lib/calendar/reservation-service";
import { InMemoryLeadRepository } from "@/lib/leads/in-memory-repository";
import { SchedulingEngine } from "@/lib/scheduling/engine";
import { renderNearestSlotAlternativesReply } from "@/lib/telegram/renderer";

const engine = new SchedulingEngine();
const now = new Date("2026-08-24T06:00:00.000Z"); // 08:00 Europe/Belgrade, Monday
const data = { cleaningType: "standard" as const, areaM2: 100, preferredDate: "2026-08-24", urgency: "standard" as const };

describe("SchedulingEngine", () => {
  it("calculates duration, buffer and the first three ordered slots", () => {
    expect(engine.durationMinutes(data)).toBe(240);
    const slots = engine.findSlots({ clientData: data, now, busyByTeam: { team_a: [], team_b: [] } });
    expect(slots).toHaveLength(3);
    expect(slots.map((slot) => [slot.team, slot.start, slot.end, slot.bufferEnd])).toEqual([
      ["team_a", "2026-08-24T06:00:00.000Z", "2026-08-24T10:00:00.000Z", "2026-08-24T10:30:00.000Z"],
      ["team_b", "2026-08-24T06:00:00.000Z", "2026-08-24T10:00:00.000Z", "2026-08-24T10:30:00.000Z"],
      ["team_a", "2026-08-24T06:30:00.000Z", "2026-08-24T10:30:00.000Z", "2026-08-24T11:00:00.000Z"],
    ]);
  });

  it("enforces Sunday closure, same-day two-hour lead time and end-of-day buffer", () => {
    const sundayRequest = engine.findSlots({ clientData: { ...data, preferredDate: "2026-08-23" }, now: new Date("2026-08-22T06:00:00.000Z"), busyByTeam: { team_a: [], team_b: [] } });
    expect(sundayRequest.every((slot) => !slot.start.startsWith("2026-08-23"))).toBe(true);
    const sameDay = engine.findSlots({ clientData: { ...data, urgency: "same_day" }, now: new Date("2026-08-24T08:10:00.000Z"), busyByTeam: { team_a: [], team_b: [] } });
    expect(sameDay[0]?.start).toBe("2026-08-24T10:30:00.000Z");
    expect(sameDay.every((slot) => new Date(slot.bufferEnd) <= new Date("2026-08-24T18:00:00.000Z"))).toBe(true);
  });

  it("does not offer past standard slots today and rejects work that cannot fit with its buffer", () => {
    const standardToday = engine.findSlots({ clientData: data, now: new Date("2026-08-24T12:10:00.000Z"), busyByTeam: { team_a: [], team_b: [] } });
    expect(standardToday.every((slot) => new Date(slot.start) >= new Date("2026-08-24T12:10:00.000Z"))).toBe(true);
    expect(engine.durationMinutes({ cleaningType: "deep", areaM2: 1 })).toBe(120);
    expect(() => engine.findSlots({ clientData: { ...data, cleaningType: "deep", areaM2: 200 }, now, busyByTeam: { team_a: [], team_b: [] } }))
      .toThrow("cleaning_duration_exceeds_workday");
  });

  it("filters a fresh offer by the requested Belgrade time window before taking three options", () => {
    const midday = engine.findSlots({ clientData: { ...data, preferredTimeWindow: "midday" }, now, busyByTeam: { team_a: [], team_b: [] } });
    expect(midday).toHaveLength(3);
    expect(midday.every((slot) => new Date(slot.start).getUTCHours() >= 10 && new Date(slot.start).getUTCHours() < 14)).toBe(true); // 12:00–15:59 Belgrade in CEST
    const evening = engine.findSlots({ clientData: { ...data, preferredTimeWindow: "evening" }, now, busyByTeam: { team_a: [], team_b: [] } });
    expect(evening.every((slot) => new Date(slot.start).getUTCHours() >= 14 && new Date(slot.start).getUTCHours() < 18)).toBe(true);
  });
});

describe("Composio Calendar response contract", () => {
  it("routes each team only to its exact configured calendar and refuses a primary fallback", () => {
    const environment = { teamACalendarId: "team-a@group.calendar.google.com", teamBCalendarId: "team-b@group.calendar.google.com" };
    expect(calendarIdForTeam(environment, "team_a")).toBe("team-a@group.calendar.google.com");
    expect(calendarIdForTeam(environment, "team_b")).toBe("team-b@group.calendar.google.com");
    expect(() => calendarIdForTeam({ ...environment, teamACalendarId: "primary" }, "team_a")).toThrow("Exact dedicated Team");
    expect(() => calendarIdForTeam({ ...environment, teamBCalendarId: " " }, "team_b")).toThrow("Exact dedicated Team");
    expect(() => calendarIdForTeam({ ...environment, teamACalendarId: "owner@example.com" }, "team_a")).toThrow("Exact dedicated Team");
    expect(() => calendarIdForTeam({ ...environment, teamBCalendarId: environment.teamACalendarId }, "team_b")).toThrow("Exact dedicated Team");
  });

  it("sends a Team A or Team B reservation only to that exact calendar ID", async () => {
    const gateway = new ComposioCalendarGateway({ apiKey: "x", userId: "user", connectedAccountId: "account", toolkitVersion: "202608_01", teamACalendarId: "team-a@group.calendar.google.com", teamBCalendarId: "team-b@group.calendar.google.com" });
    const calls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
    (gateway as unknown as { composio: { tools: { execute: (tool: string, input: { arguments: Record<string, unknown> }) => Promise<unknown> } } }).composio = { tools: { execute: async (tool, input) => { calls.push({ tool, arguments: input.arguments }); return { successful: true, data: { response_data: { id: `event-${calls.length}` } } }; } } };
    await gateway.createEvent({ team: "team_a", start: "2026-08-24T08:00:00.000Z", end: "2026-08-24T09:00:00.000Z", leadId: "lead-a", idempotencyKey: "key-a" });
    await gateway.createEvent({ team: "team_b", start: "2026-08-24T10:00:00.000Z", end: "2026-08-24T11:00:00.000Z", leadId: "lead-b", idempotencyKey: "key-b" });
    expect(calls.map((call) => call.arguments.calendar_id)).toEqual(["team-a@group.calendar.google.com", "team-b@group.calendar.google.com"]);
    expect(calls.flatMap((call) => Object.values(call.arguments))).not.toContain("primary");
    expect(calls.map((call) => ({ attendees: call.arguments.attendees, sendUpdates: call.arguments.send_updates, excludeOrganizer: call.arguments.exclude_organizer }))).toEqual([
      { attendees: [], sendUpdates: "none", excludeOrganizer: true },
      { attendees: [], sendUpdates: "none", excludeOrganizer: true },
    ]);
  });

  it("sends the agreed Europe/Belgrade wall-clock slot to the Calendar create action", async () => {
    const gateway = new ComposioCalendarGateway({ apiKey: "x", userId: "user", connectedAccountId: "account", toolkitVersion: "202608_01", teamACalendarId: "team-a@group.calendar.google.com", teamBCalendarId: "team-b@group.calendar.google.com" });
    const calls: Array<{ arguments: Record<string, unknown> }> = [];
    (gateway as unknown as { composio: { tools: { execute: (_tool: string, input: { arguments: Record<string, unknown> }) => Promise<unknown> } } }).composio = {
      tools: { execute: async (_tool, input) => { calls.push({ arguments: input.arguments }); return { successful: true, data: { response_data: { id: "event" } } }; } },
    };

    // 08:00 CEST is stored as 06:00Z. The create tool must receive 08:00
    // alongside the explicit Europe/Belgrade timezone, not the UTC value.
    await gateway.createEvent({ team: "team_b", start: "2026-08-26T06:00:00.000Z", end: "2026-08-26T09:00:00.000Z", leadId: "lead", idempotencyKey: "key" });
    expect(calls[0]?.arguments).toMatchObject({
      calendar_id: "team-b@group.calendar.google.com",
      start_datetime: "2026-08-26T08:00:00",
      end_datetime: "2026-08-26T11:00:00",
      timezone: "Europe/Belgrade",
    });

    // Winter uses CET rather than CEST; conversion must remain correct across DST.
    await gateway.createEvent({ team: "team_a", start: "2026-01-14T07:00:00.000Z", end: "2026-01-14T10:00:00.000Z", leadId: "winter", idempotencyKey: "winter-key" });
    expect(calls[1]?.arguments).toMatchObject({
      start_datetime: "2026-01-14T08:00:00",
      end_datetime: "2026-01-14T11:00:00",
      timezone: "Europe/Belgrade",
    });
  });

  it("fails closed before Calendar transport when a team mapping is invalid", async () => {
    const gateway = new ComposioCalendarGateway({ apiKey: "x", userId: "user", connectedAccountId: "account", toolkitVersion: "202608_01", teamACalendarId: "primary", teamBCalendarId: "team-b@group.calendar.google.com" });
    await expect(gateway.createEvent({ team: "team_a", start: "2026-08-24T08:00:00.000Z", end: "2026-08-24T09:00:00.000Z", leadId: "lead", idempotencyKey: "key" }))
      .resolves.toEqual({ kind: "failed", code: "calendar_team_not_configured", ambiguous: false });
  });

  it("accepts only the pinned free/busy response envelope and fails closed otherwise", () => {
    expect(parseComposioBusyIntervals({
      successful: true,
      data: { calendars: { calendar_a: { busy: [{ start: "2026-08-24T08:00:00+02:00", end: "2026-08-24T09:00:00+02:00" }], free: [] } } },
    }, "calendar_a")).toEqual([{ start: "2026-08-24T08:00:00+02:00", end: "2026-08-24T09:00:00+02:00" }]);
    expect(() => parseComposioBusyIntervals({
      successful: true,
      data: { calendars: { calendar_a: { busy: [] } } },
    }, "calendar_a")).toThrow(/free\/busy schema/);
    expect(() => parseComposioBusyIntervals({ successful: true, data: { response_data: {} } }, "calendar_a")).toThrow(/free\/busy schema/);
  });
});

describe("CalendarReservationService", () => {
  it("queries availability from the preferred date through the exact 14-day horizon", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await repository.createLead({ telegramChatId: 4, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified"; lead.quoteValidity = "active";
    lead.quote = { amountRsd: 8000, baseRsd: 8000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { ...data, preferredDate: "2026-09-10", rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar" };
    await expect(service.offerSlots(lead, "en")).resolves.toMatchObject({ ok: true });
    expect(calendar.availabilityQueries).toEqual([
      { team: "team_a", from: "2026-09-10T00:00:00.000Z", to: "2026-09-24T00:00:00.000Z" },
      { team: "team_b", from: "2026-09-10T00:00:00.000Z", to: "2026-09-24T00:00:00.000Z" },
    ]);
  });

  it("formats Calendar slot labels in the current Serbian script instead of the lead history", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await qualifiedLead(repository, 14);
    lead.firstMessageLanguage = "ru";

    const latin = await service.offerSlots(lead, "sr-Latn");
    if (!latin.ok) throw new Error(latin.error);
    expect(latin.slots[0]?.label).toContain("Tim A");
    expect(latin.slots[0]?.label).toMatch(/pon|avg/i);
    const cyrillic = await service.offerSlots(lead, "sr-Cyrl");
    if (!cyrillic.ok) throw new Error(cyrillic.error);
    expect(cyrillic.slots[0]?.label).toContain("Тим А");
    expect(cyrillic.slots[0]?.label).toMatch(/[А-Яа-я]/u);
  });

  it("consumes a token once, rechecks busy time and never creates a second event", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await repository.createLead({ telegramChatId: 5, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified";
    lead.quote = { amountRsd: 8000, baseRsd: 8000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.quoteValidity = "active";
    lead.clientData = { ...data, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar" };
    const offered = await service.offerSlots(lead, "en");
    if (!offered.ok) throw new Error(offered.error);
    const token = offered.slots[0].token;
    await expect(service.reserveSlot(lead, token)).resolves.toMatchObject({ ok: true, eventId: "fake-calendar-event-1" });
    await expect(service.reserveSlot(lead, token)).resolves.toMatchObject({ ok: true, eventId: "fake-calendar-event-1" });
    expect(calendar.creates).toHaveLength(1);
    expect(calendar.creates[0]).toMatchObject({ end: offered.slots[0].bufferEnd });
    expect(lead.bookedEnd).toBe(offered.slots[0].end);
  });

  it("keeps a durable Calendar reservation successful when the optional Trello acceleration fails", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await qualifiedLead(repository, 501);
    const offered = await service.offerSlots(lead, "en");
    if (!offered.ok) throw new Error(offered.error);
    repository.accelerateTrelloSyncJob = async () => { throw new Error("simulated acceleration RPC failure"); };

    await expect(service.reserveSlot(lead, offered.slots[0]!.token)).resolves.toMatchObject({ ok: true, eventId: "fake-calendar-event-1" });
    expect(lead.calendarEventId).toBe("fake-calendar-event-1");
    expect(repository.trelloSyncJobs.get(lead.id)).toMatchObject({ desiredLifecycle: "booked", state: "pending" });
  });

  it("invalidates an earlier offer when a requested time window changes", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await qualifiedLead(repository, 78);
    const offer = await service.offerSlots(lead, "en");
    if (!offer.ok) throw new Error(offer.error);
    lead.clientData = { ...lead.clientData, preferredTimeWindow: "evening" };

    await expect(service.reserveSlot(lead, offer.slots[0].token)).resolves.toMatchObject({ ok: false, error: "slot_token_stale" });
    expect(calendar.creates).toHaveLength(0);
  });

  it("ranks relaxed after-19 alternatives nearest to 19:00 from the same busy snapshot", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await qualifiedLead(repository, 79);
    lead.clientData = { ...lead.clientData, preferredTimeWindow: "evening" };

    const offer = await service.offerSlots(lead, "en", { minimumLocalStartMinutes: 19 * 60, supersedeExisting: true });
    if (!offer.ok) throw new Error(offer.error);
    expect(offer.match).toBe("nearest_alternatives");
    // A 4h clean + buffer cannot start at 19:00. The closest real option is
    // 15:30 Belgrade (13:30Z), not an unrelated morning slot.
    expect(offer.slots.map((slot) => slot.start)).toEqual([
      "2026-08-24T13:30:00.000Z",
      "2026-08-24T13:30:00.000Z",
      "2026-08-25T13:30:00.000Z",
    ]);
    expect(calendar.availabilityQueries).toHaveLength(2);
  });

  it("does not create an event when the recheck reports a conflict", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await repository.createLead({ telegramChatId: 6, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified"; lead.quoteValidity = "active";
    lead.quote = { amountRsd: 8000, baseRsd: 8000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { ...data, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar" };
    const offered = await service.offerSlots(lead, "en"); if (!offered.ok) throw new Error(offered.error);
    calendar.busyByTeam[offered.slots[0].team] = [{ start: offered.slots[0].start, end: offered.slots[0].end }];
    await expect(service.reserveSlot(lead, offered.slots[0].token)).resolves.toMatchObject({ ok: false, error: "slot_no_longer_available" });
    expect(calendar.creates).toHaveLength(0);
  });

  it("records a failed or ambiguous create without retrying it", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await repository.createLead({ telegramChatId: 7, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified"; lead.quoteValidity = "active";
    lead.quote = { amountRsd: 8000, baseRsd: 8000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { ...data, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar" };
    const offered = await service.offerSlots(lead, "en"); if (!offered.ok) throw new Error(offered.error);
    calendar.nextCreateResult = { kind: "failed", code: "calendar_timeout", ambiguous: true };
    await expect(service.reserveSlot(lead, offered.slots[0].token)).resolves.toMatchObject({ ok: false, ambiguous: true });
    await expect(service.reserveSlot(lead, offered.slots[0].token)).resolves.toMatchObject({ ok: false });
    expect(calendar.creates).toHaveLength(1);
  });

  it("recovers the existing event after persistence fails without creating a second one", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await repository.createLead({ telegramChatId: 8, firstMessageLanguage: "en", agentConfigVersion: 5 });
    lead.status = "qualified"; lead.quoteValidity = "active";
    lead.quote = { amountRsd: 8000, baseRsd: 8000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
    lead.clientData = { ...data, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar" };
    const offered = await service.offerSlots(lead, "en"); if (!offered.ok) throw new Error(offered.error);
    const originalSave = repository.saveLead.bind(repository);
    let failOnce = true;
    repository.saveLead = async (savedLead) => {
      if (failOnce && savedLead.calendarEventId) { failOnce = false; throw new Error("simulated persistence crash"); }
      await originalSave(savedLead);
    };
    await expect(service.reserveSlot(lead, offered.slots[0].token)).rejects.toThrow("simulated persistence crash");
    const recoveredLead = {
      ...lead,
      assignedTeam: undefined,
      bookedStart: undefined,
      bookedEnd: undefined,
      calendarEventId: undefined,
    };
    await expect(service.reserveSlot(recoveredLead, offered.slots[0].token)).resolves.toMatchObject({ ok: true, eventId: "fake-calendar-event-1" });
    expect(calendar.creates).toHaveLength(1);
  });

  it("fails closed on Calendar availability transport failures", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    calendar.getBusyIntervals = async () => { throw new Error("simulated Composio transport failure"); };
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await qualifiedLead(repository, 9);
    await expect(service.offerSlots(lead, "en")).resolves.toEqual({ ok: false, error: "calendar_availability_failed" });
  });

  it("fails closed when persisting an offer fails instead of exposing a tool-argument error", async () => {
    const repository = new InMemoryLeadRepository();
    repository.saveCalendarSlotOffer = async () => { throw new Error("simulated slot-offer RPC failure"); };
    const service = new CalendarReservationService(repository, new FakeCalendarGateway(), engine, () => now);
    const lead = await qualifiedLead(repository, 91);

    await expect(service.offerSlots(lead, "en")).resolves.toEqual({ ok: false, error: "calendar_slot_offer_persist_failed" });
  });

  it("fails closed when the pre-create Calendar recheck cannot be read", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await qualifiedLead(repository, 92);
    const offered = await service.offerSlots(lead, "en"); if (!offered.ok) throw new Error(offered.error);
    calendar.getBusyIntervals = async () => { throw new Error("simulated recheck transport failure"); };

    await expect(service.reserveSlot(lead, offered.slots[0].token))
      .resolves.toEqual({ ok: false, error: "calendar_availability_failed" });
    expect(calendar.creates).toHaveLength(0);
    expect(repository.operations.get(`google_calendar:reservation:${lead.id}:${offered.slots[0].token}`)?.status).toBe("failed");
  });

  it("does not create an operation or event from an expired consumed token", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    let currentNow = now;
    const service = new CalendarReservationService(repository, calendar, engine, () => currentNow);
    const lead = await qualifiedLead(repository, 10);
    const offered = await service.offerSlots(lead, "en"); if (!offered.ok) throw new Error(offered.error);
    const token = offered.slots[0].token;
    currentNow = new Date(now.getTime() + 31 * 60_000);
    await expect(service.reserveSlot(lead, token)).resolves.toEqual({ ok: false, error: "slot_token_invalid_or_expired" });
    expect(calendar.creates).toHaveLength(0);
    expect(repository.operations).toHaveLength(0);
  });

  it("rejects a token after schedule-defining inputs change", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await qualifiedLead(repository, 11);
    const offered = await service.offerSlots(lead, "en"); if (!offered.ok) throw new Error(offered.error);
    lead.clientData = { ...lead.clientData, preferredDate: "2026-08-25" };
    await expect(service.reserveSlot(lead, offered.slots[0].token)).resolves.toEqual({ ok: false, error: "slot_token_stale" });
    expect(calendar.creates).toHaveLength(0);
  });

  it("keeps only the newest deterministic offer active and rejects an earlier option", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await qualifiedLead(repository, 12);
    const first = await service.offerSlots(lead, "en"); if (!first.ok) throw new Error(first.error);
    const second = await service.offerSlots(lead, "en"); if (!second.ok) throw new Error(second.error);

    const active = await repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: now.toISOString() });
    expect(active.map((slot) => [slot.displayOrder, slot.team])).toEqual([[1, "team_a"], [2, "team_b"], [3, "team_a"]]);
    await expect(service.reserveSlot(lead, first.slots[0].token)).resolves.toEqual({ ok: false, error: "slot_offer_superseded" });
    await expect(service.reserveSlot(lead, second.slots[1].token)).resolves.toMatchObject({ ok: true, eventId: "fake-calendar-event-1" });
    expect(calendar.creates).toHaveLength(1);
  });

  it("supersedes a previous offer when no slots remain and does not leave it selectable", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await qualifiedLead(repository, 13);
    const first = await service.offerSlots(lead, "en"); if (!first.ok) throw new Error(first.error);
    const allHorizonBusy = [{ start: "2026-08-24T00:00:00.000Z", end: "2026-09-08T00:00:00.000Z" }];
    calendar.busyByTeam = { team_a: allHorizonBusy, team_b: allHorizonBusy };

    await expect(service.offerSlots(lead, "en")).resolves.toEqual({ ok: false, error: "no_available_slots", availabilityReason: "requested_date_unavailable" });
    await expect(repository.listActiveCalendarSlotTokens({ leadId: lead.id, now: now.toISOString() })).resolves.toEqual([]);
    await expect(service.reserveSlot(lead, first.slots[0].token)).resolves.toEqual({ ok: false, error: "slot_offer_superseded" });
  });

  it("labels a fully busy requested weekday as date-unavailable while offering the next real day", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await qualifiedLead(repository, 131);
    // 08:00–20:00 Belgrade on the requested Monday. Tuesday remains free.
    const requestedDayBusy = [{ start: "2026-08-24T06:00:00.000Z", end: "2026-08-24T18:00:00.000Z" }];
    calendar.busyByTeam = { team_a: requestedDayBusy, team_b: requestedDayBusy };

    const offer = await service.offerSlots(lead, "en");

    expect(offer).toMatchObject({ ok: true, match: "nearest_alternatives", availabilityReason: "requested_date_unavailable" });
    if (!offer.ok) throw new Error(offer.error);
    expect(offer.slots.every((slot) => slot.start.startsWith("2026-08-25"))).toBe(true);
  });

  it("labels a requested evening as time-unavailable when the day still has earlier free time", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await qualifiedLead(repository, 133);
    lead.clientData = {
      ...lead.clientData,
      areaM2: 25,
      preferredDate: "2026-08-25",
      preferredTimeWindow: "evening",
    };
    // The requested Tuesday still has morning and midday capacity, but both
    // teams are busy throughout the requested evening. Wednesday evening is
    // genuinely free, so it is an alternative to the time, not the date.
    const requestedEveningBusy = [{ start: "2026-08-25T14:00:00.000Z", end: "2026-08-25T18:00:00.000Z" }];
    calendar.busyByTeam = { team_a: requestedEveningBusy, team_b: requestedEveningBusy };

    const offer = await service.offerSlots(lead, "ru");

    expect(offer).toMatchObject({ ok: true, match: "nearest_alternatives", availabilityReason: "requested_time_unavailable" });
    if (!offer.ok) throw new Error(offer.error);
    expect(offer.slots.every((slot) => slot.start.startsWith("2026-08-26"))).toBe(true);
    expect(renderNearestSlotAlternativesReply("ru", offer.slots, "requested_time_unavailable").text)
      .toContain("В указанное время свободных слотов нет");
  });

  it("keeps a partially free requested weekday as an exact offer", async () => {
    const repository = new InMemoryLeadRepository();
    const calendar = new FakeCalendarGateway();
    const service = new CalendarReservationService(repository, calendar, engine, () => now);
    const lead = await qualifiedLead(repository, 132);
    // Leave the afternoon free on the requested Monday.
    const morningBusy = [{ start: "2026-08-24T06:00:00.000Z", end: "2026-08-24T12:00:00.000Z" }];
    calendar.busyByTeam = { team_a: morningBusy, team_b: morningBusy };

    const offer = await service.offerSlots(lead, "en");

    expect(offer).toMatchObject({ ok: true, match: "exact", availabilityReason: "exact" });
    if (!offer.ok) throw new Error(offer.error);
    expect(offer.slots.every((slot) => slot.start.startsWith("2026-08-24"))).toBe(true);
  });
});

async function qualifiedLead(repository: InMemoryLeadRepository, telegramChatId: number) {
  const lead = await repository.createLead({ telegramChatId, firstMessageLanguage: "en", agentConfigVersion: 5 });
  lead.status = "qualified";
  lead.quoteValidity = "active";
  lead.quote = { amountRsd: 8000, baseRsd: 8000, volumeDiscountPercent: 0, bathroomSurchargeRsd: 0, petHairSurchargeRsd: 0, extrasSurchargeRsd: 0, sameDayApplied: false, pricingRulesVersion: 1 };
  lead.clientData = { ...data, rooms: 3, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Vracar" };
  return lead;
}
