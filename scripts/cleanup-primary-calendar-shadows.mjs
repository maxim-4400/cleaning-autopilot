import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Composio } from "@composio/core";

import { assertDedicatedTeamCalendars } from "./seed-calendar-demo-load.mjs";

const PRIMARY_CALENDAR_ID = "primary";
const APPLY_CONFIRMATION = "--confirm-primary-shadow-cleanup";

/**
 * This utility deliberately does not discover deletion candidates. An
 * operator supplies an exact manifest made from a read-only reconciliation.
 * Default mode only reads the three configured calendars and reports whether
 * every declared primary copy still matches its specified Team A/B original.
 */
export function parsePrimaryShadowCleanupCli(argv) {
  const apply = argv.includes("--apply");
  const confirm = argv.includes(APPLY_CONFIRMATION);
  const manifestArgument = argv.find((argument) => argument.startsWith("--manifest="));
  const hashArgument = argv.find((argument) => argument.startsWith("--manifest-sha256="));
  const unknown = argv.filter((argument) => argument !== "--apply" && argument !== APPLY_CONFIRMATION && !argument.startsWith("--manifest=") && !argument.startsWith("--manifest-sha256="));
  if (unknown.length > 0) throw new Error(`Unsupported arguments: ${unknown.join(" ")}`);
  if (!manifestArgument || manifestArgument === "--manifest=") throw new Error("An exact --manifest=path is required");
  if (argv.filter((argument) => argument.startsWith("--manifest=")).length !== 1) throw new Error("Only one --manifest is allowed");
  if (argv.filter((argument) => argument.startsWith("--manifest-sha256=")).length > 1) throw new Error("Only one --manifest-sha256 is allowed");
  if (confirm && !apply) throw new Error(`${APPLY_CONFIRMATION} is meaningful only with --apply`);
  if (apply && !confirm) throw new Error(`--apply requires ${APPLY_CONFIRMATION}`);
  if (apply && !hashArgument) throw new Error("--apply requires the SHA-256 reported by the preceding dry-run via --manifest-sha256");
  if (!apply && hashArgument) throw new Error("--manifest-sha256 is meaningful only with --apply");
  const manifestSha256 = hashArgument?.slice("--manifest-sha256=".length);
  if (manifestSha256 !== undefined && !/^[a-f0-9]{64}$/.test(manifestSha256)) throw new Error("--manifest-sha256 must be a lowercase SHA-256 hash");
  return { apply, manifestPath: manifestArgument.slice("--manifest=".length), manifestSha256 };
}

export function manifestSha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Manifest fields are intentionally structural and contain only provider
 * identifiers. It contains no customer data, titles, descriptions or secrets.
 */
export function parsePrimaryShadowCleanupManifest(value) {
  if (!isRecord(value)) throw new Error("Cleanup manifest must be a JSON object");
  assertExactKeys(value, ["version", "target", "teamCalendars", "window", "candidates"], "Cleanup manifest");
  if (value.version !== 1) throw new Error("Cleanup manifest version must be 1");
  if (!isRecord(value.target)) throw new Error("Cleanup manifest target must be an object");
  assertExactKeys(value.target, ["calendarId"], "Cleanup manifest target");
  if (value.target.calendarId !== PRIMARY_CALENDAR_ID) throw new Error("Cleanup manifest target calendarId must be exactly primary");
  if (!isRecord(value.teamCalendars)) throw new Error("Cleanup manifest teamCalendars must be an object");
  assertExactKeys(value.teamCalendars, ["teamA", "teamB"], "Cleanup manifest teamCalendars");
  const teamCalendars = assertDedicatedTeamCalendars({ team_a: value.teamCalendars.teamA, team_b: value.teamCalendars.teamB });
  if (!isRecord(value.window)) throw new Error("Cleanup manifest window must be an object");
  assertExactKeys(value.window, ["timeMin", "timeMax"], "Cleanup manifest window");
  const window = { timeMin: assertIsoInstant(value.window.timeMin, "Cleanup manifest window.timeMin"), timeMax: assertIsoInstant(value.window.timeMax, "Cleanup manifest window.timeMax") };
  if (window.timeMin >= window.timeMax) throw new Error("Cleanup manifest window must have timeMin before timeMax");
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) throw new Error("Cleanup manifest requires one or more exact candidates");
  const candidates = value.candidates.map((candidate, index) => parseCandidate(candidate, index));
  if (new Set(candidates.map((candidate) => candidate.primaryEventId)).size !== candidates.length) throw new Error("Cleanup manifest primaryEventId values must be unique");
  if (new Set(candidates.map((candidate) => `${candidate.team}:${candidate.originalEventId}`)).size !== candidates.length) throw new Error("Cleanup manifest Team originals must be unique");
  return {
    version: 1,
    target: { calendarId: PRIMARY_CALENDAR_ID },
    teamCalendars: { teamA: teamCalendars.team_a, teamB: teamCalendars.team_b },
    window,
    candidates,
  };
}

