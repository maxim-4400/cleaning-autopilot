import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Composio } from "@composio/core";

export const DEMO_CALENDAR_SEED_ID = "sherlock-stage5-calendar-load-2026-08-24";
export const DEMO_EVENT_DESCRIPTION = "Synthetic demo booking. No real customer. Timezone: Europe/Belgrade.";
const BELGRADE_TIMEZONE = "Europe/Belgrade";
const DEMO_WINDOW = { from: "2026-08-24T00:00:00", to: "2026-10-01T00:00:00" };

/**
 * Intentionally finite, dated demo load. It gives the public calendars
 * credible daytime occupancy without creating recurring production data.
 * All values are Europe/Belgrade wall-clock times.
 */
export const DEMO_CALENDAR_EVENTS = [
  ...entriesFor("team_a", [
    ["2026-08-25", "08:00", "11:30"], ["2026-08-25", "15:30", "18:00"],
    ["2026-08-26", "10:00", "13:30"], ["2026-08-26", "16:00", "19:30"],
    ["2026-08-27", "08:30", "12:00"], ["2026-08-27", "14:30", "18:00"],
    ["2026-08-28", "08:00", "12:30"], ["2026-08-28", "15:30", "18:00"],
    ["2026-08-29", "09:00", "12:30"], ["2026-08-31", "14:00", "18:30"],
    // 08:00–11:30 is a separately corrected legacy test event; leave a buffer.
    ["2026-09-01", "12:00", "14:30"], ["2026-09-01", "15:00", "17:30"],
    // 08:00–11:30 is a separately corrected legacy test event.
    ["2026-09-03", "13:00", "17:30"], ["2026-09-05", "11:00", "14:30"],
    ["2026-09-07", "08:00", "11:30"], ["2026-09-07", "14:00", "18:30"],
    ["2026-09-14", "10:00", "13:30"], ["2026-09-18", "08:00", "12:30"],
    ["2026-09-23", "14:00", "17:30"], ["2026-09-28", "09:00", "11:30"],
  ]),
  ...entriesFor("team_b", [
    ["2026-08-25", "11:30", "15:00"], ["2026-08-25", "17:00", "19:30"],
    // 08:00–11:00 is a separately corrected legacy test event.
    ["2026-08-26", "13:00", "15:30"], ["2026-08-26", "16:00", "19:30"],
    ["2026-08-27", "09:30", "12:00"], ["2026-08-27", "15:00", "19:30"],
    ["2026-08-28", "10:30", "14:00"], ["2026-08-28", "16:30", "19:00"],
    ["2026-08-29", "08:00", "12:30"], ["2026-08-31", "10:00", "13:30"],
    // The Team B legacy correction is on 1 Sep, so this date has no legacy buffer.
    ["2026-09-02", "10:00", "13:30"], ["2026-09-02", "16:00", "18:30"],
    ["2026-09-04", "11:00", "15:30"], ["2026-09-04", "17:00", "19:30"],
    ["2026-09-08", "08:30", "12:00"], ["2026-09-10", "14:00", "17:30"],
    ["2026-09-15", "08:30", "12:00"], ["2026-09-19", "13:00", "17:30"],
    ["2026-09-24", "10:00", "12:30"], ["2026-09-29", "15:00", "18:30"],
  ]),
];

function entriesFor(team, intervals) {
  return intervals.map(([date, start, end]) => {
    const startDatetime = `${date}T${start}:00`;
    const endDatetime = `${date}T${end}:00`;
    const durationMinutes = minutesBetween(startDatetime, endDatetime);
    return {
      team,
      startDatetime,
      endDatetime,
      key: `${team}:${startDatetime}`,
      summary: summaryForDuration(durationMinutes),
      durationMinutes,
    };
  });
}

function minutesBetween(start, end) {
  const startMinute = Number(start.slice(11, 13)) * 60 + Number(start.slice(14, 16));
  const endMinute = Number(end.slice(11, 13)) * 60 + Number(end.slice(14, 16));
  return endMinute - startMinute;
}

function summaryForDuration(durationMinutes) {
  if (durationMinutes === 150) return "[DEMO] Standard cleaning · 50 m²";
  if (durationMinutes === 210) return "[DEMO] Standard cleaning · 75 m²";
  if (durationMinutes === 270) return "[DEMO] Deep cleaning · 60 m²";
  throw new Error(`Unsupported synthetic demo duration: ${durationMinutes}`);
}

