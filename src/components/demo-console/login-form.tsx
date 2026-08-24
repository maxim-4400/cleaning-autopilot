"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { browserSupabaseAuth } from "@/components/demo-console/browser-supabase-auth";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const next = searchParams.get("next");
  const destination = next === "/dashboard" || next === "/settings" ? next : "/dashboard";
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const result = await browserSupabaseAuth.signInWithPassword({ email, password });
    setPending(false);
    if (!result.data) return setError(result.error ?? "Could not sign in");
    router.replace(destination);
  };
  return <form className="mt-7 grid gap-4" onSubmit={submit}><label className="grid gap-1.5 text-sm font-bold text-slate-700">Email<input autoComplete="email" className="min-h-11 rounded-xl border border-slate-300 bg-slate-50 px-3 outline-none ring-teal-600 focus:ring-2" disabled={pending} name="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label><label className="grid gap-1.5 text-sm font-bold text-slate-700">Password<input autoComplete="current-password" className="min-h-11 rounded-xl border border-slate-300 bg-slate-50 px-3 outline-none ring-teal-600 focus:ring-2" disabled={pending} name="password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>{error && <p aria-live="polite" className="text-sm font-bold text-red-700">{error}</p>}<button className="min-h-11 rounded-xl bg-teal-700 px-4 text-sm font-bold text-white transition hover:bg-teal-800 disabled:opacity-50" disabled={pending} type="submit">{pending ? "Signing in…" : "Sign in"}</button></form>;
}
