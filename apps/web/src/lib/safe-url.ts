/** Internal resource references include docs, sheets, bases, slides, surveys, and canonical share/public links. */
export function isDocumentReferenceURL(url?: string): url is string {
  return !!url && (
    url.startsWith("#/doc/") ||
    /^#\/(?:sheet|base|slides|survey)\/[1-9]\d*$/.test(url) ||
    /^#\/(s|p)\/[A-Za-z0-9_-]{1,256}$/.test(url)
  );
}

/** Explicit text hyperlinks remain ordinary links, even to an internal doc. */
export function isDocumentReferenceMarks(marks: { link?: string; linkKind?: string }): boolean {
  return marks.linkKind !== "text" && isDocumentReferenceURL(marks.link);
}

/** Treat URLs in document content as untrusted. */
export function safeURL(url?: string): string | undefined {
  if (!url) return undefined;
  if (isDocumentReferenceURL(url)) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch { return undefined; }
}

/** Copy internal fragment links as usable absolute addresses outside this page. */
export function copyableURL(url: string, base: string): string | undefined {
  const safe = safeURL(url);
  if (!safe) return undefined;
  try { return isDocumentReferenceURL(safe) ? new URL(safe, base).href : safe; }
  catch { return undefined; }
}