export function demoEventArguments(entry, calendarId) {
  return {
    calendar_id: calendarId,
    summary: entry.summary,
    description: DEMO_EVENT_DESCRIPTION,
    start_datetime: entry.startDatetime,
    end_datetime: entry.endDatetime,
    timezone: BELGRADE_TIMEZONE,
    visibility: "public",
    transparency: "opaque",
    // Keep the full create-only ownership triple explicit. It prevents an
    // invitation, notification, or organizer shadow copy from materializing
    // this synthetic Team A/B event in the operator's primary calendar.
    attendees: [],
    send_updates: "none",
    exclude_organizer: true,
    create_meeting_room: false,
    extended_properties: {
      private: {
        sherlockDemoSeed: DEMO_CALENDAR_SEED_ID,
        demoKey: entry.key,
      },
    },
  };
}

/**
 * Existing synthetic events are updated with the same full replacement
 * payload as create, except for the create-only organizer exclusion field.
 */
export function demoEventUpdateArguments(entry, calendarId, eventId) {
  const arguments_ = demoEventArguments(entry, calendarId);
  delete arguments_.exclude_organizer;
  return { ...arguments_, event_id: eventId };
}

/**
 * Exact legacy correction syntax: team,eventId,YYYY-MM-DDTHH:mm:ss,YYYY-MM-DDTHH:mm:ss
 *
 * If a previous provider replacement has already removed event fields, pair
 * this with --correct-metadata=eventId,base64url(JSON). The JSON is an exact
 * operator-supplied snapshot of the original presentation fields:
 * {summary, description?, visibility, transparency, extended_properties}.
 * `description` and `extended_properties` may be null only when the operator
 * has established that the original event did not contain those fields.
 *
 * Event IDs are deliberately supplied by the operator; this utility never
 * discovers a correction target by title, date, or any other heuristic.
 */
export function parseCorrectionArgument(value) {
  const parts = value.split(",");
  if (parts.length !== 4) throw new Error("--correct-event needs team,eventId,start,end");
  const [team, eventId, startDatetime, endDatetime] = parts;
  if (team !== "team_a" && team !== "team_b") throw new Error("--correct-event team must be team_a or team_b");
  if (!/^[A-Za-z0-9_-]{6,255}$/.test(eventId)) throw new Error("--correct-event eventId is invalid");
  assertBelgradeBusinessInterval(startDatetime, endDatetime);
  return { team, eventId, startDatetime, endDatetime };
}

/**
 * Exact reconciliation-only restore syntax:
 * team,eventId,leadId,idempotencyKey,YYYY-MM-DDTHH:mm:ss,YYYY-MM-DDTHH:mm:ss
 *
 * Values must come from a read-only reconciliation of the specific Calendar
 * event ID against the application's lead and integration-operation records.
 * The script deliberately never logs these values and never searches for a
 * candidate based on them.
 */
export function parseReservationRestoreArgument(value) {
  const parts = value.split(",");
  if (parts.length !== 6) throw new Error("--restore-reservation needs team,eventId,leadId,idempotencyKey,start,end");
  const [team, eventId, leadId, idempotencyKey, startDatetime, endDatetime] = parts;
  if (team !== "team_a" && team !== "team_b") throw new Error("--restore-reservation team must be team_a or team_b");
  if (!/^[A-Za-z0-9_-]{6,255}$/.test(eventId)) throw new Error("--restore-reservation eventId is invalid");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leadId)) throw new Error("--restore-reservation leadId must be a UUID");
  if (!idempotencyKey.startsWith(`google_calendar:reservation:${leadId}:`)) throw new Error("--restore-reservation idempotencyKey does not belong to its leadId");
  assertBelgradeBusinessInterval(startDatetime, endDatetime);
  return {
    team, eventId, startDatetime, endDatetime,
    metadata: {
      summary: "Cleaning reservation",
      description: null,
      visibility: "private",
      transparency: "opaque",
      extended_properties: { private: { cleaningLeadId: leadId, idempotencyKey } },
    },
  };
}

function parseCorrectionMetadataArgument(value) {
  const separator = value.indexOf(",");
  if (separator <= 0) throw new Error("--correct-metadata needs eventId,base64url-json");
  const eventId = value.slice(0, separator);
  const encodedMetadata = value.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{6,255}$/.test(eventId)) throw new Error("--correct-metadata eventId is invalid");
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(encodedMetadata, "base64url").toString("utf8"));
  } catch {
    throw new Error("--correct-metadata must contain base64url JSON");
  }
  return [eventId, validateCorrectionMetadata(decoded)];
}

function validateCorrectionMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("--correct-metadata must be a JSON object");
  const allowed = new Set(["summary", "description", "visibility", "transparency", "extended_properties"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`--correct-metadata has unsupported field: ${key}`);
  if (typeof value.summary !== "string" || value.summary.length === 0) throw new Error("--correct-metadata requires summary");
  if (value.description !== undefined && value.description !== null && typeof value.description !== "string") throw new Error("--correct-metadata description must be a string or null");
  if (!["default", "public", "private", "confidential"].includes(value.visibility)) throw new Error("--correct-metadata requires a valid visibility");
  if (!["opaque", "transparent"].includes(value.transparency)) throw new Error("--correct-metadata requires a valid transparency");
  if (!Object.hasOwn(value, "extended_properties")) throw new Error("--correct-metadata requires exact extended_properties or null");
  if (value.extended_properties !== null) assertStringMaps(value.extended_properties, "extended_properties");
  return value;
}

function assertStringMaps(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`--correct-metadata ${fieldName} must be an object or null`);
  for (const [scope, values] of Object.entries(value)) {
    if (scope !== "private" && scope !== "shared") throw new Error(`--correct-metadata ${fieldName} has unsupported scope`);
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`--correct-metadata ${fieldName}.${scope} must be an object`);
    for (const fieldValue of Object.values(values)) if (typeof fieldValue !== "string") throw new Error(`--correct-metadata ${fieldName}.${scope} values must be strings`);
  }
}

export function parseCli(argv) {
  const apply = argv.includes("--apply");
  const correctionValues = argv
    .filter((argument) => argument.startsWith("--correct-event="))
    .map((argument) => argument.slice("--correct-event=".length));
  const metadataEntries = argv
    .filter((argument) => argument.startsWith("--correct-metadata="))
    .map((argument) => argument.slice("--correct-metadata=".length))
    .map(parseCorrectionMetadataArgument);
  const metadataByEventId = new Map(metadataEntries);
  if (metadataByEventId.size !== metadataEntries.length) throw new Error("Only one --correct-metadata is allowed per event ID");
  const explicitCorrections = correctionValues.map((value) => {
    const correction = parseCorrectionArgument(value);
    return { ...correction, metadata: metadataByEventId.get(correction.eventId) };
  });
  for (const eventId of metadataByEventId.keys()) if (!explicitCorrections.some((correction) => correction.eventId === eventId)) throw new Error("--correct-metadata must have a matching --correct-event");
  const restoredCorrections = argv
    .filter((argument) => argument.startsWith("--restore-reservation="))
    .map((argument) => argument.slice("--restore-reservation=".length))
    .map(parseReservationRestoreArgument);
  const corrections = [...explicitCorrections, ...restoredCorrections];
  if (new Set(corrections.map((correction) => correction.eventId)).size !== corrections.length) throw new Error("Only one correction or restore is allowed per event ID");
  const unknown = argv.filter((argument) => argument !== "--apply" && !argument.startsWith("--correct-event=") && !argument.startsWith("--correct-metadata=") && !argument.startsWith("--restore-reservation="));
  if (unknown.length > 0) throw new Error(`Unsupported arguments: ${unknown.join(" ")}`);
  return { apply, corrections };
}

function assertBelgradeBusinessInterval(startDatetime, endDatetime) {
  if (!isLocalDateTime(startDatetime) || !isLocalDateTime(endDatetime)) throw new Error("Calendar corrections must use YYYY-MM-DDTHH:mm:ss wall-clock datetimes");
  if (startDatetime < DEMO_WINDOW.from || endDatetime >= DEMO_WINDOW.to || startDatetime >= endDatetime) throw new Error("Calendar correction is outside the approved demo window");
  const startMinutes = Number(startDatetime.slice(11, 13)) * 60 + Number(startDatetime.slice(14, 16));
  const endMinutes = Number(endDatetime.slice(11, 13)) * 60 + Number(endDatetime.slice(14, 16));
  if (startMinutes < 8 * 60 || endMinutes > 20 * 60) throw new Error("Calendar correction must remain between 08:00 and 20:00 Europe/Belgrade");
}

function isLocalDateTime(value) {
  return /^2026-(08|09)-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value);
}

function extractResponseData(result) {
  if (!result || result.successful === false || !result.data || typeof result.data !== "object") throw new Error("Composio Calendar response was not successful");
  return result.data.response_data ?? result.data;
}

function eventKey(event) {
  return event?.extendedProperties?.private?.sherlockDemoSeed === DEMO_CALENDAR_SEED_ID
    && typeof event.extendedProperties.private.demoKey === "string"
    ? event.extendedProperties.private.demoKey
    : undefined;
}

