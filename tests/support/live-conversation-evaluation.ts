import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { AgentTurnTechnicalError, availabilityProviderEnvelopeConfig, availabilityTerminalToolConfig, maxAgentOutputTokens, maxAgentToolSteps, OpenAiAgentsGateway, providerReplayConfig, providerReplayInstructionRevision, providerReplayPromptContract, schedulingOmissionReplayConfig, schedulingOmissionReplayInstructionRevision, schedulingOmissionReplayPromptContract, type AgentGateway, type AgentTurnTechnicalCode, type ResponseRequestCounter } from "@/lib/agent/gateway";
import { getDemoConsoleConfigStore } from "@/lib/runtime-config/demo-console-config";

import { hasStockFillerReply, isFocusedIntakeReply, isTransportAndInternalSafeReply, runConversationScenario, type SanitizedConversationArtifact } from "./conversation-sandbox";
import type { SchedulingSemanticAction } from "@/lib/contracts/domain";
import { assertLiveConversationScenarioManifest, liveConversationMessageCount, liveConversationScenarioCount, liveConversationScenarios, requiredLiveConversationScenarioCount, type LiveConversationScenario } from "./conversation-live-scenarios";

export const liveEvaluationConfirmation = "I_UNDERSTAND_THIS_CALLS_OPENAI";
export const liveEvaluationProviderRequestTimeoutMs = providerReplayConfig.primaryMaxDurationMs;
export const liveEvaluationCustomerTurnDeadlineMs = 20_000;
export const liveEvaluationFocusedScenarioDeadlineMs = 45_000;
export const liveEvaluationLongScenarioDeadlineMs = 120_000;
export const liveEvaluationSuiteDeadlineMs = 20 * 60_000;
/** Four semantic tools can require a fifth model response to close the turn. */
export const liveEvaluationMaxResponsesPerCustomerMessage = 5;
export const liveEvaluationProviderResponseBudget = 220;
/** A customer message can require at most one fresh provider Conversation. */
export const liveEvaluationConversationCreateBudget = liveConversationMessageCount;
export const liveEvaluationSmokeScenarioCount = 5;
export const liveEvaluationP50TargetMs = 8_000;
export const liveEvaluationP95TargetMs = 15_000;
export const liveEvaluationRubricRevision = "visible-text-v36.3/current-turn-date-coordinate-exclusive-over-stale-durable-refs/date-scoped-negation-multiple-distinct-and-invalid-iso-require-clarification/strict-current-future-iso-coordinate/no-slots-attempt-exact-candidate-alongside-durable-refs/time-only-refinement-rechecks-attempt-coordinate-no-drift/finite-correction-record-decision-then-requote/finite-fully-booked-exact-candidate-alternative/dynamic-availability-date-schema-no-invented-coordinate/executor-coordinate-mismatch-zero-calendar-no-state-drift/finite-pre-offer-no-calendar-audit-alternative/finite-tomorrow-evening-explicit-equivalent/known-subtotal-plus-unreconciled-final-provider-leg/constraint-kind-specific-consent-after-before-range/no-hidden-numeric-bound-fallback/typed-no-slots-constraint-disposition-and-consent-paths/retain-selectable-reject-stale/refused-no-calendar-action-not-audit-evidence/candidate-commit-on-safe-availability/typed-availability-attempt-history-success-flush-after-delivery/confirmed-delivery-failure-offer-rollback/ambiguous-delivery-preserved-and-blocked/strict-attempt-grid-and-conditional-shapes/quoted-offered-attempt-read-scope/safe-last-attempt-checkpoint-evidence/last-attempt-one-of-structural-variants/offer-disposition-token-lifecycle-retain-read-failure-selectable/reject-now-stale/retained-offer-refresh-copy-no-handoff-promise/structural-checkpoint-equality/discriminated-provider-request-available-slots-envelope/state-scoped-scheduling-actions-one-of/sanitized-active-slot-starts-and-replacement-evidence/terminal-backend-rendered-availability-tool/protocol-reset-before-deferred-commit/fresh-offered-snapshot-with-active-quote/stateless-full-primary-scheduling-omission-replay/pricing-input-change-requires-quote-or-human-before-reset/published-technical-usage-not-unreconciled/pre-tool-provider-failure-replay/generic-date-only-no-prior-window-preserve-or-explicit/strict-prior-window-preserve-and-explicit-window-clear/actual-offer-quote-alignment/deferred-token-commit-compensation/calendar-read-failure-separation/trusted-typed-telegram-html/intake-groups-handoff-visible-checkpoint-normalization-integrity/conversation-create-budget-shared-smoke-remaining/gateway-and-webhook-source-binding";
/**
 * Binds the one-shot full-primary omission replay into the manifest. It can
 * make up to four model responses after a zero-tool primary, exactly matching
 * the five-response evaluator ceiling.
 */
export const liveEvaluationSchedulingOmissionReplay = {
  ...schedulingOmissionReplayConfig,
  instructionRevision: schedulingOmissionReplayInstructionRevision,
  promptContract: schedulingOmissionReplayPromptContract,
  /** Reuses the full primary system prompt independently bound below. */
  baseSystemPromptBinding: "manifest.prompt.sha256",
  resetConversationBeforeDeferredCommit: true,
} as const;
export const liveEvaluationProviderReplay = {
  ...providerReplayConfig,
  instructionRevision: providerReplayInstructionRevision,
  promptContract: providerReplayPromptContract,
  /** The base system prompt is independently bound in manifest.prompt. */
  baseSystemPromptBinding: "manifest.prompt.sha256",
  /** The production implementation that executes the replay is source-bound. */
  gatewaySourcePath: "src/lib/agent/gateway.ts",
  /** Webhook owns protocol reset, deferred commit and fresh Conversation creation. */
  webhookSourcePath: "src/lib/telegram/webhook.ts",
} as const;
/** Strict provider wire contract before canonical scheduling validation. */
export const liveEvaluationAvailabilityProviderEnvelope = availabilityProviderEnvelopeConfig;
export type LiveEvaluationProviderReplay = typeof liveEvaluationProviderReplay & {
  baseSystemPromptSha256: string;
  gatewaySourceSha256: string;
  webhookSourceSha256: string;
};
/** Binds the one tool that deliberately skips a model closure response. */
export const liveEvaluationAvailabilityTerminal = availabilityTerminalToolConfig;
export const liveEvaluationTokenCaps = {
  inputTokens: 500_000,
  outputTokens: 20_000,
  totalTokens: 550_000,
  cachedInputTokensDetail: true,
} as const;

export type LiveEvaluationPhase = "smoke" | "remaining";
export type LiveEvaluationRequest = {
  live: boolean; phase?: LiveEvaluationPhase; confirmation?: string; manifestSha256?: string; scenarioCount?: number;
  maxToolSteps?: number; model?: string; reasoningEffort?: string; maxOutputTokens?: number; maxSuiteDurationMs?: number;
  reportPath?: string; acceptedSmokeReportPath?: string;
};
export type LiveEvaluationManifest = {
  manifestSha256: string; fixtureSha256: string; scenarioCount: number; customerMessageCount: number;
  smokeScenarioCount: number; smokeCustomerMessageCount: number; model: string; reasoningEffort: "low";
  maxOutputTokens: number; maxSemanticToolSteps: number; maxResponsesPerCustomerMessage: number; providerResponseBudget: number;
  maxResponseAttemptsPerModelTurn: 1; maxConversationCreateRequests: number; maxProviderRequestDurationMs: number;
  maxCustomerTurnDurationMs: number; focusedScenarioDeadlineMs: number; longScenarioDeadlineMs: number; maxSuiteDurationMs: number;
  prompt: { source: "baseline" | "active"; revision: string; sha256: string }; pricingRules: { version: number; sha256: string };
  evaluator: { revision: string; sha256: string };
  schedulingOmissionReplay: typeof liveEvaluationSchedulingOmissionReplay;
  providerReplay: LiveEvaluationProviderReplay;
  availabilityProviderEnvelope: typeof liveEvaluationAvailabilityProviderEnvelope;
  availabilityTerminal: typeof liveEvaluationAvailabilityTerminal;
  tokenCaps: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokensDetail: true };
};
export type CompletedUsage = { requests: number; inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number };
export type UsageEvidence =
  | { status: "available"; completed: CompletedUsage }
  | { status: "unreconciled"; completed: CompletedUsage; reason: string }
  | { status: "unavailable"; completed: CompletedUsage; reason: string };
