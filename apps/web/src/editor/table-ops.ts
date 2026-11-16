/**
 * 表格结构操作与合并单元格（纯函数）。表格内容仍存于 tableData（整表 JSON），
 * 合并信息存于独立块属性 tableMerges：[[行, 列, 跨行, 跨列], ...]。不涉及协同协议。
 */
export type Merge = [number, number, number, number];
export type TableOp =
  | { kind: "insertRow"; at: number }
  | { kind: "insertCol"; at: number }
  | { kind: "deleteRow"; index: number }
  | { kind: "deleteCol"; index: number }
  | { kind: "clearRow"; index: number }
  | { kind: "clearCol"; index: number }
  | { kind: "moveRow"; index: number; to: number }
  | { kind: "moveCol"; index: number; to: number }
  | { kind: "reorderRows"; indices: number[]; before: number }
  | { kind: "reorderCols"; indices: number[]; before: number };
/** 列宽：null 表示按内容自动。 */
export type Widths = (number | null)[];
export interface CellRange { r0: number; c0: number; r1: number; c1: number }
export interface TableAnchorTransfer { fromRow: number; fromCol: number; toRow: number; toCol: number; newRow: number; newCol: number }

export const normRange = (a: CellRange): CellRange => ({ r0: Math.min(a.r0, a.r1), c0: Math.min(a.c0, a.c1), r1: Math.max(a.r0, a.r1), c1: Math.max(a.c0, a.c1) });

/** 解析并清洗合并信息：越界、尺寸为 1×1、与之前的合并重叠的项被丢弃。 */
export function parseMerges(raw: string | undefined, rows: number, cols: number): Merge[] {
  let list: unknown;
  try { list = JSON.parse(raw || "[]"); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out: Merge[] = [];
  for (const m of list) {
    if (!Array.isArray(m) || m.length !== 4 || !m.every((n) => Number.isInteger(n))) continue;
    const [r, c, rs, cs] = m as Merge;
    if (r < 0 || c < 0 || rs < 1 || cs < 1 || (rs === 1 && cs === 1) || r + rs > rows || c + cs > cols) continue;
    if (out.some((o) => overlaps(o, [r, c, rs, cs]))) continue;
    out.push([r, c, rs, cs]);
  }
  return out;
}

/** Structural moves must not silently discard malformed merge metadata. */
export function parseMergesStrict(raw: string | undefined, rows: number, cols: number): Merge[] | null {
  if (!raw) return [];
  if (raw.length > 256 * 1024) return null;
  try {
    const value:unknown=JSON.parse(raw);if(!Array.isArray(value))return null;
    const parsed=parseMerges(raw,rows,cols);return parsed.length===value.length?parsed:null;
  } catch { return null; }
}

const overlaps = (a: Merge, b: Merge) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/** 单元格覆盖关系：合并起点带跨度，被覆盖的格为 hidden。 */
export function coverMap(merges: Merge[]): Map<string, { span: [number, number] } | "hidden"> {
  const map = new Map<string, { span: [number, number] } | "hidden">();
  for (const [r, c, rs, cs] of merges) {
    for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) map.set(`${i}:${j}`, "hidden");
    map.set(`${r}:${c}`, { span: [rs, cs] });
  }
  return map;
}

/** 把选区扩展到完整包含与之相交的合并块。 */
export function expandRange(range: CellRange, merges: Merge[]): CellRange {
  let g = normRange(range);
  for (let changed = true; changed;) {
    changed = false;
    for (const [r, c, rs, cs] of merges) {
      if (!overlaps([g.r0, g.c0, g.r1 - g.r0 + 1, g.c1 - g.c0 + 1], [r, c, rs, cs])) continue;
      const n = { r0: Math.min(g.r0, r), c0: Math.min(g.c0, c), r1: Math.max(g.r1, r + rs - 1), c1: Math.max(g.c1, c + cs - 1) };
      if (n.r0 !== g.r0 || n.c0 !== g.c0 || n.r1 !== g.r1 || n.c1 !== g.c1) { g = n; changed = true; }
    }
  }
  return g;
}

