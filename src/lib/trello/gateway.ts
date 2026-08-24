import { Composio } from "@composio/core";
import { z } from "zod";

import type { LeadStatus } from "@/lib/contracts/domain";
import { PINNED_TRELLO_TOOLKIT_VERSION, TRELLO_TOPOLOGY_CACHE_TTL_MS } from "@/lib/trello/constants";
import { canonicalTrelloCardUrl } from "@/lib/trello/card-url";

export type TrelloLifecycle = LeadStatus;

export type TrelloCard = {
  id: string;
  businessReference: string;
  title: string;
  description: string;
  lifecycle: TrelloLifecycle;
  humanNeeded: boolean;
  directUrl?: string;
};

export type TrelloCardInput = Omit<TrelloCard, "id">;

export type TrelloReferenceLookup =
  | { kind: "none" }
  | { kind: "one"; card: TrelloCard }
  | { kind: "duplicate"; cardIds: string[] };

export type TrelloWriteResult =
  | { kind: "succeeded"; card: TrelloCard }
  | { kind: "failed"; code: string; ambiguous: boolean };
type TrelloFailure = Extract<TrelloWriteResult, { kind: "failed" }>;

export interface TrelloGateway {
  lookupByBusinessReference(businessReference: string): Promise<TrelloReferenceLookup>;
  getCardById(cardId: string): Promise<TrelloCard | null>;
  createCard(input: TrelloCardInput): Promise<TrelloWriteResult>;
  updateCard(input: TrelloCard & { lifecycle: Exclude<TrelloLifecycle, "done" | "lost"> }): Promise<TrelloWriteResult>;
  setHumanNeededLabel(input: { cardId: string; enabled: boolean }): Promise<TrelloWriteResult>;
}

/** Keeps an incomplete real-integration configuration fail-closed. */
export class UnavailableTrelloGateway implements TrelloGateway {
  async lookupByBusinessReference(): Promise<TrelloReferenceLookup> {
    return { kind: "none" };
  }

  async getCardById(): Promise<TrelloCard | null> {
    return null;
  }

  async createCard(): Promise<TrelloWriteResult> {
    return { kind: "failed", code: "trello_gateway_unavailable", ambiguous: false };
  }

  async updateCard(): Promise<TrelloWriteResult> {
    return { kind: "failed", code: "trello_gateway_unavailable", ambiguous: false };
  }

  async setHumanNeededLabel(): Promise<TrelloWriteResult> {
    return { kind: "failed", code: "trello_gateway_unavailable", ambiguous: false };
  }
}

export type ComposioTrelloEnvironment = {
  apiKey: string;
  userId: string;
  connectedAccountId: string;
  toolkitVersion: string;
  boardId: string;
  humanNeededLabelId: string;
};

type ComposioToolRequest = {
  userId: string;
  connectedAccountId: string;
  version: string;
  arguments: Record<string, string>;
};

export type ComposioToolExecutor = {
  execute(tool: string, request: ComposioToolRequest): Promise<unknown>;
};

export type ComposioTrelloGatewayOptions = {
  now?: () => number;
  topologyCacheTtlMs?: number;
};

type TrelloList = { id: string; name: string; closed: boolean };
type TrelloLabel = { id: string; name: string };
type TrelloProviderCard = { id: string; name: string; desc: string; idList: string; labelIds: string[]; shortUrl?: string; url?: string };
type TrelloTopology = { listIdByLifecycle: Record<TrelloLifecycle, string>; lifecycleByListId: Map<string, TrelloLifecycle> };

const lifecycleNames: Record<TrelloLifecycle, string> = {
  new_lead: "New Lead",
  qualified: "Qualified",
  booked: "Booked",
  done: "Done",
  lost: "Lost",
};
const expectedOpenListNames = new Set(Object.values(lifecycleNames));

const nonEmpty = z.string().trim().min(1);
const listSchema = z.object({ id: nonEmpty, name: nonEmpty, closed: z.boolean() }).passthrough();
// Trello's ordinary colour-only labels have no name. Only the configured
// Human Needed label is required to have its exact non-empty name in
// loadTopology below.
const labelSchema = z.object({ id: nonEmpty, name: z.string() }).passthrough();
const cardSchema = z.object({
  id: nonEmpty,
  name: z.string(),
  desc: z.string(),
  idList: nonEmpty,
  labels: z.array(labelSchema).optional(),
  idLabels: z.array(nonEmpty).optional(),
  shortUrl: z.string().optional(),
  url: z.string().optional(),
}).passthrough().superRefine((card, context) => {
  if (!card.labels && !card.idLabels) {
    context.addIssue({ code: "custom", message: "Card labels or idLabels are required to determine Human Needed state" });
  }
  if (card.labels && card.idLabels) {
    const labels = [...card.labels.map((label) => label.id)].sort();
    const ids = [...card.idLabels].sort();
    if (labels.length !== ids.length || labels.some((label, index) => label !== ids[index])) {
      context.addIssue({ code: "custom", message: "Card labels and idLabels disagree" });
    }
  }
});

