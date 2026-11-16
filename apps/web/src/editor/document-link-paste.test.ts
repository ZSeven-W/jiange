import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { pastedDocumentLink } from "./document-link-paste";
import { pasteBlocks } from "./model";

const docs = [{ id: 12, title: " 项目😀说明 " }, { id: 9, title: "" }];
const convert = (value: string, raw = "") => pastedDocumentLink(raw, value, "https://example.test", "/", docs);

describe("pasted document links", () => {
  it("inserts an accessible document title as a mention and undoes it", () => {
    const clip = convert("https://example.test/#/doc/12")!;
    const doc = new Doc(1), init = new Tx(doc), block = init.create("paragraph", null, ROOT);
    init.insert(block, 0, "前后");
    const tx = new Tx(doc); pasteBlocks(tx, { b: block, o: 1 }, clip);
    expect(doc.text(block)).toBe("前项目😀说明后");
    expect(doc.richChars(block).slice(1, -1).every((ch) => ch.marks.link === "#/doc/12")).toBe(true);
    const undo = new UndoManager(); undo.record(tx, null, null); undo.undo(doc);
    expect(doc.text(block)).toBe("前后");
    undo.redo(doc); expect(doc.text(block)).toBe("前项目😀说明后");
    expect(convert("https://example.test/#/doc/9")?.[0].chars.map((c) => c.ch).join("")).toBe("未命名文档");
  });
  it.each([
    "https://evil.test/#/doc/12", "https://example.test/other/#/doc/12",
    "https://example.test/?extra=1#/doc/12", "https://example.test/#/doc/12?block=1:2",
    "https://example.test/#/doc/13", "https://example.test/#/doc/012",
    "https://example.test/#/doc/9007199254740992", "https://example.test/#/s/token",
    " https://example.test/#/doc/12", "https://example.test/#/doc/12\n",
    "javascript:alert(1)", "https://user@example.test/#/doc/12",
  ])("leaves other or ambiguous input unchanged: %s", (value) => {
    expect(convert(value)).toBeNull();
  });
  it("does not override a rich clipboard payload", () => {
    expect(convert("https://example.test/#/doc/12", '[{"type":"paragraph"}]')).toBeNull();
  });
});
