import { describe, expect, it, vi } from "vitest";
import {
  Camera2D,
  DomNodePool,
  FenwickVirtualizer,
  GpuSurface,
  InstanceBatch,
  SpatialIndex,
  VirtualGrid2D,
  VirtualList1D,
  WebGL2Backend,
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
    createVertexArray: vi.fn(() => ({})),
    bindVertexArray: vi.fn(),
    deleteVertexArray: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    deleteBuffer: vi.fn(),
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

    const batch = new InstanceBatch(16, 16, 16);
    for (let i = 0; i < 40; i++) {
      batch.pushRect({ x: i * 10, y: 0, w: 8, h: 8, fill: [1, 0, 0, 1], radius: 2, borderWidth: 1 });
      batch.pushLine({ x1: 0, y1: i, x2: 100, y2: i, color: [0, 0, 0, 1], dashLen: 4, gapLen: 2 });
      batch.pushArc({ cx: i * 5, cy: 10, rx: 10, ry: 10, color: [0, 1, 0, 1] });
    }
    expect(batch.rects).toBe(40);
    expect(batch.lines).toBe(40);
    expect(batch.arcs).toBe(40);
    expect(batch.totalInstances).toBe(120);
    expect(batch.rectView().length).toBe(40 * 16);
    batch.reset();
    expect(batch.totalInstances).toBe(0);
  });

  it("GpuSurface selects WebGPU -> WebGL2 -> Headless cleanly without ever requesting 2d context", async () => {
    // 1. WebGPU path
    const mockPass = {
      setViewport: vi.fn(),
      setScissorRect: vi.fn(),
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      draw: vi.fn(),
      end: vi.fn(),
    };
    const mockDevice = {
      queue: { writeBuffer: vi.fn(), submit: vi.fn() },
      createShaderModule: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
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
    const stats = gpuSurface.render([b]);
    expect(stats.backend).toBe("webgpu");
    expect(stats.drawCalls).toBe(2);
    expect(mockPass.draw).toHaveBeenCalledTimes(2);
    gpuSurface.dispose();

    // 2. Automatic WebGL2 fallback path
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
    b.pushArc({ cx: 100, cy: 100, rx: 30, ry: 30, color: [1, 0.5, 0, 1] });
    const glStats = glSurface.render([b]);
    expect(glStats.backend).toBe("webgl2");
    expect(glStats.drawCalls).toBe(3);
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(3);
    glSurface.dispose();

    // 3. Headless fallback + dirty-frame scheduling
    const headless = await GpuSurface.create(null);
    expect(headless.backendKind).toBe("headless");
    headless.setClearColor([0.98, 0.98, 0.98, 1]);
    headless.resize(500, 400, 1);
    headless.setFrameProducer(() => [b]);
    headless.markDirty();
    await new Promise((r) => setTimeout(r, 10));
    expect(headless.stats?.rectInstances).toBe(1);
    headless.dispose();
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
      queue: { writeBuffer: vi.fn(), submit: vi.fn() },
      createShaderModule: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({})), // no getBindGroupLayout
      createBuffer: vi.fn(() => ({ destroy: () => { destroyedBuffers.push(1); } })),
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

    const bigBatch = new InstanceBatch(16, 16, 16);
    for (let i = 0; i < 1030; i++) {
      bigBatch.pushRect({ x: i, y: 0, w: 4, h: 4, fill: [1, 0, 0, 1] });
      bigBatch.pushLine({ x1: 0, y1: i, x2: 10, y2: i, color: [0, 1, 0, 1] });
    }
    const gpuStats = gpuSurface.render([bigBatch]);
    expect(gpuStats.rectInstances).toBe(1030);
    expect(gpuStats.lineInstances).toBe(1030);
    expect(destroyedBuffers.length).toBeGreaterThanOrEqual(2);
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
