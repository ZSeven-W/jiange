import { tableCellAlign, tableCellFill, type TableAlign, type TableAlignAxis } from './table-cells';
import { reorderIndices, type CellRange, type TableOp } from './table-ops';

export type FillGrid = string[][];
export function readTableFills(props: Record<string, string>, rows: number, cols: number): FillGrid {
  return Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => tableCellFill(props, row, col)));
}
export function readTableAlignments(props: Record<string, string>, rows: number, cols: number, axis: TableAlignAxis): FillGrid {
  return Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => tableCellAlign(props, row, col, axis)));
}

/** Match row/column edits to the existing content model; clearing text keeps fill. */
export function remapTableFills(grid: FillGrid, op: TableOp): FillGrid {
  const rows = grid.length, cols = grid[0]?.length ?? 0, next = grid.map(row => [...row]);
  switch (op.kind) {
    case 'insertRow': next.splice(Math.max(0, Math.min(rows, op.at)), 0, Array(cols).fill('')); break;
    case 'insertCol': for (const row of next) row.splice(Math.max(0, Math.min(cols, op.at)), 0, ''); break;
    case 'deleteRow': if (rows > 1) next.splice(op.index, 1); break;
    case 'deleteCol': if (cols > 1) for (const row of next) row.splice(op.index, 1); break;
    case 'moveRow': [next[op.index], next[op.to]] = [next[op.to], next[op.index]]; break;
    case 'moveCol': for (const row of next) [row[op.index], row[op.to]] = [row[op.to], row[op.index]]; break;
    case 'reorderRows': { const order=reorderIndices(rows,op.indices,op.before);return order?order.map(i=>[...next[i]]):next; }
    case 'reorderCols': { const order=reorderIndices(cols,op.indices,op.before);return order?next.map(row=>order.map(i=>row[i])):next; }
  }
  return next;
}
export function deleteSelectionFills(grid: FillGrid, kind: 'rows' | 'cols', range: CellRange): FillGrid {
  let next = grid;
  const start = kind === 'rows' ? range.r0 : range.c0, end = kind === 'rows' ? range.r1 : range.c1;
  for (let index = end; index >= start; index--) next = remapTableFills(next, { kind: kind === 'rows' ? 'deleteRow' : 'deleteCol', index });
  return next;
}
export const fillCells = (grid: FillGrid) => grid.flatMap((row, r) => row.map((fill, c) => ({ row: r, col: c, fill })));
export const alignmentCells = (grid: FillGrid, axis: TableAlignAxis) => grid.flatMap((row, r) => row.map((align, c) => ({ row: r, col: c, axis, align: (align || (axis === 'horizontal' ? 'left' : 'top')) as TableAlign })));
