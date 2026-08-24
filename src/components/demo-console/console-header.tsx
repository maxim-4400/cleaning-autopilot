"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { browserSupabaseAuth } from "@/components/demo-console/browser-supabase-auth";

const navBase = "flex min-h-11 items-center rounded-xl px-3 text-sm font-bold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900";
const navActive = "bg-teal-50 text-teal-900";

export function ConsoleHeader({ active }: { active: "dashboard" | "settings" }) {
  const [open, setOpen] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(true);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const router = useRouter();
  const close = (focus = false) => { setOpen(false); if (focus) requestAnimationFrame(() => buttonRef.current?.focus()); };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(true); };
    const outside = (event: MouseEvent) => { if (open && !drawerRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) close(); };
    document.addEventListener("keydown", escape); document.addEventListener("mousedown", outside);
    return () => { document.removeEventListener("keydown", escape); document.removeEventListener("mousedown", outside); };
  }, [open]);
  useEffect(() => { if (open) drawerRef.current?.querySelector<HTMLElement>("a,button")?.focus(); }, [open]);
  useEffect(() => {
    document.documentElement.style.setProperty("--console-sidebar-width", desktopOpen ? "232px" : "0px");
    return () => { document.documentElement.style.removeProperty("--console-sidebar-width"); };
  }, [desktopOpen]);
  const logout = async () => { close(); await browserSupabaseAuth.signOut(); router.replace("/login"); };
  const navigation = <><Link aria-current={active === "dashboard" ? "page" : undefined} className={`${navBase} ${active === "dashboard" ? navActive : ""}`} href="/dashboard" onClick={() => close()}>Dashboard</Link><Link aria-current={active === "settings" ? "page" : undefined} className={`${navBase} ${active === "settings" ? navActive : ""}`} href="/settings" onClick={() => close()}>Settings</Link></>;
  const brand = <Link aria-label="Sherlock Cleaning dashboard" className="flex min-h-14 min-w-0 items-center gap-3 text-base font-bold text-slate-900 no-underline" href="/dashboard"><Image alt="Sherlock Cleaning mascot" className="h-14 w-14 shrink-0 rounded-xl bg-sky-50 object-contain p-1" height={56} priority src="/sherlock-cleaning-avatar.png" width={56} /><span className="min-w-0">Sherlock Cleaning</span></Link>;
  return <>
    <button aria-controls="console-mobile-nav" aria-expanded={open} aria-label="Open navigation" className="fixed left-3 top-3 z-50 grid min-h-11 min-w-11 place-content-center gap-1 rounded-xl border border-slate-200 bg-white shadow-sm md:hidden" onClick={() => setOpen((value) => !value)} ref={buttonRef} type="button"><MenuIcon /></button>
    {!desktopOpen && <button aria-controls="console-desktop-nav" aria-expanded="false" aria-label="Open navigation" className="fixed left-4 top-4 z-30 hidden min-h-11 min-w-11 place-content-center rounded-xl border border-slate-200 bg-white shadow-sm md:grid" onClick={() => setDesktopOpen(true)} type="button"><MenuIcon /></button>}
    {desktopOpen && <aside aria-label="Console navigation" className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r border-slate-200 bg-white p-4 md:flex" id="console-desktop-nav"><div className="flex items-start gap-2">{brand}<button aria-controls="console-desktop-nav" aria-expanded="true" aria-label="Collapse navigation" className="grid min-h-11 min-w-11 shrink-0 place-content-center rounded-xl border border-slate-200 text-slate-700 transition hover:bg-slate-50" onClick={() => setDesktopOpen(false)} type="button"><MenuIcon /></button></div><nav className="mt-9 grid gap-1">{navigation}</nav><div className="mt-auto grid gap-3 text-sm text-slate-500"><span>admin@sherlockcleaning.rs</span><button className="min-h-11 text-left text-sm font-bold text-teal-800" onClick={() => void logout()} type="button">Log out</button></div></aside>}
    {open && <><div aria-hidden="true" className="fixed inset-0 z-40 bg-slate-950/30 md:hidden" /><aside aria-label="Console navigation" className="fixed inset-y-0 left-0 z-50 flex w-[min(286px,86vw)] flex-col bg-white p-5 shadow-2xl md:hidden" id="console-mobile-nav" ref={drawerRef}><div className="flex items-center justify-between gap-3">{brand}<button aria-label="Close navigation" className="min-h-11 min-w-11 rounded-lg border border-slate-200 px-3 text-sm font-bold text-slate-700" onClick={() => close(true)} type="button">Close</button></div><nav className="mt-8 grid gap-1">{navigation}</nav><div className="mt-auto grid gap-3"><span className="text-sm text-slate-500">admin@sherlockcleaning.rs</span><button className="min-h-11 text-left text-sm font-bold text-teal-800" onClick={() => void logout()} type="button">Log out</button></div></aside></>}
  </>;
}

function MenuIcon() { return <span aria-hidden="true" className="grid gap-1"><span className="block h-0.5 w-5 bg-current" /><span className="block h-0.5 w-5 bg-current" /><span className="block h-0.5 w-5 bg-current" /></span>; }
