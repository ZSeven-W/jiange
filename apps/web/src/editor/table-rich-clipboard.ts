import { tableCellAlign, tableCellFill, type TableHorizontalAlign, type TableVerticalAlign } from './table-cells';
import { formatTableTSV } from './table-clipboard';
import { coverMap, expandRange, normRange, type CellRange, type Merge } from './table-ops';

export interface RichTableCell { text: string; fill: string; horizontal: TableHorizontalAlign; vertical: TableVerticalAlign }
export interface RichTableClipboard { version: 1; cells: RichTableCell[][] }
const MAX_HTML = 2 * 1024 * 1024, MAX_CELLS = 1000, MAX_TEXT = 256 * 1024;
const escapeHTML = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const encode = (value: string) => {
  let binary = ''; const bytes = new TextEncoder().encode(value);
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
const plainGrid = (cells: RichTableCell[][]) => cells.map(row => row.map(cell => cell.text));

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
  const payload = encode(JSON.stringify({version:1,cells} satisfies RichTableClipboard));
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
    if(!value || typeof value!=='object' || Array.isArray(value) || (value as {version?:unknown}).version!==1)return null;
    const cells=(value as {cells?:unknown}).cells;
    if(!Array.isArray(cells)||!cells.length||cells.length>200||!Array.isArray(cells[0])||!cells[0].length||cells[0].length>50||cells.length*cells[0].length>MAX_CELLS)return null;
    const width=cells[0].length; let size=0;
    for(const row of cells){
      if(!Array.isArray(row)||row.length!==width)return null;
      for(const cell of row){
        if(!cell||typeof cell!=='object'||Array.isArray(cell)||typeof cell.text!=='string'||typeof cell.fill!=='string'||(cell.fill!==''&&!/^#[0-9a-f]{6}$/i.test(cell.fill))||!['left','center','right'].includes(cell.horizontal)||!['top','middle','bottom'].includes(cell.vertical))return null;
        size+=cell.text.length; if(size>MAX_TEXT)return null;
      }
    }
    const result: RichTableClipboard={version:1,cells:(cells as RichTableCell[][]).map(row=>row.map(cell=>({text:cell.text,fill:cell.fill.toUpperCase(),horizontal:cell.horizontal,vertical:cell.vertical})))};
    const grid=plainGrid(result.cells), canonical=formatTableTSV(grid,{r0:0,c0:0,r1:grid.length-1,c1:width-1});
    return canonical===plain ? result : null;
  } catch { return null; }
}
