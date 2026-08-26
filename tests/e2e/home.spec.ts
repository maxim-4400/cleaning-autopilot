import { expect, type Page, test } from "@playwright/test";

const dashboardFixture = {
  generatedAt: "2026-08-23T09:45:00.000Z", snapshotKind: "application_snapshot", providerState: "not_live_checked", currentStatus: "terminal", currentStatusDetail: "Booking confirmed in the application snapshot",
  integrations: [
    { id: "telegram", label: "Telegram", readiness: "ready", detail: "Recent operation succeeded" },
    { id: "openai", label: "OpenAI", readiness: "ready", detail: "Recent operation succeeded" },
    { id: "google_calendar", label: "Google Calendar", readiness: "ready", detail: "Recent operation succeeded" },
    { id: "trello", label: "Trello", readiness: "ready", detail: "Recent operation succeeded" },
  ],
  latestLead: { businessReference: "DEMO-001", lifecycle: "booked", cleaningType: "standard", areaM2: 75, preferredDate: "2026-09-03", humanNeeded: false, quotedPriceRsd: 6500, assignedTeam: "team_a", bookedStart: "2026-09-03T08:00:00.000Z", bookingConfirmed: true },
  latestLeadActivity: [{ eventType: "booking_confirmed", occurredAt: "2026-08-23T09:45:00.000Z" }],
  trelloBoard: { kind: "projection", freshness: "fresh", observedAt: "2026-08-23T09:45:00.000Z", boardUrl: "https://trello.com/b/demo-board", cards: [{ title: "Standard cleaning · 75 m²", lifecycle: "booked", humanNeeded: false }] },
};

const configSectionsFixture = {
  prompt: { mode: "baseline", semanticRevision: "mvp-0.9.1", shippedBaselineRevision: "mvp-0.9.1", sha256: "a".repeat(64), revision: "b".repeat(64) },
  pricing: { mode: "baseline", semanticRevision: "mvp-0.9.1", shippedBaselineRevision: "mvp-0.9.1", sha256: "c".repeat(64), revision: "d".repeat(64) },
};

async function mockAuthenticatedConsole(page: Page, loginPath = "/login") {
  await page.route("https://auth.test/auth/v1/token?grant_type=password", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ access_token: "test-access-token", refresh_token: "test-refresh-token", expires_in: 3600, token_type: "bearer", user: { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "admin@example.test" } }) }));
  await page.route("**/api/admin/dashboard", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(dashboardFixture) }));
  await page.route("**/api/admin/demo-console-config", async (route) => {
    const pricingRules = { version: 1, standardRateRsdPerM2: 80, standardMinimumRsd: 4000, deepRateRsdPerM2: 160, deepMinimumRsd: 9000, extraBathroomRsd: 500, heavyPetHairRsd: 900, extrasRsd: { windows: 900, oven_inside: 1000, fridge_inside: 900, balcony_or_terrace: 1000 }, sameDayMultiplierPercent: 120, volumeDiscountPercent: { upTo100: 0, from101To150: 5, from151To200: 10 } };
    const saved = route.request().method() === "PATCH";
    const sections = saved ? { ...configSectionsFixture, prompt: { mode: "custom", semanticRevision: "custom", shippedBaselineRevision: "mvp-0.9.1", sha256: "f".repeat(64), revision: "0".repeat(64) } } : configSectionsFixture;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ systemPrompt: saved ? "Updated combined prompt" : "Current prompt", pricingRules, source: saved ? "active" : "baseline", revision: "e".repeat(64), sections }) });
  });
  await page.goto(loginPath);
  await page.getByLabel("Email").fill("admin@example.test");
  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test("redirects an unauthenticated dashboard visitor to sign in", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await expect(page.getByText("View the read-only showcase")).toHaveCount(0);
});

test("shows current evidence before confirmed same-lead history", async ({ page }) => {
  await mockAuthenticatedConsole(page);
  await page.waitForTimeout(4_200);
  await expect(page.getByRole("heading", { name: "Secure sign-in is unavailable." })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Real-time information about the latest lead" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Real-time information about the latest lead" })).toContainText("Booking confirmed in the application snapshot");
  await expect(page.getByLabel("Latest lead activity")).toContainText("Booking confirmed");
  await expect(page.getByText("Times shown in Europe/Belgrade.")).toBeVisible();
  await expect(page.getByLabel("Read-only Trello lifecycle projection")).toBeVisible();
  const trelloProjection = page.getByLabel("Read-only Trello lifecycle projection");
  for (const lifecycle of ["New Lead", "Qualified", "Booked", "Done", "Lost"]) await expect(trelloProjection).toContainText(lifecycle);
  await expect(page.getByTitle("Team A public calendar")).toHaveAttribute("src", /calendar\.google\.com\/calendar\/embed/);
  await expect(page.getByTitle("Team B public calendar")).toHaveAttribute("src", /calendar\.google\.com\/calendar\/embed/);
  await expect(page.getByTitle("Sherlock Cleaning project Miro board")).toHaveAttribute("src", /miro\.com\/app\/live-embed\/uXdemo\/\?embedMode=view_only_without_ui&moveToViewport=0%2C0%2C100%2C100/);
  await expect(page.getByRole("link", { name: "Open Miro ↗" })).toHaveAttribute("href", "https://miro.com/app/board/uXdemo/");
});

