import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "3000";
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `NEXT_PUBLIC_SUPABASE_URL=https://auth.test NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=test-publishable-key NEXT_PUBLIC_TEAM_A_CALENDAR_EMBED_URL=https://calendar.google.com/calendar/embed?src=team-a%40example.test NEXT_PUBLIC_TEAM_B_CALENDAR_EMBED_URL=https://calendar.google.com/calendar/embed?src=team-b%40example.test MIRO_BOARD_URL=https://miro.com/app/board/uXdemo/?share_link_id=104117806222 MIRO_EMBED_URL=https://miro.com/app/board/uXdemo/?share_link_id=104117806222\\&embed=1 ${process.execPath} node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
