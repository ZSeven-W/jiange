export type DriveTimeColumn = "updated" | "created";
export type DriveColumnPreferences = { order: DriveTimeColumn[]; visible: Record<DriveTimeColumn, boolean> };

export function defaultDriveColumns(): DriveColumnPreferences {
  return { order: ["updated", "created"], visible: { updated: true, created: true } };
}

/** Ignore corrupt or obsolete local settings instead of hiding columns unexpectedly. */
export function readDriveColumns(storage: Pick<Storage, "getItem"> | undefined, userId: number): DriveColumnPreferences {
  try {
    const raw = storage?.getItem(`jiange:drive-columns:v1:${userId}`);
    if (!raw) return defaultDriveColumns();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return defaultDriveColumns();
    const prefs = value as Partial<DriveColumnPreferences>;
    if (!Array.isArray(prefs.order) || prefs.order.length !== 2 || new Set(prefs.order).size !== 2 || !prefs.order.includes("updated") || !prefs.order.includes("created") || typeof prefs.visible?.updated !== "boolean" || typeof prefs.visible?.created !== "boolean") return defaultDriveColumns();
    return { order: [...prefs.order], visible: { updated: prefs.visible.updated, created: prefs.visible.created } };
  } catch { return defaultDriveColumns(); }
}

export function writeDriveColumns(storage: Pick<Storage, "setItem"> | undefined, userId: number, prefs: DriveColumnPreferences): boolean {
  try { if (!storage) return false; storage.setItem(`jiange:drive-columns:v1:${userId}`, JSON.stringify(prefs)); return true; }
  catch { return false; }
}

export function moveDriveColumn(prefs: DriveColumnPreferences, from: DriveTimeColumn, to: DriveTimeColumn): DriveColumnPreferences {
  if (from === to) return prefs;
  const order = [...prefs.order];
  const fromIndex = order.indexOf(from), toIndex = order.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return prefs;
  order.splice(fromIndex, 1); order.splice(toIndex, 0, from);
  return { ...prefs, order };
}
