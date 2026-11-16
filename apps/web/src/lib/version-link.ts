export function validVersionEntryId(id: string): boolean {
  const match = /^[ns]:([1-9]\d{0,15})$/.exec(id);
  return !!match && Number.isSafeInteger(Number(match[1]));
}

// undefined means no version was requested; null means a malformed link.
export function versionFromHash(hash: string): string | null | undefined {
  const index = hash.indexOf("?");
  if (index < 0) return undefined;
  const versions = new URLSearchParams(hash.slice(index + 1)).getAll("version");
  if (!versions.length) return undefined;
  return versions.length === 1 && validVersionEntryId(versions[0]) ? versions[0] : null;
}

export function savedVersionLink(href: string, docId: number, entryId: string): string | null {
  if (!Number.isSafeInteger(docId) || docId <= 0 || !validVersionEntryId(entryId)) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname}#/doc/${docId}?version=${encodeURIComponent(entryId)}`;
  } catch { return null; }
}

export function withoutVersionHash(hash: string): string {
  const index = hash.indexOf("?");
  if (index < 0) return hash;
  const params = new URLSearchParams(hash.slice(index + 1));
  params.delete("version");
  const rest = params.toString();
  return hash.slice(0, index) + (rest ? `?${rest}` : "");
}
