import { describe, expect, it } from "vitest";

import { PINNED_TRELLO_TOOLKIT_VERSION } from "@/lib/trello/constants";
import { ComposioTrelloGateway, type ComposioToolExecutor } from "@/lib/trello/gateway";
import { canonicalTrelloCardUrl } from "@/lib/trello/card-url";

const environment = {
  apiKey: "test-key",
  userId: "user-1",
  connectedAccountId: "account-1",
  toolkitVersion: PINNED_TRELLO_TOOLKIT_VERSION,
  boardId: "board-1",
  humanNeededLabelId: "label-human",
};

const lists = [
  { id: "list-new", name: "New Lead", closed: false },
  { id: "list-qualified", name: "Qualified", closed: false },
  { id: "list-booked", name: "Booked", closed: false },
  { id: "list-done", name: "Done", closed: false },
  { id: "list-lost", name: "Lost", closed: false },
];
const labels = [{ id: "label-human", name: "Human Needed" }, { id: "label-other", name: "Priority" }];
const card = {
  id: "card-1",
  idList: "list-qualified",
  name: "SC-0123456789ABCDEF · Vracar · 80 m²",
  desc: "Business reference: SC-0123456789ABCDEF\nContact: Telegram bot conversation",
  labels: [{ id: "label-human", name: "Human Needed" }],
};

class MockComposio implements ComposioToolExecutor {
  readonly calls: Array<{ tool: string; request: Parameters<ComposioToolExecutor["execute"]>[1] }> = [];

  constructor(private readonly handlers: Record<string, unknown | ((request: Parameters<ComposioToolExecutor["execute"]>[1]) => unknown)>) {}

  async execute(tool: string, request: Parameters<ComposioToolExecutor["execute"]>[1]): Promise<unknown> {
    this.calls.push({ tool, request });
    const handler = this.handlers[tool];
    if (handler instanceof Error) throw handler;
    return typeof handler === "function" ? handler(request) : handler;
  }
}

function envelope(responseData: unknown): unknown {
  return { successful: true, data: { response_data: responseData } };
}

// Observed live result for TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD_BY_ID_CARD:
// the card is the direct `data` value, without `response_data` or `cards`.
function liveDirectCardEnvelope(cardResponse: unknown): unknown {
  return { successful: true, data: cardResponse };
}

function gateway(mock: MockComposio): ComposioTrelloGateway {
  return new ComposioTrelloGateway(environment, mock);
}

function normalHandlers(overrides: Record<string, unknown | ((request: Parameters<ComposioToolExecutor["execute"]>[1]) => unknown)> = {}): Record<string, unknown | ((request: Parameters<ComposioToolExecutor["execute"]>[1]) => unknown)> {
  return {
    TRELLO_GET_BOARDS_LISTS_BY_ID_BOARD: envelope({ lists }),
    TRELLO_GET_BOARDS_LABELS_BY_ID_BOARD: envelope({ labels }),
    TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD: envelope({ cards: [card] }),
    TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD_BY_ID_CARD: (request: Parameters<ComposioToolExecutor["execute"]>[1]) => liveDirectCardEnvelope(request.arguments.idCard === "card-created"
      ? { ...card, id: "card-created", idList: "list-new", labels: [] }
      : card),
    TRELLO_ADD_CARDS: envelope({ cards: [{ ...card, id: "card-created", idList: "list-new", labels: [] }] }),
    TRELLO_UPDATE_CARDS_BY_ID_CARD: envelope({ cards: [card] }),
    TRELLO_ADD_CARDS_ID_LABELS_BY_ID_CARD: envelope({ ok: true }),
    TRELLO_REMOVE_LABEL_FROM_CARD: envelope({ ok: true }),
    ...overrides,
  };
}

