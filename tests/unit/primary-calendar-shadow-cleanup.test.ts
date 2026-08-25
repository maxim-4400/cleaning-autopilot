import { describe, expect, it } from "vitest";

import {
  parsePrimaryShadowCleanupCli,
  parsePrimaryShadowCleanupManifest,
  reconcilePrimaryShadowCopies,
  runPrimaryShadowCleanup,
  manifestSha256,
} from "../../scripts/cleanup-primary-calendar-shadows.mjs";

const teamA = "team-a@group.calendar.google.com";
const teamB = "team-b@group.calendar.google.com";
const manifest = {
  version: 1,
  target: { calendarId: "primary" },
  teamCalendars: { teamA, teamB },
  window: { timeMin: "2026-08-24T00:00:00+02:00", timeMax: "2026-10-01T00:00:00+02:00" },
  candidates: [{ primaryEventId: "primary-event-123", team: "team_a", originalEventId: "team-a-event-123", iCalUID: "shared-ical-uid@example.com" }],
};

const environment = {
  COMPOSIO_API_KEY: "test-key",
  COMPOSIO_GOOGLE_CALENDAR_USER_ID: "test-user",
  COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID: "test-account",
  COMPOSIO_GOOGLE_CALENDAR_TOOLKIT_VERSION: "20260824_01",
  TEAM_A_CALENDAR_ID: teamA,
  TEAM_B_CALENDAR_ID: teamB,
};

