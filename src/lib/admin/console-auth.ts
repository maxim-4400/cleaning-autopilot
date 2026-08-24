import "server-only";

import { z } from "zod";

const userSchema = z.object({ id: z.string().uuid() }).passthrough();
const profileSchema = z.object({ role: z.literal("admin") }).passthrough();

/**
 * Mutations rely on a real Supabase Auth access token plus the existing
 * `profiles.role=admin` record. There is intentionally no environment-token
 * bypass: until a browser has an authenticated Supabase session, the admin
 * API remains unavailable.
 */
export async function assertConsoleAdminRequest(request: Request): Promise<void> {
  const accessToken = bearerToken(request.headers.get("authorization"));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!accessToken || !url || !secretKey) throw new ConsoleAdminAuthorizationError();

  const baseUrl = url.replace(/\/$/, "");
  let userResponse: Response;
  try {
    userResponse = await fetch(`${baseUrl}/auth/v1/user`, {
      headers: { apikey: secretKey, authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
  } catch {
    throw new ConsoleAdminAuthorizationError();
  }
  const user = userSchema.safeParse(await userResponse.json().catch(() => undefined));
  if (!userResponse.ok || !user.success) throw new ConsoleAdminAuthorizationError();

  let profileResponse: Response;
  try {
    profileResponse = await fetch(
      `${baseUrl}/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.data.id)}&select=role&limit=1`,
      { headers: { apikey: secretKey, authorization: `Bearer ${secretKey}`, accept: "application/json" }, cache: "no-store" },
    );
  } catch {
    throw new ConsoleAdminAuthorizationError();
  }
  const profiles = z.array(profileSchema).safeParse(await profileResponse.json().catch(() => undefined));
  if (!profileResponse.ok || !profiles.success || profiles.data.length !== 1) throw new ConsoleAdminAuthorizationError();
}

export class ConsoleAdminAuthorizationError extends Error {
  constructor() {
    super("Demo Console administrator authorization is required");
    this.name = "ConsoleAdminAuthorizationError";
  }
}

function bearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}
