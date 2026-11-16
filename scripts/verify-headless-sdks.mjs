import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const names = ['collab', 'ooxml', 'whiteboard-sdk', 'doc-sdk', 'slides-sdk', 'sheet-sdk'];
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
  }
  writeFileSync(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { Doc, ROOT, Tx, SyncClient } from '@jiange/collab';
import { splitBlock, bodyBlocks, buildDocx, parseDocx, columnWeights, captureColumnMove, applyColumnMove } from '@jiange/doc-sdk';
import { columnWeights as columnWidthsSubpath } from '@jiange/doc-sdk/column-widths';
import { validColumnPosition } from '@jiange/doc-sdk/column-move';
import { columnWeights as legacyColumnWidths } from '@jiange/doc-sdk/columnWidths';
import { moveShapeOrder, slideLineEndpoints } from '@jiange/slides-sdk';
import { calculateSheet, translateSheetFormula, writeXlsx, readXlsx } from '@jiange/sheet-sdk';
import { readXlsx as oldReadXlsx } from '@jiange/sheet-sdk/xlsxRead';
import { readXlsx as newReadXlsx } from '@jiange/sheet-sdk/xlsx-read';
import { listZip } from '@jiange/ooxml/zip';
import { flowWrites, readFlow } from '@jiange/whiteboard-sdk';
import { scaleInk as oldScaleInk } from '@jiange/whiteboard-sdk/inkGeometry';
import { scaleInk as newScaleInk } from '@jiange/whiteboard-sdk/ink-geometry';
assert.equal(typeof globalThis.document, 'undefined');
const doc = new Doc(1), tx = new Tx(doc), block = tx.create('paragraph', null, ROOT);
tx.insert(block, 0, 'Hello'); const next = splitBlock(tx, {b:block,o:2});
assert.equal(bodyBlocks(doc).length, 2); assert.equal(doc.text(next.b), 'llo');
assert.equal(new SyncClient(1).unacked, 0);
const word = buildDocx({blocks:[{type:'paragraph',props:{},spans:[{text:'Hello SDK',marks:{}}]}]}, {title:'Test'});
assert.equal((await parseDocx(word)).blocks[0].text, 'Hello SDK');
assert.deepEqual(columnWeights('{"1:2":1400,"1:3":600}', ['1:2','1:3']), [1400,600]);
assert.deepEqual(columnWidthsSubpath(undefined, ['1:2','1:3']), [1000,1000]);
assert.deepEqual(legacyColumnWidths(undefined, ['1:2','1:3']), [1000,1000]);
const group = tx.create('columns', next.b, ROOT), a = tx.create('paragraph', null, group), b = tx.create('paragraph', a, group);
assert.equal(applyColumnMove(tx, captureColumnMove(doc, group, a), b), 'applied');
assert.deepEqual(doc.children(group), [b, a]); assert.equal(doc.blockLocation(a).parent.clock, group.clock); assert.equal(validColumnPosition('A0'), false);
const line = {id:'l',kind:'line',x:10,y:10,width:20,height:5,color:'#000000'};
assert.equal(moveShapeOrder([line], 'l', 'front').length, 1); assert.ok(slideLineEndpoints(line,960,540).end.x > 0);
assert.equal(translateSheetFormula('=A1+$A$1',1,0), '=A2+$A$1');
assert.equal(calculateSheet({'0:0':'2','0:1':'=A1*3'})['0:1'], 6);
const xlsx = writeXlsx({sheets:[{name:'Sheet1',cells:[{row:0,col:0,value:'Hello'}]}]});
assert.ok(listZip(xlsx).some(entry => entry.name === 'xl/workbook.xml'));
assert.equal((await readXlsx(xlsx)).workbook.sheets[0].cells[0].value, 'Hello');
assert.equal(oldReadXlsx, newReadXlsx); assert.equal(oldScaleInk, newScaleInk);
const graph = {theme:'feishu',nodes:[{id:'n',x:0,y:0,w:140,h:60,shape:'rect',text:'Start'}],edges:[]};
assert.equal(readFlow(flowWrites({},graph)).nodes[0].text,'Start');
`);
  writeFileSync(join(consumer, 'types.ts'), `
import { Doc, Tx, ROOT, SyncClient } from '@jiange/collab';
import { splitBlock, columnWeights, captureColumnMove, type ColumnWidthSnapshot, type ColumnMoveSnapshot } from '@jiange/doc-sdk';
import { COLUMN_WIDTHS } from '@jiange/doc-sdk/column-widths';
import { applyColumnMove } from '@jiange/doc-sdk/column-move';
import { moveShapeOrder, type SlideShape } from '@jiange/slides-sdk';
import { calculateSheet, writeXlsx, readXlsx, type XlsxWorkbook } from '@jiange/sheet-sdk';
import { readFlow, type FlowGraph } from '@jiange/whiteboard-sdk';
const doc = new Doc(1), tx = new Tx(doc), block = tx.create('paragraph', null, ROOT);
splitBlock(tx, { b: block, o: 0 }); new SyncClient(1);
const weights: number[] = columnWeights(undefined, ['1:2']); const widthKey: string = COLUMN_WIDTHS; let snapshot: ColumnWidthSnapshot | null = null; void [weights, widthKey, snapshot];
let move: ColumnMoveSnapshot | null = captureColumnMove(doc, block, block); if (move) applyColumnMove(tx, move, null);
const shapes: SlideShape[] = []; moveShapeOrder(shapes, 'id', 'front');
calculateSheet({}); const workbook: XlsxWorkbook = { sheets: [{ name: 'Sheet1', cells: [{row:0,col:0,value:1}] }] }; readXlsx(writeXlsx(workbook));
const graph: FlowGraph = readFlow({}); void graph;
`);
  execFileSync(process.execPath, [join(consumer, 'smoke.mjs')], { cwd: consumer, stdio: 'inherit' });
  const require = createRequire(join(root, 'packages/collab/package.json'));
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022', join(consumer, 'types.ts')], { cwd: consumer, stdio: 'inherit' });
  console.log('Five packed headless SDKs and their shared OOXML library passed Node ESM and NodeNext type checks.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
