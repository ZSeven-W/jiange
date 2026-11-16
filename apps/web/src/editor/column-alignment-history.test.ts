import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { ColumnAlignmentHistory } from "./column-alignment-history";

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
  const result = history.prepareConditional(doc, undo, undo.peekMarker(redo)!, redo);
  if (result.status !== "ready") return result.status;
  doc.apply(result.plan.op);
  return history.finishConditional(doc, undo, result.plan);
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
    expect(ctx.history.prepareConditional(replacement, ctx.undo, ctx.undo.peekMarker(false)!, false).status).toBe("empty");
  });
  it("prepares an inverse without changing the replica or consuming history, then finalizes only after observation", () => {
    const ctx = setup(); change(ctx, "center");
    const marker = ctx.undo.peekMarker(false)!;
    const prepared = ctx.history.prepareConditional(ctx.doc, ctx.undo, marker, false);
    expect(prepared.status).toBe("ready"); if (prepared.status !== "ready") return;
    expect(ctx.history.canSubmitConditional(ctx.doc, ctx.undo, prepared.plan)).toBe(true);
    expect(ctx.doc.blockInfo(ctx.column).props.align).toBe("center");
    expect(ctx.undo.peekMarker(false)).toBe(marker);
    expect(ctx.history.finishConditional(ctx.doc, ctx.undo, prepared.plan)).toBe("conflict");
    const later = ctx.doc.insertText(ctx.other, 0, "后续")!;
    expect(later.id.clock).toBeGreaterThan(prepared.plan.op.id.clock);
    ctx.doc.apply(prepared.plan.op);
    expect(ctx.history.canSubmitConditional(ctx.doc, ctx.undo, prepared.plan)).toBe(false);
    expect(ctx.history.finishConditional(ctx.doc, ctx.undo, prepared.plan)).toBe("ready");
    expect(ctx.undo.peekMarker(true)).toBe(marker);
    expect(ctx.doc.blockInfo(ctx.column).props.align).toBe("");
    expect(ctx.history.finishConditional(ctx.doc, ctx.undo, prepared.plan)).toBe("conflict");
    const redo = ctx.history.prepareConditional(ctx.doc, ctx.undo, marker, true);
    expect(redo.status).toBe("ready"); if (redo.status !== "ready") return;
    ctx.doc.apply(redo.plan.op);
    expect(ctx.history.finishConditional(ctx.doc, ctx.undo, redo.plan)).toBe("ready");
    expect(ctx.doc.blockInfo(ctx.column).props.align).toBe("center");
  });
  it("does not finalize if the history or observed property changes after preparation", () => {
    for (const changeType of ["history", "peer", "different replica"] as const) {
      const ctx = setup(); change(ctx, "center");
      const prepared = ctx.history.prepareConditional(ctx.doc, ctx.undo, ctx.undo.peekMarker(false)!, false);
      expect(prepared.status).toBe("ready"); if (prepared.status !== "ready") continue;
      ctx.doc.apply(prepared.plan.op);
      if (changeType === "history") ctx.undo.recordMarker("unrelated");
      if (changeType === "peer") {
        const peer = Doc.fromState(2, ctx.doc.encodeState());
        ctx.doc.apply(peer.setProp(ctx.column, "align", "right"));
      }
      const doc = changeType === "different replica" ? Doc.fromState(3, ctx.doc.encodeState()) : ctx.doc;
      expect(ctx.history.finishConditional(doc, ctx.undo, prepared.plan)).toBe("conflict");
      expect(ctx.undo.peekMarker(true)).toBeNull();
    }
  });
  it("keeps separate markers for later edits to the same column", () => {
    const ctx = setup(); change(ctx, "center");
    const previous = ctx.undo.peekMarker(false)!;
    const prepared = ctx.history.prepareConditional(ctx.doc, ctx.undo, previous, false);
    expect(prepared.status).toBe("ready"); if (prepared.status !== "ready") return;
    change(ctx, "right");
    const latest = ctx.undo.peekMarker(false)!;
    expect(latest).not.toBe(previous);
    expect(ctx.history.canSubmitConditional(ctx.doc, ctx.undo, prepared.plan)).toBe(false);
    expect(ctx.history.finishConditional(ctx.doc, ctx.undo, prepared.plan)).toBe("conflict");
    expect(ctx.undo.peekMarker(false)).toBe(latest);
  });
  it("rebases sequential conditional undo and redo across distinct markers", () => {
    const ctx = setup(); change(ctx, "center"); change(ctx, "right");
    const commit = (redo: boolean) => {
      const marker = ctx.undo.peekMarker(redo)!;
      const result = ctx.history.prepareConditional(ctx.doc, ctx.undo, marker, redo);
      expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("no plan");
      ctx.doc.apply(result.plan.op);
      expect(ctx.history.finishConditional(ctx.doc, ctx.undo, result.plan)).toBe("ready");
    };
    commit(false); expect(ctx.doc.blockInfo(ctx.column).props.align).toBe("center");
    commit(false); expect(ctx.doc.blockInfo(ctx.column).props.align).toBe("");
    commit(true); expect(ctx.doc.blockInfo(ctx.column).props.align).toBe("center");
    commit(true); expect(ctx.doc.blockInfo(ctx.column).props.align).toBe("right");
  });
  it("retains the history entry when its legacy target is not accepted by the server", () => {
    const ctx = setup();
    new Tx(ctx.doc).setProp(ctx.column, "align", "justify");
    change(ctx, "center");
    const marker = ctx.undo.peekMarker(false)!;
    expect(ctx.history.prepareConditional(ctx.doc, ctx.undo, marker, false).status).toBe("unsupported");
    expect(ctx.undo.peekMarker(false)).toBe(marker);
    expect(ctx.doc.blockInfo(ctx.column).props.align).toBe("center");
  });
});
