import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const allowed = new Set(['@jiange/collab', '@jiange/doc-sdk', '@jiange/sheet-sdk', '@jiange/slides-sdk', '@jiange/whiteboard-sdk', '@jiange/ooxml']);
if (!allowed.has(pkg.name)) throw new Error('Refusing to clean a non-SDK directory');
await rm(resolve('dist'), { recursive: true, force: true });
