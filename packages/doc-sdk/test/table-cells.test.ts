import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager, type Op } from "@jiange/collab";
import { applyTableWrites, cellGrid, cellTableWrites, stableTableDeleteWrites, stableTableInsertWrites, stableTableReorderWrites, tableDataOf, tableHash, tableRepairWrites, tableRowsOf, writeTable } from "../src/table-cells.js";
import { applyTableEdit } from "../src/model.js";

function replicas() {
  const a = new Doc(1), b = new Doc(2);
  const tx = new Tx(a);
  const table = tx.create("table", null, ROOT, { tableData: JSON.stringify([["", ""], ["", ""]]) });
  for (const op of tx.ops) b.apply(op);
  return { a, b, table };
}
const sync = (from: Op[], to: Doc) => { for (const op of from) to.apply(op); };
const edit = (doc: Doc, table: ReturnType<typeof replicas>["table"], r: number, c: number, v: string) => {
  const tx = new Tx(doc);
  const props = doc.blockInfo(table).props;
  writeTable(tx, table, props, applyTableEdit(tableRowsOf(props), r, c, v), doc.client);
  return tx.ops;
};
const repair = (doc: Doc, table: ReturnType<typeof replicas>["table"]) => {
  const props = doc.blockInfo(table).props;
  const writes = tableRepairWrites(props, doc.client);
  const tx = new Tx(doc);
  if (writes) applyTableWrites(tx, table, props, writes);
  return tx.ops;
};

describe("cell-level table storage", () => {
  it("clears inherited legacy text while retaining a concurrent edit in another cell", () => {
    const a = new Doc(1), b = new Doc(2), init = new Tx(a);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify([["旧内容", "另一格"]]) });
    sync(init.ops, b);
    const clear = edit(a, table, 0, 0, "");
    const other = edit(b, table, 0, 1, "协作者");
    expect(clear.some((op) => op.t === "bset" && op.key === "tbl.c.r0.c0" && op.value === "")).toBe(true);
    sync(clear, b); sync(other, a);
    expect(tableRowsOf(a.blockInfo(table).props)).toEqual([["", "协作者"]]);
    expect(tableRowsOf(b.blockInfo(table).props)).toEqual([["", "协作者"]]);
  });
  it("undoes and redoes a structural clear of an inherited cell", () => {
    const doc = new Doc(1), init = new Tx(doc);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify([["原始", "其他"]]) });
    edit(doc, table, 0, 1, "已迁移");
    const before = doc.blockInfo(table).props, tx = new Tx(doc), undo = new UndoManager();
    writeTable(tx, table, before, [["", "已迁移"]], doc.client);
    undo.record(tx, null, null, "prop");
    expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["", "已迁移"]]);
    expect(undo.undo(doc)).not.toBeNull();
    expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["原始", "已迁移"]]);
    expect(undo.redo(doc)).not.toBeNull();
    expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["", "已迁移"]]);
  });
  it("repairs an old client's explicit clear of inherited text", () => {
    const doc = new Doc(1), init = new Tx(doc);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify([["原始", "其他"]]) });
    edit(doc, table, 0, 1, "已迁移");
    const legacy = new Tx(doc);
    legacy.setProp(table, "tableData", JSON.stringify([["", "已迁移"]]));
    repair(doc, table);
    expect(cellGrid(doc.blockInfo(table).props)).toEqual([["", "已迁移"]]);
    expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["", "已迁移"]]);
  });
  it("keeps both users' edits to different cells (the old whole-table LWW lost one)", () => {
    const { a, b, table } = replicas();
    // Both migrate concurrently from the same legacy table, then edit different cells.
    const opsA = edit(a, table, 0, 0, "甲");
    const opsB = edit(b, table, 1, 1, "乙");
    sync(opsA, b); sync(opsB, a);
    const rowsA = tableRowsOf(a.blockInfo(table).props), rowsB = tableRowsOf(b.blockInfo(table).props);
    expect(rowsA).toEqual(rowsB);
    // Deterministic migration IDs: concurrent first edits both survive.
    expect(rowsA).toEqual([["甲", ""], ["", "乙"]]);
    const { a: a2, b: b2, table: t2 } = replicas();
    sync(edit(a2, t2, 0, 1, "预迁移"), b2);
    const x = edit(a2, t2, 0, 0, "甲"), y = edit(b2, t2, 1, 1, "乙");
    sync(x, b2); sync(y, a2);
    expect(tableRowsOf(a2.blockInfo(t2).props)).toEqual([["甲", "预迁移"], ["", "乙"]]);
    expect(tableRowsOf(b2.blockInfo(t2).props)).toEqual([["甲", "预迁移"], ["", "乙"]]);
  });
  it("repairs a stale mirror so legacy readers (and old clients) see both edits", () => {
    const { a, b, table } = replicas();
    sync(edit(a, table, 0, 0, "x"), b);
    const x = edit(a, table, 0, 1, "甲"), y = edit(b, table, 1, 0, "乙");
    sync(x, b); sync(y, a);
    const fix = repair(a, table);
    expect(fix.length).toBeGreaterThan(0);
    sync(fix, b);
    const props = b.blockInfo(table).props;
    expect(JSON.parse(props.tableData)).toEqual([["x", "甲"], ["乙", ""]]);
    expect(props["tbl.m"]).toBe(tableHash(props.tableData));
    expect(repair(b, table)).toEqual([]);
  });
  it("adopts an old client's direct tableData write and re-seeds the cells", () => {
    const { a, b, table } = replicas();
    sync(edit(a, table, 0, 0, "新"), b);
    // An old client only knows tableData.
    const old = new Tx(b);
    old.setProp(table, "tableData", JSON.stringify([["旧客户端", ""], ["", ""], ["多一行", ""]]));
    sync(old.ops, a);
    expect(tableRowsOf(a.blockInfo(table).props)).toEqual([["旧客户端", ""], ["", ""], ["多一行", ""]]);
    sync(repair(a, table), b);
    const props = b.blockInfo(table).props;
    expect(cellGrid(props)).toEqual([["旧客户端", ""], ["", ""], ["多一行", ""]]);
    expect(tableDataOf(props)).toBe(props.tableData);
  });
  it("uses the same fingerprint as the Go search index", () => {
    expect(tableHash('[["甲",""]]')).toBe("ed7ec732");
  });
  it("leaves legacy tables untouched until first edit", () => {
    const { a, table } = replicas();
    expect(tableRepairWrites(a.blockInfo(table).props, 1)).toBeNull();
    expect(tableDataOf(a.blockInfo(table).props)).toBe(JSON.stringify([["", ""], ["", ""]]));
  });
});

