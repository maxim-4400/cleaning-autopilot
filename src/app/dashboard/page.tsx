import { DashboardClient } from "@/components/demo-console/dashboard-client";

function canonicalMiroBoardUrl(value: string | undefined) {
  if (!value) return undefined;
  try { const url = new URL(value); const match = /^\/app\/board\/([A-Za-z0-9_=-]+)\/?$/.exec(url.pathname); return url.protocol === "https:" && url.hostname === "miro.com" && match && !url.username && !url.password ? `https://miro.com/app/board/${match[1]}` : undefined; } catch { return undefined; }
}
function safeCalendarEmbed(value: string | undefined) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "calendar.google.com" && url.pathname.includes("/calendar/embed") ? url.toString() : undefined; } catch { return undefined; }
}

export default function DashboardPage() {
  const board = canonicalMiroBoardUrl(process.env.MIRO_BOARD_URL ?? process.env.NEXT_PUBLIC_MIRO_BOARD_URL);
  const embed = board ? `${board}/?embed=1` : undefined;
  return <DashboardClient miroBoardUrl={board} miroEmbedUrl={embed} teamCalendarEmbedUrls={{ teamA: safeCalendarEmbed(process.env.TEAM_A_CALENDAR_EMBED_URL), teamB: safeCalendarEmbed(process.env.TEAM_B_CALENDAR_EMBED_URL) }} />;
}
