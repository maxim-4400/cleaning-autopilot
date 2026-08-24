import { describe, expect, it } from "vitest";

import {
  DEMO_CALENDAR_EVENTS,
  DEMO_CALENDAR_SEED_ID,
  DEMO_EVENT_DESCRIPTION,
  correctionUpdateArguments,
  demoEventArguments,
  parseCli,
  parseCorrectionArgument,
  parseReservationRestoreArgument,
  runDemoCalendarSeed,
} from "../../scripts/seed-calendar-demo-load.mjs";

const demoEvents = DEMO_CALENDAR_EVENTS;

describe("calendar demo load seed", () => {
  it("contains a finite, weekday/daytime Team A/B load with realistic durations and no 06:00 events", () => {
    expect(demoEvents).toHaveLength(40);
    expect(new Set(demoEvents.map((entry) => entry.key)).size).toBe(demoEvents.length);
    expect(demoEvents.map((entry) => entry.team)).toContain("team_a");
    expect(demoEvents.map((entry) => entry.team)).toContain("team_b");
    const byTeam = new Map(["team_a", "team_b"].map((team) => [team, demoEvents.filter((entry) => entry.team === team)]));
    expect(byTeam.get("team_a")).toHaveLength(20);
    expect(byTeam.get("team_b")).toHaveLength(20);
    for (const entry of demoEvents) {
      expect(entry.startDatetime >= "2026-08-25T08:00:00").toBe(true);
      expect(entry.endDatetime <= "2026-09-29T20:00:00").toBe(true);
      expect(entry.startDatetime.slice(11, 16)).not.toBe("06:00");
      expect(new Date(`${entry.startDatetime}+02:00`).getUTCDay()).not.toBe(0);
      expect(entry.startDatetime.slice(11, 16) >= "08:00").toBe(true);
      expect(entry.endDatetime.slice(11, 16) <= "20:00").toBe(true);
      expect([150, 210, 270]).toContain(entry.durationMinutes);
      expect(entry.summary).toMatch(/^\[DEMO\]/);
    }
    for (const events of byTeam.values()) {
      events.sort((left, right) => left.startDatetime.localeCompare(right.startDatetime));
      for (let index = 1; index < events.length; index += 1) {
      expect(events[index - 1]!.endDatetime <= events[index]!.startDatetime).toBe(true);
      }
    }
    const density = (from: string, to: string) => demoEvents.filter((entry) => entry.startDatetime >= from && entry.startDatetime < to).length;
    expect(density("2026-08-25", "2026-09-01")).toBe(20);
    expect(density("2026-09-01", "2026-09-15")).toBe(13);
    expect(density("2026-09-15", "2026-10-01")).toBe(7);
    expect(demoEvents.some((entry) => entry.startDatetime === "2026-08-25T11:30:00" && entry.team === "team_b")).toBe(true);
  });

  it("marks create payloads as owned, public, synthetic, and non-notifying", () => {
    const input = demoEventArguments(demoEvents[0]!, "team-a@group.calendar.google.com");
    expect(input).toMatchObject({
      calendar_id: "team-a@group.calendar.google.com",
      description: DEMO_EVENT_DESCRIPTION,
      timezone: "Europe/Belgrade",
      visibility: "public",
      transparency: "opaque",
      send_updates: "none",
      create_meeting_room: false,
      extended_properties: { private: { sherlockDemoSeed: DEMO_CALENDAR_SEED_ID } },
    });
  });

  it("is dry-run by default and makes no provider call", async () => {
    const output: string[] = [];
    await expect(runDemoCalendarSeed({ argv: [], write: (line: string) => output.push(line) })).resolves.toMatchObject({
      mode: "dry-run", creates: demoEvents.length, externalWrites: 0,
    });
    expect(output).toHaveLength(1);
  });

  it("accepts only explicit, bounded legacy correction IDs and local times", () => {
    expect(parseCorrectionArgument("team_b,369c01sd9adjmnnbp5da0bughc,2026-08-26T08:00:00,2026-08-26T11:00:00"))
      .toMatchObject({ team: "team_b", eventId: "369c01sd9adjmnnbp5da0bughc" });
    expect(() => parseCorrectionArgument("team_b,369c01sd9adjmnnbp5da0bughc,2026-08-26T06:00:00,2026-08-26T09:00:00")).toThrow(/08:00/);
    expect(() => parseCorrectionArgument("team_b,not an id,2026-08-26T08:00:00,2026-08-26T11:00:00")).toThrow(/eventId/);
    const metadata = Buffer.from(JSON.stringify({
      summary: "Cleaning reservation", description: null, visibility: "private", transparency: "opaque",
      extended_properties: { private: { cleaningLeadId: "lead", idempotencyKey: "key" } },
    })).toString("base64url");
    expect(parseCli(["--apply", "--correct-event=team_a,b5q0l09ajaai1ivursgg3q5pr4,2026-09-01T08:00:00,2026-09-01T11:30:00", `--correct-metadata=b5q0l09ajaai1ivursgg3q5pr4,${metadata}`]))
      .toMatchObject({ apply: true, corrections: [{ team: "team_a" }] });
  });

  it("uses a complete response-derived payload for legacy corrections rather than a sparse replacement", () => {
    const correction = parseCli(["--correct-event=team_b,369c01sd9adjmnnbp5da0bughc,2026-08-26T08:00:00,2026-08-26T11:00:00"]).corrections[0]!;
    const arguments_ = correctionUpdateArguments({
      calendarId: "team-b@group.calendar.google.com",
      correction,
      current: {
        id: correction.eventId,
        summary: "Cleaning reservation",
        description: "Synthetic legacy test",
        visibility: "private",
        transparency: "opaque",
        extendedProperties: { private: { cleaningLeadId: "lead", idempotencyKey: "key" } },
        start: { dateTime: "2026-08-26T06:00:00+02:00" },
        end: { dateTime: "2026-08-26T09:00:00+02:00" },
      },
    });
    expect(arguments_).toMatchObject({
      event_id: correction.eventId,
      summary: "Cleaning reservation",
      description: "Synthetic legacy test",
      visibility: "private",
      transparency: "opaque",
      extended_properties: { private: { cleaningLeadId: "lead", idempotencyKey: "key" } },
      start_datetime: "2026-08-26T08:00:00",
      end_datetime: "2026-08-26T11:00:00",
      timezone: "Europe/Belgrade",
    });
  });

  it("builds a full reservation restore only from an exact reconciled event, lead, and operation key", () => {
    const leadId = "11111111-1111-4111-8111-111111111111";
    const idempotencyKey = `google_calendar:reservation:${leadId}:slot-token`;
    const correction = parseReservationRestoreArgument(`team_a,b5q0l09ajaai1ivursgg3q5pr4,${leadId},${idempotencyKey},2026-09-01T08:00:00,2026-09-01T11:30:00`);
    expect(correction.metadata).toEqual({
      summary: "Cleaning reservation", description: null, visibility: "private", transparency: "opaque",
      extended_properties: { private: { cleaningLeadId: leadId, idempotencyKey } },
    });
    expect(() => parseReservationRestoreArgument(`team_a,b5q0l09ajaai1ivursgg3q5pr4,${leadId},google_calendar:reservation:another-lead:slot-token,2026-09-01T08:00:00,2026-09-01T11:30:00`))
      .toThrow(/does not belong/);
  });

  it("refuses to repair a field-lost event without exact operator-supplied metadata", () => {
    const correction = parseCli(["--correct-event=team_a,b5q0l09ajaai1ivursgg3q5pr4,2026-09-01T08:00:00,2026-09-01T11:30:00"]).corrections[0]!;
    expect(() => correctionUpdateArguments({
      calendarId: "team-a@group.calendar.google.com", correction,
      current: { id: correction.eventId, start: { dateTime: "2026-09-01T08:00:00+02:00" }, end: { dateTime: "2026-09-01T11:30:00+02:00" } },
    })).toThrow(/summary metadata/);
  });
});
