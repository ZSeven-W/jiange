import { describe, expect, it } from "vitest";
import type { SheetCellConflict, SheetSnapshot } from "@/lib/api";
import {
  applyRemoteCellDelta,
  buildConflictResolutionWrite,
  formatSheetCellAddress,
  formatSheetRect,
  remoteCollaboratorBounds,
  toSheetStylePatch,
} from "./sheet-collab";

const makeSnapshot = (wbRev = 3): SheetSnapshot => ({
  nodeId: 1,
  workspaceId: 1,
  parentId: null,
  title: "Test Sheet",
  role: "edit",
  creatorId: 1,
  creatorName: "Alice",
  driveRevision: 1,
  workbookRevision: wbRev,
  updatedAt: "2026-11-20T00:00:00Z",
  sheets: [
    {
      id: 10,
      nodeId: 1,
      title: "Sheet1",
      pos: 0,
      frozenRows: 0,
      frozenCols: 0,
      merges: [],
      filter: {},
      validations: [],
      conditionalFormats: [],
      protectedRanges: [],
      revision: 3,
      rows: [{ id: 101, pos: 0 }, { id: 102, pos: 1 }],
      columns: [{ id: 201, pos: 0 }, { id: 202, pos: 1 }],
      cells: [{ rowId: 101, columnId: 201, raw: "old", style: { bold: true }, revision: 1 }],
    },
  ],
});

describe("sheet-collab helpers", () => {
  it("converts partial style updates including border clearing into sparse SheetStylePatch", () => {
    expect(toSheetStylePatch({ bold: true, bg: "#fff2cc" })).toEqual({ bold: true, bg: "#fff2cc" });
    expect(toSheetStylePatch({ borders: undefined })).toEqual({ clearBorders: true });
    expect(toSheetStylePatch({ borders: { top: true, right: true, bottom: true, left: true } })).toEqual({
      borders: { top: true, right: true, bottom: true, left: true },
    });
  });

  it("applies contiguous WebSocket cell deltas in place and returns null on revision gaps", () => {
    const snap = makeSnapshot(3);
    const next = applyRemoteCellDelta(snap, 10, 4, [
      { rowId: 101, columnId: 201, revision: 2, raw: "merged", style: { bold: true, bg: "#e8f3ff" }, merged: true },
      { rowId: 102, columnId: 202, revision: 1, raw: "newCell", style: {} },
    ]);
    expect(next).not.toBeNull();
    expect(next!.workbookRevision).toBe(4);
    expect(next!.sheets[0].cells).toHaveLength(2);
    expect(next!.sheets[0].cells.find((c) => c.rowId === 101)?.raw).toBe("merged");
    expect(next!.sheets[0].cells.find((c) => c.rowId === 101)?.style?.bg).toBe("#e8f3ff");

    // Non-contiguous revision gap forces caller to refetch.
    expect(applyRemoteCellDelta(snap, 10, 6, [{ rowId: 101, columnId: 201, revision: 3, raw: "gap" }])).toBeNull();
    // Stale revision is ignored cleanly.
    expect(applyRemoteCellDelta(snap, 10, 3, [{ rowId: 101, columnId: 201, revision: 1, raw: "stale" }])).toBe(snap);
  });

  it("computes collaborator region bounds and cell/rect addresses", () => {
    expect(formatSheetCellAddress(0, 0)).toBe("A1");
    expect(formatSheetRect({ top: 1, left: 1, bottom: 3, right: 2 })).toBe("B2:C4");
    expect(remoteCollaboratorBounds({ userId: 2, name: "Bob", worksheetId: 10, row: 4, col: 5, anchorRow: 2, anchorCol: 1, editing: true })).toEqual({
      top: 2,
      bottom: 4,
      left: 1,
      right: 5,
    });
  });

  it("builds rebased writes for value conflicts and merge-slave anchor redirection", () => {
    const valConflict: SheetCellConflict = {
      rowId: 101,
      columnId: 201,
      row: 0,
      col: 0,
      expectedRevision: 1,
      currentRevision: 2,
      currentRaw: "Alice",
      attemptedRaw: "Bob",
      reason: "value_conflict",
    };
    expect(buildConflictResolutionWrite(valConflict, "mine")).toEqual({
      rowId: 101,
      columnId: 201,
      expectedRevision: 2,
      raw: "Bob",
    });

    const slaveConflict: SheetCellConflict = {
      rowId: 102,
      columnId: 202,
      row: 1,
      col: 1,
      expectedRevision: 0,
      currentRevision: 0,
      currentRaw: "",
      attemptedRaw: "RedirectMe",
      reason: "merge_slave_conflict",
      mergeRect: { top: 0, left: 0, bottom: 1, right: 1 },
      anchorRowId: 101,
      anchorColumnId: 201,
      anchorRaw: "Header",
      anchorRevision: 3,
    };
    expect(buildConflictResolutionWrite(slaveConflict, "anchor")).toEqual({
      rowId: 101,
      columnId: 201,
      expectedRevision: 3,
      raw: "RedirectMe",
    });
  });
});
