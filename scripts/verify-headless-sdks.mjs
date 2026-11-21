import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const names = [
  'collab',
  'ooxml',
  'whiteboard-sdk',
  'doc-sdk',
  'slides-sdk',
  'sheet-sdk',
  'base-sdk',
  'render-gpu',
  'sheet-ui',
  'doc-ui',
  'slides-ui',
  'whiteboard-ui',
  'base-ui',
];
const rootLicense = readFileSync(join(root, 'LICENSE'), 'utf8');
const temp = mkdtempSync(join(tmpdir(), 'jiange-sdk-check-'));
const consumer = join(temp, 'consumer');
try {
  mkdirSync(join(consumer, 'node_modules', '@jiange'), { recursive: true });
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  for (const name of names) {
    execFileSync('pnpm', ['--filter', `@jiange/${name}`, 'build'], { cwd: root, stdio: 'pipe' });
    const archive = join(temp, `${name}.tgz`);
    execFileSync('pnpm', ['--filter', `@jiange/${name}`, 'pack', '--out', archive], { cwd: root, stdio: 'pipe' });
    const destination = join(consumer, 'node_modules', '@jiange', name);
    mkdirSync(destination, { recursive: true });
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', destination]);
    if (!existsSync(join(destination, 'dist', 'index.js')) || !existsSync(join(destination, 'dist', 'index.d.ts')) || existsSync(join(destination, 'src'))) throw new Error(`${name}: invalid package contents`);
    if (readdirSync(join(destination, 'dist')).some(file => /[A-Z_]/.test(file))) throw new Error(`${name}: stale or non-kebab build output`);
    if (!existsSync(join(destination, 'LICENSE')) || readFileSync(join(destination, 'LICENSE'), 'utf8') !== rootLicense) throw new Error(`${name}: missing or mismatched LICENSE in packed archive`);
    if (JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8')).license !== 'SEE LICENSE IN LICENSE') throw new Error(`${name}: unexpected license metadata in packed package.json`);
    if (readFileSync(join(destination, 'README.md'), 'utf8').includes('../../LICENSE')) throw new Error(`${name}: README contains parent-escaping LICENSE path`);
  }
  writeFileSync(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { Doc, ROOT, Tx, SyncClient, UndoManager } from '@jiange/collab';
import { splitBlock, bodyBlocks, buildDocx, parseDocx, columnWeights, captureColumnMove, applyColumnMove } from '@jiange/doc-sdk';
import { columnWeights as columnWidthsSubpath } from '@jiange/doc-sdk/column-widths';
import { validColumnPosition } from '@jiange/doc-sdk/column-move';
import { captureColumnArchiveTarget, prepareColumnArchive, recoverColumnArchive, toggleArchivedColumn } from '@jiange/doc-sdk/column-archive-experimental';
import { columnWeights as legacyColumnWidths } from '@jiange/doc-sdk/columnWidths';
import { moveShapeOrder, slideLineEndpoints } from '@jiange/slides-sdk';
import { exportSlidesToPptx, parsePptxToSlides } from '@jiange/slides-sdk/pptx';
import { calculateSheet, translateSheetFormula, writeXlsx, writeXlsxAsync, readXlsx, Workbook, createSheetTools, SUPPORTED_FORMULA_FUNCTIONS } from '@jiange/sheet-sdk';
import { readXlsx as oldReadXlsx } from '@jiange/sheet-sdk/xlsxRead';
import { readXlsx as newReadXlsx } from '@jiange/sheet-sdk/xlsx-read';
import { listZip, createZipAsync } from '@jiange/ooxml/zip';
import { flowWrites, readFlow } from '@jiange/whiteboard-sdk';
import { scaleInk as oldScaleInk } from '@jiange/whiteboard-sdk/inkGeometry';
import { scaleInk as newScaleInk, scaleSelectionProportionally } from '@jiange/whiteboard-sdk/ink-geometry';
import { exportMindMapToXmind, parseXmindToMindMap } from '@jiange/whiteboard-sdk/xmind';
import { encodeFlowCommentAnchor, parseFlowCommentAnchor } from '@jiange/whiteboard-sdk/comment-anchor';
assert.equal(typeof globalThis.document, 'undefined');
const doc = new Doc(1), tx = new Tx(doc), block = tx.create('paragraph', null, ROOT);
tx.insert(block, 0, 'Hello'); const next = splitBlock(tx, {b:block,o:2});
assert.equal(bodyBlocks(doc).length, 2); assert.equal(doc.text(next.b), 'llo');
assert.equal(new SyncClient(1).unacked, 0);
const history = new UndoManager(), point = history.markInsertionPoint();
assert.equal(history.insertMarkerAt(point, 'async'), true); assert.equal(history.peekMarker(false), 'async');
const word = buildDocx({blocks:[{type:'paragraph',props:{},spans:[{text:'Hello SDK',marks:{}}]}]}, {title:'Test'});
assert.equal((await parseDocx(word)).blocks[0].text, 'Hello SDK');
assert.deepEqual(columnWeights('{"1:2":1400,"1:3":600}', ['1:2','1:3']), [1400,600]);
assert.deepEqual(columnWidthsSubpath(undefined, ['1:2','1:3']), [1000,1000]);
assert.deepEqual(legacyColumnWidths(undefined, ['1:2','1:3']), [1000,1000]);
const group = tx.create('columns', next.b, ROOT), a = tx.create('paragraph', null, group), b = tx.create('paragraph', a, group);
assert.equal(applyColumnMove(tx, captureColumnMove(doc, group, a), b), 'applied');
assert.deepEqual(doc.children(group), [b, a]); assert.equal(doc.blockLocation(a).parent.clock, group.clock); assert.equal(validColumnPosition('A0'), false);
assert.ok(captureColumnArchiveTarget(doc, group, a));
const archived = prepareColumnArchive(doc, 7, group, a); assert.ok(archived); assert.equal(doc.children(group).length, 2);
for (const op of archived.ops) doc.apply(op);
const handle = recoverColumnArchive(doc, archived.recovery); assert.ok(handle); assert.equal(doc.children(group).length, 1);
assert.ok(toggleArchivedColumn(new Tx(doc), handle)); assert.deepEqual(doc.children(group), [b, a]);
const wholeGroup = prepareColumnArchive(doc, 8, ROOT, group); assert.ok(wholeGroup);
for (const op of wholeGroup.ops) doc.apply(op);
assert.equal(doc.children(ROOT).some(item => item.client === group.client && item.clock === group.clock), false);
const groupHandle = recoverColumnArchive(doc, wholeGroup.recovery); assert.ok(groupHandle);
assert.ok(toggleArchivedColumn(new Tx(doc), groupHandle)); assert.deepEqual(doc.children(group), [b, a]);
const line = {id:'l',kind:'line',x:10,y:10,width:20,height:5,color:'#000000'};
assert.equal(moveShapeOrder([line], 'l', 'front').length, 1); assert.ok(slideLineEndpoints(line,960,540).end.x > 0);
const pptx = exportSlidesToPptx([{title:'Hello PPTX',body:'Body',background:'#ffffff',layout:'title',notes:'Note',shapes:[line],hidden:false}]);
assert.equal((await parsePptxToSlides(pptx)).pages[0].title, 'Hello PPTX');
assert.equal(translateSheetFormula('=A1+$A$1',1,0), '=A2+$A$1');
assert.equal(calculateSheet({'0:0':'2','0:1':'=A1*3'})['0:1'], 6);
const xlsx = writeXlsx({sheets:[{name:'Sheet1',cells:[{row:0,col:0,value:'Hello'}]}]});
assert.ok(listZip(xlsx).some(entry => entry.name === 'xl/workbook.xml'));
assert.equal((await readXlsx(xlsx)).workbook.sheets[0].cells[0].value, 'Hello');
const deflateXlsx = await writeXlsxAsync({sheets:[{name:'Sheet1',cells:[{row:0,col:0,value:'Compressed'.repeat(20)}]}]});
assert.equal((await readXlsx(deflateXlsx)).workbook.sheets[0].cells[0].value, 'Compressed'.repeat(20));
assert.ok(SUPPORTED_FORMULA_FUNCTIONS.length >= 125);
const wb = Workbook.fromCsv('Item,Qty,Price\\nA,2,10\\nB,3,20\\n', 'Sales');
const tools = createSheetTools(wb);
const applied = tools.execute('sheet_apply', { ops: [{ op: 'setCells', sheet: 'Sales', cells: [{ a1: 'D2', raw: '=B2*C2' }, { a1: 'D3', raw: '=B3*C3' }, { a1: 'D4', raw: '=SUM(D2:D3)' }] }] });
assert.equal(applied.ok, true);
assert.equal(wb.sheet('Sales').getValue('D4'), 80);
assert.equal(wb.verify().length, 0);
assert.ok((await createZipAsync([{ name: 'a.txt', data: new TextEncoder().encode('hello'.repeat(50)) }])).length < 250);
assert.equal(oldReadXlsx, newReadXlsx); assert.equal(oldScaleInk, newScaleInk);
const graph = {theme:'feishu',nodes:[{id:'n',x:0,y:0,w:140,h:60,shape:'rect',text:'Start'}],edges:[]};
assert.equal(readFlow(flowWrites({},graph)).nodes[0].text,'Start');
assert.equal(scaleSelectionProportionally(graph.nodes, [], {x:0,y:0}, 2).nodes[0].w, 280);
const xmind = exportMindMapToXmind({mind:[{id:'r',parent:null,order:1000,text:'Root',x:0,y:0},{id:'c',parent:'r',order:1000,text:'Child'}]});
assert.equal((await parseXmindToMindMap(xmind)).topicCount, 2);
const encAnchor = encodeFlowCommentAnchor({kind:'node',targetId:'n',x:140,y:0});
assert.equal(parseFlowCommentAnchor(encAnchor.startChar, encAnchor.endChar)?.targetId, 'n');
`);
  writeFileSync(join(consumer, 'types.ts'), `
import { Doc, Tx, ROOT, SyncClient, UndoManager } from '@jiange/collab';
import { splitBlock, columnWeights, captureColumnMove, type ColumnWidthSnapshot, type ColumnMoveSnapshot } from '@jiange/doc-sdk';
import { COLUMN_WIDTHS } from '@jiange/doc-sdk/column-widths';
import { applyColumnMove } from '@jiange/doc-sdk/column-move';
import { prepareColumnArchive, type PreparedColumnArchive } from '@jiange/doc-sdk/column-archive-experimental';
import { moveShapeOrder, type SlideShape } from '@jiange/slides-sdk';
import { exportSlidesToPptx, parsePptxToSlides, type ImportedSlidePage } from '@jiange/slides-sdk/pptx';
import { calculateSheet, writeXlsx, readXlsx, type XlsxWorkbook } from '@jiange/sheet-sdk';
import { readFlow, type FlowGraph } from '@jiange/whiteboard-sdk';
import { exportMindMapToXmind, parseXmindToMindMap, type XmindImportResult } from '@jiange/whiteboard-sdk/xmind';
import { encodeFlowCommentAnchor, type FlowCommentAnchor } from '@jiange/whiteboard-sdk/comment-anchor';
const doc = new Doc(1), tx = new Tx(doc), block = tx.create('paragraph', null, ROOT);
splitBlock(tx, { b: block, o: 0 }); new SyncClient(1);
const history = new UndoManager(), point: object = history.markInsertionPoint(); history.insertMarkerAt(point, 'async');
const weights: number[] = columnWeights(undefined, ['1:2']); const widthKey: string = COLUMN_WIDTHS; let snapshot: ColumnWidthSnapshot | null = null; void [weights, widthKey, snapshot];
let move: ColumnMoveSnapshot | null = captureColumnMove(doc, block, block); if (move) applyColumnMove(tx, move, null);
const archivePlan: PreparedColumnArchive | null = prepareColumnArchive(doc, 7, block, block); void archivePlan;
const shapes: SlideShape[] = []; moveShapeOrder(shapes, 'id', 'front');
const pptxBytes: Uint8Array = exportSlidesToPptx([]); const parsedPptx: Promise<{ pages: ImportedSlidePage[] }> = parsePptxToSlides(pptxBytes); void parsedPptx;
calculateSheet({}); const workbook: XlsxWorkbook = { sheets: [{ name: 'Sheet1', cells: [{row:0,col:0,value:1}] }] }; readXlsx(writeXlsx(workbook));
const graph: FlowGraph = readFlow({}); void graph;
const xm: Uint8Array = exportMindMapToXmind({ mind: [{ id: 'r', parent: null, order: 1, text: 'R', x: 0, y: 0 }] });
const xmRes: Promise<XmindImportResult> = parseXmindToMindMap(xm);
const fcAnchor: FlowCommentAnchor = { kind: 'point', x: 1, y: 2 };
encodeFlowCommentAnchor(fcAnchor); void xmRes;
`);
  execFileSync(process.execPath, [join(consumer, 'smoke.mjs')], { cwd: consumer, stdio: 'inherit' });
  const require = createRequire(join(root, 'packages/collab/package.json'));
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022', join(consumer, 'types.ts')], { cwd: consumer, stdio: 'inherit' });

  // Verify strict single-package isolated installation:
  // 1) @jiange/sheet-sdk needs ONLY @jiange/ooxml
  // 2) @jiange/doc-sdk needs ONLY @jiange/collab + @jiange/ooxml (NO @jiange/whiteboard-sdk)
  const verifyIsolated = (label, pkgs, script) => {
    const iso = join(temp, `iso-${label}`);
    mkdirSync(join(iso, 'node_modules', '@jiange'), { recursive: true });
    writeFileSync(join(iso, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    for (const pkg of pkgs) {
      const dst = join(iso, 'node_modules', '@jiange', pkg);
      mkdirSync(dst, { recursive: true });
      execFileSync('tar', ['-xzf', join(temp, `${pkg}.tgz`), '--strip-components=1', '-C', dst]);
    }
    writeFileSync(join(iso, 'check.mjs'), script);
    execFileSync(process.execPath, [join(iso, 'check.mjs')], { cwd: iso, stdio: 'inherit' });
  };
  verifyIsolated('sheet-only', ['ooxml', 'sheet-sdk'], `
import assert from 'node:assert/strict';
import { Workbook, createSheetTools } from '@jiange/sheet-sdk';
const wb = Workbook.create({ sheets: [{ name: 'S1' }] });
wb.sheet('S1').setCell('A1', 10).setCell('A2', '=A1*5');
assert.equal(wb.sheet('S1').getValue('A2'), 50);
assert.equal(createSheetTools(wb).tools.length, 6);
`);
  verifyIsolated('doc-without-whiteboard', ['ooxml', 'collab', 'doc-sdk'], `
import assert from 'node:assert/strict';
import { toMarkdown } from '@jiange/doc-sdk/markdown';
const md = toMarkdown([{ type: 'flowchart', text: '', props: { 'fc.n.a': '{"shape":"rect","text":"Start"}' }, spans: [] }]);
assert.ok(md.includes('flowchart TD'));
`);
  verifyIsolated('base-only', ['base-sdk'], `
import assert from 'node:assert/strict';
import { Base, createBaseTools } from '@jiange/base-sdk';
const b = Base.create({ name: 'CRM' });
b.addRecord(undefined, { Name: 'Acme' });
assert.equal(b.getRecords().length, 1);
assert.equal(createBaseTools(b).tools.length, 8);
`);
  verifyIsolated('render-gpu-only', ['render-gpu'], `
import assert from 'node:assert/strict';
import { FenwickVirtualizer, GpuSurface } from '@jiange/render-gpu';
assert.equal(new FenwickVirtualizer(100000, 28).totalSize, 2800000);
assert.equal((await GpuSurface.create(null)).backendKind, 'headless');
`);
  console.log('All 13 packed SDK & WebGPU/WebGL2 UI packages passed Node ESM, NodeNext type checks, and isolated single-package installs.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
