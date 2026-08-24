"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type BrowserSession = { accessToken: string };
export type BrowserSessionCheck =
  | { kind: "authenticated"; session: BrowserSession }
  | { kind: "anonymous" }
  | { kind: "unavailable" };

let client: SupabaseClient | undefined;

function getClient(): SupabaseClient | undefined {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) return undefined;
  client = createClient(url, publishableKey, { auth: { autoRefreshToken: true, detectSessionInUrl: false, persistSession: true } });
  return client;
}

export const browserSupabaseAuth = {
  async getSession(): Promise<BrowserSessionCheck> {
    const supabase = getClient();
    if (!supabase) return { kind: "unavailable" };
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) return { kind: "unavailable" };
      return data.session ? { kind: "authenticated", session: { accessToken: data.session.access_token } } : { kind: "anonymous" };
    } catch { return { kind: "unavailable" }; }
  },
  async signInWithPassword({ email, password }: { email: string; password: string }): Promise<{ data?: BrowserSession; error?: string }> {
    const supabase = getClient();
    if (!supabase) return { error: "Supabase browser configuration is unavailable" };
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) return { error: error?.message ?? "Email or password was not accepted" };
    return { data: { accessToken: data.session.access_token } };
  },
  async signOut(): Promise<void> { await getClient()?.auth.signOut(); },
  async clearSession(): Promise<void> { await getClient()?.auth.signOut({ scope: "local" }); },
};
