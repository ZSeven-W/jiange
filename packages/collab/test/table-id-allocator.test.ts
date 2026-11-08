import { describe, expect, it } from "vitest";
import { Doc, idKey } from "../src/index";

/** Slice ① of table-block integration: the document is the single source of
 * operation IDs for every sub-CRDT. Reserved ranges must never collide with
 * locally generated text ops or remotely observed IDs. */
describe("allocateOpIds (sub-CRDT id reservation)", () => {
  it("returns unique sequential ids and advances past them", () => {
    const d = new Doc(7);
    const p = d.createBlock("paragraph");
    d.insertText(p.id, 0, "hi"); // clocks 1..2 (create uses 1, text uses 2)
    const ids = d.allocateOpIds(3);
    expect(ids.map((x) => x.client)).toEqual([7, 7, 7]);
    expect(ids[1].clock - ids[0].clock).toBe(1);
    const after = d.insertText(p.id, 2, "!");
    // every id distinct
    const keys = [p.id, after!.id, ...ids].map(idKey);
    expect(new Set(keys).size).toBe(keys.length);
    // the next local op lands strictly after the reserved range
    expect(after!.id.clock).toBeGreaterThan(ids[2].clock);
  });

  it("reservations never collide with remotely observed clocks", () => {
    const a = new Doc(1);
    const p = a.createBlock("paragraph");
    const remote = a.insertText(p.id, 0, "远端文本"); // clock up to ~6
    const b = new Doc(2);
    b.apply(p);
    b.apply(remote!); // b.clock moves past observed ids
    const ids = b.allocateOpIds(2);
    expect(ids.every((x) => x.clock > remote!.id.clock)).toBe(true);
    const local = b.insertText(p.id, 0, "本");
    expect(idKey(local!.id)).not.toBe(idKey(ids[0]));
    expect(idKey(local!.id)).not.toBe(idKey(ids[1]));
  });

  it("rejects invalid counts without consuming the clock", () => {
    const d = new Doc(3);
    const p = d.createBlock("paragraph");
    const before = d.allocateOpIds(1)[0].clock;
    expect(() => d.allocateOpIds(0)).toThrow(RangeError);
    expect(() => d.allocateOpIds(-1)).toThrow(RangeError);
    expect(() => d.allocateOpIds(1.5)).toThrow(RangeError);
    const after = d.allocateOpIds(1)[0].clock;
    expect(after).toBe(before + 1); // failed reservations consumed nothing
    expect(d.hasBlock(p.id)).toBe(true);
  });
});
