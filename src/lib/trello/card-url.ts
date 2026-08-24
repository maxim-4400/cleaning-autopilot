const canonicalTrelloCardPath = /^\/c\/([A-Za-z0-9_-]{1,64})(?:\/[A-Za-z0-9_-]{1,256})?$/;

/** Accept only provider-supplied public card URLs and discard an optional UI slug. */
export function canonicalTrelloCardUrl(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || (url.hostname !== "trello.com" && url.hostname !== "www.trello.com") || url.username || url.password || url.search || url.hash) return undefined;
    const match = canonicalTrelloCardPath.exec(url.pathname);
    return match ? `https://trello.com/c/${match[1]}` : undefined;
  } catch { return undefined; }
}
