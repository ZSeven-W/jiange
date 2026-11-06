import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, encodeClientMsg, encodeOps } from "@jiange/collab";
import { findMatches, replaceMatches } from "./findReplace";
import { preflightFindReplace } from "./findReplaceSafety";

function setup(text: string) {
  const doc = new Doc(1);
  const tx = new Tx(doc);
  const block = tx.create("paragraph", null, ROOT);
  tx.insert(block, 0, text);
  return { doc, block };
}

describe("find replacement preflight", () => {
  it("measures the actual encoded frame for emoji without changing the live replica", () => {
    const { doc } = setup("甲 甲");
    const matches = findMatches(doc, "甲");
    const before = doc.encodeState();
    const copy = Doc.fromState(doc.client, before);
    const tx = new Tx(copy);
    replaceMatches(tx, matches.map((match) => ({ ...match, doc: copy })), "😀好");
    const actualBytes = encodeClientMsg({ type: "ops", batch: encodeOps(tx.ops) }).byteLength;
    expect(preflightFindReplace(doc, matches, "😀好")).toEqual({ ok: true, frameBytes: actualBytes });
    expect(doc.encodeState()).toEqual(before);
    expect(preflightFindReplace(doc, matches, "😀好", actualBytes - 1)).toEqual({ ok: false, reason: "size" });
    expect(preflightFindReplace(doc, matches, "😀好", actualBytes)).toEqual({ ok: true, frameBytes: actualBytes });
    expect(doc.encodeState()).toEqual(before);
  });

  it("permits an empty replacement and leaves the live text unchanged during preflight", () => {
    const { doc, block } = setup("待删除");
    const result = preflightFindReplace(doc, findMatches(doc, "删除"), "");
    expect(result.ok && result.frameBytes > 0).toBe(true);
    expect(doc.text(block)).toBe("待删除");
  });

  it("refuses oversized UTF-8, excessive code points and repeated long inputs before editing", () => {
    const { doc, block } = setup("x ".repeat(100));
    const matches = findMatches(doc, "x");
    const before = doc.encodeState();
    expect(preflightFindReplace(doc, matches, "a".repeat(100_000))).toEqual({ ok: false, reason: "size" });
    expect(preflightFindReplace(doc, matches.slice(0, 1), "😀".repeat(262_145))).toEqual({ ok: false, reason: "size" });
    expect(preflightFindReplace(doc, matches.slice(0, 1), "😀".repeat(20_000))).toEqual({ ok: false, reason: "size" });
    expect(doc.text(block)).toBe("x ".repeat(100));
    expect(doc.encodeState()).toEqual(before);
  });

  it("refuses a high-work replace-all without applying any of its matches", () => {
    const { doc, block } = setup("x".repeat(1000));
    const matches = findMatches(doc, "x");
    const before = doc.encodeState();
    expect(preflightFindReplace(doc, matches, "y")).toEqual({ ok: false, reason: "work" });
    expect(doc.text(block)).toBe("x".repeat(1000));
    expect(doc.encodeState()).toEqual(before);
  });
});
