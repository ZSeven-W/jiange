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

  discard(doc: object, key: string, redo: boolean): void {
    const histories = this.sessions.get(doc);
    const history = histories?.get(key);
    if (!history) return;
    (redo ? history.redo : history.undo).pop();
    if (!history.undo.length && !history.redo.length) histories?.delete(key);
  }
}
