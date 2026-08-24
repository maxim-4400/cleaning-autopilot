import { describe, expect, it } from "vitest";

import { InMemoryLeadRepository } from "@/lib/leads/in-memory-repository";
import { FakeTrelloGateway } from "@/lib/trello/gateway";
import { canonicalTrelloCardUrl } from "@/lib/trello/card-url";
import { presentTrelloCard } from "@/lib/trello/presenter";
import { TrelloSyncService } from "@/lib/trello/sync-service";

async function createLead() {
  const repository = new InMemoryLeadRepository();
  const lead = await repository.createLead({ telegramChatId: 998877, firstMessageLanguage: "und", agentConfigVersion: 5 });
  lead.clientData = {
    cleaningType: "standard",
    areaM2: 80,
    rooms: 3,
    bathrooms: 1,
    heavyPetHair: false,
    extras: ["windows"],
    addressOrDistrict: "Vracar",
    preferredDate: "2026-08-24",
  };
  lead.quote = {
    amountRsd: 7300,
    baseRsd: 6400,
    volumeDiscountPercent: 0,
    bathroomSurchargeRsd: 0,
    petHairSurchargeRsd: 0,
    extrasSurchargeRsd: 900,
    sameDayApplied: false,
    pricingRulesVersion: 1,
  };
  lead.quoteValidity = "active";
  return { repository, lead };
}

