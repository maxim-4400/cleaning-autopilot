import "server-only";

import { ComposioTrelloGateway, type TrelloBoardProjectionCard, type TrelloBoardReader } from "@/lib/trello/gateway";

export type LiveTrelloProjection = {
  state: "fresh" | "stale" | "unavailable" | "not_configured";
  cards: TrelloBoardProjectionCard[];
  observedAt?: string;
};

export interface LiveTrelloProjectionReader {
  read(): Promise<LiveTrelloProjection>;
}

/**
 * Cache a read-only board view across dashboard requests. A short TTL protects
 * Trello from the dashboard's five-second client polling while still allowing
 * manual moves and cards to become visible promptly. Failed refreshes retain
 * the last successful snapshot and label it stale rather than fabricating an
 * empty board.
 */
export class CachedLiveTrelloProjectionReader implements LiveTrelloProjectionReader {
  private latest: { cards: TrelloBoardProjectionCard[]; observedAt: string; expiresAt: number } | undefined;
  private inFlight: Promise<LiveTrelloProjection> | undefined;

  constructor(
    private readonly reader: TrelloBoardReader,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 30_000,
  ) {}

  async read(): Promise<LiveTrelloProjection> {
    const current = this.now();
    if (this.latest && this.latest.expiresAt > current) {
      return { state: "fresh", cards: this.latest.cards, observedAt: this.latest.observedAt };
    }
    if (this.inFlight) return this.inFlight;

    const request = this.refresh();
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  private async refresh(): Promise<LiveTrelloProjection> {
    try {
      const cards = await this.reader.listBoardCards();
      const observedAt = new Date(this.now()).toISOString();
      this.latest = { cards, observedAt, expiresAt: this.now() + this.ttlMs };
      return { state: "fresh", cards, observedAt };
    } catch {
      return this.latest
        ? { state: "stale", cards: this.latest.cards, observedAt: this.latest.observedAt }
        : { state: "unavailable", cards: [] };
    }
  }
}

type TrelloEnvironmentSource = Record<string, string | undefined>;

function value(env: TrelloEnvironmentSource, key: string): string | undefined {
  const candidate = env[key]?.trim();
  return candidate || undefined;
}

export function configuredLiveTrelloProjectionReader(environment: TrelloEnvironmentSource = process.env): LiveTrelloProjectionReader | undefined {
  const apiKey = value(environment, "COMPOSIO_API_KEY");
  const userId = value(environment, "COMPOSIO_TRELLO_USER_ID");
  const connectedAccountId = value(environment, "COMPOSIO_TRELLO_CONNECTED_ACCOUNT_ID");
  const toolkitVersion = value(environment, "COMPOSIO_TRELLO_TOOLKIT_VERSION");
  const boardId = value(environment, "TRELLO_BOARD_ID");
  const humanNeededLabelId = value(environment, "TRELLO_HUMAN_NEEDED_LABEL_ID");
  if (!apiKey || !userId || !connectedAccountId || !toolkitVersion || !boardId || !humanNeededLabelId) return undefined;
  return new CachedLiveTrelloProjectionReader(new ComposioTrelloGateway({
    apiKey,
    userId,
    connectedAccountId,
    toolkitVersion,
    boardId,
    humanNeededLabelId,
  }));
}
