import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, idKey } from "@jiange/collab";
import { TableCellHistory } from "./tableCellHistory";
import { applyTableEdit, parseTableData } from "./model";

function setup() {
  const doc = new Doc(1), tx = new Tx(doc);
  const block = tx.create("table", null, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]) });
  return { doc, block, history: new TableCellHistory(), key: `table:${idKey(block)}:0:0` };
}
const version = (doc: Doc, block: Parameters<Doc["propVersion"]>[0], key: string) => {
  const value = doc.propVersion(block, key);
  return value ? idKey(value) : null;
};
function edit(ctx: ReturnType<typeof setup>, text: string, kind?: string, now = 0) {
  const { doc, block, history, key } = ctx;
  const rows = parseTableData(doc.blockInfo(block).props.tableData);
  const before = rows[0][0], prev = version(doc, block, "tableData");
  const tx = new Tx(doc);
  tx.setProp(block, "tableData", JSON.stringify(applyTableEdit(rows, 0, 0, text)));
  history.record(doc, key, before, text, prev, version(doc, block, "tableData"), version(doc, block, "type"), kind, now);
}
function step(ctx: ReturnType<typeof setup>, redo: boolean) {
  const { doc, block, history, key } = ctx;
  const rows = parseTableData(doc.blockInfo(block).props.tableData);
  const result = history.prepare(doc, key, redo, rows[0][0], version(doc, block, "tableData"), version(doc, block, "type"));
  if (result.status !== "ready") return result.status;
  const tx = new Tx(doc);
  tx.setProp(block, "tableData", JSON.stringify(applyTableEdit(rows, 0, 0, result.value)));
  const next = version(doc, block, "tableData");
  const logical = history.commit(doc, key, redo, next);
  history.rebase(doc, `table:${idKey(block)}:`, logical, next, version(doc, block, "type"));
  return "ready";
}

describe("table cell undo and redo", () => {
  it("undoes and redoes grouped typing and paste without modifying other cells", () => {
    const ctx = setup();
    edit(ctx, "Al", "insertText", 100);
    edit(ctx, "Alpha", "insertText", 200);
    edit(ctx, "Alpha数据", "insertFromPaste", 250);
    expect(step(ctx, false)).toBe("ready");
    expect(parseTableData(ctx.doc.blockInfo(ctx.block).props.tableData)).toEqual([["Alpha", "B"], ["C", "D"]]);
    expect(step(ctx, false)).toBe("ready");
    expect(parseTableData(ctx.doc.blockInfo(ctx.block).props.tableData)).toEqual([["A", "B"], ["C", "D"]]);
    expect(step(ctx, true)).toBe("ready");
    expect(step(ctx, true)).toBe("ready");
    expect(parseTableData(ctx.doc.blockInfo(ctx.block).props.tableData)).toEqual([["Alpha数据", "B"], ["C", "D"]]);
  });

  it("refuses to overwrite a collaborator's other-cell edit", () => {
    const ctx = setup();
    edit(ctx, "Alpha", "insertText");
    const peer = Doc.fromState(2, ctx.doc.encodeState());
    const rows = parseTableData(peer.blockInfo(ctx.block).props.tableData);
    ctx.doc.apply(peer.setProp(ctx.block, "tableData", JSON.stringify(applyTableEdit(rows, 1, 1, "远端"))));
    expect(step(ctx, false)).toBe("conflict");
    expect(parseTableData(ctx.doc.blockInfo(ctx.block).props.tableData)).toEqual([["Alpha", "B"], ["C", "远端"]]);
  });

  it("refuses undo after a same-value remote write or row deletion and restoration", () => {
    for (const change of ["same", "rows"] as const) {
      const ctx = setup();
      edit(ctx, "Alpha", "insertText");
      const peer = Doc.fromState(2, ctx.doc.encodeState());
      const original = peer.blockInfo(ctx.block).props.tableData;
      if (change === "rows") ctx.doc.apply(peer.setProp(ctx.block, "tableData", JSON.stringify([["Alpha", "B"]])));
      ctx.doc.apply(peer.setProp(ctx.block, "tableData", original));
      expect(step(ctx, false)).toBe("conflict");
      expect(ctx.doc.blockInfo(ctx.block).props.tableData).toBe(original);
    }
  });

  it("returns an isolated winning register version after same-value writes and snapshots", () => {
    const ctx = setup();
    const initial = ctx.doc.propVersion(ctx.block, "tableData")!;
    const copy = { ...initial };
    initial.clock = -1;
    expect(ctx.doc.propVersion(ctx.block, "tableData")).toEqual(copy);
    const current = ctx.doc.blockInfo(ctx.block).props.tableData;
    const peer = Doc.fromState(2, ctx.doc.encodeState());
    const op = peer.setProp(ctx.block, "tableData", current);
    ctx.doc.apply(op);
    expect(ctx.doc.propVersion(ctx.block, "tableData")).toEqual(op.id);
    const restored = Doc.fromState(3, ctx.doc.encodeState());
    expect(restored.propVersion(ctx.block, "tableData")).toEqual(op.id);
    expect(restored.propVersion(ctx.block, "missing")).toBeNull();
  });

  it("refuses after a table changes type and back, and does not reuse history across document replacement", () => {
    const ctx = setup();
    edit(ctx, "Alpha", "insertText");
    const peer = Doc.fromState(2, ctx.doc.encodeState());
    ctx.doc.apply(peer.setProp(ctx.block, "type", "paragraph"));
    ctx.doc.apply(peer.setProp(ctx.block, "type", "table"));
    expect(step(ctx, false)).toBe("conflict");
    const replacement = Doc.fromState(3, ctx.doc.encodeState());
    expect(version(replacement, ctx.block, "tableData")).toBe(version(ctx.doc, ctx.block, "tableData"));
    expect(ctx.history.prepare(replacement, ctx.key, false, "Alpha", version(replacement, ctx.block, "tableData"), version(replacement, ctx.block, "type")).status).toBe("empty");
  });
});
