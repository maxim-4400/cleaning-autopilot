import type { AgentToolName, SchedulingSemanticAction } from "@/lib/contracts/domain";

/**
 * Synthetic-only customer messages for the explicitly approved live-model
 * evaluator. They carry no real contact data. The scenario manifest is fixed:
 * six longer conversations exercise continuity, and fourteen focused ones
 * isolate specific behavioural boundaries.
 */
export const requiredLiveConversationScenarioCount = 20 as const;
export const requiredSmokeScenarioShape = [
  ["ru-price-no-booking", 8],
  ["ru-correction-date-booking", 8],
  ["ru-conversational-availability", 8],
  ["ru-renovation-human", 4],
  ["sr-latn-booking", 3],
] as const;

type SafeAvailabilityAttemptExpectation = {
  result: "exact_offer" | "fallback_offer" | "no_slots" | "failure";
  candidateDate: string;
  timePreference: "any" | "morning" | "midday" | "evening" | "after" | "before" | "range";
  timePreferenceMode: "preserve" | "explicit";
  afterLocalTime?: string;
  beforeLocalTime?: string;
  relation: "fresh" | "later_than_last_offer";
};

export type LiveConversationScenario = {
  id: string;
  customerMessages: readonly string[];
  /** Strict cap for model turns in this scenario; transport fast paths may use fewer. */
  agentTurnLimit: number;
  /** Deterministic fake-calendar setup only; it never reaches an external provider. */
  sandbox?: {
    /** Per-scenario synthetic wall clock, always an ISO instant. */
    now?: string;
    calendarFullyBooked?: boolean;
    calendarTransportFails?: boolean;
    evening90m2Slot?: boolean;
  };
  expected: {
    hasQuote: boolean;
    humanNeeded: boolean;
    fakeCalendarCreates: number;
    slotOffer: boolean;
  };
  /** Exact post-message invariants for acceptance-critical smoke fixtures. */
  checkpointExpectations?: Array<undefined | {
    quoteAmountRsd?: number;
    quoteState?: "active" | "superseded" | "none";
    preferredDate?: string;
    preferredTimeWindow?: "morning" | "midday" | "evening";
    /** Proves an explicit `any` cleared an earlier durable time window. */
    preferredTimeWindowAbsent?: boolean;
    /** Ensures an incidental time word has not fabricated a booking date. */
    preferredDateAbsent?: boolean;
    humanNeeded?: boolean;
    humanNeededReason?: string;
    calendarCreates?: number;
    calendarAvailabilityQueries?: number;
    slotOfferCount?: number;
    /** Sorted active fake-slot starts; intentionally contains no token IDs. */
    activeSlotStarts?: string[];
    /** Safe durable availability attempt evidence; no IDs, payloads or customer text. */
    lastAvailabilityAttempt?: SafeAvailabilityAttemptExpectation;
    /** Exact safe attempt variants accepted for a bounded provider wording variant. */
    lastAvailabilityAttemptOneOf?: SafeAvailabilityAttemptExpectation[];
    semanticTools?: AgentToolName[];
    schedulingActions?: SchedulingSemanticAction[];
    /** Exact ordered scheduling decisions accepted for a bounded semantic variant. */
    schedulingActionsOneOf?: SchedulingSemanticAction[][];
    /** A date-only active-quote turn may only save a fact, or need no SDK tool. */
    semanticToolsOneOf?: AgentToolName[][];
    visibleIncludes?: string[];
    visibleDifferentFromPrevious?: boolean;
  }>;
  /** Exact semantic calls permitted across the whole scenario. */
  requiredToolCounts?: Partial<Record<AgentToolName, number>>;
};

const expectation = (
  overrides: Partial<LiveConversationScenario["expected"]> = {},
): LiveConversationScenario["expected"] => ({
  hasQuote: false,
  humanNeeded: false,
  fakeCalendarCreates: 0,
  slotOffer: false,
  ...overrides,
});

