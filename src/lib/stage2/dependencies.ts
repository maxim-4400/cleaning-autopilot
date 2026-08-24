import { FakeAgentGateway, OpenAiAgentsGateway } from "@/lib/agent/gateway";
import { ComposioCalendarGateway, FakeCalendarGateway } from "@/lib/calendar/gateway";
import { CalendarReservationService } from "@/lib/calendar/reservation-service";
import {
  getIntegrationMode,
  getCalendarEnvironment,
  getOptionalTrelloEnvironment,
  getOpenAiEnvironment,
  getSupabaseEnvironment,
  getTelegramEnvironment,
  IntegrationConfigurationError,
} from "@/lib/env/server";
import { InMemoryLeadRepository } from "@/lib/leads/in-memory-repository";
import { SupabaseLeadRepository } from "@/lib/leads/supabase-repository";
import { FakeTelegramGateway, TelegramApiGateway } from "@/lib/telegram/gateway";
import type { Stage2Dependencies } from "@/lib/telegram/webhook";
import { ComposioTrelloGateway, FakeTrelloGateway, UnavailableTrelloGateway } from "@/lib/trello/gateway";
import { TrelloSyncService } from "@/lib/trello/sync-service";
import { TrelloRecoveryService } from "@/lib/trello/recovery-service";

let fakeDependencies: Stage2Dependencies | undefined;

export function getStage2Dependencies(): Stage2Dependencies {
  const mode = getIntegrationMode();
  if (mode === "fake") {
    if (!fakeDependencies) {
      const repository = new InMemoryLeadRepository();
      const telegram = new FakeTelegramGateway();
      const trelloSync = new TrelloSyncService(repository, new FakeTrelloGateway());
      const trelloRecovery = new TrelloRecoveryService(repository, trelloSync, telegram);
      fakeDependencies = {
        repository,
        agent: new FakeAgentGateway(),
        telegram,
        calendarReservation: new CalendarReservationService(repository, new FakeCalendarGateway()),
        trelloSync,
        trelloRecovery,
      };
    }
    return fakeDependencies;
  }

  const telegramEnvironment = getTelegramEnvironment();
  if (!telegramEnvironment.TELEGRAM_BOT_TOKEN) throw new IntegrationConfigurationError(["TELEGRAM_BOT_TOKEN"]);
  const openAi = getOpenAiEnvironment();
  const supabase = getSupabaseEnvironment();
  const calendar = getCalendarEnvironment();
  const trello = getOptionalTrelloEnvironment();
  const repository = new SupabaseLeadRepository({ url: supabase.NEXT_PUBLIC_SUPABASE_URL, secretKey: supabase.SUPABASE_SECRET_KEY });
  const telegram = new TelegramApiGateway(telegramEnvironment.TELEGRAM_BOT_TOKEN);
  const trelloSync = new TrelloSyncService(repository, trello ? new ComposioTrelloGateway({
    apiKey: trello.COMPOSIO_API_KEY,
    userId: trello.COMPOSIO_TRELLO_USER_ID,
    connectedAccountId: trello.COMPOSIO_TRELLO_CONNECTED_ACCOUNT_ID,
    toolkitVersion: trello.COMPOSIO_TRELLO_TOOLKIT_VERSION,
    boardId: trello.TRELLO_BOARD_ID,
    humanNeededLabelId: trello.TRELLO_HUMAN_NEEDED_LABEL_ID,
  }) : new UnavailableTrelloGateway());
  const trelloRecovery = new TrelloRecoveryService(repository, trelloSync, telegram);
  return {
    repository,
    agent: new OpenAiAgentsGateway(openAi.OPENAI_API_KEY, openAi.OPENAI_MODEL, openAi.OPENAI_REASONING_EFFORT),
    telegram,
    calendarReservation: new CalendarReservationService(repository, new ComposioCalendarGateway({
      apiKey: calendar.COMPOSIO_API_KEY,
      userId: calendar.COMPOSIO_GOOGLE_CALENDAR_USER_ID,
      connectedAccountId: calendar.COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID,
      toolkitVersion: calendar.COMPOSIO_GOOGLE_CALENDAR_TOOLKIT_VERSION,
      teamACalendarId: calendar.TEAM_A_CALENDAR_ID,
      teamBCalendarId: calendar.TEAM_B_CALENDAR_ID,
    })),
    trelloSync,
    trelloRecovery,
  };
}
