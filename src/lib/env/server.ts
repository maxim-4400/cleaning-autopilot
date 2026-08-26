import "server-only";

import { z } from "zod";

import { PINNED_TRELLO_TOOLKIT_VERSION } from "@/lib/trello/constants";

const nonEmpty = z.string().trim().min(1);
const integrationModeSchema = z.enum(["fake", "real"]);

const telegramEnvironmentSchema = z.object({
  TELEGRAM_BOT_TOKEN: nonEmpty.optional(),
  TELEGRAM_WEBHOOK_SECRET: nonEmpty,
});

const openAiEnvironmentSchema = z.object({
  OPENAI_API_KEY: nonEmpty,
  OPENAI_MODEL: nonEmpty.default("gpt-5.6-terra"),
  OPENAI_REASONING_EFFORT: z.enum(["low", "medium"]).default("low"),
});

const supabaseEnvironmentSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: nonEmpty,
});

const calendarEnvironmentSchema = z.object({
  COMPOSIO_API_KEY: nonEmpty,
  COMPOSIO_GOOGLE_CALENDAR_USER_ID: nonEmpty,
  COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID: nonEmpty,
  COMPOSIO_GOOGLE_CALENDAR_TOOLKIT_VERSION: z.string().regex(/^\d{8}_\d{2}$/),
  TEAM_A_CALENDAR_ID: nonEmpty,
  TEAM_B_CALENDAR_ID: nonEmpty,
}).superRefine((environment, context) => {
  const teamA = environment.TEAM_A_CALENDAR_ID.trim();
  const teamB = environment.TEAM_B_CALENDAR_ID.trim();
  if (!isDedicatedTeamCalendarId(teamA)) {
    context.addIssue({ code: "custom", path: ["TEAM_A_CALENDAR_ID"], message: "A dedicated Team A calendar ID is required" });
  }
  if (!isDedicatedTeamCalendarId(teamB)) {
    context.addIssue({ code: "custom", path: ["TEAM_B_CALENDAR_ID"], message: "A dedicated Team B calendar ID is required" });
  }
  if (teamA.localeCompare(teamB, undefined, { sensitivity: "accent" }) === 0) {
    context.addIssue({ code: "custom", path: ["TEAM_B_CALENDAR_ID"], message: "Team A and Team B calendars must be distinct" });
  }
});

const trelloEnvironmentSchema = z.object({
  COMPOSIO_API_KEY: nonEmpty,
  COMPOSIO_TRELLO_USER_ID: nonEmpty,
  COMPOSIO_TRELLO_CONNECTED_ACCOUNT_ID: nonEmpty,
  COMPOSIO_TRELLO_TOOLKIT_VERSION: z.literal(PINNED_TRELLO_TOOLKIT_VERSION),
  TRELLO_BOARD_ID: nonEmpty,
  TRELLO_HUMAN_NEEDED_LABEL_ID: nonEmpty,
});

const internalReconcileEnvironmentSchema = z.object({
  INTERNAL_RECONCILE_SECRET: nonEmpty,
});

export type TelegramEnvironment = z.infer<typeof telegramEnvironmentSchema>;
export type OpenAiEnvironment = z.infer<typeof openAiEnvironmentSchema>;
export type SupabaseEnvironment = z.infer<typeof supabaseEnvironmentSchema>;
export type CalendarEnvironment = z.infer<typeof calendarEnvironmentSchema>;
export type TrelloEnvironment = z.infer<typeof trelloEnvironmentSchema>;
export type InternalReconcileEnvironment = z.infer<typeof internalReconcileEnvironmentSchema>;

export class IntegrationConfigurationError extends Error {
  constructor(readonly missingVariables: string[]) {
    super(`Integration configuration is incomplete: ${missingVariables.join(", ")}`);
    this.name = "IntegrationConfigurationError";
  }
}

function parseEnvironment<T>(schema: z.ZodType<T>, source: Record<string, string | undefined>): T {
  const parsed = schema.safeParse(source);
  if (parsed.success) return parsed.data;

  const missingVariables = parsed.error.issues
    .map((issue) => issue.path[0])
    .filter((key): key is string => typeof key === "string");
  throw new IntegrationConfigurationError(missingVariables);
}

export function getTelegramEnvironment(): TelegramEnvironment {
  return parseEnvironment(telegramEnvironmentSchema, process.env);
}

export function getOpenAiEnvironment(): OpenAiEnvironment {
  return parseEnvironment(openAiEnvironmentSchema, process.env);
}

export function getSupabaseEnvironment(): SupabaseEnvironment {
  return parseEnvironment(supabaseEnvironmentSchema, process.env);
}

export function getCalendarEnvironment(): CalendarEnvironment {
  return parseCalendarEnvironment(process.env);
}

export function parseCalendarEnvironment(source: Record<string, string | undefined>): CalendarEnvironment {
  return parseEnvironment(calendarEnvironmentSchema, source);
}

/**
 * These aliases have special personal/default semantics in Google Calendar;
 * they can never identify one of the two dedicated operational calendars.
 * We intentionally do not guess or whitelist a calendar name or address.
 */
export function isUnsafeTeamCalendarAlias(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase();
  return normalized === "primary" ||
    normalized === "default" ||
    normalized === "personal" ||
    normalized === "my calendar" ||
    normalized === "my-calendar" ||
    normalized === "me";
}

export function isDedicatedTeamCalendarId(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase();
  return !isUnsafeTeamCalendarAlias(normalized) && normalized.endsWith("@group.calendar.google.com");
}

/**
 * A completely absent Trello configuration keeps the integration fail-closed
 * during staged rollout. A partial configuration is an operator error: do not
 * silently start an adapter against a different board or account.
 */
export function getOptionalTrelloEnvironment(): TrelloEnvironment | undefined {
  // COMPOSIO_API_KEY is shared with Calendar, so it cannot by itself mean a
  // Trello integration was intended.
  const keys: Array<Exclude<keyof TrelloEnvironment, "COMPOSIO_API_KEY">> = [
    "COMPOSIO_TRELLO_USER_ID",
    "COMPOSIO_TRELLO_CONNECTED_ACCOUNT_ID",
    "COMPOSIO_TRELLO_TOOLKIT_VERSION",
    "TRELLO_BOARD_ID",
    "TRELLO_HUMAN_NEEDED_LABEL_ID",
  ];
  if (keys.every((key) => !process.env[key])) return undefined;
  return parseEnvironment(trelloEnvironmentSchema, process.env);
}

export function getIntegrationMode(): "fake" | "real" {
  const parsed = integrationModeSchema.safeParse(process.env.INTEGRATION_MODE);
  if (parsed.success) return parsed.data;
  throw new IntegrationConfigurationError(["INTEGRATION_MODE"]);
}

export function getInternalReconcileEnvironment(): InternalReconcileEnvironment {
  return parseEnvironment(internalReconcileEnvironmentSchema, process.env);
}
