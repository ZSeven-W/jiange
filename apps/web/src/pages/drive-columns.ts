export type DriveColumn = "owner" | "updated" | "created";
export type DriveColumnPreferences = { order: DriveColumn[]; visible: Record<DriveColumn, boolean> };

export function defaultDriveColumns(): DriveColumnPreferences {
  return { order: ["owner", "updated", "created"], visible: { owner: false, updated: true, created: true } };
}

/** Ignore corrupt or obsolete local settings instead of hiding columns unexpectedly. */
export function readDriveColumns(storage: Pick<Storage, "getItem"> | undefined, userId: number): DriveColumnPreferences {
  try {
    const current = storage?.getItem(`jiange:drive-columns:v2:${userId}`);
    const raw = current ?? storage?.getItem(`jiange:drive-columns:v1:${userId}`);
    if (!raw) return defaultDriveColumns();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return defaultDriveColumns();
    const prefs = value as Partial<DriveColumnPreferences>;
    if (!Array.isArray(prefs.order) || new Set(prefs.order).size !== prefs.order.length || !prefs.order.includes("updated") || !prefs.order.includes("created") || typeof prefs.visible?.updated !== "boolean" || typeof prefs.visible?.created !== "boolean") return defaultDriveColumns();
    if (current == null && prefs.order.length === 2) return { order: ["owner", ...prefs.order], visible: { owner: false, updated: prefs.visible.updated, created: prefs.visible.created } };
    if (prefs.order.length !== 3 || !prefs.order.includes("owner") || typeof prefs.visible?.owner !== "boolean") return defaultDriveColumns();
    return { order: [...prefs.order], visible: { owner: prefs.visible.owner, updated: prefs.visible.updated, created: prefs.visible.created } };
  } catch { return defaultDriveColumns(); }
}

export function writeDriveColumns(storage: Pick<Storage, "setItem"> | undefined, userId: number, prefs: DriveColumnPreferences): boolean {
  try { if (!storage) return false; storage.setItem(`jiange:drive-columns:v2:${userId}`, JSON.stringify(prefs)); return true; }
  catch { return false; }
}

export function moveDriveColumn(prefs: DriveColumnPreferences, from: DriveColumn, to: DriveColumn): DriveColumnPreferences {
  if (from === to) return prefs;
  const order = [...prefs.order];
  const fromIndex = order.indexOf(from), toIndex = order.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return prefs;
  order.splice(fromIndex, 1); order.splice(toIndex, 0, from);
  return { ...prefs, order };
}
