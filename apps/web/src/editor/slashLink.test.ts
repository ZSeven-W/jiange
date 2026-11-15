import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { captureInlineLink, insertInlineLink } from "./slashLink";

function fixture(text: string) { const doc = new Doc(1), tx = new Tx(doc), block = tx.create("paragraph", null, ROOT); tx.insert(block, 0, text); return { doc, block }; }
describe("slash link insertion", () => {
  it("inserts linked text at the captured position without changing adjacent text", () => {
    const { doc, block } = fixture("前后"), anchor = captureInlineLink(doc, { b: block, o: 1 })!;
    const tx = new Tx(doc), pos = insertInlineLink(tx, anchor, "网址😀", "https://example.test/");
    expect(doc.text(block)).toBe("前网址😀后");
    expect(pos?.o).toBe(4);
    expect(doc.richChars(block).slice(1, 4).every((c) => c.marks.link === "https://example.test/")).toBe(true);
    expect(doc.richChars(block)[4].marks.link).toBeUndefined();
  });
  it("rejects unsafe URLs and deleted anchors without changing the document", () => {
    const { doc, block } = fixture("abc"), anchor = captureInlineLink(doc, { b: block, o: 2 })!;
    expect(insertInlineLink(new Tx(doc), anchor, "link", "javascript:alert(1)")).toBeNull();
    new Tx(doc).delete(block, 1, 2);
    const before = doc.text(block), tx = new Tx(doc);
    expect(insertInlineLink(tx, anchor, "link", "https://example.test/")).toBeNull();
    expect(doc.text(block)).toBe(before);
    expect(tx.ops).toHaveLength(0);
  });
  it("rejects a changed block type while the form is open", () => {
    const { doc, block } = fixture("a"), anchor = captureInlineLink(doc, { b: block, o: 1 })!;
    new Tx(doc).setProp(block, "type", "h1");
    const tx = new Tx(doc);
    expect(insertInlineLink(tx, anchor, "link", "https://example.test/")).toBeNull();
    expect(tx.ops).toHaveLength(0);
  });
});
