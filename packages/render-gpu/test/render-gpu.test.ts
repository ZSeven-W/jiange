import { describe, expect, it, vi } from "vitest";
import {
  Camera2D,
  DomNodePool,
  FenwickVirtualizer,
  GLSL300_GLYPH_FS,
  GLSL300_GLYPH_VS,
  GLYPH_CELL_ADVANCE,
  GLYPH_CELL_HEIGHT,
  GLYPH_CELL_WIDTH,
  GLYPH_STRIDE,
  GlyphAtlas,
  GpuSurface,
  HeadlessNullBackend,
  InstanceBatch,
  SpatialIndex,
  VirtualGrid2D,
  VirtualList1D,
  WGSL_ARC_SHADER,
  WGSL_GLYPH_SHADER,
  WebGL2Backend,
  WebGPUBackend,
  packColorRGBA,
  type GpuCanvasLike,
  type PoolableElement,
} from "../src/index.js";

function makeFakeElement(): PoolableElement {
  return {
    style: { transform: "", width: "", height: "", display: "" },
    textContent: "",
  };
}

function makeMockWebGL2() {
  return {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    BLEND: 0x0be2,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    COLOR_BUFFER_BIT: 0x4000,
    SCISSOR_TEST: 0x0c11,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    UNPACK_ALIGNMENT: 0x0cf5,
    R8: 0x8229,
    RED: 0x1903,
    UNSIGNED_BYTE: 0x1401,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ""),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ""),
    deleteProgram: vi.fn(),
    useProgram: vi.fn(),
    getUniformLocation: vi.fn(() => ({})),
    uniform4f: vi.fn(),
    uniform1i: vi.fn(),
    createVertexArray: vi.fn(() => ({})),
    bindVertexArray: vi.fn(),
    deleteVertexArray: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    deleteBuffer: vi.fn(),
    createTexture: vi.fn(() => ({})),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    deleteTexture: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    vertexAttribDivisor: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    blendFunc: vi.fn(),
    viewport: vi.fn(),
    scissor: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    drawArraysInstanced: vi.fn(),
  };
}

