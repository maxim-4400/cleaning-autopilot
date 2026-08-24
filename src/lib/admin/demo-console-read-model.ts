import "server-only";

import { z } from "zod";
import { canonicalTrelloCardUrl } from "@/lib/trello/card-url";
import { presentTrelloCardTitle, safeTrelloLocation } from "@/lib/trello/presenter";

type IntegrationId = "telegram" | "openai" | "google_calendar" | "trello";
type Readiness = "ready" | "attention" | "not_configured";
export type LeadProofStatus = "terminal" | "human_needed" | "recovery" | "pending" | "stalled" | "waiting_customer" | "idle";

export type DemoConsoleIntegration = { id: IntegrationId; label: string; readiness: Readiness; detail: string; lastActivityAt?: string };
export type DemoConsoleLead = {
  businessReference: string; lifecycle: "new_lead" | "qualified" | "booked" | "done" | "lost";
  cleaningType?: "standard" | "deep"; areaM2?: number; rooms?: number; bathrooms?: number; preferredDate?: string;
  /** Redacted presentation context only; raw address and Telegram identifiers never enter this DTO. */
  customerLabel: string; locationLabel: string;
  humanNeeded: boolean; humanNeededReason?: string; quotedPriceRsd?: number; assignedTeam?: "team_a" | "team_b";
  bookedStart?: string; hasCalendarEvent: boolean; hasTrelloCard: boolean; trelloCardUrl?: string; updatedAt: string;
};
export type DemoConsoleActivity = { eventType: string; occurredAt: string };
export type TrelloBoardSnapshot = { kind: "projection" | "not_configured" | "unavailable"; boardUrl?: string; cards: Array<{ title: string; businessReference: string; lifecycle: DemoConsoleLead["lifecycle"]; humanNeeded: boolean; updatedAt: string; cardUrl?: string }> };
export type DemoConsoleReadModel = {
  generatedAt: string; snapshotKind: "application_snapshot"; providerState: "not_live_checked"; integrations: DemoConsoleIntegration[];
  latestLead?: DemoConsoleLead; latestLeadActivity: DemoConsoleActivity[]; currentStatus: LeadProofStatus; currentStatusDetail: string; trelloBoard: TrelloBoardSnapshot;
};

const clientDataSchema = z.object({ cleaningType: z.enum(["standard", "deep"]).optional(), areaM2: z.number().positive().optional(), rooms: z.number().int().positive().optional(), bathrooms: z.number().int().positive().optional(), preferredDate: z.string().date().optional(), addressOrDistrict: z.string().trim().min(2).max(300).optional() });
const leadSchema = z.object({ id: z.string().uuid(), business_reference: z.string().min(1), status: z.enum(["new_lead", "qualified", "booked", "done", "lost"]), client_data: clientDataSchema, customer_display_name: z.string().trim().min(1).max(128).nullable().optional(), human_needed: z.boolean(), human_needed_reason: z.string().nullable().optional(), quoted_price_rsd: z.number().int().positive().nullable().optional(), assigned_team: z.enum(["team_a", "team_b"]).nullable().optional(), booked_start: z.string().datetime({ offset: true }).nullable().optional(), calendar_event_id: z.string().min(1).nullable().optional(), trello_card_id: z.string().min(1).nullable().optional(), trello_card_url: z.string().url().nullable().optional(), updated_at: z.string().datetime({ offset: true }) }).strict();
const activitySchema = z.object({ event_type: z.string().min(1).max(120), created_at: z.string().datetime({ offset: true }) }).strict();
const operationSchema = z.object({ provider: z.enum(["telegram", "openai", "google_calendar", "trello"]), status: z.enum(["pending", "succeeded", "failed", "ambiguous"]), updated_at: z.string().datetime({ offset: true }) }).strict();
const syncSchema = z.object({ state: z.enum(["pending", "calendar_pending", "confirmation_pending", "done", "manual"]), next_attempt_at: z.string().datetime({ offset: true }), updated_at: z.string().datetime({ offset: true }) }).strict();
type LeadRow = z.infer<typeof leadSchema>; type ActivityRow = z.infer<typeof activitySchema>; type OperationRow = z.infer<typeof operationSchema>; type SyncRow = z.infer<typeof syncSchema>;

