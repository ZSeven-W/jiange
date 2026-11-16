import { cellAlignKey, cellFillKey, isCellTable, tableCellAlign, tableCellFill, TBL_COLS, TBL_ROWS, type TableAlign, type TableAlignAxis } from "./table-cells";
import type { TableAnchorTransfer } from "./table-ops";

type FormatPlan = { ok: true; fills: { row: number; col: number; fill: string }[]; alignments: { row: number; col: number; axis: TableAlignAxis; align: TableAlign }[] } | { ok: false; message: string };

/** Refuse to overwrite hidden cell formatting while preserving visible anchors. */
export function planAnchorFormats(props: Record<string, string>, transfers: readonly TableAnchorTransfer[]): FormatPlan {
  if (!isCellTable(props)) return { ok: false, message: "表格数据状态不完整，请等待同步后重试。" };
  const rows: string[] = JSON.parse(props[TBL_ROWS]), cols: string[] = JSON.parse(props[TBL_COLS]);
  const fills: { row: number; col: number; fill: string }[] = [];
  const alignments: { row: number; col: number; axis: TableAlignAxis; align: TableAlign }[] = [];
  for (const transfer of transfers) {
    const positions = [[transfer.fromRow, transfer.fromCol], [transfer.toRow, transfer.toCol], [transfer.newRow, transfer.newCol]];
    if (positions.some(([r, c]) => !Number.isSafeInteger(r) || !Number.isSafeInteger(c) || r < 0 || c < 0 || r >= rows.length || c >= cols.length)) return { ok: false, message: "合并区域已变化，请重新操作。" };
    for (const [r, c] of positions.slice(0, 2)) {
      const fill = props[cellFillKey(rows[r], cols[c])] ?? "";
      const horizontal = props[cellAlignKey(rows[r], cols[c], "horizontal")] ?? "";
      const vertical = props[cellAlignKey(rows[r], cols[c], "vertical")] ?? "";
      if ((fill && !/^#[0-9a-f]{6}$/i.test(fill)) || !["", "left", "center", "right"].includes(horizontal) || !["", "top", "middle", "bottom"].includes(vertical)) return { ok: false, message: "合并区域格式无法识别，请先拆分单元格再删除。" };
    }
    const sourceFill = tableCellFill(props, transfer.fromRow, transfer.fromCol), targetFill = tableCellFill(props, transfer.toRow, transfer.toCol);
    const sourceH = tableCellAlign(props, transfer.fromRow, transfer.fromCol, "horizontal"), targetH = tableCellAlign(props, transfer.toRow, transfer.toCol, "horizontal");
    const sourceV = tableCellAlign(props, transfer.fromRow, transfer.fromCol, "vertical"), targetV = tableCellAlign(props, transfer.toRow, transfer.toCol, "vertical");
    if ((targetFill && targetFill !== sourceFill) || (targetH !== "left" && targetH !== sourceH) || (targetV !== "top" && targetV !== sourceV)) return { ok: false, message: "合并区域中有隐藏格式，请先拆分单元格再删除。" };
    fills.push({ row: transfer.newRow, col: transfer.newCol, fill: sourceFill });
    alignments.push({ row: transfer.newRow, col: transfer.newCol, axis: "horizontal", align: sourceH }, { row: transfer.newRow, col: transfer.newCol, axis: "vertical", align: sourceV });
  }
  return { ok: true, fills, alignments };
}
