import "server-only";

import type { TrelloReconcileCounts } from "@/lib/trello/recovery-service";

const runnerIntervalMilliseconds = 60_000;
const recoveryBatchSize = 25;
const runnerStateKey = Symbol.for("cleaning-autopilot.trello-recovery-runner");

export type RecoveryRunnerEnvironment = {
  APP_ENV?: string;
  INTEGRATION_MODE?: string;
  TRELLO_RECOVERY_RUNNER_ENABLED?: string;
};

type TimerHandle = ReturnType<typeof setInterval>;

type RunnerTimer = {
  setInterval(callback: () => void, delayMilliseconds: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
};

type RecoveryRunnerLogger = Pick<Console, "info" | "error">;

export type TrelloRecoveryRunnerOptions = {
  environment: RecoveryRunnerEnvironment;
  reconcileDueJobs(limit: number): Promise<TrelloReconcileCounts>;
  timer?: RunnerTimer;
  logger?: RecoveryRunnerLogger;
};

export type TrelloRecoveryRunner = {
  readonly started: boolean;
  dispose(): void;
};

type RecoveryRunnerState = {
  timer: TimerHandle;
  running: boolean;
  runner: TrelloRecoveryRunner;
};

type RunnerGlobal = typeof globalThis & {
  [runnerStateKey]?: RecoveryRunnerState;
};

const defaultTimer: RunnerTimer = { setInterval, clearInterval };

/**
 * The worker is opt-in and intentionally impossible to start in local, preview,
 * or fake environments. This preserves fake-test isolation and prevents a second
 * process from unexpectedly writing a real Trello board.
 */
export function isTrelloRecoveryRunnerEnabled(environment: RecoveryRunnerEnvironment): boolean {
  return environment.APP_ENV === "production"
    && environment.INTEGRATION_MODE === "real"
    && environment.TRELLO_RECOVERY_RUNNER_ENABLED === "true";
}

/**
 * Starts one best-effort recovery timer per Node.js process. Next.js
 * instrumentation has no dispose lifecycle, so the returned disposer is used by
 * controlled teardown and tests; process exit clears the remaining timer.
 */
export function startTrelloRecoveryRunner(options: TrelloRecoveryRunnerOptions): TrelloRecoveryRunner {
  if (!isTrelloRecoveryRunnerEnabled(options.environment)) return disabledRunner;

  const globalRunner = globalThis as RunnerGlobal;
  const existing = globalRunner[runnerStateKey];
  if (existing) return existing.runner;

  const timer = options.timer ?? defaultTimer;
  const logger = options.logger ?? console;
  const state: RecoveryRunnerState = {
    timer: undefined as unknown as TimerHandle,
    running: false,
    runner: undefined as unknown as TrelloRecoveryRunner,
  };

  const run = async (): Promise<void> => {
    if (state.running) return;
    state.running = true;
    try {
      const counts = await options.reconcileDueJobs(recoveryBatchSize);
      logger.info("Trello recovery reconciliation completed", aggregateCounts(counts));
    } catch {
      // Provider errors can contain payloads, ids, and authentication context.
      // Keep the production log intentionally opaque and free of customer data.
      logger.error("Trello recovery reconciliation failed", { error: "unexpected" });
    } finally {
      state.running = false;
    }
  };

  const dispose = (): void => {
    if (globalRunner[runnerStateKey] !== state) return;
    timer.clearInterval(state.timer);
    delete globalRunner[runnerStateKey];
  };
  const runner: TrelloRecoveryRunner = { started: true, dispose };
  state.runner = runner;
  state.timer = timer.setInterval(() => {
    void run();
  }, runnerIntervalMilliseconds);
  // A running web server keeps the process alive, so unref does not change
  // production scheduling. It does let Next.js build/test processes exit
  // instead of waiting for this best-effort timer's first tick.
  (state.timer as unknown as { unref?: () => void }).unref?.();
  globalRunner[runnerStateKey] = state;
  return runner;
}

export function stopTrelloRecoveryRunner(): void {
  const globalRunner = globalThis as RunnerGlobal;
  globalRunner[runnerStateKey]?.runner.dispose();
}

function aggregateCounts(counts: TrelloReconcileCounts): TrelloReconcileCounts {
  return {
    claimed: safeCount(counts.claimed),
    completed: safeCount(counts.completed),
    retried: safeCount(counts.retried),
    manual: safeCount(counts.manual),
  };
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

const disabledRunner: TrelloRecoveryRunner = { started: false, dispose() {} };
