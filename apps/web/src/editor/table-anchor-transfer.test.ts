import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@zseven-w/collab";
import { buildDocx, parseDocx } from "@zseven-w/doc-sdk/docx";
import { applyTableWrites, cellAlignKey, cellFillKey, cellTableWrites, setTableCellAlignments, setTableCellFills, stableTableDeleteWrites, tableCellAlign, tableCellFill, tableRowsOf, writeTable } from "./table-cells";
import { planAnchorFormats } from "./table-anchor-transfer";
import { planTableAxisDelete } from "./table-ops";

const transfer = { fromRow: 0, fromCol: 0, toRow: 1, toCol: 0, newRow: 0, newCol: 0 };
function fixture(): Record<string, string> {
  const rows = [["标题", "状态"], ["", "完成"]], props: Record<string, string> = { tableData: JSON.stringify(rows) };
  Object.assign(props, cellTableWrites(props, rows, 1));
  return props;
}

describe("merged anchor format transfer", () => {
  it("preserves the visible fill and alignment on the new anchor", () => {
    const props = fixture();
    props[cellFillKey("r0", "c0")] = "#E3ECFF";
    props[cellAlignKey("r0", "c0", "horizontal")] = "center";
    props[cellAlignKey("r0", "c0", "vertical")] = "bottom";
    expect(planAnchorFormats(props, [transfer])).toEqual({ ok: true, fills: [{ row: 0, col: 0, fill: "#E3ECFF" }], alignments: [{ row: 0, col: 0, axis: "horizontal", align: "center" }, { row: 0, col: 0, axis: "vertical", align: "bottom" }] });
  });
  it("refuses hidden formatting conflicts or malformed metadata", () => {
    const props = fixture();
    props[cellFillKey("r1", "c0")] = "#E5F5E8";
    expect(planAnchorFormats(props, [transfer])).toMatchObject({ ok: false, message: expect.stringContaining("隐藏格式") });
    props[cellFillKey("r1", "c0")] = "url(evil)";
    expect(planAnchorFormats(props, [transfer])).toMatchObject({ ok: false, message: expect.stringContaining("格式无法识别") });
    expect(planAnchorFormats({}, [transfer])).toMatchObject({ ok: false });
  });
  it("accepts matching hidden styles without changing the source properties", () => {
    const props = fixture();
    props[cellFillKey("r0", "c0")] = "#E3ECFF";
    props[cellFillKey("r1", "c0")] = "#e3ecff";
    const before = JSON.stringify(props);
    expect(planAnchorFormats(props, [transfer])).toMatchObject({ ok: true });
    expect(JSON.stringify(props)).toBe(before);
  });
  it("keeps a transferred anchor and its styles through a Word round trip", async () => {
    const grid = [["标题", "状态"], ["合并内容", "任务"], ["", "完成"]], doc = new Doc(1), init = new Tx(doc);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify(grid), tableMerges: "[[1,0,2,1]]", tableHeader: "none" });
    const legacy = doc.blockInfo(table).props, migrate = new Tx(doc);
    applyTableWrites(migrate, table, legacy, cellTableWrites(legacy, grid, doc.client));
    const format = new Tx(doc);
    setTableCellFills(format, table, [{ row: 1, col: 0, fill: "#E3ECFF" }]);
    setTableCellAlignments(format, table, [{ row: 1, col: 0, axis: "horizontal", align: "center" }]);
    const props = doc.blockInfo(table).props, deletion = planTableAxisDelete(grid, [[1,0,2,1]], { kind: "deleteRow", index: 1 });
    expect(deletion.ok).toBe(true);
    if (!deletion.ok) throw new Error(deletion.message);
    const styles = planAnchorFormats(props, deletion.transfers);
    expect(styles.ok).toBe(true);
    if (!styles.ok) throw new Error(styles.message);
    const tx = new Tx(doc); applyTableWrites(tx, table, props, stableTableDeleteWrites(props, "row", [1])!);
    writeTable(tx, table, doc.blockInfo(table).props, deletion.rows, doc.client);
    setTableCellFills(tx, table, styles.fills); setTableCellAlignments(tx, table, styles.alignments);
    tx.setProp(table, "tableMerges", JSON.stringify(deletion.merges));
    const imported = (await parseDocx(buildDocx({ blocks: [{ type: "table", props: doc.blockInfo(table).props, spans: [] }] }))).blocks[0];
    expect(tableRowsOf(imported.props)).toEqual([["标题", "状态"], ["合并内容", "完成"]]);
    expect(tableCellFill(imported.props, 1, 0)).toBe("#E3ECFF");
    expect(tableCellAlign(imported.props, 1, 0, "horizontal")).toBe("center");
  });
});