/**
 * Server-only Composio adapter. It pins the Trello toolkit and accepts only
 * the verified Trello tools/arguments. Provider fields are parsed into a
 * small internal DTO before the rest of the application sees them.
 */
export class ComposioTrelloGateway implements TrelloGateway {
  private readonly executor: ComposioToolExecutor;
  private readonly now: () => number;
  private readonly topologyCacheTtlMs: number;
  private topologyCache: { expiresAt: number; promise: Promise<TrelloTopology> } | undefined;

  constructor(
    private readonly environment: ComposioTrelloEnvironment,
    executor?: ComposioToolExecutor,
    options: ComposioTrelloGatewayOptions = {},
  ) {
    if (environment.toolkitVersion !== PINNED_TRELLO_TOOLKIT_VERSION) {
      throw new Error(`Trello toolkit version must be pinned to ${PINNED_TRELLO_TOOLKIT_VERSION}`);
    }
    this.now = options.now ?? Date.now;
    this.topologyCacheTtlMs = options.topologyCacheTtlMs ?? TRELLO_TOPOLOGY_CACHE_TTL_MS;
    if (executor) {
      this.executor = executor;
    } else {
      const composio = new Composio({
        apiKey: environment.apiKey,
        toolkitVersions: { trello: environment.toolkitVersion },
      });
      this.executor = {
        execute: (tool, request) => composio.tools.execute(tool, request),
      };
    }
  }

  async lookupByBusinessReference(businessReference: string): Promise<TrelloReferenceLookup> {
    const topology = await this.topology();
    const result = await this.execute("TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD", { idBoard: this.environment.boardId });
    const matches = parseCards(result)
      .map((card) => this.toCard(card, topology))
      .filter((card): card is TrelloCard => card !== undefined)
      .filter((card) => hasBusinessReferenceMarker(card.description, businessReference));
    if (matches.length === 0) return { kind: "none" };
    if (matches.length === 1) return { kind: "one", card: matches[0] };
    return { kind: "duplicate", cardIds: matches.map((card) => card.id) };
  }

  async getCardById(cardId: string): Promise<TrelloCard | null> {
    const topology = await this.topology();
    return this.readCardById(cardId, topology);
  }

  async createCard(input: TrelloCardInput): Promise<TrelloWriteResult> {
    try {
      const topology = await this.topology();
      const result = await this.execute("TRELLO_ADD_CARDS", {
        idList: this.listId(topology, input.lifecycle),
        name: input.title,
        desc: withBusinessReferenceMarker(input.description, input.businessReference),
        idBoard: this.environment.boardId,
      });
      const cardId = parseMutationCardId(result);
      const card = await this.readCardById(cardId, topology);
      if (!card || !matchesDesiredCard(card, { id: cardId, ...input })) return writeFailure("trello_create_confirmation_failed");
      return { kind: "succeeded", card };
    } catch {
      return writeFailure("trello_create_transport_failed");
    }
  }

  async updateCard(input: TrelloCard & { lifecycle: Exclude<TrelloLifecycle, "done" | "lost"> }): Promise<TrelloWriteResult> {
    try {
      const topology = await this.topology();
      const result = await this.execute("TRELLO_UPDATE_CARDS_BY_ID_CARD", {
        idCard: input.id,
        idList: this.listId(topology, input.lifecycle),
        name: input.title,
        desc: withBusinessReferenceMarker(input.description, input.businessReference),
      });
      assertComposioSuccess(result);
      const card = await this.readCardById(input.id, topology);
      if (!card || !matchesDesiredCard(card, input)) return writeFailure("trello_update_confirmation_failed");
      return { kind: "succeeded", card };
    } catch {
      return writeFailure("trello_update_transport_failed");
    }
  }

