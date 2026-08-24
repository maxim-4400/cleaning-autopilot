"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { browserSupabaseAuth } from "@/components/demo-console/browser-supabase-auth";
import { ConfigurationEditors } from "@/components/demo-console/configuration-editors";
import { ConsoleHeader } from "@/components/demo-console/console-header";
import { ConsoleGuard } from "@/components/demo-console/console-guard";
import type { PricingRules } from "@/lib/contracts/domain";

type Config = { systemPrompt: string; pricingRules: PricingRules; source: "baseline" | "active"; version?: string | number; savedAt?: string; revision?: string };

export function SettingsClient() { return <ConsoleGuard>{(session) => <SettingsData accessToken={session.accessToken} />}</ConsoleGuard>; }

function SettingsData({ accessToken }: { accessToken: string }) {
  const router = useRouter();
  const [config, setConfig] = useState<Config>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void fetch("/api/admin/demo-console-config", { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" }).then(async (response) => {
      if (response.status === 401) { void browserSupabaseAuth.clearSession(); router.replace("/login?next=/settings"); return; }
      const data: unknown = await response.json().catch(() => undefined);
      if (response.ok && isConfig(data)) setConfig(data);
      else setError("Configuration is unavailable right now.");
    }).catch(() => setError("Configuration is unavailable right now."));
  }, [accessToken, router]);
  return <><ConsoleHeader active="settings" />{!config ? <main aria-live="polite" className="grid min-h-screen place-items-center bg-slate-50 px-6 text-center text-sm text-slate-600 md:ml-[232px]">{error ?? "Loading saved configuration…"}</main> : <main className="min-h-screen bg-slate-50 pb-16 pt-20 text-slate-900 md:ml-[232px] md:pt-12"><div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8"><section className="mb-8 max-w-3xl"><h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Agent behaviour and pricing.</h1><p className="mt-4 text-base leading-7 text-slate-600">Update the prompt or pricing separately. The backend validates pricing and writes a single safe active snapshot.</p></section><ConfigurationEditors accessToken={accessToken} pricingRules={config.pricingRules} prompt={config.systemPrompt} revision={config.revision} savedAt={config.savedAt} source={config.source} version={config.version} /></div></main>}</>;
}

function isConfig(value: unknown): value is Config { return typeof value === "object" && value !== null && "systemPrompt" in value && typeof value.systemPrompt === "string" && "pricingRules" in value && typeof value.pricingRules === "object" && value.pricingRules !== null && "source" in value && (value.source === "baseline" || value.source === "active") && (!("version" in value) || typeof value.version === "string" || typeof value.version === "number") && (!("savedAt" in value) || typeof value.savedAt === "string") && (!("revision" in value) || typeof value.revision === "string"); }
