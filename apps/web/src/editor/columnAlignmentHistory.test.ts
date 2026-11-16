import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { ColumnAlignmentHistory } from "./columnAlignmentHistory";

function setup() {
  const doc = new Doc(1), init = new Tx(doc);
  const parent = init.create("columns", null, ROOT), column = init.create("paragraph", null, parent), other = init.create("paragraph", column, parent);
  init.insert(column, 0, "左栏"); init.insert(other, 0, "右栏");
  return { doc, parent, column, other, undo: new UndoManager(), history: new ColumnAlignmentHistory() };
}
type Context = ReturnType<typeof setup>;
function change({ doc, column, undo, history }: Context, value: string) {
  const before = history.capture(doc, column)!;
  new Tx(doc).setProp(column, "align", value);
  history.record(doc, undo, column, before);
}
function step({ doc, undo, history }: Context, redo = false) {
  return history.step(doc, undo, undo.peekMarker(redo)!, redo).status;
}

describe("column alignment local history", () => {
  it("rebases adjacent local actions across undo and redo", () => {
    const ctx = setup();
    change(ctx, "center"); change(ctx, "right");
    expect(step(ctx)).toBe("ready"); expect(ctx.doc.blockInfo(ctx.column).props.align).toBe("center");
    expect(step(ctx)).toBe("ready"); expect(ctx.doc.blockInfo(ctx.column).props.align).toBe("");
    expect(step(ctx, true)).toBe("ready"); expect(ctx.doc.blockInfo(ctx.column).props.align).toBe("center");
    expect(step(ctx, true)).toBe("ready"); expect(ctx.doc.blockInfo(ctx.column).props.align).toBe("right");
  });
  it.each(["different", "same"])("refuses to overwrite an observed %s remote property write", (kind) => {
    const ctx = setup(); change(ctx, "center");
    const peer = Doc.fromState(2, ctx.doc.encodeState());
    ctx.doc.apply(peer.setProp(ctx.column, "align", kind === "same" ? "center" : "right"));
    const marker = ctx.undo.peekMarker(false);
    expect(step(ctx)).toBe("conflict"); expect(ctx.undo.peekMarker(false)).toBe(marker);
    expect(ctx.doc.blockInfo(ctx.column).props.align).toBe(kind === "same" ? "center" : "right");
  });
  it("preserves unrelated peer text and rejects changed type or document replacement", () => {
    const ctx = setup(); change(ctx, "center");
    const peer = Doc.fromState(2, ctx.doc.encodeState());
    ctx.doc.apply(peer.insertText(ctx.other, 0, "远端")!);
    expect(step(ctx)).toBe("ready"); expect(ctx.doc.text(ctx.other)).toBe("远端右栏");
    expect(step(ctx, true)).toBe("ready");
    ctx.doc.apply(peer.setProp(ctx.column, "type", "h1"));
    ctx.doc.apply(peer.setProp(ctx.column, "type", "paragraph"));
    expect(step(ctx)).toBe("conflict");
    const replacement = Doc.fromState(3, ctx.doc.encodeState());
    expect(ctx.history.step(replacement, ctx.undo, ctx.undo.peekMarker(false)!, false).status).toBe("empty");
  });
});