describe("Trello presentation and sync", () => {
  it("renders only approved structured business facts without technical identifiers", async () => {
    const { lead } = await createLead();
    const card = presentTrelloCard(lead);

    expect(card.title).toBe("Telegram customer · Vracar · 80 m²");
    expect(card.description).toContain("Contact: No public Telegram username");
    expect(card.description).toContain("Quote: 7,300 RSD");
    expect(card.description).toContain("Extras: Windows");
    expect(card.description).not.toContain(String(lead.telegramChatId));
    expect(card.description).not.toContain(lead.id);
    expect(card.description).not.toContain("openai");
  });

  it("uses the same redacted customer, location, and area context for card titles", async () => {
    const { lead } = await createLead();
    lead.customerDisplayName = "Mila Petrović";
    lead.clientData.addressOrDistrict = "12 Test Street, Belgrade";

    expect(presentTrelloCard(lead).title).toBe("Mila Petrović · Belgrade · 80 m²");
    expect(presentTrelloCard(lead).title).not.toContain("12 Test Street");
  });

  it("reconciles an ambiguous create by business reference without a second create", async () => {
    const { repository, lead } = await createLead();
    const gateway = new FakeTrelloGateway();
    gateway.createThenReturnAmbiguous = true;
    const sync = new TrelloSyncService(repository, gateway);

    await expect(sync.syncLead(lead, "new_lead")).resolves.toMatchObject({ ok: true, cardId: "fake-trello-card-1" });
    await expect(sync.syncLead(lead, "new_lead")).resolves.toMatchObject({ ok: true, cardId: "fake-trello-card-1" });
    expect(gateway.creates).toHaveLength(1);
    expect(lead.trelloCardId).toBe("fake-trello-card-1");
  });

  it("persists an authoritative direct URL and preserves it when a later read has none", async () => {
    const { repository, lead } = await createLead();
    const gateway = new FakeTrelloGateway();
    const originalCreate = gateway.createCard.bind(gateway);
    gateway.createCard = async (input) => {
      const result = await originalCreate(input);
      return result.kind === "succeeded" ? { ...result, card: { ...result.card, directUrl: canonicalTrelloCardUrl("https://trello.com/c/abc123/card-slug") } } : result;
    };
    const sync = new TrelloSyncService(repository, gateway);
    await sync.syncLead(lead, "new_lead");
    expect(lead.trelloCardUrl).toBe("https://trello.com/c/abc123");
    await sync.syncLead(lead, "new_lead");
    expect(lead.trelloCardUrl).toBe("https://trello.com/c/abc123");
  });

  it("does not regress a manually terminal Trello card", async () => {
    const { repository, lead } = await createLead();
    const gateway = new FakeTrelloGateway();
    const sync = new TrelloSyncService(repository, gateway);
    await sync.syncLead(lead, "new_lead");
    gateway.setCardLifecycle(lead.trelloCardId ?? "missing", "done");

    lead.status = "booked";
    await expect(sync.syncLead(lead, "booked")).resolves.toMatchObject({ ok: true });
    await expect(gateway.findCardByBusinessReference(lead.businessReference)).resolves.toMatchObject({ lifecycle: "done" });
  });

  it("updates Human Needed as a separate label without moving the card", async () => {
    const { repository, lead } = await createLead();
    const gateway = new FakeTrelloGateway();
    const sync = new TrelloSyncService(repository, gateway);
    lead.status = "qualified";
    lead.humanNeeded = true;
    lead.humanNeededReason = "scope_uncertain";

    await sync.syncLead(lead, "qualified");
    expect(gateway.labelUpdates.at(-1)).toMatchObject({ enabled: true });
    await expect(gateway.findCardByBusinessReference(lead.businessReference)).resolves.toMatchObject({
      lifecycle: "qualified",
      humanNeeded: true,
    });

    lead.humanNeeded = false;
    lead.humanNeededReason = undefined;
    await sync.syncLead(lead, "qualified");
    expect(gateway.labelUpdates.at(-1)).toMatchObject({ enabled: false });
    await expect(gateway.findCardByBusinessReference(lead.businessReference)).resolves.toMatchObject({
      lifecycle: "qualified",
      humanNeeded: false,
    });
  });

  it("does not write a matching card or label again", async () => {
    const { repository, lead } = await createLead();
    const gateway = new FakeTrelloGateway();
    const sync = new TrelloSyncService(repository, gateway);

    await sync.syncLead(lead, "new_lead");
    const writesAfterFirstSync = { updates: gateway.updates.length, labels: gateway.labelUpdates.length };
    await sync.syncLead(lead, "new_lead");

    expect(gateway.updates).toHaveLength(writesAfterFirstSync.updates);
    expect(gateway.labelUpdates).toHaveLength(writesAfterFirstSync.labels);
  });

  it("reopens a completed desired-state operation for label on-off-on and card A-B-A", async () => {
    const { repository, lead } = await createLead();
    const gateway = new FakeTrelloGateway();
    const sync = new TrelloSyncService(repository, gateway);
    await sync.syncLead(lead, "new_lead");

    lead.humanNeeded = true;
    lead.humanNeededReason = "scope_uncertain";
    await sync.syncLead(lead, "new_lead");
    lead.humanNeeded = false;
    lead.humanNeededReason = undefined;
    await sync.syncLead(lead, "new_lead");
    lead.humanNeeded = true;
    lead.humanNeededReason = "scope_uncertain";
    await expect(sync.syncLead(lead, "new_lead")).resolves.toMatchObject({ ok: true });
    expect(gateway.labelUpdates.map((update) => update.enabled)).toEqual([true, false, true]);

    const updatesBeforeContentCycle = gateway.updates.length;
    lead.clientData.areaM2 = 81;
    await sync.syncLead(lead, "new_lead");
    lead.clientData.areaM2 = 82;
    await sync.syncLead(lead, "new_lead");
    lead.clientData.areaM2 = 81;
    await expect(sync.syncLead(lead, "new_lead")).resolves.toMatchObject({ ok: true });
    expect(gateway.updates).toHaveLength(updatesBeforeContentCycle + 3);
  });

  it("atomically retries a definite create failure but reconciles ambiguous state by reading", async () => {
    const { repository, lead } = await createLead();
    const gateway = new FakeTrelloGateway();
    const sync = new TrelloSyncService(repository, gateway);
    gateway.nextCreateResult = { kind: "failed", code: "trello_503", ambiguous: false };

    await expect(sync.syncLead(lead, "new_lead")).resolves.toMatchObject({ ok: false, code: "trello_503" });
    gateway.nextCreateResult = undefined;
    await expect(sync.syncLead(lead, "new_lead")).resolves.toMatchObject({ ok: true, cardId: "fake-trello-card-1" });
    expect(gateway.creates).toHaveLength(2);
    expect(repository.operations.get(`trello:create_card:${lead.id}`)).toMatchObject({ status: "succeeded" });
  });

  it("reconciles ambiguous card and label writes instead of blindly repeating them", async () => {
    const { repository, lead } = await createLead();
    const gateway = new FakeTrelloGateway();
    const sync = new TrelloSyncService(repository, gateway);
    await sync.syncLead(lead, "new_lead");

    lead.clientData.areaM2 = 90;
    gateway.updateThenReturnAmbiguous = true;
    await expect(sync.syncLead(lead, "new_lead")).resolves.toMatchObject({ ok: true });
    expect(gateway.updates).toHaveLength(1);

    lead.humanNeeded = true;
    lead.humanNeededReason = "scope_uncertain";
    gateway.labelThenReturnAmbiguous = true;
    await expect(sync.syncLead(lead, "new_lead")).resolves.toMatchObject({ ok: true });
    expect(gateway.labelUpdates.at(-1)).toMatchObject({ enabled: true });
  });

  it("does not choose a Trello card when business-reference reconciliation is duplicate", async () => {
    const { repository, lead } = await createLead();
    const gateway = new FakeTrelloGateway();
    const sync = new TrelloSyncService(repository, gateway);
    gateway.addDuplicateCard({
      id: "duplicate-a",
      ...presentTrelloCard(lead),
    });
    gateway.addDuplicateCard({
      id: "duplicate-b",
      ...presentTrelloCard(lead),
    });

    await expect(sync.syncLead(lead, "new_lead")).resolves.toMatchObject({
      ok: false,
      code: "trello_business_reference_duplicate",
      ambiguous: true,
    });
    expect(lead.trelloCardId).toBeUndefined();
  });

  it("recovers after card creation or movement succeeds before the local lead save", async () => {
    const { repository, lead } = await createLead();
    const gateway = new FakeTrelloGateway();
    const sync = new TrelloSyncService(repository, gateway);
    const saveLead = repository.saveLead.bind(repository);
    let failSave = true;
    repository.saveLead = async (storedLead) => {
      if (failSave) {
        failSave = false;
        throw new Error("simulated local save crash");
      }
      await saveLead(storedLead);
    };

    await expect(sync.syncLead(lead, "new_lead")).rejects.toThrow("simulated local save crash");
    lead.trelloCardId = undefined;
    await expect(sync.syncLead(lead, "new_lead")).resolves.toMatchObject({ ok: true, cardId: "fake-trello-card-1" });
    expect(gateway.creates).toHaveLength(1);

    const beforeMove = structuredClone(lead);
    lead.status = "qualified";
    await sync.syncLead(lead, "qualified");
    const writesAfterMove = gateway.updates.length;
    failSave = true;
    await expect(repository.saveLead(lead)).rejects.toThrow("simulated local save crash");
    const recoveredAfterMove = { ...beforeMove, clientData: { ...beforeMove.clientData } };
    await expect(sync.syncLead(recoveredAfterMove, "qualified")).resolves.toMatchObject({ ok: true });
    await expect(repository.saveLead(recoveredAfterMove)).resolves.toBeUndefined();
    expect(gateway.updates).toHaveLength(writesAfterMove);
  });
});