  async setHumanNeededLabel(input: { cardId: string; enabled: boolean }): Promise<TrelloWriteResult> {
    try {
      await this.topology();
      if (input.enabled) {
        assertComposioSuccess(await this.execute("TRELLO_ADD_CARDS_ID_LABELS_BY_ID_CARD", {
          idCard: input.cardId,
          value: this.environment.humanNeededLabelId,
        }));
      } else {
        assertComposioSuccess(await this.execute("TRELLO_REMOVE_LABEL_FROM_CARD", {
          idCard: input.cardId,
          idLabel: this.environment.humanNeededLabelId,
        }));
      }
      const topology = await this.topology();
      const card = await this.readCardById(input.cardId, topology);
      if (!card || card.humanNeeded !== input.enabled) return writeFailure("trello_label_confirmation_failed");
      return { kind: "succeeded", card };
    } catch {
      return writeFailure("trello_label_transport_failed");
    }
  }

  private topology(): Promise<TrelloTopology> {
    const current = this.now();
    if (this.topologyCache && this.topologyCache.expiresAt > current) return this.topologyCache.promise;
    const promise = this.loadTopology();
    const cache = { expiresAt: current + this.topologyCacheTtlMs, promise };
    this.topologyCache = cache;
    void promise.catch(() => {
      if (this.topologyCache === cache) this.topologyCache = undefined;
    });
    return promise;
  }

  private async loadTopology(): Promise<TrelloTopology> {
    const [listsResult, labelsResult] = await Promise.all([
      this.execute("TRELLO_GET_BOARDS_LISTS_BY_ID_BOARD", { idBoard: this.environment.boardId }),
      this.execute("TRELLO_GET_BOARDS_LABELS_BY_ID_BOARD", { idBoard: this.environment.boardId }),
    ]);
    const lists = parseLists(listsResult);
    const openLists = lists.filter((list) => !list.closed);
    const byName = new Map<string, TrelloList[]>();
    for (const list of openLists) byName.set(list.name, [...(byName.get(list.name) ?? []), list]);
    if (openLists.length !== expectedOpenListNames.size || [...byName.keys()].some((name) => !expectedOpenListNames.has(name))) {
      throw new Error("Trello board must have exactly the five canonical open lifecycle lists");
    }
    const listIdByLifecycle = {} as Record<TrelloLifecycle, string>;
    const lifecycleByListId = new Map<string, TrelloLifecycle>();
    for (const [lifecycle, name] of Object.entries(lifecycleNames) as Array<[TrelloLifecycle, string]>) {
      const matching = byName.get(name);
      if (!matching || matching.length !== 1) throw new Error(`Trello board lifecycle list is missing or duplicate: ${name}`);
      listIdByLifecycle[lifecycle] = matching[0].id;
      lifecycleByListId.set(matching[0].id, lifecycle);
    }
    const humanNeededLabels = parseLabels(labelsResult).filter((item) => item.name === "Human Needed");
    if (humanNeededLabels.length !== 1 || humanNeededLabels[0].id !== this.environment.humanNeededLabelId) {
      throw new Error("Configured Trello Human Needed label must be the one unique exact-name label");
    }
    return { listIdByLifecycle, lifecycleByListId };
  }

  private async execute(tool: string, arguments_: Record<string, string>): Promise<unknown> {
    return this.executor.execute(tool, {
      userId: this.environment.userId,
      connectedAccountId: this.environment.connectedAccountId,
      version: this.environment.toolkitVersion,
      arguments: arguments_,
    });
  }

  private listId(topology: TrelloTopology, lifecycle: TrelloLifecycle): string {
    const listId = topology.listIdByLifecycle[lifecycle];
    if (!listId) throw new Error(`Unknown Trello lifecycle: ${lifecycle}`);
    return listId;
  }

  private async readCardById(cardId: string, topology: TrelloTopology): Promise<TrelloCard | null> {
    const result = await this.execute("TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD_BY_ID_CARD", {
      idBoard: this.environment.boardId,
      idCard: cardId,
    });
    return this.toCard(parseDirectCard(result), topology) ?? null;
  }

  private toCard(source: TrelloProviderCard, topology: TrelloTopology): TrelloCard | undefined {
    const lifecycle = topology.lifecycleByListId.get(source.idList);
    const businessReference = businessReferenceFromDescription(source.desc);
    if (!lifecycle || !businessReference) return undefined;
    return {
      id: source.id,
      businessReference,
      title: source.name,
      description: source.desc,
      lifecycle,
      humanNeeded: source.labelIds.includes(this.environment.humanNeededLabelId),
      directUrl: canonicalTrelloCardUrl(source.shortUrl) ?? canonicalTrelloCardUrl(source.url),
    };
  }
}