describe("stable table axis insertion and deletion", () => {
  it("inserts a blank axis and keeps delayed edits and formatting on their original cells", async () => {
    const { setTableCellFills, tableCellFill } = await import('../src/table-cells.js');
    const a = new Doc(1), b = new Doc(2), init = new Tx(a);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]) });
    sync(init.ops, b); sync(edit(a, table, 0, 0, "甲"), b);
    const color = new Tx(a); setTableCellFills(color, table, [{ row: 1, col: 1, fill: "#E3ECFF" }]); sync(color.ops, b);
    const before = a.blockInfo(table).props, insert = new Tx(a);
    applyTableWrites(insert, table, before, stableTableInsertWrites(before, "row", 1, "a1_100")!);
    expect(insert.ops.every(op => op.t === "bset" && !op.key.startsWith("tbl.c.") && !op.key.startsWith("tbl.fill."))).toBe(true);
    const delayed = edit(b, table, 1, 1, "远程编辑");
    sync(insert.ops, b); sync(delayed, a);
    for (const doc of [a, b]) {
      expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["甲", "B"], ["", ""], ["C", "远程编辑"]]);
      expect(tableCellFill(doc.blockInfo(table).props, 2, 1)).toBe("#E3ECFF");
      expect(tableCellFill(doc.blockInfo(table).props, 1, 1)).toBe("");
    }
  });
  it("retains delayed edits to a removed axis as hidden registers", () => {
    const a = new Doc(1), b = new Doc(2), init = new Tx(a);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]) });
    sync(init.ops, b); sync(edit(a, table, 0, 0, "甲"), b);
    const before = a.blockInfo(table).props, deletion = new Tx(a);
    applyTableWrites(deletion, table, before, stableTableDeleteWrites(before, "row", [0])!);
    const delayed = edit(b, table, 0, 1, "迟到的修改");
    sync(deletion.ops, b); sync(delayed, a);
    for (const doc of [a, b]) {
      const props = doc.blockInfo(table).props;
      expect(tableRowsOf(props)).toEqual([["C", "D"]]);
      expect(props['tbl.c.r0.c1']).toBe("迟到的修改");
    }
  });
  it("keeps a delayed edit on its original column after inserting a new one", () => {
    const a = new Doc(1), b = new Doc(2), init = new Tx(a);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]) });
    sync(init.ops, b); sync(edit(a, table, 0, 0, "甲"), b);
    const before = a.blockInfo(table).props, insert = new Tx(a);
    applyTableWrites(insert, table, before, stableTableInsertWrites(before, "column", 0, "a1_101")!);
    const delayed = edit(b, table, 1, 1, "远程");
    sync(delayed, a); sync(insert.ops, b);
    for (const doc of [a, b]) expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["", "甲", "B"], ["", "C", "远程"]]);
  });
  it("does not transfer delayed formatting from a deleted row to its successor", async () => {
    const { setTableCellFills, tableCellFill } = await import('../src/table-cells.js');
    const { a, b, table } = replicas(); sync(edit(a, table, 0, 0, "甲"), b);
    const props = a.blockInfo(table).props, deletion = new Tx(a), color = new Tx(b);
    applyTableWrites(deletion, table, props, stableTableDeleteWrites(props, "row", [0])!);
    setTableCellFills(color, table, [{ row: 0, col: 1, fill: "#E5F5E8" }]);
    sync(color.ops, a); sync(deletion.ops, b);
    for (const doc of [a, b]) {
      expect(doc.blockInfo(table).props['tbl.fill.r0.c1']).toBe('#E5F5E8');
      expect(tableCellFill(doc.blockInfo(table).props, 0, 1)).toBe('');
    }
  });
  it("preserves surviving identities when deleting multiple columns", async () => {
    const { setTableCellFills, tableCellFill } = await import('../src/table-cells.js');
    const doc = new Doc(1), tx = new Tx(doc), table = tx.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B", "C", "D"]]) });
    edit(doc, table, 0, 0, "甲");
    const color = new Tx(doc); setTableCellFills(color, table, [{ row: 0, col: 3, fill: "#E5F5E8" }]);
    const props = doc.blockInfo(table).props, deletion = new Tx(doc);
    applyTableWrites(deletion, table, props, stableTableDeleteWrites(props, "column", [0, 2])!);
    expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["B", "D"]]);
    expect(tableCellFill(doc.blockInfo(table).props, 0, 1)).toBe("#E5F5E8");
    expect(deletion.ops.every(op => op.t === "bset" && !op.key.startsWith("tbl.c.") && !op.key.startsWith("tbl.fill."))).toBe(true);
  });
  it("rejects invalid, stale and reused identities before writing", () => {
    const { a, table } = replicas(); edit(a, table, 0, 0, "甲");
    const props = a.blockInfo(table).props;
    expect(stableTableInsertWrites(props, "row", -1, "a1_1")).toBeNull();
    expect(stableTableInsertWrites(props, "column", 1, "c0")).toBeNull();
    expect(stableTableInsertWrites({ ...props, 'tbl.c.a1_1.c0': 'orphan' }, "row", 1, "a1_1")).toBeNull();
    expect(stableTableInsertWrites({ ...props, tableData: '[["legacy"]]' }, "row", 1, "a1_1")).toBeNull();
    expect(stableTableDeleteWrites(props, "row", [0, 0])).toBeNull();
    expect(stableTableDeleteWrites(props, "row", [0, 1])).toBeNull();
    expect(stableTableDeleteWrites(props, "column", [2])).toBeNull();
  });
  it("refuses insertions beyond the table resource limits", () => {
    const grid = Array.from({ length: 200 }, () => Array(25).fill(""));
    const props: Record<string, string> = { tableData: JSON.stringify(grid) };
    Object.assign(props, cellTableWrites(props, grid, 1));
    expect(stableTableInsertWrites(props, "row", 0, "a1_100")).toBeNull();
    expect(stableTableInsertWrites(props, "column", 0, "a1_101")).toBeNull();
  });
});

