import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/console-auth", () => {
  class ConsoleAdminAuthorizationError extends Error {}
  return { ConsoleAdminAuthorizationError, assertConsoleAdminRequest: vi.fn().mockResolvedValue(undefined) };
});

import { PATCH } from "@/app/api/admin/demo-console-config/route";

const originalConfigPath = process.env.DEMO_CONSOLE_CONFIG_PATH;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalConfigPath === undefined) delete process.env.DEMO_CONSOLE_CONFIG_PATH;
  else process.env.DEMO_CONSOLE_CONFIG_PATH = originalConfigPath;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Demo Console configuration PATCH", () => {
  it.each([
    { section: "prompt", expectedRevision: "a".repeat(64) },
    { section: "pricing", expectedRevision: "b".repeat(64) },
  ])("returns 400 without a required $section payload field", async (body) => {
    const directory = await mkdtemp(join(tmpdir(), "cleaning-demo-config-route-"));
    temporaryDirectories.push(directory);
    process.env.DEMO_CONSOLE_CONFIG_PATH = join(directory, "active.json");

    const response = await PATCH(new Request("https://app.test/api/admin/demo-console-config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_configuration" });
  });
});
