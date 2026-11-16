/** Internal document references include canonical share and public links. */
export function isDocumentReferenceURL(url?: string): url is string {
  return !!url && (url.startsWith("#/doc/") || /^#\/(s|p)\/[A-Za-z0-9_-]{1,256}$/.test(url));
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
