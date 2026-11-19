import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { BaseUndoStack, groupByRecord, sameCell, type UndoApi, type UndoCellValue } from "./undo";

function fakeApi() {
  const rows = new Map<number, Record<string, UndoCellValue>>([[1, { "10": "a" }]]);
  let next = 100;
  const conflict = () => new ApiError(409, "cells_changed", "changed");
  const api: UndoApi = {
    setCellsIf: async (rid, expected, cells) => {
      const row = rows.get(rid);
      if (!row) throw new ApiError(404, "not_found", "x");
      for (const [k, v] of Object.entries(expected)) if (!sameCell(row[k], v)) throw conflict();
      for (const [k, v] of Object.entries(cells)) { if (v === null) delete row[k]; else row[k] = v; }
    },
    deleteRecordIf: async (rid, expected) => {
      const row = rows.get(rid)!;
      const keys = Object.keys(row);
      if (keys.length !== Object.keys(expected).length || keys.some((k) => !sameCell(row[k], expected[k]))) throw conflict();
      rows.delete(rid);
    },
    addRecord: async (cells) => { const id = next++; const stored = { ...cells, "99": "默认" }; rows.set(id, stored); return { id, cells: { ...stored } }; },
  };
  return { rows, api };
}

describe("base undo/redo", () => {
  it("groups changes per record with the value that must be present", () => {
    const g = groupByRecord([{ rid: 1, fid: 10, before: "a", after: "b" }, { rid: 1, fid: 11, before: null, after: 3 }], "before");
    expect(g.get(1)).toEqual({ expected: { "10": "b", "11": 3 }, cells: { "10": "a", "11": null } });
  });
  it("undoes and redoes a cell edit through conditional writes", async () => {
    const { rows, api } = fakeApi();
    const stack = new BaseUndoStack();
    rows.get(1)!["10"] = "b";
    stack.record({ label: "编辑", cells: [{ rid: 1, fid: 10, before: "a", after: "b" }], created: [] });
    expect(await stack.undo(api)).toEqual({ ok: true, label: "编辑" });
    expect(rows.get(1)!["10"]).toBe("a");
    expect(stack.canRedo).toBe(true);
    expect(await stack.redo(api)).toEqual({ ok: true, label: "编辑" });
    expect(rows.get(1)!["10"]).toBe("b");
  });
  it("refuses to overwrite a newer edit and drops the step", async () => {
    const { rows, api } = fakeApi();
    const stack = new BaseUndoStack();
    stack.record({ label: "编辑", cells: [{ rid: 1, fid: 10, before: "a", after: "b" }], created: [] });
    rows.get(1)!["10"] = "别人改的";
    expect(await stack.undo(api)).toEqual({ ok: false, label: "编辑", conflict: true });
    expect(rows.get(1)!["10"]).toBe("别人改的");
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
  });
  it("undoes a created record only while untouched, and redo re-creates it", async () => {
    const { rows, api } = fakeApi();
    const stack = new BaseUndoStack();
    const added = await api.addRecord({ "10": "新" });
    stack.record({ label: "新增记录", cells: [], created: [{ rid: added.id, cells: added.cells as Record<string, UndoCellValue> }] });
    expect((await stack.undo(api))?.ok).toBe(true);
    expect(rows.has(added.id)).toBe(false);
    expect((await stack.redo(api))?.ok).toBe(true);
    const recreated = [...rows.keys()].find((id) => id !== 1)!;
    expect(rows.get(recreated)).toEqual({ "10": "新", "99": "默认" });
    rows.get(recreated)!["10"] = "被改";
    expect(await stack.undo(api)).toMatchObject({ ok: false, conflict: true });
    expect(rows.has(recreated)).toBe(true);
  });
  it("ignores no-op steps and clears redo on a new step", async () => {
    const { rows, api } = fakeApi();
    const stack = new BaseUndoStack();
    stack.record({ label: "空", cells: [{ rid: 1, fid: 10, before: "", after: null }], created: [] });
    expect(stack.canUndo).toBe(false);
    rows.get(1)!["10"] = "b";
    stack.record({ label: "一", cells: [{ rid: 1, fid: 10, before: "a", after: "b" }], created: [] });
    await stack.undo(api);
    stack.record({ label: "二", cells: [{ rid: 1, fid: 10, before: "a", after: "c" }], created: [] });
    expect(stack.canRedo).toBe(false);
  });

  it("undoes and redoes atomic batch record deletion via restore/delete", async () => {
    const rows = new Map<number, { tableId?: number; position: number; cells: Record<string, UndoCellValue> }>([
      [10, { tableId: 1, position: 1, cells: { "1": "Alpha" } }],
      [11, { tableId: 1, position: 2, cells: { "1": "Beta" } }],
    ]);
    let nextId = 200;
    const api: UndoApi = {
      setCellsIf: async () => {},
      deleteRecordIf: async () => {},
      addRecord: async () => ({ id: nextId++, cells: {} }),
      batchDeleteRecords: async (ids) => {
        const deleted = ids.map((id) => {
          const r = rows.get(id)!;
          rows.delete(id);
          return { id, tableId: r.tableId, position: r.position, cells: { ...r.cells } };
        });
        return { deleted };
      },
      batchRestoreRecords: async (recs) => {
        const records = recs.map((r) => {
          const id = nextId++;
          rows.set(id, { tableId: r.tableId, position: r.position, cells: { ...r.cells } });
          return { id, tableId: r.tableId, position: r.position, cells: { ...r.cells } };
        });
        return { records };
      },
    };
    const stack = new BaseUndoStack();
    const res = await api.batchDeleteRecords!([10, 11]);
    stack.record({
      label: "删除 2 条记录",
      cells: [],
      created: [],
      deleted: res.deleted.map((r) => ({ rid: r.id, tableId: r.tableId, position: r.position, cells: r.cells as Record<string, UndoCellValue> })),
    });
    expect(rows.size).toBe(0);
    expect((await stack.undo(api))?.ok).toBe(true);
    expect(rows.size).toBe(2);
    expect([...rows.values()].map((r) => r.cells["1"])).toEqual(["Alpha", "Beta"]);
    expect((await stack.redo(api))?.ok).toBe(true);
    expect(rows.size).toBe(0);
  });

  it("uses atomic batchUpdateCells when undoing multi-record cell edits", async () => {
    const rows = new Map<number, Record<string, UndoCellValue>>([[1, { "10": "x2" }], [2, { "10": "y2" }]]);
    let batchCalls = 0;
    const api: UndoApi = {
      setCellsIf: async () => { throw new Error("should use batchUpdateCells"); },
      deleteRecordIf: async () => {},
      addRecord: async () => ({ id: 99, cells: {} }),
      batchUpdateCells: async (updates) => {
        batchCalls++;
        for (const u of updates) {
          const row = rows.get(u.id)!;
          for (const [k, v] of Object.entries(u.expected)) if (!sameCell(row[k], v)) throw new ApiError(409, "cells_changed", "changed");
        }
        for (const u of updates) {
          const row = rows.get(u.id)!;
          for (const [k, v] of Object.entries(u.cells)) row[k] = v;
        }
      },
    };
    const stack = new BaseUndoStack();
    stack.record({
      label: "粘贴",
      cells: [
        { rid: 1, fid: 10, before: "x1", after: "x2" },
        { rid: 2, fid: 10, before: "y1", after: "y2" },
      ],
      created: [],
    });
    expect((await stack.undo(api))?.ok).toBe(true);
    expect(batchCalls).toBe(1);
    expect(rows.get(1)!["10"]).toBe("x1");
    expect(rows.get(2)!["10"]).toBe("y1");
  });
});
