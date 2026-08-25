import { readFile, unlink } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { AgentTurnTechnicalError, FakeAgentGateway, type AgentGateway, type AgentTurnInput } from "@/lib/agent/gateway";
import type { AgentTurn } from "@/lib/contracts/domain";

import {
  canonicalLiveEvaluationManifestSha256,
  DeadlineBoundAgentGateway,
  defaultLiveEvaluationReportPath,
  EvaluationDeadlineExceededError,
  EvaluationResourceLimitExceededError,
  liveEvaluationConfirmation,
  liveEvaluationCustomerTurnDeadlineMs,
  liveEvaluationFocusedScenarioDeadlineMs,
  liveEvaluationLongScenarioDeadlineMs,
  liveEvaluationMaxResponsesPerCustomerMessage,
  liveEvaluationProviderRequestTimeoutMs,
  liveEvaluationProviderResponseBudget,
  liveEvaluationSmokeScenarioCount,
  liveEvaluationSuiteDeadlineMs,
  liveEvaluationRubricRevision,
  liveEvaluationTokenCaps,
  markLiveEvaluationReportFailed,
  loadAcceptedSmokeCheckpoint,
  persistCustomerMessageCheckpoint,
  ProviderResponseCounter,
  reEvaluateStoredLiveReport,
  runLiveConversationEvaluation,
  toScenarioResult,
  type LiveEvaluationManifest,
  type LiveEvaluationReport,
} from "../support/live-conversation-evaluation";
import { runConversationScenario, type SanitizedConversationArtifact } from "../support/conversation-sandbox";
import { liveConversationMessageCount, liveConversationScenarioCount, liveConversationScenarios, type LiveConversationScenario } from "../support/conversation-live-scenarios";

const manifest = (): LiveEvaluationManifest => {
  const unsignedManifest: Omit<LiveEvaluationManifest, "manifestSha256"> = {
    fixtureSha256: "fixture-hash",
    scenarioCount: liveConversationScenarioCount,
    customerMessageCount: liveConversationMessageCount,
    smokeScenarioCount: liveEvaluationSmokeScenarioCount,
    smokeCustomerMessageCount: 31,
    model: "gpt-test",
    reasoningEffort: "low",
    maxOutputTokens: 1200,
    maxSemanticToolSteps: 4,
    maxResponsesPerCustomerMessage: liveEvaluationMaxResponsesPerCustomerMessage,
    providerResponseBudget: liveEvaluationProviderResponseBudget,
    maxResponseAttemptsPerModelTurn: 1,
    maxConversationCreateRequests: liveConversationScenarioCount,
    maxProviderRequestDurationMs: liveEvaluationProviderRequestTimeoutMs,
    maxCustomerTurnDurationMs: liveEvaluationCustomerTurnDeadlineMs,
    focusedScenarioDeadlineMs: liveEvaluationFocusedScenarioDeadlineMs,
    longScenarioDeadlineMs: liveEvaluationLongScenarioDeadlineMs,
    maxSuiteDurationMs: liveEvaluationSuiteDeadlineMs,
    prompt: { source: "baseline", revision: "prompt-revision", sha256: "prompt-hash" },
    pricingRules: { version: 1, sha256: "pricing-hash" },
    evaluator: { revision: liveEvaluationRubricRevision, sha256: "test-evaluator-hash" },
    tokenCaps: liveEvaluationTokenCaps,
  };
  return { ...unsignedManifest, manifestSha256: canonicalLiveEvaluationManifestSha256(unsignedManifest) };
};

const liveRequest = (overrides = {}) => ({
  live: true,
  phase: "smoke" as const,
  confirmation: liveEvaluationConfirmation,
  manifestSha256: manifest().manifestSha256,
  scenarioCount: liveConversationScenarioCount,
  maxToolSteps: 4,
  model: "gpt-test",
  reasoningEffort: "low",
  maxOutputTokens: 1200,
  maxSuiteDurationMs: liveEvaluationSuiteDeadlineMs,
  reportPath: defaultLiveEvaluationReportPath(new Date("2026-08-24T10:00:00.000Z")),
  ...overrides,
});