/** 合并选区：内部已有合并被吸收；被覆盖格的文字按行拼接到起点格（与飞书一致保留内容）。 */
export function mergeCells(rows: string[][], merges: Merge[], range: CellRange): { rows: string[][]; merges: Merge[] } | null {
  const g = expandRange(range, merges);
  if (g.r0 === g.r1 && g.c0 === g.c1) return null;
  const texts: string[] = [];
  for (let i = g.r0; i <= g.r1; i++) for (let j = g.c0; j <= g.c1; j++) if (rows[i]?.[j]) texts.push(rows[i][j]);
  const next = rows.map((row, i) => row.map((cell, j) => (i >= g.r0 && i <= g.r1 && j >= g.c0 && j <= g.c1 ? (i === g.r0 && j === g.c0 ? texts.join(" ") : "") : cell)));
  const kept = merges.filter((m) => !overlaps(m, [g.r0, g.c0, g.r1 - g.r0 + 1, g.c1 - g.c0 + 1]));
  return { rows: next, merges: [...kept, [g.r0, g.c0, g.r1 - g.r0 + 1, g.c1 - g.c0 + 1]] };
}

/** 拆分包含 (r, c) 的合并块。 */
export function splitCell(merges: Merge[], r: number, c: number): Merge[] | null {
  const i = merges.findIndex(([mr, mc, rs, cs]) => r >= mr && r < mr + rs && c >= mc && c < mc + cs);
  return i < 0 ? null : merges.filter((_, k) => k !== i);
}

/** Move selected indices, preserving their order, before an original boundary. */
export function reorderIndices(count: number, indices: readonly number[], before: number): number[] | null {
  if (!Number.isSafeInteger(count) || count < 1 || count > 5000 || !Number.isSafeInteger(before) || before < 0 || before > count || !indices.length || indices.some(i => !Number.isSafeInteger(i) || i < 0 || i >= count) || new Set(indices).size !== indices.length) return null;
  const selected=[...indices].sort((a,b)=>a-b), chosen=new Set(selected);
  const remaining=Array.from({length:count},(_,i)=>i).filter(i=>!chosen.has(i));
  const at=remaining.filter(i=>i<before).length;
  return [...remaining.slice(0,at),...selected,...remaining.slice(at)];
}

/** Reject permutations that split or reverse an existing merged region. */
export function planTableReorder(rows: string[][], merges: Merge[], op: Extract<TableOp,{kind:"reorderRows"|"reorderCols"}>): {rows:string[][];merges:Merge[];order:number[]} | null {
  const cols=rows[0]?.length??0;
  if(!rows.length || !cols || rows.length>200 || cols>50 || rows.length*cols>5000 || rows.some(row=>!Array.isArray(row)||row.length!==cols||row.some(cell=>typeof cell!=="string")))return null;
  const byRow=op.kind==='reorderRows', order=reorderIndices(byRow?rows.length:cols,op.indices,op.before);
  if(!order)return null;
  const inverse=Array.from({length:order.length},()=>0);order.forEach((old,index)=>{inverse[old]=index;});
  const mapped:Merge[]=[];
  for(const [r,c,rs,cs] of merges){
    if(![r,c,rs,cs].every(Number.isSafeInteger)||r<0||c<0||rs<1||cs<1||r+rs>rows.length||c+cs>cols)return null;
    const start=byRow?r:c, span=byRow?rs:cs;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(span)||start<0||span<1||start+span>order.length)return null;
    const next=inverse[start];
    for(let i=1;i<span;i++)if(inverse[start+i]!==next+i)return null;
    mapped.push(byRow?[next,c,rs,cs]:[r,next,rs,cs]);
  }
  const reordered=byRow?order.map(i=>[...rows[i]]):rows.map(row=>order.map(i=>row[i]));
  return {rows:reordered,merges:mapped,order};
}

