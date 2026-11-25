import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const allowed = new Set([
  '@zseven-w/collab',
  '@zseven-w/ooxml',
  '@zseven-w/doc-sdk',
  '@zseven-w/sheet-sdk',
  '@zseven-w/slides-sdk',
  '@zseven-w/whiteboard-sdk',
  '@zseven-w/base-sdk',
  '@zseven-w/render-gpu',
  '@zseven-w/sheet-ui',
  '@zseven-w/doc-ui',
  '@zseven-w/slides-ui',
  '@zseven-w/whiteboard-ui',
  '@zseven-w/base-ui',
]);
if (!allowed.has(pkg.name)) throw new Error(`Refusing to clean a non-SDK directory: ${pkg.name}`);
await rm(resolve('dist'), { recursive: true, force: true });