const validSmokeReport = (currentManifest: LiveEvaluationManifest): LiveEvaluationReport => {
  const fixtures = liveConversationScenarios.slice(0, liveEvaluationSmokeScenarioCount);
  const scenarios = fixtures.map((fixture) => {
    const checkpointEvidence = fixture.customerMessages.map((customer, index) => {
      const { semanticTools, semanticToolsOneOf, visibleIncludes: _visibleIncludes, ...state } = fixture.checkpointExpectations?.[index] ?? {};
      void semanticToolsOneOf;
      void _visibleIncludes;
      const requiredAtFirstCheckpoint = index === 0 ? Object.entries(fixture.requiredToolCounts ?? {}).flatMap(([name, count]) => count === 1 ? [name as "mark_human_needed"] : []) : [];
      return { provenance: "post_customer_message_checkpoint" as const, customerMessageNumber: index + 1, customer, semanticTools: semanticTools ?? requiredAtFirstCheckpoint, quoteState: fixture.expected.hasQuote ? "active" as const : "none" as const, humanNeeded: fixture.expected.humanNeeded, calendarCreates: fixture.expected.fakeCalendarCreates, slotOfferCount: fixture.expected.slotOffer ? 1 : 0, ...state };
    });
    return ({
    id: fixture.id,
    state: "passed" as const,
    failures: [],
    transcript: fixture.customerMessages.map((customer, index) => {
      const checkpoint = fixture.checkpointExpectations?.[index];
      const visibleText = checkpoint?.visibleIncludes?.join(" ") ?? (checkpoint?.visibleDifferentFromPrevious ? `I can help ${index}.` : "I can help.");
      return { customer, transportText: visibleText, visibleText, trustedTransport: true };
    }),
    rubric: { customerSafe: true, nonEmptyReplies: true, noStockThanksOrBotSyntax: true, intakeFocused: true },
    observed: { pricingRulesVersions: [1], semanticTools: [], slotOffer: fixture.expected.slotOffer, customerTurnDurationsMs: fixture.customerMessages.map(() => 10), messageEvidence: checkpointEvidence, usage: { status: "available" as const, completed: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 } } },
    outcome: { status: fixture.expected.humanNeeded ? "human_needed" : "qualified", hasQuote: fixture.expected.hasQuote, quoteState: fixture.expected.hasQuote ? "active" as const : "none" as const, humanNeeded: fixture.expected.humanNeeded, fakeCalendarCreates: fixture.expected.fakeCalendarCreates, slotOffer: fixture.expected.slotOffer, slotOfferCount: fixture.expected.slotOffer ? 1 : 0 },
  });
  });
  const messages = fixtures.reduce((total, fixture) => total + fixture.customerMessages.length, 0);
  return {
    version: 4, mode: "live", phase: "smoke", state: "smoke_complete_pending_acceptance", manifest: currentManifest,
    summary: { processed: fixtures.length, customerMessagesProcessed: messages, failed: 0, repliesSafe: fixtures.length, quotes: scenarios.filter((scenario) => scenario.outcome.hasQuote).length, humanNeeded: scenarios.filter((scenario) => scenario.outcome.humanNeeded).length, fakeCalendarCreates: scenarios.reduce((total, scenario) => total + scenario.outcome.fakeCalendarCreates, 0) },
    scenarios,
    providerResponses: { started: fixtures.length, limit: liveEvaluationProviderResponseBudget, remaining: liveEvaluationProviderResponseBudget - fixtures.length },
    latency: { completedTurns: messages, p50Ms: 10, p95Ms: 10, withinTargets: true },
    usage: { status: "available", completed: { requests: fixtures.length, inputTokens: fixtures.length, outputTokens: fixtures.length, totalTokens: fixtures.length * 2, cachedInputTokens: 0 } },
  };
};