function parseCandidate(value, index) {
  if (!isRecord(value)) throw new Error(`Cleanup manifest candidate ${index} must be an object`);
  assertExactKeys(value, ["primaryEventId", "team", "originalEventId", "iCalUID"], `Cleanup manifest candidate ${index}`);
  if (value.team !== "team_a" && value.team !== "team_b") throw new Error(`Cleanup manifest candidate ${index} team must be team_a or team_b`);
  return {
    primaryEventId: assertGoogleIdentifier(value.primaryEventId, `Cleanup manifest candidate ${index} primaryEventId`),
    team: value.team,
    originalEventId: assertGoogleIdentifier(value.originalEventId, `Cleanup manifest candidate ${index} originalEventId`),
    iCalUID: assertIcalUid(value.iCalUID, `Cleanup manifest candidate ${index} iCalUID`),
  };
}

export function reconcilePrimaryShadowCopies(manifest, events) {
  const primaryById = indexEvents(events.primary);
  const originals = { team_a: indexEvents(events.team_a), team_b: indexEvents(events.team_b) };
  const matches = [];
  const mismatches = [];
  for (const candidate of manifest.candidates) {
    const primary = primaryById.get(candidate.primaryEventId);
    const original = originals[candidate.team].get(candidate.originalEventId);
    if (!primary || !original) {
      mismatches.push({ primaryEventId: candidate.primaryEventId, reason: !primary ? "primary_event_missing" : "team_original_missing" });
      continue;
    }
    if (primary.status === "cancelled" || original.status === "cancelled") {
      mismatches.push({ primaryEventId: candidate.primaryEventId, reason: "cancelled_event" });
      continue;
    }
    if (primary.iCalUID !== candidate.iCalUID || original.iCalUID !== candidate.iCalUID || primary.iCalUID !== original.iCalUID) {
      mismatches.push({ primaryEventId: candidate.primaryEventId, reason: "ical_uid_mismatch" });
      continue;
    }
    matches.push({ primaryEventId: candidate.primaryEventId, team: candidate.team, originalEventId: candidate.originalEventId });
  }
  return { matches, mismatches };
}

function indexEvents(events) {
  if (!Array.isArray(events)) throw new Error("Calendar provider list response did not include event items");
  const byId = new Map();
  for (const event of events) {
    if (isRecord(event) && typeof event.id === "string" && event.id.length > 0) byId.set(event.id, event);
  }
  return byId;
}

function environmentFromProcess(env) {
  const required = ["COMPOSIO_API_KEY", "COMPOSIO_GOOGLE_CALENDAR_USER_ID", "COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID", "COMPOSIO_GOOGLE_CALENDAR_TOOLKIT_VERSION", "TEAM_A_CALENDAR_ID", "TEAM_B_CALENDAR_ID"];
  for (const key of required) if (!env[key]?.trim()) throw new Error(`Missing required environment variable: ${key}`);
  const calendarIds = assertDedicatedTeamCalendars({ team_a: env.TEAM_A_CALENDAR_ID, team_b: env.TEAM_B_CALENDAR_ID });
  return {
    apiKey: env.COMPOSIO_API_KEY,
    userId: env.COMPOSIO_GOOGLE_CALENDAR_USER_ID,
    connectedAccountId: env.COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID,
    toolkitVersion: env.COMPOSIO_GOOGLE_CALENDAR_TOOLKIT_VERSION,
    calendarIds,
  };
}

function assertManifestMatchesEnvironment(manifest, environment) {
  if (manifest.teamCalendars.teamA !== environment.calendarIds.team_a || manifest.teamCalendars.teamB !== environment.calendarIds.team_b) {
    throw new Error("Cleanup manifest Team calendar IDs must exactly match the configured Team A/B targets");
  }
}

