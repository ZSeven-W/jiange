import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, idKey } from "@jiange/collab";
import { applyColumnMove, captureColumnMove, validColumnPosition } from "./columnMove";

function setup() {
  const doc = new Doc(1), tx = new Tx(doc), parent = tx.create("columns", null, ROOT);
  const a = tx.create("paragraph", null, parent), b = tx.create("paragraph", a, parent), c = tx.create("paragraph", b, parent);
  tx.insert(a, 0, "左"); tx.insert(b, 0, "中"); tx.insert(c, 0, "右");
  tx.setProp(parent, "columnWidths", JSON.stringify({[idKey(a)]:1400,[idKey(b)]:600}));
  return { doc, parent, a, b, c };
}
const order = (doc: Doc, parent: {client:number;clock:number}) => doc.children(parent).map(idKey);

describe("document column moves", () => {
  it("moves stable column IDs and keeps text and widths attached", () => {
    const x = setup(), snapshot = captureColumnMove(x.doc, x.parent, x.a)!;
    const tx = new Tx(x.doc); expect(applyColumnMove(tx, snapshot, x.b)).toBe("applied");
    expect(order(x.doc, x.parent)).toEqual([x.b, x.a, x.c].map(idKey));
    expect(x.doc.text(x.a)).toBe("左"); expect(x.doc.text(x.b)).toBe("中");
    expect(JSON.parse(x.doc.blockInfo(x.parent).props.columnWidths)[idKey(x.a)]).toBe(1400);
    expect(tx.ops).toHaveLength(1); expect(tx.ops[0].t).toBe("bmove");
    const next = captureColumnMove(x.doc, x.parent, x.c)!;
    expect(applyColumnMove(new Tx(x.doc), next, null)).toBe("applied");
    expect(order(x.doc, x.parent)).toEqual([x.c, x.b, x.a].map(idKey));
  });
  it("refuses stale or invalid targets without changing the document", () => {
    const x = setup(), before = captureColumnMove(x.doc, x.parent, x.b)!;
    expect(Object.isFrozen(before)).toBe(true); expect(Object.isFrozen(before.ids)).toBe(true);
    const unchanged = new Tx(x.doc); expect(applyColumnMove(unchanged, before, x.a)).toBe("unchanged"); expect(unchanged.ops).toHaveLength(0);
    expect(applyColumnMove(new Tx(x.doc), before, x.b)).toBe("invalid");
    expect(applyColumnMove(new Tx(x.doc), before, {client:99,clock:99})).toBe("changed");
    const peer = Doc.fromState(2, x.doc.encodeState());
    const move = peer.moveBlock(x.c, x.parent, 0); x.doc.apply(move);
    const stale = new Tx(x.doc); expect(applyColumnMove(stale, before, null)).toBe("changed"); expect(stale.ops).toHaveLength(0);
    expect(x.doc.text(x.c)).toBe("右");
  });
  it("allows unrelated peer text edits but rejects malformed or duplicate positions", () => {
    const x = setup(), snapshot = captureColumnMove(x.doc, x.parent, x.b)!;
    const peer = Doc.fromState(2, x.doc.encodeState()); x.doc.apply(peer.insertText(x.c, 1, "远端")!);
    expect(applyColumnMove(new Tx(x.doc), snapshot, null)).toBe("applied");
    expect(x.doc.text(x.c)).toBe("右远端");
    const loc = x.doc.blockLocation(x.a); loc.parent.clock = 99; loc.version.clock = 99;
    expect(x.doc.blockLocation(x.a).parent).toEqual(x.parent);
    const duplicate = x.doc.blockLocation(x.a).pos;
    x.doc.apply({t:"bmove", id:x.doc.allocateOpIds()[0], block:x.c, parent:x.parent, pos:duplicate});
    expect(captureColumnMove(x.doc, x.parent, x.a)).toBeNull();
    expect(validColumnPosition("V")).toBe(true); expect(validColumnPosition("A0")).toBe(false); expect(validColumnPosition("a/../b")).toBe(false);
  });
});