export type ScenarioObservedEvidence = {
  pricingRulesVersions: number[]; semanticTools: string[]; schedulingActions?: SchedulingSemanticAction[]; slotOffer: boolean; customerTurnDurationsMs: number[]; usage: UsageEvidence;
  /** Safe provider/SDK failure categories from started turns; no raw errors. */
  technicalFailures?: Array<{ code: AgentTurnTechnicalCode; elapsedMs: number; usageUnreconciled: boolean }>;
  /** Ordered after-message state/tool evidence, never a final-state dedupe. */
  messageEvidence?: SanitizedConversationArtifact["messageEvidence"];
};
export type LiveEvaluationTranscriptLine = { customer: string; transportText: string; visibleText: string; trustedTransport: boolean };
export type LiveEvaluationOutcome = {
  status: string; hasQuote: boolean; quoteState: "active" | "superseded" | "none"; humanNeeded: boolean; humanNeededReason?: string;
  fakeCalendarCreates: number; slotOffer: boolean; slotOfferCount: number;
};
export type LiveEvaluationScenarioResult = {
  id: string; state: "passed" | "failed"; failures: string[]; transcript: LiveEvaluationTranscriptLine[];
  rubric: { customerSafe: boolean; nonEmptyReplies: boolean; noStockThanksOrBotSyntax: boolean; intakeFocused: boolean };
  observed: ScenarioObservedEvidence; outcome: LiveEvaluationOutcome;
};
export type ProviderResponseEvidence = { started: number; limit: number; remaining: number };
export type ConversationCreateEvidence = { started: number; limit: number; remaining: number };
export type AcceptedSmokeEvidence = {
  reportPath: string; reportSha256: string; manifestSha256: string; providerResponsesStarted: number; conversationCreatesStarted: number;
  /** The remaining phase starts from this immutable whole-suite ledger. */
  usage: CompletedUsage;
};
export type LiveEvaluationReport = {
  version: 4; mode: "dry_run" | "live"; phase?: LiveEvaluationPhase;
  state: "planned" | "running" | "failed" | "incomplete" | "smoke_complete_pending_acceptance" | "remaining_complete_pending_acceptance";
  manifest: LiveEvaluationManifest;
  summary: { processed: number; customerMessagesProcessed: number; failed: number; repliesSafe: number; quotes: number; humanNeeded: number; fakeCalendarCreates: number };
  scenarios: LiveEvaluationScenarioResult[];
  activeCheckpoint?: { scenarioId: string; customerMessagesCompleted: number; customerMessagesTotal: number; transcript: LiveEvaluationTranscriptLine[]; observed: ScenarioObservedEvidence; outcome: LiveEvaluationScenarioResult["outcome"]; criteria: LiveConversationScenario["expected"] };
  acceptedSmoke?: AcceptedSmokeEvidence;
  /** Immutable earlier-phase subtotal, included in every remaining ledger. */
  priorUsage?: CompletedUsage;
  continuation?: { state: "not_evaluated_pending_acceptance" | "capacity_available_after_acceptance"; remainingScenarioCount: number; remainingCustomerMessageCount: number; providerResponsesStarted: number; remainingProviderResponseCapacity: number; conversationCreatesStarted: number; remainingConversationCreateCapacity: number };
  providerResponses: ProviderResponseEvidence;
  conversationCreates: ConversationCreateEvidence;
  latency: { completedTurns: number; p50Ms: number | null; p95Ms: number | null; withinTargets: boolean | null };
  usage: UsageEvidence; terminalFailure?: string;
};
export type LiveAgentFactory = (input: { maxToolSteps: number; maxOutputTokens: number; model: string; reasoningEffort: "low"; responseRequestCounter: ResponseRequestCounter }) => AgentGateway;
type LiveGate = { kind: "live"; phase: LiveEvaluationPhase; maxToolSteps: number; maxOutputTokens: number; suiteDeadlineMs: number };

export async function buildLiveEvaluationManifest(): Promise<LiveEvaluationManifest> {
  assertLiveConversationScenarioManifest();
  const config = await getDemoConsoleConfigStore().load();
  const model = (process.env.OPENAI_MODEL ?? "gpt-5.6-terra").trim();
  const configuredReasoning = (process.env.OPENAI_REASONING_EFFORT ?? "low").trim();
  if (!model) throw new Error("OPENAI_MODEL must be non-empty for a live evaluation manifest");
  if (configuredReasoning !== "low") throw new Error("Live evaluation requires OPENAI_REASONING_EFFORT=low");
  const smoke = liveConversationScenarios.slice(0, liveEvaluationSmokeScenarioCount);
  const baseSystemPromptSha256 = sha256(config.systemPrompt);
  const gatewaySourceSha256 = await currentSourceSha256(liveEvaluationProviderReplay.gatewaySourcePath);
  const webhookSourceSha256 = await currentSourceSha256(liveEvaluationProviderReplay.webhookSourcePath);
  const unsignedManifest: Omit<LiveEvaluationManifest, "manifestSha256"> = {
    fixtureSha256: sha256(liveConversationScenarios.map(({ id, customerMessages, agentTurnLimit, sandbox, expected, checkpointExpectations, requiredToolCounts }) => ({ id, customerMessages, agentTurnLimit, sandbox, expected, checkpointExpectations, requiredToolCounts }))),
    scenarioCount: liveConversationScenarioCount, customerMessageCount: liveConversationMessageCount,
    smokeScenarioCount: liveEvaluationSmokeScenarioCount, smokeCustomerMessageCount: smoke.reduce((total, scenario) => total + scenario.customerMessages.length, 0),
    model, reasoningEffort: "low", maxOutputTokens: maxAgentOutputTokens, maxSemanticToolSteps: maxAgentToolSteps,
    maxResponsesPerCustomerMessage: liveEvaluationMaxResponsesPerCustomerMessage, providerResponseBudget: liveEvaluationProviderResponseBudget,
    maxResponseAttemptsPerModelTurn: 1, maxConversationCreateRequests: liveEvaluationConversationCreateBudget,
    maxProviderRequestDurationMs: liveEvaluationProviderRequestTimeoutMs, maxCustomerTurnDurationMs: liveEvaluationCustomerTurnDeadlineMs,
    focusedScenarioDeadlineMs: liveEvaluationFocusedScenarioDeadlineMs, longScenarioDeadlineMs: liveEvaluationLongScenarioDeadlineMs,
    maxSuiteDurationMs: liveEvaluationSuiteDeadlineMs,
    prompt: { source: config.source, revision: config.revision ?? baseSystemPromptSha256.slice(0, 16), sha256: baseSystemPromptSha256 },
    pricingRules: { version: config.pricingRules.version, sha256: sha256(config.pricingRules) },
    evaluator: { revision: liveEvaluationRubricRevision, sha256: sha256(liveEvaluationRubricRevision) },
    schedulingOmissionReplay: liveEvaluationSchedulingOmissionReplay,
    providerReplay: { ...liveEvaluationProviderReplay, baseSystemPromptSha256, gatewaySourceSha256, webhookSourceSha256 },
    availabilityProviderEnvelope: liveEvaluationAvailabilityProviderEnvelope,
    availabilityTerminal: liveEvaluationAvailabilityTerminal,
    tokenCaps: liveEvaluationTokenCaps,
  };
  return { ...unsignedManifest, manifestSha256: canonicalLiveEvaluationManifestSha256(unsignedManifest) };
}

async function currentSourceSha256(relativePath: string): Promise<string> {
  return sha256(await readFile(resolve(process.cwd(), ...relativePath.split("/")), "utf8"));
}

