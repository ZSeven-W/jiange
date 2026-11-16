import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { captureInlineLink, captureInlineLinkSelection, insertInlineLink } from "./slash-link";

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
  it("links selected text while preserving existing formatting and surrounding text", () => {
    const { doc, block } = fixture("前文字后");
    new Tx(doc).format(block, 1, 3, "bold", "true");
    const anchor = captureInlineLinkSelection(doc, { a: { b: block, o: 1 }, f: { b: block, o: 3 } })!;
    const pos = insertInlineLink(new Tx(doc), anchor, "文字", "https://example.test/");
    expect(pos?.o).toBe(3);
    expect(doc.text(block)).toBe("前文字后");
    expect(doc.richChars(block).slice(1, 3).every((char) => char.marks.bold === "true" && char.marks.link === "https://example.test/")).toBe(true);
  });
  it("retains leading and trailing spaces when linking a selection", () => {
    const { doc, block } = fixture(" 前后 "), anchor = captureInlineLinkSelection(doc, { a: { b: block, o: 0 }, f: { b: block, o: 4 } })!;
    expect(insertInlineLink(new Tx(doc), anchor, " 前后 ", "https://example.test/")).not.toBeNull();
    expect(doc.text(block)).toBe(" 前后 ");
    expect(doc.richChars(block).every((char) => char.marks.link === "https://example.test/")).toBe(true);
  });
  it("does not replace changed or mixed-format selection text", () => {
    const { doc, block } = fixture("前文字后"), before = captureInlineLinkSelection(doc, { a: { b: block, o: 1 }, f: { b: block, o: 3 } })!;
    new Tx(doc).insert(block, 2, "新");
    const tx = new Tx(doc);
    expect(insertInlineLink(tx, before, "替换", "https://example.test/")).toBeNull();
    expect(tx.ops).toHaveLength(0);
    const other = fixture("文字"); new Tx(other.doc).format(other.block, 0, 1, "bold", "true");
    const mixed = captureInlineLinkSelection(other.doc, { a: { b: other.block, o: 0 }, f: { b: other.block, o: 2 } })!;
    const second = new Tx(other.doc);
    expect(insertInlineLink(second, mixed, "替换", "https://example.test/")).toBeNull();
    expect(second.ops).toHaveLength(0);
  });
  it("does not override a link modified while the dialog is open", () => {
    const { doc, block } = fixture("文字"), anchor = captureInlineLinkSelection(doc, { a: { b: block, o: 0 }, f: { b: block, o: 2 } })!;
    new Tx(doc).format(block, 0, 2, "link", "https://other.test/");
    const tx = new Tx(doc);
    expect(insertInlineLink(tx, anchor, "文字", "https://example.test/")).toBeNull();
    expect(tx.ops).toHaveLength(0);
  });
  it("rejects a changed block type while the form is open", () => {
    const { doc, block } = fixture("a"), anchor = captureInlineLink(doc, { b: block, o: 1 })!;
    new Tx(doc).setProp(block, "type", "h1");
    const tx = new Tx(doc);
    expect(insertInlineLink(tx, anchor, "link", "https://example.test/")).toBeNull();
    expect(tx.ops).toHaveLength(0);
  });
  it("distinguishes a manually authored internal link from a reference", () => {
    const { doc, block } = fixture("链接"), anchor = captureInlineLinkSelection(doc, { a: { b: block, o: 0 }, f: { b: block, o: 2 } })!;
    expect(insertInlineLink(new Tx(doc), anchor, "链接", "#/doc/12")).not.toBeNull();
    expect(doc.richChars(block).every((char) => char.marks.link === "#/doc/12" && char.marks.linkKind === "text")).toBe(true);
  });
  it("does not edit or insert inside a document reference", () => {
    const { doc, block } = fixture("引用"), tx = new Tx(doc);
    tx.format(block, 0, 2, "link", "#/doc/12"); tx.format(block, 0, 2, "linkKind", "reference");
    expect(captureInlineLinkSelection(doc, { a: { b: block, o: 0 }, f: { b: block, o: 1 } })).toBeNull();
    expect(captureInlineLink(doc, { b: block, o: 1 })).toBeNull();
  });
  it("rejects a changed link classification while the form is open", () => {
    const { doc, block } = fixture("链接"), anchor = captureInlineLinkSelection(doc, { a: { b: block, o: 0 }, f: { b: block, o: 2 } })!;
    new Tx(doc).format(block, 0, 2, "linkKind", "text");
    const tx = new Tx(doc);
    expect(insertInlineLink(tx, anchor, "链接", "#/doc/12")).toBeNull();
    expect(tx.ops).toHaveLength(0);
  });
});
