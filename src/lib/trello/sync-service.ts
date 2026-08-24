import { createHash } from "node:crypto";

import type { LeadStatus } from "@/lib/contracts/domain";
import type { LeadRepository, StoredLead } from "@/lib/leads/repository";
import { isTerminalTrelloLifecycle, presentTrelloCard } from "@/lib/trello/presenter";
import type { TrelloCard, TrelloGateway } from "@/lib/trello/gateway";

type SyncableLifecycle = Extract<LeadStatus, "new_lead" | "qualified" | "booked">;
type SyncFailure = { ok: false; code: string; ambiguous: boolean };
type SyncSuccess = { ok: true; cardId: string; terminalLifecycle?: "done" | "lost" };

export type TrelloSyncResult = SyncSuccess | SyncFailure;

export class TrelloSyncService {
  constructor(private readonly repository: LeadRepository, private readonly gateway: TrelloGateway) {}

  async syncLead(
    lead: StoredLead,
    lifecycle: SyncableLifecycle = lead.status as SyncableLifecycle,
  ): Promise<TrelloSyncResult> {
    if (lifecycle !== "new_lead" && lifecycle !== "qualified" && lifecycle !== "booked") {
      return { ok: false, code: "trello_lifecycle_not_syncable", ambiguous: false };
    }
    const resolved = await this.resolveCard(lead, lifecycle);
    if (!resolved.ok) return resolved;
    const card = resolved.card;
    await this.persistCard(lead, card);
    if (isTerminalTrelloLifecycle(card.lifecycle)) {
      await this.reflectTerminalLifecycle(lead, card);
      return { ok: true, cardId: card.id, terminalLifecycle: card.lifecycle };
    }

    const desired = presentTrelloCard(lead, lifecycle);
    const cardWrite = await this.syncCardState(lead, card, desired, lifecycle);
    if (!cardWrite.ok) return cardWrite;
    await this.persistCard(lead, cardWrite.card);
    const labelWrite = await this.syncHumanNeededLabel(lead, cardWrite.card);
    if (!labelWrite.ok) return labelWrite;
    return { ok: true, cardId: card.id };
  }

  async syncHumanNeededLabelOnly(lead: StoredLead): Promise<TrelloSyncResult> {
    const known = await this.lookupExistingCard(lead);
    if (!known.ok) return known;
    if (!known.card) return { ok: false, code: "trello_card_missing_for_label_recovery", ambiguous: true };
    const card = known.card;
    await this.persistCard(lead, card);
    if (isTerminalTrelloLifecycle(card.lifecycle)) {
      await this.reflectTerminalLifecycle(lead, card);
      return { ok: true, cardId: card.id, terminalLifecycle: card.lifecycle };
    }
    const labelWrite = await this.syncHumanNeededLabel(lead, card);
    if (!labelWrite.ok) return labelWrite;
    return { ok: true, cardId: card.id };
  }

  private async resolveCard(
    lead: StoredLead,
    lifecycle: SyncableLifecycle,
  ): Promise<{ ok: true; card: TrelloCard } | SyncFailure> {
    const known = await this.lookupExistingCard(lead);
    if (!known.ok) return known;
    if (known.card) return { ok: true, card: known.card };
    return this.createOrRecoverCard(lead, lifecycle);
  }

  private async lookupExistingCard(
    lead: StoredLead,
  ): Promise<{ ok: true; card?: TrelloCard } | SyncFailure> {
    let lookup: Awaited<ReturnType<TrelloGateway["lookupByBusinessReference"]>>;
    try {
      lookup = await this.gateway.lookupByBusinessReference(lead.businessReference);
    } catch {
      return { ok: false, code: "trello_lookup_failed", ambiguous: true };
    }
    if (lookup.kind === "duplicate") {
      return { ok: false, code: "trello_business_reference_duplicate", ambiguous: true };
    }
    if (lead.trelloCardId) {
      let storedCard: TrelloCard | null;
      try {
        storedCard = await this.gateway.getCardById(lead.trelloCardId);
      } catch {
        return { ok: false, code: "trello_card_lookup_failed", ambiguous: true };
      }
      if (!storedCard || storedCard.businessReference !== lead.businessReference) {
        return { ok: false, code: "trello_stored_card_reconciliation_failed", ambiguous: true };
      }
      if (lookup.kind !== "one" || lookup.card.id !== storedCard.id) {
        return { ok: false, code: "trello_stored_card_reconciliation_failed", ambiguous: true };
      }
      return { ok: true, card: storedCard };
    }
    if (lookup.kind === "one") {
      await this.closeCreateOperationIfPresent(lead, lookup.card.id);
      return { ok: true, card: lookup.card };
    }
    return { ok: true };
  }

