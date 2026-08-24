import { createHash, timingSafeEqual } from "node:crypto";

import { getInternalReconcileEnvironment, IntegrationConfigurationError } from "@/lib/env/server";
import { getStage2Dependencies } from "@/lib/stage2/dependencies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maximumBatchSize = 25;

export async function POST(request: Request): Promise<Response> {
  let secret: string;
  try {
    secret = getInternalReconcileEnvironment().INTERNAL_RECONCILE_SECRET;
  } catch (error) {
    return error instanceof IntegrationConfigurationError
      ? Response.json({ ok: false, error: "integration_not_configured" }, { status: 503 })
      : Response.json({ ok: false, error: "reconcile_unavailable" }, { status: 500 });
  }
  const supplied = bearerToken(request.headers.get("authorization"));
  if (!supplied || !secretsMatch(secret, supplied)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const batch = parseBatchSize(new URL(request.url).searchParams.get("limit"));
  if (batch === null) return Response.json({ ok: false, error: "invalid_limit" }, { status: 400 });
  try {
    const recovery = getStage2Dependencies().trelloRecovery;
    if (!recovery) return Response.json({ ok: false, error: "integration_not_configured" }, { status: 503 });
    const counts = await recovery.reconcileDueJobs(batch);
    return Response.json({ ok: true, ...counts });
  } catch {
    // No lead ids, provider response, or authentication material leaves this endpoint.
    return Response.json({ ok: false, error: "reconcile_unavailable" }, { status: 500 });
  }
}

function bearerToken(value: string | null): string | undefined {
  if (value && value.length > 1024) return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(value ?? "");
  return match?.[1];
}

function parseBatchSize(value: string | null): number | null {
  if (value === null) return 10;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximumBatchSize ? parsed : null;
}

function secretsMatch(expected: string, supplied: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}
