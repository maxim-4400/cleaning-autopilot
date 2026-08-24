"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { browserSupabaseAuth, type BrowserSession, type BrowserSessionCheck } from "@/components/demo-console/browser-supabase-auth";

type ConsoleSessionState = { kind: "checking" } | BrowserSessionCheck;
const sessionCheckTimeoutMs = 4_000;

export function useConsoleSession() {
  const [state, setState] = useState<ConsoleSessionState>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => { if (active) setState({ kind: "unavailable" }); }, sessionCheckTimeoutMs);
    void browserSupabaseAuth.getSession().then((result) => {
      if (!active) return;
      window.clearTimeout(timeout);
      setState(result);
    });
    return () => { active = false; window.clearTimeout(timeout); };
  }, [attempt]);

  return { retry: () => { setState({ kind: "checking" }); setAttempt((value) => value + 1); }, state };
}

export function ConsoleGuard({ children }: { children: (session: BrowserSession) => React.ReactNode }) {
  const { retry, state } = useConsoleSession();
  const pathname = usePathname();
  const router = useRouter();
  const loginHref = `/login?next=${encodeURIComponent(pathname)}`;

  useEffect(() => {
    if (state.kind === "anonymous") router.replace(loginHref);
  }, [loginHref, router, state.kind]);

  if (state.kind === "authenticated") return <>{children(state.session)}</>;
  if (state.kind === "unavailable") {
    const clearAndSignIn = async () => { await browserSupabaseAuth.clearSession(); router.replace(loginHref); };
    return <main aria-labelledby="auth-unavailable-title" className="grid min-h-screen place-items-center bg-slate-50 p-6" role="status"><section className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><h1 className="text-3xl font-semibold tracking-tight text-slate-950" id="auth-unavailable-title">Secure sign-in is unavailable.</h1><p className="mt-4 text-base leading-7 text-slate-600">The Admin session could not be checked, so dashboard content remains hidden. Check the browser connection or public Auth configuration, then try again.</p><div className="mt-6 flex flex-wrap gap-3"><button className="min-h-11 rounded-xl bg-teal-700 px-4 text-sm font-bold text-white" onClick={retry} type="button">Retry session check</button><button className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700" onClick={() => void clearAndSignIn()} type="button">Clear local session and sign in</button></div><Link className="mt-5 inline-block text-sm font-bold text-teal-800 underline underline-offset-4" href={loginHref}>Go to sign in</Link></section></main>;
  }
  return <main aria-live="polite" className="grid min-h-screen place-items-center bg-slate-50 text-sm text-slate-600">Checking secure Admin session…</main>;
}
