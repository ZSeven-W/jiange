import { Doc } from "@jiange/collab";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOfflineDbForTesting } from "./offline-db";
import {
  base64ToUint8Array,
  deleteDocCollabReplica,
  deleteSheetOfflineCells,
  deleteSlidesOfflinePage,
  flushAllOfflineCollab,
  flushSheetOfflineCells,
  flushSlidesOfflinePage,
  getOfflineCollabSummary,
  listDocCollabReplicas,
  loadDocCollabReplica,
  loadSheetOfflineCells,
  loadSlidesOfflinePage,
  mergeSheetOfflineCells,
  queueSheetOfflineCells,
  queueSlidesOfflinePage,
  saveDocCollabReplica,
  uint8ArrayToBase64,
  type OfflineCollabFetcher,
} from "./offline-collab";

describe("offline-collab CRDT replicas & Sheet/Slides offline deltas", () => {
  beforeEach(async () => {
    await resetOfflineDbForTesting({ indexedDB: null });
  });

  afterEach(async () => {
    await resetOfflineDbForTesting();
  });

  it("round-trips binary CRDT doc snapshots via saveDocCollabReplica / loadDocCollabReplica / list / delete", async () => {
    const doc = new Doc(7);
    const blk = doc.createBlock("paragraph");
    doc.insertText(blk.id, 0, "离线协同 CRDT 文档内容");
    const bytes = doc.encodeState();

    // Base64 codec fidelity
    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes);
    expect(uint8ArrayToBase64(new Uint8Array(0))).toBe("");
    expect(base64ToUint8Array("")).toEqual(new Uint8Array(0));

    const saved = await saveDocCollabReplica(10, 42, {
      snapshot: bytes,
      seq: 18,
      historyEpoch: 3,
      role: "edit",
      clientId: 7,
      pendingOpsCount: 2,
      updatedAt: 5000,
    });
    expect(saved).not.toBeNull();
    expect(saved?.key).toBe("doc:10:42");
    expect(saved?.seq).toBe(18);
    expect(saved?.historyEpoch).toBe(3);
    expect(saved?.pendingOpsCount).toBe(2);

    const loaded = await loadDocCollabReplica(10, 42);
    expect(loaded).not.toBeNull();
    expect(loaded?.snapshot).toEqual(bytes);
    const decoded = Doc.fromState(loaded!.clientId ?? 1, loaded!.snapshot);
    expect(decoded.text(blk.id)).toBe("离线协同 CRDT 文档内容");

    // Account isolation
    await saveDocCollabReplica(11, 42, {
      snapshot: bytes,
      seq: 1,
      historyEpoch: 1,
      role: "view",
      updatedAt: 6000,
    });
    expect((await listDocCollabReplicas()).map((r) => r.key)).toEqual(["doc:11:42", "doc:10:42"]);
    expect((await listDocCollabReplicas(10)).map((r) => r.key)).toEqual(["doc:10:42"]);

    await deleteDocCollabReplica(10, 42);
    expect(await loadDocCollabReplica(10, 42)).toBeNull();
    expect(await listDocCollabReplicas(10)).toEqual([]);

    // Invalid IDs safely return null
    expect(await saveDocCollabReplica(0, 42, { snapshot: bytes, seq: 1 })).toBeNull();
    expect(await loadDocCollabReplica(-1, 42)).toBeNull();
  });

  it("queues and compacts repeated offline sheet edits per (worksheetId, row, col)", async () => {
    await queueSheetOfflineCells(1, 7, {
      worksheetId: 100,
      baseRevision: 5,
      edits: [
        { row: 0, col: 0, raw: "初始值", updatedAt: 1000 },
        { row: 0, col: 1, raw: "100", updatedAt: 1100 },
      ],
    });

    // Second offline edit updates (0,0) and adds a cell in another worksheet
    const updated = await queueSheetOfflineCells(1, 7, {
      worksheetId: 100,
      baseRevision: 99, // preserves original baseRevision = 5!
      edits: [
        { row: 0, col: 0, raw: "最终值", updatedAt: 2000 },
        { worksheetId: 200, row: 0, col: 0, raw: "表2内容", updatedAt: 2100 },
      ],
    });

    expect(updated?.key).toBe("sheet:1:7");
    expect(updated?.baseRevision).toBe(5);
    expect(updated?.edits).toHaveLength(3);
    expect(updated?.edits).toEqual([
      { worksheetId: 100, row: 0, col: 0, raw: "最终值", updatedAt: 2000 },
      { worksheetId: 100, row: 0, col: 1, raw: "100", updatedAt: 1100 },
      { worksheetId: 200, row: 0, col: 0, raw: "表2内容", updatedAt: 2100 },
    ]);

    const loaded = await loadSheetOfflineCells(1, 7);
    expect(loaded).toEqual(updated);

    await deleteSheetOfflineCells(1, 7);
    expect(await loadSheetOfflineCells(1, 7)).toBeNull();
  });

  it("mergeSheetOfflineCells applies LWW per (worksheetId, row, col) with accurate conflict detection metadata", () => {
    const remoteCells = [
      // Unchanged relative to baseRevision=5 -> clean local overwrite (no conflict)
      { worksheetId: 1, row: 0, col: 0, raw: "Old", revision: 5, updatedAt: 1000 },
      // Changed remotely (rev 6 > 5) AND older than local -> local wins with conflict metadata
      { worksheetId: 1, row: 0, col: 1, raw: "RemoteOlder", revision: 6, updatedAt: 2000 },
      // Changed remotely (rev 7 > 5) AND newer than local -> remote wins with conflict metadata
      { worksheetId: 1, row: 0, col: 2, raw: "RemoteNewer", revision: 7, updatedAt: 5000 },
      // Both edited to identical value -> converged, zero conflict
      { worksheetId: 1, row: 1, col: 0, raw: "Same", revision: 6, updatedAt: 2500 },
      // Remote-only cell -> preserved
      { worksheetId: 1, row: 2, col: 0, raw: "RemoteOnly", revision: 6, updatedAt: 2600 },
      // Different worksheet at same (0,1) -> isolated!
      { worksheetId: 2, row: 0, col: 1, raw: "Sheet2Remote", revision: 5, updatedAt: 1000 },
    ];

    const localEdits = [
      { worksheetId: 1, row: 0, col: 0, raw: "CleanLocal", updatedAt: 3000 },
      { worksheetId: 1, row: 0, col: 1, raw: "LocalNewer", updatedAt: 4000 },
      { worksheetId: 1, row: 0, col: 2, raw: "LocalOlder", updatedAt: 3500 },
      { worksheetId: 1, row: 1, col: 0, raw: "Same", updatedAt: 3600 },
      // Local-only new cell
      { worksheetId: 1, row: 3, col: 0, raw: "LocalOnly", updatedAt: 3700 },
    ];

    const result = mergeSheetOfflineCells(remoteCells, localEdits, {
      worksheetId: 1,
      baseRevision: 5,
    });

    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts[0]).toMatchObject({
      worksheetId: 1,
      row: 0,
      col: 1,
      localRaw: "LocalNewer",
      remoteRaw: "RemoteOlder",
      winner: "local",
      resolvedRaw: "LocalNewer",
    });
    expect(result.conflicts[1]).toMatchObject({
      worksheetId: 1,
      row: 0,
      col: 2,
      localRaw: "LocalOlder",
      remoteRaw: "RemoteNewer",
      winner: "remote",
      resolvedRaw: "RemoteNewer",
    });

    const cellMap = new Map(
      result.merged.map((c) => [`${c.worksheetId}:${c.row}:${c.col}`, c]),
    );
    expect(cellMap.get("1:0:0")).toMatchObject({ raw: "CleanLocal", source: "local" });
    expect(cellMap.get("1:0:1")).toMatchObject({ raw: "LocalNewer", source: "local" });
    expect(cellMap.get("1:0:2")).toMatchObject({ raw: "RemoteNewer", source: "remote" });
    expect(cellMap.get("1:1:0")).toMatchObject({ raw: "Same", source: "converged" });
    expect(cellMap.get("1:2:0")).toMatchObject({ raw: "RemoteOnly", source: "remote" });
    expect(cellMap.get("1:3:0")).toMatchObject({ raw: "LocalOnly", source: "local" });
    expect(cellMap.get("2:0:1")).toMatchObject({ raw: "Sheet2Remote", source: "remote" });
    expect(result.localWins).toBe(3); // 1:0:0, 1:0:1, 1:3:0
    expect(result.remoteWins).toBe(1); // 1:0:2

    // Also verifies baseCells-based conflict detection (no revision numbers)
    const baseCheck = mergeSheetOfflineCells(
      [{ row: 0, col: 0, raw: "Original", updatedAt: 1000 }],
      [{ row: 0, col: 0, raw: "Edited", updatedAt: 2000 }],
      { worksheetId: 1, baseCells: [{ row: 0, col: 0, raw: "Original" }] },
    );
    expect(baseCheck.conflicts).toEqual([]);
    expect(baseCheck.merged[0]).toMatchObject({ raw: "Edited", source: "local" });
  });

  it("flushes batched offline sheet cells to /api/sheets/{id}/cells and clears on success", async () => {
    await queueSheetOfflineCells(3, 88, {
      worksheetId: 10,
      baseRevision: 2,
      edits: [
        { row: 1, col: 2, rowId: 11, columnId: 22, raw: "=SUM(A1:A5)", updatedAt: 1000 },
        { row: 2, col: 2, rowId: 12, columnId: 22, raw: "420", updatedAt: 1050 },
      ],
    });

    const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn<OfflineCollabFetcher>(async (url, init) => {
      requests.push({
        url,
        method: String(init.method),
        body: JSON.parse(String(init.body)),
      });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          conflicts: [
            { row: 2, col: 2, attemptedRaw: "420", currentRaw: "500", reason: "value_conflict" },
          ],
        }),
      };
    });

    const res = await flushSheetOfflineCells(3, 88, fetcher);
    expect(res.flushed).toBe(1);
    expect(res.cellsFlushed).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]).toMatchObject({
      kind: "sheet",
      resourceId: 88,
      worksheetId: 10,
      row: 2,
      col: 2,
      localRaw: "420",
      remoteRaw: "500",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/sheets/88/cells");
    expect(requests[0].method).toBe("POST");
    expect(requests[0].body.worksheetId).toBe(10);
    expect(requests[0].body.mergeMode).toBe("auto");
    expect(Array.isArray(requests[0].body.cells)).toBe(true);
    expect((requests[0].body.cells as unknown[]).length).toBe(2);

    // Cleared from IndexedDB after successful flush
    expect(await loadSheetOfflineCells(3, 88)).toBeNull();
  });

  it("retains offline sheet edits on 5xx / 409 failures and reports conflicts", async () => {
    await queueSheetOfflineCells(3, 89, {
      worksheetId: 10,
      baseRevision: 4,
      edits: [
        { worksheetId: 10, row: 0, col: 0, raw: "OK", updatedAt: 1000 },
        { worksheetId: 20, row: 0, col: 0, raw: "Conflict", updatedAt: 1100 },
      ],
    });

    const fetcher = vi.fn<OfflineCollabFetcher>(async (_url, init) => {
      const parsed = JSON.parse(String(init.body)) as { worksheetId: number };
      if (parsed.worksheetId === 10) {
        return { ok: true, status: 200, statusText: "OK" };
      }
      return { ok: false, status: 409, statusText: "Conflict" };
    });

    const res = await flushSheetOfflineCells(3, 89, fetcher);
    expect(res.flushed).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.conflicts).toEqual([
      { kind: "sheet", resourceId: 89, worksheetId: 20, reason: "revision_conflict" },
    ]);

    // Only worksheet 20's edit remains queued
    const remaining = await loadSheetOfflineCells(3, 89);
    expect(remaining?.edits).toHaveLength(1);
    expect(remaining?.edits[0].worksheetId).toBe(20);
  });

  it("queues, loads, selectively deletes, and replays offline slides drafts across multiple pages", async () => {
    await queueSlidesOfflinePage(5, 30, {
      pageId: 101,
      title: "封面",
      shapesJson: JSON.stringify([{ id: "s1", kind: "rectangle", x: 10, y: 20 }]),
      baseRevision: 3,
      updatedAt: 1000,
    });
    await queueSlidesOfflinePage(5, 30, {
      pageId: 102,
      title: "第二页",
      shapesJson: JSON.stringify([{ id: "s2", kind: "text", text: "离线要点" }]),
      baseRevision: 1,
      updatedAt: 2000,
    });

    const deckDraft = await loadSlidesOfflinePage(5, 30);
    expect(deckDraft?.key).toBe("slides:5:30");
    expect(deckDraft?.pageId).toBe(102);

    const page101 = await loadSlidesOfflinePage(5, 30, 101);
    expect(page101?.pageId).toBe(101);
    expect(page101?.title).toBe("封面");

    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn<OfflineCollabFetcher>(async (url, init) => {
      calls.push({ url, method: String(init.method), body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, statusText: "OK" };
    });

    const res = await flushSlidesOfflinePage(5, 30, fetcher);
    expect(res).toEqual({ flushed: 2, failed: 0, conflicts: [] });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH /api/slides/30/pages/101/content",
      "PATCH /api/slides/30/pages/102/content",
    ]);
    expect(calls[0].body.expectedRevision).toBe(3);
    expect(calls[0].body.shapes).toEqual([{ id: "s1", kind: "rectangle", x: 10, y: 20 }]);
    expect(await loadSlidesOfflinePage(5, 30)).toBeNull();

    // Verify single-page deletion retains sibling page
    await queueSlidesOfflinePage(5, 31, { pageId: 201, shapesJson: "[]", baseRevision: 1, updatedAt: 100 });
    await queueSlidesOfflinePage(5, 31, { pageId: 202, shapesJson: "[]", baseRevision: 1, updatedAt: 200 });
    await deleteSlidesOfflinePage(5, 31, 201);
    expect(await loadSlidesOfflinePage(5, 31, 201)).toBeNull();
    expect((await loadSlidesOfflinePage(5, 31, 202))?.pageId).toBe(202);
  });

  it("flushAllOfflineCollab flushes both sheet and slides deltas and summarizes offline collab state", async () => {
    const doc = new Doc(1);
    doc.createBlock("paragraph");
    await saveDocCollabReplica(1, 5, {
      snapshot: doc.encodeState(),
      seq: 3,
      historyEpoch: 1,
      pendingOpsCount: 4,
    });
    await queueSheetOfflineCells(1, 12, {
      worksheetId: 1,
      baseRevision: 1,
      edits: [{ row: 0, col: 0, raw: "A1", updatedAt: 1000 }],
    });
    await queueSlidesOfflinePage(1, 22, {
      pageId: 1,
      shapesJson: JSON.stringify([{ id: "shape-1", kind: "ellipse" }]),
      baseRevision: 2,
      updatedAt: 2000,
    });

    const before = await getOfflineCollabSummary();
    expect(before).toEqual({
      totalCount: 3,
      docReplicaCount: 1,
      docPendingOpsCount: 4,
      sheetDeltaCount: 1,
      sheetEditCount: 1,
      slidesDraftCount: 1,
      pendingMergeCount: 3,
    });

    const fetcher = vi.fn<OfflineCollabFetcher>(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
    }));

    const result = await flushAllOfflineCollab(fetcher);
    expect(result).toEqual({ flushed: 2, failed: 0, conflicts: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const after = await getOfflineCollabSummary();
    expect(after).toEqual({
      totalCount: 1,
      docReplicaCount: 1,
      docPendingOpsCount: 4,
      sheetDeltaCount: 0,
      sheetEditCount: 0,
      slidesDraftCount: 0,
      pendingMergeCount: 1,
    });
  });
});
