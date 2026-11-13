// A view preference, scoped to the local account and document; it is not document content.
export type DocWidth = "default" | "wider" | "full";
const key = (user: number, doc: number) => `jiange:doc-wide:${user}:${doc}`;

export function readDocWidth(user: number, doc: number): DocWidth {
  try {
    const value = typeof localStorage !== "undefined" ? localStorage.getItem(key(user, doc)) : null;
    // "1" is the previous version's full-width setting.
    return value === "1" || value === "full" ? "full" : value === "wider" ? "wider" : "default";
  } catch { return "default"; }
}

export function writeDocWidth(user: number, doc: number, width: DocWidth) {
  try {
    if (width === "default") localStorage.removeItem(key(user, doc));
    else localStorage.setItem(key(user, doc), width === "full" ? "1" : width);
  } catch { /* The preference remains active for this session. */ }
}

export const docWidthClass = (width: DocWidth) => width === "full" ? "max-w-none" : width === "wider" ? "max-w-[1200px]" : "max-w-[960px]";