describe("primary Calendar shadow cleanup", () => {
  it("requires an exact manifest and explicit apply confirmation", () => {
    expect(() => parsePrimaryShadowCleanupCli([])).toThrow(/--manifest/);
    expect(() => parsePrimaryShadowCleanupCli(["--manifest=/tmp/manifest.json", "--apply"])).toThrow(/confirm-primary-shadow-cleanup/);
    expect(parsePrimaryShadowCleanupCli(["--manifest=/tmp/manifest.json"])).toEqual({ apply: false, manifestPath: "/tmp/manifest.json", manifestSha256: undefined });
    expect(() => parsePrimaryShadowCleanupCli(["--manifest=/tmp/manifest.json", "--apply", "--confirm-primary-shadow-cleanup"])).toThrow(/manifest-sha256/);
    expect(parsePrimaryShadowCleanupCli(["--manifest=/tmp/manifest.json", "--apply", "--confirm-primary-shadow-cleanup", `--manifest-sha256=${"a".repeat(64)}`]))
      .toEqual({ apply: true, manifestPath: "/tmp/manifest.json", manifestSha256: "a".repeat(64) });
  });

  it("accepts only a primary target with two declared dedicated Team group calendars", () => {
    expect(parsePrimaryShadowCleanupManifest(manifest)).toMatchObject({ target: { calendarId: "primary" }, teamCalendars: { teamA, teamB } });
    expect(() => parsePrimaryShadowCleanupManifest({ ...manifest, target: { calendarId: teamA } })).toThrow(/exactly primary/);
    expect(() => parsePrimaryShadowCleanupManifest({ ...manifest, teamCalendars: { teamA: "primary", teamB } })).toThrow(/dedicated Team/);
    expect(() => parsePrimaryShadowCleanupManifest({ ...manifest, teamCalendars: { teamA, teamB: teamA } })).toThrow(/distinct dedicated/);
  });

  it("allows deletion candidates only when the exact Team A/B original and shared iCalUID both match", () => {
    const parsed = parsePrimaryShadowCleanupManifest(manifest);
    expect(reconcilePrimaryShadowCopies(parsed, {
      primary: [{ id: "primary-event-123", iCalUID: "shared-ical-uid@example.com" }],
      team_a: [{ id: "team-a-event-123", iCalUID: "shared-ical-uid@example.com" }],
      team_b: [],
    })).toEqual({ matches: [{ primaryEventId: "primary-event-123", team: "team_a", originalEventId: "team-a-event-123" }], mismatches: [] });
    expect(reconcilePrimaryShadowCopies(parsed, {
      primary: [{ id: "primary-event-123", iCalUID: "different-uid@example.com" }],
      team_a: [{ id: "team-a-event-123", iCalUID: "shared-ical-uid@example.com" }],
      team_b: [],
    })).toMatchObject({ matches: [], mismatches: [{ primaryEventId: "primary-event-123", reason: "ical_uid_mismatch" }] });
  });

  it("is read-only by default even for a valid fully matching manifest", async () => {
    const calls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
    const output: string[] = [];
    const composioFactory = () => ({
      tools: {
        execute: async (tool: string, input: { arguments: Record<string, unknown> }) => {
          calls.push({ tool, arguments: input.arguments });
          const items = input.arguments.calendarId === "primary"
            ? [{ id: "primary-event-123", iCalUID: "shared-ical-uid@example.com" }]
            : input.arguments.calendarId === teamA
              ? [{ id: "team-a-event-123", iCalUID: "shared-ical-uid@example.com" }]
              : [];
          return { successful: true, data: { response_data: { items } } };
        },
      },
    });
    await expect(runPrimaryShadowCleanup({
      argv: ["--manifest=/tmp/manifest.json"], env: environment, write: (line) => output.push(line),
      readManifest: async () => JSON.stringify(manifest), composioFactory,
    })).resolves.toMatchObject({ mode: "dry-run", eligible: 1, blocked: 0, deleted: 0 });
    expect(calls.map((call) => call.tool)).toEqual(["GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_EVENTS_LIST"]);
    expect(calls.some((call) => call.tool === "GOOGLECALENDAR_DELETE_EVENT")).toBe(false);
    expect(output).toHaveLength(1);
  });

  it("never calls delete for a mismatch and hard-codes primary for an eligible apply", async () => {
    const calls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
    const matchingFactory = () => ({
      tools: {
        execute: async (tool: string, input: { arguments: Record<string, unknown> }) => {
          calls.push({ tool, arguments: input.arguments });
          if (tool === "GOOGLECALENDAR_DELETE_EVENT") return { successful: true, data: {} };
          const items = input.arguments.calendarId === "primary"
            ? [{ id: "primary-event-123", iCalUID: "shared-ical-uid@example.com" }]
            : input.arguments.calendarId === teamA
              ? [{ id: "team-a-event-123", iCalUID: "shared-ical-uid@example.com" }]
              : [];
          return { successful: true, data: { response_data: { items } } };
        },
      },
    });
    const rawManifest = JSON.stringify(manifest);
    const manifestHash = manifestSha256(rawManifest);
    await expect(runPrimaryShadowCleanup({
      argv: ["--manifest=/tmp/manifest.json", "--apply", "--confirm-primary-shadow-cleanup", `--manifest-sha256=${manifestHash}`], env: environment,
      write: () => {}, readManifest: async () => rawManifest, composioFactory: matchingFactory,
    })).resolves.toMatchObject({ mode: "apply", deleted: 1 });
    expect(calls.find((call) => call.tool === "GOOGLECALENDAR_DELETE_EVENT")?.arguments).toEqual({ calendar_id: "primary", event_id: "primary-event-123", send_updates: "none" });

    const mismatchedCalls: string[] = [];
    await expect(runPrimaryShadowCleanup({
      argv: ["--manifest=/tmp/manifest.json", "--apply", "--confirm-primary-shadow-cleanup", `--manifest-sha256=${manifestHash}`], env: environment,
      write: () => {}, readManifest: async () => rawManifest,
      composioFactory: () => ({ tools: { execute: async (tool: string, input: { arguments: Record<string, unknown> }) => {
        mismatchedCalls.push(tool);
        const items = input.arguments.calendarId === "primary" ? [{ id: "primary-event-123", iCalUID: "wrong-uid@example.com" }] : [];
        return { successful: true, data: { response_data: { items } } };
      } } }),
    })).rejects.toThrow(/blocked/);
    expect(mismatchedCalls).not.toContain("GOOGLECALENDAR_DELETE_EVENT");
  });
});