function writeFailure(code: string): TrelloWriteResult {
  return { kind: "failed", code, ambiguous: true };
}

function responseData(result: unknown): unknown {
  if (!isRecord(result) || result.successful === false || !isRecord(result.data)) {
    throw new Error("Composio Trello execution failed or returned an invalid envelope");
  }
  return result.data.response_data ?? result.data;
}

function assertComposioSuccess(result: unknown): void {
  responseData(result);
}

function parseLists(result: unknown): TrelloList[] {
  return collection(result, "lists", listSchema).map((list) => ({ id: list.id, name: list.name, closed: list.closed }));
}

function parseLabels(result: unknown): TrelloLabel[] {
  return collection(result, "labels", labelSchema).map((label) => ({ id: label.id, name: label.name }));
}

function parseCards(result: unknown): TrelloProviderCard[] {
  return collection(result, "cards", cardSchema).map(providerCard);
}

function parseDirectCard(result: unknown): TrelloProviderCard {
  const payload = responseData(result);
  // The current Composio direct-card action returns the card object in `data`.
  // Older observed responses wrapped that exact object in `{ cards: [card] }`.
  // Keep the legacy shape temporarily, but reject any collection other than one
  // card so a broad board response can never be mistaken for an authoritative
  // post-write confirmation.
  const candidate = isRecord(payload) && Array.isArray(payload.cards)
    ? payload.cards.length === 1 ? payload.cards[0] : undefined
    : payload;
  if (candidate === undefined) {
    throw new Error("Composio Trello direct-card response must contain exactly one card");
  }
  const parsed = cardSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("Composio Trello card response did not match the verified schema");
  return providerCard(parsed.data);
}

function parseMutationCardId(result: unknown): string {
  const payload = responseData(result);
  const cards = isRecord(payload) ? payload.cards : undefined;
  if (!Array.isArray(cards) || cards.length !== 1 || !isRecord(cards[0])) {
    throw new Error("Composio Trello create response must contain exactly one card");
  }
  const parsed = nonEmpty.safeParse(cards[0].id);
  if (!parsed.success) throw new Error("Composio Trello create response did not include a card id");
  return parsed.data;
}

function collection<T extends z.ZodType>(result: unknown, key: string, schema: T): z.output<T>[] {
  const payload = responseData(result);
  const values = Array.isArray(payload) ? payload : isRecord(payload) ? payload[key] : undefined;
  if (!Array.isArray(values)) throw new Error(`Composio Trello ${key} response did not match the verified schema`);
  const parsed = z.array(schema).safeParse(values);
  if (!parsed.success) throw new Error(`Composio Trello ${key} response did not match the verified schema`);
  return parsed.data;
}

function providerCard(card: z.output<typeof cardSchema>): TrelloProviderCard {
  const labelIds = card.idLabels ?? card.labels?.map((label) => label.id);
  if (!labelIds) throw new Error("Composio Trello card response omitted label state");
  return {
    id: card.id,
    name: card.name,
    desc: card.desc,
    idList: card.idList,
    labelIds,
    shortUrl: card.shortUrl,
    url: card.url,
  };
}

function matchesDesiredCard(card: TrelloCard, desired: TrelloCardInput | TrelloCard): boolean {
  return card.id === ("id" in desired ? desired.id : card.id)
    && card.businessReference === desired.businessReference
    && card.lifecycle === desired.lifecycle
    && card.title === desired.title
    && card.description === withBusinessReferenceMarker(desired.description, desired.businessReference);
}

function businessReferenceFromDescription(description: string): string | undefined {
  const marker = description.split(/\r?\n/u).find((line) => /^Business reference: SC-[A-F0-9]{16}$/u.test(line));
  return marker?.slice("Business reference: ".length);
}

function hasBusinessReferenceMarker(description: string, businessReference: string): boolean {
  return description.split(/\r?\n/u).includes(`Business reference: ${businessReference}`);
}

