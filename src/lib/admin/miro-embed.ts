/**
 * Miro's normal board URL is a navigation URL, not an iframe contract. Keep
 * the two concerns separate: the direct link is a minimal canonical board
 * URL, while an iframe may only receive Miro's documented live-embed shape.
 */
const boardPath = /^\/app\/board\/([A-Za-z0-9_=-]+)\/?$/;
const liveEmbedPath = /^\/app\/live-embed\/([A-Za-z0-9_=-]+)\/?$/;
const viewport = /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,(?:0|[1-9]\d*)(?:\.\d+)?,(?:0|[1-9]\d*)(?:\.\d+)?$/;

type ParsedMiroUrl = { url: URL; boardId: string };

function parseUrl(value: string | undefined, expression: RegExp): ParsedMiroUrl | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const match = expression.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "miro.com" || !match || url.username || url.password || url.hash) return undefined;
    return { url, boardId: match[1]! };
  } catch {
    return undefined;
  }
}

/**
 * Accept a board URL only as a source of its public board identifier.  The
 * validated share id is kept for direct anonymous navigation: stripping it
 * can silently turn a public view link into a sign-in wall.  The value is
 * never used in the iframe URL, whose stricter live-embed allowlist remains
 * intentionally separate.
 */
export function canonicalMiroBoardUrl(value: string | undefined): string | undefined {
  const parsed = parseUrl(value, boardPath);
  if (!parsed) return undefined;
  const entries = [...parsed.url.searchParams.entries()];
  if (entries.length > 1 || (entries.length === 1 && entries[0]?.[0] !== "share_link_id")) return undefined;
  const shareLinkId = parsed.url.searchParams.get("share_link_id");
  if (shareLinkId !== null && !/^\d{6,32}$/.test(shareLinkId)) return undefined;
  const normalized = new URL(`https://miro.com/app/board/${parsed.boardId}/`);
  if (shareLinkId !== null) normalized.searchParams.set("share_link_id", shareLinkId);
  return normalized.toString();
}

/** Return an ID only from the same validated board-URL parser used for links. */
export function miroBoardId(value: string | undefined): string | undefined {
  return parseUrl(value, boardPath)?.boardId;
}

/** Resolve direct navigation and iframe sources together, without regex parsing. */
export function resolveMiroPresentation(boardValue: string | undefined, embedValue: string | undefined): {
  boardUrl?: string;
  embedUrl?: string;
} {
  const boardUrl = canonicalMiroBoardUrl(boardValue);
  const boardId = miroBoardId(boardUrl);
  const embedUrl = safeMiroLiveEmbedUrl(embedValue, boardId) ?? defaultMiroLiveEmbedUrl(boardUrl);
  return { ...(boardUrl ? { boardUrl } : {}), ...(embedUrl ? { embedUrl } : {}) };
}

/**
 * Validate a configured Miro live embed for a specific board. This is strict
 * by design: provider access tokens, arbitrary URL flags and a different
 * board must never cross into an iframe source.
 */
export function safeMiroLiveEmbedUrl(value: string | undefined, boardId: string | undefined): string | undefined {
  if (!boardId) return undefined;
  const parsed = parseUrl(value, liveEmbedPath);
  if (!parsed || parsed.boardId !== boardId) return undefined;

  const entries = [...parsed.url.searchParams.entries()];
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length) return undefined;
  const accepted = new Set(["autoplay", "embedMode", "moveToWidget", "moveToViewport"]);
  if (keys.some((key) => !accepted.has(key))) return undefined;
  if (parsed.url.searchParams.get("embedMode") !== "view_only_without_ui") return undefined;
  const autoplay = parsed.url.searchParams.get("autoplay");
  if (autoplay !== null && autoplay !== "true" && autoplay !== "false") return undefined;
  const widget = parsed.url.searchParams.get("moveToWidget");
  const moveToViewport = parsed.url.searchParams.get("moveToViewport");
  if (widget !== null && moveToViewport !== null) return undefined;
  if (widget !== null && !/^\d+$/.test(widget)) return undefined;
  if (moveToViewport !== null && !isValidViewport(moveToViewport)) return undefined;

  const normalized = new URL(`https://miro.com/app/live-embed/${boardId}/`);
  normalized.searchParams.set("embedMode", "view_only_without_ui");
  if (autoplay !== null) normalized.searchParams.set("autoplay", autoplay);
  if (widget !== null) normalized.searchParams.set("moveToWidget", widget);
  if (moveToViewport !== null) normalized.searchParams.set("moveToViewport", moveToViewport);
  return normalized.toString();
}

function isValidViewport(value: string): boolean {
  if (!viewport.test(value)) return false;
  const [, , width, height] = value.split(",").map(Number);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

/** Minimal provider-supported fallback when no positioned live embed is set. */
export function defaultMiroLiveEmbedUrl(boardUrl: string | undefined): string | undefined {
  const parsed = parseUrl(boardUrl, boardPath);
  if (!parsed) return undefined;
  return `https://miro.com/app/live-embed/${parsed.boardId}/?embedMode=view_only_without_ui&autoplay=true`;
}