export async function validateLiveEvaluationRequest(request: LiveEvaluationRequest, manifest: LiveEvaluationManifest): Promise<{ kind: "dry_run" } | LiveGate> {
  const { baseSystemPromptSha256, gatewaySourceSha256, webhookSourceSha256, ...providerReplayConfig } = manifest.providerReplay;
  if (
    canonicalJson(providerReplayConfig) !== canonicalJson(liveEvaluationProviderReplay) ||
    baseSystemPromptSha256 !== manifest.prompt.sha256 ||
    gatewaySourceSha256 !== await currentSourceSha256(liveEvaluationProviderReplay.gatewaySourcePath) ||
    webhookSourceSha256 !== await currentSourceSha256(liveEvaluationProviderReplay.webhookSourcePath)
  ) throw new Error("Live evaluation provider-replay contract is invalid or stale; run dry mode again");
  if (manifest.maxConversationCreateRequests !== liveEvaluationConversationCreateBudget) throw new Error(`Live evaluation requires exactly ${liveEvaluationConversationCreateBudget} Conversation-create requests`);
  if (!request.live) return { kind: "dry_run" };
  if (request.phase !== "smoke" && request.phase !== "remaining") throw new Error("Live evaluation requires --phase=smoke or --phase=remaining");
  if (manifest.scenarioCount !== requiredLiveConversationScenarioCount) throw new Error(`Live evaluation is fixed to ${requiredLiveConversationScenarioCount} scenarios`);
  if (manifest.smokeScenarioCount !== liveEvaluationSmokeScenarioCount) throw new Error("Live evaluation smoke scope is immutable");
  if (manifest.maxResponsesPerCustomerMessage !== maxAgentToolSteps + 1) throw new Error("Live evaluation requires four semantic tools plus one final closure response");
  if (canonicalJson(manifest.schedulingOmissionReplay) !== canonicalJson(liveEvaluationSchedulingOmissionReplay)) throw new Error("Live evaluation scheduling-omission-replay contract is invalid or stale; run dry mode again");
  if (canonicalJson(manifest.availabilityProviderEnvelope) !== canonicalJson(liveEvaluationAvailabilityProviderEnvelope)) throw new Error("Live evaluation availability-provider-envelope contract is invalid or stale; run dry mode again");
  if (canonicalJson(manifest.availabilityTerminal) !== canonicalJson(liveEvaluationAvailabilityTerminal)) throw new Error("Live evaluation terminal-availability contract is invalid or stale; run dry mode again");
  const { manifestSha256, ...unsignedManifest } = manifest;
  if (manifestSha256 !== canonicalLiveEvaluationManifestSha256(unsignedManifest)) throw new Error("Live evaluation manifest hash is invalid or stale; run dry mode again");
  if (request.confirmation !== liveEvaluationConfirmation) throw new Error("Live evaluation requires the literal confirmation flag");
  if (request.manifestSha256 !== manifest.manifestSha256) throw new Error("Live evaluation requires --manifest-sha256 from the current dry-run manifest");
  if (request.scenarioCount !== manifest.scenarioCount) throw new Error(`Live evaluation requires --scenario-count=${manifest.scenarioCount}`);
  if (!Number.isInteger(request.maxToolSteps) || request.maxToolSteps! < 1 || request.maxToolSteps! > manifest.maxSemanticToolSteps) throw new Error(`Live evaluation requires --max-tool-steps between 1 and ${manifest.maxSemanticToolSteps}`);
  if (request.model !== manifest.model) throw new Error("Live evaluation --model does not match the current OPENAI_MODEL manifest");
  if (request.reasoningEffort !== manifest.reasoningEffort) throw new Error("Live evaluation --reasoning-effort does not match the current manifest");
  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens! < 1 || request.maxOutputTokens! > manifest.maxOutputTokens) throw new Error(`Live evaluation requires --max-output-tokens between 1 and ${manifest.maxOutputTokens}`);
  if (request.maxSuiteDurationMs !== manifest.maxSuiteDurationMs) throw new Error(`Live evaluation requires --max-suite-duration-ms=${manifest.maxSuiteDurationMs}`);
  if (!request.reportPath) throw new Error("Live evaluation requires an ignored local report path");
  if (request.phase === "remaining" && !request.acceptedSmokeReportPath) throw new Error("Remaining evaluation requires --accepted-smoke-report with an explicitly accepted smoke checkpoint");
  return { kind: "live", phase: request.phase, maxToolSteps: request.maxToolSteps!, maxOutputTokens: request.maxOutputTokens!, suiteDeadlineMs: request.maxSuiteDurationMs };
}

/** Counts each actual SDK Responses request immediately before it starts. */
export class ProviderResponseCounter implements ResponseRequestCounter {
  private startedRequests: number;
  constructor(readonly limit: number, initialStarted = 0) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(initialStarted) || initialStarted < 0 || initialStarted > limit) throw new Error("invalid_provider_response_budget");
    this.startedRequests = initialStarted;
  }
  beforeResponseRequest(): void {
    if (this.startedRequests >= this.limit) throw new EvaluationResourceLimitExceededError("provider_response_budget_exceeded_before_request_221");
    this.startedRequests += 1;
  }
  snapshot(): ProviderResponseEvidence { return { started: this.startedRequests, limit: this.limit, remaining: this.limit - this.startedRequests }; }
}

/** Counts every provider Conversation creation immediately before its external call. */
export class ConversationCreateCounter {
  private startedRequests: number;
  constructor(readonly limit: number, initialStarted = 0) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(initialStarted) || initialStarted < 0 || initialStarted > limit) throw new Error("invalid_conversation_create_budget");
    this.startedRequests = initialStarted;
  }
  beforeConversationCreate(): void {
    if (this.startedRequests >= this.limit) throw new EvaluationResourceLimitExceededError("conversation_create_budget_exceeded_before_request_87");
    this.startedRequests += 1;
  }
  snapshot(): ConversationCreateEvidence { return { started: this.startedRequests, limit: this.limit, remaining: this.limit - this.startedRequests }; }
}

