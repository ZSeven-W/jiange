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
});