export interface DemoConsoleReadRepository { latestLead(): Promise<LeadRow | null>; trelloLeads(): Promise<LeadRow[]>; activityForLead(leadId: string): Promise<ActivityRow[]>; operationsForLead(leadId: string): Promise<OperationRow[]>; trelloSyncForLead(leadId: string): Promise<SyncRow | null>; }

/** Whitelisted, server-only Supabase projection. Sensitive source fields never enter a DTO. */
export class SupabaseDemoConsoleReadRepository implements DemoConsoleReadRepository {
  constructor(private readonly environment: { url: string; secretKey: string }) {}
  async latestLead() { const rows = await this.request("leads?select=id,business_reference,status,client_data,customer_display_name,human_needed,human_needed_reason,quoted_price_rsd,assigned_team,booked_start,calendar_event_id,trello_card_id,trello_card_url,updated_at&order=updated_at.desc&limit=1", leadSchema); return rows[0] ?? null; }
  async trelloLeads() { return this.request("leads?trello_card_id=not.is.null&select=id,business_reference,status,client_data,customer_display_name,human_needed,human_needed_reason,quoted_price_rsd,assigned_team,booked_start,calendar_event_id,trello_card_id,trello_card_url,updated_at&order=updated_at.desc&limit=50", leadSchema); }
  async activityForLead(leadId: string) { return this.request(`activity_log?lead_id=eq.${encodeURIComponent(leadId)}&select=event_type,created_at&order=created_at.desc&limit=12`, activitySchema); }
  async operationsForLead(leadId: string) { return this.request(`integration_operations?lead_id=eq.${encodeURIComponent(leadId)}&select=provider,status,updated_at&order=updated_at.desc&limit=24`, operationSchema); }
  async trelloSyncForLead(leadId: string) { const rows = await this.request(`trello_sync_jobs?lead_id=eq.${encodeURIComponent(leadId)}&select=state,next_attempt_at,updated_at&limit=1`, syncSchema); return rows[0] ?? null; }
  private async request<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>[]> {
    let response: Response; try { response = await fetch(`${this.environment.url.replace(/\/$/, "")}/rest/v1/${path}`, { headers: { apikey: this.environment.secretKey, authorization: `Bearer ${this.environment.secretKey}`, accept: "application/json" }, cache: "no-store" }); } catch { throw new DemoConsoleReadError(); }
    const payload: unknown = await response.json().catch(() => undefined); const parsed = z.array(schema).safeParse(payload);
    if (!response.ok || !parsed.success) throw new DemoConsoleReadError(); return parsed.data;
  }
}
export class DemoConsoleReadError extends Error { constructor() { super("Demo Console read source unavailable"); this.name = "DemoConsoleReadError"; } }

export async function getDemoConsoleReadModel(repository: DemoConsoleReadRepository | undefined = configuredRepository(), environment: NodeJS.ProcessEnv = process.env, now: () => Date = () => new Date()): Promise<DemoConsoleReadModel> {
  const integrations = integrationDefinitionsFor(environment); const base = emptyModel(integrations, environment, now); if (!repository) throw new DemoConsoleReadError();
  try {
    const [lead, trelloLeads] = await Promise.all([repository.latestLead(), repository.trelloLeads()]); if (!lead) return { ...base, trelloBoard: trelloSnapshot(integrations[3], trelloLeads, environment) };
    const [activity, operations, sync] = await Promise.all([repository.activityForLead(lead.id), repository.operationsForLead(lead.id), repository.trelloSyncForLead(lead.id)]);
    const snapshotNow = now();
    const status = currentStatus(lead, operations, sync, snapshotNow);
    return { ...base, generatedAt: snapshotNow.toISOString(), integrations: applyRecentActivity(integrations, operations, snapshotNow), latestLead: toLead(lead), latestLeadActivity: semanticActivity(activity), currentStatus: status.status, currentStatusDetail: status.detail, trelloBoard: trelloSnapshot(integrations[3], trelloLeads, environment) };
  } catch (error) { throw error instanceof DemoConsoleReadError ? error : new DemoConsoleReadError(); }
}

