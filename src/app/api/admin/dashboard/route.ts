import { ConsoleAdminAuthorizationError, assertConsoleAdminRequest } from "@/lib/admin/console-auth";
import { getDemoConsoleReadModel } from "@/lib/admin/demo-console-read-model";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await assertConsoleAdminRequest(request);
    return Response.json(await getDemoConsoleReadModel(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ConsoleAdminAuthorizationError) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ error: "dashboard_unavailable" }, { status: 503 });
  }
}
