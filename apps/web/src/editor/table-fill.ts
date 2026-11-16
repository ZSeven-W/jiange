import { tableCellAlign, tableCellFill, type TableAlign, type TableAlignAxis } from './table-cells';
import { reorderIndices, type CellRange, type Merge, type TableOp } from './table-ops';

export type FillGrid = string[][];
export type TableFormatTarget = { kind: 'range'; range: CellRange } | { kind: 'axes'; axis: 'row' | 'col'; indices: number[] };

/** Expand only intersecting merged cells, without filling gaps between axes. */
export function tableFormatCells(rows: number, cols: number, merges: readonly Merge[], target: TableFormatTarget): { row: number; col: number }[] | null {
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 1 || cols < 1 || rows > 200 || cols > 50 || rows * cols > 5000) return null;
  const selected = new Set<number>();
  const add = (row: number, col: number) => selected.add(row * cols + col);
  if (target.kind === 'range') {
    const { r0, r1, c0, c1 } = target.range;
    if (![r0, r1, c0, c1].every(Number.isSafeInteger) || r0 < 0 || c0 < 0 || r1 < r0 || c1 < c0 || r1 >= rows || c1 >= cols) return null;
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) add(row, col);
  } else {
    if (target.axis !== 'row' && target.axis !== 'col') return null;
    const count = target.axis === 'row' ? rows : cols;
    if (!target.indices.length || new Set(target.indices).size !== target.indices.length || target.indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= count)) return null;
    for (const index of target.indices) {
      if (target.axis === 'row') for (let col = 0; col < cols; col++) add(index, col);
      else for (let row = 0; row < rows; row++) add(row, index);
    }
  }
  for (const [r, c, rs, cs] of merges) {
    if (![r, c, rs, cs].every(Number.isSafeInteger) || r < 0 || c < 0 || rs < 1 || cs < 1 || r + rs > rows || c + cs > cols) return null;
    let intersects = false;
    for (let row = r; row < r + rs && !intersects; row++) for (let col = c; col < c + cs; col++) if (selected.has(row * cols + col)) { intersects = true; break; }
    if (intersects) for (let row = r; row < r + rs; row++) for (let col = c; col < c + cs; col++) add(row, col);
  }
  return [...selected].sort((a, b) => a - b).map(index => ({ row: Math.floor(index / cols), col: index % cols }));
}
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
