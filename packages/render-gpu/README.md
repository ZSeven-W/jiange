# @zseven-w/render-gpu

Zero-dependency WebGPU / WebGL2 + Virtual List rendering kernel (`v0.2.0`) powering all `@zseven-w/*-ui` packages.

**Zero HTML5 Canvas 2D (`getContext("2d")`) usage** — statically verified in CI and benchmark audits.

## Install

```bash
npm install @zseven-w/render-gpu
```

- **Runtime dependencies**: `0`
- **Bundle size**: ~17.5 KB gzip

## Features

- **Unified `GpuSurface` Backend Fallback**: WebGPU (primary) → WebGL2 (automatic fallback) → `HeadlessNullBackend` (Node.js / SSR / CI testing), with DPI-aware `resize()`, multi-pass `scissor` regions, dirty-frame `requestAnimationFrame` coalescing (`setFrameProducer`, `markDirty`), and per-frame `GpuFrameStats` telemetry.
- **4 Instanced SDF / Glyph Pipelines (WGSL + GLSL 300 es)**:
  - `Rect` (`RECT_STRIDE = 16` floats / 64 B): rounded rectangles, borders, rotation.
  - `Line` (`LINE_STRIDE = 12` floats / 48 B): anti-aliased lines with dash/gap intervals.
  - `Arc` (`ARC_STRIDE = 12` floats / 48 B): ellipses, rings, pie/donut chart arcs (`innerRatio`).
  - `Glyph` (`GLYPH_STRIDE = 12` floats / 48 B): R8 procedural bitmap `GlyphAtlas` (`pushText`) with zero Canvas 2D rasterization.
- **Zero-GC `InstanceBatch` & `Camera2D`**: Pre-allocated `Float32Array` buffers with `reset()` cursor reuse and world↔screen transforms (`screenToWorld`, `worldToScreen`).
- **Sparse `FenwickVirtualizer`**: Supports `1,000,000+` variable-size rows/columns in `O(overrides)` memory with `O(log N)` prefix sum (`indexToOffset`) and binary-lifting inverse lookup (`offsetToIndex`).
- **Zero-Churn Pooled Virtual Views**: `DomNodePool`, `VirtualList1D`, and 4-quadrant frozen `VirtualGrid2D` positioned purely via `transform: translate3d(...)` + `contain: strict`.
- **Uniform-Grid `SpatialIndex`**: `O(1)` frustum culling (`queryRect`) and point hit-testing (`hitTest`) across `10,000+` 2D objects.

## Quickstart

```ts
import {
  GpuSurface,
  InstanceBatch,
  FenwickVirtualizer,
  SpatialIndex,
  packColorRGBA,
} from "@zseven-w/render-gpu";
import { GlyphAtlas } from "@zseven-w/render-gpu/glyph-atlas";

// 1. WebGPU -> WebGL2 -> Headless surface (pass an HTMLCanvasElement in browsers, or null in Node/SSR)
const surface = await GpuSurface.create(null);
surface.resize(1280, 720, 2);

const batch = new InstanceBatch();
batch.pushRect({ x: 16, y: 16, w: 220, h: 64, fill: packColorRGBA("#3370ff"), radius: 8 });
batch.pushLine({ x1: 16, y1: 100, x2: 236, y2: 100, thickness: 2, color: packColorRGBA("#1f2329") });
batch.pushArc({ cx: 300, cy: 50, rx: 28, ry: 28, innerRatio: 0.5, color: packColorRGBA("#00b42a") });
batch.pushText(surface.glyphAtlas, "Jiange GPU", 32, 38, 16, [1, 1, 1, 1]);

const stats = surface.render([batch]);
console.log(stats.backend, stats.drawCalls, stats.glyphInstances);

// 2. 1,000,000-row sparse Fenwick virtualizer & 2D spatial index
const rows = new FenwickVirtualizer(1_000_000, 28);
rows.setSize(42, 64);
const visible = rows.visibleRange(10_000, 720, 2);

const spatial = new SpatialIndex<string>(256);
spatial.insert("node-1", { minX: 0, minY: 0, maxX: 160, maxY: 80 });
const hits = spatial.queryRect({ minX: 0, minY: 0, maxX: 800, maxY: 600 });
void [visible, hits, GlyphAtlas];
surface.dispose();
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@zseven-w/render-gpu` | Full barrel export of all modules below |
| `@zseven-w/render-gpu/gpu-surface` | `GpuSurface`, `WebGPUBackend`, `WebGL2Backend`, `HeadlessNullBackend`, `GpuFrameStats`, `GpuSurfaceOptions` |
| `@zseven-w/render-gpu/instance-buffer` | `InstanceBatch`, `Camera2D`, `packColorRGBA`, `RECT_STRIDE`, `LINE_STRIDE`, `ARC_STRIDE`, `GLYPH_STRIDE` |
| `@zseven-w/render-gpu/glyph-atlas` | `GlyphAtlas`, `GLYPH_CELL_WIDTH`, `GLYPH_CELL_HEIGHT`, `GLYPH_CELL_ADVANCE`, `GlyphMetrics` |
| `@zseven-w/render-gpu/shaders` | WGSL (`WGSL_*_SHADER`) and GLSL 300 es (`GLSL300_*_VS` / `_FS`) shader sources for Rect, Line, Arc, Glyph |
| `@zseven-w/render-gpu/fenwick` | `FenwickVirtualizer`, `VisibleRange` |
| `@zseven-w/render-gpu/virtual-pool` | `DomNodePool`, `VirtualList1D`, `VirtualGrid2D`, `PoolableElement`, `VirtualGridFrame` |
| `@zseven-w/render-gpu/spatial-index` | `SpatialIndex`, `Box2D` |

## Documentation

Full GPU pipeline architecture, shader layouts, and UI embedding guides are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/gpu-ui-sdks.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