/** Only the injected agent can be live; all operational adapters remain fake. */
export async function runLiveConversationEvaluation(request: LiveEvaluationRequest, agentFactory: LiveAgentFactory = createLiveAgentFromEnvironment, suppliedManifest?: LiveEvaluationManifest): Promise<LiveEvaluationReport> {
  const manifest = suppliedManifest ?? await buildLiveEvaluationManifest();
  const gate = await validateLiveEvaluationRequest(request, manifest);
  if (gate.kind === "dry_run") return emptyReport("dry_run", "planned", manifest);
  const acceptedSmoke = gate.phase === "remaining" ? await loadAcceptedSmokeCheckpoint(request.acceptedSmokeReportPath!, manifest) : undefined;
  const responseCounter = new ProviderResponseCounter(manifest.providerResponseBudget, acceptedSmoke?.providerResponsesStarted ?? 0);
  const conversationCreateCounter = new ConversationCreateCounter(manifest.maxConversationCreateRequests, acceptedSmoke?.conversationCreatesStarted ?? 0);
  const report = emptyReport("live", "running", manifest, gate.phase, responseCounter.snapshot(), acceptedSmoke?.usage, conversationCreateCounter.snapshot());
  if (acceptedSmoke) report.acceptedSmoke = acceptedSmoke;
  await writeLiveEvaluationReport(request.reportPath!, report);
  try {
    const suiteDeadlineAt = Date.now() + gate.suiteDeadlineMs;
    const delegate = agentFactory({ maxToolSteps: gate.maxToolSteps, maxOutputTokens: gate.maxOutputTokens, model: manifest.model, reasoningEffort: manifest.reasoningEffort, responseRequestCounter: responseCounter });
    const scenarios = gate.phase === "smoke" ? liveConversationScenarios.slice(0, manifest.smokeScenarioCount) : liveConversationScenarios.slice(manifest.smokeScenarioCount);
    for (const scenario of scenarios) {
      assertDeadline(suiteDeadlineAt, "live_suite_deadline_exceeded");
      const scopeDeadlineAt = Date.now() + scenarioDeadlineMs(scenario, manifest);
      const agent = new DeadlineBoundAgentGateway(delegate, { suiteDeadlineAt, scopeDeadlineAt, customerTurnDeadlineMs: manifest.maxCustomerTurnDurationMs }, Date.now, conversationCreateCounter);
      const durations: number[] = [];
      try {
        const artifact = await runConversationScenario({ id: scenario.id, customerMessages: [...scenario.customerMessages], agentTurnLimit: scenario.agentTurnLimit, expected: { calendarFullyBooked: scenario.sandbox?.calendarFullyBooked, calendarTransportFails: scenario.sandbox?.calendarTransportFails, evening90m2Slot: scenario.sandbox?.evening90m2Slot, now: scenario.sandbox?.now } }, {
          agent, agentTurnLimit: scenario.agentTurnLimit,
          stopAfterTechnicalTurn: true,
          beforeCustomerMessage: () => { assertDeadline(suiteDeadlineAt, "live_suite_deadline_exceeded"); assertDeadline(scopeDeadlineAt, "scenario_deadline_exceeded"); },
          afterCustomerMessage: async (checkpoint) => {
            durations.push(checkpoint.customerMessageDurationMs);
            await persistCustomerMessageCheckpoint({
              report, scenario, artifact: checkpoint.artifact, customerTurnDurationsMs: durations,
              providerResponses: responseCounter.snapshot(), conversationCreates: conversationCreateCounter.snapshot(), reportPath: request.reportPath!, suiteDeadlineAt, scopeDeadlineAt,
            });
          },
        });
        report.scenarios.push(toScenarioResult(scenario, artifact, durations)); report.activeCheckpoint = undefined;
      } catch (error) {
        const partial = report.activeCheckpoint?.scenarioId === scenario.id ? report.activeCheckpoint : undefined;
        // A typed resource fence is evidence, not an ordinary scenario error:
        // retain the last fully persisted customer checkpoint for audit. Do
        // not also materialize it as a failed scenario: the report ledger
        // would otherwise count its usage, durations and outcome twice.
        if (!(error instanceof EvaluationResourceLimitExceededError)) {
          report.scenarios.push(failedScenario(scenario, error, durations, partial));
          report.activeCheckpoint = undefined;
        }
        report.providerResponses = responseCounter.snapshot(); report.conversationCreates = conversationCreateCounter.snapshot(); refreshReport(report); await writeLiveEvaluationReport(request.reportPath!, report); throw error;
      }
      report.providerResponses = responseCounter.snapshot(); report.conversationCreates = conversationCreateCounter.snapshot(); refreshReport(report); await writeLiveEvaluationReport(request.reportPath!, report);
    }
    refreshReport(report);
    const exceededTokenCap = tokenCapFailure(report.usage, manifest.tokenCaps);
    if (report.summary.failed > 0 || report.latency.withinTargets !== true || exceededTokenCap) {
      markLiveEvaluationReportFailed(report, new Error(
        report.summary.failed > 0 ? `${gate.phase}_acceptance_failed`
          : exceededTokenCap ?? `${gate.phase}_latency_threshold_failed`,
      ), true);
      await writeLiveEvaluationReport(request.reportPath!, report); throw new Error("Live conversation evaluation failed; inspect the local sanitized checkpoint report");
    }
    if (gate.phase === "smoke") {
      report.state = "smoke_complete_pending_acceptance";
      report.continuation = { state: "not_evaluated_pending_acceptance", remainingScenarioCount: manifest.scenarioCount - manifest.smokeScenarioCount, remainingCustomerMessageCount: manifest.customerMessageCount - manifest.smokeCustomerMessageCount, providerResponsesStarted: responseCounter.snapshot().started, remainingProviderResponseCapacity: responseCounter.snapshot().remaining, conversationCreatesStarted: conversationCreateCounter.snapshot().started, remainingConversationCreateCapacity: conversationCreateCounter.snapshot().remaining };
    } else report.state = "remaining_complete_pending_acceptance";
    report.providerResponses = responseCounter.snapshot(); report.conversationCreates = conversationCreateCounter.snapshot(); await writeLiveEvaluationReport(request.reportPath!, report); return report;
  } catch (error) {
    report.providerResponses = responseCounter.snapshot();
    report.conversationCreates = conversationCreateCounter.snapshot();
    if (error instanceof EvaluationResourceLimitExceededError) markLiveEvaluationReportIncomplete(report, error);
    else if (report.state !== "failed") markLiveEvaluationReportFailed(report, error);
    await writeLiveEvaluationReport(request.reportPath!, report);
    throw new Error(`Live conversation evaluation stopped before completion: ${report.terminalFailure}`);
  }
}

export async function loadAcceptedSmokeCheckpoint(path: string, manifest: LiveEvaluationManifest): Promise<AcceptedSmokeEvidence> {
  const destination = assertLiveReportPath(path); const raw = await readFile(destination, "utf8");
  let report: unknown; try { report = JSON.parse(raw); } catch { throw new Error("Accepted smoke checkpoint is not valid JSON"); }
  if (!isLiveReport(report)) throw new Error("Accepted smoke checkpoint has an invalid shape");
  if (report.mode !== "live" || report.phase !== "smoke" || report.state !== "smoke_complete_pending_acceptance") throw new Error("Accepted smoke checkpoint is not a completed smoke phase");
  if (report.terminalFailure) throw new Error("Accepted smoke checkpoint has a terminal failure");
  assertAcceptedSmokeManifest(report.manifest, manifest);
  assertAcceptedSmokeEvidence(report, manifest);
  return {
    reportPath: destination,
    reportSha256: sha256(raw),
    manifestSha256: report.manifest.manifestSha256,
    providerResponsesStarted: report.providerResponses.started,
    conversationCreatesStarted: report.conversationCreates.started,
    usage: report.usage.completed,
  };
}

function assertAcceptedSmokeManifest(embedded: LiveEvaluationManifest, current: LiveEvaluationManifest): void {
  const { manifestSha256, ...unsignedEmbedded } = embedded;
  if (manifestSha256 !== canonicalLiveEvaluationManifestSha256(unsignedEmbedded)) throw new Error("Accepted smoke checkpoint embedded manifest hash is invalid");
  if (manifestSha256 !== current.manifestSha256 || canonicalJson(embedded) !== canonicalJson(current)) {
    throw new Error("Accepted smoke checkpoint manifest/config does not exactly match the current immutable manifest");
  }
}

