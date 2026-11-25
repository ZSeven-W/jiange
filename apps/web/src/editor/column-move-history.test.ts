import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager, idKey } from "@zseven-w/collab";
import { applyColumnMove, captureColumnMove } from "./column-move";
import { ColumnMoveHistory } from "./column-move-history";

function setup() {
  const doc = new Doc(1), tx = new Tx(doc), parent = tx.create("columns", null, ROOT);
  const a = tx.create("paragraph", null, parent), b = tx.create("paragraph", a, parent), c = tx.create("paragraph", b, parent);
  tx.insert(a, 0, "左"); tx.insert(b, 0, "中"); tx.insert(c, 0, "右");
  return { doc, parent, a, b, c, undo: new UndoManager(), history: new ColumnMoveHistory() };
}
type Context = ReturnType<typeof setup>;
const order = (x: Context) => x.doc.children(x.parent).map(idKey);
function move(x: Context, block: typeof x.a, after: typeof x.a | null) {
  const before = captureColumnMove(x.doc, x.parent, block)!;
  expect(applyColumnMove(new Tx(x.doc), before, after)).toBe("applied");
  x.history.record(x.doc, x.undo, before);
}
function commit(x: Context, redo = false) {
  const result = x.history.prepareConditional(x.doc, x.undo, x.undo.peekMarker(redo)!, redo);
  if (result.status !== "ready") return result.status;
  expect(x.history.canSubmitConditional(x.doc, x.undo, result.plan)).toBe(true);
  x.doc.apply(result.plan.op);
  return x.history.finishConditional(x.doc, x.undo, result.plan);
}

describe("conditional column move history", () => {
  it("undoes and redoes a move without changing column IDs or content", () => {
    const x = setup(); move(x, x.a, x.b);
    expect(order(x)).toEqual([x.b,x.a,x.c].map(idKey));
    expect(commit(x)).toBe("ready"); expect(order(x)).toEqual([x.a,x.b,x.c].map(idKey));
    expect(commit(x,true)).toBe("ready"); expect(order(x)).toEqual([x.b,x.a,x.c].map(idKey));
    expect(x.doc.text(x.a)).toBe("左"); expect(x.doc.text(x.b)).toBe("中");
  });
  it("rebases sequential moves of the same column", () => {
    const x = setup(); move(x,x.a,x.b); move(x,x.a,x.c);
    expect(commit(x)).toBe("ready"); expect(order(x)).toEqual([x.b,x.a,x.c].map(idKey));
    expect(commit(x)).toBe("ready"); expect(order(x)).toEqual([x.a,x.b,x.c].map(idKey));
    expect(commit(x,true)).toBe("ready"); expect(commit(x,true)).toBe("ready");
    expect(order(x)).toEqual([x.b,x.c,x.a].map(idKey));
  });
  it("rejects an observed peer move while preserving their text", () => {
    const x = setup(); move(x,x.a,x.b);
    const peer = Doc.fromState(2, x.doc.encodeState());
    x.doc.apply(peer.moveBlock(x.c, x.parent, 0)); x.doc.apply(peer.insertText(x.a, 1, "远端")!);
    expect(commit(x)).toBe("conflict"); expect(x.doc.text(x.a)).toBe("左远端");
  });
  it("waits for the exact committed operation before advancing history", () => {
    const x = setup(); move(x,x.a,x.b); const marker = x.undo.peekMarker(false)!;
    const prepared = x.history.prepareConditional(x.doc, x.undo, marker, false);
    expect(prepared.status).toBe("ready"); if (prepared.status !== "ready") return;
    expect(x.history.finishConditional(x.doc, x.undo, prepared.plan)).toBe("conflict");
    x.doc.apply(prepared.plan.op); expect(x.history.finishConditional(x.doc, x.undo, prepared.plan)).toBe("ready");
    expect(x.undo.peekMarker(true)).toBe(marker);
  });
});
