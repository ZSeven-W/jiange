import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildScenarios, decodeOps, Doc, encodeOps, fromHex, keyBetween, randomSession, rng, ROOT, shuffle, toHex,
  type Op,
} from "../src/index";

const vec = (f: string) => JSON.parse(readFileSync(resolve(__dirname, "../../../spec/vectors", f), "utf8"));

describe("fractional index", () => {
  it("generates strictly ordered keys", () => {
    const r = rng(7);
    let keys: string[] = [];
    for (let i = 0; i < 500; i++) {
      const at = Math.floor(r() * (keys.length + 1));
      const k = keyBetween(at > 0 ? keys[at - 1] : "", at < keys.length ? keys[at] : "");
      keys.splice(at, 0, k);
    }
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => !k.endsWith("0"))).toBe(true);
  });
});

describe("text", () => {
  it("local edits", () => {
    const d = new Doc(1);
    const p = d.createBlock("paragraph");
    d.insertText(p.id, 0, "helo");
    d.insertText(p.id, 3, "l");
    d.insertText(p.id, 5, " 世界🙂");
    expect(d.text(p.id)).toBe("hello 世界🙂");
    d.deleteText(p.id, 0, 6);
    expect(d.text(p.id)).toBe("世界🙂");
  });

  it("does not interleave concurrent runs", () => {
    const a = new Doc(1), b = new Doc(2);
    const p = a.createBlock("paragraph");
    b.apply(p);
    const x = a.insertText(p.id, 0, "aaaa")!;
    const y = b.insertText(p.id, 0, "bbbb")!;
    a.apply(y); b.apply(x);
    expect(a.text(p.id)).toBe(b.text(p.id));
    expect(["aaaabbbb", "bbbbaaaa"]).toContain(a.text(p.id));
  });

  it("marks: later op wins, removal works, spans merge", () => {
    const d = new Doc(1);
    const p = d.createBlock("paragraph");
    d.insertText(p.id, 0, "abcdef");
    d.format(p.id, 0, 4, "bold", "true");
    d.format(p.id, 2, 6, "bold", null);
    const spans = d.view().blocks[0].spans;
    expect(spans).toEqual([
      { text: "ab", marks: { bold: "true" } },
      { text: "cdef", marks: {} },
    ]);
  });
});

describe("blocks", () => {
  it("move cycles converge and attach to root", () => {
    const a = new Doc(1), b = new Doc(2);
    const x = a.createBlock("p"), y = a.createBlock("p");
    b.apply(x); b.apply(y);
    const m1 = a.moveBlock(x.id, y.id), m2 = b.moveBlock(y.id, x.id);
    a.apply(m2); b.apply(m1);
    expect(a.view()).toEqual(b.view());
    expect(a.view().blocks.length).toBe(2);
  });

  it("buffers ops whose dependencies are missing", () => {
    const a = new Doc(1);
    const p = a.createBlock("p");
    const t = a.insertText(p.id, 0, "hi")!;
    const t2 = a.insertText(p.id, 2, "!")!;
    const d = new Doc(2);
    d.apply(t2); d.apply(t);
    expect(d.pendingCount).toBe(2);
    d.apply(p);
    expect(d.pendingCount).toBe(0);
    expect(d.text(p.id)).toBe("hi!");
  });

  it("is idempotent", () => {
    const a = new Doc(1);
    const p = a.createBlock("p");
    const t = a.insertText(p.id, 0, "x")!;
    const d = new Doc(2);
    for (let i = 0; i < 3; i++) { d.apply(p); d.apply(t); }
    expect(d.text(p.id)).toBe("x");
  });
});

describe("convergence (property)", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}: replicas converge; any delivery order converges`, () => {
      const { ops, docs } = randomSession(seed, 3, 150);
      const v = docs[0].view();
      for (const d of docs) expect(d.view()).toEqual(v);
      const r = rng(seed * 31);
      for (let k = 0; k < 3; k++) {
        const d = new Doc(100 + k);
        const order = shuffle(ops, r);
        for (const op of order) d.apply(op);
        for (const op of order.slice(0, 10)) d.apply(op); // duplicates
        expect(d.pendingCount).toBe(0);
        expect(d.view()).toEqual(v);
      }
    });
  }
});

describe("encoding", () => {
  it("round-trips random sessions", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { ops } = randomSession(seed, 3, 120);
      expect(decodeOps(encodeOps(ops))).toEqual(ops);
    }
  });

  it("rejects malformed input", () => {
    expect(() => decodeOps(new Uint8Array([0x00, 1, 0]))).toThrow();
    expect(() => decodeOps(new Uint8Array([0x4a, 1, 1, 99]))).toThrow();
    const ok = encodeOps([{ t: "bdel", id: { client: 1, clock: 2 }, block: ROOT }]);
    expect(() => decodeOps(ok.subarray(0, ok.length - 1))).toThrow();
  });
});

describe("shared vectors (spec/vectors)", () => {
  const encoding = vec("encoding.json") as { name: string; ops: Op[]; hex: string }[];
  const scenarios = vec("scenarios.json") as { name: string; ops: Op[]; expected: unknown }[];

  it("vectors are up to date with the implementation", () => {
    const fresh = buildScenarios();
    expect(JSON.parse(JSON.stringify(fresh))).toEqual(scenarios);
  });

  for (const e of encoding) {
    it(`encoding ${e.name}`, () => {
      expect(toHex(encodeOps(e.ops))).toBe(e.hex);
      expect(decodeOps(fromHex(e.hex))).toEqual(e.ops);
    });
  }

  for (const s of scenarios) {
    it(`scenario ${s.name}`, () => {
      const d = new Doc(77);
      for (const op of shuffle(s.ops, rng(5))) d.apply(op);
      expect(d.view()).toEqual(s.expected);
    });
  }
});
