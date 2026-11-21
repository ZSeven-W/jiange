import { describe, expect, it, vi } from "vitest";
import { Doc, ROOT, Tx, idKey } from "@jiange/collab";
import { applyColumnMove, captureColumnMove, validColumnPosition } from "../src/column-move.js";

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

  it("handles edge cases: missing/non-columns/single-child capture, move to end, key overflow, and clock exhaustion", () => {
    const x = setup();
    // Missing parent or block
    expect(captureColumnMove(x.doc, { client: 99, clock: 99 }, x.a)).toBeNull();
    expect(captureColumnMove(x.doc, x.parent, { client: 99, clock: 99 })).toBeNull();

    // Non-columns parent, nested columns, and block under another parent
    const para = new Tx(x.doc).create("paragraph", null, ROOT);
    expect(captureColumnMove(x.doc, para, x.a)).toBeNull();
    expect(captureColumnMove(x.doc, x.parent, para)).toBeNull();
    const nestedCols = new Tx(x.doc).create("columns", null, para);
    const nc1 = new Tx(x.doc).create("paragraph", null, nestedCols);
    expect(captureColumnMove(x.doc, nestedCols, nc1)).toBeNull();

    // Single-child columns container
    const soloCols = new Tx(x.doc).create("columns", null, ROOT);
    const soloChild = new Tx(x.doc).create("paragraph", null, soloCols);
    expect(captureColumnMove(x.doc, soloCols, soloChild)).toBeNull();

    // Move first column to the very end (upper === "")
    const snapA = captureColumnMove(x.doc, x.parent, x.a)!;
    expect(applyColumnMove(new Tx(x.doc), snapA, x.c)).toBe("applied");
    expect(order(x.doc, x.parent)).toEqual([x.b, x.c, x.a].map(idKey));

    // Missing typeVersion fallback in guard
    const pvSpy = vi.spyOn(x.doc, "propVersion").mockReturnValueOnce(null);
    const noTypeVerSnap = captureColumnMove(x.doc, x.parent, x.b);
    pvSpy.mockRestore();
    expect(noTypeVerSnap).not.toBeNull();
    expect(noTypeVerSnap!.guard).toContain(",null,");

    // Position length > 512 triggers !validColumnPosition(pos) -> "invalid"
    const p1 = "0".repeat(511) + "1";
    const p2 = "0".repeat(511) + "2";
    const p3 = "0".repeat(511) + "3";
    x.doc.apply({ t: "bmove", id: x.doc.allocateOpIds()[0], block: x.b, parent: x.parent, pos: p1 });
    x.doc.apply({ t: "bmove", id: x.doc.allocateOpIds()[0], block: x.c, parent: x.parent, pos: p2 });
    x.doc.apply({ t: "bmove", id: x.doc.allocateOpIds()[0], block: x.a, parent: x.parent, pos: p3 });
    const longSnap = captureColumnMove(x.doc, x.parent, x.a)!;
    expect(applyColumnMove(new Tx(x.doc), longSnap, x.b)).toBe("invalid");

    // keyBetween throws when blockLocation returns inverted bounds during apply
    const y = setup();
    const ySnap = captureColumnMove(y.doc, y.parent, y.c)!;
    const origLoc = y.doc.blockLocation.bind(y.doc);
    let calls = 0;
    const locSpy = vi.spyOn(y.doc, "blockLocation").mockImplementation((id) => {
      calls++;
      // First 5 calls are inside captureColumnMove; calls 6 & 7 are positionOf(a) and positionOf(b)
      if (calls === 6) return { ...origLoc(id), pos: "z" };
      if (calls === 7) return { ...origLoc(id), pos: "a" };
      return origLoc(id);
    });
    expect(applyColumnMove(new Tx(y.doc), ySnap, y.a)).toBe("invalid");
    locSpy.mockRestore();

    // Clock exhaustion -> allocateOpIds throws -> "invalid"
    const z = setup();
    const zSnap = captureColumnMove(z.doc, z.parent, z.a)!;
    // Advance clock to MAX_SAFE_INTEGER with an unrelated block op so guard is unaffected
    z.doc.apply({ t: "bcreate", id: { client: 9, clock: Number.MAX_SAFE_INTEGER }, parent: ROOT, pos: "z", type: "paragraph" });
    expect(applyColumnMove(new Tx(z.doc), zSnap, z.b)).toBe("invalid");
  });
});