/** 结构操作；合并块随行列插入平移/扩展，删除行列时收缩，失效者丢弃。 */
export function applyTableOp(rows: string[][], merges: Merge[], op: TableOp): { rows: string[][]; merges: Merge[] } {
  const cols = rows[0]?.length ?? 0;
  const blank = (n: number) => Array.from({ length: n }, () => "");
  switch (op.kind) {
    case "insertRow": {
      const at = Math.max(0, Math.min(rows.length, op.at));
      const next = [...rows.slice(0, at), blank(cols), ...rows.slice(at)];
      const m = merges.map(([r, c, rs, cs]): Merge => (at <= r ? [r + 1, c, rs, cs] : at < r + rs ? [r, c, rs + 1, cs] : [r, c, rs, cs]));
      return { rows: next, merges: m };
    }
    case "insertCol": {
      const at = Math.max(0, Math.min(cols, op.at));
      const next = rows.map((row) => [...row.slice(0, at), "", ...row.slice(at)]);
      const m = merges.map(([r, c, rs, cs]): Merge => (at <= c ? [r, c + 1, rs, cs] : at < c + cs ? [r, c, rs, cs + 1] : [r, c, rs, cs]));
      return { rows: next, merges: m };
    }
    case "deleteRow": {
      if (rows.length <= 1) return { rows, merges };
      const d = op.index;
      const next = rows.filter((_, i) => i !== d);
      const m = merges.flatMap(([r, c, rs, cs]): Merge[] => {
        if (d < r) return [[r - 1, c, rs, cs]];
        if (d >= r + rs) return [[r, c, rs, cs]];
        return rs - 1 >= 1 && (rs - 1 > 1 || cs > 1) ? [[r, c, rs - 1, cs]] : [];
      });
      return { rows: next, merges: m };
    }
    case "deleteCol": {
      if (cols <= 1) return { rows, merges };
      const d = op.index;
      const next = rows.map((row) => row.filter((_, j) => j !== d));
      const m = merges.flatMap(([r, c, rs, cs]): Merge[] => {
        if (d < c) return [[r, c - 1, rs, cs]];
        if (d >= c + cs) return [[r, c, rs, cs]];
        return cs - 1 >= 1 && (cs - 1 > 1 || rs > 1) ? [[r, c, rs, cs - 1]] : [];
      });
      return { rows: next, merges: m };
    }
    case "moveRow":
    case "moveCol": {
      if (!canMove(rows, merges, op)) return { rows, merges };
      const { index: a, to: b } = op;
      const swap = (i: number) => (i === a ? b : i === b ? a : i);
      if (op.kind === "moveRow") {
        const next = rows.map((_, i) => rows[swap(i)]);
        return { rows: next, merges: merges.map(([r, c, rs, cs]): Merge => [rs === 1 ? swap(r) : r, c, rs, cs]) };
      }
      const next = rows.map((row) => row.map((_, j) => row[swap(j)]));
      return { rows: next, merges: merges.map(([r, c, rs, cs]): Merge => [r, cs === 1 ? swap(c) : c, rs, cs]) };
    }
    case "reorderRows":
    case "reorderCols": {
      const result=planTableReorder(rows,merges,op);
      return result?{rows:result.rows,merges:result.merges}:{rows,merges};
    }
    case "clearRow":
      return { rows: rows.map((row, i) => (i === op.index ? blank(row.length) : row)), merges };
    case "clearCol":
      return { rows: rows.map((row) => row.map((cell, j) => (j === op.index ? "" : cell))), merges };
  }
}

/** Keep a merged cell's visible anchor when only its first row or column is removed. */
export function planTableAxisDelete(rows: string[][], merges: Merge[], op: Extract<TableOp, { kind: "deleteRow" | "deleteCol" }>):
  | { ok: true; rows: string[][]; merges: Merge[]; transfers: TableAnchorTransfer[] }
  | { ok: false; message: string } {
  const cols = rows[0]?.length ?? 0, count = op.kind === "deleteRow" ? rows.length : cols;
  if (!count || rows.some(row => row.length !== cols || row.some(cell => typeof cell !== "string")) || !Number.isSafeInteger(op.index) || op.index < 0 || op.index >= count || count <= 1) return { ok: false, message: "无法删除最后一行或最后一列。" };
  if (!parseMergesStrict(JSON.stringify(merges), rows.length, cols)) return { ok: false, message: "表格合并数据无效，未删除行列。" };
  const next = applyTableOp(rows, merges, op), result = next.rows.map(row => [...row]), transfers: TableAnchorTransfer[] = [];
  for (const [r, c, rs, cs] of merges) {
    const row = op.kind === "deleteRow" && op.index === r && rs > 1;
    const col = op.kind === "deleteCol" && op.index === c && cs > 1;
    if (!row && !col) continue;
    const toRow = r + (row ? 1 : 0), toCol = c + (col ? 1 : 0), newRow = r, newCol = c;
    if (rows[toRow]?.[toCol]) return { ok: false, message: "合并区域中有隐藏内容，请先拆分单元格再删除。" };
    result[newRow][newCol] = rows[r][c];
    transfers.push({ fromRow: r, fromCol: c, toRow, toCol, newRow, newCol });
  }
  return { ok: true, rows: result, merges: next.merges, transfers };
}

