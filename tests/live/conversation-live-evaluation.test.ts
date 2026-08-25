import { describe, expect, it } from "vitest";

import { buildLiveEvaluationManifest, reEvaluateStoredLiveReportPath, runLiveConversationEvaluation } from "../support/live-conversation-evaluation";

const live = process.env.CONVERSATION_LIVE_EVAL_MODE === "live";
const reEvaluateReportPath = process.env.CONVERSATION_LIVE_EVAL_REEVALUATE_REPORT_PATH;

describe("opt-in live conversation evaluation", () => {
  it("prints a sanitized immutable manifest in dry-run or executes only after the full gate", async () => {
    if (reEvaluateReportPath) {
      const reEvaluation = await reEvaluateStoredLiveReportPath(reEvaluateReportPath);
      expect(reEvaluation.scenarios.length).toBeGreaterThan(0);
      process.stdout.write(`${JSON.stringify({ mode: "read_only_re_evaluation", ...reEvaluation })}\n`);
      return;
    }
    const manifest = await buildLiveEvaluationManifest();
    const report = await runLiveConversationEvaluation({
      live,
      phase: process.env.CONVERSATION_LIVE_EVAL_PHASE === "smoke" || process.env.CONVERSATION_LIVE_EVAL_PHASE === "remaining"
        ? process.env.CONVERSATION_LIVE_EVAL_PHASE
        : undefined,
      confirmation: process.env.CONVERSATION_LIVE_EVAL_CONFIRMATION,
      manifestSha256: process.env.CONVERSATION_LIVE_EVAL_MANIFEST_SHA256,
      scenarioCount: Number(process.env.CONVERSATION_LIVE_EVAL_SCENARIO_COUNT),
      maxToolSteps: Number(process.env.CONVERSATION_LIVE_EVAL_MAX_TOOL_STEPS),
      model: process.env.CONVERSATION_LIVE_EVAL_MODEL,
      reasoningEffort: process.env.CONVERSATION_LIVE_EVAL_REASONING_EFFORT,
      maxOutputTokens: Number(process.env.CONVERSATION_LIVE_EVAL_MAX_OUTPUT_TOKENS),
      maxSuiteDurationMs: Number(process.env.CONVERSATION_LIVE_EVAL_MAX_SUITE_DURATION_MS),
      reportPath: live ? process.env.CONVERSATION_LIVE_EVAL_REPORT_PATH : undefined,
      acceptedSmokeReportPath: live ? process.env.CONVERSATION_LIVE_EVAL_ACCEPTED_SMOKE_REPORT_PATH : undefined,
    }, undefined, manifest);

    expect(report.manifest).toEqual(manifest);
    expect(report.mode).toBe(live ? "live" : "dry_run");
    process.stdout.write(`${JSON.stringify({ mode: report.mode, state: report.state, manifest: report.manifest, summary: report.summary, reportPath: live ? process.env.CONVERSATION_LIVE_EVAL_REPORT_PATH : undefined })}\n`);
  });
});
