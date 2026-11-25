import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@zseven-w/collab";
import { bodyBlocks, markdownShortcut } from "../src/model.js";

function make(text = "") {
  const doc = new Doc(1), tx = new Tx(doc), block = tx.create("paragraph", null, ROOT);
  if (text) tx.insert(block, 0, text);
  return { doc, block };
}

describe("Feishu Markdown typing shortcuts", () => {
  it.each([
    ["**粗体😀**", "bold", "粗体😀"],
    ["*斜体*", "italic", "斜体"],
    ["~下划线~", "underline", "下划线"],
    ["~~删除线~~", "strike", "删除线"],
  ])("converts %s only after a trailing space and leaves following text intact", (syntax, mark, result) => {
    const { doc, block } = make(`前 ${syntax}后`), end = [...`前 ${syntax}`].length;
    expect(markdownShortcut(new Tx(doc), { b: block, o: end }, [...syntax].at(-1)!)).toBeNull();
    const tx = new Tx(doc); tx.insert(block, end, " ");
    const cursor = markdownShortcut(tx, { b: block, o: end + 1 }, " ");
    expect(doc.text(block)).toBe(`前 ${result} 后`);
    expect(cursor?.o).toBe([...`前 ${result} `].length);
    const chars = doc.richChars(block);
    expect(chars.slice(2, 2 + [...result].length).every((char) => char.marks[mark] === "true")).toBe(true);
    expect(chars.at(-1)?.marks[mark]).toBeUndefined();
  });
  it("converts inline code and double-dollar formulas on their closing delimiter", () => {
    const code = make("前 `a😀` 后"), codeEnd = [..."前 `a😀`"].length;
    expect(markdownShortcut(new Tx(code.doc), { b: code.block, o: codeEnd }, "`")?.o).toBe([..."前 a😀"].length);
    expect(code.doc.text(code.block)).toBe("前 a😀 后"); expect(code.doc.richChars(code.block)[2].marks.code).toBe("true");
    const math = make("公式 $$x^2$$ 后"), mathEnd = [..."公式 $$x^2$$"].length;
    expect(markdownShortcut(new Tx(math.doc), { b: math.block, o: mathEnd }, "$")?.o).toBe([..."公式 x^2"].length);
    expect(math.doc.text(math.block)).toBe("公式 x^2 后"); expect(math.doc.richChars(math.block)[3].marks.math).toBe("x^2");
    const single = make("$x$"); expect(markdownShortcut(new Tx(single.doc), { b: single.block, o: 3 }, "$")).toBeNull(); expect(single.doc.text(single.block)).toBe("$x$");
  });
  it("does not turn code or formula contents into other styles", () => {
    for (const existing of ["math", "code"]) {
      const { doc, block } = make("~符号~ "); new Tx(doc).format(block, 1, 3, existing, existing === "math" ? "x" : "true");
      const tx = new Tx(doc); expect(markdownShortcut(tx, { b: block, o: 5 }, " ")).toBeNull(); expect(tx.ops).toHaveLength(0); expect(doc.text(block)).toBe("~符号~ ");
    }
  });
  it.each([["#### ", "h4"], ["##### ", "h5"], ["###### ", "h6"], ["####### ", "h7"], ["######## ", "h8"], ["######### ", "h9"]])("converts %s to %s", (syntax, type) => {
    const { doc, block } = make(syntax); markdownShortcut(new Tx(doc), { b: block, o: syntax.length }, " ");
    expect(doc.blockInfo(block).type).toBe(type); expect(doc.text(block)).toBe("");
  });
  it.each(["---", "***"])("creates a divider and a writable paragraph from %s", (syntax) => {
    const { doc, block } = make(syntax); const next = markdownShortcut(new Tx(doc), { b: block, o: 3 }, syntax[2]);
    expect(doc.blockInfo(block).type).toBe("divider"); expect(next && doc.blockInfo(next.b).type).toBe("paragraph"); expect(bodyBlocks(doc)).toHaveLength(2);
  });
  it("undoes conversion without losing a peer's concurrent edit", () => {
    const { doc, block } = make("**文本**"), peer = Doc.fromState(2, doc.encodeState());
    const tx = new Tx(doc); tx.insert(block, 6, " "); markdownShortcut(tx, { b: block, o: 7 }, " ");
    const late = peer.insertText(block, 0, "远端")!; doc.apply(late);
    const undo = new UndoManager(); undo.record(tx, null, null); undo.undo(doc);
    expect(doc.text(block)).toContain("远端"); expect(doc.text(block).replace("远端", "")).toBe("**文本**");
  });
});
