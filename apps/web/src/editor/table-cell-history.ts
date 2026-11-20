type Version = string | null;
type Entry = { before: string; after: string; beforeVersion: Version; afterVersion: Version; expected: Version; typeVersion: Version; kind?: string; time: number };
type History = { undo: Entry[]; redo: Entry[] };

/**
 * Local input history for table cells. Table structure has no stable row or
 * column IDs yet, so any intervening tableData write invalidates the action.
 */
export class TableCellHistory {
  private readonly sessions = new WeakMap<object, Map<string, History>>();

  private get(doc: object, key: string): History {
    let histories = this.sessions.get(doc);
    if (!histories) { histories = new Map(); this.sessions.set(doc, histories); }
    let history = histories.get(key);
    if (!history) { history = { undo: [], redo: [] }; histories.set(key, history); }
    return history;
  }

  record(doc: object, key: string, before: string, after: string, previousVersion: Version, version: Version, typeVersion: Version, kind?: string, now = Date.now(), canMerge = true): boolean {
    if (before === after) return false;
    const history = this.get(doc, key);
    const last = history.undo.at(-1);
    const mergeable = kind === "insertText" || kind === "deleteContentBackward" || kind === "deleteContentForward" || kind === "insertCompositionText";
    const merged = !!(canMerge && mergeable && last && last.kind === kind && last.after === before && last.expected === previousVersion && last.typeVersion === typeVersion && now - last.time < 800);
    if (merged && last) {
      last.after = after; last.afterVersion = version; last.expected = version; last.time = now;
    } else {
      history.undo.push({ before, after, beforeVersion: previousVersion, afterVersion: version, expected: version, typeVersion, kind, time: now });
      if (history.undo.length > 500) history.undo.shift();
    }
    history.redo = [];
    return merged;
  }

  prepare(doc: object, key: string, redo: boolean, current: string, version: Version, typeVersion: Version): { status: "empty" | "conflict" } | { status: "ready"; value: string } {
    const history = this.get(doc, key);
    const item = (redo ? history.redo : history.undo).at(-1);
    if (!item) return { status: "empty" };
    if (item.expected !== version || item.typeVersion !== typeVersion || current !== (redo ? item.before : item.after)) return { status: "conflict" };
    return { status: "ready", value: redo ? item.after : item.before };
  }

  commit(doc: object, key: string, redo: boolean, version: Version): Version {
    const history = this.get(doc, key);
    const from = redo ? history.redo : history.undo;
    const to = redo ? history.undo : history.redo;
    const item = from.pop();
    if (!item) return null;
    item.expected = version;
    item.kind = undefined;
    to.push(item);
    return redo ? item.afterVersion : item.beforeVersion;
  }

  /** Rebase adjacent local history onto the version created by an undo/redo. */
  rebase(doc: object, tablePrefix: string, logicalVersion: Version, actualVersion: Version, typeVersion: Version): void {
    const histories = this.sessions.get(doc);
    if (!histories) return;
    for (const [key, history] of histories) {
      if (!key.startsWith(tablePrefix)) continue;
      const undo = history.undo.at(-1), redo = history.redo.at(-1);
      if (undo && undo.afterVersion === logicalVersion && undo.typeVersion === typeVersion) undo.expected = actualVersion;
      if (redo && redo.beforeVersion === logicalVersion && redo.typeVersion === typeVersion) redo.expected = actualVersion;
    }
  }

  /** A verified structural undo/redo may recreate the same logical registers at new versions. */
  rebaseStructure(doc: object, tablePrefix: string, logicalVersion: Version, actualVersion: Version, logicalGuard: Version, actualGuard: Version): void {
    const histories = this.sessions.get(doc);
    if (!histories) return;
    for (const [key, history] of histories) {
      if (!key.startsWith(tablePrefix)) continue;
      for (const entry of [history.undo.at(-1), history.redo.at(-1)]) {
        if (entry && entry.expected === logicalVersion && entry.typeVersion === logicalGuard) {
          entry.expected = actualVersion;
          entry.typeVersion = actualGuard;
        }
      }
    }
  }

  discard(doc: object, key: string, redo: boolean): void {
    const histories = this.sessions.get(doc);
    const history = histories?.get(key);
    if (!history) return;
    (redo ? history.redo : history.undo).pop();
    if (!history.undo.length && !history.redo.length) histories?.delete(key);
  }

  exportState(doc: object, hasMarker?: (key: string) => boolean): { v: 1; entries: [string, History][] } {
    const histories = this.sessions.get(doc);
    const entries: [string, History][] = [];
    if (!histories) return { v: 1, entries };
    for (const [key, history] of histories) {
      if (hasMarker && !hasMarker(key)) continue;
      if (!history.undo.length && !history.redo.length) continue;
      entries.push([
        key,
        {
          undo: history.undo.slice(-50).map((e) => ({ ...e, kind: undefined })),
          redo: history.redo.slice(-20).map((e) => ({ ...e, kind: undefined })),
        },
      ]);
    }
    return { v: 1, entries };
  }

  importState(doc: object, raw: unknown): Set<string> {
    const restoredKeys = new Set<string>();
    if (typeof raw !== "object" || raw === null) return restoredKeys;
    const data = raw as { v?: unknown; entries?: unknown };
    if (data.v !== 1 || !Array.isArray(data.entries)) return restoredKeys;
    const isVer = (v: unknown): v is Version => v === null || typeof v === "string";
    const isEntry = (e: unknown): e is Entry =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as Entry).before === "string" &&
      typeof (e as Entry).after === "string" &&
      isVer((e as Entry).beforeVersion) &&
      isVer((e as Entry).afterVersion) &&
      isVer((e as Entry).expected) &&
      isVer((e as Entry).typeVersion) &&
      typeof (e as Entry).time === "number";
    const valid: [string, History][] = [];
    for (const pair of data.entries) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") return restoredKeys;
      const h = pair[1] as Partial<History>;
      if (!h || !Array.isArray(h.undo) || !Array.isArray(h.redo) || !h.undo.every(isEntry) || !h.redo.every(isEntry)) return restoredKeys;
      valid.push([pair[0], { undo: h.undo.map((e) => ({ ...e, kind: undefined })), redo: h.redo.map((e) => ({ ...e, kind: undefined })) }]);
    }
    const histories = new Map<string, History>();
    for (const [key, history] of valid) {
      histories.set(key, history);
      restoredKeys.add(key);
    }
    this.sessions.set(doc, histories);
    return restoredKeys;
  }
}
