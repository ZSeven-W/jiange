type SidebarStorage = Pick<Storage, "getItem" | "setItem">;

export const sidebarPreferenceKey = (userId: number) => `jiange:document-sidebar:v1:${userId}`;
export const decodeSidebarPreference = (value: string | null): boolean => value !== "collapsed";

export function readSidebarPreference(storage: SidebarStorage | null, userId: number): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) return true;
  try { return decodeSidebarPreference(storage?.getItem(sidebarPreferenceKey(userId)) ?? null); }
  catch { return true; }
}

export function writeSidebarPreference(storage: SidebarStorage | null, userId: number, expanded: boolean): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  try { storage?.setItem(sidebarPreferenceKey(userId), expanded ? "expanded" : "collapsed"); }
  catch { /* The current tab remains usable when storage is unavailable. */ }
}

export function browserSidebarStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}
