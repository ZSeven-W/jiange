import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildDocx, docxExportLosses, parseDocx, type DocxExportBlock } from '../packages/doc-sdk/src/docx';

// Requires python-docx and LibreOffice. Output can be retained for visual QA.
const python = process.env.JIANGE_PYTHON || 'python3';
const soffice = process.env.JIANGE_SOFFICE || 'soffice';
const output = process.env.JIANGE_DOCX_OUTPUT || mkdtempSync(path.join(tmpdir(), 'jiange-docx-table-'));
const clean = !process.env.JIANGE_DOCX_OUTPUT;
const original = path.join(output, 'original'), roundtrip = path.join(output, 'roundtrip');
mkdirSync(original, { recursive: true }); mkdirSync(roundtrip, { recursive: true });
const b = (type: string, text = '', props: Record<string, string> = {}): DocxExportBlock => ({ type, props, spans: text ? [{ text, marks: {} }] : [] });
const rows = [['项目进度', '', '负责人'], ['', '', '小简'], ['设计', '已完成', '设计团队'], ['研发', '进行中', '开发团队']];
const view = { blocks: [b('title', '项目协作表格'), b('paragraph', '表格包含横向与纵向合并，标题列以浅灰色标识。'), b('table', '', { tableData: JSON.stringify(rows), tableMerges: '[[0,0,2,2]]', tableHeader: 'none', tableHeaderColumn: 'column', tableWidths: '[180,120,240]' }), b('paragraph', '下方表格开启标题行并包含横向合并。'), b('table', '', { tableData: JSON.stringify([['阶段', '状态', ''], ['设计', '已完成', '小简'], ['研发', '进行中', '团队']]), tableMerges: '[[0,1,1,2]]', tableHeader: 'row', tableWidths: '[140,180,160]' })] };
async function main() {
try {
  assert.deepEqual(docxExportLosses(view), []);
  const source = path.join(original, 'jiange-table.docx');
  writeFileSync(source, buildDocx(view, { title: '项目协作表格' }));
  execFileSync(python, ['-c', `from docx import Document\nfrom docx.oxml import OxmlElement\nfrom docx.oxml.ns import qn\nfrom docx.shared import Twips\nimport sys\nd=Document(sys.argv[1]); a,b=d.tables\nassert a.cell(0,0).text=='项目进度' and a.cell(1,1).text=='项目进度'\nassert b.cell(0,1).text=='状态' and b.cell(0,2).text=='状态'\nassert [c.width.twips for c in a.columns]==[2700,1800,3600]\nassert [c.width.twips for c in b.columns]==[2100,2700,2400]\nassert a.rows[0]._tr.trPr is None or a.rows[0]._tr.trPr.find(qn('w:tblHeader')) is None\nassert b.rows[0]._tr.trPr.find(qn('w:tblHeader')) is not None\nx=Document(); t=x.add_table(rows=3, cols=3)\nt.cell(0,0).text='第三方表头'; t.cell(0,0).merge(t.cell(0,1)); t.cell(0,2).text='状态'\nt.cell(1,0).text='跨行'; t.cell(1,0).merge(t.cell(2,0)); t.cell(1,1).text='开发'; t.cell(2,1).text='测试'\np=t.rows[0]._tr.get_or_add_trPr(); p.append(OxmlElement('w:tblHeader'))\nf=x.add_table(rows=2, cols=2); f.autofit=False\nf.columns[0].width=Twips(2700); f.columns[1].width=Twips(1800)\nfor row in f.rows:\n    row.cells[0].width=Twips(2700); row.cells[1].width=Twips(1800)\nf.cell(0,0).text='第三方固定宽度'; x.save(sys.argv[2])`, source, path.join(original, 'python-docx.docx')], { stdio: 'inherit' });
  const third = await parseDocx(readFileSync(path.join(original, 'python-docx.docx')));
  const external = third.blocks.find((block) => block.type === 'table')!;
  assert.deepEqual(JSON.parse(external.props.tableMerges).sort(), [[0, 0, 1, 2], [1, 0, 2, 1]].sort());
  assert.equal(external.props.tableHeader, undefined);
  assert.equal(JSON.parse(external.props.tableData)[2][1], '测试');
  assert.equal(third.warnings.some((warning) => warning.includes('合并单元格')), false);
  assert.equal(third.blocks.filter((block) => block.type === 'table')[1].props.tableWidths, '[180,120]');
  assert.ok(third.warnings.includes('Word 表格使用自动布局，列宽可能不同'));
  execFileSync(soffice, [`-env:UserInstallation=file://${path.join(output, 'lo-profile')}`, '--headless', '--convert-to', 'docx:Office Open XML Text', '--outdir', roundtrip, source], { stdio: 'inherit' });
  const reopened = await parseDocx(readFileSync(path.join(roundtrip, 'jiange-table.docx')));
  const tables = reopened.blocks.filter((block) => block.type === 'table');
  assert.equal(tables.length, 2);
  assert.deepEqual(JSON.parse(tables[0].props.tableData), rows);
  assert.deepEqual(JSON.parse(tables[0].props.tableMerges), [[0, 0, 2, 2]]);
  assert.equal(tables[0].props.tableHeader, 'none');
  assert.equal(tables[0].props.tableHeaderColumn, 'column');
  assert.deepEqual(JSON.parse(tables[0].props.tableWidths), [180, 120, 240]);
  assert.deepEqual(JSON.parse(tables[1].props.tableMerges), [[0, 1, 1, 2]]);
  assert.equal(tables[1].props.tableHeader, undefined);
  assert.deepEqual(JSON.parse(tables[1].props.tableWidths), [140, 180, 160]);
  if (process.env.JIANGE_DOCX_EXPORTED) {
    execFileSync(python, ['-c', `from docx import Document\nimport sys\na,b=Document(sys.argv[1]).tables\nassert a.cell(0,0).text=='项目进度' and a.cell(1,1).text=='项目进度'\nassert b.cell(0,1).text=='状态' and b.cell(0,2).text=='状态'`, process.env.JIANGE_DOCX_EXPORTED], { stdio: 'inherit' });
    const downloaded = await parseDocx(readFileSync(process.env.JIANGE_DOCX_EXPORTED));
    const actual = downloaded.blocks.filter((block) => block.type === 'table');
    assert.equal(actual.length, 2);
    assert.deepEqual(JSON.parse(actual[0].props.tableData), rows);
    assert.deepEqual(JSON.parse(actual[0].props.tableMerges), [[0, 0, 2, 2]]);
    assert.equal(actual[0].props.tableHeader, 'none');
    assert.equal(actual[0].props.tableHeaderColumn, 'column');
    assert.deepEqual(JSON.parse(actual[0].props.tableWidths), [180, 120, 240]);
    assert.deepEqual(JSON.parse(actual[1].props.tableMerges), [[0, 1, 1, 2]]);
    assert.equal(actual[1].props.tableHeader, undefined);
    const secondWidths = process.env.JIANGE_DOCX_EXPORTED_SECOND_WIDTHS ? JSON.parse(process.env.JIANGE_DOCX_EXPORTED_SECOND_WIDTHS) : [140, 180, 160];
    assert.deepEqual(JSON.parse(actual[1].props.tableWidths), secondWidths);
    console.log('Jiange UI download parsed with expected content and structure');
  }
  console.log('python-docx read/write and LibreOffice round-trip passed');
} finally { if (clean) rmSync(output, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