  private async createOrRecoverCard(
    lead: StoredLead,
    lifecycle: SyncableLifecycle,
  ): Promise<{ ok: true; card: TrelloCard } | SyncFailure> {
    const operationKey = `trello:create_card:${lead.id}`;
    const existing = await this.repository.getIntegrationOperation(operationKey);
    if (existing && existing.status !== "failed" && existing.status !== "succeeded") {
      const reconciled = await this.reconcileOneByBusinessReference(lead.businessReference);
      if (reconciled.ok) {
        await this.repository.completeIntegrationOperation(operationKey, reconciled.card.id);
        return reconciled;
      }
      return { ok: false, code: "trello_create_requires_recovery", ambiguous: true };
    }

    const operation = await this.repository.createIntegrationOperation({
      leadId: lead.id,
      idempotencyKey: operationKey,
      provider: "trello",
      operationType: "create_card",
    });
    if (!operation.isNew) {
      const reconciled = await this.reconcileOneByBusinessReference(lead.businessReference);
      if (reconciled.ok) {
        await this.repository.completeIntegrationOperation(operationKey, reconciled.card.id);
        return reconciled;
      }
      return { ok: false, code: "trello_create_requires_recovery", ambiguous: true };
    }
    const presentation = presentTrelloCard(lead, lifecycle);
    // A label is a separate Trello operation, never an incidental list/card
    // property. Its desired state is reconciled after card creation.
    const created = await this.gateway.createCard({ ...presentation, humanNeeded: false });
    if (created.kind === "succeeded") {
      await this.repository.completeIntegrationOperation(operationKey, created.card.id);
      return { ok: true, card: created.card };
    }
    await this.repository.failIntegrationOperation(operationKey, created.code, created.ambiguous ? "ambiguous" : "failed");
    if (created.ambiguous) {
      const reconciled = await this.reconcileOneByBusinessReference(lead.businessReference);
      if (reconciled.ok) {
        await this.repository.completeIntegrationOperation(operationKey, reconciled.card.id);
        return reconciled;
      }
    }
    return { ok: false, code: created.code, ambiguous: created.ambiguous };
  }

  private async syncCardState(
    lead: StoredLead,
    card: TrelloCard,
    desired: ReturnType<typeof presentTrelloCard>,
    lifecycle: SyncableLifecycle,
  ): Promise<{ ok: true; card: TrelloCard } | SyncFailure> {
    const operationKey = `trello:card_state:${lead.id}:${fingerprint({ title: desired.title, description: desired.description, lifecycle: desired.lifecycle })}`;
    if (sameCardState(card, desired)) {
      const matchingOperation = await this.repository.getIntegrationOperation(operationKey);
      if (matchingOperation && matchingOperation.status !== "failed") {
        await this.repository.completeIntegrationOperation(operationKey, card.id);
      }
      return { ok: true, card };
    }
    const existing = await this.repository.getIntegrationOperation(operationKey);
    if (existing && existing.status !== "failed" && existing.status !== "succeeded") {
      const reconciled = await this.reconcileCardState(card.id, desired);
      if (reconciled) {
        await this.repository.completeIntegrationOperation(operationKey, card.id);
        return { ok: true, card: reconciled };
      }
      return { ok: false, code: "trello_card_state_requires_recovery", ambiguous: true };
    }
    const operation = await this.repository.createIntegrationOperation({
      leadId: lead.id,
      idempotencyKey: operationKey,
      provider: "trello",
      operationType: "update_move_card",
    });
    if (!operation.isNew) {
      const reconciled = await this.reconcileCardState(card.id, desired);
      if (reconciled) {
        await this.repository.completeIntegrationOperation(operationKey, card.id);
        return { ok: true, card: reconciled };
      }
      return { ok: false, code: "trello_card_state_requires_recovery", ambiguous: true };
    }
    const updated = await this.gateway.updateCard({ id: card.id, ...desired, lifecycle });
    if (updated.kind === "succeeded") {
      await this.repository.completeIntegrationOperation(operationKey, card.id);
      return { ok: true, card: updated.card };
    }
    await this.repository.failIntegrationOperation(operationKey, updated.code, updated.ambiguous ? "ambiguous" : "failed");
    if (updated.ambiguous) {
      const reconciled = await this.reconcileCardState(card.id, desired);
      if (reconciled) {
        await this.repository.completeIntegrationOperation(operationKey, card.id);
        return { ok: true, card: reconciled };
      }
    }
    return { ok: false, code: updated.code, ambiguous: updated.ambiguous };
  }

