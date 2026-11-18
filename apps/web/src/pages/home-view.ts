type HomeViewStorage = Pick<Storage, "getItem" | "setItem">;
export type HomeView = "list" | "grid";
export const homeViewKey = (userId: number) => `jiange:home-view:v1:${userId}`;
export function browserHomeViewStorage(): Storage | null { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } }
export function readHomeView(storage: HomeViewStorage | null, userId: number): HomeView {
  if (!Number.isSafeInteger(userId) || userId <= 0) return "list";
  try { return storage?.getItem(homeViewKey(userId)) === "grid" ? "grid" : "list"; } catch { return "list"; }
}
export function writeHomeView(storage: HomeViewStorage | null, userId: number, view: HomeView): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  try { storage?.setItem(homeViewKey(userId), view); } catch { /* Keep the current view usable without storage. */ }
}

export function matchesHomeTypeFilter(doc: { kind?: string; docType?: string }, selectedKind: string): boolean {
  if (selectedKind === "all") return true;
  const kind = doc.kind ?? "doc";
  if (selectedKind === "board") return kind === "doc" && doc.docType === "board";
  if (selectedKind === "doc") return kind === "doc" && doc.docType !== "board";
  return kind === selectedKind;
}
