import {
  deleteOfflineCollabRecord,
  getOfflineCollabRecord,
  listOfflineCollabRecords,
  putOfflineCollabRecord,
  type DocCollabReplica,
  type SheetOfflineCellEdit,
  type SheetOfflineDelta,
  type SlidesOfflineDraft,
  type SlidesOfflinePageEntry,
} from "./offline-db";

export type {
  DocCollabReplica,
  SheetOfflineCellEdit,
  SheetOfflineDelta,
  SlidesOfflineDraft,
  SlidesOfflinePageEntry,
};

export type OfflineCollabFetcher = (
  input: string,
  init: RequestInit,
) => Promise<
  Pick<Response, "ok" | "status" | "statusText"> & {
    json?: () => Promise<unknown>;
  }
>;

export interface SaveDocCollabReplicaInput {
  snapshot: Uint8Array | string;
  seq: number;
  historyEpoch?: number | null;
  role?: "view" | "edit" | "manage";
  clientId?: number;
  pendingOpsCount?: number;
  updatedAt?: number;
}

export interface LoadedDocCollabReplica extends DocCollabReplica {
  snapshot: Uint8Array;
}

export interface QueueSheetOfflineCellInput {
  worksheetId?: number;
  row: number;
  col: number;
  rowId?: number;
  columnId?: number;
  raw: string;
  expectedRevision?: number;
  updatedAt?: number;
}

export interface QueueSheetOfflineCellsInput {
  worksheetId: number;
  edits: QueueSheetOfflineCellInput[];
  baseRevision?: number;
  updatedAt?: number;
}

export interface SheetRemoteCell {
  worksheetId?: number;
  row: number;
  col: number;
  raw: string;
  revision?: number;
  updatedAt?: number;
}

export interface SheetMergedCell {
  worksheetId: number;
  row: number;
  col: number;
  raw: string;
  source: "remote" | "local" | "converged";
  updatedAt?: number;
  revision?: number;
}

export interface SheetCellMergeConflict {
  worksheetId: number;
  row: number;
  col: number;
  localRaw: string;
  remoteRaw: string;
  localUpdatedAt: number;
  remoteUpdatedAt?: number;
  remoteRevision?: number;
  baseRevision?: number;
  winner: "local" | "remote";
  resolvedRaw: string;
}

export interface MergeSheetOfflineCellsOptions {
  worksheetId?: number;
  baseRevision?: number;
  baseCells?: Array<{ worksheetId?: number; row: number; col: number; raw: string }>;
}

export interface MergeSheetOfflineCellsResult {
  merged: SheetMergedCell[];
  conflicts: SheetCellMergeConflict[];
  localWins: number;
  remoteWins: number;
}

export interface QueueSlidesOfflinePageInput {
  pageId: number;
  shapesJson: string;
  baseRevision: number;
  title?: string;
  body?: string;
  background?: string;
  layout?: string;
  notes?: string;
  updatedAt?: number;
}

export interface OfflineCollabConflict {
  kind: "sheet" | "slides";
  resourceId: number;
  worksheetId?: number;
  pageId?: number;
  row?: number;
  col?: number;
  localRaw?: string;
  remoteRaw?: string;
  winner?: "local" | "remote";
  reason: string;
}

export interface FlushOfflineCollabResult {
  flushed: number;
  failed: number;
  conflicts: OfflineCollabConflict[];
}

export interface FlushSheetOfflineCellsResult extends FlushOfflineCollabResult {
  cellsFlushed: number;
}

export interface OfflineCollabSummary {
  totalCount: number;
  docReplicaCount: number;
  docPendingOpsCount: number;
  sheetDeltaCount: number;
  sheetEditCount: number;
  slidesDraftCount: number;
  pendingMergeCount: number;
}

export function docCollabReplicaKey(userId: number, docId: number): string {
  return `doc:${userId}:${docId}`;
}

export function sheetOfflineDeltaKey(userId: number, sheetId: number): string {
  return `sheet:${userId}:${sheetId}`;
}