function assertAcceptedSmokeEvidence(report: LiveEvaluationReport, manifest: LiveEvaluationManifest): void {
  const smoke = liveConversationScenarios.slice(0, manifest.smokeScenarioCount);
  const expectedMessageCount = smoke.reduce((total, scenario) => total + scenario.customerMessages.length, 0);
  if (manifest.smokeCustomerMessageCount !== expectedMessageCount || report.summary.processed !== smoke.length || report.summary.customerMessagesProcessed !== expectedMessageCount || report.summary.failed !== 0 || report.scenarios.length !== smoke.length) {
    throw new Error("Accepted smoke checkpoint has inconsistent smoke summary evidence");
  }
  for (const [index, fixture] of smoke.entries()) {
    const result = report.scenarios[index];
    if (!result || result.id !== fixture.id || result.state !== "passed" || result.failures.length !== 0 || !result.rubric.customerSafe || !result.rubric.nonEmptyReplies || !result.rubric.noStockThanksOrBotSyntax || !result.rubric.intakeFocused) {
      throw new Error("Accepted smoke checkpoint does not contain the required five passing smoke scenarios");
    }
    if (result.transcript.length !== fixture.customerMessages.length || result.observed.customerTurnDurationsMs.length !== fixture.customerMessages.length || result.observed.messageEvidence?.length !== fixture.customerMessages.length || result.transcript.some(({ customer, visibleText, trustedTransport }, messageIndex) => customer !== fixture.customerMessages[messageIndex] || !visibleText.trim() || !trustedTransport || !isTransportAndInternalSafeReply(visibleText) || hasStockFillerReply(visibleText) || !isFocusedIntakeReply(visibleText))) {
      throw new Error("Accepted smoke checkpoint transcript evidence is incomplete or inconsistent");
    }
    if (result.observed.messageEvidence.some((evidence, messageIndex) => evidence.provenance !== "post_customer_message_checkpoint" || evidence.customerMessageNumber !== messageIndex + 1 || evidence.customer !== fixture.customerMessages[messageIndex])) {
      throw new Error("Accepted smoke checkpoint ordered message evidence is incomplete or inconsistent");
    }
    if (result.observed.usage.status !== "available" || result.outcome.hasQuote !== fixture.expected.hasQuote || result.outcome.humanNeeded !== fixture.expected.humanNeeded || result.outcome.fakeCalendarCreates !== fixture.expected.fakeCalendarCreates || result.observed.slotOffer !== fixture.expected.slotOffer) {
      throw new Error("Accepted smoke checkpoint has contradictory outcome or usage evidence");
    }
    if (fixture.checkpointExpectations?.some((expected, messageIndex) => expected !== undefined && !checkpointMatchesExpectation(result.observed.messageEvidence?.[messageIndex], result.transcript[messageIndex]?.visibleText, result.transcript[messageIndex - 1]?.visibleText, expected))) {
      throw new Error("Accepted smoke checkpoint does not preserve its exact per-message evidence");
    }
    if (fixture.requiredToolCounts && !toolCountsMatchEvidence(result.observed.messageEvidence, fixture.requiredToolCounts)) {
      throw new Error("Accepted smoke checkpoint does not preserve required semantic tool counts");
    }
  }
  const summary = summarizeScenarios(report.scenarios);
  if (canonicalJson(report.summary) !== canonicalJson(summary)) throw new Error("Accepted smoke checkpoint summary does not match its scenario evidence");
  const durations = report.scenarios.flatMap((scenario) => scenario.observed.customerTurnDurationsMs);
  const latency = latencyEvidence(durations);
  if (!report.latency.withinTargets || canonicalJson(report.latency) !== canonicalJson(latency)) throw new Error("Accepted smoke checkpoint latency evidence is inconsistent");
  const usage = aggregateUsage(report.scenarios.map((scenario) => scenario.observed.usage));
  if (usage.status !== "available" || report.usage.status !== "available" || canonicalJson(report.usage) !== canonicalJson(usage)) throw new Error("Accepted smoke checkpoint usage is unreconciled or inconsistent");
  if (tokenCapFailure(report.usage, manifest.tokenCaps)) throw new Error("Accepted smoke checkpoint already exceeds a whole-suite token cap");
  const startedResponses = report.providerResponses.started;
  const publishedUsageRequests = usage.completed.requests;
  const unpublishedResponseGap = startedResponses - publishedUsageRequests;
  if (!Number.isInteger(startedResponses) || startedResponses < 0 || report.providerResponses.limit !== manifest.providerResponseBudget || report.providerResponses.remaining !== report.providerResponses.limit - startedResponses || startedResponses >= manifest.providerResponseBudget || !Number.isInteger(publishedUsageRequests) || publishedUsageRequests < 0 || unpublishedResponseGap < 0 || unpublishedResponseGap >= liveEvaluationMaxResponsesPerCustomerMessage) {
    throw new Error("Accepted smoke checkpoint Responses budget evidence is inconsistent or exhausted");
  }
  if (!Number.isInteger(report.conversationCreates.started) || report.conversationCreates.started < 0 || report.conversationCreates.limit !== manifest.maxConversationCreateRequests || report.conversationCreates.remaining !== report.conversationCreates.limit - report.conversationCreates.started || report.conversationCreates.started > expectedMessageCount || report.conversationCreates.started >= manifest.maxConversationCreateRequests) {
    throw new Error("Accepted smoke checkpoint Conversation-create budget evidence is inconsistent or exhausted");
  }
}

export function createLiveAgentFromEnvironment(input: { maxToolSteps: number; maxOutputTokens: number; model: string; reasoningEffort: "low"; responseRequestCounter: ResponseRequestCounter }): AgentGateway {
  const apiKey = process.env.OPENAI_API_KEY?.trim(); if (!apiKey) throw new Error("OPENAI_API_KEY is required for an approved live evaluation");
  return new OpenAiAgentsGateway(apiKey, input.model, input.reasoningEffort, input.maxToolSteps, { maxOutputTokens: input.maxOutputTokens, maxResponseRetries: 0, maxConversationCreateAttempts: 1, requestTimeoutMs: liveEvaluationProviderRequestTimeoutMs, maxResponsesPerTurn: liveEvaluationMaxResponsesPerCustomerMessage, responseRequestCounter: input.responseRequestCounter });
}

export function defaultLiveEvaluationReportPath(now = new Date()): string { const stamp = now.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/u, "Z"); return resolve(process.cwd(), ".runtime", "conversation-live-evaluations", `${stamp}.json`); }
export async function writeLiveEvaluationReport(path: string, report: LiveEvaluationReport): Promise<void> { const destination = assertLiveReportPath(path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); const temporary = resolve(dirname(destination), `.${randomUUID()}.tmp`); await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }); await rename(temporary, destination); }
/**
 * A completed webhook message is durable evidence even when its post-message
 * wall-clock guard fires. Persist it first, then enforce the deadline.
 */
export async function persistCustomerMessageCheckpoint(input: {
  report: LiveEvaluationReport;
  scenario: LiveConversationScenario;
  artifact: SanitizedConversationArtifact;
  customerTurnDurationsMs: number[];
  providerResponses: ProviderResponseEvidence;
  conversationCreates: ConversationCreateEvidence;
  reportPath: string;
  suiteDeadlineAt: number;
  scopeDeadlineAt: number;
}): Promise<void> {
  input.report.activeCheckpoint = checkpointResult(input.scenario, input.artifact, input.customerTurnDurationsMs);
  input.report.providerResponses = input.providerResponses;
  input.report.conversationCreates = input.conversationCreates;
  refreshReport(input.report);
  await writeLiveEvaluationReport(input.reportPath, input.report);
  const exceededTokenCap = tokenCapFailure(input.report.usage, input.report.manifest.tokenCaps);
  if (exceededTokenCap) throw new EvaluationResourceLimitExceededError(exceededTokenCap);
  assertDeadline(input.suiteDeadlineAt, "live_suite_deadline_exceeded");
  assertDeadline(input.scopeDeadlineAt, "scenario_deadline_exceeded");
}

export function toScenarioResult(scenario: LiveConversationScenario, artifact: SanitizedConversationArtifact, customerTurnDurationsMs: number[] = []): LiveEvaluationScenarioResult {
  const customerSafe = artifact.transcript.every(({ visibleText, trustedTransport }) => trustedTransport && isTransportAndInternalSafeReply(visibleText));
  const nonEmptyReplies = artifact.transcript.every(({ visibleText }) => visibleText.trim().length > 0);
  const noStockThanksOrBotSyntax = artifact.transcript.every(({ visibleText }) => !hasStockFillerReply(visibleText));
  const intakeFocused = artifact.transcript.every(({ visibleText }) => isFocusedIntakeReply(visibleText)); const observed = observedFromArtifact(artifact, customerTurnDurationsMs);
  const checkpointFailure = scenario.checkpointExpectations?.map((expected, index) => {
    if (expected === undefined) return undefined;
    const failure = checkpointMismatch(artifact.messageEvidence[index], artifact.transcript[index]?.visibleText, artifact.transcript[index - 1]?.visibleText, expected);
    return failure ? { ...failure, index } : undefined;
  }).find((failure): failure is CheckpointMismatch => failure !== undefined);
  const checkpointMatches = checkpointFailure === undefined;
  const toolCountsMatch = scenario.requiredToolCounts === undefined || toolCountsMatchEvidence(artifact.messageEvidence, scenario.requiredToolCounts);
  const updateCallsBounded = artifact.messageEvidence.every((evidence) => evidence.semanticTools.filter((tool) => tool === "update_client_data").length <= 1);
  const failures = [...(customerSafe ? [] : ["unsafe_customer_reply"]), ...(nonEmptyReplies ? [] : ["empty_customer_reply"]), ...(noStockThanksOrBotSyntax ? [] : ["stock_thanks_or_bot_syntax"]), ...(intakeFocused ? [] : ["unfocused_intake_reply"]), ...(checkpointMatches ? [] : ["unexpected_checkpoint_evidence", `unexpected_checkpoint_evidence:checkpoint_${checkpointFailure!.index + 1}:${checkpointFailure!.field}`]), ...(toolCountsMatch ? [] : ["unexpected_semantic_tool_count"]), ...(updateCallsBounded ? [] : ["too_many_client_data_updates_in_customer_turn"]), ...(artifact.lead.hasQuote === scenario.expected.hasQuote ? [] : ["unexpected_quote_outcome"]), ...(artifact.lead.humanNeeded === scenario.expected.humanNeeded ? [] : ["unexpected_human_needed_outcome"]), ...(artifact.calendarCreates === scenario.expected.fakeCalendarCreates ? [] : ["unexpected_fake_calendar_create_count"]), ...(artifact.slotOffer === scenario.expected.slotOffer ? [] : ["unexpected_slot_offer_outcome"])];
  return { id: scenario.id, state: failures.length === 0 ? "passed" : "failed", failures, transcript: artifact.transcript.map(({ customer, transportText, visibleText, trustedTransport }) => ({ customer: sanitize(customer), transportText: sanitize(transportText), visibleText: sanitize(visibleText), trustedTransport })), rubric: { customerSafe, nonEmptyReplies, noStockThanksOrBotSyntax, intakeFocused }, observed, outcome: outcomeFromArtifact(artifact) };
}

