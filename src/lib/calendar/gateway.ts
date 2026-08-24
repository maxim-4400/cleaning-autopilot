import { Composio } from "@composio/core";
import { z } from "zod";

import type { CleaningTeam } from "@/lib/contracts/domain";
import type { BusyInterval } from "@/lib/scheduling/engine";

export type CalendarCreateInput = {
  team: CleaningTeam;
  start: string;
  end: string;
  leadId: string;
  idempotencyKey: string;
};

export type CalendarCreateResult = { kind: "created"; eventId: string } | { kind: "failed"; code: string; ambiguous: boolean };

export interface CalendarGateway {
  getBusyIntervals(input: { team: CleaningTeam; from: string; to: string }): Promise<BusyInterval[]>;
  createEvent(input: CalendarCreateInput): Promise<CalendarCreateResult>;
}

export class FakeCalendarGateway implements CalendarGateway {
  readonly creates: CalendarCreateInput[] = [];
  readonly availabilityQueries: Array<{ team: CleaningTeam; from: string; to: string }> = [];
  busyByTeam: Record<CleaningTeam, BusyInterval[]> = { team_a: [], team_b: [] };
  nextCreateResult: CalendarCreateResult | undefined;

  async getBusyIntervals(input: { team: CleaningTeam; from: string; to: string }): Promise<BusyInterval[]> {
    this.availabilityQueries.push(input);
    return this.busyByTeam[input.team];
  }

  async createEvent(input: CalendarCreateInput): Promise<CalendarCreateResult> {
    this.creates.push(input);
    return this.nextCreateResult ?? { kind: "created", eventId: `fake-calendar-event-${this.creates.length}` };
  }
}

type ComposioCalendarEnvironment = {
  apiKey: string;
  userId: string;
  connectedAccountId: string;
  toolkitVersion: string;
  teamACalendarId: string;
  teamBCalendarId: string;
};

/**
 * Calendar routing is deliberately explicit. Google accepts `primary` as a
 * valid calendar identifier, but a reservation must never use it as a
 * fallback: every team needs its own configured target.
 */
export function calendarIdForTeam(environment: Pick<ComposioCalendarEnvironment, "teamACalendarId" | "teamBCalendarId">, team: CleaningTeam): string {
  const teamA = environment.teamACalendarId?.trim();
  const teamB = environment.teamBCalendarId?.trim();
  if (!isDedicatedTeamCalendarId(teamA) || !isDedicatedTeamCalendarId(teamB) || teamA.localeCompare(teamB, undefined, { sensitivity: "accent" }) === 0) {
    throw new Error("Exact dedicated Team A and Team B calendar configuration is required");
  }
  const calendarId = team === "team_a" ? teamA : teamB;
  return calendarId;
}

function isDedicatedTeamCalendarId(calendarId: string | undefined): calendarId is string {
  if (!calendarId) return false;
  const normalized = calendarId.toLocaleLowerCase();
  return normalized.endsWith("@group.calendar.google.com") && !["primary", "default", "personal", "my calendar", "my-calendar", "me"].includes(normalized);
}

// Google Calendar free/busy returns RFC 3339 timestamps in the requested
// timezone (for example, `+02:00` in Belgrade), not necessarily UTC `Z`.
// Keep the response contract strict while accepting both valid ISO forms.
const busyIntervalSchema = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }).strict();
const calendarBusySchema = z.object({
  busy: z.array(busyIntervalSchema),
  free: z.array(busyIntervalSchema),
}).strict();

/**
 * Server-only, two-tool Composio adapter. Tool slugs and argument shapes are
 * deliberately fixed here; the agent never sees the Composio SDK or its tools.
 */
export class ComposioCalendarGateway implements CalendarGateway {
  private readonly composio: Composio;

  constructor(private readonly environment: ComposioCalendarEnvironment) {
    this.composio = new Composio({
      apiKey: environment.apiKey,
      toolkitVersions: { googlecalendar: environment.toolkitVersion },
    });
  }

  async getBusyIntervals(input: { team: CleaningTeam; from: string; to: string }): Promise<BusyInterval[]> {
    const calendarId = calendarIdForTeam(this.environment, input.team);
    const result = await this.composio.tools.execute("GOOGLECALENDAR_FIND_FREE_SLOTS", {
      userId: this.environment.userId,
      connectedAccountId: this.environment.connectedAccountId,
      version: this.environment.toolkitVersion,
      arguments: { items: [calendarId], time_min: input.from, time_max: input.to, timezone: "Europe/Belgrade" },
    });
    return parseComposioBusyIntervals(result, calendarId);
  }

  async createEvent(input: CalendarCreateInput): Promise<CalendarCreateResult> {
    try {
      const calendarId = calendarIdForTeam(this.environment, input.team);
      const result = await this.composio.tools.execute("GOOGLECALENDAR_CREATE_EVENT", {
        userId: this.environment.userId,
        connectedAccountId: this.environment.connectedAccountId,
        version: this.environment.toolkitVersion,
        arguments: {
          calendar_id: calendarId,
          summary: "Cleaning reservation",
          start_datetime: input.start,
          end_datetime: input.end,
          timezone: "Europe/Belgrade",
          visibility: "private",
          transparency: "opaque",
          send_updates: "none",
          create_meeting_room: false,
          extended_properties: { private: { cleaningLeadId: input.leadId, idempotencyKey: input.idempotencyKey } },
        },
      });
      const eventId = parseEventId(result);
      return eventId ? { kind: "created", eventId } : { kind: "failed", code: "calendar_create_response_ambiguous", ambiguous: true };
    } catch (error) {
      if (error instanceof Error && error.message === "Exact dedicated Team A and Team B calendar configuration is required") {
        return { kind: "failed", code: "calendar_team_not_configured", ambiguous: false };
      }
      return { kind: "failed", code: "calendar_create_transport_failed", ambiguous: true };
    }
  }
}

export function parseComposioBusyIntervals(result: unknown, calendarId: string): BusyInterval[] {
  const payload = responseData(result);
  const calendar = isRecord(payload) && isRecord(payload.calendars) ? payload.calendars[calendarId] : undefined;
  const parsed = calendarBusySchema.safeParse(calendar);
  if (!parsed.success) throw new Error("Composio Calendar availability response did not match the verified free/busy schema");
  return parsed.data.busy.map(({ start, end }) => ({ start, end }));
}

function parseEventId(result: unknown): string | undefined {
  const payload = responseData(result);
  if (!isRecord(payload)) return undefined;
  return typeof payload.id === "string" && payload.id.length > 0 ? payload.id : undefined;
}

function responseData(result: unknown): unknown {
  if (!isRecord(result) || result.successful === false || !isRecord(result.data)) {
    throw new Error("Composio Calendar execution failed or returned an invalid envelope");
  }
  return result.data.response_data ?? result.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