test("does not label a pending booked lifecycle as a confirmed booking", async ({ page }) => {
  const pendingFixture = { ...dashboardFixture, currentStatus: "recovery", currentStatusDetail: "Retrying Trello sync", latestLead: { ...dashboardFixture.latestLead, bookingConfirmed: false } };
  await page.route("https://auth.test/auth/v1/token?grant_type=password", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ access_token: "test-access-token", refresh_token: "test-refresh-token", expires_in: 3600, token_type: "bearer", user: { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "admin@example.test" } }) }));
  await page.route("**/api/admin/dashboard", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(pendingFixture) }));
  await page.route("**/api/admin/demo-console-config", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ systemPrompt: "Current prompt", pricingRules: { version: 1, standardRateRsdPerM2: 80, standardMinimumRsd: 4000, deepRateRsdPerM2: 160, deepMinimumRsd: 9000, extraBathroomRsd: 500, heavyPetHairRsd: 900, extrasRsd: { windows: 900, oven_inside: 1000, fridge_inside: 900, balcony_or_terrace: 1000 }, sameDayMultiplierPercent: 120, volumeDiscountPercent: { upTo100: 0, from101To150: 5, from151To200: 10 } }, source: "baseline", revision: "e".repeat(64), sections: configSectionsFixture }) }));
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@example.test");
  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("region", { name: "Real-time information about the latest lead" })).toContainText("Retrying Trello sync");
  await expect(page.getByText("03 Sep, 10:00 · Team A")).toHaveCount(0);
  await expect(page.getByText("Requested date")).toBeVisible();
});

test("rejects an external next destination after sign in", async ({ page }) => {
  await mockAuthenticatedConsole(page, "/login?next=%2F%2Fevil.example");
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("uses an accessible mobile hamburger drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAuthenticatedConsole(page);
  const trigger = page.getByRole("button", { name: "Open navigation" });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
});

test("lets a desktop reviewer collapse and reopen the navigation", async ({ page }) => {
  await mockAuthenticatedConsole(page);
  await page.getByRole("button", { name: "Collapse navigation" }).click();
  const open = page.getByRole("button", { name: "Open navigation" });
  await expect(open).toBeVisible();
  await open.click();
  await expect(page.getByRole("complementary", { name: "Console navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse navigation" })).toBeVisible();
});

test("keeps protected proof and menu usable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAuthenticatedConsole(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("textbox", { name: "Main Prompt" })).toBeVisible();
  await expect(page.getByText("Prompt: Using the latest project defaults")).toBeVisible();
  await expect(page.getByText("Pricing: Using the latest project defaults")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save prompt" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore project defaults" })).toHaveCount(2);
  await page.getByRole("textbox", { name: "Main Prompt" }).fill("Updated combined prompt");
  await page.getByRole("button", { name: "Save prompt" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Prompt: Custom version saved. Latest project defaults are available")).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
});

test("requires a focused confirmation before restoring one configuration section", async ({ page }) => {
  await mockAuthenticatedConsole(page);
  await page.getByRole("complementary", { name: "Console navigation" }).getByRole("link", { name: "Settings" }).click();
  const confirmation = new Promise<void>((resolve, reject) => {
    page.once("dialog", (dialog) => {
      try {
        expect(dialog.type()).toBe("confirm");
        expect(dialog.message()).toContain("only the pricing settings");
        expect(dialog.message()).toContain("Restore project defaults");
        expect(dialog.message()).toContain("other section");
      } catch (error) {
        reject(error);
        return;
      }
      void dialog.dismiss().then(resolve, reject);
    });
  });
  await page.getByRole("button", { name: "Restore project defaults" }).nth(1).click();
  await confirmation;
  await expect(page.getByText("Project defaults restored", { exact: true })).toHaveCount(0);
});

test("retains the secure header and menu when configuration cannot be read", async ({ page }) => {
  await mockAuthenticatedConsole(page);
  await page.unroute("**/api/admin/demo-console-config");
  await page.route("**/api/admin/demo-console-config", async (route) => route.fulfill({ contentType: "application/json", status: 500, body: JSON.stringify({ error: "configuration_unavailable" }) }));
  await page.goto("/settings");
  await expect(page.getByText("Configuration is unavailable right now.")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Console navigation" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
});

test("keeps the last confirmed snapshot visible when dashboard updates fail", async ({ page }) => {
  let calls = 0;
  await page.route("https://auth.test/auth/v1/token?grant_type=password", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ access_token: "test-access-token", refresh_token: "test-refresh-token", expires_in: 3600, token_type: "bearer", user: { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "admin@example.test" } }) }));
  await page.route("**/api/admin/dashboard", async (route) => {
    calls += 1;
    // React strict-mode development startup may discard the first effect run.
    if (calls <= 2) return route.fulfill({ contentType: "application/json", body: JSON.stringify(dashboardFixture) });
    return route.fulfill({ contentType: "application/json", status: 503, body: JSON.stringify({ error: "dashboard_unavailable" }) });
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@example.test");
  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("region", { name: "Real-time information about the latest lead" })).toContainText("Standard cleaning · 75 m²");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(50);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("region", { name: "Real-time information about the latest lead" })).toContainText("Updates paused. The dashboard source is temporarily unavailable.");
  await expect(page.getByRole("region", { name: "Real-time information about the latest lead" })).toContainText("Standard cleaning · 75 m²");
});

test("offers a direct card only when the safe dashboard DTO supplies one", async ({ page }) => {
  const humanNeededFixture = { ...dashboardFixture, currentStatus: "human_needed", currentStatusDetail: "Human review is required", latestLead: { ...dashboardFixture.latestLead, humanNeeded: true, trelloCardUrl: "https://trello.com/c/safe-demo-card" } };
  await page.route("https://auth.test/auth/v1/token?grant_type=password", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ access_token: "test-access-token", refresh_token: "test-refresh-token", expires_in: 3600, token_type: "bearer", user: { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "admin@example.test" } }) }));
  await page.route("**/api/admin/dashboard", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(humanNeededFixture) }));
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@example.test");
  await page.getByLabel("Password").fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Open this Trello card ↗" })).toHaveAttribute("href", "https://trello.com/c/safe-demo-card");
});
