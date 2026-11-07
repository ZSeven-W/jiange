/** Treat URLs in document content as untrusted. */
export function safeURL(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("#/doc/")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch { return undefined; }
}
