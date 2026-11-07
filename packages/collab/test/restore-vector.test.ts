import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Doc, ROOT, type Op } from "../src/index";

const fixture = JSON.parse(readFileSync(new URL("../../../spec/vectors/restore.json", import.meta.url), "utf8")) as {
  state: string;
  ops: Op[];
  expected: ReturnType<Doc["view"]>;
};

describe("Go restore operation vector", () => {
  it("replays nested blocks, type changes and marks in any delivery order", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const doc = Doc.fromState(19, Uint8Array.from(Buffer.from(fixture.state, "base64")));
      const ops = [...fixture.ops];
      let state = seed;
      for (let i = ops.length - 1; i > 0; i--) {
        state = (state * 48271) % 2147483647;
        const j = state % (i + 1);
        [ops[i], ops[j]] = [ops[j], ops[i]];
      }
      for (const op of ops) doc.apply(op);
      expect(doc.pendingCount).toBe(0);
      expect(doc.view()).toEqual(fixture.expected);
    }
  });

  it("can insert a new block between formerly tied siblings", () => {
    const doc = Doc.fromState(19, Uint8Array.from(Buffer.from(fixture.state, "base64")));
    for (const op of fixture.ops) doc.apply(op);
    const siblings = doc.children(ROOT);
    const first = siblings.findIndex((id) => doc.text(id) === "FIRST");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(doc.text(siblings[first + 1])).toBe("SECOND");
    const inserted = doc.createBlock("paragraph", ROOT, first + 1);
    doc.insertText(inserted.id, 0, "BETWEEN");
    expect(doc.children(ROOT).slice(first, first + 3).map((id) => doc.text(id))).toEqual(["FIRST", "BETWEEN", "SECOND"]);
  });

  it("preserves non-expanding marks and deleted mark anchors on later input", () => {
    const doc = Doc.fromState(19, Uint8Array.from(Buffer.from(fixture.state, "base64")));
    for (const op of fixture.ops) doc.apply(op);
    const blocks = doc.blockIds();
    const text = blocks.find((id) => doc.text(id) === "中文😀AB")!;
    doc.insertText(text, 3, "X");
    expect(doc.richChars(text)[3].marks).toEqual({});
    const hidden = blocks.find((id) => doc.text(id) === "AC")!;
    doc.insertText(hidden, 1, "X");
    expect(doc.richChars(hidden).map((c) => ({ ch: c.ch, marks: c.marks }))).toEqual([
      { ch: "A", marks: {} }, { ch: "X", marks: {} }, { ch: "C", marks: {} },
    ]);
  });
});
