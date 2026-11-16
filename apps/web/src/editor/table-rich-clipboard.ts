import { tableCellAlign, tableCellFill, type TableHorizontalAlign, type TableVerticalAlign } from './table-cells';
import { formatTableTSV, planTablePasteGrid } from './table-clipboard';
import { coverMap, expandRange, normRange, parseMerges, type CellRange, type Merge } from './table-ops';

export interface RichTableCell { text: string; fill: string; horizontal: TableHorizontalAlign; vertical: TableVerticalAlign }
export type RichTableClipboard = { version: 1; cells: RichTableCell[][] } | { version: 2; cells: RichTableCell[][]; merges: Merge[] };
const MAX_HTML = 2 * 1024 * 1024, MAX_CELLS = 1000, MAX_TEXT = 256 * 1024;
const escapeHTML = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const encode = (value: string) => {
  let binary = ''; const bytes = new TextEncoder().encode(value);
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
const plainGrid = (cells: RichTableCell[][]) => cells.map(row => row.map(cell => cell.text));
function isRichCell(value: unknown): value is RichTableCell {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cell = value as Record<string, unknown>;
  return typeof cell.text === 'string' && typeof cell.fill === 'string' && (cell.fill === '' || /^#[0-9a-f]{6}$/i.test(cell.fill)) && typeof cell.horizontal === 'string' && ['left','center','right'].includes(cell.horizontal) && typeof cell.vertical === 'string' && ['top','middle','bottom'].includes(cell.vertical);
}
function validHiddenCells(cells: RichTableCell[][], merges: Merge[]): boolean {
  const covered=coverMap(merges);
  for(let row=0;row<cells.length;row++) for(let col=0;col<cells[row].length;col++) if(covered.get(`${row}:${col}`)==='hidden') {
    const cell=cells[row][col];
    if(cell.text || cell.fill || cell.horizontal!=='left' || cell.vertical!=='top') return false;
  }
  return true;
}

/** Copy only visible cells. Hidden merged content and its formatting never leave the document. */
export function tableRichHTML(rows: string[][], props: Record<string, string>, range: CellRange, merges: Merge[]): string | null {
  const r = normRange(range), expanded = expandRange(r, merges), width = r.c1-r.c0+1, height = r.r1-r.r0+1;
  if (!Number.isSafeInteger(r.r0) || !Number.isSafeInteger(r.c0) || !Number.isSafeInteger(r.r1) || !Number.isSafeInteger(r.c1) || r.r0 < 0 || r.c0 < 0 || r.r1 >= rows.length || r.c1 >= (rows[0]?.length ?? 0) || !width || !height || width > 50 || height > 200 || width * height > MAX_CELLS || rows.some(row => !Array.isArray(row) || row.length !== rows[0]?.length || row.some(cell => typeof cell !== 'string')) || JSON.stringify(r) !== JSON.stringify(expanded)) return null;
  const cover = coverMap(merges);
  const cells: RichTableCell[][] = Array.from({length: height}, (_, y) => Array.from({length: width}, (_, x) => {
    const row = r.r0+y, col = r.c0+x;
    if (cover.get(`${row}:${col}`) === 'hidden') return {text:'', fill:'', horizontal:'left', vertical:'top'};
    return {text:rows[row][col], fill:tableCellFill(props,row,col), horizontal:tableCellAlign(props,row,col,'horizontal'), vertical:tableCellAlign(props,row,col,'vertical')};
  }));
  if (cells.flat().reduce((n, cell) => n + cell.text.length, 0) > MAX_TEXT) return null;
  const relativeMerges: Merge[] = merges.filter(([row,col]) => row >= r.r0 && col >= r.c0 && row <= r.r1 && col <= r.c1).map(([row,col,rs,cs]) => [row-r.r0,col-r.c0,rs,cs]);
  // Preserve formatted-copy compatibility with older clients when the
  // selection contains no merge geometry.
  const payload = encode(JSON.stringify(relativeMerges.length ? {version:2,cells,merges:relativeMerges} satisfies RichTableClipboard : {version:1,cells} satisfies RichTableClipboard));
  const body = cells.map((row, y) => `<tr>${row.map((cell,x) => {
    const info=cover.get(`${r.r0+y}:${r.c0+x}`); if(info==='hidden') return '';
    const span=info?.span, styles=[cell.fill && `background-color:${cell.fill}`,cell.horizontal!=='left' && `text-align:${cell.horizontal}`,cell.vertical!=='top' && `vertical-align:${cell.vertical}`].filter(Boolean).join(';');
    return `<td${span?.[0] ? ` rowspan="${span[0]}"` : ''}${span?.[1] ? ` colspan="${span[1]}"` : ''}${styles ? ` style="${styles}"` : ''}>${escapeHTML(cell.text).replace(/\n/g,'<br>')}</td>`;
  }).join('')}</tr>`).join('');
  const html=`<table data-jiange-cell-grid="${payload}">${body}</table>`;
  return html.length <= MAX_HTML ? html : null;
}

/** Treat the clipboard as untrusted; accept only our first top-level table and matching plain text. */
export function parseTableRichHTML(html: string, plain: string): RichTableClipboard | null {
  if (!html || html.length > MAX_HTML || plain.length > MAX_TEXT * 2) return null;
  try {
    let offset=0;
    while(offset < html.length && offset < 8192) {
      const tail=html.slice(offset), space=/^\s+/.exec(tail);
      if(space){offset+=space[0].length;continue;}
      if(tail.startsWith('<!--')){const end=html.indexOf('-->',offset+4);if(end<0||end>8192)return null;offset=end+3;continue;}
      const wrapper=/^(?:<!doctype\s+html\s*>|<html(?:\s[^<>]*)?>|<body(?:\s[^<>]*)?>|<meta\s[^<>]*>)/i.exec(tail);
      if(wrapper){offset+=wrapper[0].length;continue;} break;
    }
    if(offset>=8192)return null;
    const match=/^<table\s+data-jiange-cell-grid\s*=\s*(["'])([A-Za-z0-9+/=]+)\1\s*>/i.exec(html.slice(offset));
    if(!match || /<table\s+data-jiange-cell-grid\s*=/i.test(html.slice(offset+match[0].length)))return null;
    const binary=atob(match[2]); if(binary.length>MAX_HTML)return null;
    const value: unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary, ch=>ch.charCodeAt(0))));
    if(!value || typeof value!=='object' || Array.isArray(value) || ![1,2].includes((value as {version:number}).version))return null;
    const cells=(value as {cells?:unknown}).cells;
    if(!Array.isArray(cells)||!cells.length||cells.length>200||!Array.isArray(cells[0])||!cells[0].length||cells[0].length>50||cells.length*cells[0].length>MAX_CELLS)return null;
    const width=cells[0].length; let size=0;
    for(const row of cells){
      if(!Array.isArray(row)||row.length!==width)return null;
      for(const cell of row){
        if(!isRichCell(cell))return null;
        size+=cell.text.length; if(size>MAX_TEXT)return null;
      }
    }
    const normalized=(cells as RichTableCell[][]).map(row=>row.map(cell=>({text:cell.text,fill:cell.fill.toUpperCase(),horizontal:cell.horizontal,vertical:cell.vertical})));
    let result: RichTableClipboard;
    if ((value as {version:number}).version === 2) {
      const raw=(value as {merges?:unknown}).merges;
      if (!Array.isArray(raw) || raw.length > MAX_CELLS) return null;
      const merges=parseMerges(JSON.stringify(raw),cells.length,width);
      if (merges.length !== raw.length) return null;
      if(!validHiddenCells(normalized,merges))return null;
      result={version:2,cells:normalized,merges};
    } else result={version:1,cells:normalized};
    const grid=plainGrid(result.cells), canonical=formatTableTSV(grid,{r0:0,c0:0,r1:grid.length-1,c1:width-1});
    return canonical===plain ? result : null;
  } catch { return null; }
}

const intersects = ([r,c,rs,cs]: Merge, [rr,cc,rrs,ccs]: Merge) => r < rr+rrs && rr < r+rs && c < cc+ccs && cc < c+cs;
const sameMerge = (a: Merge,b: Merge) => a.every((value,index)=>value===b[index]);

/** Preserve a v2 source's merges only when they do not conflict with destination merges. */
export function planRichTablePaste(rows: string[][], merges: Merge[], startRow: number, startCol: number, source: RichTableClipboard):
  | { ok: true; rows: string[][]; merges: Merge[]; changed: boolean }
  | { ok: false; message: string } {
  const invalid = {ok:false as const,message:'粘贴内容格式无效，表格未修改。'};
  if(!source || ![1,2].includes(source.version) || !Array.isArray(source.cells) || !source.cells.length || source.cells.length>200 || !Array.isArray(source.cells[0]) || !source.cells[0].length || source.cells[0].length>50 || source.cells.length*source.cells[0].length>MAX_CELLS || source.cells.some(row=>!Array.isArray(row)||row.length!==source.cells[0].length||row.some(cell=>!isRichCell(cell))))return invalid;
  if(source.version===2) {
    if(!Array.isArray(source.merges) || source.merges.length>MAX_CELLS)return invalid;
    let valid: Merge[];
    try { valid=parseMerges(JSON.stringify(source.merges),source.cells.length,source.cells[0].length); } catch { return invalid; }
    if(valid.length!==source.merges.length || !validHiddenCells(source.cells,valid))return invalid;
  }
  const grid=plainGrid(source.cells), result=planTablePasteGrid(rows,merges,startRow,startCol,grid);
  if(!result.ok)return result;
  if(source.version===1)return {...result,merges};
  const target: Merge=[startRow,startCol,grid.length,grid[0].length];
  const incoming: Merge[]=source.merges.map(([row,col,rs,cs])=>[startRow+row,startCol+col,rs,cs]);
  for(const existing of merges) if(intersects(existing,target) && !incoming.some(next=>sameMerge(existing,next))) return {ok:false,message:'粘贴区域与现有合并单元格不匹配，请先拆分或调整选区。'};
  const combined=merges.concat(incoming.filter(next=>!merges.some(existing=>sameMerge(existing,next))));
  return {ok:true,rows:result.rows,merges:combined,changed:result.changed || combined.length!==merges.length};
}
