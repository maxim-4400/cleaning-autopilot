import { ConsoleAdminAuthorizationError, assertConsoleAdminRequest } from "@/lib/admin/console-auth";
import { RuntimeConfigConflictError, RuntimeConfigValidationError, getDemoConsoleConfigStore } from "@/lib/runtime-config/demo-console-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await assertConsoleAdminRequest(request);
    return Response.json(await getDemoConsoleConfigStore().load());
  } catch (error) {
    return configErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    await assertConsoleAdminRequest(request);
    // Full-document replacement pre-dated independent Prompt/Pricing drafts.
    // Keep the route non-mutating rather than permitting an update without a
    // CAS revision; clients use PATCH per section instead.
    return Response.json({ error: "method_not_supported" }, { status: 405, headers: { allow: "GET, PATCH, DELETE" } });
  } catch (error) {
    return configErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await assertConsoleAdminRequest(request);
    const section = new URL(request.url).searchParams.get("section");
    const expectedRevision = request.headers.get("if-match") ?? "";
    if (section) return Response.json(await getDemoConsoleConfigStore().resetSection({ section, expectedRevision }));
    return Response.json(await getDemoConsoleConfigStore().resetToBaselineAtRevision(expectedRevision));
  } catch (error) {
    return configErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await assertConsoleAdminRequest(request);
    return Response.json(await getDemoConsoleConfigStore().saveSection(await request.json()));
  } catch (error) {
    return configErrorResponse(error);
  }
}

function configErrorResponse(error: unknown): Response {
  if (error instanceof ConsoleAdminAuthorizationError) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (error instanceof RuntimeConfigConflictError) return Response.json({ error: "configuration_conflict" }, { status: 409 });
  if (error instanceof RuntimeConfigValidationError || error instanceof SyntaxError) {
    return Response.json({ error: "invalid_configuration" }, { status: 400 });
  }
  return Response.json({ error: "configuration_unavailable" }, { status: 500 });
}
