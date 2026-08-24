import type { Extra } from "@/lib/contracts/domain";
import type { StoredLead } from "@/lib/leads/repository";
import type { TrelloCardInput, TrelloLifecycle } from "@/lib/trello/gateway";

const terminalLifecycle = new Set<TrelloLifecycle>(["done", "lost"]);

export type TrelloCardTitleContext = {
  customerDisplayName?: string;
  addressOrDistrict?: string;
  areaM2?: number;
};

/**
 * Trello is an operational surface, so its title gives a reviewer enough
 * context to find the request without copying a house number or chat handle
 * into another list view. A district or city is retained when it is supplied
 * separately from a street address.
 */
export function safeTrelloLocation(value: string | undefined): string {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return "Location pending";
  const parts = normalized.split(",").map((part) => part.trim()).filter(Boolean);
  const location = parts.length > 1 ? parts[parts.length - 1]! : normalized;
  return /\d/.test(location) ? "Location shared" : location.slice(0, 64);
}

export function presentTrelloCardTitle(context: TrelloCardTitleContext): string {
  const customer = context.customerDisplayName?.replace(/\s+/g, " ").trim().slice(0, 80) || "Telegram customer";
  const location = safeTrelloLocation(context.addressOrDistrict);
  const area = context.areaM2 ? `${formatNumber(context.areaM2)} m²` : "Area pending";
  return `${customer} · ${location} · ${area}`;
}

export function presentTrelloCard(lead: StoredLead, lifecycle: TrelloLifecycle = lead.status): TrelloCardInput {
  const data = lead.clientData;
  const customer = lead.customerDisplayName || "Telegram customer";
  return {
    businessReference: lead.businessReference,
    title: presentTrelloCardTitle({ customerDisplayName: lead.customerDisplayName, addressOrDistrict: data.addressOrDistrict, areaM2: data.areaM2 }),
    description: [
      line("Business reference", lead.businessReference),
      line("Customer", customer),
      line("Cleaning type", formatCleaningType(data.cleaningType)),
      line("Area", data.areaM2 ? `${formatNumber(data.areaM2)} m²` : "Pending"),
      line("Rooms", data.rooms ?? "Pending"),
      line("Bathrooms", data.bathrooms ?? "Pending"),
      line("Extras", formatExtras(data.extras)),
      line("Pet hair", formatPetHair(data.heavyPetHair)),
      line("Location", data.addressOrDistrict || "Pending"),
      line("Preferred date", data.preferredDate || "Pending"),
      line("Quote", lead.quote?.amountRsd ? `${new Intl.NumberFormat("en-US").format(lead.quote.amountRsd)} RSD` : "Pending"),
      line("Assigned team", lead.assignedTeam ? formatTeam(lead.assignedTeam) : "Pending"),
      line("Cleaning time", lead.bookedStart && lead.bookedEnd ? `${lead.bookedStart} – ${lead.bookedEnd}` : "Pending"),
      line("Human Needed", lead.humanNeeded ? formatHumanReason(lead.humanNeededReason) : "No"),
      line("Contact", publicTelegramContact(lead.telegramUsername)),
    ].join("\n"),
    lifecycle,
    humanNeeded: lead.humanNeeded,
  };
}

function publicTelegramContact(username: string | undefined): string {
  return username && /^[A-Za-z0-9_]{5,32}$/.test(username)
    ? `https://t.me/${username}`
    : "No public Telegram username";
}

export function isTerminalTrelloLifecycle(value: TrelloLifecycle): value is "done" | "lost" {
  return terminalLifecycle.has(value);
}

function line(label: string, value: string | number): string {
  return `${label}: ${value}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatCleaningType(value: StoredLead["clientData"]["cleaningType"]): string {
  if (value === "deep") return "Deep cleaning";
  if (value === "standard") return "Standard cleaning";
  return "Pending";
}

function formatExtras(value: Extra[] | undefined): string {
  if (!value?.length) return "None";
  return value.map((extra) => ({
    windows: "Windows",
    oven_inside: "Oven inside",
    fridge_inside: "Fridge inside",
    balcony_or_terrace: "Balcony or terrace",
  })[extra]).join(", ");
}

function formatPetHair(value: boolean | undefined): string {
  return value === undefined ? "Pending" : value ? "Heavy pet hair" : "No";
}

function formatTeam(value: NonNullable<StoredLead["assignedTeam"]>): string {
  return value === "team_a" ? "Team A" : "Team B";
}

function formatHumanReason(value: StoredLead["humanNeededReason"]): string {
  return value ? value.replaceAll("_", " ") : "Review requested";
}
