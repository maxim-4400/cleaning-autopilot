"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserSupabaseAuth } from "@/components/demo-console/browser-supabase-auth";
import type { PricingRules } from "@/lib/contracts/domain";

type ConfigResponse = { systemPrompt: string; pricingRules: PricingRules; source: "baseline" | "active"; version?: string | number; savedAt?: string; revision?: string };
type Section = "prompt" | "pricing";
type SectionState = { pending: boolean; message?: string };
type Result = { ok: true; data: ConfigResponse } | { ok: false; message: string };
type PricingPath = "standardRateRsdPerM2" | "standardMinimumRsd" | "deepRateRsdPerM2" | "deepMinimumRsd" | "extraBathroomRsd" | "heavyPetHairRsd" | "sameDayMultiplierPercent" | "extrasRsd.windows" | "extrasRsd.oven_inside" | "extrasRsd.fridge_inside" | "extrasRsd.balcony_or_terrace" | "volumeDiscountPercent.upTo100" | "volumeDiscountPercent.from101To150" | "volumeDiscountPercent.from151To200";

const moneyFields: Array<{ label: string; path: PricingPath }> = [
  { label: "Standard rate per m²", path: "standardRateRsdPerM2" }, { label: "Standard minimum", path: "standardMinimumRsd" },
  { label: "Deep-cleaning rate per m²", path: "deepRateRsdPerM2" }, { label: "Deep-cleaning minimum", path: "deepMinimumRsd" },
  { label: "Each extra bathroom", path: "extraBathroomRsd" }, { label: "Heavy pet hair", path: "heavyPetHairRsd" },
  { label: "Windows", path: "extrasRsd.windows" }, { label: "Oven inside", path: "extrasRsd.oven_inside" },
  { label: "Fridge inside", path: "extrasRsd.fridge_inside" }, { label: "Balcony or terrace", path: "extrasRsd.balcony_or_terrace" },
];
const percentageFields: Array<{ label: string; path: PricingPath }> = [
  { label: "Same-day surcharge", path: "sameDayMultiplierPercent" }, { label: "Discount up to 100 m²", path: "volumeDiscountPercent.upTo100" },
  { label: "Discount 101–150 m²", path: "volumeDiscountPercent.from101To150" }, { label: "Discount 151–200 m²", path: "volumeDiscountPercent.from151To200" },
];

export function ConfigurationEditors({ accessToken, pricingRules, prompt, savedAt, source, version, revision }: { accessToken: string; pricingRules: PricingRules; prompt: string; savedAt?: string; source: "baseline" | "active"; version?: string | number; revision?: string }) {
  const router = useRouter();
  const [promptValue, setPromptValue] = useState(prompt);
  const [pricingValue, setPricingValue] = useState(pricingRules);
  const [savedPrompt, setSavedPrompt] = useState(prompt);
  const [savedPricing, setSavedPricing] = useState(pricingRules);
  const [meta, setMeta] = useState({ savedAt, source, version, revision });
  const [sections, setSections] = useState<Record<Section, SectionState>>({ prompt: { pending: false }, pricing: { pending: false } });
  const setSection = (section: Section, next: SectionState) => setSections((current) => ({ ...current, [section]: next }));
  const request = async (section: Section, reset = false): Promise<Result> => {
    const response = await fetch(reset ? `/api/admin/demo-console-config?section=${section}` : "/api/admin/demo-console-config", reset ? {
      method: "DELETE", headers: { authorization: `Bearer ${accessToken}`, "if-match": meta.revision ?? "" },
    } : {
      method: "PATCH", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(section === "prompt" ? { section, expectedRevision: meta.revision, systemPrompt: promptValue } : { section, expectedRevision: meta.revision, pricingRules: pricingValue }),
    }).catch(() => undefined);
    if (response?.status === 401) { void browserSupabaseAuth.clearSession(); router.replace("/login?next=/settings"); return { ok: false, message: "Your Admin session has expired" }; }
    if (response?.status === 409) return { ok: false, message: "Saved configuration changed elsewhere. Refresh before saving this draft." };
    if (response?.status === 400) return { ok: false, message: "Check the highlighted pricing values before saving." };
    if (!response?.ok) return { ok: false, message: reset ? "This section could not be restored" : "This section could not be saved" };
    const data: unknown = await response.json().catch(() => undefined);
    return isConfigResponse(data) ? { ok: true, data } : { ok: false, message: "Configuration response was incomplete" };
  };
  const run = (section: Section, reset = false) => {
    setSection(section, { pending: true });
    void request(section, reset).then((result) => {
      if (!result.ok) { setSection(section, { pending: false, message: result.message }); return; }
      setMeta({ savedAt: result.data.savedAt, source: result.data.source, version: result.data.version, revision: result.data.revision });
      if (section === "prompt") { const next = reset ? result.data.systemPrompt : promptValue; setPromptValue(next); setSavedPrompt(next); }
      else { const next = reset ? result.data.pricingRules : pricingValue; setPricingValue(next); setSavedPricing(next); }
      setSection(section, { pending: false, message: reset ? "Restored to the baseline" : "Saved" });
    });
  };
  const updatePricing = (path: PricingPath, raw: string) => { const value = Number(raw); setPricingValue((current) => setPricingPath(current, path, Number.isFinite(value) ? value : 0)); setSection("pricing", { pending: false }); };
  const versionLabel = meta.version === undefined ? (meta.source === "active" ? "Active version" : "Baseline version") : `Version ${meta.version}`;
  return <div className="grid gap-6">
    <div className="flex flex-wrap items-center gap-3 text-sm font-medium text-slate-500"><span className="rounded-full bg-teal-50 px-3 py-1 text-teal-800">{versionLabel}</span><span>{meta.savedAt ? `Saved ${formatSavedAt(meta.savedAt)}` : "Not yet saved on this server"}</span></div>
    <section aria-labelledby="main-prompt-heading" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><div className="mb-5"><h2 className="text-xl font-bold text-slate-900" id="main-prompt-heading">Main Prompt</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">This changes the customer-facing agent instruction. It is saved independently of pricing.</p></div><textarea aria-label="Main Prompt" className="min-h-56 w-full rounded-xl border border-slate-300 bg-slate-50 p-4 font-mono text-sm leading-6 text-slate-800 outline-none ring-teal-600 focus:ring-2" onChange={(event) => { setPromptValue(event.target.value); setSection("prompt", { pending: false }); }} value={promptValue} /><SectionActions dirty={promptValue !== savedPrompt} message={sections.prompt.message} onReset={() => run("prompt", true)} onSave={() => run("prompt")} pending={sections.prompt.pending} section="prompt" /></section>
    <section aria-labelledby="pricing-rules-heading" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><div className="mb-6"><h2 className="text-xl font-bold text-slate-900" id="pricing-rules-heading">Pricing Rules</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Edit deterministic values directly. The backend validates every value before replacing the active snapshot.</p></div><div className="grid gap-7 lg:grid-cols-2"><PricingGroup fields={moneyFields} label="Prices in RSD" onChange={updatePricing} pricing={pricingValue} suffix="RSD" /><PricingGroup fields={percentageFields} label="Multipliers and discounts" onChange={updatePricing} pricing={pricingValue} suffix="%" /></div><SectionActions dirty={!samePricing(pricingValue, savedPricing)} message={sections.pricing.message} onReset={() => run("pricing", true)} onSave={() => run("pricing")} pending={sections.pricing.pending} section="pricing" /></section>
  </div>;
}