async function listEvents(composio, environment, calendarId, window) {
  const result = await composio.tools.execute("GOOGLECALENDAR_EVENTS_LIST", {
    userId: environment.userId,
    connectedAccountId: environment.connectedAccountId,
    version: environment.toolkitVersion,
    arguments: { calendarId, timeMin: window.timeMin, timeMax: window.timeMax, singleEvents: true, showDeleted: false, maxResults: 250 },
  });
  const data = responseData(result);
  if (!isRecord(data) || !Array.isArray(data.items)) throw new Error("Calendar provider list response did not include event items");
  return data.items;
}

async function deletePrimaryShadow(composio, environment, primaryEventId) {
  const result = await composio.tools.execute("GOOGLECALENDAR_DELETE_EVENT", {
    userId: environment.userId,
    connectedAccountId: environment.connectedAccountId,
    version: environment.toolkitVersion,
    // This tool is purpose-built for this one target. Never substitute the
    // manifest's target string into a different calendar ID.
    arguments: { calendar_id: PRIMARY_CALENDAR_ID, event_id: primaryEventId, send_updates: "none" },
  });
  if (!isRecord(result) || result.successful === false) throw new Error("Google Calendar primary-shadow deletion was not confirmed");
}

/**
 * Read-only by default. Even with --apply, every candidate must match its
 * exact declared Team A/B original before this function can call delete.
 */
export async function runPrimaryShadowCleanup({ argv = process.argv.slice(2), env = process.env, write = console.log, readManifest = readFile, composioFactory = (environment) => new Composio({ apiKey: environment.apiKey, toolkitVersions: { googlecalendar: environment.toolkitVersion } }) }) {
  const { apply, manifestPath, manifestSha256: expectedManifestSha256 } = parsePrimaryShadowCleanupCli(argv);
  const rawManifest = await readManifest(manifestPath, "utf8");
  const actualManifestSha256 = manifestSha256(rawManifest);
  if (apply && expectedManifestSha256 !== actualManifestSha256) throw new Error("Cleanup manifest SHA-256 does not match the preceding dry-run");
  let parsedRaw;
  try {
    parsedRaw = JSON.parse(rawManifest);
  } catch {
    throw new Error("Cleanup manifest must be valid JSON");
  }
  const manifest = parsePrimaryShadowCleanupManifest(parsedRaw);
  const environment = environmentFromProcess(env);
  assertManifestMatchesEnvironment(manifest, environment);
  const composio = composioFactory(environment);
  const events = {
    primary: await listEvents(composio, environment, PRIMARY_CALENDAR_ID, manifest.window),
    team_a: await listEvents(composio, environment, environment.calendarIds.team_a, manifest.window),
    team_b: await listEvents(composio, environment, environment.calendarIds.team_b, manifest.window),
  };
  const reconciliation = reconcilePrimaryShadowCopies(manifest, events);
  const report = { mode: apply ? "apply" : "dry-run", targetCalendarId: PRIMARY_CALENDAR_ID, manifestSha256: actualManifestSha256, candidates: manifest.candidates.length, eligible: reconciliation.matches.length, blocked: reconciliation.mismatches.length, deleted: 0 };
  if (!apply) {
    write(JSON.stringify(report));
    return report;
  }
  if (reconciliation.mismatches.length > 0) throw new Error("Primary-shadow cleanup is blocked because one or more exact Team originals no longer match");
  for (const match of reconciliation.matches) await deletePrimaryShadow(composio, environment, match.primaryEventId);
  const applied = { ...report, deleted: reconciliation.matches.length };
  write(JSON.stringify(applied));
  return applied;
}

function responseData(result) {
  if (!isRecord(result) || result.successful === false || !isRecord(result.data)) throw new Error("Composio Calendar execution failed or returned an invalid envelope");
  return result.data.response_data ?? result.data;
}

function assertExactKeys(value, keys, subject) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${subject} has unsupported field: ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`${subject} requires ${key}`);
}

function assertGoogleIdentifier(value, subject) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{6,1024}$/.test(value)) throw new Error(`${subject} is invalid`);
  return value;
}

function assertIcalUid(value, subject) {
  if (typeof value !== "string" || value.length < 3 || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${subject} is invalid`);
  return value;
}

function assertIsoInstant(value, subject) {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime()) || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error(`${subject} must be an ISO datetime with timezone`);
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  runPrimaryShadowCleanup({})
    .catch((error) => { console.error(error instanceof Error ? error.message : "Primary-calendar cleanup failed"); process.exitCode = 1; });
}
