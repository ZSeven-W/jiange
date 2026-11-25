import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@zseven-w/collab";
import { capturePastedLink, documentLinkClip, pastedDocumentURL, resolvePastedLink } from "./document-link-paste";
import { pasteBlocks } from "./model";

const parse = (value: string, raw = "") => pastedDocumentURL(raw, value, "https://example.test", "/");

describe("pasted document links", () => {
  it("preserves a document block target and creates a title mention", () => {
    const target = parse("https://example.test/#/doc/12?block=3%3A9")!;
    expect(target).toEqual({ id: 12, href: "#/doc/12?block=3%3A9" });
    const clip = documentLinkClip(target, " 项目😀说明 ")!;
    expect(clip[0].chars.map((c) => c.ch).join("")).toBe("项目😀说明");
    expect(clip[0].chars.every((c) => c.marks.link === target.href)).toBe(true);
    expect(clip[0].chars.every((c) => c.marks.linkKind === "reference")).toBe(true);
    expect(documentLinkClip(target, "")?.[0].chars.map((c) => c.ch).join("")).toBe("未命名文档");
  });
  it("preserves a share token in the reference", () => {
    const target = parse("https://example.test/#/s/aBc_123")!;
    expect(target).toEqual({ token: "aBc_123", href: "#/s/aBc_123" });
    expect(documentLinkClip(target, "共享文档")?.[0].chars[0].marks.link).toBe("#/s/aBc_123");
    expect(parse("https://example.test/#/p/aBc_123")).toEqual({ token: "aBc_123", href: "#/p/aBc_123" });
  });
  it("recognizes pasted sheet, base, slides, and survey resource URLs", () => {
    expect(parse("https://example.test/#/sheet/18")).toEqual({ id: 18, kind: "sheet", href: "#/sheet/18" });
    expect(parse("https://example.test/#/base/22")).toEqual({ id: 22, kind: "base", href: "#/base/22" });
    expect(parse("https://example.test/#/slides/31")).toEqual({ id: 31, kind: "slides", href: "#/slides/31" });
    expect(parse("https://example.test/#/survey/9")).toEqual({ id: 9, kind: "survey", href: "#/survey/9" });
  });
  it.each([
    "https://evil.test/#/doc/12", "https://example.test/other/#/doc/12",
    "https://example.test/?extra=1#/doc/12", "https://example.test/#/doc/12?block=1%3A2&x=1",
    "https://example.test/#/doc/12?block=bad", "https://example.test/#/doc/012",
    "https://example.test/#/doc/9007199254740992", "https://example.test/#/s/token?other=1",
    " https://example.test/#/doc/12", "https://example.test/#/doc/12\n",
    "javascript:alert(1)", "https://user@example.test/#/doc/12",
  ])("leaves other or ambiguous input unchanged: %s", (value) => expect(parse(value)).toBeNull());
  it("does not override a rich clipboard payload", () => expect(parse("https://example.test/#/doc/12", "rich")).toBeNull());
  it("only resolves unchanged inserted characters at their original location", () => {
    const doc = new Doc(1), tx = new Tx(doc), block = tx.create("paragraph", null, ROOT);
    tx.insert(block, 0, "前https://example.test/#/doc/12后");
    const text = "https://example.test/#/doc/12", anchor = capturePastedLink(doc, block, 1, text)!;
    expect(resolvePastedLink(doc, anchor)).toEqual({ start: 1, end: 1 + text.length });
    doc.insertText(block, 0, "甲");
    expect(resolvePastedLink(doc, anchor)?.start).toBe(2);
    new Tx(doc).format(block, 2, 3, "bold", "true");
    expect(resolvePastedLink(doc, anchor)).toBeNull();
  });
  it("does not replace a range split by a remote insertion", () => {
    const doc = new Doc(1), tx = new Tx(doc), block = tx.create("paragraph", null, ROOT);
    const text = "https://example.test/#/doc/12";
    tx.insert(block, 0, text);
    const anchor = capturePastedLink(doc, block, 0, text)!;
    doc.insertText(block, 4, "并发");
    expect(resolvePastedLink(doc, anchor)).toBeNull();
    expect(doc.text(block)).toContain("并发");
  });
  it("combines literal paste and conversion into one undo action", () => {
    const doc = new Doc(1), initial = new Tx(doc), block = initial.create("paragraph", null, ROOT);
    initial.insert(block, 0, "前后");
    const undo = new UndoManager(), literal = new Tx(doc), value = "https://example.test/#/doc/12";
    literal.insert(block, 1, value); undo.record(literal, null, null, "paste", 100);
    const anchor = capturePastedLink(doc, block, 1, value)!, range = resolvePastedLink(doc, anchor)!;
    const conversion = new Tx(doc); conversion.delete(block, range.start, range.end);
    pasteBlocks(conversion, { b: block, o: range.start }, documentLinkClip(parse(value)!, "需求")!);
    undo.record(conversion, null, null, "paste", 100); undo.seal();
    expect(doc.text(block)).toBe("前需求后");
    undo.undo(doc); expect(doc.text(block)).toBe("前后");
    undo.redo(doc); expect(doc.text(block)).toBe("前需求后");
  });
});