describe("live conversation evaluation guard", () => {
  it("keeps the default mode dry and never constructs an OpenAI gateway", async () => {
    const agentFactory = vi.fn(() => new FakeAgentGateway());
    const report = await runLiveConversationEvaluation({ live: false }, agentFactory, manifest());
    expect(agentFactory).not.toHaveBeenCalled();
    expect(report).toMatchObject({ mode: "dry_run", state: "planned", manifest: { scenarioCount: 20, customerMessageCount: liveConversationMessageCount } });
  });

  it("requires the immutable smoke gate before it constructs an agent", async () => {
    const agentFactory = vi.fn(() => new FakeAgentGateway());
    await expect(runLiveConversationEvaluation(liveRequest({ phase: undefined }), agentFactory, manifest())).rejects.toThrow("--phase=smoke or --phase=remaining");
    await expect(runLiveConversationEvaluation(liveRequest({ confirmation: undefined }), agentFactory, manifest())).rejects.toThrow("literal confirmation");
    await expect(runLiveConversationEvaluation(liveRequest({ scenarioCount: 19 }), agentFactory, manifest())).rejects.toThrow("scenario-count");
    await expect(runLiveConversationEvaluation(liveRequest({ maxToolSteps: 5 }), agentFactory, manifest())).rejects.toThrow("max-tool-steps");
    expect(agentFactory).not.toHaveBeenCalled();
  });

  it("binds a paid invocation to the exact dry manifest before constructing an agent", async () => {
    const agentFactory = vi.fn(() => new FakeAgentGateway());
    await expect(runLiveConversationEvaluation(liveRequest({ manifestSha256: "stale" }), agentFactory, manifest())).rejects.toThrow("manifest-sha256");
    const tampered = manifest();
    tampered.customerMessageCount += 1;
    await expect(runLiveConversationEvaluation(liveRequest(), agentFactory, tampered)).rejects.toThrow("manifest hash is invalid");
    const rubricTampered = manifest();
    rubricTampered.evaluator.revision = "different-rubric";
    await expect(runLiveConversationEvaluation(liveRequest(), agentFactory, rubricTampered)).rejects.toThrow("manifest hash is invalid");
    expect(agentFactory).not.toHaveBeenCalled();
  });

  it("uses a real abort signal for a customer-turn deadline instead of a race", async () => {
    vi.useFakeTimers();
    const delegate = {
      createConversation: vi.fn(async (_leadId: string, signal?: AbortSignal) => new Promise<{ id: string }>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      })),
      runTurn: vi.fn(),
    };
    const bounded = new DeadlineBoundAgentGateway(delegate, {
      suiteDeadlineAt: 1_000,
      scopeDeadlineAt: 1_000,
      customerTurnDeadlineMs: 5,
    }, () => 0);
    const pending = bounded.createConversation("lead");
    const rejected = expect(pending).rejects.toMatchObject({ code: "customer_turn_deadline_exceeded" });
    await vi.advanceTimersByTimeAsync(5);
    await rejected;
    expect(delegate.createConversation).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("passes the same deadline signal into a model run after Conversation creation", async () => {
    vi.useFakeTimers();
    const delegate = {
      createConversation: vi.fn(async () => ({ id: "conversation" })),
      runTurn: vi.fn(async (input: AgentTurnInput): Promise<AgentTurn> => new Promise<AgentTurn>((_resolve, reject) => {
        const signal = input.signal;
        if (!signal) return reject(new Error("missing_test_signal"));
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })),
    };
    const bounded = new DeadlineBoundAgentGateway(delegate, {
      suiteDeadlineAt: 1_000,
      scopeDeadlineAt: 1_000,
      customerTurnDeadlineMs: 5,
    }, () => 0);
    const conversation = await bounded.createConversation("lead");
    const pending = bounded.runTurn({ conversationId: conversation.id, systemPrompt: "prompt", message: "message", replyLanguage: "en", knownClientData: {}, executeTool: async () => ({}) });
    const rejected = expect(pending).rejects.toMatchObject({ code: "customer_turn_deadline_exceeded" });
    await vi.advanceTimersByTimeAsync(5);
    await rejected;
    expect(delegate.runTurn).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.useRealTimers();
  });

  it("counts actual Responses requests and fails closed before request 221", () => {
    const counter = new ProviderResponseCounter(2);
    counter.beforeResponseRequest();
    expect(counter.snapshot()).toEqual({ started: 1, limit: 2, remaining: 1 });
    counter.beforeResponseRequest();
    expect(() => counter.beforeResponseRequest()).toThrow(EvaluationResourceLimitExceededError);
    try { counter.beforeResponseRequest(); } catch (error) {
      expect(error).toMatchObject({ code: "provider_response_budget_exceeded_before_request_221" });
    }
  });

  it("keeps a completed checkpoint and writes terminal incomplete when request 221 is refused in the evaluator", async () => {
    const path = defaultLiveEvaluationReportPath(new Date("2026-08-24T10:00:00.221Z"));
    let turns = 0;
    const completedUsage = { requests: 1, inputTokens: 17, outputTokens: 5, totalTokens: 22, cachedInputTokens: 3 };
    const factory = vi.fn((input) => ({
      async createConversation() { return { id: "resource-fence" }; },
      async runTurn(turn: AgentTurnInput): Promise<AgentTurn> {
        turns += 1;
        if (turns === 1) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          await turn.executeTool("update_client_data", { patch: {
            cleaningType: "standard", areaM2: 50, rooms: 1, bathrooms: 1,
            heavyPetHair: false, extras: [], addressOrDistrict: "Vracar",
          } });
          await turn.executeTool("calculate_quote", {});
          return { reply: "I can help with that.", toolResults: [], steps: 0, usage: completedUsage };
        }
        while (input.responseRequestCounter.snapshot().remaining > 0) input.responseRequestCounter.beforeResponseRequest();
        input.responseRequestCounter.beforeResponseRequest();
        throw new Error("unreachable");
      },
    }));
    await expect(runLiveConversationEvaluation(liveRequest({ reportPath: path }), factory, manifest())).rejects.toThrow("provider_response_budget_exceeded_before_request_221");
    const report = JSON.parse(await readFile(path, "utf8")) as LiveEvaluationReport;
    expect(report).toMatchObject({
      state: "incomplete",
      terminalFailure: "provider_response_budget_exceeded_before_request_221",
      providerResponses: { started: liveEvaluationProviderResponseBudget, remaining: 0 },
      activeCheckpoint: { scenarioId: liveConversationScenarios[0]?.id, customerMessagesCompleted: 1 },
      scenarios: [],
      summary: { processed: 0, customerMessagesProcessed: 1, failed: 0, quotes: 1, humanNeeded: 0, fakeCalendarCreates: 0 },
      usage: { status: "available", completed: completedUsage },
    });
    expect(report.activeCheckpoint).toMatchObject({ outcome: { hasQuote: true, humanNeeded: false, fakeCalendarCreates: 0 } });
    expect(report.activeCheckpoint?.observed.customerTurnDurationsMs).toHaveLength(1);
    expect(report.activeCheckpoint?.observed.customerTurnDurationsMs[0]).toBeGreaterThan(0);
    expect(report.latency).toMatchObject({ completedTurns: 1 });
    expect(report.latency.p50Ms).toBeGreaterThan(0);
    await unlink(path);
  });

  it("keeps the accepted smoke evidence immutable before a distinct remaining phase", async () => {
    const smokePath = defaultLiveEvaluationReportPath(new Date("2026-08-24T10:00:01.000Z"));
    const remainingPath = defaultLiveEvaluationReportPath(new Date("2026-08-24T10:00:02.000Z"));
    const currentManifest = manifest();
    const smoke = validSmokeReport(currentManifest);
    const { writeLiveEvaluationReport } = await import("../support/live-conversation-evaluation");
    await writeLiveEvaluationReport(smokePath, smoke);
    const accepted = await loadAcceptedSmokeCheckpoint(smokePath, currentManifest);
    expect(accepted).toMatchObject({ manifestSha256: currentManifest.manifestSha256, providerResponsesStarted: 5 });

    const factory = vi.fn((input) => {
      input.responseRequestCounter.beforeResponseRequest();
      throw new Error("stop_after_remaining_gate");
    });
    await expect(runLiveConversationEvaluation(liveRequest({ phase: "remaining", reportPath: remainingPath, acceptedSmokeReportPath: smokePath }), factory, currentManifest)).rejects.toThrow("stopped before completion");
    expect(factory).toHaveBeenCalledOnce();
    const remaining = JSON.parse(await readFile(remainingPath, "utf8")) as LiveEvaluationReport;
    expect(remaining).toMatchObject({ phase: "remaining", providerResponses: { started: 6, remaining: liveEvaluationProviderResponseBudget - 6 }, acceptedSmoke: { reportPath: smokePath, providerResponsesStarted: 5 } });
    const original = JSON.parse(await readFile(smokePath, "utf8")) as LiveEvaluationReport;
    expect(original.state).toBe("smoke_complete_pending_acceptance");
    await unlink(smokePath); await unlink(remainingPath);
  });

  it("rejects a missing or stale accepted smoke checkpoint before constructing the agent", async () => {
    const factory = vi.fn(() => new FakeAgentGateway());
    await expect(runLiveConversationEvaluation(liveRequest({ phase: "remaining", acceptedSmokeReportPath: undefined }), factory, manifest())).rejects.toThrow("accepted-smoke-report");
    await expect(runLiveConversationEvaluation(liveRequest({ phase: "remaining", acceptedSmokeReportPath: defaultLiveEvaluationReportPath(new Date("2026-08-24T10:00:03.000Z")) }), factory, manifest())).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects a copied manifest hash with altered limits and fabricated smoke evidence", async () => {
    const path = defaultLiveEvaluationReportPath(new Date("2026-08-24T10:00:04.000Z"));
    const currentManifest = manifest();
    const forged = validSmokeReport(structuredClone(currentManifest));
    forged.manifest.maxOutputTokens = 1;
    // Simulate a copied self-declared digest instead of recomputing it.
    forged.manifest.manifestSha256 = currentManifest.manifestSha256;
    const { writeLiveEvaluationReport } = await import("../support/live-conversation-evaluation");
    await writeLiveEvaluationReport(path, forged);
    await expect(loadAcceptedSmokeCheckpoint(path, currentManifest)).rejects.toThrow("embedded manifest hash is invalid");

    const divergent = validSmokeReport(structuredClone(currentManifest));
    divergent.manifest.maxOutputTokens = 100;
    const { manifestSha256: _oldHash, ...unsignedDivergent } = divergent.manifest;
    void _oldHash;
    divergent.manifest.manifestSha256 = canonicalLiveEvaluationManifestSha256(unsignedDivergent);
    await writeLiveEvaluationReport(path, divergent);
    await expect(loadAcceptedSmokeCheckpoint(path, currentManifest)).rejects.toThrow("manifest/config does not exactly match");

    const incoherentBudget = validSmokeReport(currentManifest);
    incoherentBudget.providerResponses = { started: 6, limit: liveEvaluationProviderResponseBudget, remaining: liveEvaluationProviderResponseBudget - 6 };
    await writeLiveEvaluationReport(path, incoherentBudget);
    await expect(loadAcceptedSmokeCheckpoint(path, currentManifest)).rejects.toThrow("Responses budget evidence");

    const unreconciled = validSmokeReport(currentManifest);
    unreconciled.scenarios[0]!.observed.usage = { status: "unreconciled", completed: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 }, reason: "aborted" };
    await writeLiveEvaluationReport(path, unreconciled);
    await expect(loadAcceptedSmokeCheckpoint(path, currentManifest)).rejects.toThrow("outcome or usage evidence");

    const fabricated = validSmokeReport(currentManifest);
    fabricated.scenarios[0]!.transcript[0]!.visibleText = "";
    await writeLiveEvaluationReport(path, fabricated);
    await expect(loadAcceptedSmokeCheckpoint(path, currentManifest)).rejects.toThrow("transcript evidence");

    // S1 only constrains its final checkpoint. Every earlier evidence item
    // still has to be bound to its exact customer message and its post-message
    // checkpoint provenance, otherwise a reordered or substituted transcript
    // could be accepted as legitimate smoke evidence.
    const alteredS1Evidence = validSmokeReport(currentManifest);
    alteredS1Evidence.scenarios[0]!.observed.messageEvidence![0]!.customer = "altered customer text";
    await writeLiveEvaluationReport(path, alteredS1Evidence);
    await expect(loadAcceptedSmokeCheckpoint(path, currentManifest)).rejects.toThrow("ordered message evidence");

    const reorderedS2Evidence = validSmokeReport(currentManifest);
    const s2Evidence = reorderedS2Evidence.scenarios[1]!.observed.messageEvidence!;
    [s2Evidence[0], s2Evidence[1]] = [s2Evidence[1]!, s2Evidence[0]!];
    await writeLiveEvaluationReport(path, reorderedS2Evidence);
    await expect(loadAcceptedSmokeCheckpoint(path, currentManifest)).rejects.toThrow("ordered message evidence");

    const missingProvenance = validSmokeReport(currentManifest);
    missingProvenance.scenarios[1]!.observed.messageEvidence![0]!.provenance = "forged" as never;
    await writeLiveEvaluationReport(path, missingProvenance);
    await expect(loadAcceptedSmokeCheckpoint(path, currentManifest)).rejects.toThrow("ordered message evidence");
    await unlink(path);
  });

  it("rejects English S3 confirmation, forbidden S2 date-only tools, repeated S4 follow-up, and stale S5 date evidence", async () => {
    const currentManifest = manifest();
    const { writeLiveEvaluationReport } = await import("../support/live-conversation-evaluation");
    const cases: Array<[string, (report: LiveEvaluationReport) => void]> = [
      ["english-s3", (report) => { report.scenarios[2]!.transcript[7]!.visibleText = "Your booking is confirmed."; }],
      ["s2-date-only-availability", (report) => { report.scenarios[1]!.observed.messageEvidence![4]!.semanticTools = ["request_available_slots"]; }],
      ["s2-date-only-quote", (report) => { report.scenarios[1]!.observed.messageEvidence![4]!.semanticTools = ["calculate_quote"]; }],
      ["s2-date-only-handoff", (report) => { report.scenarios[1]!.observed.messageEvidence![4]!.semanticTools = ["mark_human_needed"]; }],
      ["s2-date-only-booking", (report) => { report.scenarios[1]!.observed.messageEvidence![4]!.calendarCreates = 1; }],
      ["repeat-s4", (report) => { report.scenarios[3]!.transcript[2]!.visibleText = report.scenarios[3]!.transcript[1]!.visibleText; }],
      ["stale-s5", (report) => { report.scenarios[4]!.observed.messageEvidence![0]!.preferredDate = "2025-08-26"; }],
      ["second-s4-handoff", (report) => { report.scenarios[3]!.observed.messageEvidence![1]!.semanticTools.push("mark_human_needed"); }],
    ];
    for (const [name, mutate] of cases) {
      const path = defaultLiveEvaluationReportPath(new Date(`2026-08-24T10:00:${String(cases.findIndex(([id]) => id === name) + 6).padStart(2, "0")}.000Z`));
      const report = validSmokeReport(currentManifest);
      mutate(report);
      await writeLiveEvaluationReport(path, report);
      await expect(loadAcceptedSmokeCheckpoint(path, currentManifest)).rejects.toThrow();
      await unlink(path);
    }
  });

  it("writes the just-completed message checkpoint before enforcing its post-message deadline", async () => {
    const path = defaultLiveEvaluationReportPath(new Date("2026-08-24T10:00:05.000Z"));
    const currentManifest = manifest();
    const report: LiveEvaluationReport = {
      ...validSmokeReport(currentManifest), state: "running", scenarios: [],
      summary: { processed: 0, customerMessagesProcessed: 0, failed: 0, repliesSafe: 0, quotes: 0, humanNeeded: 0, fakeCalendarCreates: 0 },
      providerResponses: { started: 0, limit: liveEvaluationProviderResponseBudget, remaining: liveEvaluationProviderResponseBudget },
      usage: { status: "unavailable", completed: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 }, reason: "no_completed_provider_runs" },
    };
    const fixture = liveConversationScenarios[0]!;
    await expect(persistCustomerMessageCheckpoint({
      report, scenario: fixture,
      artifact: { scenarioId: fixture.id, transcript: [{ customer: fixture.customerMessages[0]!, transportText: "I can help.", visibleText: "I can help.", trustedTransport: true }], turns: [], lead: { status: "qualified", clientData: {}, hasQuote: false, quoteState: "none", humanNeeded: false }, calendarCreates: 0, slotOffer: false, slotOfferCount: 0, messageEvidence: [] },
      customerTurnDurationsMs: [10], providerResponses: report.providerResponses, reportPath: path,
      suiteDeadlineAt: 0, scopeDeadlineAt: Date.now() + 1_000,
    })).rejects.toMatchObject({ code: "live_suite_deadline_exceeded" });
    const saved = JSON.parse(await readFile(path, "utf8")) as LiveEvaluationReport;
    expect(saved.activeCheckpoint).toMatchObject({ scenarioId: fixture.id, customerMessagesCompleted: 1, transcript: [{ customer: fixture.customerMessages[0], visibleText: "I can help." }], criteria: fixture.expected });
    await unlink(path);
  });

  it("stops the evaluator as incomplete when a recorded output-token cap is reached", async () => {
    const path = defaultLiveEvaluationReportPath(new Date("2026-08-24T10:00:05.500Z"));
    const report: LiveEvaluationReport = { ...validSmokeReport(manifest()), state: "running", scenarios: [], summary: { processed: 0, customerMessagesProcessed: 0, failed: 0, repliesSafe: 0, quotes: 0, humanNeeded: 0, fakeCalendarCreates: 0 }, providerResponses: { started: 1, limit: liveEvaluationProviderResponseBudget, remaining: liveEvaluationProviderResponseBudget - 1 }, usage: { status: "available", completed: { requests: 1, inputTokens: 1, outputTokens: 20_001, totalTokens: 20_002, cachedInputTokens: 0 } } };
    const fixture = liveConversationScenarios[0]!;
    const artifact = { scenarioId: fixture.id, transcript: [{ customer: fixture.customerMessages[0]!, transportText: "I can help.", visibleText: "I can help.", trustedTransport: true }], turns: [{ knownClientData: {}, pricingRulesVersion: 1, allowedTools: [], semanticTools: [], usage: { requests: 1, inputTokens: 1, outputTokens: 20_001, totalTokens: 20_002, cachedInputTokens: 0 } }], lead: { status: "qualified", clientData: {}, hasQuote: false, quoteState: "none" as const, humanNeeded: false }, calendarCreates: 0, slotOffer: false, slotOfferCount: 0, messageEvidence: [] };
    await expect(persistCustomerMessageCheckpoint({ report, scenario: fixture, artifact, customerTurnDurationsMs: [10], providerResponses: report.providerResponses, reportPath: path, suiteDeadlineAt: Date.now() + 1_000, scopeDeadlineAt: Date.now() + 1_000 })).rejects.toBeInstanceOf(EvaluationResourceLimitExceededError);
    await unlink(path);
  });

  it("marks a setup interruption terminal and keeps a sanitized checkpoint", async () => {
    const path = defaultLiveEvaluationReportPath(new Date("2026-08-24T10:00:00.002Z"));
    const agentFactory = vi.fn(() => { throw new Error("simulated setup failure with sk-secret-that-must-not-appear"); });
    await expect(runLiveConversationEvaluation(liveRequest({ reportPath: path }), agentFactory, manifest())).rejects.toThrow("stopped before completion");
    const saved = JSON.parse(await readFile(path, "utf8")) as { state: string; terminalFailure?: string; summary: { failed: number } };
    expect(saved).toMatchObject({ state: "failed", summary: { failed: 1 } });
    expect(saved.terminalFailure).toBe("evaluation_processing_failed");
    expect(saved.terminalFailure).not.toContain("sk-secret");
    await unlink(path);
  });

  it("reports completed usage with cached-input subtotal and never fabricates a currency cost", async () => {
    const artifact = await runConversationScenario({
      id: "outcome-mismatch",
      customerMessages: ["Hello", "I need cleaning", "Please estimate"],
      agentTurns: [{ reply: "I can help with that." }, { reply: "What size is the flat?" }, { reply: "How many rooms are there?" }],
      agentTurnLimit: 3,
      expected: {},
    });
    const scenario: LiveConversationScenario = { id: "outcome-mismatch", customerMessages: ["Hello", "I need cleaning", "Please estimate"], agentTurnLimit: 3, expected: { hasQuote: true, humanNeeded: false, fakeCalendarCreates: 0, slotOffer: false } };
    const result = toScenarioResult(scenario, { ...artifact, turns: artifact.turns.map((turn) => ({ ...turn, usage: { requests: 1, inputTokens: 11, outputTokens: 7, totalTokens: 18, cachedInputTokens: 4 } })) });
    expect(result.state).toBe("failed");
    expect(result.observed.usage).toEqual({ status: "available", completed: { requests: 3, inputTokens: 33, outputTokens: 21, totalTokens: 54, cachedInputTokens: 12 } });
  });

  it("retains only a typed provider failure code, elapsed time and unreconciled usage in evaluator evidence", () => {
    const scenario: LiveConversationScenario = {
      id: "typed-provider-evidence", customerMessages: ["Hello", "Need cleaning", "Can you estimate?"], agentTurnLimit: 3,
      expected: { hasQuote: false, humanNeeded: false, fakeCalendarCreates: 0, slotOffer: false },
    };
    const artifact: SanitizedConversationArtifact = {
      scenarioId: scenario.id,
      transcript: scenario.customerMessages.map((customer) => ({ customer, transportText: "I can help.", visibleText: "I can help.", trustedTransport: true })),
      turns: [{ knownClientData: {}, pricingRulesVersion: 1, allowedTools: [], semanticTools: [], technicalFailureCode: "agent_provider_timeout", elapsedMs: 123.7, usageUnreconciledReason: "provider_turn_usage_unreconciled" }],
      lead: { status: "new_lead", clientData: {}, hasQuote: false, quoteState: "none", humanNeeded: false },
      calendarCreates: 0, slotOffer: false, slotOfferCount: 0,
      messageEvidence: scenario.customerMessages.map((customer, index) => ({ provenance: "post_customer_message_checkpoint", customerMessageNumber: index + 1, customer, semanticTools: [], quoteState: "none", humanNeeded: false, calendarCreates: 0, slotOfferCount: 0 })),
    };
    expect(toScenarioResult(scenario, artifact).observed).toMatchObject({
      technicalFailures: [{ code: "agent_provider_timeout", elapsedMs: 124, usageUnreconciled: true }],
      usage: { status: "unreconciled", reason: "provider_turn_usage_unreconciled" },
    });
  });

  it("captures a webhook-recovered injected provider timeout as sanitized evaluator evidence end to end", async () => {
    let turns = 0;
    const agent: AgentGateway = {
      async createConversation() { return { id: `injected-${turns}` }; },
      async runTurn() {
        if (turns++ === 0) throw new AgentTurnTechnicalError("agent_provider_timeout", undefined, "provider_turn_usage_unreconciled");
        return { reply: "What size is the place?", toolResults: [], steps: 0 };
      },
    };
    const scenario: LiveConversationScenario = {
      id: "injected-timeout", customerMessages: ["Need cleaning", "It is a flat.", "About 50 m2."], agentTurnLimit: 3,
      expected: { hasQuote: false, humanNeeded: false, fakeCalendarCreates: 0, slotOffer: false },
    };
    const artifact = await runConversationScenario({ id: scenario.id, customerMessages: [...scenario.customerMessages], agentTurnLimit: 3, expected: {} }, { agent });
    const result = toScenarioResult(scenario, artifact);
    expect(result.observed.technicalFailures).toEqual([expect.objectContaining({ code: "agent_provider_timeout", usageUnreconciled: true })]);
    expect(JSON.stringify(result)).not.toContain("provider body");
  });

  it("captures a recovered create-time timeout with its safe operation, code and elapsed evidence end to end", async () => {
    let creates = 0;
    const agent: AgentGateway = {
      async createConversation() {
        if (creates++ === 0) throw new AgentTurnTechnicalError("agent_provider_timeout", undefined, "provider_conversation_create_usage_unreconciled");
        return { id: `created-after-recovery-${creates}` };
      },
      async runTurn() { return { reply: "What size is the place?", toolResults: [], steps: 0 }; },
    };
    const scenario: LiveConversationScenario = {
      id: "injected-create-timeout", customerMessages: ["Need cleaning", "It is a flat.", "About 50 m2."], agentTurnLimit: 3,
      expected: { hasQuote: false, humanNeeded: false, fakeCalendarCreates: 0, slotOffer: false },
    };
    const artifact = await runConversationScenario({ id: scenario.id, customerMessages: [...scenario.customerMessages], agentTurnLimit: 3, expected: {} }, { agent });
    expect(artifact.turns[0]).toMatchObject({ operation: "conversation_create", technicalFailureCode: "agent_provider_timeout", usageUnreconciledReason: "provider_conversation_create_usage_unreconciled" });
    expect(artifact.turns[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(toScenarioResult(scenario, artifact).observed.technicalFailures).toEqual([expect.objectContaining({ code: "agent_provider_timeout", usageUnreconciled: true })]);
  });

  it("rejects the mixed service-and-layout smoke transcript through the evaluator rubric", async () => {
    const scenario: LiveConversationScenario = {
      id: "mixed-intake-transcript", customerMessages: ["Hello", "50 m2 in Vracar", "Okay"], agentTurnLimit: 3,
      expected: { hasQuote: false, humanNeeded: false, fakeCalendarCreates: 0, slotOffer: false },
    };
    const artifact = await runConversationScenario({
      id: scenario.id, customerMessages: [...scenario.customerMessages], agentTurnLimit: 3,
      agentTurns: [{ reply: "I can help." }, { reply: "What type of cleaning do you need?" }, { reply: "How many rooms are there?" }], expected: {},
    });
    const result = toScenarioResult(scenario, {
      ...artifact,
      transcript: [{
        ...artifact.transcript[0]!,
        transportText: "Для расчёта уточните, нужна стандартная или генеральная уборка, и сколько комнат с санузлами в квартире?",
        visibleText: "Для расчёта уточните, нужна стандартная или генеральная уборка, и сколько комнат с санузлами в квартире?",
      }, ...artifact.transcript.slice(1)],
    });
    expect(result).toMatchObject({ state: "failed", failures: expect.arrayContaining(["unfocused_intake_reply"]), rubric: { intakeFocused: false } });
  });

  it("rejects a repeated generic Human Needed reply where a late fixture requires context", () => {
    const scenario: LiveConversationScenario = {
      id: "repeated-human-needed", customerMessages: ["Unsupported service", "The sofa has stains.", "The carpet is wool."], agentTurnLimit: 3,
      expected: { hasQuote: false, humanNeeded: true, fakeCalendarCreates: 0, slotOffer: false },
      checkpointExpectations: [
        { humanNeeded: true },
        { humanNeeded: true, visibleDifferentFromPrevious: true },
        { humanNeeded: true, visibleDifferentFromPrevious: true },
      ],
    };
    const generic = "I have added that to your request. Our team is already handling the next step.";
    const artifact: SanitizedConversationArtifact = {
      scenarioId: scenario.id,
      transcript: scenario.customerMessages.map((customer, index) => ({ customer, transportText: index === 0 ? "Our team will review this request." : generic, visibleText: index === 0 ? "Our team will review this request." : generic, trustedTransport: true })),
      turns: [],
      lead: { status: "new_lead", clientData: {}, hasQuote: false, quoteState: "none", humanNeeded: true },
      calendarCreates: 0,
      slotOffer: false,
      slotOfferCount: 0,
      messageEvidence: scenario.customerMessages.map((customer, index) => ({ provenance: "post_customer_message_checkpoint", customerMessageNumber: index + 1, customer, semanticTools: [], quoteState: "none", humanNeeded: true, calendarCreates: 0, slotOfferCount: 0 })),
    };
    expect(toScenarioResult(scenario, artifact)).toMatchObject({ state: "failed", failures: expect.arrayContaining(["unexpected_checkpoint_evidence"]) });
  });

  it("normalizes dash, whitespace and case only for visibleIncludes checkpoint comparison", () => {
    const scenario: LiveConversationScenario = {
      id: "visible-include-normalization", customerMessages: ["One", "Two", "Three"], agentTurnLimit: 3,
      expected: { hasQuote: false, humanNeeded: false, fakeCalendarCreates: 0, slotOffer: false },
      checkpointExpectations: [{ visibleIncludes: ["commercial space"] }],
    };
    const artifact = (visibleText: string): SanitizedConversationArtifact => ({
      scenarioId: scenario.id,
      transcript: scenario.customerMessages.map((customer, index) => ({ customer, transportText: index === 0 ? visibleText : "I can help.", visibleText: index === 0 ? visibleText : "I can help.", trustedTransport: true })),
      turns: [], lead: { status: "new_lead", clientData: {}, hasQuote: false, quoteState: "none", humanNeeded: false }, calendarCreates: 0, slotOffer: false, slotOfferCount: 0,
      messageEvidence: scenario.customerMessages.map((customer, index) => ({ provenance: "post_customer_message_checkpoint", customerMessageNumber: index + 1, customer, semanticTools: [], quoteState: "none", humanNeeded: false, calendarCreates: 0, slotOfferCount: 0 })),
    });
    expect(toScenarioResult(scenario, artifact("Commercial‑space is included.")).state).toBe("passed");
    expect(toScenarioResult(scenario, artifact("Commercial accommodation is included.")).failures).toEqual(expect.arrayContaining([
      "unexpected_checkpoint_evidence:checkpoint_1:visibleIncludes",
    ]));
  });

  it("re-evaluates a saved artifact read-only against the current visibleIncludes rule", () => {
    const fixture = liveConversationScenarios.find((scenario) => scenario.id === "en-commercial")!;
    const report = validSmokeReport(manifest());
    const checkpointEvidence = fixture.customerMessages.map((customer, index) => {
      const { semanticTools, semanticToolsOneOf: _oneOf, visibleIncludes: _visible, visibleDifferentFromPrevious: _different, preferredDateAbsent: _absent, ...state } = fixture.checkpointExpectations?.[index] ?? {};
      void _oneOf; void _visible; void _different; void _absent;
      return { provenance: "post_customer_message_checkpoint" as const, customerMessageNumber: index + 1, customer, semanticTools: semanticTools ?? (index === 0 ? ["mark_human_needed" as const] : []), quoteState: "none" as const, humanNeeded: true, humanNeededReason: "commercial_property" as const, calendarCreates: 0, slotOfferCount: 0, ...state };
    });
    const source = {
      ...report,
      state: "failed" as const,
      scenarios: [{
        id: fixture.id,
        state: "failed" as const,
        failures: ["unexpected_checkpoint_evidence"],
        transcript: fixture.customerMessages.map((customer, index) => {
          const expected = fixture.checkpointExpectations?.[index];
          const visibleText = index === 3 ? "I have added the commercial-space details to your request."
            : expected?.visibleIncludes?.join(" ") ?? `I can help ${index}.`;
          return { customer, transportText: visibleText, visibleText, trustedTransport: true };
        }),
        rubric: { customerSafe: true, nonEmptyReplies: true, noStockThanksOrBotSyntax: true, intakeFocused: true },
        observed: { pricingRulesVersions: [1], semanticTools: [], slotOffer: false, customerTurnDurationsMs: fixture.customerMessages.map(() => 1), messageEvidence: checkpointEvidence, usage: { status: "available" as const, completed: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 } } },
        outcome: { status: "new_lead", hasQuote: false, quoteState: "none" as const, humanNeeded: true, humanNeededReason: "commercial_property", fakeCalendarCreates: 0, slotOffer: false, slotOfferCount: 0 },
      }],
    };
    const reEvaluation = reEvaluateStoredLiveReport(source);
    expect(reEvaluation.scenarios).toEqual([expect.objectContaining({ id: "en-commercial", priorState: "failed", reEvaluatedState: "passed", failures: [] })]);
    expect(source.scenarios[0]?.state).toBe("failed");
  });

  it("keeps intake focus green for the real deterministic S1 and S2 fixture artifacts", async () => {
    const s1 = liveConversationScenarios[0]!;
    const s2 = liveConversationScenarios[1]!;
    const [s1Artifact, s2Artifact] = await Promise.all([
      runConversationScenario({
        id: s1.id,
        customerMessages: [...s1.customerMessages],
        agentTurnLimit: s1.agentTurnLimit,
        agentTurns: [
          { reply: "Здравствуйте! Помогу рассчитать стоимость и подобрать время для уборки. Что именно хотите узнать?" },
          { reply: "Да, точную цену можно узнать до выбора времени. Какая уборка нужна и какая примерно площадь?" },
          { reply: "Для квартиры 50 м² в Врачаре уточните, пожалуйста, обычная это уборка или генеральная.", patch: { areaM2: 50, addressOrDistrict: "Врачар" } },
          { reply: "Хорошо. Сколько комнат и санузлов в квартире?", patch: { cleaningType: "standard" } },
          { reply: "Записал две комнаты. Сколько санузлов?", patch: { rooms: 2 } },
          { reply: "Есть ли сильная шерсть животных или дополнительные услуги?", patch: { bathrooms: 1 } },
          { reply: "Понял. Нужны ли окна, духовка, холодильник или балкон?", patch: { heavyPetHair: false } },
          { reply: "Теперь могу посчитать точную стоимость.", patch: { cleaningType: "standard", areaM2: 50, rooms: 2, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар" }, action: "quote" },
        ],
        expected: {},
      }),
      runConversationScenario({
        id: s2.id,
        customerMessages: [...s2.customerMessages],
        agentTurnLimit: s2.agentTurnLimit,
        expected: { evening90m2Slot: true },
        agentTurns: [
          { reply: "Помогу. Уточню пару деталей и рассчитаю стоимость." },
          { reply: "Записал параметры квартиры и сразу посчитал стоимость.", patch: { cleaningType: "standard", areaM2: 50, rooms: 2, bathrooms: 1, heavyPetHair: false, extras: [], addressOrDistrict: "Врачар" }, action: "quote" },
          { reply: "Да, базовая цена остаётся актуальной, пока параметры не изменятся." },
          { reply: "Исправляю площадь на 90 м² и пересчитываю сумму.", patch: { areaM2: 90 }, action: "quote" },
          { reply: "Дата через два дня записана. Могу подобрать время, когда будете готовы." },
        ],
      }),
    ]);

    expect(toScenarioResult(s1, s1Artifact).rubric.intakeFocused).toBe(true);
    expect(toScenarioResult(s2, s2Artifact).rubric.intakeFocused).toBe(true);
  });

  it("keeps completed usage in a partial artifact when a later provider turn is unreconciled", async () => {
    const artifact = await runConversationScenario({
      id: "partial-usage", customerMessages: ["Hello", "I need cleaning", "Please estimate"],
      agentTurns: [{ reply: "I can help." }, { reply: "What size?" }, { reply: "How many rooms?" }], agentTurnLimit: 3, expected: {},
    });
    const scenario: LiveConversationScenario = { id: "partial-usage", customerMessages: ["Hello", "I need cleaning", "Please estimate"], agentTurnLimit: 3, expected: { hasQuote: false, humanNeeded: false, fakeCalendarCreates: 0, slotOffer: false } };
    const result = toScenarioResult(scenario, {
      ...artifact,
      turns: artifact.turns.map((turn, index) => index === 0
        ? { ...turn, usage: { requests: 1, inputTokens: 9, outputTokens: 3, totalTokens: 12, cachedInputTokens: 2 } }
        : index === 1 ? { ...turn, usageUnreconciledReason: "max_turns_usage_unavailable" } : turn),
    });
    expect(result.observed.usage).toEqual({ status: "unreconciled", completed: { requests: 1, inputTokens: 9, outputTokens: 3, totalTokens: 12, cachedInputTokens: 2 }, reason: "max_turns_usage_unavailable" });
  });

  it("preserves an explicit terminal failure when a report refreshes", () => {
    const report: LiveEvaluationReport = {
      version: 4, mode: "live", phase: "smoke", state: "running", manifest: manifest(),
      summary: { processed: 0, customerMessagesProcessed: 0, failed: 0, repliesSafe: 0, quotes: 0, humanNeeded: 0, fakeCalendarCreates: 0 },
      scenarios: [], providerResponses: { started: 0, limit: liveEvaluationProviderResponseBudget, remaining: liveEvaluationProviderResponseBudget }, latency: { completedTurns: 0, p50Ms: null, p95Ms: null, withinTargets: null }, usage: { status: "unavailable", completed: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 }, reason: "no_completed_provider_runs" },
    };
    markLiveEvaluationReportFailed(report, new EvaluationDeadlineExceededError("live_suite_deadline_exceeded"));
    expect(report).toMatchObject({ state: "failed", terminalFailure: "live_suite_deadline_exceeded", summary: { failed: 1 } });
  });

  it("keeps reconciled usage available for a completed acceptance failure", () => {
    const report: LiveEvaluationReport = {
      version: 4, mode: "live", phase: "smoke", state: "running", manifest: manifest(),
      summary: { processed: 5, customerMessagesProcessed: 31, failed: 1, repliesSafe: 4, quotes: 2, humanNeeded: 1, fakeCalendarCreates: 1 },
      scenarios: [], providerResponses: { started: 31, limit: liveEvaluationProviderResponseBudget, remaining: liveEvaluationProviderResponseBudget - 31 }, latency: { completedTurns: 31, p50Ms: 10, p95Ms: 10, withinTargets: true },
      usage: { status: "available", completed: { requests: 31, inputTokens: 310, outputTokens: 62, totalTokens: 372, cachedInputTokens: 0 } },
    };
    markLiveEvaluationReportFailed(report, new Error("smoke_acceptance_failed"), true);
    expect(report).toMatchObject({ state: "failed", terminalFailure: "smoke_acceptance_failed", usage: { status: "available", completed: { requests: 31 } } });
  });
});