export const liveConversationScenarios: readonly LiveConversationScenario[] = [
  // Long, progressive conversations. Every customer message adds, corrects or
  // narrows useful information; none is filler.
  { id: "ru-price-no-booking", customerMessages: ["Привет, что вы умеете?", "Можно сначала узнать цену?", "Квартира в Врачаре, 50 м².", "Обычная уборка.", "Две комнаты.", "Один санузел.", "Кота нет.", "Без допуслуг."], agentTurnLimit: 8, expected: expectation({ hasQuote: true }), checkpointExpectations: [undefined, undefined, undefined, undefined, undefined, undefined, undefined, { quoteAmountRsd: 4_000, quoteState: "active", humanNeeded: false, calendarCreates: 0, slotOfferCount: 0 }] },
  { id: "ru-correction-date-booking", customerMessages: ["Нужна обычная уборка 50 м² в Врачаре.", "Две комнаты, один санузел, без шерсти и допуслуг.", "Сколько получится?", "Стоп, площадь 90 м².", "Через два дня.", "А вечером есть?", "1", "Спасибо, жду."], agentTurnLimit: 8, sandbox: { evening90m2Slot: true }, expected: expectation({ hasQuote: true, slotOffer: true, fakeCalendarCreates: 1 }), checkpointExpectations: [{ quoteState: "none", calendarCreates: 0, slotOfferCount: 0 }, { quoteAmountRsd: 4_000, quoteState: "active", calendarCreates: 0, slotOfferCount: 0 }, { quoteAmountRsd: 4_000, quoteState: "active", calendarCreates: 0, slotOfferCount: 0 }, { quoteAmountRsd: 7_200, quoteState: "active", calendarCreates: 0, slotOfferCount: 0 }, { quoteAmountRsd: 7_200, quoteState: "active", preferredDate: "2026-08-26", preferredTimeWindowAbsent: true, humanNeeded: false, calendarCreates: 0, calendarAvailabilityQueries: 2, slotOfferCount: 1, semanticToolsOneOf: [["request_available_slots"], ["update_client_data", "request_available_slots"]], schedulingActionsOneOf: [[{ kind: "availability", dateReference: "exact_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "none" }], [{ kind: "availability", dateReference: "exact_date", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "none" }]] }, { quoteAmountRsd: 7_200, quoteState: "active", preferredDate: "2026-08-26", calendarCreates: 0, calendarAvailabilityQueries: 4, slotOfferCount: 2, semanticTools: ["request_available_slots"], schedulingActions: [{ kind: "availability", dateReference: "current_preferred_date", timePreference: "evening", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "retain_until_replacement" }] }, { quoteAmountRsd: 7_200, quoteState: "active", preferredDate: "2026-08-26", calendarCreates: 1, calendarAvailabilityQueries: 5, slotOfferCount: 2, semanticTools: [], visibleIncludes: ["26 августа", "Команда А", "7 200 RSD"] }, { quoteAmountRsd: 7_200, quoteState: "active", preferredDate: "2026-08-26", calendarCreates: 1, calendarAvailabilityQueries: 5, slotOfferCount: 2, semanticTools: [], visibleIncludes: ["уже зарезервировано"] }] },
  { id: "ru-conversational-availability", customerMessages: ["Хочу уборку квартиры.", "Обычная, 75 м², Врачар.", "Три комнаты.", "Один санузел.", "Без шерсти и допуслуг, 26 августа.", "А в середине дня есть?", "А вечером?", "2"], agentTurnLimit: 8, expected: expectation({ hasQuote: true, slotOffer: true, fakeCalendarCreates: 1 }), checkpointExpectations: [undefined, undefined, undefined, undefined, undefined, { quoteAmountRsd: 6_000, quoteState: "active", preferredDate: "2026-08-26", calendarCreates: 0, calendarAvailabilityQueries: 2, slotOfferCount: 1, semanticTools: ["request_available_slots"], schedulingActions: [{ kind: "availability", dateReference: "current_preferred_date", timePreference: "midday", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "none" }] }, { quoteAmountRsd: 6_000, quoteState: "active", preferredDate: "2026-08-26", calendarCreates: 0, calendarAvailabilityQueries: 4, slotOfferCount: 2, semanticTools: ["request_available_slots"], schedulingActions: [{ kind: "availability", dateReference: "current_preferred_date", timePreference: "evening", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "retain_until_replacement" }] }, { semanticTools: [], calendarCreates: 1, calendarAvailabilityQueries: 5, visibleIncludes: ["26 августа", "16:00", "Команда Б", "6 000 RSD"] }] },
  { id: "ru-renovation-human", customerMessages: ["Нужна уборка после ремонта, 80 м², Врачар.", "Три комнаты и два санузла.", "На 26 августа, и нужны окна.", "Можете передать человеку?"], agentTurnLimit: 4, expected: expectation({ humanNeeded: true }), requiredToolCounts: { mark_human_needed: 1 }, checkpointExpectations: [{ humanNeeded: true, humanNeededReason: "after_renovation" }, { humanNeeded: true, semanticToolsOneOf: [[], ["update_client_data"]], visibleDifferentFromPrevious: true }, { humanNeeded: true, preferredDate: "2026-08-26", semanticToolsOneOf: [[], ["update_client_data"]], visibleDifferentFromPrevious: true }, { humanNeeded: true, semanticTools: [], visibleIncludes: ["уже передали команде"] }] },
  { id: "sr-latn-booking", customerMessages: ["Treba mi standardno čišćenje stana od 70 m2 u Zemunu, dve sobe, jedno kupatilo, bez dlaka i dodataka, 26. avgusta.", "Pokaži slobodne termine.", "2"], agentTurnLimit: 3, expected: expectation({ hasQuote: true, slotOffer: true, fakeCalendarCreates: 1 }), checkpointExpectations: [{ quoteAmountRsd: 5_600, quoteState: "active", preferredDate: "2026-08-26", humanNeeded: false }, { preferredTimeWindowAbsent: true, semanticToolsOneOf: [["request_available_slots"], ["update_client_data", "request_available_slots"]], schedulingActionsOneOf: [[{ kind: "availability", dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "none" }], [{ kind: "availability", dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "none" }]], calendarCreates: 0, calendarAvailabilityQueries: 2, slotOfferCount: 1 }, { semanticTools: [], calendarCreates: 1, calendarAvailabilityQueries: 3, visibleIncludes: ["26. avgust", "08:00", "Tim B", "5.600 RSD"] }] },
  { id: "en-explore-correction-no-booking", customerMessages: ["What can you help with?", "Can I get a price before I choose a time?", "It is a 40 m2 flat in Dorcol.", "Standard cleaning.", "One room, one bathroom, no pet hair or extras, 26 August.", "Actually it is 55 m2.", "Why did the price change?", "What about between 10:00 and 16:00?"], agentTurnLimit: 8, expected: expectation({ hasQuote: true, slotOffer: true }), checkpointExpectations: [undefined, undefined, undefined, undefined, undefined, { quoteAmountRsd: 4_400, quoteState: "active", humanNeeded: false, calendarCreates: 0, slotOfferCount: 0, semanticToolsOneOf: [["update_client_data", "calculate_quote"], ["update_client_data", "calculate_quote", "record_scheduling_decision"]], schedulingActionsOneOf: [[], [{ kind: "no_calendar", reason: "question_not_about_scheduling" }]], visibleIncludes: ["4,400 RSD"] }, undefined, { quoteAmountRsd: 4_400, quoteState: "active", calendarCreates: 0, calendarAvailabilityQueries: 2, slotOfferCount: 1, activeSlotStarts: ["2026-08-26T08:00:00.000Z", "2026-08-26T08:00:00.000Z", "2026-08-26T08:30:00.000Z"], semanticTools: ["request_available_slots"], schedulingActions: [{ kind: "availability", dateReference: "current_preferred_date", timePreference: "range", timePreferenceMode: "explicit", afterLocalTime: "10:00", beforeLocalTime: "16:00", relation: "fresh", existingOfferDisposition: "none" }] }] },

  // Focused scenarios.
  { id: "calendar-fully-booked", customerMessages: ["Standard 75 m2, 3 rooms, one bathroom, no pet hair or extras, Vracar, 26 August.", "Please show available times.", "What is the nearest day with a slot?"], agentTurnLimit: 3, sandbox: { calendarFullyBooked: true }, expected: expectation({ hasQuote: true, slotOffer: false }), checkpointExpectations: [{ quoteAmountRsd: 6_000, quoteState: "active", preferredDate: "2026-08-26", humanNeeded: false }, { quoteAmountRsd: 6_000, quoteState: "active", preferredDate: "2026-08-26", preferredTimeWindowAbsent: true, humanNeeded: false, calendarAvailabilityQueries: 2, slotOfferCount: 0, lastAvailabilityAttemptOneOf: [{ result: "no_slots", candidateDate: "2026-08-26", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" }, { result: "no_slots", candidateDate: "2026-08-26", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh" }], semanticToolsOneOf: [["request_available_slots"], ["update_client_data", "request_available_slots"]], schedulingActionsOneOf: [[{ kind: "availability", dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "none" }], [{ kind: "availability", dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "none" }]] }, { quoteAmountRsd: 6_000, quoteState: "active", preferredDate: "2026-08-26", preferredTimeWindowAbsent: true, humanNeeded: false, calendarAvailabilityQueries: 4, slotOfferCount: 0, lastAvailabilityAttemptOneOf: [{ result: "no_slots", candidateDate: "2026-08-26", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh" }, { result: "no_slots", candidateDate: "2026-08-26", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh" }], semanticToolsOneOf: [["request_available_slots"], ["update_client_data", "request_available_slots"]], schedulingActionsOneOf: [[{ kind: "availability", dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "none" }], [{ kind: "availability", dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "none" }], [{ kind: "availability", dateReference: "exact_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "none" }], [{ kind: "availability", dateReference: "exact_date", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "none" }]], visibleIncludes: ["There are no free slots"] }] },
  { id: "date-preserve-vs-any", customerMessages: ["Standard 75 m2, three rooms, one bathroom, no pet hair or extras, Vracar, 26 August, evening.", "Tomorrow.", "Tomorrow any time.", "None of those. Anything later on the same day?"], agentTurnLimit: 4, expected: expectation({ hasQuote: true, slotOffer: true }), checkpointExpectations: [{ quoteAmountRsd: 6_000, quoteState: "active", preferredDate: "2026-08-26", preferredTimeWindow: "evening", calendarCreates: 0, slotOfferCount: 0 }, { quoteAmountRsd: 6_000, quoteState: "active", preferredDate: "2026-08-25", preferredTimeWindow: "evening", calendarCreates: 0, calendarAvailabilityQueries: 2, slotOfferCount: 1, semanticToolsOneOf: [["request_available_slots"], ["update_client_data", "request_available_slots"]], schedulingActionsOneOf: [[{ kind: "availability", dateReference: "tomorrow", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "none" }], [{ kind: "availability", dateReference: "tomorrow", timePreference: "evening", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "none" }]] }, { quoteAmountRsd: 6_000, quoteState: "active", preferredDate: "2026-08-25", preferredTimeWindowAbsent: true, calendarCreates: 0, calendarAvailabilityQueries: 4, slotOfferCount: 2, semanticToolsOneOf: [["request_available_slots"], ["update_client_data", "request_available_slots"]], schedulingActions: [{ kind: "availability", dateReference: "tomorrow", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "retain_until_replacement" }] }, { quoteAmountRsd: 6_000, quoteState: "active", preferredDate: "2026-08-25", preferredTimeWindowAbsent: true, calendarCreates: 0, calendarAvailabilityQueries: 6, slotOfferCount: 3, activeSlotStarts: ["2026-08-25T07:00:00.000Z", "2026-08-25T07:00:00.000Z", "2026-08-25T07:30:00.000Z"], semanticTools: ["request_available_slots"], schedulingActionsOneOf: [[{ kind: "availability", dateReference: "same_day_as_last_offer", timePreference: "any", timePreferenceMode: "preserve", relation: "later_than_last_offer", existingOfferDisposition: "reject_now" }], [{ kind: "availability", dateReference: "same_day_as_last_offer", timePreference: "any", timePreferenceMode: "explicit", relation: "later_than_last_offer", existingOfferDisposition: "reject_now" }], [{ kind: "availability", dateReference: "same_day_as_last_offer", timePreference: "after", timePreferenceMode: "explicit", afterLocalTime: "08:30", relation: "later_than_last_offer", existingOfferDisposition: "reject_now" }]] }] },
  { id: "weekend-saturday-sunday", customerMessages: ["Хочу уборку на выходных.", "Воскресенье лучше.", "Да, суббота тоже подойдет."], agentTurnLimit: 3, expected: expectation(), checkpointExpectations: [{ preferredDateAbsent: true, semanticTools: [] }, { preferredDateAbsent: true, semanticTools: [] }, { preferredDate: "2026-08-29", semanticTools: [] }] },
  { id: "same-day", customerMessages: ["Нужна уборка сегодня.", "Обычная 50 м², одна комната, один санузел, Врачар, без шерсти и допуслуг.", "Почему цена выше?"], agentTurnLimit: 3, expected: expectation({ hasQuote: true }) },
  { id: "sofa-carpet", customerMessages: ["Can you clean a sofa and carpet?", "It is in a 50 m2 flat in Dorcol.", "The sofa has old stains.", "The carpet is wool.", "Can I get a rough price?", "Thursday would suit me."], agentTurnLimit: 6, expected: expectation({ humanNeeded: true }), requiredToolCounts: { mark_human_needed: 1 }, checkpointExpectations: [
    { humanNeeded: true },
    { humanNeeded: true, semanticToolsOneOf: [[], ["update_client_data"]], visibleDifferentFromPrevious: true },
    { humanNeeded: true, semanticToolsOneOf: [[], ["update_client_data"]], visibleIncludes: ["sofa"], visibleDifferentFromPrevious: true },
    { humanNeeded: true, semanticToolsOneOf: [[], ["update_client_data"]], visibleIncludes: ["carpet"], visibleDifferentFromPrevious: true },
    { humanNeeded: true, semanticTools: [], visibleIncludes: ["automatic price"], visibleDifferentFromPrevious: true },
    { humanNeeded: true, preferredDate: "2026-08-27", semanticToolsOneOf: [[], ["update_client_data"]], visibleIncludes: ["requested date"], visibleDifferentFromPrevious: true },
  ] },
  { id: "over-200-m2", customerMessages: ["Нужна уборка 240 м².", "Это квартира в Новом Белграде.", "На 26 августа."], agentTurnLimit: 3, expected: expectation({ humanNeeded: true }), requiredToolCounts: { mark_human_needed: 0 }, checkpointExpectations: [{ quoteState: "none", humanNeeded: true, humanNeededReason: "area_over_200_m2", semanticTools: ["update_client_data"] }, { humanNeeded: true, semanticTools: [], visibleIncludes: ["Новый Белград добавил"] }, { humanNeeded: true, preferredDate: "2026-08-26", semanticToolsOneOf: [[], ["update_client_data"]] }] },
  { id: "en-commercial", customerMessages: ["I need an office cleaned.", "It is 120 m2 in New Belgrade.", "There are four rooms and two bathrooms.", "There is also a staff kitchen.", "Can you estimate the cost?", "Thursday afternoon would suit us."], agentTurnLimit: 6, expected: expectation({ humanNeeded: true }), requiredToolCounts: { mark_human_needed: 1 }, checkpointExpectations: [
    { humanNeeded: true, humanNeededReason: "commercial_property" },
    { humanNeeded: true, semanticToolsOneOf: [[], ["update_client_data"]], visibleDifferentFromPrevious: true },
    { humanNeeded: true, semanticToolsOneOf: [[], ["update_client_data"]], visibleIncludes: ["room and bathroom"], visibleDifferentFromPrevious: true },
    { humanNeeded: true, semanticToolsOneOf: [[], ["update_client_data"]], visibleIncludes: ["commercial space"], visibleDifferentFromPrevious: true },
    { humanNeeded: true, semanticTools: [], visibleIncludes: ["automatic price"], visibleDifferentFromPrevious: true },
    { humanNeeded: true, preferredDate: "2026-08-27", semanticToolsOneOf: [[], ["update_client_data"]], visibleIncludes: ["requested date"], visibleDifferentFromPrevious: true },
  ] },
  { id: "ru-to-en-switch", customerMessages: ["Нужна обычная уборка 60 м² в Врачаре.", "I mean two rooms and one bathroom.", "Без шерсти и допуслуг, 26 августа."], agentTurnLimit: 3, expected: expectation({ hasQuote: true }) },
  { id: "sr-cyrillic", customerMessages: ["Треба ми чишћење.", "Стандардно, 60 m² у Земуну.", "Две собе, једно купатило, без додатака и много длака, 26. августа."], agentTurnLimit: 3, expected: expectation({ hasQuote: true }) },
  { id: "sr-latn-da", customerMessages: ["Treba mi čišćenje za vikend.", "Da.", "Standardno 50 m2, jedna soba, jedno kupatilo, Dorćol, bez dodataka."], agentTurnLimit: 3, expected: expectation(), checkpointExpectations: [{ preferredDateAbsent: true, semanticTools: [] }, { preferredDate: "2026-08-29", semanticTools: [] }] },
  { id: "pet-hair-context", customerMessages: ["Нужна обычная уборка 50 м² в Врачаре, одна комната, один санузел, без допуслуг.", "Собака дома.", "Нет, сильной шерсти нет."], agentTurnLimit: 3, expected: expectation({ hasQuote: true }), checkpointExpectations: [{ quoteState: "none", humanNeeded: false }, { quoteState: "none", humanNeeded: false, visibleDifferentFromPrevious: true }, { quoteAmountRsd: 4_000, quoteState: "active", humanNeeded: false, visibleIncludes: ["4 000 RSD"] }] },
  { id: "off-topic", customerMessages: ["Какая сегодня погода?", "Ладно, мне нужна уборка 50 м².", "Обычная, одна комната, один санузел, Врачар, без шерсти и допуслуг, 26 августа."], agentTurnLimit: 3, expected: expectation({ hasQuote: true }), checkpointExpectations: [{ preferredDateAbsent: true }] },
  { id: "calendar-transport-failure", customerMessages: ["Standard 75 m2, 3 rooms, one bathroom, no pet hair or extras, Vracar, 26 August.", "Please show available times.", "Can someone help find another date?"], agentTurnLimit: 3, sandbox: { calendarTransportFails: true }, expected: expectation({ hasQuote: true, humanNeeded: true }), checkpointExpectations: [{ quoteAmountRsd: 6_000, quoteState: "active", preferredDate: "2026-08-26", humanNeeded: false }, { quoteAmountRsd: 6_000, quoteState: "active", preferredDate: "2026-08-26", preferredTimeWindowAbsent: true, humanNeeded: true, humanNeededReason: "calendar_unavailable", semanticToolsOneOf: [["request_available_slots"], ["update_client_data", "request_available_slots"]], schedulingActionsOneOf: [[{ kind: "availability", dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "none" }], [{ kind: "availability", dateReference: "current_preferred_date", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "none" }]] }, { quoteAmountRsd: 6_000, quoteState: "active", preferredDate: "2026-08-26", humanNeeded: true, humanNeededReason: "calendar_unavailable", semanticTools: [], visibleIncludes: ["already been passed to our team"] }] },
  { id: "same-day-after-hours", customerMessages: ["Нужна обычная уборка 50 м², одна комната, один санузел, Врачар, без шерсти и допуслуг, сегодня.", "Покажи свободные слоты сегодня.", "А если на завтра?", "А в этот же день после 19:00 есть?"], agentTurnLimit: 4, sandbox: { now: "2026-08-24T19:42:00.000Z" }, expected: expectation({ hasQuote: true, slotOffer: true }), checkpointExpectations: [{ quoteAmountRsd: 4_800, quoteState: "active", preferredDate: "2026-08-24", humanNeeded: false }, { quoteAmountRsd: 4_000, quoteState: "active", preferredDate: "2026-08-25", preferredTimeWindowAbsent: true, humanNeeded: false, calendarAvailabilityQueries: 2, slotOfferCount: 1, semanticToolsOneOf: [["request_available_slots"], ["update_client_data", "request_available_slots"]], schedulingActionsOneOf: [[{ kind: "availability", dateReference: "today", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "none" }], [{ kind: "availability", dateReference: "today", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "none" }]] }, { quoteAmountRsd: 4_000, quoteState: "active", preferredTimeWindowAbsent: true, humanNeeded: false, calendarAvailabilityQueries: 4, slotOfferCount: 2, semanticToolsOneOf: [["request_available_slots"], ["update_client_data", "request_available_slots"]], schedulingActionsOneOf: [[{ kind: "availability", dateReference: "tomorrow", timePreference: "any", timePreferenceMode: "preserve", relation: "fresh", existingOfferDisposition: "retain_until_replacement" }], [{ kind: "availability", dateReference: "tomorrow", timePreference: "any", timePreferenceMode: "explicit", relation: "fresh", existingOfferDisposition: "retain_until_replacement" }]] }, { quoteAmountRsd: 4_000, quoteState: "active", preferredTimeWindowAbsent: true, humanNeeded: false, calendarCreates: 0, calendarAvailabilityQueries: 6, slotOfferCount: 2, semanticTools: ["request_available_slots"], schedulingActions: [{ kind: "availability", dateReference: "same_day_as_last_offer", timePreference: "after", timePreferenceMode: "explicit", afterLocalTime: "19:00", relation: "fresh", existingOfferDisposition: "retain_until_replacement" }], visibleIncludes: ["В заданный промежуток в ближайшие две недели свободных слотов нет"] }] },
];

export function assertLiveConversationScenarioManifest(
  scenarios: readonly LiveConversationScenario[] = liveConversationScenarios,
): void {
  if (scenarios.length !== requiredLiveConversationScenarioCount) {
    throw new Error(`Live conversation manifest must contain exactly ${requiredLiveConversationScenarioCount} scenarios`);
  }
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== requiredLiveConversationScenarioCount) {
    throw new Error("Live conversation manifest contains duplicate scenario IDs");
  }
  for (const [index, [expectedId, expectedMessages]] of requiredSmokeScenarioShape.entries()) {
    const scenario = scenarios[index];
    if (scenario?.id !== expectedId || scenario.customerMessages.length !== expectedMessages) {
      throw new Error(`Live smoke fixture ${index + 1} must remain ${expectedId} with ${expectedMessages} customer messages`);
    }
  }
  const longScenarioCount = scenarios.filter((scenario) => scenario.customerMessages.length >= 6).length;
  if (longScenarioCount !== 6) throw new Error("Live conversation manifest must contain exactly six long scenarios");
  if (scenarios.some((scenario) => scenario.customerMessages.length < 3 || scenario.customerMessages.length > 8)) {
    throw new Error("Live conversation scenarios must contain 3 to 8 customer messages");
  }
  if (scenarios.some((scenario) => !Number.isInteger(scenario.agentTurnLimit) || scenario.agentTurnLimit < 1 || scenario.agentTurnLimit > scenario.customerMessages.length)) {
    throw new Error("Each live conversation scenario needs an agent-turn limit within its customer-message count");
  }
  for (const scenario of scenarios) {
    for (const checkpoint of scenario.checkpointExpectations ?? []) {
      if (checkpoint?.schedulingActions !== undefined && checkpoint.schedulingActionsOneOf !== undefined) {
        throw new Error("A live checkpoint cannot define both schedulingActions and schedulingActionsOneOf");
      }
      if (checkpoint?.lastAvailabilityAttempt !== undefined && checkpoint.lastAvailabilityAttemptOneOf !== undefined) {
        throw new Error("A live checkpoint cannot define both lastAvailabilityAttempt and lastAvailabilityAttemptOneOf");
      }
    }
  }
}

assertLiveConversationScenarioManifest();

export const liveConversationScenarioCount = requiredLiveConversationScenarioCount;
export const liveConversationMessageCount = liveConversationScenarios.reduce(
  (total, scenario) => total + scenario.customerMessages.length,
  0,
);
