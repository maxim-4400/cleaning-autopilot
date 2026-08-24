import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { IntegrationConfigurationError, parseCalendarEnvironment } from "@/lib/env/server";

const environment = {
  COMPOSIO_API_KEY: "test-key",
  COMPOSIO_GOOGLE_CALENDAR_USER_ID: "test-user",
  COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID: "test-account",
  COMPOSIO_GOOGLE_CALENDAR_TOOLKIT_VERSION: "20260824_01",
  TEAM_A_CALENDAR_ID: "team-a@group.calendar.google.com",
  TEAM_B_CALENDAR_ID: "team-b@group.calendar.google.com",
};

describe("dedicated Team Calendar configuration", () => {
  it("requires two distinct Google group calendars", () => {
    expect(parseCalendarEnvironment(environment)).toMatchObject({
      TEAM_A_CALENDAR_ID: environment.TEAM_A_CALENDAR_ID,
      TEAM_B_CALENDAR_ID: environment.TEAM_B_CALENDAR_ID,
    });
    expect(() => parseCalendarEnvironment({ ...environment, TEAM_A_CALENDAR_ID: "primary" })).toThrow(IntegrationConfigurationError);
    expect(() => parseCalendarEnvironment({ ...environment, TEAM_A_CALENDAR_ID: "owner@example.com" })).toThrow(IntegrationConfigurationError);
    expect(() => parseCalendarEnvironment({ ...environment, TEAM_B_CALENDAR_ID: environment.TEAM_A_CALENDAR_ID })).toThrow(IntegrationConfigurationError);
  });
});
