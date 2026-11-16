/** Public links carry their share token in the fragment; never move it into a query. */
export function publicBlockKey(hash: string, token: string): string | null {
  const match = /^#\/p\/([A-Za-z0-9_-]+)(?:\?([^#]*))?$/.exec(hash);
  if (!match || match[1] !== token || !match[2]) return null;
  const values = new URLSearchParams(match[2]).getAll("block");
  if (values.length !== 1 || !/^\d{1,16}:\d{1,16}$/.test(values[0])) return null;
  const [client, clock] = values[0].split(":").map(Number);
  return Number.isSafeInteger(client) && Number.isSafeInteger(clock) ? values[0] : null;
}

export function publicBlockLink(href: string, token: string, block: string): string | null {
  const hashAt = href.indexOf("#");
  if (hashAt < 0 || !/^\d{1,16}:\d{1,16}$/.test(block)) return null;
  const [client, clock] = block.split(":").map(Number);
  if (!Number.isSafeInteger(client) || !Number.isSafeInteger(clock)) return null;
  const route = href.slice(hashAt);
  const match = /^#\/p\/([A-Za-z0-9_-]+)(?:\?[^#]*)?$/.exec(route);
  if (!match || match[1] !== token) return null;
  return `${href.slice(0, hashAt)}#/p/${token}?block=${encodeURIComponent(block)}`;
}
