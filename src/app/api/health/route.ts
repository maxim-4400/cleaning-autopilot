export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ok",
    service: "cleaning-autopilot",
    environment: process.env.APP_ENV ?? "local",
  });
}
