import { DashboardClient } from "@/components/demo-console/dashboard-client";

function canonicalMiroBoardUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const match = /^\/app\/board\/([A-Za-z0-9_=-]+)\/?$/.exec(url.pathname);
    const shareLinkId = url.searchParams.get("share_link_id");
    const embed = url.searchParams.get("embed");
    if (url.protocol !== "https:" || url.hostname !== "miro.com" || !match || url.username || url.password || url.hash || [...url.searchParams.keys()].some((key) => key !== "share_link_id" && key !== "embed") || (shareLinkId !== null && !/^\d{1,32}$/.test(shareLinkId)) || (embed !== null && embed !== "1" && embed !== "true")) return undefined;
    const board = `https://miro.com/app/board/${match[1]}/`;
    return shareLinkId ? `${board}?share_link_id=${shareLinkId}` : board;
  } catch { return undefined; }
}
function safeCalendarEmbed(value: string | undefined) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "calendar.google.com" && url.pathname.includes("/calendar/embed") ? url.toString() : undefined; } catch { return undefined; }
}
function safeMiroEmbed(value: string | undefined) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "miro.com" && /^\/app\/board\/[A-Za-z0-9_=-]+\/?$/.test(url.pathname) && (url.searchParams.get("embed") === "1" || url.searchParams.get("embed") === "true") ? url.toString() : undefined; } catch { return undefined; }
}
function miroEmbedUrl(board: string | undefined) {
  if (!board) return undefined;
  const url = new URL(board);
  url.searchParams.set("embed", "1");
  return url.toString();
}

export default function DashboardPage() {
  const configuredEmbed = safeMiroEmbed(process.env.MIRO_EMBED_URL ?? process.env.NEXT_PUBLIC_MIRO_EMBED_URL);
  const board = canonicalMiroBoardUrl(process.env.MIRO_BOARD_URL ?? process.env.NEXT_PUBLIC_MIRO_BOARD_URL) ?? canonicalMiroBoardUrl(configuredEmbed);
  const embed = configuredEmbed ?? miroEmbedUrl(board);
  return <DashboardClient miroBoardUrl={board} miroEmbedUrl={embed} teamCalendarEmbedUrls={{ teamA: safeCalendarEmbed(process.env.TEAM_A_CALENDAR_EMBED_URL ?? process.env.NEXT_PUBLIC_TEAM_A_CALENDAR_EMBED_URL), teamB: safeCalendarEmbed(process.env.TEAM_B_CALENDAR_EMBED_URL ?? process.env.NEXT_PUBLIC_TEAM_B_CALENDAR_EMBED_URL) }} />;
}
