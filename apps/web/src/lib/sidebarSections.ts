type SectionStorage = Pick<Storage, "getItem" | "setItem">;
export type SidebarSection = "pinned" | "documents";

export const sidebarSectionKey = (userId: number, section: SidebarSection) => `jiange:sidebar-section:v1:${userId}:${section}`;
export const decodeSidebarSection = (value: string | null) => value !== "collapsed";

export function readSidebarSection(storage: SectionStorage | null, userId: number, section: SidebarSection): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) return true;
  try { return decodeSidebarSection(storage?.getItem(sidebarSectionKey(userId, section)) ?? null); }
  catch { return true; }
}

export function writeSidebarSection(storage: SectionStorage | null, userId: number, section: SidebarSection, expanded: boolean): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  try { storage?.setItem(sidebarSectionKey(userId, section), expanded ? "expanded" : "collapsed"); }
  catch { /* Keep the current tab usable when storage is unavailable. */ }
}