describe('cell background fills', () => {
  it('keeps concurrent colors in different cells and rejects invalid color values', async () => {
    const { setTableCellFills, tableCellFill } = await import('../src/table-cells.js');
    const { a, b, table } = replicas();
    sync(edit(a, table, 0, 0, '文本'), b);
    const first = new Tx(a), second = new Tx(b);
    setTableCellFills(first, table, [{ row: 0, col: 0, fill: '#fbe4e2' }]);
    setTableCellFills(second, table, [{ row: 1, col: 1, fill: '#E3ECFF' }]);
    sync(first.ops, b); sync(second.ops, a);
    for (const doc of [a, b]) {
      expect(tableCellFill(doc.blockInfo(table).props, 0, 0)).toBe('#FBE4E2');
      expect(tableCellFill(doc.blockInfo(table).props, 1, 1)).toBe('#E3ECFF');
    }
    const invalid = new Tx(a);
    expect(() => setTableCellFills(invalid, table, [{ row: 0, col: 0, fill: '#FBE4E2' }, { row: 0, col: 1, fill: 'url(evil)' }])).toThrow();
    expect(invalid.ops).toEqual([]);
  });
});

describe('cell alignment', () => {
  it('merges concurrent changes to separate axes, and rejects an invalid batch without partial writes', async () => {
    const { setTableCellAlignments, tableCellAlign } = await import('../src/table-cells.js');
    const { a, b, table } = replicas();
    sync(edit(a, table, 0, 0, '文字'), b);
    const first = new Tx(a), second = new Tx(b);
    setTableCellAlignments(first, table, [{ row: 0, col: 0, axis: 'horizontal', align: 'right' }]);
    setTableCellAlignments(second, table, [{ row: 0, col: 0, axis: 'vertical', align: 'bottom' }]);
    sync(first.ops, b); sync(second.ops, a);
    for (const doc of [a, b]) {
      expect(tableCellAlign(doc.blockInfo(table).props, 0, 0, 'horizontal')).toBe('right');
      expect(tableCellAlign(doc.blockInfo(table).props, 0, 0, 'vertical')).toBe('bottom');
      expect(tableCellAlign(doc.blockInfo(table).props, 0, 1, 'horizontal')).toBe('left');
    }
    const tx = new Tx(a);
    expect(() => setTableCellAlignments(tx, table, [{ row: 0, col: 0, axis: 'horizontal', align: 'left' }, { row: 0, col: 1, axis: 'horizontal', align: 'bottom' }])).toThrow();
    expect(tx.ops).toEqual([]);
    setTableCellAlignments(tx, table, [{ row: 0, col: 0, axis: 'horizontal', align: 'left' }]);
    expect(tableCellAlign(a.blockInfo(table).props, 0, 0, 'horizontal')).toBe('left');
  });
});

