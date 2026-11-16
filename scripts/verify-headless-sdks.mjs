import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const names = ['collab', 'whiteboard-sdk', 'doc-sdk', 'slides-sdk', 'sheet-sdk'];
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
  }
  writeFileSync(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { Doc, ROOT, Tx, SyncClient } from '@jiange/collab';
import { splitBlock, bodyBlocks, buildDocx, parseDocx } from '@jiange/doc-sdk';
import { moveShapeOrder, slideLineEndpoints } from '@jiange/slides-sdk';
import { calculateSheet, translateSheetFormula } from '@jiange/sheet-sdk';
import { flowWrites, readFlow } from '@jiange/whiteboard-sdk';
assert.equal(typeof globalThis.document, 'undefined');
const doc = new Doc(1), tx = new Tx(doc), block = tx.create('paragraph', null, ROOT);
tx.insert(block, 0, 'Hello'); const next = splitBlock(tx, {b:block,o:2});
assert.equal(bodyBlocks(doc).length, 2); assert.equal(doc.text(next.b), 'llo');
assert.equal(new SyncClient(1).unacked, 0);
const word = buildDocx({blocks:[{type:'paragraph',props:{},spans:[{text:'Hello SDK',marks:{}}]}]}, {title:'Test'});
assert.equal((await parseDocx(word)).blocks[0].text, 'Hello SDK');
const line = {id:'l',kind:'line',x:10,y:10,width:20,height:5,color:'#000000'};
assert.equal(moveShapeOrder([line], 'l', 'front').length, 1); assert.ok(slideLineEndpoints(line,960,540).end.x > 0);
assert.equal(translateSheetFormula('=A1+$A$1',1,0), '=A2+$A$1');
assert.equal(calculateSheet({'0:0':'2','0:1':'=A1*3'})['0:1'], 6);
const graph = {theme:'feishu',nodes:[{id:'n',x:0,y:0,w:140,h:60,shape:'rect',text:'Start'}],edges:[]};
assert.equal(readFlow(flowWrites({},graph)).nodes[0].text,'Start');
`);
  writeFileSync(join(consumer, 'types.ts'), `
import { Doc, Tx, ROOT, SyncClient } from '@jiange/collab';
import { splitBlock } from '@jiange/doc-sdk';
import { moveShapeOrder, type SlideShape } from '@jiange/slides-sdk';
import { calculateSheet } from '@jiange/sheet-sdk';
import { readFlow, type FlowGraph } from '@jiange/whiteboard-sdk';
const doc = new Doc(1), tx = new Tx(doc), block = tx.create('paragraph', null, ROOT);
splitBlock(tx, { b: block, o: 0 }); new SyncClient(1);
const shapes: SlideShape[] = []; moveShapeOrder(shapes, 'id', 'front');
calculateSheet({}); const graph: FlowGraph = readFlow({}); void graph;
`);
  execFileSync(process.execPath, [join(consumer, 'smoke.mjs')], { cwd: consumer, stdio: 'inherit' });
  const require = createRequire(join(root, 'packages/collab/package.json'));
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022', join(consumer, 'types.ts')], { cwd: consumer, stdio: 'inherit' });
  console.log('Five packed headless SDKs passed Node ESM and NodeNext type checks.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
