"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { browserSupabaseAuth } from "@/components/demo-console/browser-supabase-auth";
import { CaseStoryConsole } from "@/components/demo-console/case-story-console";
import { ConsoleHeader } from "@/components/demo-console/console-header";
import { ConsoleGuard } from "@/components/demo-console/console-guard";
import type { ConsoleReadModel } from "@/components/demo-console/demo-console-types";

export function DashboardClient({ miroBoardUrl, miroEmbedUrl, teamCalendarEmbedUrls }: { miroBoardUrl?: string; miroEmbedUrl?: string; teamCalendarEmbedUrls?: { teamA?: string; teamB?: string } }) {
  return <ConsoleGuard>{(session) => <DashboardData accessToken={session.accessToken} miroBoardUrl={miroBoardUrl} miroEmbedUrl={miroEmbedUrl} teamCalendarEmbedUrls={teamCalendarEmbedUrls} />}</ConsoleGuard>;
}

function DashboardData({ accessToken, miroBoardUrl, miroEmbedUrl, teamCalendarEmbedUrls }: { accessToken: string; miroBoardUrl?: string; miroEmbedUrl?: string; teamCalendarEmbedUrls?: { teamA?: string; teamB?: string } }) {
  const router = useRouter();
  const [model, setModel] = useState<ConsoleReadModel>();
  const [state, setState] = useState<"loading" | "ready" | "paused">("loading");
  const [lastRefreshed, setLastRefreshed] = useState<string>();
  const [readFailure, setReadFailure] = useState<string>();
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const response = await fetch("/api/admin/dashboard", { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" }).catch(() => undefined);
      if (!active) return;
      if (response?.ok) {
        const data: unknown = await response.json().catch(() => undefined);
        if (isReadModel(data)) { setModel(data); setState("ready"); setLastRefreshed(new Date().toISOString()); setReadFailure(undefined); return; }
      }
      if (response?.status === 401) { void browserSupabaseAuth.clearSession(); router.replace("/login?next=/dashboard"); }
      setReadFailure(response?.status === 503 ? "The dashboard source is temporarily unavailable." : "The dashboard could not be read.");
      setState("paused");
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener("focus", refresh); };
  }, [accessToken, router]);
  return <><ConsoleHeader active="dashboard" />{model ? <CaseStoryConsole miroBoardUrl={miroBoardUrl} miroEmbedUrl={miroEmbedUrl} teamCalendarEmbedUrls={teamCalendarEmbedUrls} pollingState={state} readFailure={readFailure} readModel={model} refreshedAt={lastRefreshed} /> : <main aria-live="polite" className="grid min-h-screen place-items-center bg-slate-50 px-6 text-center text-sm text-slate-600 md:ml-[232px]">{state === "loading" ? "Loading current operational proof…" : `${readFailure ?? "The dashboard could not be read."} Updates are paused; no prior snapshot is available.`}</main>}</>;
}

function isReadModel(value: unknown): value is ConsoleReadModel {
  return typeof value === "object" && value !== null && "integrations" in value && Array.isArray(value.integrations) && "latestLeadActivity" in value && Array.isArray(value.latestLeadActivity) && "trelloBoard" in value && "currentStatus" in value && "currentStatusDetail" in value && "snapshotKind" in value;
}
