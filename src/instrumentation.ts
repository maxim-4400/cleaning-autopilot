export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startTrelloRecoveryRunner } = await import("@/lib/trello/recovery-runner");
  let recovery: { reconcileDueJobs(limit: number): Promise<{ claimed: number; completed: number; retried: number; manual: number }> } | undefined;
  startTrelloRecoveryRunner({
    environment: {
      APP_ENV: process.env.APP_ENV,
      INTEGRATION_MODE: process.env.INTEGRATION_MODE,
      TRELLO_RECOVERY_RUNNER_ENABLED: process.env.TRELLO_RECOVERY_RUNNER_ENABLED,
    },
    reconcileDueJobs: async (limit) => {
      if (!recovery) {
        const { getStage2Dependencies } = await import("@/lib/stage2/dependencies");
        recovery = getStage2Dependencies().trelloRecovery;
      }
      if (!recovery) throw new Error("Trello recovery is not configured");
      return recovery.reconcileDueJobs(limit);
    },
  });
}
