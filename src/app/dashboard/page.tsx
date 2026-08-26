import { DashboardClient } from "@/components/demo-console/dashboard-client";
import { resolveMiroPresentation } from "@/lib/admin/miro-embed";

function safeCalendarEmbed(value: string | undefined) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "calendar.google.com" && url.pathname.includes("/calendar/embed") ? url.toString() : undefined; } catch { return undefined; }
}

export default function DashboardPage() {
  const miro = resolveMiroPresentation(
    process.env.MIRO_BOARD_URL ?? process.env.NEXT_PUBLIC_MIRO_BOARD_URL,
    process.env.MIRO_EMBED_URL ?? process.env.NEXT_PUBLIC_MIRO_EMBED_URL,
  );
  return <DashboardClient miroBoardUrl={miro.boardUrl} miroEmbedUrl={miro.embedUrl} teamCalendarEmbedUrls={{ teamA: safeCalendarEmbed(process.env.TEAM_A_CALENDAR_EMBED_URL ?? process.env.NEXT_PUBLIC_TEAM_A_CALENDAR_EMBED_URL), teamB: safeCalendarEmbed(process.env.TEAM_B_CALENDAR_EMBED_URL ?? process.env.NEXT_PUBLIC_TEAM_B_CALENDAR_EMBED_URL) }} />;
}