function localEventDateTime(eventPart) {
  if (!eventPart || typeof eventPart !== "object" || typeof eventPart.dateTime !== "string") return undefined;
  return eventPart.dateTime.slice(0, 19);
}

function hasOwn(object, field) {
  return Boolean(object) && typeof object === "object" && Object.hasOwn(object, field);
}

/**
 * GOOGLECALENDAR_UPDATE_EVENT has replacement semantics with the pinned
 * provider version. Never send a sparse time-only object: map the listed
 * event's presentation fields back to the tool's snake_case request schema.
 */
export function correctionUpdateArguments({ current, correction, calendarId }) {
  const supplied = correction.metadata;
  const summary = supplied?.summary ?? current.summary;
  const description = hasOwn(supplied, "description") ? supplied.description : current.description;
  const visibility = supplied?.visibility ?? current.visibility;
  const transparency = supplied?.transparency ?? current.transparency;
  const currentExtendedProperties = current.extendedProperties;
  const extendedProperties = hasOwn(supplied, "extended_properties") ? supplied.extended_properties : currentExtendedProperties;
  if (typeof summary !== "string" || summary.length === 0) throw new Error(`Correction needs exact summary metadata for ${correction.eventId}`);
  if (!["default", "public", "private", "confidential"].includes(visibility)) throw new Error(`Correction needs exact visibility metadata for ${correction.eventId}`);
  if (!["opaque", "transparent"].includes(transparency)) throw new Error(`Correction needs exact transparency metadata for ${correction.eventId}`);
  if (!hasOwn(supplied, "extended_properties") && !hasOwn(current, "extendedProperties")) {
    throw new Error(`Correction needs exact extended_properties metadata for ${correction.eventId}`);
  }
  if (extendedProperties !== null && extendedProperties !== undefined) assertStringMaps(extendedProperties, "extended_properties");
  const arguments_ = {
    calendar_id: calendarId,
    event_id: correction.eventId,
    summary,
    start_datetime: correction.startDatetime,
    end_datetime: correction.endDatetime,
    timezone: BELGRADE_TIMEZONE,
    visibility,
    transparency,
    send_updates: "none",
    create_meeting_room: false,
  };
  if (description !== undefined && description !== null) arguments_.description = description;
  if (extendedProperties !== undefined && extendedProperties !== null) arguments_.extended_properties = extendedProperties;
  return arguments_;
}

function isExpectedExplicitLegacyCorrection(current, correction) {
  const summary = correction.metadata?.summary ?? current.summary;
  const currentStart = localEventDateTime(current.start);
  return summary === "Cleaning reservation"
    && (currentStart?.endsWith("T06:00:00") || currentStart === correction.startDatetime);
}

async function listEvents(composio, environment, calendarId) {
  const result = await composio.tools.execute("GOOGLECALENDAR_EVENTS_LIST", {
    userId: environment.userId,
    connectedAccountId: environment.connectedAccountId,
    version: environment.toolkitVersion,
    arguments: {
      calendarId,
      timeMin: `${DEMO_WINDOW.from}+02:00`,
      timeMax: `${DEMO_WINDOW.to}+02:00`,
      singleEvents: true,
      showDeleted: false,
      maxResults: 250,
    },
  });
  const data = extractResponseData(result);
  if (!data || !Array.isArray(data.items)) throw new Error("Composio Calendar list response did not include event items");
  return data.items;
}

async function execute(composio, environment, tool, arguments_) {
  const result = await composio.tools.execute(tool, {
    userId: environment.userId,
    connectedAccountId: environment.connectedAccountId,
    version: environment.toolkitVersion,
    arguments: arguments_,
  });
  // Do not count a provider failure as a completed create/update. A later
  // explicit --apply run is safe because owned demo events are keyed.
  extractResponseData(result);
  return result;
}

function environmentFromProcess(env) {
  const required = ["COMPOSIO_API_KEY", "COMPOSIO_GOOGLE_CALENDAR_USER_ID", "COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID", "COMPOSIO_GOOGLE_CALENDAR_TOOLKIT_VERSION", "TEAM_A_CALENDAR_ID", "TEAM_B_CALENDAR_ID"];
  for (const key of required) if (!env[key]?.trim()) throw new Error(`Missing required environment variable: ${key}`);
  const calendarIds = { team_a: env.TEAM_A_CALENDAR_ID.trim(), team_b: env.TEAM_B_CALENDAR_ID.trim() };
  assertDedicatedTeamCalendars(calendarIds);
  return {
    apiKey: env.COMPOSIO_API_KEY,
    userId: env.COMPOSIO_GOOGLE_CALENDAR_USER_ID,
    connectedAccountId: env.COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID,
    toolkitVersion: env.COMPOSIO_GOOGLE_CALENDAR_TOOLKIT_VERSION,
    calendarIds,
  };
}

