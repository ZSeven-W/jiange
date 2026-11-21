# Jiange AI-Native UI SDK Playground

Interactive, zero-bundler, zero-Canvas-2D browser playground showcasing `@jiange/render-gpu` (WebGPU primary / WebGL2 automatic fallback + R8 `GlyphAtlas`) and all five `@jiange/*-ui` packages running directly from compiled `packages/*/dist/*.js` ESM builds via native `<script type="importmap">`.

## Quick Start

From the repository root:

```bash
pnpm -r build && node examples/ui-playground/serve.mjs
```

Then open:

```text
http://127.0.0.1:4173
```

To use a custom port:

```bash
PORT=4200 node examples/ui-playground/serve.mjs
```

## Tabs Included

1. **Sheet (GPU + Virtual2D)** (`@jiange/sheet-ui`, `@jiange/sheet-sdk`)
   - 4-quadrant WebGPU/WebGL2 frozen panes + Fenwick `VirtualGrid2D` + incremental formula DAG.
   - Toggle **10,000 Rows Stress**, toggle inline GPU bar charts, and run AI `sheet_inspect` / `sheet_apply` (`=SUM(...)` formula injection with instant re-render).
2. **Doc (Virtual1D)** (`@jiange/doc-ui`, `@jiange/doc-sdk`)
   - Recycled `VirtualList1D` over CRDT-backed `Document`.
   - Toggle **5,000 Blocks Stress**, jump across sections via the outline panel, and run AI `doc_inspect` / `doc_apply`.
3. **Slides (GPU Stage)** (`@jiange/slides-ui`, `@jiange/slides-sdk`)
   - WebGPU/WebGL2 SDF stage + virtual thumbnail rail.
   - Switch slides, add a slide via AI `slides_apply`, run `slides_verify`, and compare against deterministic `Presentation.renderSvg()` side-by-side.
4. **Whiteboard (GPU Canvas)** (`@jiange/whiteboard-ui`, `@jiange/whiteboard-sdk`)
   - `SpatialIndex` frustum culling + `Camera2D` pan/zoom + SDF shapes & dashed edges.
   - Edit/load Mermaid architecture diagrams, run `autoLayout` (`LR` / `TB`), pan/zoom, and run AI `board_verify`.
5. **Base (Grid / Kanban / Gantt / Dashboard)** (`@jiange/base-ui`, `@jiange/base-sdk`)
   - Switch live between `Grid`, `Kanban`, `Gantt`, and `Dashboard` GPU views.
   - Toggle **10,000 Records Stress** and run AI `base_inspect` / `base_verify`.
6. **GPU GlyphAtlas Lab** (`@jiange/render-gpu`, `@jiange/render-gpu/glyph-atlas`)
   - Direct single-frame `GpuSurface` + `GlyphAtlas` + `InstanceBatch` showcase rendering rounded SDF rects, dashed lines, pie/donut arcs, and R8 bitmap glyphs (`batch.pushText(...)`).
   - Displays exact `backendKind`, `drawCalls`, `rectInstances`, `lineInstances`, `arcInstances`, `glyphInstances`, `GlyphAtlas` dimensions, and `frameTimeMs`.

## Verification Hook

Automated browser checks can inspect live state or drive tabs via `window.__JIANGE_PLAYGROUND__`:

- `window.__JIANGE_PLAYGROUND__.getState()`
- `await window.__JIANGE_PLAYGROUND__.switchTab("sheet" | "doc" | "slides" | "whiteboard" | "base" | "glyph-lab")`
- `await window.__JIANGE_PLAYGROUND__.runAction(actionName, payload)`