function withBusinessReferenceMarker(description: string, businessReference: string): string {
  const marker = `Business reference: ${businessReference}`;
  const withoutMarkers = description.split(/\r?\n/u).filter((line) => !line.startsWith("Business reference:"));
  return [marker, ...withoutMarkers].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class FakeTrelloGateway implements TrelloGateway {
  readonly creates: TrelloCardInput[] = [];
  readonly updates: Array<TrelloCard & { lifecycle: Exclude<TrelloLifecycle, "done" | "lost"> }> = [];
  readonly labelUpdates: Array<{ cardId: string; enabled: boolean }> = [];
  readonly cardsById = new Map<string, TrelloCard>();
  nextCreateResult: TrelloFailure | undefined;
  nextUpdateResult: TrelloFailure | undefined;
  nextLabelResult: TrelloFailure | undefined;
  createThenReturnAmbiguous = false;
  updateThenReturnAmbiguous = false;
  labelThenReturnAmbiguous = false;

  async lookupByBusinessReference(businessReference: string): Promise<TrelloReferenceLookup> {
    const cards = [...this.cardsById.values()].filter((card) => card.businessReference === businessReference);
    if (cards.length === 0) return { kind: "none" };
    if (cards.length === 1) return { kind: "one", card: { ...cards[0] } };
    return { kind: "duplicate", cardIds: cards.map((card) => card.id) };
  }

  async getCardById(cardId: string): Promise<TrelloCard | null> {
    const card = this.cardsById.get(cardId);
    return card ? { ...card } : null;
  }

  async findCardByBusinessReference(businessReference: string): Promise<TrelloCard | null> {
    const lookup = await this.lookupByBusinessReference(businessReference);
    return lookup.kind === "one" ? lookup.card : null;
  }

  async createCard(input: TrelloCardInput): Promise<TrelloWriteResult> {
    this.creates.push({ ...input });
    const existing = await this.lookupByBusinessReference(input.businessReference);
    if (existing.kind === "one") return { kind: "succeeded", card: existing.card };
    if (existing.kind === "duplicate") return { kind: "failed", code: "trello_business_reference_duplicate", ambiguous: true };
    if (this.nextCreateResult) return this.nextCreateResult;
    const card: TrelloCard = { id: `fake-trello-card-${this.cardsById.size + 1}`, ...input };
    this.cardsById.set(card.id, card);
    if (this.createThenReturnAmbiguous) {
      this.createThenReturnAmbiguous = false;
      return { kind: "failed", code: "trello_create_transport_failed", ambiguous: true };
    }
    return { kind: "succeeded", card: { ...card } };
  }

  async updateCard(input: TrelloCard & { lifecycle: Exclude<TrelloLifecycle, "done" | "lost"> }): Promise<TrelloWriteResult> {
    this.updates.push({ ...input });
    if (this.nextUpdateResult) return this.nextUpdateResult;
    const existing = this.cardsById.get(input.id);
    if (!existing || existing.businessReference !== input.businessReference) {
      return { kind: "failed", code: "trello_card_not_found", ambiguous: false };
    }
    if (existing.lifecycle === "done" || existing.lifecycle === "lost") return { kind: "succeeded", card: { ...existing } };
    const next: TrelloCard = { ...input, humanNeeded: existing.humanNeeded };
    this.cardsById.set(next.id, next);
    if (this.updateThenReturnAmbiguous) {
      this.updateThenReturnAmbiguous = false;
      return { kind: "failed", code: "trello_update_transport_failed", ambiguous: true };
    }
    return { kind: "succeeded", card: { ...next } };
  }

  async setHumanNeededLabel(input: { cardId: string; enabled: boolean }): Promise<TrelloWriteResult> {
    this.labelUpdates.push({ ...input });
    if (this.nextLabelResult) return this.nextLabelResult;
    const card = this.cardsById.get(input.cardId);
    if (!card) return { kind: "failed", code: "trello_card_not_found", ambiguous: false };
    card.humanNeeded = input.enabled;
    if (this.labelThenReturnAmbiguous) {
      this.labelThenReturnAmbiguous = false;
      return { kind: "failed", code: "trello_label_transport_failed", ambiguous: true };
    }
    return { kind: "succeeded", card: { ...card } };
  }

  setCardLifecycle(cardId: string, lifecycle: TrelloLifecycle): void {
    const card = this.cardsById.get(cardId);
    if (!card) throw new Error(`Unknown fake Trello card ${cardId}`);
    card.lifecycle = lifecycle;
  }

  setCardHumanNeeded(cardId: string, humanNeeded: boolean): void {
    const card = this.cardsById.get(cardId);
    if (!card) throw new Error(`Unknown fake Trello card ${cardId}`);
    card.humanNeeded = humanNeeded;
  }

  addDuplicateCard(card: TrelloCard): void {
    this.cardsById.set(card.id, { ...card });
  }
}