/**
 * This mirrors the runtime Calendar gateway's fail-closed routing boundary.
 * The seed is an operator tool and must never be the exception that permits a
 * personal/default calendar or two aliases for the same calendar.
 */
export function assertDedicatedTeamCalendars(calendarIds) {
  const teamA = calendarIds?.team_a?.trim();
  const teamB = calendarIds?.team_b?.trim();
  if (!isDedicatedGroupCalendarId(teamA) || !isDedicatedGroupCalendarId(teamB) || teamA.localeCompare(teamB, undefined, { sensitivity: "accent" }) === 0) {
    throw new Error("Exact distinct dedicated Team A and Team B Google group calendar IDs are required");
  }
  return { team_a: teamA, team_b: teamB };
}

function isDedicatedGroupCalendarId(calendarId) {
  if (!calendarId) return false;
  const normalized = calendarId.toLocaleLowerCase();
  return normalized.endsWith("@group.calendar.google.com")
    && !["primary", "default", "personal", "my calendar", "my-calendar", "me"].includes(normalized);
}

function isSameDemoEvent(event, desired) {
  return event.summary === desired.summary
    && event.description === DEMO_EVENT_DESCRIPTION
    && localEventDateTime(event.start) === desired.startDatetime
    && localEventDateTime(event.end) === desired.endDatetime;
}

/** A dry-run is completely local. --apply is required before any provider call. */
export async function runDemoCalendarSeed({ argv = process.argv.slice(2), env = process.env, write = console.log }) {
  const { apply, corrections } = parseCli(argv);
  if (!apply) {
    write(JSON.stringify({ mode: "dry-run", creates: DEMO_CALENDAR_EVENTS.length, corrections: corrections.length, externalWrites: 0 }));
    return { mode: "dry-run", creates: DEMO_CALENDAR_EVENTS.length, corrections: corrections.length, externalWrites: 0 };
  }

  const environment = environmentFromProcess(env);
  const composio = new Composio({ apiKey: environment.apiKey, toolkitVersions: { googlecalendar: environment.toolkitVersion } });
  const byTeam = {
    team_a: await listEvents(composio, environment, environment.calendarIds.team_a),
    team_b: await listEvents(composio, environment, environment.calendarIds.team_b),
  };
  const result = { mode: "apply", created: 0, updated: 0, unchanged: 0, corrected: 0 };

  for (const correction of corrections) {
    const current = byTeam[correction.team].find((event) => event?.id === correction.eventId);
    if (!current) throw new Error(`Explicit correction target not found in its Team calendar: ${correction.eventId}`);
    // This extra guard applies only after the operator supplied the exact ID.
    // It prevents an accidental update of an arbitrary real event.
    if (!isExpectedExplicitLegacyCorrection(current, correction)) {
      throw new Error(`Explicit correction target is not an expected synthetic reservation: ${correction.eventId}`);
    }
    await execute(composio, environment, "GOOGLECALENDAR_UPDATE_EVENT", correctionUpdateArguments({ current, correction, calendarId: environment.calendarIds[correction.team] }));
    result.corrected += 1;
  }

  for (const entry of DEMO_CALENDAR_EVENTS) {
    const matches = byTeam[entry.team].filter((event) => eventKey(event) === entry.key);
    if (matches.length > 1) throw new Error(`Duplicate owned demo events found for ${entry.key}; refusing to choose one`);
    const existing = matches[0];
    if (!existing) {
      await execute(composio, environment, "GOOGLECALENDAR_CREATE_EVENT", demoEventArguments(entry, environment.calendarIds[entry.team]));
      result.created += 1;
    } else if (isSameDemoEvent(existing, entry)) {
      result.unchanged += 1;
    } else {
      await execute(composio, environment, "GOOGLECALENDAR_UPDATE_EVENT", demoEventUpdateArguments(entry, environment.calendarIds[entry.team], existing.id));
      result.updated += 1;
    }
  }
  write(JSON.stringify(result));
  return result;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runDemoCalendarSeed({})
    .catch((error) => { console.error(error instanceof Error ? error.message : "Calendar demo seed failed"); process.exitCode = 1; });
}