function PricingGroup({ fields, label, onChange, pricing, suffix }: { fields: Array<{ label: string; path: PricingPath }>; label: string; onChange: (path: PricingPath, value: string) => void; pricing: PricingRules; suffix: string }) {
  return <fieldset><legend className="mb-3 text-sm font-bold text-slate-800">{label}</legend><div className="grid gap-3 sm:grid-cols-2">{fields.map((field) => { const surcharge = field.path === "sameDayMultiplierPercent"; return <label className="grid gap-1.5 text-sm font-medium text-slate-700" key={field.path}>{field.label}<span className="relative">{surcharge && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm font-bold text-slate-500">+</span>}<input aria-label={surcharge ? "Same-day surcharge percentage" : field.label} className={`min-h-11 w-full rounded-lg border border-slate-300 bg-slate-50 ${surcharge ? "pl-7" : "px-3"} pr-12 text-slate-900 outline-none ring-teal-600 focus:ring-2`} min="0" onChange={(event) => onChange(field.path, event.target.value)} type="number" value={getPricingPath(pricing, field.path)} /><span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-bold text-slate-500">{suffix}</span></span></label>; })}</div></fieldset>;
}

function SectionActions({ dirty, message, onReset, onSave, pending, section }: { dirty: boolean; message?: string; onReset: () => void; onSave: () => void; pending: boolean; section: Section }) {
  const name = section === "prompt" ? "prompt" : "pricing";
  const confirmReset = () => {
    const confirmed = window.confirm(`Restore only the ${name} settings to the baseline? This does not change the other section.`);
    if (confirmed) onReset();
  };
  return <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5"><button className="min-h-11 rounded-xl bg-teal-700 px-4 text-sm font-bold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50" disabled={pending || !dirty} onClick={onSave} type="button">{pending ? "Saving…" : `Save ${name}`}</button><button className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={pending} onClick={confirmReset} type="button">Reset {name}</button>{message && <p aria-live="polite" className="text-sm font-medium text-slate-600">{message}</p>}</div>;
}

function getPricingPath(pricing: PricingRules, path: PricingPath): number {
  if (path === "sameDayMultiplierPercent") return pricing.sameDayMultiplierPercent - 100;
  if (path.startsWith("extrasRsd.")) return pricing.extrasRsd[path.slice("extrasRsd.".length) as keyof PricingRules["extrasRsd"]];
  if (path.startsWith("volumeDiscountPercent.")) return pricing.volumeDiscountPercent[path.slice("volumeDiscountPercent.".length) as keyof PricingRules["volumeDiscountPercent"]];
  return pricing[path as Exclude<PricingPath, `extrasRsd.${string}` | `volumeDiscountPercent.${string}`>];
}
function setPricingPath(pricing: PricingRules, path: PricingPath, value: number): PricingRules {
  if (path === "sameDayMultiplierPercent") return { ...pricing, sameDayMultiplierPercent: value + 100 };
  if (path.startsWith("extrasRsd.")) return { ...pricing, extrasRsd: { ...pricing.extrasRsd, [path.slice("extrasRsd.".length)]: value } };
  if (path.startsWith("volumeDiscountPercent.")) return { ...pricing, volumeDiscountPercent: { ...pricing.volumeDiscountPercent, [path.slice("volumeDiscountPercent.".length)]: value } };
  return { ...pricing, [path]: value } as PricingRules;
}
function samePricing(a: PricingRules, b: PricingRules) { return JSON.stringify(a) === JSON.stringify(b); }
function isConfigResponse(value: unknown): value is ConfigResponse { return typeof value === "object" && value !== null && "systemPrompt" in value && typeof value.systemPrompt === "string" && "pricingRules" in value && typeof value.pricingRules === "object" && "source" in value && (value.source === "baseline" || value.source === "active") && (!("revision" in value) || typeof value.revision === "string"); }
function formatSavedAt(value: string) { return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Belgrade" }).format(new Date(value)); }