/**
 * Read-only diagnostic for a saved report. It recomputes the current rubric
 * from the immutable sanitized artifact and never writes the source report,
 * calls a provider, or promotes an older manifest to accepted evidence.
 */
export type StoredReportReevaluation = {
  source: { manifestSha256: string; evaluatorRevision: string; state: LiveEvaluationReport["state"] };
  evaluatorRevision: string;
  scenarios: Array<{ id: string; priorState: LiveEvaluationScenarioResult["state"]; reEvaluatedState: LiveEvaluationScenarioResult["state"]; failures: string[] }>;
};
export async function reEvaluateStoredLiveReportPath(reportPath: string): Promise<StoredReportReevaluation> {
  const report = JSON.parse(await readFile(reportPath, "utf8")) as LiveEvaluationReport;
  return reEvaluateStoredLiveReport(report);
}
export function reEvaluateStoredLiveReport(report: LiveEvaluationReport): StoredReportReevaluation {
  const fixtures = new Map(liveConversationScenarios.map((scenario) => [scenario.id, scenario]));
  return {
    source: { manifestSha256: report.manifest.manifestSha256, evaluatorRevision: report.manifest.evaluator.revision, state: report.state },
    evaluatorRevision: liveEvaluationRubricRevision,
    scenarios: report.scenarios.map((stored) => {
      const scenario = fixtures.get(stored.id);
      if (!scenario) return { id: stored.id, priorState: stored.state, reEvaluatedState: "failed", failures: ["fixture_not_found_in_current_evaluator"] };
      const artifact: SanitizedConversationArtifact = {
        scenarioId: stored.id,
        transcript: stored.transcript,
        turns: [],
        lead: { status: stored.outcome.status, clientData: {}, hasQuote: stored.outcome.hasQuote, quoteState: stored.outcome.quoteState, humanNeeded: stored.outcome.humanNeeded, ...(stored.outcome.humanNeededReason ? { humanNeededReason: stored.outcome.humanNeededReason } : {}) },
        calendarCreates: stored.outcome.fakeCalendarCreates,
        slotOffer: stored.outcome.slotOffer,
        slotOfferCount: stored.outcome.slotOfferCount,
        messageEvidence: stored.observed.messageEvidence ?? [],
      };
      const result = toScenarioResult(scenario, artifact, stored.observed.customerTurnDurationsMs);
      return { id: stored.id, priorState: stored.state, reEvaluatedState: result.state, failures: result.failures };
    }),
  };
}
type CheckpointExpectation = Exclude<NonNullable<LiveConversationScenario["checkpointExpectations"]>[number], undefined>;
function toolCountsMatchEvidence(evidence: SanitizedConversationArtifact["messageEvidence"] | undefined, expected: NonNullable<LiveConversationScenario["requiredToolCounts"]>): boolean {
  const items = evidence ?? [];
  return evidence !== undefined && Object.entries(expected).every(([name, count]) => items.flatMap((item) => item.semanticTools).filter((tool) => tool === name).length === count);
}
type CheckpointMismatch = { field: string; index: number };
function checkpointMatchesExpectation(actual: SanitizedConversationArtifact["messageEvidence"][number] | undefined, visibleText: string | undefined, previousVisibleText: string | undefined, expected: CheckpointExpectation): boolean {
  return checkpointMismatch(actual, visibleText, previousVisibleText, expected) === undefined;
}
function checkpointMismatch(actual: SanitizedConversationArtifact["messageEvidence"][number] | undefined, visibleText: string | undefined, previousVisibleText: string | undefined, expected: CheckpointExpectation): Omit<CheckpointMismatch, "index"> | undefined {
  if (!actual) return { field: "evidence" };
  const { semanticTools, semanticToolsOneOf, schedulingActions, schedulingActionsOneOf, lastAvailabilityAttempt, lastAvailabilityAttemptOneOf, activeSlotStarts, visibleIncludes, visibleDifferentFromPrevious, preferredDateAbsent, preferredTimeWindowAbsent, ...state } = expected;
  const stateMismatch = Object.entries(state).find(([key, value]) => !structurallyEqual(actual[key as keyof typeof actual], value));
  if (stateMismatch) return { field: `state.${stateMismatch[0]}` };
  if (preferredDateAbsent && actual.preferredDate !== undefined) return { field: "preferredDateAbsent" };
  if (preferredTimeWindowAbsent && actual.preferredTimeWindow !== undefined) return { field: "preferredTimeWindowAbsent" };
  if (semanticTools !== undefined && !structurallyEqual(actual.semanticTools, semanticTools)) return { field: "semanticTools" };
  if (semanticToolsOneOf !== undefined && !semanticToolsOneOf.some((allowed) => structurallyEqual(actual.semanticTools, allowed))) return { field: "semanticToolsOneOf" };
  if (schedulingActions !== undefined && !schedulingActionsEqual(actual.schedulingActions ?? [], schedulingActions)) return { field: "schedulingActions" };
  if (schedulingActionsOneOf !== undefined && !schedulingActionsOneOf.some((allowed) => schedulingActionsEqual(actual.schedulingActions ?? [], allowed))) return { field: "schedulingActionsOneOf" };
  if (lastAvailabilityAttempt !== undefined && !structurallyEqual(actual.lastAvailabilityAttempt, lastAvailabilityAttempt)) return { field: "lastAvailabilityAttempt" };
  if (lastAvailabilityAttemptOneOf !== undefined && !lastAvailabilityAttemptOneOf.some((allowed) => structurallyEqual(actual.lastAvailabilityAttempt, allowed))) return { field: "lastAvailabilityAttemptOneOf" };
  if (activeSlotStarts !== undefined && !structurallyEqual(actual.activeSlotStarts ?? [], activeSlotStarts)) return { field: "activeSlotStarts" };
  if (visibleIncludes !== undefined && !visibleIncludes.every((text) => normalizedVisibleText(visibleText).includes(normalizedVisibleText(text)))) return { field: "visibleIncludes" };
  if (visibleDifferentFromPrevious && !(Boolean(previousVisibleText) && visibleText !== previousVisibleText)) return { field: "visibleDifferentFromPrevious" };
  return undefined;
}
/** Exact structural equality for evaluator evidence; object-key insertion order
 * is transport noise, while array order remains semantically meaningful. */
function structurallyEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** V34 evaluator fixtures bind the full provider-owned offer disposition.
 * Immutable pre-v34 reports are not reinterpreted by this evaluator. */
