/**
 * Automated Performance Benchmark Suite, Bundle Size Audit & Isolated Package Verification
 * for Jiange's AI-Native Office SDKs (RFC Section 7 SLAs).
 *
 * Run with: node benchmarks/run-benchmarks.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const ALL_PACKAGES = [
  "ooxml",
  "collab",
  "sheet-sdk",
  "doc-sdk",
  "slides-sdk",
  "whiteboard-sdk",
  "base-sdk",
  "render-gpu",
  "sheet-ui",
  "doc-ui",
  "slides-ui",
  "whiteboard-ui",
  "base-ui",
];

// ---------------------------------------------------------------------------
// 1. Bundle Size & Zero-Canvas-2D Audit
// ---------------------------------------------------------------------------

function walkJsFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

console.log("=== 1. Bundle Size & Zero-Canvas-2D Audit ===");
const sizeRows = [];
for (const pkg of ALL_PACKAGES) {
  const distDir = join(root, "packages", pkg, "dist");
  assert.ok(existsSync(join(distDir, "index.js")), `${pkg}: missing dist/index.js`);
  const files = walkJsFiles(distDir);
  let rawBytes = 0;
  let combined = "";
  for (const f of files) {
    const txt = readFileSync(f, "utf8");
    rawBytes += Buffer.byteLength(txt, "utf8");
    combined += txt + "\n";
    if (pkg === "render-gpu" || pkg.endsWith("-ui")) {
      const codeOnly = txt.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.ok(!/getContext\s*\(\s*["']2d["']\s*\)/.test(codeOnly), `${pkg}/${f} MUST NOT use Canvas 2D getContext("2d")!`);
    }
    const base = f.split("/").pop();
    assert.ok(!/[A-Z_]/.test(base), `${pkg}: non-kebab dist file ${base}`);
  }
  const gzBytes = gzipSync(combined, { level: 9 }).length;
  sizeRows.push({ pkg: `@jiange/${pkg}`, files: files.length, rawKB: (rawBytes / 1024).toFixed(1), gzipKB: (gzBytes / 1024).toFixed(1) });
}
console.table(sizeRows);

// ---------------------------------------------------------------------------
// 2. RFC Section 7 Performance Benchmarks
// ---------------------------------------------------------------------------

console.log("=== 2. RFC Section 7 Performance Benchmarks ===");

const { Workbook } = await import(join(root, "packages/sheet-sdk/dist/index.js"));
const { writeXlsxAsync, readXlsx } = await import(join(root, "packages/sheet-sdk/dist/xlsx.js"));
const { readXlsx: readXlsxReal } = await import(join(root, "packages/sheet-sdk/dist/xlsx-read.js"));
void readXlsx;
const { FenwickVirtualizer, SpatialIndex, InstanceBatch } = await import(join(root, "packages/render-gpu/dist/index.js"));

// Benchmark A: 10,000-formula incremental recalc (single edit in 10k-formula workbook)
{
  const wb = Workbook.create({ sheets: [{ name: "Calc", rows: 10010, cols: 4 }] });
  const sh = wb.sheet("Calc");
  const rows = [];
  for (let r = 0; r < 10_000; r++) {
    rows.push([r + 1, `=A${r + 1}*2`]);
  }
  sh.setRange("A1", rows);
  assert.equal(sh.getValue("B1"), 2);
  assert.equal(sh.getValue("B10000"), 20000);

  // Measure single-cell incremental edit + recalc (warmed)
  sh.setCell("A1", 10);
  const t0 = performance.now();
  sh.setCell("A1", 42);
  const v = sh.getValue("B1");
  const elapsedMs = performance.now() - t0;
  assert.equal(v, 84);
  console.log(`  [PASS] 10k-formula incremental recalc (1 edit): ${elapsedMs.toFixed(3)} ms (SLA < 5 ms)`);
  assert.ok(elapsedMs < 5, `Incremental recalc exceeded 5ms SLA: ${elapsedMs.toFixed(3)}ms`);
}

// Benchmark B: 50,000-cell XLSX DEFLATE write + read
{
  const cells = [];
  for (let r = 0; r < 5000; r++) {
    for (let c = 0; c < 10; c++) {
      cells.push({ row: r, col: c, value: c === 0 ? `Row-${r}` : r * 10 + c });
    }
  }
  const tWrite0 = performance.now();
  const bytes = await writeXlsxAsync({ sheets: [{ name: "Data", cells }] });
  const writeMs = performance.now() - tWrite0;

  const tRead0 = performance.now();
  const parsed = await readXlsxReal(bytes);
  const readMs = performance.now() - tRead0;

  assert.equal(parsed.workbook.sheets[0].cells.length, 50_000);
  console.log(`  [PASS] 50k-cell XLSX DEFLATE write: ${writeMs.toFixed(1)} ms (${(bytes.length / 1024).toFixed(1)} KB), read: ${readMs.toFixed(1)} ms`);
}

// Benchmark C: 1,000,000-row FenwickVirtualizer (1,000 random variable-height scroll frames)
{
  const v = new FenwickVirtualizer(1_000_000, 28);
  for (let i = 0; i < 500; i++) v.setSize(i * 1999, 44 + (i % 40));
  const t0 = performance.now();
  let acc = 0;
  for (let f = 0; f < 1000; f++) {
    const r = v.visibleRange(f * 25_000, 720, 2);
    acc += r.end - r.start;
  }
  const totalMs = performance.now() - t0;
  const perFrameMs = totalMs / 1000;
  assert.ok(acc > 0);
  console.log(`  [PASS] 1M-row Fenwick virtualizer (1,000 scroll frames): ${perFrameMs.toFixed(4)} ms/frame (total ${totalMs.toFixed(2)} ms, SLA < 4 ms/frame)`);
  assert.ok(perFrameMs < 4, `Fenwick virtualizer exceeded 4ms/frame: ${perFrameMs}`);
}

// Benchmark D: 10,000-node SpatialIndex frustum culling + GPU InstanceBatch packing
{
  const spatial = new SpatialIndex(256);
  const nodes = [];
  for (let i = 0; i < 10_000; i++) {
    const x = (i % 100) * 160;
    const y = Math.floor(i / 100) * 90;
    const n = { id: i, x, y, w: 140, h: 60 };
    nodes.push(n);
    spatial.insert(i, { minX: x, minY: y, maxX: x + 140, maxY: y + 60 });
  }
  const batch = new InstanceBatch(2048, 2048, 64);
  const fill = [0.2, 0.44, 1, 1];
  const t0 = performance.now();
  for (let f = 0; f < 100; f++) {
    batch.reset();
    const ox = (f % 20) * 300;
    const oy = Math.floor(f / 20) * 300;
    const visible = spatial.queryRect({ minX: ox, minY: oy, maxX: ox + 1280, maxY: oy + 720 });
    for (const id of visible) {
      const n = nodes[id];
      batch.pushRect({ x: n.x, y: n.y, w: n.w, h: n.h, fill, radius: 8, borderWidth: 1.5 });
    }
  }
  const perFrameMs = (performance.now() - t0) / 100;
  console.log(`  [PASS] 10k-node SpatialIndex cull + GPU buffer pack: ${perFrameMs.toFixed(4)} ms/frame (SLA < 2 ms/frame)`);
  assert.ok(perFrameMs < 2, `Spatial cull + GPU pack exceeded 2ms/frame: ${perFrameMs}`);
}

// Benchmark E: 10,000-row Workbook.inspect({ detail: "summary" })
{
  const wb = Workbook.create({ sheets: [{ name: "Big", rows: 10005, cols: 5 }] });
  const sh = wb.sheet("Big");
  const rows = [];
  for (let r = 0; r < 10_000; r++) rows.push([`Row${r}`, r, r * 2, r * 3, "Active"]);
  sh.setRange("A1", rows);
  const t0 = performance.now();
  const summary = wb.inspect({ detail: "summary" });
  const elapsedMs = performance.now() - t0;
  assert.equal(summary.summary.totalCells, 50_000);
  console.log(`  [PASS] 10k-row (50k cells) Workbook.inspect summary: ${elapsedMs.toFixed(2)} ms`);
}

// ---------------------------------------------------------------------------
// 3. Isolated Single-Package Install Verification (ALL 13 packages!)
// ---------------------------------------------------------------------------

console.log("=== 3. Isolated Single-Package Install Verification ===");
const temp = mkdtempSync(join(tmpdir(), "jiange-iso-bench-"));
try {
  const mountPublishedPkg = (dir, pkgName) => {
    const srcPkgDir = join(root, "packages", pkgName);
    const rawPkg = JSON.parse(readFileSync(join(srcPkgDir, "package.json"), "utf8"));
    const pubPkg = { ...rawPkg, ...(rawPkg.publishConfig ?? {}) };
    delete pubPkg.publishConfig;
    const dst = join(dir, "node_modules", "@jiange", pkgName);
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, "package.json"), JSON.stringify(pubPkg, null, 2));
    cpSync(join(srcPkgDir, "dist"), join(dst, "dist"), { recursive: true });
  };

  const runIsolated = (label, deps, code) => {
    const iso = join(temp, label);
    mkdirSync(iso, { recursive: true });
    writeFileSync(join(iso, "package.json"), JSON.stringify({ private: true, type: "module" }));
    for (const d of deps) mountPublishedPkg(iso, d);
    writeFileSync(join(iso, "test.mjs"), code);
    execFileSync(process.execPath, [join(iso, "test.mjs")], { cwd: iso, stdio: "inherit" });
    console.log(`  [PASS] isolated install "${label}" (deps: ${deps.join(", ")})`);
  };

  runIsolated("ooxml-only", ["ooxml"], `
    import assert from 'node:assert/strict';
    import { createZipAsync, listZip } from '@jiange/ooxml/zip';
    const z = await createZipAsync([{ name: 'a.txt', data: new TextEncoder().encode('hello'.repeat(30)) }]);
    assert.equal(listZip(z)[0].name, 'a.txt');
  `);

  runIsolated("collab-only", ["collab"], `
    import assert from 'node:assert/strict';
    import { Doc } from '@jiange/collab';
    import { CollabTable, encodeTableOps, decodeTableOps } from '@jiange/collab/table';
    import { AiCollabSession } from '@jiange/collab/ai-agent';
    const ai = new AiCollabSession({ agentId: 'a', clientId: 9 });
    ai.appendParagraph('hi');
    assert.equal(decodeTableOps(encodeTableOps([])).length, 0);
    assert.ok(new CollabTable() && new Doc(1));
  `);

  runIsolated("sheet-sdk-only", ["ooxml", "sheet-sdk"], `
    import assert from 'node:assert/strict';
    import { Workbook, createSheetTools } from '@jiange/sheet-sdk';
    const wb = Workbook.create();
    wb.sheet(0).setCell('A1', 10).setCell('A2', '=A1*4');
    assert.equal(wb.sheet(0).getValue('A2'), 40);
    assert.equal(createSheetTools(wb).tools.length, 6);
  `);

  runIsolated("doc-sdk-only", ["ooxml", "collab", "doc-sdk"], `
    import assert from 'node:assert/strict';
    import { Document, createDocTools } from '@jiange/doc-sdk';
    const doc = Document.fromMarkdown('# Hello\\n\\nWorld', 'Doc');
    assert.equal(doc.outline().length, 1);
    assert.equal(createDocTools(doc).tools.length, 7);
  `);

  runIsolated("slides-sdk-only", ["ooxml", "slides-sdk"], `
    import assert from 'node:assert/strict';
    import { Presentation, createSlidesTools } from '@jiange/slides-sdk';
    const deck = Presentation.create({ title: 'Pitch' });
    assert.ok(deck.renderSvg(0).includes('Pitch'));
    assert.equal(createSlidesTools(deck).tools.length, 7);
  `);

  runIsolated("whiteboard-sdk-only", ["ooxml", "whiteboard-sdk"], `
    import assert from 'node:assert/strict';
    import { Board, createWhiteboardTools } from '@jiange/whiteboard-sdk';
    const board = Board.fromMermaid('flowchart TD\\n  A[Start] --> B[Done]');
    assert.ok(board.toSvg().includes('Start'));
    assert.equal(createWhiteboardTools(board).tools.length, 8);
  `);

  runIsolated("base-sdk-only", ["base-sdk"], `
    import assert from 'node:assert/strict';
    import { Base, createBaseTools } from '@jiange/base-sdk';
    const base = Base.create({ name: 'CRM' });
    base.addRecord(undefined, { Name: 'Acme' });
    assert.equal(base.getRecords().length, 1);
    assert.equal(createBaseTools(base).tools.length, 8);
  `);

  runIsolated("render-gpu-only", ["render-gpu"], `
    import assert from 'node:assert/strict';
    import { FenwickVirtualizer, GpuSurface } from '@jiange/render-gpu';
    const v = new FenwickVirtualizer(100000, 28);
    assert.equal(v.totalSize, 2800000);
    const s = await GpuSurface.create(null);
    assert.equal(s.backendKind, 'headless');
  `);

  runIsolated("sheet-ui-only", ["ooxml", "sheet-sdk", "render-gpu", "sheet-ui"], `
    import assert from 'node:assert/strict';
    import { Workbook } from '@jiange/sheet-sdk';
    import { GpuSurface } from '@jiange/render-gpu';
    import { SheetGpuRenderer, SheetViewController } from '@jiange/sheet-ui';
    const wb = Workbook.create();
    const ctrl = new SheetViewController(wb, new SheetGpuRenderer(await GpuSurface.create(null), () => ({ style: { transform: '', width: '', height: '', display: '' }, textContent: '' })));
    assert.equal(ctrl.render().gpu.backend, 'headless');
  `);

  runIsolated("doc-ui-only", ["ooxml", "collab", "doc-sdk", "render-gpu", "doc-ui"], `
    import assert from 'node:assert/strict';
    import { Document } from '@jiange/doc-sdk';
    import { DocViewController } from '@jiange/doc-ui';
    const ctrl = new DocViewController(Document.fromMarkdown('# Hi'), () => ({ style: { transform: '', width: '', height: '', display: '' }, textContent: '' }));
    assert.equal(ctrl.render().visibleCount, 1);
  `);

  runIsolated("slides-ui-only", ["ooxml", "slides-sdk", "render-gpu", "slides-ui"], `
    import assert from 'node:assert/strict';
    import { Presentation } from '@jiange/slides-sdk';
    import { GpuSurface } from '@jiange/render-gpu';
    import { SlidesViewController } from '@jiange/slides-ui';
    const ctrl = new SlidesViewController(Presentation.create({ title: 'Hi' }), await GpuSurface.create(null), () => ({ style: { transform: '', width: '', height: '', display: '' }, textContent: '' }));
    assert.equal(ctrl.render().slideIndex, 0);
  `);

  runIsolated("whiteboard-ui-only", ["ooxml", "whiteboard-sdk", "render-gpu", "whiteboard-ui"], `
    import assert from 'node:assert/strict';
    import { Board } from '@jiange/whiteboard-sdk';
    import { GpuSurface } from '@jiange/render-gpu';
    import { WhiteboardViewController } from '@jiange/whiteboard-ui';
    const ctrl = new WhiteboardViewController(Board.fromMermaid('flowchart TD\\n A --> B'), await GpuSurface.create(null), () => ({ style: { transform: '', width: '', height: '', display: '' }, textContent: '' }));
    assert.equal(ctrl.render().totalNodes, 2);
  `);

  runIsolated("base-ui-only", ["base-sdk", "render-gpu", "base-ui"], `
    import assert from 'node:assert/strict';
    import { Base } from '@jiange/base-sdk';
    import { GpuSurface } from '@jiange/render-gpu';
    import { BaseViewController } from '@jiange/base-ui';
    const ctrl = new BaseViewController(Base.create({ name: 'B' }), await GpuSurface.create(null), () => ({ style: { transform: '', width: '', height: '', display: '' }, textContent: '' }));
    assert.equal(ctrl.render().mode, 'grid');
  `);

  console.log("\nALL 13 PACKAGES PASSED BUNDLE AUDIT, BENCHMARKS & ISOLATED INSTALLS!");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