describe("@jiange/render-gpu", () => {
  it("FenwickVirtualizer handles 1,000,000 rows with O(log N) exact offset/index mapping", () => {
    const v = new FenwickVirtualizer(1_000_000, 28);
    expect(v.itemCount).toBe(1_000_000);
    expect(v.defaultItemSize).toBe(28);
    expect(v.totalSize).toBe(28_000_000);
    expect(v.offsetToIndex(28 * 500_000 + 5)).toBe(500_000);

    // Sparse custom row heights + hidden row (height 0)
    v.setSizes([
      [0, 60],
      [10, 0],
      [100, 120],
      [500_000, 80],
    ]);
    expect(v.overrideCount).toBe(4);
    expect(v.getSize(0)).toBe(60);
    expect(v.getSize(10)).toBe(0);
    expect(v.indexToOffset(1)).toBe(60);
    expect(v.indexToOffset(11)).toBe(60 + 9 * 28);
    expect(v.offsetToIndex(59)).toBe(0);
    expect(v.offsetToIndex(60)).toBe(1);

    const range = v.visibleRange(v.indexToOffset(500_000), 600, 2);
    expect(range.start).toBe(499_998);
    expect(range.end).toBeGreaterThan(500_015);

    // Resize & reset
    v.setSize(0, 28); // resets back to default
    expect(v.overrideCount).toBe(3);
    v.setCount(50);
    expect(v.overrideCount).toBe(1);
    v.resetAll(32);
    expect(v.totalSize).toBe(50 * 32);
  });

  it("DomNodePool, VirtualList1D, and 4-quadrant VirtualGrid2D recycle DOM nodes with zero churn", () => {
    const pool = new DomNodePool(makeFakeElement);
    const list = new VirtualList1D(10_000, 30, makeFakeElement);
    const f1 = list.update(0, 300, 400, (idx, el) => { el.textContent = `Row ${idx}`; }, 1);
    const initialCreated = list.pool.totalCreated;
    expect(f1.items.length).toBeGreaterThanOrEqual(10);
    expect(initialCreated).toBe(f1.items.length);

    // Scroll far down — nodes are recycled instead of newly allocated!
    const f2 = list.update(6000, 300, 400, (idx, el) => { el.textContent = `Row ${idx}`; }, 1);
    expect(f2.start).toBeGreaterThan(190);
    expect(list.pool.totalRecycled).toBeGreaterThan(0);
    expect(list.pool.totalCreated).toBeLessThanOrEqual(initialCreated + 2);

    // 4-quadrant frozen VirtualGrid2D
    const grid = new VirtualGrid2D(1000, 100, 28, 100, makeFakeElement);
    const gf = grid.sync(
      { scrollLeft: 500, scrollTop: 1000, viewportWidth: 600, viewportHeight: 300, frozenRows: 1, frozenCols: 1 },
      (cell, el) => { el.textContent = `${cell.row},${cell.col}`; },
    );
    const quads = new Set(gf.cells.map((c) => c.quadrant));
    expect(quads.has("top-left")).toBe(true);
    expect(quads.has("top-right")).toBe(true);
    expect(quads.has("bottom-left")).toBe(true);
    expect(quads.has("bottom-right")).toBe(true);
    expect(gf.frozenHeight).toBe(28);
    expect(gf.frozenWidth).toBe(100);

    pool.clear();
    expect(pool.activeCount).toBe(0);
  });

  it("SpatialIndex performs fast frustum culling and point hit-testing across 10,000 shapes", () => {
    const idx = new SpatialIndex<string>(256);
    for (let i = 0; i < 10_000; i++) {
      const col = i % 100;
      const row = Math.floor(i / 100);
      idx.insert(`n${i}`, { minX: col * 120, minY: row * 80, maxX: col * 120 + 100, maxY: row * 80 + 60 });
    }
    expect(idx.size).toBe(10_000);
    const visible = idx.queryRect({ minX: 0, minY: 0, maxX: 500, maxY: 300 });
    expect(visible.length).toBeGreaterThan(10);
    expect(visible.length).toBeLessThan(60);
    expect(idx.hitTest(50, 30)).toContain("n0");

    idx.update("n0", { minX: 9000, minY: 9000, maxX: 9100, maxY: 9060 });
    expect(idx.hitTest(50, 30)).not.toContain("n0");
    expect(idx.getBox("n0")?.minX).toBe(9000);
    expect(idx.remove("n0")).toBe(true);
    expect(idx.remove("missing")).toBe(false);
    idx.clear();
    expect(idx.size).toBe(0);
  });

  it("packs colors, camera transforms, and auto-growing InstanceBatch buffers with zero per-frame GC", () => {
    expect(packColorRGBA("#fff")).toEqual([1, 1, 1, 1]);
    expect(packColorRGBA("#3370ff")).toEqual([0x33 / 255, 0x70 / 255, 1, 1]);
    expect(packColorRGBA("#00000080")[3]).toBeCloseTo(128 / 255, 3);
    expect(packColorRGBA("rgba(255, 0, 128, 0.5)")[3]).toBe(0.5);
    expect(packColorRGBA("invalid")[2]).toBe(1);

    const cam = new Camera2D(100, 50, 2);
    expect(cam.worldToScreen(150, 75)).toEqual({ x: 100, y: 50 });
    expect(cam.screenToWorld(100, 50)).toEqual({ x: 150, y: 75 });

    const batch = new InstanceBatch(16, 16, 16, 16);
    const atlas = new GlyphAtlas();
    for (let i = 0; i < 40; i++) {
      batch.pushRect({ x: i * 10, y: 0, w: 8, h: 8, fill: [1, 0, 0, 1], radius: 2, borderWidth: 1 });
      batch.pushLine({ x1: 0, y1: i, x2: 100, y2: i, color: [0, 0, 0, 1], dashLen: 4, gapLen: 2 });
      batch.pushArc({ cx: i * 5, cy: 10, rx: 10, ry: 10, color: [0, 1, 0, 1] });
      const gm = atlas.getGlyph("A");
      batch.pushGlyph({ x: i * 8, y: 20, w: 5, h: 7, u0: gm.u0, v0: gm.v0, u1: gm.u1, v1: gm.v1, color: [0, 0, 1, 1] });
    }
    expect(batch.rects).toBe(40);
    expect(batch.lines).toBe(40);
    expect(batch.arcs).toBe(40);
    expect(batch.glyphs).toBe(40);
    expect(batch.totalInstances).toBe(160);
    expect(batch.rectView().length).toBe(40 * 16);
    expect(batch.glyphView().length).toBe(40 * GLYPH_STRIDE);
    batch.reset();
    expect(batch.totalInstances).toBe(0);

    // pushText handles ASCII, spaces, newlines, and non-ASCII fallback glyphs
    batch.pushText(atlas, "Hi World!\n中文", 10, 20, 14, [0.1, 0.2, 0.3, 1]);
    // 10 visible glyphs: H,i,W,o,r,l,d,!,中,文 (space skipped, newline breaks line)
    expect(batch.glyphs).toBe(10);
    const gv = batch.glyphView();
    // Second line starts back at x = 10, y = 20 + 14 * 1.25 = 37.5
    expect(gv[8 * GLYPH_STRIDE]).toBe(10);
    expect(gv[8 * GLYPH_STRIDE + 1]).toBeCloseTo(37.5, 5);
  });

  it("GlyphAtlas shelf-packs ASCII 0x20..0x7E + fallback into R8 Uint8Array with dirty tracking and overflow reset", () => {
    expect(WGSL_ARC_SHADER).toContain("atan2");
    expect(WGSL_GLYPH_SHADER).toContain("textureSample");
    expect(GLSL300_GLYPH_VS).toContain("aUvRect");
    expect(GLSL300_GLYPH_FS).toContain("uAtlas");

    const atlas = new GlyphAtlas();
    expect(atlas.width).toBe(256);
    expect(atlas.height).toBe(256);
    expect(atlas.data.length).toBe(256 * 256);
    expect(atlas.dirty).toBe(false);
    expect(atlas.version).toBe(0);
    expect(atlas.glyphCount).toBe(0);
    expect(atlas.hasGlyph("A")).toBe(false);

    // Rasterize all printable ASCII 0x20..0x7E
    for (let cp = 0x20; cp <= 0x7e; cp++) {
      const ch = String.fromCodePoint(cp);
      const m = atlas.getGlyph(ch);
      expect(m.width).toBe(GLYPH_CELL_WIDTH);
      expect(m.height).toBe(GLYPH_CELL_HEIGHT);
      expect(m.advance).toBe(GLYPH_CELL_ADVANCE);
      expect(m.u0).toBeGreaterThanOrEqual(0);
      expect(m.u1).toBeLessThanOrEqual(1);
      expect(m.u1).toBeGreaterThan(m.u0);
      expect(m.v0).toBeGreaterThanOrEqual(0);
      expect(m.v1).toBeLessThanOrEqual(1);
      expect(m.v1).toBeGreaterThan(m.v0);
    }
    expect(atlas.glyphCount).toBe(95);
    expect(atlas.dirty).toBe(true);
    expect(atlas.hasGlyph("A")).toBe(true);

    // Cache hit does not bump version
    const verBefore = atlas.version;
    const mA1 = atlas.getGlyph("A");
    const mA2 = atlas.getGlyph("A");
    expect(mA2).toEqual(mA1);
    expect(atlas.version).toBe(verBefore);

    // Verify lit R8 pixels exist in atlas buffer
    let litPixels = 0;
    for (let i = 0; i < atlas.data.length; i++) {
      if (atlas.data[i] === 255) litPixels++;
    }
    expect(litPixels).toBeGreaterThan(500);

    // Fallback glyph shared across CJK, control chars, and empty string
    const fbCjk = atlas.getGlyph("汉");
    const fbCtrl = atlas.getGlyph("\t");
    const fbEmpty = atlas.getGlyph("");
    expect(fbCtrl).toEqual(fbCjk);
    expect(fbEmpty).toEqual(fbCjk);
    expect(atlas.hasGlyph("日")).toBe(true);

    // Dirty flag reset
    atlas.markClean();
    expect(atlas.dirty).toBe(false);

    // Tiny atlas forces shelf wrap and overflow auto-clear
    const tiny = new GlyphAtlas({ width: 16, height: 16, padding: 1 });
    expect(tiny.width).toBe(16);
    expect(tiny.height).toBe(16);
    const t1 = tiny.getGlyph("A");
    const t2 = tiny.getGlyph("B");
    expect(t2.u0).toBeGreaterThan(t1.u0);
    // Third glyph wraps shelf and overflows height -> clears and packs at origin
    const t3 = tiny.getGlyph("C");
    expect(t3.u0).toBeCloseTo(1 / 16, 5);
    expect(t3.v0).toBeCloseTo(1 / 16, 5);
    expect(tiny.glyphCount).toBe(1);
  });

  it("GpuSurface selects WebGPU -> WebGL2 -> Headless cleanly without ever requesting 2d context", async () => {
    // 1. WebGPU path with all 4 RFC pipelines (Rect, Line, Arc, GlyphAtlas)
    const mockPass = {
      setViewport: vi.fn(),
      setScissorRect: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      draw: vi.fn(),
      end: vi.fn(),
    };
    const mockTexture = { createView: vi.fn(() => ({})), destroy: vi.fn() };
    const mockDevice = {
      queue: { writeBuffer: vi.fn(), writeTexture: vi.fn(), submit: vi.fn() },
      createShaderModule: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
      createTexture: vi.fn(() => mockTexture),
      createSampler: vi.fn(() => ({})),
      createBindGroup: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(() => ({
        beginRenderPass: () => mockPass,
        finish: () => ({}),
      })),
      destroy: vi.fn(),
    };
    const mockWebGpuCtx = {
      configure: vi.fn(),
      getCurrentTexture: () => ({ createView: () => ({}) }),
    };
    const gpuCanvas: GpuCanvasLike = {
      width: 0,
      height: 0,
      style: {},
      getContext: vi.fn((id: string) => (id === "webgpu" ? mockWebGpuCtx : null)) as GpuCanvasLike["getContext"],
    };

    const gpuSurface = await GpuSurface.create(gpuCanvas, {
      prefer: "webgpu",
      dpr: 2,
      navigatorGpu: {
        requestAdapter: async () => ({ requestDevice: async () => mockDevice }),
        getPreferredCanvasFormat: () => "bgra8unorm",
      },
    });
    expect(gpuSurface.backendKind).toBe("webgpu");
    gpuSurface.resize(800, 600);
    expect(gpuCanvas.width).toBe(1600);

    const b = new InstanceBatch();
    b.scissor = { x: 0, y: 0, w: 400, h: 300 };
    b.pushRect({ x: 10, y: 10, w: 100, h: 30, fill: [0.2, 0.4, 1, 1] });
    b.pushLine({ x1: 0, y1: 0, x2: 100, y2: 100, color: [0, 0, 0, 1] });
    b.pushArc({ cx: 100, cy: 100, rx: 30, ry: 30, color: [1, 0.5, 0, 1] });
    b.pushText(gpuSurface.glyphAtlas, "GPU", 20, 20, 14, [0, 0, 0, 1]);
    expect(gpuSurface.glyphAtlas.dirty).toBe(true);
    const stats = gpuSurface.render([b]);
    expect(stats.backend).toBe("webgpu");
    expect(stats.drawCalls).toBe(4);
    expect(stats.arcInstances).toBe(1);
    expect(stats.glyphInstances).toBe(3);
    expect(mockPass.draw).toHaveBeenCalledTimes(4);
    expect(mockDevice.queue.writeTexture).toHaveBeenCalledTimes(1);
    expect(gpuSurface.glyphAtlas.dirty).toBe(false);

    // Second render skips atlas texture upload when clean
    gpuSurface.render([b]);
    expect(mockDevice.queue.writeTexture).toHaveBeenCalledTimes(1);
    gpuSurface.dispose();
    expect(mockTexture.destroy).toHaveBeenCalledTimes(1);

    // 2. Automatic WebGL2 fallback path with all 4 RFC pipelines
    const gl = makeMockWebGL2();
    const glCanvas: GpuCanvasLike = {
      width: 0,
      height: 0,
      style: {},
      getContext: vi.fn((id: string) => (id === "webgl2" ? gl : null)) as GpuCanvasLike["getContext"],
    };
    const glSurface = await GpuSurface.create(glCanvas, { prefer: "webgpu", dpr: 1 });
    expect(glSurface.backendKind).toBe("webgl2");
    glSurface.resize(640, 480);
    const glBatch = new InstanceBatch();
    glBatch.scissor = { x: 0, y: 0, w: 400, h: 300 };
    glBatch.pushRect({ x: 10, y: 10, w: 100, h: 30, fill: [0.2, 0.4, 1, 1] });
    glBatch.pushLine({ x1: 0, y1: 0, x2: 100, y2: 100, color: [0, 0, 0, 1] });
    glBatch.pushArc({ cx: 100, cy: 100, rx: 30, ry: 30, color: [1, 0.5, 0, 1] });
    glBatch.pushText(glSurface.glyphAtlas, "GL2", 10, 10, 14, [0, 0, 0, 1]);
    expect(glSurface.glyphAtlas.dirty).toBe(true);
    const glStats = glSurface.render([glBatch]);
    expect(glStats.backend).toBe("webgl2");
    expect(glStats.drawCalls).toBe(4);
    expect(glStats.glyphInstances).toBe(3);
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(4);
    expect(gl.texImage2D).toHaveBeenCalledTimes(2); // 1 initial + 1 dirty upload
    expect(glSurface.glyphAtlas.dirty).toBe(false);
    // Clean second render skips redundant texImage2D
    glSurface.render([glBatch]);
    expect(gl.texImage2D).toHaveBeenCalledTimes(2);
    glSurface.dispose();
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);

    // 3. Headless fallback + custom glyphAtlas + dirty-frame scheduling
    const customAtlas = new GlyphAtlas({ width: 128, height: 128 });
    const headless = await GpuSurface.create(null, { glyphAtlas: customAtlas });
    expect(headless.backendKind).toBe("headless");
    expect(headless.glyphAtlas).toBe(customAtlas);
    headless.setClearColor([0.98, 0.98, 0.98, 1]);
    headless.resize(500, 400, 1);
    headless.setFrameProducer(() => [b]);
    headless.markDirty();
    await new Promise((r) => setTimeout(r, 10));
    expect(headless.stats?.rectInstances).toBe(1);
    expect(headless.stats?.glyphInstances).toBe(3);
    expect(headless.stats?.drawCalls).toBe(4);
    headless.dispose();

    // Direct backend default glyphAtlas constructors
    const directGpu = new WebGPUBackend(mockDevice, mockWebGpuCtx, "bgra8unorm");
    expect(directGpu.glyphAtlas).toBeInstanceOf(GlyphAtlas);
    directGpu.dispose();
    const directHeadless = new HeadlessNullBackend();
    expect(directHeadless.glyphAtlas).toBeInstanceOf(GlyphAtlas);
    directHeadless.dispose();
  });

  it("covers FenwickVirtualizer, InstanceBatch, SpatialIndex, and VirtualPool edge cases", () => {
    // FenwickVirtualizer bounds & edge cases
    const empty = new FenwickVirtualizer(0, 28);
    expect(empty.getSize(0)).toBe(0);
    expect(empty.offsetToIndex(10)).toBe(0);
    expect(empty.visibleRange(0, 100)).toEqual({ start: 0, end: -1, startOffset: 0, endOffset: 0, totalSize: 0 });

    const fv = new FenwickVirtualizer(5, 20);
    expect(fv.getSize(-1)).toBe(0);
    expect(fv.getSize(5)).toBe(0);
    fv.setSize(-1, 50);
    fv.setSize(5, 50);
    fv.setSize(2, 20); // diff === 0 no-op
    fv.setSize(2, 40);
    fv.setSize(2, 40); // diff === 0 no-op on existing override
    fv.setSize(2, Number.NaN); // falls back to defaultSize
    expect(fv.getSize(2)).toBe(20);
    expect(fv.offsetToIndex(fv.totalSize + 50)).toBe(4);
    expect(fv.visibleRange(0, 0).end).toBe(-1);

    // packColorRGBA rgb() without alpha component and alphaOverride
    expect(packColorRGBA("rgb(255, 0, 128)")).toEqual([1, 0, 128 / 255, 1]);
    expect(packColorRGBA("rgb(255, 0, 128)", 0.4)).toEqual([1, 0, 128 / 255, 0.4]);

    // SpatialIndex empty buckets in queryRect and hitTest
    const spatial = new SpatialIndex<string>(128);
    spatial.insert("a", { minX: 0, minY: 0, maxX: 50, maxY: 50 });
    expect(spatial.queryRect({ minX: -500, minY: -500, maxX: 500, maxY: 500 })).toEqual(["a"]);
    expect(spatial.hitTest(-999, -999)).toEqual([]);

    // DomNodePool freeCount, unchanged x/y/w/h re-sync, and clear() on non-empty pool
    const pool = new DomNodePool(makeFakeElement);
    const items = [{ key: "k1", x: 10, y: 20, width: 100, height: 30, render: () => {} }];
    pool.sync(items);
    pool.sync(items); // same x, y, width, height -> skip style updates
    expect(pool.activeCount).toBe(1);
    expect(pool.freeCount).toBe(0);
    pool.clear();
    expect(pool.activeCount).toBe(0);
    expect(pool.freeCount).toBe(1);

    // VirtualList1D skipping zero-height hidden items
    const list = new VirtualList1D(5, 30, makeFakeElement);
    list.sizes.setSize(1, 0);
    const listFrame = list.update(0, 200, 400, () => {}, 0);
    expect(listFrame.items.map((it) => it.index)).not.toContain(1);

    // VirtualGrid2D default frozenRows/frozenCols, zero-sized hidden row/col, and shouldMount filter
    const grid = new VirtualGrid2D(5, 5, 25, 80, makeFakeElement);
    grid.rows.setSize(1, 0);
    grid.cols.setSize(2, 0);
    const mounted: string[] = [];
    const gf = grid.sync(
      { scrollLeft: 0, scrollTop: 0, viewportWidth: 400, viewportHeight: 200 },
      (cell) => {
        mounted.push(`${cell.row}:${cell.col}`);
      },
      (row, col) => (row + col) % 2 === 0,
    );
    expect(gf.frozenHeight).toBe(0);
    expect(gf.frozenWidth).toBe(0);
    expect(gf.cells.some((c) => c.row === 1 || c.col === 2)).toBe(false);
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(gf.cells.length);
  });

  it("covers WebGPU buffer growth, scissor-less rendering, WebGL2 shader/link failures, and GpuSurface fallback/RAF/dispose paths", async () => {
    // WebGPU backend: pipeline without getBindGroupLayout, buffer growth >1024 rects & lines, no scissor
    const mockPass = {
      setViewport: vi.fn(),
      setScissorRect: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      draw: vi.fn(),
      end: vi.fn(),
    };
    const destroyedBuffers: number[] = [];
    const mockDevice = {
      queue: { writeBuffer: vi.fn(), writeTexture: vi.fn(), submit: vi.fn() },
      createShaderModule: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({})), // no getBindGroupLayout
      createBuffer: vi.fn(() => ({ destroy: () => { destroyedBuffers.push(1); } })),
      createTexture: vi.fn(() => ({ createView: () => ({}), destroy: vi.fn() })),
      createSampler: vi.fn(() => ({})),
      createBindGroup: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(() => ({
        beginRenderPass: () => mockPass,
        finish: () => ({}),
      })),
    };
    const mockWebGpuCtx = {
      configure: vi.fn(),
      getCurrentTexture: () => ({ createView: () => ({}) }),
    };
    const gpuCanvas: GpuCanvasLike = {
      width: 0,
      height: 0,
      getContext: vi.fn((id: string) => (id === "webgpu" ? mockWebGpuCtx : null)) as GpuCanvasLike["getContext"],
    };

    const gpuSurface = await GpuSurface.create(gpuCanvas, {
      prefer: "webgpu",
      navigatorGpu: {
        requestAdapter: async () => ({ requestDevice: async () => mockDevice }),
        // omit getPreferredCanvasFormat to hit "bgra8unorm" fallback
      },
    });
    expect(gpuSurface.backendKind).toBe("webgpu");
    gpuSurface.resize(400, 300);

    const bigBatch = new InstanceBatch(16, 16, 16, 16);
    const gm = gpuSurface.glyphAtlas.getGlyph("X");
    for (let i = 0; i < 1030; i++) {
      bigBatch.pushRect({ x: i, y: 0, w: 4, h: 4, fill: [1, 0, 0, 1] });
      bigBatch.pushLine({ x1: 0, y1: i, x2: 10, y2: i, color: [0, 1, 0, 1] });
      if (i < 260) {
        bigBatch.pushArc({ cx: i, cy: 10, rx: 5, ry: 5, color: [0, 0, 1, 1] });
      }
      bigBatch.pushGlyph({ x: i, y: 20, w: 5, h: 7, u0: gm.u0, v0: gm.v0, u1: gm.u1, v1: gm.v1, color: [1, 1, 1, 1] });
    }
    const gpuStats = gpuSurface.render([bigBatch]);
    expect(gpuStats.rectInstances).toBe(1030);
    expect(gpuStats.lineInstances).toBe(1030);
    expect(gpuStats.arcInstances).toBe(260);
    expect(gpuStats.glyphInstances).toBe(1030);
    expect(destroyedBuffers.length).toBeGreaterThanOrEqual(4);
    expect(mockPass.setScissorRect).toHaveBeenCalledWith(0, 0, 400, 300);

    // Dispose twice & render/markDirty after dispose
    gpuSurface.dispose();
    gpuSurface.dispose();
    expect(gpuSurface.render([bigBatch]).drawCalls).toBe(0);
    gpuSurface.markDirty();

    // WebGL2 shader compile failure (with info log and null info log)
    const badShaderGl1 = makeMockWebGL2();
    badShaderGl1.getShaderParameter = vi.fn(() => false);
    badShaderGl1.getShaderInfoLog = vi.fn(() => "bad syntax");
    expect(() => new WebGL2Backend(badShaderGl1)).toThrow(/bad syntax/);

    const badShaderGl2 = makeMockWebGL2();
    badShaderGl2.getShaderParameter = vi.fn(() => false);
    badShaderGl2.getShaderInfoLog = vi.fn(() => null as unknown as string);
    expect(() => new WebGL2Backend(badShaderGl2)).toThrow(/shader compile failed/);

    // WebGL2 program link failure (with info log and null info log)
    const badLinkGl1 = makeMockWebGL2();
    badLinkGl1.getProgramParameter = vi.fn(() => false);
    badLinkGl1.getProgramInfoLog = vi.fn(() => "bad link");
    expect(() => new WebGL2Backend(badLinkGl1)).toThrow(/bad link/);

    const badLinkGl2 = makeMockWebGL2();
    badLinkGl2.getProgramParameter = vi.fn(() => false);
    badLinkGl2.getProgramInfoLog = vi.fn(() => null as unknown as string);
    expect(() => new WebGL2Backend(badLinkGl2)).toThrow(/program link failed/);

    // WebGL2 render without scissor
    const okGl = makeMockWebGL2();
    const glBackend = new WebGL2Backend(okGl);
    glBackend.resize(200, 100, 1);
    const smallBatch = new InstanceBatch();
    smallBatch.pushRect({ x: 0, y: 0, w: 10, h: 10, fill: [1, 1, 1, 1] });
    glBackend.render([smallBatch], [0, 0, 0, 1]);
    expect(okGl.disable).toHaveBeenCalledWith(okGl.SCISSOR_TEST);
    glBackend.dispose();

    // GpuSurface.create fallbacks: null adapter, null webgpu ctx, throwing requestAdapter, throwing webgl2
    const nullCanvas: GpuCanvasLike = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => null) as GpuCanvasLike["getContext"],
    };
    const sNullAdapter = await GpuSurface.create(nullCanvas, {
      prefer: "webgpu",
      navigatorGpu: { requestAdapter: async () => null },
    });
    expect(sNullAdapter.backendKind).toBe("headless");

    const sNullCtx = await GpuSurface.create(nullCanvas, {
      prefer: "webgpu",
      navigatorGpu: { requestAdapter: async () => ({ requestDevice: async () => mockDevice }) },
    });
    expect(sNullCtx.backendKind).toBe("headless");

    const sThrowWebGpu = await GpuSurface.create(nullCanvas, {
      prefer: "webgpu",
      navigatorGpu: { requestAdapter: async () => { throw new Error("no gpu"); } },
    });
    expect(sThrowWebGpu.backendKind).toBe("headless");

    const throwGlCanvas: GpuCanvasLike = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => { throw new Error("gl boom"); }) as GpuCanvasLike["getContext"],
    };
    const sThrowGl = await GpuSurface.create(throwGlCanvas, { prefer: "webgl2" });
    expect(sThrowGl.backendKind).toBe("headless");

    // Global devicePixelRatio, undefined navigator, requestAnimationFrame & cancelAnimationFrame
    const origDprDesc = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
    const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const origRafDesc = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const origCancelRafDesc = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
    try {
      Object.defineProperty(globalThis, "devicePixelRatio", { value: 2, configurable: true, writable: true });
      Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true, writable: true });

      const sNoNav = await GpuSurface.create(nullCanvas, { prefer: "webgpu" });
      expect(sNoNav.backendKind).toBe("headless");
      sNoNav.dispose();

      let pendingCb: (() => void) | null = null;
      const cancelRafSpy = vi.fn();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        value: (cb: () => void) => {
          pendingCb = cb;
          return 42;
        },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        value: cancelRafSpy,
        configurable: true,
        writable: true,
      });

      const sRaf = await GpuSurface.create(null);
      sRaf.setFrameProducer(() => [smallBatch]);
      sRaf.markDirty();
      sRaf.markDirty(); // already dirty -> no-op
      expect(pendingCb).not.toBeNull();
      sRaf.dispose();
      expect(cancelRafSpy).toHaveBeenCalledWith(42);
      // Invoking stale callback after dispose safely does nothing
      pendingCb!();
    } finally {
      if (origDprDesc) Object.defineProperty(globalThis, "devicePixelRatio", origDprDesc);
      else delete (globalThis as Record<string, unknown>).devicePixelRatio;
      if (origNavDesc) Object.defineProperty(globalThis, "navigator", origNavDesc);
      if (origRafDesc) Object.defineProperty(globalThis, "requestAnimationFrame", origRafDesc);
      else delete (globalThis as Record<string, unknown>).requestAnimationFrame;
      if (origCancelRafDesc) Object.defineProperty(globalThis, "cancelAnimationFrame", origCancelRafDesc);
      else delete (globalThis as Record<string, unknown>).cancelAnimationFrame;
    }
  });
});