describe("ComposioTrelloGateway", () => {
  it("normalizes only canonical authoritative Trello card URLs", () => {
    expect(canonicalTrelloCardUrl("https://www.trello.com/c/abc_123")).toBe("https://trello.com/c/abc_123");
    expect(canonicalTrelloCardUrl("https://trello.com/c/abc_123/a-card-slug")).toBe("https://trello.com/c/abc_123");
    expect(canonicalTrelloCardUrl("https://trello.com/c/abc?token=x")).toBeUndefined();
    expect(canonicalTrelloCardUrl("https://user:pass@trello.com/c/abc")).toBeUndefined();
    expect(canonicalTrelloCardUrl("https://trello.com/b/board")).toBeUndefined();
    expect(canonicalTrelloCardUrl("http://trello.com/c/abc")).toBeUndefined();
  });
  it("uses the pinned account/version and only idBoard on discovery reads", async () => {
    const mock = new MockComposio(normalHandlers());
    await expect(gateway(mock).getCardById("card-1")).resolves.toMatchObject({
      id: "card-1",
      lifecycle: "qualified",
      humanNeeded: true,
    });

    expect(mock.calls.slice(0, 2).map((call) => call.tool).sort()).toEqual([
      "TRELLO_GET_BOARDS_LABELS_BY_ID_BOARD",
      "TRELLO_GET_BOARDS_LISTS_BY_ID_BOARD",
    ]);
    for (const call of mock.calls.slice(0, 2)) {
      expect(call.request).toEqual({
        userId: "user-1",
        connectedAccountId: "account-1",
        version: PINNED_TRELLO_TOOLKIT_VERSION,
        arguments: { idBoard: "board-1" },
      });
    }
    expect(mock.calls.at(-1)).toEqual({
      tool: "TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD_BY_ID_CARD",
      request: {
        userId: "user-1",
        connectedAccountId: "account-1",
        version: PINNED_TRELLO_TOOLKIT_VERSION,
        arguments: { idBoard: "board-1", idCard: "card-1" },
      },
    });
  });

  it("fails closed when lifecycle topology is extra, duplicate, or the configured label is wrong", async () => {
    const extra = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_LISTS_BY_ID_BOARD: envelope({ lists: [...lists, { id: "list-other", name: "Follow up", closed: false }] }),
    }));
    await expect(gateway(extra).getCardById("card-1")).rejects.toThrow(/exactly the five canonical/i);

    const duplicate = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_LISTS_BY_ID_BOARD: envelope({ lists: [...lists, { id: "list-new-2", name: "New Lead", closed: false }] }),
    }));
    await expect(gateway(duplicate).getCardById("card-1")).rejects.toThrow(/exactly the five canonical/i);

    const wrongLabel = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_LABELS_BY_ID_BOARD: envelope({ labels: [{ id: "label-human", name: "Escalated" }] }),
    }));
    await expect(gateway(wrongLabel).getCardById("card-1")).rejects.toThrow(/Human Needed label/i);

    const duplicateHumanLabel = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_LABELS_BY_ID_BOARD: envelope({ labels: [...labels, { id: "label-human-2", name: "Human Needed" }] }),
    }));
    await expect(gateway(duplicateHumanLabel).getCardById("card-1")).rejects.toThrow(/one unique exact-name/i);
  });

  it("allows Trello's unnamed standard labels but still requires one exact Human Needed label", async () => {
    const unnamedStandardLabels = [
      { id: "label-1", name: "" },
      { id: "label-2", name: "" },
      { id: "label-3", name: "" },
      { id: "label-4", name: "" },
      { id: "label-5", name: "" },
      { id: "label-human", name: "Human Needed" },
    ];
    const permitted = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_LABELS_BY_ID_BOARD: envelope({ labels: unnamedStandardLabels }),
    }));
    await expect(gateway(permitted).getCardById("card-1")).resolves.toMatchObject({ id: "card-1" });

    const missing = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_LABELS_BY_ID_BOARD: envelope({ labels: unnamedStandardLabels.filter((label) => label.id !== "label-human") }),
    }));
    await expect(gateway(missing).getCardById("card-1")).rejects.toThrow(/one unique exact-name/i);
  });

  it("accepts the current direct-card response and the legacy exact-one wrapper, but rejects malformed collections", async () => {
    const direct = new MockComposio(normalHandlers());
    await expect(gateway(direct).getCardById("card-1")).resolves.toMatchObject({ id: "card-1" });

    const legacy = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD_BY_ID_CARD: envelope({ cards: [card] }),
    }));
    await expect(gateway(legacy).getCardById("card-1")).resolves.toMatchObject({ id: "card-1" });

    const zero = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD_BY_ID_CARD: envelope({ cards: [] }),
    }));
    await expect(gateway(zero).getCardById("card-1")).rejects.toThrow(/exactly one card/i);

    const multiple = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD_BY_ID_CARD: envelope({ cards: [card, { ...card, id: "card-2" }] }),
    }));
    await expect(gateway(multiple).getCardById("card-1")).rejects.toThrow(/exactly one card/i);

    const missingLabelState = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD_BY_ID_CARD: liveDirectCardEnvelope({ ...card, labels: undefined }),
    }));
    await expect(gateway(missingLabelState).getCardById("card-1")).rejects.toThrow(/card response/i);
  });

  it("finds only the exact business-reference description marker and reports duplicate markers", async () => {
    const markerCard = { ...card, id: "marker-card" };
    const titleOnly = { ...card, id: "title-only", desc: "Contact: Telegram bot conversation" };
    const mock = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD: envelope({ cards: [markerCard, titleOnly] }),
    }));
    await expect(gateway(mock).lookupByBusinessReference("SC-0123456789ABCDEF"))
      .resolves.toMatchObject({ kind: "one", card: { id: "marker-card" } });

    const duplicate = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD: envelope({ cards: [markerCard, { ...markerCard, id: "marker-card-2" }] }),
    }));
    await expect(gateway(duplicate).lookupByBusinessReference("SC-0123456789ABCDEF"))
      .resolves.toEqual({ kind: "duplicate", cardIds: ["marker-card", "marker-card-2"] });
  });

  it("reads a privacy-minimized board projection including manually created Done and Lost cards", async () => {
    const manualDone = { ...card, id: "manual-done", idList: "list-done", name: "Manual completed cleaning", desc: "Customer-facing notes must not leak", labels: [] };
    const manualLost = { ...card, id: "manual-lost", idList: "list-lost", name: "Manual lost enquiry", desc: "No application marker", labels: [] };
    const mock = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD: envelope({ cards: [card, manualDone, manualLost] }),
    }));
    const projection = await gateway(mock).listBoardCards();
    expect(projection).toEqual([
      { title: card.name, lifecycle: "qualified", humanNeeded: true },
      { title: "Manual completed cleaning", lifecycle: "done", humanNeeded: false },
      { title: "Manual lost enquiry", lifecycle: "lost", humanNeeded: false },
    ]);
    expect(JSON.stringify(projection)).not.toContain("Customer-facing notes");
    expect(JSON.stringify(projection)).not.toContain("Business reference");
  });

  it("maps create, update and independent label changes to the verified Trello tool arguments", async () => {
    let directHumanNeeded = true;
    const mock = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD_BY_ID_CARD: (request: Parameters<ComposioToolExecutor["execute"]>[1]) => liveDirectCardEnvelope(request.arguments.idCard === "card-created"
        ? { ...card, id: "card-created", idList: "list-new", labels: [] }
        : { ...card, labels: directHumanNeeded ? card.labels : [] }),
    }));
    const subject = gateway(mock);
    const input = {
      businessReference: "SC-0123456789ABCDEF",
      title: "SC-0123456789ABCDEF · Vracar · 80 m²",
      description: "Contact: Telegram bot conversation",
      lifecycle: "new_lead" as const,
      humanNeeded: false,
    };
    await expect(subject.lookupByBusinessReference(input.businessReference)).resolves.toMatchObject({ kind: "one" });
    await expect(subject.createCard(input)).resolves.toMatchObject({ kind: "succeeded", card: { id: "card-created", lifecycle: "new_lead" } });
    expect(mock.calls.find((call) => call.tool === "TRELLO_ADD_CARDS")?.request.arguments).toEqual({
      idList: "list-new",
      name: input.title,
      desc: "Business reference: SC-0123456789ABCDEF\nContact: Telegram bot conversation",
      idBoard: "board-1",
    });

    await expect(subject.updateCard({ id: "card-1", ...input, lifecycle: "qualified", humanNeeded: true })).resolves.toMatchObject({ kind: "succeeded" });
    expect(mock.calls.find((call) => call.tool === "TRELLO_UPDATE_CARDS_BY_ID_CARD")?.request.arguments).toEqual({
      idCard: "card-1",
      idList: "list-qualified",
      name: input.title,
      desc: "Business reference: SC-0123456789ABCDEF\nContact: Telegram bot conversation",
    });

    await expect(subject.setHumanNeededLabel({ cardId: "card-1", enabled: true })).resolves.toMatchObject({ kind: "succeeded" });
    directHumanNeeded = false;
    await expect(subject.setHumanNeededLabel({ cardId: "card-1", enabled: false })).resolves.toMatchObject({ kind: "succeeded" });
    expect(mock.calls.find((call) => call.tool === "TRELLO_ADD_CARDS_ID_LABELS_BY_ID_CARD")?.request.arguments)
      .toEqual({ idCard: "card-1", value: "label-human" });
    expect(mock.calls.find((call) => call.tool === "TRELLO_REMOVE_LABEL_FROM_CARD")?.request.arguments)
      .toEqual({ idCard: "card-1", idLabel: "label-human" });
    expect(mock.calls.every((call) => call.tool.startsWith("TRELLO_"))).toBe(true);
  });

  it("does not report a stale direct read as a booked-card confirmation", async () => {
    const mock = new MockComposio(normalHandlers({
      // Trello acknowledged the update, but the authoritative direct read is
      // still in Qualified. The caller must therefore keep the reservation
      // pending rather than mark the lead Booked/send a final confirmation.
      TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD_BY_ID_CARD: envelope({ cards: [card] }),
    }));
    await expect(gateway(mock).updateCard({
      id: "card-1",
      businessReference: "SC-0123456789ABCDEF",
      title: card.name,
      description: card.desc,
      lifecycle: "booked",
      humanNeeded: true,
    })).resolves.toEqual({ kind: "failed", code: "trello_update_confirmation_failed", ambiguous: true });
  });

  it("does not report a label change successful until direct read confirms its exact state", async () => {
    const mock = new MockComposio(normalHandlers({
      // The remove call is acknowledged, but direct state still has the label.
      TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD_BY_ID_CARD: envelope({ cards: [card] }),
    }));
    await expect(gateway(mock).setHumanNeededLabel({ cardId: "card-1", enabled: false }))
      .resolves.toEqual({ kind: "failed", code: "trello_label_confirmation_failed", ambiguous: true });
  });

  it("refreshes topology after its short TTL and fails closed when the board drifts", async () => {
    let time = 0;
    let currentLists = lists;
    const mock = new MockComposio(normalHandlers({
      TRELLO_GET_BOARDS_LISTS_BY_ID_BOARD: () => envelope({ lists: currentLists }),
    }));
    const subject = new ComposioTrelloGateway(environment, mock, { now: () => time, topologyCacheTtlMs: 10 });
    await expect(subject.getCardById("card-1")).resolves.toMatchObject({ id: "card-1" });
    currentLists = [...lists, { id: "drift", name: "Unexpected", closed: false }];
    time = 11;
    await expect(subject.getCardById("card-1")).rejects.toThrow(/exactly the five canonical/i);
  });

  it("rejects a non-pinned toolkit version before any Composio execution", () => {
    const mock = new MockComposio(normalHandlers());
    expect(() => new ComposioTrelloGateway({ ...environment, toolkitVersion: "20260822_01" }, mock))
      .toThrow(`pinned to ${PINNED_TRELLO_TOOLKIT_VERSION}`);
    expect(mock.calls).toEqual([]);
  });

  it("returns ambiguous write failures when Composio rejects or returns an unusable response", async () => {
    const rejected = new MockComposio(normalHandlers({ TRELLO_ADD_CARDS: { successful: false, data: {} } }));
    await expect(gateway(rejected).createCard({
      businessReference: "SC-0123456789ABCDEF", title: "title", description: "description", lifecycle: "new_lead", humanNeeded: false,
    })).resolves.toEqual({ kind: "failed", code: "trello_create_transport_failed", ambiguous: true });

    const invalid = new MockComposio(normalHandlers({ TRELLO_UPDATE_CARDS_BY_ID_CARD: { successful: false, data: {} } }));
    await expect(gateway(invalid).updateCard({
      id: "card-1", businessReference: "SC-0123456789ABCDEF", title: "title", description: "description", lifecycle: "qualified", humanNeeded: false,
    })).resolves.toEqual({ kind: "failed", code: "trello_update_transport_failed", ambiguous: true });

    const labelRejected = new MockComposio(normalHandlers({ TRELLO_ADD_CARDS_ID_LABELS_BY_ID_CARD: { successful: false, data: {} } }));
    await expect(gateway(labelRejected).setHumanNeededLabel({ cardId: "card-1", enabled: true }))
      .resolves.toEqual({ kind: "failed", code: "trello_label_transport_failed", ambiguous: true });
  });
});
