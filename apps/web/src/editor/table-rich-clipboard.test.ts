import { describe, expect, it } from 'vitest';
import { cellAlignKey, cellFillKey, cellTableWrites } from './table-cells';
import { formatTableTSV, planTablePasteGrid } from './table-clipboard';
import { parseTableRichHTML, tableRichHTML } from './table-rich-clipboard';

const range = { r0: 0, c0: 0, r1: 1, c1: 1 };
function fixture() {
  const rows = [['计划😀', '负责人'], ['多\n行', '']];
  const props: Record<string,string> = { tableData: JSON.stringify(rows) };
  Object.assign(props, cellTableWrites(props, rows, 1));
  props[cellFillKey('r0','c1')] = '#E3ECFF';
  props[cellAlignKey('r0','c1','horizontal')] = 'right';
  props[cellAlignKey('r0','c1','vertical')] = 'bottom';
  return { rows, props, plain: formatTableTSV(rows, range) };
}
describe('formatted table selection clipboard', () => {
  it('preserves the exact text and supported formatting with safe external HTML', () => {
    const {rows,props,plain}=fixture(), html=tableRichHTML(rows,props,range,[])!;
    const value=parseTableRichHTML(html,plain)!;
    expect(value.cells.map(row=>row.map(cell=>cell.text))).toEqual(rows);
    expect(value.cells[0][1]).toMatchObject({fill:'#E3ECFF',horizontal:'right',vertical:'bottom'});
    expect(html).toContain('style="background-color:#E3ECFF;text-align:right;vertical-align:bottom"');
    expect(parseTableRichHTML(`<html><body><!--StartFragment-->${html}<!--EndFragment--></body></html>`,plain)).toEqual(value);
    expect(parseTableRichHTML(html,plain+'x')).toBeNull();
    expect(parseTableRichHTML(`<script>${html}</script>`,plain)).toBeNull();
    expect(parseTableRichHTML(html+html,plain)).toBeNull();
  });
  it('does not expose hidden merged content or its formatting', () => {
    const rows=[['visible','secret'],['other','<script>']];
    const props:Record<string,string>={tableData:JSON.stringify(rows)};Object.assign(props,cellTableWrites(props,rows,1));
    props[cellFillKey('r0','c1')]='#FBE4E2';
    const merges: [number,number,number,number][]= [[0,0,1,2]], plain=formatTableTSV(rows,range,merges);
    const html=tableRichHTML(rows,props,range,merges)!;
    const parsed=parseTableRichHTML(html,plain)!;
    expect(parsed.cells[0][1]).toEqual({text:'',fill:'',horizontal:'left',vertical:'top'});
    expect(html).not.toContain('secret');expect(html).toContain('&lt;script&gt;');
    expect(tableRichHTML(rows,props,{r0:0,c0:0,r1:0,c1:0},merges)).toBeNull();
  });
  it('preserves an all-empty last row while bounding malformed or oversized grids', () => {
    const rows=[['a','b'],['','']], props={tableData:JSON.stringify(rows)}, plain=formatTableTSV(rows,range);
    const copied=parseTableRichHTML(tableRichHTML(rows,props,range,[])!,plain)!;
    expect(planTablePasteGrid([['x','y'],['z','w']],[],0,0,copied.cells.map(row=>row.map(cell=>cell.text)))).toEqual({ok:true,changed:true,rows});
    expect(planTablePasteGrid([['x']],[],0,0,Array.from({length:201},()=>['x']))).toMatchObject({ok:false});
    expect(tableRichHTML(rows,props,{r0:0,c0:0,r1:1,c1:2},[])).toBeNull();
    expect(parseTableRichHTML('<table data-jiange-cell-grid="%%%%">','x')).toBeNull();
  });
  it('rejects forged metadata and CSS-like payloads without trusting the HTML body', () => {
    const wrap=(value:unknown)=>`<table data-jiange-cell-grid="${btoa(JSON.stringify(value))}"><tr><td>not used</td></tr></table>`;
    const valid={version:1,cells:[[{text:'x',fill:'',horizontal:'left',vertical:'top'}]]};
    expect(parseTableRichHTML(wrap(valid),'x')?.cells[0][0].text).toBe('x');
    expect(parseTableRichHTML(wrap({...valid,version:2}),'x')).toBeNull();
    expect(parseTableRichHTML(wrap({version:1,cells:[[{text:'x',fill:'url(evil)',horizontal:'left',vertical:'top'}]]}),'x')).toBeNull();
    expect(parseTableRichHTML(wrap({version:1,cells:[[{text:'x',fill:'',horizontal:'right;display:none',vertical:'top'}]]}),'x')).toBeNull();
    expect(parseTableRichHTML(wrap({version:1,cells:[[{text:'x',fill:'',horizontal:'left',vertical:'top'}],[]]}),'x')).toBeNull();
  });
});
