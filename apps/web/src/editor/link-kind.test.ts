import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@zseven-w/collab";
import { toggleTextLink } from "./link-kind";

function fixture(text: string) { const doc = new Doc(1), tx = new Tx(doc), block = tx.create("paragraph", null, ROOT); tx.insert(block, 0, text); return { doc, block }; }
describe("manual text links", () => {
  it("marks internal links as text and undoes both marks together", () => {
    const { doc, block } = fixture("目标文字"), sel = { a: { b: block, o: 0 }, f: { b: block, o: 4 } }, tx = new Tx(doc);
    expect(toggleTextLink(tx, sel, "#/doc/12")).toBe("applied");
    expect(doc.richChars(block).every((char) => char.marks.link === "#/doc/12" && char.marks.linkKind === "text")).toBe(true);
    const undo = new UndoManager(); undo.record(tx, sel, sel); undo.undo(doc);
    expect(doc.richChars(block).every((char) => !char.marks.link && !char.marks.linkKind)).toBe(true);
    undo.redo(doc); expect(doc.richChars(block)[0].marks.linkKind).toBe("text");
    expect(toggleTextLink(new Tx(doc), sel, "#/doc/12")).toBe("applied");
    expect(doc.richChars(block).every((char) => !char.marks.link && !char.marks.linkKind)).toBe(true);
  });
  it("does not overwrite a document reference or formula", () => {
    for (const kind of ["reference", "math", "mention"] as const) {
      const { doc, block } = fixture("目标文字"), setup = new Tx(doc);
      if (kind === "reference") { setup.format(block, 0, 2, "link", "#/doc/12"); setup.format(block, 0, 2, "linkKind", "reference"); }
      else if (kind === "math") setup.format(block, 0, 2, "math", "x^2");
      else setup.format(block, 0, 2, "mention", "7");
      const tx = new Tx(doc), result = toggleTextLink(tx, { a: { b: block, o: 0 }, f: { b: block, o: 4 } }, "https://example.test/");
      expect(result).toBe("blocked"); expect(tx.ops).toHaveLength(0);
    }
  });
  it("clears the internal discriminator when changing to an external link", () => {
    const { doc, block } = fixture("文字"), sel = { a: { b: block, o: 0 }, f: { b: block, o: 2 } };
    toggleTextLink(new Tx(doc), sel, "#/doc/12");
    toggleTextLink(new Tx(doc), sel, "https://example.test/");
    expect(doc.richChars(block).every((char) => char.marks.link === "https://example.test/" && !char.marks.linkKind)).toBe(true);
    expect(toggleTextLink(new Tx(doc), sel, "javascript:alert(1)")).toBe("invalid");
  });
});
