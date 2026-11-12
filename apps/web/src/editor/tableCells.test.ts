import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, type Op } from "@jiange/collab";
import { cellGrid, tableDataOf, tableHash, tableRepairWrites, tableRowsOf, writeTable } from "./tableCells";
import { applyTableEdit } from "./model";

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
  const writes = tableRepairWrites(doc.blockInfo(table).props, doc.client);
  const tx = new Tx(doc);
  for (const [k, v] of Object.entries(writes ?? {})) tx.setProp(table, k, v);
  return tx.ops;
};

describe("cell-level table storage", () => {
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
