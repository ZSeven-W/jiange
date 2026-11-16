import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { captureLinkRange, resolveLinkRange } from "./linkRange";
function fixture() { const doc = new Doc(1), tx = new Tx(doc), b = tx.create("paragraph", null, ROOT); tx.insert(b, 0, "文本链接尾"); tx.format(b, 2, 4, "link", "https://example.test/"); return { doc, b }; }
describe("stable link ranges", () => {
  it("tracks a link when text is inserted before it", () => {
    const { doc, b } = fixture(), range = captureLinkRange(doc, { b, o: 2 }, { b, o: 4 }, "https://example.test/")!;
    new Tx(doc).insert(b, 0, "新");
    expect(resolveLinkRange(doc, range)).toEqual({ from: { b, o: 3 }, to: { b, o: 5 } });
  });
  it("rejects inserted, deleted, or relinked characters within the captured range", () => {
    for (const change of ["insert", "delete", "relink", "math"] as const) {
      const { doc, b } = fixture(), range = captureLinkRange(doc, { b, o: 2 }, { b, o: 4 }, "https://example.test/")!, tx = new Tx(doc);
      if (change === "insert") tx.insert(b, 3, "新"); else if (change === "delete") tx.delete(b, 2, 3); else if (change === "relink") tx.format(b, 2, 4, "link", "https://other.test/"); else tx.format(b, 2, 4, "math", "x^2");
      expect(resolveLinkRange(doc, range)).toBeNull();
    }
  });
  it("captures an entire link across different visual styles", () => {
    const { doc, b } = fixture(), tx = new Tx(doc);
    tx.format(b, 2, 3, "bold", "true");
    const range = captureLinkRange(doc, { b, o: 2 }, { b, o: 3 }, "https://example.test/", true)!;
    expect(range.ids).toHaveLength(2);
    expect(resolveLinkRange(doc, range)).toEqual({ from: { b, o: 2 }, to: { b, o: 4 } });
    const changed = resolveLinkRange(doc, range)!;
    tx.format(b, changed.from.o, changed.to.o, "link", "https://new.example/");
    expect(doc.richChars(b).slice(2, 4).map((char) => char.marks.link)).toEqual(["https://new.example/", "https://new.example/"]);
    expect(doc.richChars(b)[2].marks.bold).toBe("true");
    expect(doc.richChars(b)[3].marks.bold).toBeUndefined();
  });
  it("invalidates a captured whole link when another matching character joins at a boundary", () => {
    for (const side of ["before", "after"] as const) {
      const { doc, b } = fixture(), range = captureLinkRange(doc, { b, o: 2 }, { b, o: 3 }, "https://example.test/", true)!, tx = new Tx(doc);
      const at = side === "before" ? 2 : 4;
      tx.insert(b, at, "新");
      tx.format(b, at, at + 1, "link", "https://example.test/");
      expect(resolveLinkRange(doc, range)).toBeNull();
    }
  });
  it("does not expand across math, user mentions, or a different link", () => {
    const doc = new Doc(1), tx = new Tx(doc), b = tx.create("paragraph", null, ROOT), href = "https://example.test/";
    tx.insert(b, 0, "甲乙丙丁戊"); tx.format(b, 0, 5, "link", href);
    tx.format(b, 0, 1, "mention", "42"); tx.format(b, 3, 4, "math", "x"); tx.format(b, 4, 5, "link", "https://other.test/");
    const range = captureLinkRange(doc, { b, o: 1 }, { b, o: 2 }, href, true)!;
    expect(range.ids).toHaveLength(2);
    expect(resolveLinkRange(doc, range)).toEqual({from:{b,o:1},to:{b,o:3}});
    tx.format(b, 1, 2, "mention", "42");
    expect(resolveLinkRange(doc, range)).toBeNull();
  });
});