function schedulingActionsEqual(actual: SchedulingSemanticAction[], expected: SchedulingSemanticAction[]): boolean {
  return structurallyEqual(actual, expected);
}
/** Only checkpoint substring comparison is normalized; transport/safety keeps raw text. */
function normalizedVisibleText(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[\u2010-\u2015\u2212-]+/gu, " ").replace(/\s+/gu, " ").trim();
}
function checkpointResult(scenario: LiveConversationScenario, artifact: SanitizedConversationArtifact, customerTurnDurationsMs: number[]): NonNullable<LiveEvaluationReport["activeCheckpoint"]> { return { scenarioId: scenario.id, customerMessagesCompleted: artifact.transcript.length, customerMessagesTotal: scenario.customerMessages.length, transcript: artifact.transcript.map(({ customer, transportText, visibleText, trustedTransport }) => ({ customer: sanitize(customer), transportText: sanitize(transportText), visibleText: sanitize(visibleText), trustedTransport })), observed: observedFromArtifact(artifact, customerTurnDurationsMs), outcome: outcomeFromArtifact(artifact), criteria: scenario.expected }; }
function failedScenario(scenario: LiveConversationScenario, error: unknown, customerTurnDurationsMs: number[] = [], partial?: LiveEvaluationReport["activeCheckpoint"]): LiveEvaluationScenarioResult { const safe = partial ? partial.transcript.every(({ visibleText, trustedTransport }) => trustedTransport && isTransportAndInternalSafeReply(visibleText)) : false; const noStock = partial ? partial.transcript.every(({ visibleText }) => !hasStockFillerReply(visibleText)) : false; const focused = partial ? partial.transcript.every(({ visibleText }) => isFocusedIntakeReply(visibleText)) : false; return { id: scenario.id, state: "failed", failures: ["scenario_execution_failed", sanitizedEvaluationFailureCode(error)], transcript: partial?.transcript ?? [], rubric: { customerSafe: safe, nonEmptyReplies: partial ? partial.transcript.every(({ visibleText }) => visibleText.trim().length > 0) : false, noStockThanksOrBotSyntax: noStock, intakeFocused: focused }, observed: partial?.observed ?? { pricingRulesVersions: [], semanticTools: [], slotOffer: false, customerTurnDurationsMs, usage: { status: "unreconciled", completed: emptyUsage(), reason: "aborted_or_failed_provider_turn" } }, outcome: partial?.outcome ?? { status: "not_available", hasQuote: false, quoteState: "none", humanNeeded: false, fakeCalendarCreates: 0, slotOffer: false, slotOfferCount: 0 } }; }
/** A report is operational evidence, never a carrier for exception prose. */
function sanitizedEvaluationFailureCode(error: unknown): string {
  if (error instanceof AgentTurnTechnicalError) return error.code;
  if (error instanceof EvaluationResourceLimitExceededError || error instanceof EvaluationDeadlineExceededError) return error.code;
  if (error instanceof Error && /^(?:smoke|remaining)_(?:acceptance_failed|latency_threshold_failed|usage_unreconciled)$/u.test(error.message)) return error.message;
  return "evaluation_processing_failed";
}
function emptyReport(mode: "dry_run" | "live", state: LiveEvaluationReport["state"], manifest: LiveEvaluationManifest, phase?: LiveEvaluationPhase, providerResponses: ProviderResponseEvidence = { started: 0, limit: manifest.providerResponseBudget, remaining: manifest.providerResponseBudget }, initialUsage: CompletedUsage = emptyUsage(), conversationCreates: ConversationCreateEvidence = { started: 0, limit: manifest.maxConversationCreateRequests, remaining: manifest.maxConversationCreateRequests }): LiveEvaluationReport { return { version: 4, mode, ...(phase ? { phase } : {}), state, manifest, summary: { processed: 0, customerMessagesProcessed: 0, failed: 0, repliesSafe: 0, quotes: 0, humanNeeded: 0, fakeCalendarCreates: 0 }, scenarios: [], providerResponses, conversationCreates, latency: { completedTurns: 0, p50Ms: null, p95Ms: null, withinTargets: null }, ...(initialUsage.requests > 0 ? { priorUsage: initialUsage } : {}), usage: initialUsage.requests > 0 ? { status: "available", completed: initialUsage } : { status: "unavailable", completed: initialUsage, reason: "no_completed_provider_runs" } }; }
/** Preserve reconciled usage for a fully completed acceptance failure. Actual interruptions remain unreconciled. */
export function markLiveEvaluationReportFailed(report: LiveEvaluationReport, error: unknown, preserveReconciledUsage = false): void { report.terminalFailure = sanitizedEvaluationFailureCode(error); report.state = "failed"; report.summary = { ...report.summary, failed: Math.max(report.summary.failed, 1) }; if (!preserveReconciledUsage && report.usage.status !== "unreconciled") report.usage = { status: "unreconciled", completed: report.usage.completed, reason: "evaluation_terminated_before_reconciliation" }; }
export function markLiveEvaluationReportIncomplete(report: LiveEvaluationReport, error: EvaluationResourceLimitExceededError): void { report.terminalFailure = error.code; report.state = "incomplete"; }
function refreshReport(report: LiveEvaluationReport): void { const scenarios = report.scenarios; const active = report.activeCheckpoint; report.summary = summarizeScenarios(scenarios, active); report.usage = aggregateUsage([...scenarios.map((scenario) => scenario.observed.usage), ...(active ? [active.observed.usage] : [])], report.priorUsage); report.latency = latencyEvidence([...scenarios.flatMap((scenario) => scenario.observed.customerTurnDurationsMs), ...(active?.observed.customerTurnDurationsMs ?? [])]); if (report.terminalFailure && report.state !== "incomplete") report.state = "failed"; }
function summarizeScenarios(scenarios: LiveEvaluationScenarioResult[], active?: LiveEvaluationReport["activeCheckpoint"]): LiveEvaluationReport["summary"] {
  const activeOutcome = active?.outcome;
  return {
    // An active checkpoint is retained evidence, not a completed scenario.
    processed: scenarios.length,
    customerMessagesProcessed: scenarios.reduce((total, scenario) => total + scenario.transcript.length, 0) + (active?.customerMessagesCompleted ?? 0),
    failed: scenarios.filter((scenario) => scenario.state === "failed").length,
    repliesSafe: scenarios.filter((scenario) => scenario.rubric.customerSafe).length,
    quotes: scenarios.filter((scenario) => scenario.outcome.hasQuote).length + (activeOutcome?.hasQuote ? 1 : 0),
    humanNeeded: scenarios.filter((scenario) => scenario.outcome.humanNeeded).length + (activeOutcome?.humanNeeded ? 1 : 0),
    fakeCalendarCreates: scenarios.reduce((total, scenario) => total + scenario.outcome.fakeCalendarCreates, 0) + (activeOutcome?.fakeCalendarCreates ?? 0),
  };
}
function observedFromArtifact(artifact: SanitizedConversationArtifact, customerTurnDurationsMs: number[]): ScenarioObservedEvidence { const technicalFailures = artifact.turns.flatMap((turn) => turn.technicalFailureCode ? [{ code: turn.technicalFailureCode, elapsedMs: Math.max(0, Math.round(turn.elapsedMs ?? 0)), usageUnreconciled: Boolean(turn.usageUnreconciledReason) }] : []); const schedulingActions = artifact.turns.flatMap((turn) => turn.schedulingActions ?? []); return { pricingRulesVersions: [...new Set(artifact.turns.map((turn) => turn.pricingRulesVersion))], semanticTools: [...new Set(artifact.turns.flatMap((turn) => turn.semanticTools))], ...(schedulingActions.length > 0 ? { schedulingActions } : {}), slotOffer: artifact.slotOffer, customerTurnDurationsMs: [...customerTurnDurationsMs], messageEvidence: structuredClone(artifact.messageEvidence), ...(technicalFailures.length > 0 ? { technicalFailures } : {}), usage: usageFromArtifact(artifact) }; }
function outcomeFromArtifact(artifact: SanitizedConversationArtifact): LiveEvaluationScenarioResult["outcome"] { return { status: artifact.lead.status, hasQuote: artifact.lead.hasQuote, quoteState: artifact.lead.quoteState, humanNeeded: artifact.lead.humanNeeded, ...(artifact.lead.humanNeededReason ? { humanNeededReason: artifact.lead.humanNeededReason } : {}), fakeCalendarCreates: artifact.calendarCreates, slotOffer: artifact.slotOffer, slotOfferCount: artifact.slotOfferCount }; }
function usageFromArtifact(artifact: SanitizedConversationArtifact): UsageEvidence { const completed = artifact.turns.reduce<CompletedUsage>((total, turn) => turn.usage ? addUsage(total, turn.usage) : total, emptyUsage()); const unreconciled = artifact.turns.map((turn) => turn.usageUnreconciledReason).find((reason): reason is string => Boolean(reason)); if (unreconciled) return { status: "unreconciled", completed, reason: unreconciled }; if (artifact.turns.some((turn) => turn.usage === undefined)) return { status: "unavailable", completed, reason: "provider_usage_not_reported" }; return { status: "available", completed }; }
function aggregateUsage(evidence: UsageEvidence[], initial: CompletedUsage = emptyUsage()): UsageEvidence { if (evidence.length === 0 && initial.requests === 0) return { status: "unavailable", completed: emptyUsage(), reason: "no_completed_provider_runs" }; const completed = evidence.reduce<CompletedUsage>((total, entry) => addUsage(total, entry.completed), initial); if (evidence.some((entry) => entry.status === "unreconciled")) return { status: "unreconciled", completed, reason: "one_or_more_provider_turns_aborted_or_failed" }; if (evidence.some((entry) => entry.status === "unavailable")) return { status: "unavailable", completed, reason: "provider_usage_not_reported" }; return { status: "available", completed }; }
function tokenCapFailure(usage: UsageEvidence, caps: LiveEvaluationManifest["tokenCaps"]): EvaluationResourceLimitExceededError["code"] | undefined {
  if (usage.completed.inputTokens > caps.inputTokens) return "input_token_cap_exceeded";
  if (usage.completed.outputTokens > caps.outputTokens) return "output_token_cap_exceeded";
  if (usage.completed.totalTokens > caps.totalTokens) return "total_token_cap_exceeded";
  return undefined;
}