function configuredRepository(): DemoConsoleReadRepository | undefined { const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(); const secretKey = process.env.SUPABASE_SECRET_KEY?.trim(); return url && secretKey ? new SupabaseDemoConsoleReadRepository({ url, secretKey }) : undefined; }
function integrationDefinitionsFor(env: NodeJS.ProcessEnv): DemoConsoleIntegration[] { const r = (keys: string[]): Readiness => { const count = keys.filter((key) => Boolean(env[key]?.trim())).length; return count === keys.length ? "ready" : count ? "attention" : "not_configured"; }; return [item("telegram", "Telegram", r(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"])), item("openai", "OpenAI", r(["OPENAI_API_KEY"])), item("google_calendar", "Google Calendar", r(["COMPOSIO_API_KEY", "COMPOSIO_GOOGLE_CALENDAR_USER_ID", "COMPOSIO_GOOGLE_CALENDAR_CONNECTED_ACCOUNT_ID", "COMPOSIO_GOOGLE_CALENDAR_TOOLKIT_VERSION", "TEAM_A_CALENDAR_ID", "TEAM_B_CALENDAR_ID"])), item("trello", "Trello", r(["COMPOSIO_API_KEY", "COMPOSIO_TRELLO_USER_ID", "COMPOSIO_TRELLO_CONNECTED_ACCOUNT_ID", "COMPOSIO_TRELLO_TOOLKIT_VERSION", "TRELLO_BOARD_ID", "TRELLO_HUMAN_NEEDED_LABEL_ID"]))]; }
function item(id: IntegrationId, label: string, readiness: Readiness): DemoConsoleIntegration { return { id, label, readiness, detail: readiness === "ready" ? "Configuration complete" : readiness === "attention" ? "Configuration incomplete" : "Not configured" }; }
function emptyModel(integrations: DemoConsoleIntegration[], env: NodeJS.ProcessEnv, now: () => Date): DemoConsoleReadModel { return { generatedAt: now().toISOString(), snapshotKind: "application_snapshot", providerState: "not_live_checked", integrations, latestLeadActivity: [], currentStatus: "idle", currentStatusDetail: "No persisted lead is available", trelloBoard: trelloSnapshot(integrations[3], [], env) }; }
const freshOperationMs = 10 * 60_000;
function applyRecentActivity(integrations: DemoConsoleIntegration[], operations: OperationRow[], now: Date) { return integrations.map((integration) => { const recent = operations.find((operation) => operation.provider === integration.id); if (!recent || integration.readiness === "not_configured") return integration; if (recent.status === "failed" || recent.status === "ambiguous" || (recent.status === "pending" && isStale(recent.updated_at, now))) return { ...integration, readiness: "attention" as const, detail: recent.status === "pending" ? "Operation needs review" : "Recent operation needs review", lastActivityAt: recent.updated_at }; return { ...integration, detail: recent.status === "pending" ? "Recent operation in progress" : "Recent operation succeeded", lastActivityAt: recent.updated_at }; }); }
const semanticActivityTypes = new Set(["lead_created", "date_proposed", "date_proposal_confirmed", "quote_delivered", "calendar_reserved_pending_trello", "trello_synced", "booking_confirmed"]);
function semanticActivity(activity: ActivityRow[]): DemoConsoleActivity[] {
  const seen = new Set<string>();
  return activity.filter((event) => semanticActivityTypes.has(event.event_type) && !seen.has(event.event_type) && Boolean(seen.add(event.event_type))).slice(0, 4).reverse().map((event) => ({ eventType: event.event_type, occurredAt: event.created_at }));
}
function currentStatus(lead: LeadRow, operations: OperationRow[], sync: SyncRow | null, now: Date): { status: LeadProofStatus; detail: string } { if (lead.human_needed) return { status: "human_needed", detail: "Human review is required" }; if (lead.status === "done" || lead.status === "lost" || lead.status === "booked") return { status: "terminal", detail: lead.status === "booked" ? "Booking confirmed in the application snapshot" : `Lead is ${lead.status.replace("_", " ")}` }; if (sync?.state === "manual") return { status: "stalled", detail: "Trello sync requires manual recovery" }; if (sync && sync.state !== "done") return { status: "recovery", detail: "Retrying Trello sync" }; const pending = operations.find((operation) => operation.status === "pending"); if (pending) return isStale(pending.updated_at, now) ? { status: "stalled", detail: "Operation needs review" } : { status: "pending", detail: "A persisted external operation is in progress" }; if (operations.some((operation) => operation.status === "failed" || operation.status === "ambiguous")) return { status: "stalled", detail: "A persisted external operation needs review" }; if (lead.status === "new_lead") return { status: "waiting_customer", detail: "Waiting for customer details" }; return { status: "idle", detail: "No pending application operation" }; }
function isStale(value: string, now: Date) { const timestamp = new Date(value).getTime(); return !Number.isFinite(timestamp) || now.getTime() - timestamp > freshOperationMs; }
function toLead(row: LeadRow): DemoConsoleLead { return { businessReference: row.business_reference, lifecycle: row.status, cleaningType: row.client_data.cleaningType, areaM2: row.client_data.areaM2, rooms: row.client_data.rooms, bathrooms: row.client_data.bathrooms, preferredDate: row.client_data.preferredDate, customerLabel: row.customer_display_name?.trim().slice(0, 80) || "Telegram customer", locationLabel: safeTrelloLocation(row.client_data.addressOrDistrict), humanNeeded: row.human_needed, humanNeededReason: row.human_needed_reason ?? undefined, quotedPriceRsd: row.quoted_price_rsd ?? undefined, assignedTeam: row.assigned_team ?? undefined, bookedStart: row.booked_start ?? undefined, hasCalendarEvent: Boolean(row.calendar_event_id), hasTrelloCard: Boolean(row.trello_card_id), trelloCardUrl: canonicalTrelloCardUrl(row.trello_card_url), updatedAt: row.updated_at }; }
function trelloSnapshot(integration: DemoConsoleIntegration, rows: LeadRow[], env: NodeJS.ProcessEnv): TrelloBoardSnapshot { const board = canonicalTrelloBoardUrl(env.TRELLO_BOARD_URL ?? env.NEXT_PUBLIC_TRELLO_BOARD_URL); if (integration.readiness === "not_configured") return { kind: "not_configured", cards: [], boardUrl: board }; const cards = rows.filter((row) => row.trello_card_id).map((row) => ({ title: presentTrelloCardTitle({ customerDisplayName: row.customer_display_name ?? undefined, addressOrDistrict: row.client_data.addressOrDistrict, areaM2: row.client_data.areaM2 }), businessReference: row.business_reference, lifecycle: row.status, humanNeeded: row.human_needed, updatedAt: row.updated_at, cardUrl: canonicalTrelloCardUrl(row.trello_card_url) })); return cards.length ? { kind: "projection", boardUrl: board, cards } : { kind: "unavailable", boardUrl: board, cards: [] }; }
function canonicalTrelloBoardUrl(value: string | undefined): string | undefined { if (!value) return undefined; try { const url = new URL(value); if (url.protocol !== "https:" || !["trello.com", "www.trello.com"].includes(url.hostname) || !/^\/b\/[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_-]{1,256})?\/?$/.test(url.pathname) || url.search || url.hash || url.username || url.password) return undefined; return `https://trello.com${url.pathname.replace(/\/$/, "")}`; } catch { return undefined; } }
