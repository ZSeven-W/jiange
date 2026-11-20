import type { Doc, UndoManager, UndoManagerSnapshot } from "@jiange/collab";
import type { FindBatchHistory } from "./find-batch";
import type { TableCellHistory } from "./table-cell-history";
import type { SerializedTableStructureHistory, TableStructureHistory } from "./table-structure-history";

const PREFIX = "jiange:undo-history:v1";
const MAX_PERSISTED_BYTES = 512 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface UndoStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistedUndoPayload {
  v: 1;
  userId: number;
  docId: number;
  epoch: number;
  savedAt: number;
  undo: UndoManagerSnapshot;
  tableCells: ReturnType<TableCellHistory["exportState"]>;
  tableStructures: SerializedTableStructureHistory;
  findBatches: ReturnType<FindBatchHistory["exportState"]>;
}

export interface UndoPersistenceContext<S> {
  storage: UndoStorageLike | null;
  userId: number;
  docId: number;
  epoch: number | null;
  doc: Doc;
  session: object;
  undo: UndoManager<S>;
  tableHistory: TableCellHistory;
  tableStructureHistory: TableStructureHistory;
  findBatchHistory: FindBatchHistory;
  readOnly: boolean;
  copyBlocked: boolean;
}

export function undoHistoryStorageKey(userId: number, docId: number): string {
  return `${PREFIX}:${userId}:${docId}`;
}

export function defaultUndoStorage(): UndoStorageLike | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function clearPersistedUndoHistory(storage: UndoStorageLike | null, userId: number, docId: number): void {
  if (!storage || !Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(docId) || docId < 1) return;
  try {
    storage.removeItem(undoHistoryStorageKey(userId, docId));
  } catch {
    // Ignore restricted/unavailable storage.
  }
}

const isPersistableMarker = (marker: string): boolean =>
  marker.startsWith("table:") || marker.startsWith("table-structure:") || marker.startsWith("find-batch:");

/**
 * Persists local CRDT undo/redo stacks alongside version-guarded table cell,
 * table structure, and find-batch histories into per-tab sessionStorage so a
 * page reload preserves local Cmd+Z/Cmd+Shift+Z safely.
 */
export function savePersistedUndoHistory<S>(ctx: UndoPersistenceContext<S>, now = Date.now()): boolean {
  const { storage, userId, docId, epoch, doc, session, undo, tableHistory, tableStructureHistory, findBatchHistory, readOnly, copyBlocked } = ctx;
  if (!storage || !Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(docId) || docId < 1) return false;
  if (readOnly || copyBlocked || epoch === null || !Number.isSafeInteger(epoch)) {
    clearPersistedUndoHistory(storage, userId, docId);
    return false;
  }
  const caps: [number, number][] = [
    [50, 20],
    [20, 10],
    [8, 4],
  ];
  for (const [maxUndos, maxRedos] of caps) {
    const exportedUndo = undo.exportState({ allowMarker: isPersistableMarker, maxUndos, maxRedos });
    if (!exportedUndo.undos.length && !exportedUndo.redos.length) {
      clearPersistedUndoHistory(storage, userId, docId);
      return false;
    }
    const liveMarkers = new Set<string>();
    for (const entry of [...exportedUndo.undos, ...exportedUndo.redos]) {
      if (entry.marker) liveMarkers.add(entry.marker);
    }
    const hasMarker = (key: string) => liveMarkers.has(key);
    const payload: PersistedUndoPayload = {
      v: 1,
      userId,
      docId,
      epoch,
      savedAt: now,
      undo: exportedUndo,
      tableCells: tableHistory.exportState(session, hasMarker),
      tableStructures: tableStructureHistory.exportState(undo),
      findBatches: findBatchHistory.exportState(doc, undo),
    };
    try {
      const encoded = JSON.stringify(payload);
      if (encoded.length <= MAX_PERSISTED_BYTES) {
        storage.setItem(undoHistoryStorageKey(userId, docId), encoded);
        return true;
      }
    } catch {
      return false;
    }
  }
  clearPersistedUndoHistory(storage, userId, docId);
  return false;
}

/**
 * Restores a previously saved local undo/redo history into a freshly reloaded
 * editor once synced at the matching document epoch. Strictly validates account,
 * document, epoch, freshness, copy-policy, and marker integrity.
 */
export function restorePersistedUndoHistory<S>(ctx: UndoPersistenceContext<S>, now = Date.now()): boolean {
  const { storage, userId, docId, epoch, doc, session, undo, tableHistory, tableStructureHistory, findBatchHistory, readOnly, copyBlocked } = ctx;
  if (!storage || !Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(docId) || docId < 1) return false;
  if (readOnly || copyBlocked || epoch === null || !Number.isSafeInteger(epoch)) {
    if (copyBlocked) clearPersistedUndoHistory(storage, userId, docId);
    return false;
  }
  if (undo.revision !== 0) return false;
  let rawText: string | null = null;
  try {
    rawText = storage.getItem(undoHistoryStorageKey(userId, docId));
  } catch {
    return false;
  }
  if (!rawText || rawText.length > MAX_PERSISTED_BYTES) return false;
  let parsed: Partial<PersistedUndoPayload>;
  try {
    parsed = JSON.parse(rawText) as Partial<PersistedUndoPayload>;
  } catch {
    clearPersistedUndoHistory(storage, userId, docId);
    return false;
  }
  if (
    !parsed ||
    parsed.v !== 1 ||
    parsed.userId !== userId ||
    parsed.docId !== docId ||
    parsed.epoch !== epoch ||
    typeof parsed.savedAt !== "number" ||
    now - parsed.savedAt > MAX_AGE_MS ||
    parsed.savedAt - now > 60_000
  ) {
    clearPersistedUndoHistory(storage, userId, docId);
    return false;
  }

  const allowedMarkers = new Set<string>();
  for (const key of tableHistory.importState(session, parsed.tableCells)) allowedMarkers.add(key);
  for (const key of tableStructureHistory.importState(parsed.tableStructures)) allowedMarkers.add(key);
  for (const key of findBatchHistory.importState(doc, undo, parsed.findBatches)) allowedMarkers.add(key);

  const ok = undo.importState(parsed.undo, { allowMarker: (marker) => allowedMarkers.has(marker) });
  if (!ok || (!undo.canUndo && !undo.canRedo)) {
    clearPersistedUndoHistory(storage, userId, docId);
    return false;
  }
  return true;
}
