import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { buildDocx } from "@jiange/doc-sdk/docx";
import { toMarkdown } from "@jiange/doc-sdk/markdown";
import {
  cellRichKey,
  setTableCellRich,
  tableCellHasMark,
  tableCellRich,
  tableDataOf,
  toggleTableCellRichMark,
  writeTable,
} from "./table-cells";
import { parseTableRichHTML, tableRichHTML } from "./table-rich-clipboard";
import { TableBlock } from "./table-block";

describe("document table cell rich text", () => {
  it("toggles whole-cell and sub-range inline marks and preserves uniform style on plain text edit", () => {
    const doc = new Doc(1);
    const tx0 = new Tx(doc);
    const tbl = tx0.create("table", null, ROOT);
    writeTable(tx0, tbl, {}, [["指标", "说明"], ["延迟", "核心链路 P99 达标"]], 1);

    // Whole-cell bold + color on (1, 0)
    const tx1 = new Tx(doc);
    const boldSpans = toggleTableCellRichMark(doc.blockInfo(tbl).props, 1, 0, "延迟", "bold");
    setTableCellRich(tx1, tbl, [{ row: 1, col: 0, spans: boldSpans }]);
    const colorSpans = toggleTableCellRichMark(doc.blockInfo(tbl).props, 1, 0, "延迟", "color", "#d83931");
    setTableCellRich(tx1, tbl, [{ row: 1, col: 0, spans: colorSpans }]);

    expect(tableCellHasMark(doc.blockInfo(tbl).props, 1, 0, "bold", "延迟")).toBe(true);
    expect(tableCellRich(doc.blockInfo(tbl).props, 1, 0, "延迟")).toEqual([
      { text: "延迟", marks: { bold: true, color: "#D83931" } },
    ]);

    // Plain-text edit preserves uniform cell-level marks
    expect(tableCellRich(doc.blockInfo(tbl).props, 1, 0, "响应延迟")).toEqual([
      { text: "响应延迟", marks: { bold: true, color: "#D83931" } },
    ]);

    // Sub-range inline code on "P99" in (1, 1): "核心链路 P99 达标" -> indices 5..8
    const tx2 = new Tx(doc);
    const partial = toggleTableCellRichMark(doc.blockInfo(tbl).props, 1, 1, "核心链路 P99 达标", "code", undefined, { start: 5, end: 8 });
    setTableCellRich(tx2, tbl, [{ row: 1, col: 1, spans: partial }]);
    expect(tableCellRich(doc.blockInfo(tbl).props, 1, 1, "核心链路 P99 达标")).toEqual([
      { text: "核心链路 " },
      { text: "P99", marks: { code: true } },
      { text: " 达标" },
    ]);

    // Toggling off clears the register back to empty
    const tx3 = new Tx(doc);
    const cleared = toggleTableCellRichMark(doc.blockInfo(tbl).props, 1, 1, "核心链路 P99 达标", "code", undefined, { start: 5, end: 8 });
    setTableCellRich(tx3, tbl, [{ row: 1, col: 1, spans: cleared }]);
    expect(doc.blockInfo(tbl).props[cellRichKey("r1", "c1")]).toBe("");
  });

  it("renders rich toolbar controls and rich overlays in TableBlock", () => {
    const doc = new Doc(2);
    const tx = new Tx(doc);
    const tbl = tx.create("table", null, ROOT);
    writeTable(tx, tbl, {}, [["列 1", "列 2"], ["重要数据", "代码片段"]], 2);
    setTableCellRich(tx, tbl, [
      { row: 1, col: 0, spans: [{ text: "重要", marks: { bold: true, color: "#D83931" } }, { text: "数据" }] },
      { row: 1, col: 1, spans: [{ text: "代码片段", marks: { italic: true, code: true } }] },
    ]);
    const props = doc.blockInfo(tbl).props;
    const editableHtml = renderToStaticMarkup(
      <TableBlock
        data={tableDataOf(props)}
        fillProps={props}
        onEdit={() => {}}
        onRichMark={() => null}
        onDelete={() => {}}
        readOnly={false}
      />,
    );
    expect(editableHtml).toContain('data-table-rich-mark="bold"');
    expect(editableHtml).toContain('data-table-rich-mark="italic"');
    expect(editableHtml).toContain('data-table-rich-mark="underline"');
    expect(editableHtml).toContain('data-table-rich-mark="strike"');
    expect(editableHtml).toContain('data-table-rich-mark="code"');
    expect(editableHtml).toContain('data-table-rich-mark="color"');
    expect(editableHtml).toContain("data-table-rich-overlay");
    expect(editableHtml).toContain("<strong");
    expect(editableHtml).toContain("<code");
    expect(editableHtml).toContain("#D83931");

    const roHtml = renderToStaticMarkup(
      <TableBlock
        data={tableDataOf(props)}
        fillProps={props}
        onEdit={() => {}}
        onDelete={() => {}}
        readOnly={true}
      />,
    );
    expect(roHtml).toContain("<strong");
    expect(roHtml).toContain("<em");
  });

  it("preserves rich cell marks across clipboard HTML, DOCX export, and Markdown export", async () => {
    const doc = new Doc(3);
    const tx = new Tx(doc);
    const tbl = tx.create("table", null, ROOT);
    const rows = [["项目", "状态"], ["鉴格", "核心通过"]];
    writeTable(tx, tbl, {}, rows, 3);
    setTableCellRich(tx, tbl, [
      { row: 1, col: 0, spans: [{ text: "鉴格", marks: { bold: true, underline: true, color: "#245BDB" } }] },
      { row: 1, col: 1, spans: [{ text: "核心", marks: { italic: true } }, { text: "通过", marks: { code: true } }] },
    ]);
    const props = doc.blockInfo(tbl).props;

    // Clipboard round-trip
    const html = tableRichHTML(rows, props, { r0: 0, c0: 0, r1: 1, c1: 1 }, []);
    expect(html).toBeTruthy();
    expect(html).toContain("<strong><u>鉴格</u></strong>");
    expect(html).toContain("<code>通过</code>");
    const parsed = parseTableRichHTML(html!, "项目\t状态\n鉴格\t核心通过");
    expect(parsed?.cells[1][0].rich).toEqual([
      { text: "鉴格", marks: { bold: true, underline: true, color: "#245BDB" } },
    ]);

    // DOCX export
    const docxBytes = buildDocx({ blocks: [{ type: "table", props, spans: [] }] }, { title: "表格富文本导出" });
    const docXml = new TextDecoder().decode(docxBytes);
    expect(docXml).toContain('<w:u w:val="single"/>');
    expect(docXml).toContain('<w:color w:val="245BDB"/>');
    expect(docXml).toContain("<w:i/>");
    expect(docXml).toContain('w:ascii="Courier New"');

    // Markdown export
    const md = toMarkdown([{ type: "table", text: "", props, spans: [] }]);
    expect(md).toContain("<u>**鉴格**</u>");
    expect(md).toContain("*核心*`通过`");
  });
});