  private async syncHumanNeededLabel(
    lead: StoredLead,
    card: TrelloCard,
  ): Promise<{ ok: true } | SyncFailure> {
    const operationKey = `trello:human_needed_label:${lead.id}:${lead.humanNeeded ? "on" : "off"}`;
    if (card.humanNeeded === lead.humanNeeded) {
      const matchingOperation = await this.repository.getIntegrationOperation(operationKey);
      if (matchingOperation && matchingOperation.status !== "failed") {
        await this.repository.completeIntegrationOperation(operationKey, card.id);
      }
      return { ok: true };
    }
    const existing = await this.repository.getIntegrationOperation(operationKey);
    if (existing && existing.status !== "failed" && existing.status !== "succeeded") {
      if (await this.reconcileLabel(card.id, lead.humanNeeded)) {
        await this.repository.completeIntegrationOperation(operationKey, card.id);
        return { ok: true };
      }
      return { ok: false, code: "trello_label_requires_recovery", ambiguous: true };
    }
    const operation = await this.repository.createIntegrationOperation({
      leadId: lead.id,
      idempotencyKey: operationKey,
      provider: "trello",
      operationType: "set_human_needed_label",
    });
    if (!operation.isNew) {
      if (await this.reconcileLabel(card.id, lead.humanNeeded)) {
        await this.repository.completeIntegrationOperation(operationKey, card.id);
        return { ok: true };
      }
      return { ok: false, code: "trello_label_requires_recovery", ambiguous: true };
    }
    const updated = await this.gateway.setHumanNeededLabel({ cardId: card.id, enabled: lead.humanNeeded });
    if (updated.kind === "succeeded") {
      await this.repository.completeIntegrationOperation(operationKey, card.id);
      return { ok: true };
    }
    await this.repository.failIntegrationOperation(operationKey, updated.code, updated.ambiguous ? "ambiguous" : "failed");
    if (updated.ambiguous && await this.reconcileLabel(card.id, lead.humanNeeded)) {
      await this.repository.completeIntegrationOperation(operationKey, card.id);
      return { ok: true };
    }
    return { ok: false, code: updated.code, ambiguous: updated.ambiguous };
  }

  private async reconcileOneByBusinessReference(businessReference: string): Promise<{ ok: true; card: TrelloCard } | SyncFailure> {
    try {
      const lookup = await this.gateway.lookupByBusinessReference(businessReference);
      if (lookup.kind === "one") return { ok: true, card: lookup.card };
      if (lookup.kind === "duplicate") return { ok: false, code: "trello_business_reference_duplicate", ambiguous: true };
      return { ok: false, code: "trello_card_missing", ambiguous: true };
    } catch {
      return { ok: false, code: "trello_lookup_failed", ambiguous: true };
    }
  }

  private async reconcileCardState(cardId: string, desired: ReturnType<typeof presentTrelloCard>): Promise<TrelloCard | undefined> {
    try {
      const card = await this.gateway.getCardById(cardId);
      return card && sameCardState(card, desired) ? card : undefined;
    } catch {
      return undefined;
    }
  }

  private async reconcileLabel(cardId: string, enabled: boolean): Promise<boolean> {
    try {
      return (await this.gateway.getCardById(cardId))?.humanNeeded === enabled;
    } catch {
      return false;
    }
  }

  private async closeCreateOperationIfPresent(lead: StoredLead, cardId: string): Promise<void> {
    const operation = await this.repository.getIntegrationOperation(`trello:create_card:${lead.id}`);
    if (operation && (operation.status === "pending" || operation.status === "ambiguous" || operation.status === "succeeded")) {
      await this.repository.completeIntegrationOperation(operation.idempotencyKey, cardId);
    }
  }

  private async persistCard(lead: StoredLead, card: TrelloCard): Promise<void> {
    const nextUrl = card.directUrl ?? lead.trelloCardUrl;
    if (lead.trelloCardId === card.id && lead.trelloCardUrl === nextUrl) return;
    lead.trelloCardId = card.id;
    lead.trelloCardUrl = nextUrl;
    await this.repository.saveLead(lead);
  }

  private async reflectTerminalLifecycle(lead: StoredLead, card: TrelloCard): Promise<void> {
    if (!isTerminalTrelloLifecycle(card.lifecycle) || lead.status === card.lifecycle) return;
    lead.status = card.lifecycle;
    await this.repository.saveLead(lead);
    await this.repository.appendActivity(lead.id, "trello_terminal_lifecycle_observed", {
      trello_card_id: card.id,
      lifecycle: card.lifecycle,
    });
  }
}

function sameCardState(card: TrelloCard, desired: ReturnType<typeof presentTrelloCard>): boolean {
  return card.title === desired.title && card.description === desired.description && card.lifecycle === desired.lifecycle;
}

function fingerprint(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}
