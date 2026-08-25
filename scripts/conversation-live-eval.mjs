#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const confirmation = "I_UNDERSTAND_THIS_CALLS_OPENAI";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function parse(argv) {
  const live = argv.includes("--live");
  const names = ["--phase", "--confirm", "--manifest-sha256", "--scenario-count", "--max-tool-steps", "--model", "--reasoning-effort", "--max-output-tokens", "--max-suite-duration-ms", "--accepted-smoke-report", "--re-evaluate-report"];
  const values = Object.fromEntries(names.map((name) => [name, argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1)]));
  const allowed = new Set(["--live", ...names.map((name) => values[name] === undefined ? undefined : `${name}=${values[name]}`).filter(Boolean)]);
  const unknown = argv.filter((argument) => !allowed.has(argument));
  if (unknown.length > 0) throw new Error(`Unsupported arguments: ${unknown.join(" ")}`);
  return { live, values };
}

/** Marks a checkpoint terminal after an unexpected child exit without logging provider data. */
export async function finalizeUnfinishedCheckpoint(reportPath, reason) {
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    if (report?.mode !== "live" || report?.state !== "running") return false;
    const sanitizedReason = String(reason).replace(/\bsk-[A-Za-z0-9_-]+\b/gu, "[redacted-key]").slice(0, 240);
    report.state = "failed";
    report.terminalFailure = `child_process_${sanitizedReason}`;
    report.summary = { ...report.summary, failed: Math.max(Number(report.summary?.failed) || 0, 1) };
    const temporary = resolve(dirname(reportPath), `.${process.pid}.interrupted.tmp`);
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
    await rename(temporary, reportPath);
    return true;
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parse(argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Invalid live evaluation arguments");
    return;
  }

  if (options.live) {
    const required = ["--phase", "--confirm", "--manifest-sha256", "--scenario-count", "--max-tool-steps", "--model", "--reasoning-effort", "--max-output-tokens", "--max-suite-duration-ms"];
    const missing = required.filter((name) => !options.values[name]);
    if (missing.length > 0) fail(`Live evaluation requires ${missing.join(", ")}`);
    if (!["smoke", "remaining"].includes(options.values["--phase"])) fail("Live evaluation requires --phase=smoke or --phase=remaining");
    if (options.values["--phase"] === "remaining" && !options.values["--accepted-smoke-report"]) fail("Remaining evaluation requires --accepted-smoke-report for the explicitly accepted smoke checkpoint");
    if (options.values["--confirm"] !== confirmation) fail("Live evaluation requires the literal --confirm value documented in CONVERSATION_LIVE_EVALUATION.md");
    if (process.exitCode) return;
  }
  if (options.values["--re-evaluate-report"] && options.live) {
    fail("--re-evaluate-report is read-only and cannot be combined with --live");
    return;
  }

  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/u, "Z");
  const reportPath = resolve(process.cwd(), ".runtime", "conversation-live-evaluations", `${timestamp}.json`);
  const reevaluateReportPath = options.values["--re-evaluate-report"];
  const vitestEntrypoint = resolve(process.cwd(), "node_modules", "vitest", "vitest.mjs");
  process.stdout.write(reevaluateReportPath
    ? `Read-only conversation evaluation re-check: ${resolve(process.cwd(), reevaluateReportPath)}\n`
    : `Conversation evaluation report: ${reportPath}\n`);
  const child = spawn(process.execPath, [
    "--env-file-if-exists=.env.local",
    vitestEntrypoint,
    "run",
    "--config",
    "vitest.live-evaluation.config.mts",
  ], {
    stdio: "inherit",
    env: {
      ...process.env,
      CONVERSATION_LIVE_EVAL_MODE: options.live ? "live" : "dry_run",
      CONVERSATION_LIVE_EVAL_PHASE: options.values["--phase"] ?? "",
      CONVERSATION_LIVE_EVAL_CONFIRMATION: options.values["--confirm"] ?? "",
      CONVERSATION_LIVE_EVAL_MANIFEST_SHA256: options.values["--manifest-sha256"] ?? "",
      CONVERSATION_LIVE_EVAL_SCENARIO_COUNT: options.values["--scenario-count"] ?? "",
      CONVERSATION_LIVE_EVAL_MAX_TOOL_STEPS: options.values["--max-tool-steps"] ?? "",
      CONVERSATION_LIVE_EVAL_MODEL: options.values["--model"] ?? "",
      CONVERSATION_LIVE_EVAL_REASONING_EFFORT: options.values["--reasoning-effort"] ?? "",
      CONVERSATION_LIVE_EVAL_MAX_OUTPUT_TOKENS: options.values["--max-output-tokens"] ?? "",
      CONVERSATION_LIVE_EVAL_MAX_SUITE_DURATION_MS: options.values["--max-suite-duration-ms"] ?? "",
      CONVERSATION_LIVE_EVAL_REPORT_PATH: reportPath,
      CONVERSATION_LIVE_EVAL_ACCEPTED_SMOKE_REPORT_PATH: options.values["--accepted-smoke-report"] ?? "",
      CONVERSATION_LIVE_EVAL_REEVALUATE_REPORT_PATH: reevaluateReportPath ? resolve(process.cwd(), reevaluateReportPath) : "",
    },
  });
  let interruptedBy;
  const relayInterruption = (signal) => {
    interruptedBy = signal;
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", relayInterruption);
  process.once("SIGTERM", relayInterruption);
  const outcome = await new Promise((resolveOutcome) => {
    child.once("error", (error) => resolveOutcome({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolveOutcome({ code, signal, error: undefined }));
  });
  process.removeListener("SIGINT", relayInterruption);
  process.removeListener("SIGTERM", relayInterruption);
  const childFailure = outcome.error
    ? "spawn_error"
    : interruptedBy
      ? `signal_${interruptedBy}`
      : outcome.signal
        ? `signal_${outcome.signal}`
        : outcome.code === 0
          ? undefined
          : `exit_code_${outcome.code ?? "unknown"}`;
  const finalized = options.live ? await finalizeUnfinishedCheckpoint(reportPath, childFailure ?? "exit_code_0_before_terminal_checkpoint") : false;
  if (childFailure || finalized) {
    const reason = childFailure ?? "exit_code_0_before_terminal_checkpoint";
    process.stderr.write(`Conversation evaluation child ended unexpectedly (${reason})${finalized ? "; marked its running checkpoint as failed." : "; no running checkpoint was available to finalize."}\n`);
    process.exitCode = typeof outcome.code === "number" && outcome.code > 0 ? outcome.code : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
