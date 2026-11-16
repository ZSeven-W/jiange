import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { bodyBlocks } from "@/editor/model";
import { buildDocx, parseDocx, type DocxExportBlock } from "./docx";
import { appendBlocksOps } from "./md-import";
import { insertStarterBlocks } from "@/pages/starter-template-ops";
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

  it("keeps imported table spans and headers in both existing and new documents", async () => {
    const props = { tableData: '[["计划",""],["",""],["项目","完成"]]', tableMerges: '[[0,0,2,2]]', tableHeader: "none", tableHeaderColumn: "column" };
    const bytes = buildDocx({ blocks: [{ type: "table", props, spans: [] }] });
    const { blocks, warnings } = await parseDocx(bytes);
    expect(warnings).toEqual([]);
    for (const starter of [false, true]) {
      const doc = new Doc(1); new Tx(doc).create("paragraph", null, ROOT);
      if (starter) expect(insertStarterBlocks(doc, blocks)).not.toBeNull();
      else appendBlocksOps(doc, blocks);
      const table = bodyBlocks(doc).find((id) => doc.blockInfo(id).type === "table")!;
      expect(doc.blockInfo(table).props).toMatchObject(props);
    }
  });

});