export function slidesOfflineDraftKey(userId: number, deckId: number): string {
  return `slides:${userId}:${deckId}`;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return "";
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  if (!base64) return new Uint8Array(0);
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(base64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function isValidPositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function generateMutationId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${Date.now()}_${rand}`;
}

function resolveFetcher(fetcher?: OfflineCollabFetcher): OfflineCollabFetcher | null {
  if (fetcher) return fetcher;
  if (typeof fetch === "function") return fetch as OfflineCollabFetcher;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ Doc CRDT Replicas */

/**
 * Persists a binary CRDT snapshot for `(userId, docId)` into IndexedDB (`collab_replicas`).
 */
export async function saveDocCollabReplica(
  userId: number,
  docId: number,
  input: SaveDocCollabReplicaInput,
): Promise<DocCollabReplica | null> {
  if (!isValidPositiveInt(userId) || !isValidPositiveInt(docId)) {
    return null;
  }
  const snapshotBase64 =
    typeof input.snapshot === "string"
      ? input.snapshot
      : uint8ArrayToBase64(input.snapshot);
  if (!snapshotBase64) {
    return null;
  }
  const seq = Number.isSafeInteger(input.seq) && input.seq >= 0 ? input.seq : 0;
  const historyEpoch =
    input.historyEpoch != null && Number.isSafeInteger(input.historyEpoch) && input.historyEpoch >= 1
      ? input.historyEpoch
      : null;
  const pendingOpsCount =
    typeof input.pendingOpsCount === "number" &&
    Number.isSafeInteger(input.pendingOpsCount) &&
    input.pendingOpsCount >= 0
      ? input.pendingOpsCount
      : 0;
  const updatedAt =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
      ? input.updatedAt
      : Date.now();

  const record: DocCollabReplica = {
    key: docCollabReplicaKey(userId, docId),
    kind: "doc",
    userId,
    docId,
    snapshotBase64,
    seq,
    historyEpoch,
    role: input.role ?? "edit",
    ...(input.clientId !== undefined && isValidPositiveInt(input.clientId)
      ? { clientId: input.clientId }
      : {}),
    updatedAt,
    pendingOpsCount,
  };
  return putOfflineCollabRecord(record);
}

/**
 * Loads and decodes the persisted binary CRDT snapshot for `(userId, docId)`.
 */
export async function loadDocCollabReplica(
  userId: number,
  docId: number,
): Promise<LoadedDocCollabReplica | null> {
  if (!isValidPositiveInt(userId) || !isValidPositiveInt(docId)) {
    return null;
  }
  const record = await getOfflineCollabRecord<DocCollabReplica>(
    docCollabReplicaKey(userId, docId),
  );
  if (!record || record.kind !== "doc" || typeof record.snapshotBase64 !== "string") {
    return null;
  }
  try {
    const snapshot = base64ToUint8Array(record.snapshotBase64);
    if (snapshot.byteLength === 0) return null;
    return { ...record, snapshot };
  } catch {
    return null;
  }
}

export async function deleteDocCollabReplica(userId: number, docId: number): Promise<void> {
  if (!isValidPositiveInt(userId) || !isValidPositiveInt(docId)) return;
  await deleteOfflineCollabRecord(docCollabReplicaKey(userId, docId));
}

export async function listDocCollabReplicas(userId?: number): Promise<DocCollabReplica[]> {
  const records = await listOfflineCollabRecords<DocCollabReplica>("doc");
  if (userId === undefined) return records;
  return records.filter((item) => item.userId === userId);
}

/* ------------------------------------------------------------------ Sheet Offline Deltas */

function cellCoordKey(worksheetId: number, row: number, col: number): string {
  return `${worksheetId}:${row}:${col}`;
}

function compactSheetEdits(
  edits: SheetOfflineCellEdit[],
  defaultWorksheetId: number,
): SheetOfflineCellEdit[] {
  const byCoord = new Map<string, SheetOfflineCellEdit>();
  for (const edit of edits) {
    const wsId = edit.worksheetId ?? defaultWorksheetId;
    const coord = cellCoordKey(wsId, edit.row, edit.col);
    const existing = byCoord.get(coord);
    if (!existing || edit.updatedAt >= existing.updatedAt) {
      byCoord.set(coord, { ...edit, worksheetId: wsId });
    }
  }
  return Array.from(byCoord.values()).sort(
    (a, b) =>
      (a.worksheetId ?? defaultWorksheetId) - (b.worksheetId ?? defaultWorksheetId) ||
      a.row - b.row ||
      a.col - b.col,
  );
}

/**
 * Queues offline cell edits for a spreadsheet, deduplicating per `(worksheetId, row, col)`
 * using last-write-wins semantics so repeated offline edits compact cleanly.
 */
export async function queueSheetOfflineCells(
  userId: number,
  sheetId: number,
  input: QueueSheetOfflineCellsInput,
): Promise<SheetOfflineDelta | null> {
  if (!isValidPositiveInt(userId) || !isValidPositiveInt(sheetId) || !input.edits.length) {
    return null;
  }
  const key = sheetOfflineDeltaKey(userId, sheetId);
  const existing = await getOfflineCollabRecord<SheetOfflineDelta>(key);
  const now =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
      ? input.updatedAt
      : Date.now();

  const incoming: SheetOfflineCellEdit[] = input.edits.map((edit, idx) => ({
    worksheetId: edit.worksheetId ?? input.worksheetId,
    row: edit.row,
    col: edit.col,
    ...(edit.rowId !== undefined ? { rowId: edit.rowId } : {}),
    ...(edit.columnId !== undefined ? { columnId: edit.columnId } : {}),
    raw: edit.raw,
    ...(edit.expectedRevision !== undefined ? { expectedRevision: edit.expectedRevision } : {}),
    updatedAt:
      typeof edit.updatedAt === "number" && Number.isFinite(edit.updatedAt)
        ? edit.updatedAt
        : now + idx,
  }));

  const priorEdits = existing?.kind === "sheet" ? existing.edits : [];
  const priorWsId = existing?.kind === "sheet" ? existing.worksheetId : input.worksheetId;
  const normalizedPrior = priorEdits.map((e) => ({
    ...e,
    worksheetId: e.worksheetId ?? priorWsId,
  }));
  const mergedEdits = compactSheetEdits([...normalizedPrior, ...incoming], input.worksheetId);
  const maxEditTs = mergedEdits.reduce((max, item) => Math.max(max, item.updatedAt), now);

  const baseRevision =
    existing?.kind === "sheet"
      ? existing.baseRevision
      : typeof input.baseRevision === "number" && Number.isSafeInteger(input.baseRevision) && input.baseRevision >= 0
        ? input.baseRevision
        : 0;

  const delta: SheetOfflineDelta = {
    key,
    kind: "sheet",
    userId,
    sheetId,
    worksheetId: input.worksheetId,
    edits: mergedEdits,
    baseRevision,
    updatedAt: Math.max(now, maxEditTs),
  };

  return putOfflineCollabRecord(delta);
}

export async function loadSheetOfflineCells(
  userId: number,
  sheetId: number,
): Promise<SheetOfflineDelta | null> {
  if (!isValidPositiveInt(userId) || !isValidPositiveInt(sheetId)) return null;
  const record = await getOfflineCollabRecord<SheetOfflineDelta>(
    sheetOfflineDeltaKey(userId, sheetId),
  );
  if (!record || record.kind !== "sheet") return null;
  return record;
}

export async function deleteSheetOfflineCells(userId: number, sheetId: number): Promise<void> {
  if (!isValidPositiveInt(userId) || !isValidPositiveInt(sheetId)) return;
  await deleteOfflineCollabRecord(sheetOfflineDeltaKey(userId, sheetId));
}

export async function listSheetOfflineDeltas(userId?: number): Promise<SheetOfflineDelta[]> {
  const records = await listOfflineCollabRecords<SheetOfflineDelta>("sheet");
  if (userId === undefined) return records;
  return records.filter((item) => item.userId === userId);
}

/**
 * Pure last-write-wins merge per `(worksheetId, row, col)` with conflict detection
 * metadata whenever a remote cell also changed while editing offline.
 */
export function mergeSheetOfflineCells(
  remoteCells: SheetRemoteCell[],
  localInput: SheetOfflineDelta | SheetOfflineCellEdit[],
  options?: MergeSheetOfflineCellsOptions,
): MergeSheetOfflineCellsResult {
  const isDelta = !Array.isArray(localInput);
  const defaultWsId = options?.worksheetId ?? (isDelta ? localInput.worksheetId : 0);
  const effectiveBaseRevision =
    options?.baseRevision ?? (isDelta ? localInput.baseRevision : undefined);
  const rawLocalEdits = isDelta ? localInput.edits : localInput;
  const localEdits = compactSheetEdits(rawLocalEdits, defaultWsId);

  const remoteMap = new Map<string, SheetRemoteCell & { worksheetId: number }>();
  for (const cell of remoteCells) {
    const wsId = cell.worksheetId ?? defaultWsId;
    remoteMap.set(cellCoordKey(wsId, cell.row, cell.col), { ...cell, worksheetId: wsId });
  }

  const baseMap = new Map<string, string>();
  if (options?.baseCells) {
    for (const cell of options.baseCells) {
      const wsId = cell.worksheetId ?? defaultWsId;
      baseMap.set(cellCoordKey(wsId, cell.row, cell.col), cell.raw);
    }
  }

  const localMap = new Map<string, SheetOfflineCellEdit & { worksheetId: number }>();
  for (const edit of localEdits) {
    const wsId = edit.worksheetId ?? defaultWsId;
    localMap.set(cellCoordKey(wsId, edit.row, edit.col), { ...edit, worksheetId: wsId });
  }

  const allKeys = new Set<string>([...remoteMap.keys(), ...localMap.keys()]);
  const merged: SheetMergedCell[] = [];
  const conflicts: SheetCellMergeConflict[] = [];
  let localWins = 0;
  let remoteWins = 0;

  for (const key of allKeys) {
    const remote = remoteMap.get(key);
    const local = localMap.get(key);

    if (remote && !local) {
      merged.push({
        worksheetId: remote.worksheetId,
        row: remote.row,
        col: remote.col,
        raw: remote.raw,
        source: "remote",
        ...(remote.updatedAt !== undefined ? { updatedAt: remote.updatedAt } : {}),
        ...(remote.revision !== undefined ? { revision: remote.revision } : {}),
      });
      continue;
    }

    if (local && !remote) {
      localWins += 1;
      merged.push({
        worksheetId: local.worksheetId,
        row: local.row,
        col: local.col,
        raw: local.raw,
        source: "local",
        updatedAt: local.updatedAt,
      });
      continue;
    }

    if (remote && local) {
      if (remote.raw === local.raw) {
        merged.push({
          worksheetId: local.worksheetId,
          row: local.row,
          col: local.col,
          raw: local.raw,
          source: "converged",
          updatedAt: Math.max(local.updatedAt, remote.updatedAt ?? 0),
          ...(remote.revision !== undefined ? { revision: remote.revision } : {}),
        });
        continue;
      }

      const hasBase = baseMap.has(key);
      const baseRaw = baseMap.get(key);
      const remoteChanged = hasBase
        ? remote.raw !== baseRaw
        : remote.revision !== undefined && effectiveBaseRevision !== undefined
          ? remote.revision > effectiveBaseRevision
          : remote.updatedAt !== undefined || remote.raw !== "";

      const remoteTs = remote.updatedAt ?? -Infinity;
      const winner: "local" | "remote" = remoteTs > local.updatedAt ? "remote" : "local";
      const resolvedRaw = winner === "local" ? local.raw : remote.raw;

      if (winner === "local") localWins += 1;
      else remoteWins += 1;

      if (remoteChanged) {
        conflicts.push({
          worksheetId: local.worksheetId,
          row: local.row,
          col: local.col,
          localRaw: local.raw,
          remoteRaw: remote.raw,
          localUpdatedAt: local.updatedAt,
          ...(remote.updatedAt !== undefined ? { remoteUpdatedAt: remote.updatedAt } : {}),
          ...(remote.revision !== undefined ? { remoteRevision: remote.revision } : {}),
          ...(effectiveBaseRevision !== undefined ? { baseRevision: effectiveBaseRevision } : {}),
          winner,
          resolvedRaw,
        });
      }

      merged.push({
        worksheetId: local.worksheetId,
        row: local.row,
        col: local.col,
        raw: resolvedRaw,
        source: winner,
        updatedAt: winner === "local" ? local.updatedAt : remote.updatedAt,
        ...(remote.revision !== undefined ? { revision: remote.revision } : {}),
      });
    }
  }

  merged.sort((a, b) => a.worksheetId - b.worksheetId || a.row - b.row || a.col - b.col);
  conflicts.sort((a, b) => a.worksheetId - b.worksheetId || a.row - b.row || a.col - b.col);

  return { merged, conflicts, localWins, remoteWins };
}

/**
 * Posts batched offline sheet edits to `/api/sheets/{id}/cells` on reconnect and
 * clears the persisted delta on success.
 */
export async function flushSheetOfflineCells(
  userId: number,
  sheetId: number,
  fetcher?: OfflineCollabFetcher,
): Promise<FlushSheetOfflineCellsResult> {
  const delta = await loadSheetOfflineCells(userId, sheetId);
  if (!delta || delta.edits.length === 0) {
    return { flushed: 0, cellsFlushed: 0, failed: 0, conflicts: [] };
  }

  const effectiveFetcher = resolveFetcher(fetcher);
  if (!effectiveFetcher) {
    return { flushed: 0, cellsFlushed: 0, failed: 0, conflicts: [] };
  }

  const byWorksheet = new Map<number, SheetOfflineCellEdit[]>();
  for (const edit of compactSheetEdits(delta.edits, delta.worksheetId)) {
    const wsId = edit.worksheetId ?? delta.worksheetId;
    const list = byWorksheet.get(wsId) ?? [];
    list.push(edit);
    byWorksheet.set(wsId, list);
  }

  let flushed = 0;
  let cellsFlushed = 0;
  let failed = 0;
  const conflicts: OfflineCollabConflict[] = [];
  const remainingEdits: SheetOfflineCellEdit[] = [];

  for (const [worksheetId, edits] of byWorksheet.entries()) {
    const payload = {
      mutationId: generateMutationId("offline_sheet"),
      worksheetId,
      mergeMode: "auto" as const,
      baseRevision: delta.baseRevision,
      cells: edits.map((edit) => ({
        row: edit.row,
        col: edit.col,
        rowId: edit.rowId ?? edit.row,
        columnId: edit.columnId ?? edit.col,
        expectedRevision: edit.expectedRevision ?? delta.baseRevision,
        raw: edit.raw,
        updatedAt: edit.updatedAt,
      })),
    };

    try {
      const response = await effectiveFetcher(`/api/sheets/${sheetId}/cells`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Jiange-User-Id": String(userId),
          "X-Jiange-Sheet-Version": "1",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok || response.status === 404 || response.status === 410) {
        if (response.ok && typeof response.json === "function") {
          try {
            const body = await response.json();
            if (isRecord(body) && Array.isArray(body.conflicts)) {
              for (const rawConflict of body.conflicts) {
                if (!isRecord(rawConflict)) continue;
                conflicts.push({
                  kind: "sheet",
                  resourceId: sheetId,
                  worksheetId,
                  row: typeof rawConflict.row === "number" ? rawConflict.row : undefined,
                  col: typeof rawConflict.col === "number" ? rawConflict.col : undefined,
                  localRaw: typeof rawConflict.attemptedRaw === "string" ? rawConflict.attemptedRaw : undefined,
                  remoteRaw: typeof rawConflict.currentRaw === "string" ? rawConflict.currentRaw : undefined,
                  winner: "remote",
                  reason: typeof rawConflict.reason === "string" ? rawConflict.reason : "value_conflict",
                });
              }
            }
          } catch {
            // ignore non-JSON body on successful batch response
          }
        }
        flushed += 1;
        cellsFlushed += edits.length;
      } else if (response.status === 409) {
        failed += 1;
        remainingEdits.push(...edits);
        conflicts.push({
          kind: "sheet",
          resourceId: sheetId,
          worksheetId,
          reason: "revision_conflict",
        });
      } else {
        failed += 1;
        remainingEdits.push(...edits);
      }
    } catch {
      failed += 1;
      remainingEdits.push(...edits);
    }
  }

  if (remainingEdits.length === 0) {
    await deleteSheetOfflineCells(userId, sheetId);
  } else if (flushed > 0) {
    await putOfflineCollabRecord<SheetOfflineDelta>({
      ...delta,
      edits: remainingEdits,
      updatedAt: Date.now(),
    });
  }

  return { flushed, cellsFlushed, failed, conflicts };
}

/* ------------------------------------------------------------------ Slides Offline Drafts */

function extractSlidesPages(draft: SlidesOfflineDraft): SlidesOfflinePageEntry[] {
  if (draft.pages && Object.keys(draft.pages).length > 0) {
    return Object.values(draft.pages).sort(
      (a, b) => a.updatedAt - b.updatedAt || a.pageId - b.pageId,
    );
  }
  return [
    {
      pageId: draft.pageId,
      shapesJson: draft.shapesJson,
      baseRevision: draft.baseRevision,
      ...(draft.title !== undefined ? { title: draft.title } : {}),
      ...(draft.body !== undefined ? { body: draft.body } : {}),
      ...(draft.background !== undefined ? { background: draft.background } : {}),
      ...(draft.layout !== undefined ? { layout: draft.layout } : {}),
      ...(draft.notes !== undefined ? { notes: draft.notes } : {}),
      updatedAt: draft.updatedAt,
    },
  ];
}

/**
 * Queues an offline slide page shape/content draft for `(userId, deckId)` in IndexedDB.
 * Preserves edits across multiple slide pages within the same deck.
 */
export async function queueSlidesOfflinePage(
  userId: number,
  deckId: number,
  input: QueueSlidesOfflinePageInput,
): Promise<SlidesOfflineDraft | null> {
  if (!isValidPositiveInt(userId) || !isValidPositiveInt(deckId) || !isValidPositiveInt(input.pageId)) {
    return null;
  }
  const key = slidesOfflineDraftKey(userId, deckId);
  const existing = await getOfflineCollabRecord<SlidesOfflineDraft>(key);
  const updatedAt =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
      ? input.updatedAt
      : Date.now();
  const baseRevision =
    Number.isSafeInteger(input.baseRevision) && input.baseRevision >= 0 ? input.baseRevision : 0;

  const pageMap: Record<string, SlidesOfflinePageEntry> = {};
  if (existing?.kind === "slides") {
    for (const entry of extractSlidesPages(existing)) {
      pageMap[String(entry.pageId)] = entry;
    }
  }

  const nextEntry: SlidesOfflinePageEntry = {
    pageId: input.pageId,
    shapesJson: input.shapesJson,
    baseRevision,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.background !== undefined ? { background: input.background } : {}),
    ...(input.layout !== undefined ? { layout: input.layout } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    updatedAt,
  };
  pageMap[String(input.pageId)] = nextEntry;

  const draft: SlidesOfflineDraft = {
    key,
    kind: "slides",
    userId,
    deckId,
    pageId: nextEntry.pageId,
    shapesJson: nextEntry.shapesJson,
    baseRevision: nextEntry.baseRevision,
    ...(nextEntry.title !== undefined ? { title: nextEntry.title } : {}),
    ...(nextEntry.body !== undefined ? { body: nextEntry.body } : {}),
    ...(nextEntry.background !== undefined ? { background: nextEntry.background } : {}),
    ...(nextEntry.layout !== undefined ? { layout: nextEntry.layout } : {}),
    ...(nextEntry.notes !== undefined ? { notes: nextEntry.notes } : {}),
    pages: pageMap,
    updatedAt,
  };

  return putOfflineCollabRecord(draft);
}

export async function loadSlidesOfflinePage(
  userId: number,
  deckId: number,
  pageId?: number,
): Promise<SlidesOfflineDraft | null> {
  if (!isValidPositiveInt(userId) || !isValidPositiveInt(deckId)) return null;
  const record = await getOfflineCollabRecord<SlidesOfflineDraft>(
    slidesOfflineDraftKey(userId, deckId),
  );
  if (!record || record.kind !== "slides") return null;
  if (pageId === undefined) return record;
  const entry = record.pages?.[String(pageId)];
  if (entry) {
    return {
      ...record,
      pageId: entry.pageId,
      shapesJson: entry.shapesJson,
      baseRevision: entry.baseRevision,
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(entry.body !== undefined ? { body: entry.body } : {}),
      ...(entry.background !== undefined ? { background: entry.background } : {}),
      ...(entry.layout !== undefined ? { layout: entry.layout } : {}),
      ...(entry.notes !== undefined ? { notes: entry.notes } : {}),
      updatedAt: entry.updatedAt,
    };
  }
  return record.pageId === pageId ? record : null;
}

export async function deleteSlidesOfflinePage(
  userId: number,
  deckId: number,
  pageId?: number,
): Promise<void> {
  if (!isValidPositiveInt(userId) || !isValidPositiveInt(deckId)) return;
  const key = slidesOfflineDraftKey(userId, deckId);
  if (pageId === undefined) {
    await deleteOfflineCollabRecord(key);
    return;
  }
  const existing = await getOfflineCollabRecord<SlidesOfflineDraft>(key);
  if (!existing || existing.kind !== "slides") return;
  const remaining = extractSlidesPages(existing).filter((entry) => entry.pageId !== pageId);
  if (remaining.length === 0) {
    await deleteOfflineCollabRecord(key);
    return;
  }
  const latest = remaining[remaining.length - 1];
  const pages: Record<string, SlidesOfflinePageEntry> = {};
  for (const entry of remaining) {
    pages[String(entry.pageId)] = entry;
  }
  await putOfflineCollabRecord<SlidesOfflineDraft>({
    ...existing,
    pageId: latest.pageId,
    shapesJson: latest.shapesJson,
    baseRevision: latest.baseRevision,
    title: latest.title,
    body: latest.body,
    background: latest.background,
    layout: latest.layout,
    notes: latest.notes,
    pages,
    updatedAt: latest.updatedAt,
  });
}

export async function listSlidesOfflineDrafts(userId?: number): Promise<SlidesOfflineDraft[]> {
  const records = await listOfflineCollabRecords<SlidesOfflineDraft>("slides");
  if (userId === undefined) return records;
  return records.filter((item) => item.userId === userId);
}

/**
 * Replays queued slide page shape/content updates to
 * `PATCH /api/slides/{deckId}/pages/{pageId}/content` on reconnect and clears on success.
 */
export async function flushSlidesOfflinePage(
  userId: number,
  deckId: number,
  fetcher?: OfflineCollabFetcher,
): Promise<FlushOfflineCollabResult> {
  const draft = await loadSlidesOfflinePage(userId, deckId);
  if (!draft) {
    return { flushed: 0, failed: 0, conflicts: [] };
  }
  const effectiveFetcher = resolveFetcher(fetcher);
  if (!effectiveFetcher) {
    return { flushed: 0, failed: 0, conflicts: [] };
  }

  const pages = extractSlidesPages(draft);
  let flushed = 0;
  let failed = 0;
  const conflicts: OfflineCollabConflict[] = [];
  const remaining: SlidesOfflinePageEntry[] = [];

  for (const page of pages) {
    let parsedShapes: unknown = [];
    try {
      parsedShapes = JSON.parse(page.shapesJson);
    } catch {
      parsedShapes = [];
    }

    const body: Record<string, unknown> = {
      title: page.title ?? "",
      body: page.body ?? "",
      background: page.background ?? "",
      layout: page.layout ?? "",
      expectedRevision: page.baseRevision,
      shapes: parsedShapes,
      ...(page.notes !== undefined ? { notes: page.notes } : {}),
    };

    try {
      const response = await effectiveFetcher(
        `/api/slides/${deckId}/pages/${page.pageId}/content`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-Jiange-User-Id": String(userId),
            "X-Jiange-Slides-Version": "5",
          },
          body: JSON.stringify(body),
        },
      );

      if (response.ok || response.status === 404 || response.status === 410) {
        flushed += 1;
      } else if (response.status === 409) {
        failed += 1;
        remaining.push(page);
        conflicts.push({
          kind: "slides",
          resourceId: deckId,
          pageId: page.pageId,
          reason: "revision_conflict",
        });
      } else {
        failed += 1;
        remaining.push(page);
      }
    } catch {
      failed += 1;
      remaining.push(page);
    }
  }

  if (remaining.length === 0) {
    await deleteSlidesOfflinePage(userId, deckId);
  } else if (flushed > 0) {
    const latest = remaining[remaining.length - 1];
    const pageMap: Record<string, SlidesOfflinePageEntry> = {};
    for (const entry of remaining) {
      pageMap[String(entry.pageId)] = entry;
    }
    await putOfflineCollabRecord<SlidesOfflineDraft>({
      ...draft,
      pageId: latest.pageId,
      shapesJson: latest.shapesJson,
      baseRevision: latest.baseRevision,
      title: latest.title,
      body: latest.body,
      background: latest.background,
      layout: latest.layout,
      notes: latest.notes,
      pages: pageMap,
      updatedAt: Date.now(),
    });
  }

  return { flushed, failed, conflicts };
}

/* ------------------------------------------------------------------ Unified Collab Flush & Summary */

/**
 * Flushes all queued Sheet & Slides offline deltas upon reconnection.
 * (Doc CRDT replicas sync automatically over WebSocket via `SyncClient`.)
 */
export async function flushAllOfflineCollab(
  fetcher?: OfflineCollabFetcher,
): Promise<FlushOfflineCollabResult> {
  const effectiveFetcher = resolveFetcher(fetcher);
  if (!effectiveFetcher) {
    return { flushed: 0, failed: 0, conflicts: [] };
  }

  const [sheetDeltas, slidesDrafts] = await Promise.all([
    listSheetOfflineDeltas(),
    listSlidesOfflineDrafts(),
  ]);

  let flushed = 0;
  let failed = 0;
  const conflicts: OfflineCollabConflict[] = [];

  for (const delta of sheetDeltas) {
    const res = await flushSheetOfflineCells(delta.userId, delta.sheetId, effectiveFetcher);
    flushed += res.flushed;
    failed += res.failed;
    conflicts.push(...res.conflicts);
  }

  for (const draft of slidesDrafts) {
    const res = await flushSlidesOfflinePage(draft.userId, draft.deckId, effectiveFetcher);
    flushed += res.flushed;
    failed += res.failed;
    conflicts.push(...res.conflicts);
  }

  return { flushed, failed, conflicts };
}

/**
 * Summarizes all locally persisted CRDT doc replicas and queued Sheet/Slides offline deltas.
 */
export async function getOfflineCollabSummary(userId?: number): Promise<OfflineCollabSummary> {
  const all = await listOfflineCollabRecords();
  const filtered = userId === undefined ? all : all.filter((item) => item.userId === userId);

  let docReplicaCount = 0;
  let docPendingOpsCount = 0;
  let docPendingMerges = 0;
  let sheetDeltaCount = 0;
  let sheetEditCount = 0;
  let slidesDraftCount = 0;

  for (const record of filtered) {
    if (record.kind === "doc") {
      docReplicaCount += 1;
      docPendingOpsCount += Math.max(0, record.pendingOpsCount);
      if (record.pendingOpsCount > 0) docPendingMerges += 1;
    } else if (record.kind === "sheet") {
      sheetDeltaCount += 1;
      sheetEditCount += record.edits.length;
    } else if (record.kind === "slides") {
      slidesDraftCount += 1;
    }
  }

  return {
    totalCount: filtered.length,
    docReplicaCount,
    docPendingOpsCount,
    sheetDeltaCount,
    sheetEditCount,
    slidesDraftCount,
    pendingMergeCount: docPendingMerges + sheetDeltaCount + slidesDraftCount,
  };
}
