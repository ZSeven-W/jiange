import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { bodyBlocks } from "@/editor/model";
import { buildDocx, parseDocx, type DocxExportBlock } from "./docx";
import { appendBlocksOps } from "./md-import";
const b = (type: string, spans: DocxExportBlock["spans"] | string): DocxExportBlock => ({type, props:{}, spans: typeof spans === "string" ? [{text:spans,marks:{}}] : spans});
describe("Word import integration", () => {
  it("imports into a collaborative document through the shared append path", async () => {
    const doc = new Doc(1);
    const init = new Tx(doc);
    const first = init.create("paragraph", null, ROOT);
    init.insert(first, 0, "原内容");
    const { blocks } = await parseDocx(buildDocx({ blocks: [b("h2", "标题"), b("paragraph", [{ text: "粗", marks: { bold: "true" } }, { text: "下", marks: { underline: "true" } }])] }));
    appendBlocksOps(doc, blocks);
    const ids = bodyBlocks(doc);
    expect(doc.text(first)).toBe("原内容");
    expect(doc.blockInfo(ids[1]).type).toBe("h2");
    expect(doc.richChars(ids[2]).map((c) => [c.ch, !!c.marks.bold, !!c.marks.underline])).toEqual([["粗", true, false], ["下", false, true]]);
  });

});
