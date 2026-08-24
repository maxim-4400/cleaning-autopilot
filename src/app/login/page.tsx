import Image from "next/image";
import { Suspense } from "react";
import { LoginForm } from "@/components/demo-console/login-form";

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-gradient-to-br from-teal-50 via-white to-amber-50 p-6"><section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-200/50 sm:p-9"><Image alt="Sherlock Cleaning Telegram bot avatar" className="rounded-2xl object-cover" height={72} priority src="/sherlock-cleaning-avatar.png" width={72} /><h1 className="mt-6 text-4xl font-semibold tracking-tight text-slate-950">Welcome back.</h1><p className="mt-4 text-base leading-7 text-slate-600">Sign in as the project Admin to review the live showcase and change agent configuration.</p><Suspense fallback={<p aria-live="polite" className="mt-6 text-sm text-slate-500">Preparing sign in…</p>}><LoginForm /></Suspense></section></main>
  );
}
