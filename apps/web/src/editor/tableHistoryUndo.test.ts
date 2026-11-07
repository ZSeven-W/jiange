import { describe, expect, it } from "vitest";
import { Doc, ROOT, SyncClient, Tx, UndoManager, encodeServerMsg, idKey } from "@jiange/collab";
import { applyTableEdit, parseTableData } from "./model";
import { TableCellHistory } from "./tableCellHistory";
import { applyTableHistory } from "./tableHistoryUndo";

function setup() {
  const doc = new Doc(1), tx = new Tx(doc);
  const body = tx.create("paragraph", null, ROOT);
  tx.insert(body, 0, "正文");
  const table = tx.create("table", body, ROOT, { tableData: JSON.stringify([["A", "B"], ["C", "D"]]) });
  return { doc, session: {}, body, table, undo: new UndoManager(), history: new TableCellHistory() };
}
type Context = ReturnType<typeof setup>;
const version = (ctx: Context, key: string) => {
  const value = ctx.doc.propVersion(ctx.table, key);
  return value ? idKey(value) : null;
};
function edit(ctx: Context, row: number, col: number, value: string) {
  const { doc, session, table, undo, history } = ctx;
  const info = doc.blockInfo(table), rows = parseTableData(info.props.tableData);
  const before = row < 0 ? (info.props.tableData ?? "") : rows[row][col];
  const previous = version(ctx, "tableData"), type = version(ctx, "type");
  const tx = new Tx(doc);
  tx.setProp(table, "tableData", JSON.stringify(applyTableEdit(rows, row, col, value)));
  const after = row < 0 ? doc.blockInfo(table).props.tableData : value;
  const key = `table:${idKey(table)}:${row < 0 ? "-1:-1" : `${row}:${col}`}`;
  const merged = history.record(session, key, before, after, previous, version(ctx, "tableData"), type, undefined, Date.now(), undo.peekMarker(false) === key);
  undo.recordMarker(key, merged);
  if (session instanceof SyncClient) session.push(tx.ops);
  return key;
}
function step(ctx: Context, redo = false) {
  const key = ctx.undo.peekMarker(redo);
  if (key) return applyTableHistory(ctx.doc, ctx.session, ctx.undo, ctx.history, key, redo).status;
  return (redo ? ctx.undo.redo(ctx.doc) : ctx.undo.undo(ctx.doc)) ? "ready" : "empty";
}
const rows = (ctx: Context) => parseTableData(ctx.doc.blockInfo(ctx.table).props.tableData);