/** 相邻行/列交换；任一侧被跨行（跨列）合并块覆盖时不可移动。 */
export function canMove(rows: string[][], merges: Merge[], op: { kind: "moveRow" | "moveCol"; index: number; to: number }): boolean {
  const n = op.kind === "moveRow" ? rows.length : (rows[0]?.length ?? 0);
  if (op.to < 0 || op.to >= n || Math.abs(op.to - op.index) !== 1) return false;
  const lines = [op.index, op.to];
  return !merges.some(([r, c, rs, cs]) => (op.kind === "moveRow" ? rs > 1 && lines.some((i) => i >= r && i < r + rs) : cs > 1 && lines.some((j) => j >= c && j < c + cs)));
}

/** 列宽随列插入、删除、移动同步（null 为自动宽度）；无列操作时返回 undefined。 */
export function remapWidths(widths: Widths | undefined, op: TableOp, cols: number): Widths | undefined {
  if (!widths?.length) return undefined;
  const w: Widths = Array.from({ length: cols }, (_, i) => widths[i] ?? null);
  switch (op.kind) {
    case "insertCol": { const at = Math.max(0, Math.min(cols, op.at)); return [...w.slice(0, at), null, ...w.slice(at)]; }
    case "deleteCol": return cols <= 1 ? undefined : w.filter((_, i) => i !== op.index);
    case "moveCol": { const next = [...w]; [next[op.index], next[op.to]] = [next[op.to], next[op.index]]; return next; }
    case "reorderCols": { const order=reorderIndices(cols,op.indices,op.before);return order?.map(i=>w[i]); }
    default: return undefined;
  }
}

/** The selection toolbar can delete full rows, full columns, or the whole table. */
export function planSelectionDelete(rows: string[][], merges: Merge[], widths: Widths | undefined, selection: CellRange):
  | { kind: "table" }
  | { kind: "rows" | "cols"; rows: string[][]; merges: Merge[]; widths?: Widths }
  | null {
  const nrows = rows.length, ncols = rows[0]?.length ?? 0;
  const range = normRange(selection);
  if (!nrows || !ncols || rows.some((row) => row.length !== ncols) ||
      ![range.r0, range.r1, range.c0, range.c1].every(Number.isInteger) ||
      range.r0 < 0 || range.c0 < 0 || range.r1 >= nrows || range.c1 >= ncols) return null;
  const expanded = expandRange(range, merges);
  if (expanded.r0 !== range.r0 || expanded.r1 !== range.r1 || expanded.c0 !== range.c0 || expanded.c1 !== range.c1) return null;
  const fullRows = range.c0 === 0 && range.c1 === ncols - 1;
  const fullCols = range.r0 === 0 && range.r1 === nrows - 1;
  if (fullRows && fullCols) return { kind: "table" };
  if (!fullRows && !fullCols) return null;
  let nextRows = rows, nextMerges = merges, nextWidths = widths;
  const kind = fullRows ? "rows" : "cols";
  const start = fullRows ? range.r0 : range.c0, end = fullRows ? range.r1 : range.c1;
  for (let index = end; index >= start; index--) {
    const op: TableOp = { kind: fullRows ? "deleteRow" : "deleteCol", index };
    const result = applyTableOp(nextRows, nextMerges, op);
    nextWidths = remapWidths(nextWidths, op, nextRows[0].length) ?? nextWidths;
    nextRows = result.rows; nextMerges = result.merges;
  }
  return { kind, rows: nextRows, merges: nextMerges, widths: kind === "cols" ? nextWidths : undefined };
}
