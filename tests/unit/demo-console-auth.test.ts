import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ConsoleAdminAuthorizationError, assertConsoleAdminRequest } from "@/lib/admin/console-auth";

const originalEnvironment = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  secret: process.env.SUPABASE_SECRET_KEY,
};

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalEnvironment.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalEnvironment.url;
  if (originalEnvironment.secret === undefined) delete process.env.SUPABASE_SECRET_KEY;
  else process.env.SUPABASE_SECRET_KEY = originalEnvironment.secret;
});

describe("Demo Console administrator authorization", () => {
  it("requires a valid Supabase user session and an admin profile", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "service-role-test-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: "11111111-1111-4111-8111-111111111111" }))
      .mockResolvedValueOnce(Response.json([{ role: "admin" }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(assertConsoleAdminRequest(new Request("https://app.test", {
      headers: { authorization: "Bearer user-access-token" },
    }))).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed without an authenticated browser session", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;

    await expect(assertConsoleAdminRequest(new Request("https://app.test"))).rejects.toBeInstanceOf(ConsoleAdminAuthorizationError);
  });
});