describe("stable table axis reorder", () => {
  it("moves row and column identities without rewriting cell text or formatting", async () => {
    const { setTableCellFills, tableCellFill } = await import('../src/table-cells.js');
    const doc = new Doc(1), init = new Tx(doc);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]) });
    edit(doc, table, 0, 0, "甲");
    const style = new Tx(doc); setTableCellFills(style, table, [{ row: 0, col: 1, fill: "#E3ECFF" }]);
    const before = doc.blockInfo(table).props, writes = stableTableReorderWrites(before, "row", [1, 0]);
    expect(writes).not.toBeNull();
    const move = new Tx(doc); applyTableWrites(move, table, before, writes!);
    expect(move.ops.every(op => op.t === "bset" && !op.key.startsWith("tbl.c.") && !op.key.startsWith("tbl.fill."))).toBe(true);
    expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["C", "D"], ["甲", "B"]]);
    expect(tableCellFill(doc.blockInfo(table).props, 1, 1)).toBe("#E3ECFF");
    const previous = doc.blockInfo(table).props, col = stableTableReorderWrites(previous, "column", [1, 0]);
    const moveCol = new Tx(doc); applyTableWrites(moveCol, table, previous, col!);
    expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["D", "C"], ["B", "甲"]]);
    expect(tableCellFill(doc.blockInfo(table).props, 1, 0)).toBe("#E3ECFF");
  });
  it("keeps a delayed edit attached to its original row after a reorder", () => {
    const a = new Doc(1), b = new Doc(2), init = new Tx(a);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]) });
    sync(init.ops, b); sync(edit(a, table, 0, 0, "甲"), b);
    const previous = a.blockInfo(table).props, move = new Tx(a);
    applyTableWrites(move, table, previous, stableTableReorderWrites(previous, "row", [1, 0])!);
    const delayed = edit(b, table, 0, 1, "协作者");
    sync(move.ops, b); sync(delayed, a);
    for (const doc of [a, b]) expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["C", "D"], ["甲", "协作者"]]);
    sync(repair(a, table), b);
    for (const doc of [a, b]) expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["C", "D"], ["甲", "协作者"]]);
  });
  it("keeps delayed cell formatting attached to its original column", async () => {
    const { setTableCellFills, tableCellFill } = await import('../src/table-cells.js');
    const { a, b, table } = replicas();
    sync(edit(a, table, 0, 0, "甲"), b);
    const previous = a.blockInfo(table).props, move = new Tx(a), color = new Tx(b);
    applyTableWrites(move, table, previous, stableTableReorderWrites(previous, "column", [1, 0])!);
    setTableCellFills(color, table, [{ row: 0, col: 1, fill: "#E5F5E8" }]);
    sync(color.ops, a); sync(move.ops, b);
    for (const doc of [a, b]) {
      expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["", "甲"], ["", ""]]);
      expect(tableCellFill(doc.blockInfo(table).props, 0, 0)).toBe("#E5F5E8");
      expect(tableCellFill(doc.blockInfo(table).props, 0, 1)).toBe("");
    }
  });
  it("combines concurrent row and column reorders without mixing cell contents", () => {
    const a = new Doc(1), b = new Doc(2), init = new Tx(a);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]) });
    sync(init.ops, b); sync(edit(a, table, 0, 0, "甲"), b);
    const rowProps = a.blockInfo(table).props, colProps = b.blockInfo(table).props, row = new Tx(a), col = new Tx(b);
    applyTableWrites(row, table, rowProps, stableTableReorderWrites(rowProps, "row", [1, 0])!);
    applyTableWrites(col, table, colProps, stableTableReorderWrites(colProps, "column", [1, 0])!);
    sync(row.ops, b); sync(col.ops, a);
    for (const doc of [a, b]) expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["D", "C"], ["B", "甲"]]);
    sync(repair(a, table), b);
    for (const doc of [a, b]) expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["D", "C"], ["B", "甲"]]);
  });
  it("refuses stale mirrors, duplicate identities and invalid permutations", () => {
    const doc = new Doc(1), init = new Tx(doc);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]) });
    edit(doc, table, 0, 0, "甲");
    const props = doc.blockInfo(table).props;
    expect(stableTableReorderWrites({ ...props, tableData: '[["old"]]' }, "row", [1, 0])).toBeNull();
    expect(stableTableReorderWrites({ ...props, 'tbl.rows': '["r0","r0"]' }, "row", [1, 0])).toBeNull();
    expect(stableTableReorderWrites(props, "row", [0, 0])).toBeNull();
    expect(stableTableReorderWrites(props, "column", [0, 2])).toBeNull();
  });
  it("plans a legacy migration before reordering inherited cells", () => {
    const doc = new Doc(1), init = new Tx(doc);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]) });
    const legacy = doc.blockInfo(table).props;
    expect(stableTableReorderWrites(legacy, "row", [1, 0])).toBeNull();
    const migration = cellTableWrites(legacy, tableRowsOf(legacy), doc.client);
    const reorder = stableTableReorderWrites({ ...legacy, ...migration }, "row", [1, 0]);
    expect(reorder).not.toBeNull();
    const tx = new Tx(doc); applyTableWrites(tx, table, legacy, migration);
    applyTableWrites(tx, table, doc.blockInfo(table).props, reorder!);
    expect(tableRowsOf(doc.blockInfo(table).props)).toEqual([["C", "D"], ["A", "B"]]);
    expect(tx.ops.every(op => op.t === "bset" && !op.key.startsWith("tbl.c."))).toBe(true);
  });
});