describe("table and document undo ordering", () => {
  it("undoes and redoes interleaved cells and document text in global order", () => {
    const ctx = setup();
    edit(ctx, 0, 0, "AA");
    const text = new Tx(ctx.doc);
    text.insert(ctx.body, 2, "修改");
    ctx.undo.record(text, null, null, "type");
    edit(ctx, 1, 1, "DD");
    expect(step(ctx)).toBe("ready");
    expect(rows(ctx)).toEqual([["AA", "B"], ["C", "D"]]);
    expect(step(ctx)).toBe("ready");
    expect(ctx.doc.text(ctx.body)).toBe("正文");
    expect(step(ctx)).toBe("ready");
    expect(rows(ctx)).toEqual([["A", "B"], ["C", "D"]]);
    expect(step(ctx, true)).toBe("ready");
    expect(step(ctx, true)).toBe("ready");
    expect(step(ctx, true)).toBe("ready");
    expect(ctx.doc.text(ctx.body)).toBe("正文修改");
    expect(rows(ctx)).toEqual([["AA", "B"], ["C", "DD"]]);
  });

  it("does not replay an already undone cell when global undo moves to body text", () => {
    const ctx = setup(), text = new Tx(ctx.doc);
    text.insert(ctx.body, 2, "修改");
    ctx.undo.record(text, null, null, "type");
    const key = edit(ctx, 0, 0, "AA");
    expect(applyTableHistory(ctx.doc, ctx.session, ctx.undo, ctx.history, key, false).status).toBe("ready");
    expect(step(ctx)).toBe("ready");
    expect(ctx.doc.text(ctx.body)).toBe("正文");
    expect(rows(ctx)[0][0]).toBe("A");
  });

  it("blocks global undo without consuming its marker when a collaborator changes the table", () => {
    const ctx = setup();
    const key = edit(ctx, 0, 0, "AA");
    const peer = Doc.fromState(2, ctx.doc.encodeState());
    const remote = JSON.stringify([["AA", "远端"], ["C", "D"]]);
    ctx.doc.apply(peer.setProp(ctx.table, "tableData", remote));
    expect(step(ctx)).toBe("conflict");
    expect(ctx.undo.peekMarker(false)).toBe(key);
    expect(ctx.undo.undo(ctx.doc)).toBeNull();
    expect(ctx.doc.blockInfo(ctx.table).props.tableData).toBe(remote);
  });

  it("protects row operations against remote edits and safely undoes unchanged structure", () => {
    const ctx = setup();
    edit(ctx, -1, 2, "");
    expect(rows(ctx)).toHaveLength(3);
    expect(step(ctx)).toBe("ready");
    expect(rows(ctx)).toHaveLength(2);
    expect(step(ctx, true)).toBe("ready");
    const peer = Doc.fromState(2, ctx.doc.encodeState());
    const changed = JSON.stringify([["A", "远端"], ["C", "D"], ["", ""]]);
    ctx.doc.apply(peer.setProp(ctx.table, "tableData", changed));
    expect(step(ctx)).toBe("conflict");
    expect(ctx.doc.blockInfo(ctx.table).props.tableData).toBe(changed);
  });

  it("recovers undo after a SyncClient snapshot replaces the document instance", () => {
    const seed = setup(), client = new SyncClient(1);
    client.open(() => {});
    client.receive(encodeServerMsg({ type: "welcome", clientId: 1, headSeq: 0, snapshot: { seq: 0, state: seed.doc.encodeState() } }));
    const ctx = { ...seed, doc: client.doc!, session: client };
    const snapshotBeforeEdit = client.doc!.encodeState();
    const key = edit(ctx, 0, 0, "AA");
    const before = client.doc!;
    client.close();
    client.open(() => {});
    client.receive(encodeServerMsg({ type: "welcome", clientId: 1, headSeq: 0, snapshot: { seq: 0, state: snapshotBeforeEdit } }));
    expect(client.doc).not.toBe(before);
    expect(client.pendingOps()).toHaveLength(1);
    expect(applyTableHistory(client.doc!, client, ctx.undo, ctx.history, key, false).status).toBe("ready");
    expect(parseTableData(client.doc!.blockInfo(ctx.table).props.tableData)[0][0]).toBe("A");
  });

  it("lets the user explicitly skip a conflicting local marker without changing document content", () => {
    const ctx = setup(), bodyEdit = new Tx(ctx.doc);
    bodyEdit.insert(ctx.body, 2, "修改");
    ctx.undo.record(bodyEdit, null, null, "type");
    const key = edit(ctx, 0, 0, "AA");
    const peer = Doc.fromState(2, ctx.doc.encodeState());
    const remote = JSON.stringify([["AA", "远端"], ["C", "D"]]);
    ctx.doc.apply(peer.setProp(ctx.table, "tableData", remote));
    expect(step(ctx)).toBe("conflict");
    const revision = ctx.undo.revision;
    expect(ctx.undo.discardMarker(false, "wrong", revision)).toBe(false);
    expect(ctx.undo.discardMarker(false, key, revision)).toBe(true);
    ctx.history.discard(ctx.session, key, false);
    expect(ctx.doc.blockInfo(ctx.table).props.tableData).toBe(remote);
    expect(step(ctx)).toBe("ready");
    expect(ctx.doc.text(ctx.body)).toBe("正文");
    expect(ctx.doc.blockInfo(ctx.table).props.tableData).toBe(remote);
  });

  it("does not discard a newer same-cell marker from a stale conflict prompt", () => {
    const ctx = setup();
    const key = edit(ctx, 0, 0, "AA");
    const peer = Doc.fromState(2, ctx.doc.encodeState());
    ctx.doc.apply(peer.setProp(ctx.table, "tableData", JSON.stringify([["AA", "远端"], ["C", "D"]])));
    expect(step(ctx)).toBe("conflict");
    const staleRevision = ctx.undo.revision;
    expect(edit(ctx, 0, 0, "AAA")).toBe(key);
    expect(ctx.undo.discardMarker(false, key, staleRevision)).toBe(false);
    expect(ctx.undo.peekMarker(false)).toBe(key);
    expect(step(ctx)).toBe("ready");
    expect(rows(ctx)).toEqual([["AA", "远端"], ["C", "D"]]);
  });
});
