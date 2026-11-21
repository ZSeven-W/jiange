import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const allowed = new Set([
  '@jiange/collab',
  '@jiange/ooxml',
  '@jiange/doc-sdk',
  '@jiange/sheet-sdk',
  '@jiange/slides-sdk',
  '@jiange/whiteboard-sdk',
  '@jiange/base-sdk',
  '@jiange/render-gpu',
  '@jiange/sheet-ui',
  '@jiange/doc-ui',
  '@jiange/slides-ui',
  '@jiange/whiteboard-ui',
  '@jiange/base-ui',
]);
if (!allowed.has(pkg.name)) throw new Error(`Refusing to clean a non-SDK directory: ${pkg.name}`);
await rm(resolve('dist'), { recursive: true, force: true });
