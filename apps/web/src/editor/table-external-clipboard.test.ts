import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseExternalTableHTML } from './table-external-clipboard';
import { planRichTablePaste } from './table-rich-clipboard';

describe('inert external HTML table clipboard', () => {
  it('reads a synthetic workbook exported as HTML by LibreOffice Calc', () => {
    const html=readFileSync(new URL('./fixtures/libreoffice-table.html',import.meta.url),'utf8');
    const result=parseExternalTableHTML(html,'项目\t负责人\n进度\t完成');
    expect(result?.lostFormatting).toBe(true);
    expect(result?.clipboard.cells).toMatchObject([[{text:'项目',fill:'#D9EAF7',horizontal:'center',vertical:'middle'},{text:'负责人'}],[{text:'进度'},{text:'完成',fill:'#FFF2CC',horizontal:'right'}]]);
  });
  it('reads common inline styles, legacy attributes, spans and authoritative plain text', () => {
    const html=`<table><tr><td rowspan="2" style="background-color:#cde;text-align:center;vertical-align:bottom">项目</td><td bgcolor="#FFEECC" align="right">甲</td></tr><tr><td style="background:rgb(12, 34, 56)">乙<br>二</td></tr></table>`;
    const parsed=parseExternalTableHTML(html,'项目\t甲\r\n\t"乙\n二"\r\n')!.clipboard;
    expect(parsed.version).toBe(2);
    expect(parsed).toMatchObject({merges:[[0,0,2,1]],cells:[[{text:'项目',fill:'#CCDDEE',horizontal:'center',vertical:'bottom'},{text:'甲',fill:'#FFEECC',horizontal:'right'}],[{text:''},{text:'乙\n二',fill:'#0C2238'}]]});
    expect(planRichTablePaste([['x','y'],['z','w']],[],0,0,parsed)).toMatchObject({ok:true,merges:[[0,0,2,1]],rows:[['项目','甲'],['','乙\n二']]});
  });
  it('maps simple Office-like class rules and uses inline declarations as overrides', () => {
    const html=`<html><head><style>td.xl65 {background:#abc;text-align:center;vertical-align:middle}.xl66 {background:#123456}</style></head><body><table><tr><td class="xl65">甲</td><td class="xl66" style="background-color:#fedcba;text-align:right">乙</td></tr></table></body></html>`;
    expect(parseExternalTableHTML(html,'甲\t乙')?.clipboard).toMatchObject({version:1,cells:[[{text:'甲',fill:'#AABBCC',horizontal:'center',vertical:'middle'},{text:'乙',fill:'#FEDCBA',horizontal:'right'}]]});
  });
  it('requires the plain text to match and never treats Jiange metadata as external', () => {
    const html='<table><tr><td>A</td><td>B</td></tr></table>';
    expect(parseExternalTableHTML(html,'A\tchanged')).toBeNull();
    expect(parseExternalTableHTML('<table data-jiange-cell-grid="broken"><tr><td>A</td></tr></table>','A')).toBeNull();
    expect(parseExternalTableHTML(html+'<table><tr><td>C</td></tr></table>','A\tB')).toBeNull();
    expect(parseExternalTableHTML('<table><tr><td>A<img src="https://example.invalid/track"></td></tr></table>','A')).toBeNull();
  });
  it('does not interpret executable CSS or non-text markup', () => {
    const html='<table><tr><td style="background:url(https://example.invalid/x);text-align:right">A</td><td><script>throw 1</script>B</td></tr></table>';
    expect(parseExternalTableHTML(html,'A\tB')).toBeNull();
    const simple='<table><tr><td style="background:url(https://example.invalid/x);text-align:right">A</td><td>B</td></tr></table>';
    expect(parseExternalTableHTML(simple,'A\tB')).toBeNull();
    expect(parseExternalTableHTML('<table><tr><td style="background:red !important">A</td><td>B</td></tr></table>','A\tB')).toBeNull();
  });
  it('respects supported rule order, specificity and transparent background inheritance', () => {
    const html='<style>.a{background:#f00}.b{background:#00f}td.a{background:#0f0}@media print{.b{background:#000}}</style><table bgcolor="#ffeecc"><tr><td class="b a" bgcolor="#123456">A</td><td style="background:transparent">B</td></tr></table>';
    expect(parseExternalTableHTML(html,'A\tB')?.clipboard.cells[0]).toMatchObject([{fill:'#00FF00'},{fill:'#FFEECC'}]);
  });
  it('respects row-group formatting and rejects ambiguous group ordering or spanning', () => {
    const html='<table><tbody style="background:#abc;text-align:center"><tr><td>A</td><td>B</td></tr></tbody></table>';
    expect(parseExternalTableHTML(html,'A\tB')?.clipboard.cells[0]).toMatchObject([{fill:'#AABBCC',horizontal:'center'},{fill:'#AABBCC',horizontal:'center'}]);
    const badOrder='<table><tfoot><tr><td>A</td></tr></tfoot><tbody><tr><td>B</td></tr></tbody></table>';
    expect(parseExternalTableHTML(badOrder,'A\nB')).toBeNull();
    const badSpan='<table><tbody><tr><td rowspan="2">A</td></tr></tbody><tbody><tr><td>B</td></tr></tbody></table>';
    expect(parseExternalTableHTML(badSpan,'A\nB')).toBeNull();
  });
  it('preserves blank trailing rows and rejects malformed spans and large input', () => {
    const html='<table><tr><td>A</td><td>B</td></tr><tr><td></td><td></td></tr></table>';
    expect(parseExternalTableHTML(html,'A\tB\n\t')?.clipboard.cells.map(row=>row.map(cell=>cell.text))).toEqual([['A','B'],['','']]);
    expect(parseExternalTableHTML('<table><tr><td rowspan="3">A</td></tr></table>','A')).toBeNull();
    expect(parseExternalTableHTML('<table><tr><td colspan="5000000">A</td></tr></table>','A')).toBeNull();
    expect(parseExternalTableHTML(html,'A\tB')).toBeNull();
    expect(parseExternalTableHTML('x'.repeat(512*1024+1),'')).toBeNull();
  });
  it('reports unsupported text and border formatting rather than silently claiming fidelity', () => {
    const html='<table><tr><td style="font-weight:bold;border:1px solid black"><b>A</b></td><td>B</td></tr></table>';
    expect(parseExternalTableHTML(html,'A\tB')).toMatchObject({lostFormatting:true,clipboard:{cells:[[{text:'A'},{text:'B'}]]}});
    expect(parseExternalTableHTML('<table><tr><td>A</td><td>B</td></tr></table>','A\tB')?.lostFormatting).toBe(false);
    expect(parseExternalTableHTML('<style>td{background:#f00}</style><table><tr><td>A</td><td>B</td></tr></table>','A\tB')?.lostFormatting).toBe(true);
    expect(parseExternalTableHTML('<table><tr><td style="background-image:url(https://example.invalid/x)">A</td><td>B</td></tr></table>','A\tB')?.lostFormatting).toBe(true);
  });
});
