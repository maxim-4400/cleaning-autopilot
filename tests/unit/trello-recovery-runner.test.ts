import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isTrelloRecoveryRunnerEnabled,
  startTrelloRecoveryRunner,
  stopTrelloRecoveryRunner,
  type TrelloRecoveryRunnerOptions,
} from "@/lib/trello/recovery-runner";
import type { TrelloReconcileCounts } from "@/lib/trello/recovery-service";

type Tick = () => void;
type TimerHandle = ReturnType<typeof setInterval>;

function makeTimer(): { timer: NonNullable<TrelloRecoveryRunnerOptions["timer"]>; tick(): void; clearInterval: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> } {
  let callback: Tick | undefined;
  const clearInterval = vi.fn();
  const unref = vi.fn();
  return {
    timer: {
      setInterval: vi.fn((next: Tick) => {
        callback = next;
        return { unref } as unknown as TimerHandle;
      }),
      clearInterval,
    },
    tick: () => callback?.(),
    clearInterval,
    unref,
  };
}

function productionEnvironment(): TrelloRecoveryRunnerOptions["environment"] {
  return { APP_ENV: "production", INTEGRATION_MODE: "real", TRELLO_RECOVERY_RUNNER_ENABLED: "true" };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  stopTrelloRecoveryRunner();
});

describe("Trello recovery runner", () => {
  it("is fail-closed unless production, real integrations, and the explicit flag are all present", () => {
    expect(isTrelloRecoveryRunnerEnabled(productionEnvironment())).toBe(true);
    expect(isTrelloRecoveryRunnerEnabled({ ...productionEnvironment(), APP_ENV: "preview" })).toBe(false);
    expect(isTrelloRecoveryRunnerEnabled({ ...productionEnvironment(), INTEGRATION_MODE: "fake" })).toBe(false);
    expect(isTrelloRecoveryRunnerEnabled({ ...productionEnvironment(), TRELLO_RECOVERY_RUNNER_ENABLED: "1" })).toBe(false);

    const clock = makeTimer();
    const disabled = startTrelloRecoveryRunner({
      environment: { ...productionEnvironment(), APP_ENV: "preview" },
      reconcileDueJobs: vi.fn().mockResolvedValue({ claimed: 0, completed: 0, retried: 0, manual: 0 }),
      timer: clock.timer,
    });
    expect(disabled.started).toBe(false);
    expect(clock.timer.setInterval).not.toHaveBeenCalled();
  });

  it("creates one 60-second timer per process and logs an empty batch as aggregate counts", async () => {
    const clock = makeTimer();
    const reconcileDueJobs = vi.fn().mockResolvedValue({ claimed: 0, completed: 0, retried: 0, manual: 0 });
    const logger = { info: vi.fn(), error: vi.fn() };

    const first = startTrelloRecoveryRunner({ environment: productionEnvironment(), reconcileDueJobs, timer: clock.timer, logger });
    const second = startTrelloRecoveryRunner({ environment: productionEnvironment(), reconcileDueJobs, timer: clock.timer, logger });
    clock.tick();
    await settle();

    expect(first.started).toBe(true);
    expect(second).toBe(first);
    expect(clock.timer.setInterval).toHaveBeenCalledTimes(1);
    expect(clock.timer.setInterval).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(clock.unref).toHaveBeenCalledTimes(1);
    expect(reconcileDueJobs).toHaveBeenCalledWith(25);
    expect(logger.info).toHaveBeenCalledWith("Trello recovery reconciliation completed", { claimed: 0, completed: 0, retried: 0, manual: 0 });
    first.dispose();
    expect(clock.clearInterval).toHaveBeenCalledTimes(1);
  });

  it("skips an overlapping tick until the previous reconciliation settles", async () => {
    const clock = makeTimer();
    let resolveRun: ((value: TrelloReconcileCounts) => void) | undefined;
    const reconcileDueJobs = vi.fn<(limit: number) => Promise<TrelloReconcileCounts>>(
      () => new Promise<TrelloReconcileCounts>((resolve) => { resolveRun = resolve; }),
    );
    const runner = startTrelloRecoveryRunner({ environment: productionEnvironment(), reconcileDueJobs, timer: clock.timer, logger: { info: vi.fn(), error: vi.fn() } });

    clock.tick();
    await settle();
    clock.tick();
    await settle();
    expect(reconcileDueJobs).toHaveBeenCalledTimes(1);

    resolveRun?.({ claimed: 1, completed: 1, retried: 0, manual: 0 });
    await settle();
    clock.tick();
    await settle();
    expect(reconcileDueJobs).toHaveBeenCalledTimes(2);
    runner.dispose();
  });

  it("catches an unexpected run error and continues with the next scheduled batch", async () => {
    const clock = makeTimer();
    const reconcileDueJobs = vi.fn()
      .mockRejectedValueOnce(new Error("provider response must not enter logs"))
      .mockResolvedValueOnce({ claimed: 2, completed: 1, retried: 1, manual: 0 });
    const logger = { info: vi.fn(), error: vi.fn() };
    startTrelloRecoveryRunner({ environment: productionEnvironment(), reconcileDueJobs, timer: clock.timer, logger });

    clock.tick();
    await settle();
    clock.tick();
    await settle();

    expect(reconcileDueJobs).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith("Trello recovery reconciliation failed", { error: "unexpected" });
    expect(logger.info).toHaveBeenCalledWith("Trello recovery reconciliation completed", { claimed: 2, completed: 1, retried: 1, manual: 0 });
  });
});
