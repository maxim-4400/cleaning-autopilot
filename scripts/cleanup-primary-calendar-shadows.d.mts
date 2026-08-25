export type PrimaryShadowCandidate = {
  primaryEventId: string;
  team: "team_a" | "team_b";
  originalEventId: string;
  iCalUID: string;
};

export type PrimaryShadowCleanupManifest = {
  version: 1;
  target: { calendarId: "primary" };
  teamCalendars: { teamA: string; teamB: string };
  window: { timeMin: string; timeMax: string };
  candidates: PrimaryShadowCandidate[];
};

export function parsePrimaryShadowCleanupCli(argv: string[]): { apply: boolean; manifestPath: string; manifestSha256?: string };
export function manifestSha256(contents: string): string;
export function parsePrimaryShadowCleanupManifest(value: unknown): PrimaryShadowCleanupManifest;
export function reconcilePrimaryShadowCopies(manifest: PrimaryShadowCleanupManifest, events: { primary: unknown[]; team_a: unknown[]; team_b: unknown[] }): { matches: Array<Pick<PrimaryShadowCandidate, "primaryEventId" | "team" | "originalEventId">>; mismatches: Array<{ primaryEventId: string; reason: string }> };
export function runPrimaryShadowCleanup(input: { argv?: string[]; env?: Record<string, string | undefined>; write?: (line: string) => void; readManifest?: (path: string, encoding: "utf8") => Promise<string>; composioFactory?: (environment: unknown) => unknown }): Promise<Record<string, unknown>>;
