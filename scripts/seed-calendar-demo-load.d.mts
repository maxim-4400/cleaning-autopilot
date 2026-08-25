export type DemoCalendarEntry = {
  team: "team_a" | "team_b";
  startDatetime: string;
  endDatetime: string;
  key: string;
  summary: string;
  durationMinutes: number;
};

export const DEMO_CALENDAR_SEED_ID: string;
export const DEMO_EVENT_DESCRIPTION: string;
export const DEMO_CALENDAR_EVENTS: DemoCalendarEntry[];
export function demoEventArguments(entry: DemoCalendarEntry, calendarId: string): Record<string, unknown>;
export function assertDedicatedTeamCalendars(calendarIds: { team_a?: string; team_b?: string }): { team_a: string; team_b: string };
export type CorrectionMetadata = { summary: string; description?: string | null; visibility: "default" | "public" | "private" | "confidential"; transparency: "opaque" | "transparent"; extended_properties: { private?: Record<string, string>; shared?: Record<string, string> } | null };
export type CalendarCorrection = { team: "team_a" | "team_b"; eventId: string; startDatetime: string; endDatetime: string; metadata?: CorrectionMetadata };
export function parseCorrectionArgument(value: string): Omit<CalendarCorrection, "metadata">;
export function parseReservationRestoreArgument(value: string): CalendarCorrection & { metadata: CorrectionMetadata };
export function parseCli(argv: string[]): { apply: boolean; corrections: CalendarCorrection[] };
export function correctionUpdateArguments(input: { current: Record<string, unknown>; correction: CalendarCorrection; calendarId: string }): Record<string, unknown>;
export function runDemoCalendarSeed(input: { argv?: string[]; env?: Record<string, string | undefined>; write?: (line: string) => void }): Promise<Record<string, unknown>>;
