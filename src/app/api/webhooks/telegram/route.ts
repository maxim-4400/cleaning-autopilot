import { timingSafeEqual } from "node:crypto";

import { IntegrationConfigurationError, getTelegramEnvironment } from "@/lib/env/server";
import { getStage2Dependencies } from "@/lib/stage2/dependencies";
import { processTelegramWebhook } from "@/lib/telegram/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let secret: string;
  try {
    secret = getTelegramEnvironment().TELEGRAM_WEBHOOK_SECRET;
  } catch (error) {
    return configurationErrorResponse(error);
  }

  const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!suppliedSecret || !secretsMatch(secret, suppliedSecret)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return Response.json({ ok: false, error: "invalid_update" }, { status: 400 });
  }

  try {
    const result = await processTelegramWebhook(payload as Record<string, unknown>, getStage2Dependencies());
    if (result.kind === "failed") {
      const status = result.failureCode === "invalid_update" ? 400 : 500;
      return Response.json({ ok: false, error: result.failureCode }, { status });
    }
    return Response.json({ ok: true, result: result.kind });
  } catch (error) {
    return configurationErrorResponse(error);
  }
}

function configurationErrorResponse(error: unknown): Response {
  if (error instanceof IntegrationConfigurationError) {
    console.error("Telegram webhook integration is not configured", {
      missingVariables: error.missingVariables,
    });
    return Response.json({ ok: false, error: "integration_not_configured" }, { status: 503 });
  }
  return Response.json({ ok: false, error: "webhook_unavailable" }, { status: 500 });
}

function secretsMatch(expected: string, supplied: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}