export class EvaluationDeadlineExceededError extends Error { constructor(readonly code: "live_suite_deadline_exceeded" | "scenario_deadline_exceeded" | "customer_turn_deadline_exceeded") { super(code); } }
export class EvaluationResourceLimitExceededError extends Error { constructor(readonly code: "provider_response_budget_exceeded_before_request_221" | "conversation_create_budget_exceeded_before_request_87" | "input_token_cap_exceeded" | "output_token_cap_exceeded" | "total_token_cap_exceeded") { super(code); } }
export function assertDeadline(deadlineAt: number, code: EvaluationDeadlineExceededError["code"], now = Date.now()): void { if (now >= deadlineAt) throw new EvaluationDeadlineExceededError(code); }
/** Genuine signal propagation replaces race-only cancellation. */
export class DeadlineBoundAgentGateway implements AgentGateway {
  private readonly pendingConversations = new Map<string, TurnAbort>();
  constructor(private readonly delegate: AgentGateway, private readonly deadlines: { suiteDeadlineAt: number; scopeDeadlineAt: number; customerTurnDeadlineMs: number }, private readonly now: () => number = Date.now, private readonly conversationCreateCounter?: ConversationCreateCounter) {}
  async createConversation(leadId: string, signal?: AbortSignal): Promise<{ id: string }> { const turn = this.newTurn(signal); try { throwIfAborted(turn.signal); this.conversationCreateCounter?.beforeConversationCreate(); const conversation = await this.delegate.createConversation(leadId, turn.signal); this.pendingConversations.set(conversation.id, turn); return conversation; } catch (error) { turn.dispose(); throw error; } }
  async runTurn(input: Parameters<AgentGateway["runTurn"]>[0]) { const turn = this.pendingConversations.get(input.conversationId) ?? this.newTurn(input.signal); this.pendingConversations.delete(input.conversationId); try { throwIfAborted(turn.signal); return await this.delegate.runTurn({ ...input, signal: composeSignals(input.signal, turn.signal) }); } finally { turn.dispose(); } }
  private newTurn(existing: AbortSignal | undefined): TurnAbort { const now = this.now(); const candidates: Array<{ at: number; code: EvaluationDeadlineExceededError["code"] }> = [{ at: now + this.deadlines.customerTurnDeadlineMs, code: "customer_turn_deadline_exceeded" }, { at: this.deadlines.scopeDeadlineAt, code: "scenario_deadline_exceeded" }, { at: this.deadlines.suiteDeadlineAt, code: "live_suite_deadline_exceeded" }]; const earliest = candidates.reduce((first, candidate) => candidate.at < first.at ? candidate : first); if (earliest.at <= now) throw new EvaluationDeadlineExceededError(earliest.code); return new TurnAbort(composeSignals(existing), earliest.at - now, earliest.code); }
}
class TurnAbort { private readonly controller = new AbortController(); private readonly timer: ReturnType<typeof setTimeout>; readonly signal: AbortSignal; constructor(existing: AbortSignal | undefined, delayMs: number, code: EvaluationDeadlineExceededError["code"]) { this.timer = setTimeout(() => this.controller.abort(new EvaluationDeadlineExceededError(code)), delayMs); this.signal = composeSignals(existing, this.controller.signal)!; } dispose(): void { clearTimeout(this.timer); } }
function scenarioDeadlineMs(scenario: LiveConversationScenario, manifest: LiveEvaluationManifest): number { return scenario.customerMessages.length >= 6 ? manifest.longScenarioDeadlineMs : manifest.focusedScenarioDeadlineMs; }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("evaluation_abort_signal_triggered"); }
function composeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined { const active = signals.filter((signal): signal is AbortSignal => signal !== undefined); return active.length === 0 ? undefined : active.length === 1 ? active[0] : AbortSignal.any(active); }
function addUsage(left: CompletedUsage, right: CompletedUsage): CompletedUsage { return { requests: left.requests + right.requests, inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens, totalTokens: left.totalTokens + right.totalTokens, cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens }; }
function emptyUsage(): CompletedUsage { return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 }; }
function latencyEvidence(durations: number[]): LiveEvaluationReport["latency"] { if (durations.length === 0) return { completedTurns: 0, p50Ms: null, p95Ms: null, withinTargets: null }; const ordered = [...durations].sort((left, right) => left - right); const percentile = (percent: number) => ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percent) - 1)]!; const p50Ms = percentile(0.5); const p95Ms = percentile(0.95); return { completedTurns: ordered.length, p50Ms, p95Ms, withinTargets: p50Ms <= liveEvaluationP50TargetMs && p95Ms <= liveEvaluationP95TargetMs && ordered.every((duration) => duration <= liveEvaluationCustomerTurnDeadlineMs) }; }
function assertLiveReportPath(path: string): string { const destination = resolve(path); const allowedRoot = resolve(process.cwd(), ".runtime", "conversation-live-evaluations"); if (!destination.startsWith(`${allowedRoot}/`)) throw new Error("Live evaluation reports must stay under .runtime/conversation-live-evaluations"); return destination; }
function isLiveReport(value: unknown): value is LiveEvaluationReport { if (typeof value !== "object" || value === null) return false; const report = value as Partial<LiveEvaluationReport>; return report.version === 4 && report.manifest !== undefined && Array.isArray(report.scenarios) && report.summary !== undefined && report.providerResponses !== undefined && report.conversationCreates !== undefined; }
function sha256(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
export function canonicalLiveEvaluationManifestSha256(manifest: Omit<LiveEvaluationManifest, "manifestSha256">): string { return sha256(manifest); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function sanitize(value: string): string { return value.replace(/\bsk-[A-Za-z0-9_-]+\b/gu, "[redacted-key]").replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/giu, "[redacted-id]").replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu, "[redacted-email]").replace(/\+?\d[\d ()-]{7,}\d/gu, "[redacted-phone]").replace(/\b[A-Za-z0-9_-]{40,}\b/gu, "[redacted-token]"); }
