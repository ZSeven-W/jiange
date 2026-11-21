# @jiange/render-gpu

Ultra-lightweight WebGPU (primary) / WebGL2 (automatic fallback) instanced SDF rendering kernel + sparse Fenwick Tree Virtualizer + DOM Recycling Pool.

**Zero Canvas 2D (`getContext("2d")`) usage. Zero runtime dependencies.**

## Components

- `FenwickVirtualizer` — O(log N) variable-size offset/index lookup across 1,000,000+ rows/columns with sparse delta storage
- `VirtualList1D` & `VirtualGrid2D` — Fixed-size recycled DOM node pool (`translate3d` + `contain: strict`), zero mount/unmount during scroll, 4-quadrant frozen pane support
- `SpatialIndex` — O(1) uniform-grid frustum culling & point hit-testing for 10,000+ shapes
- `InstanceBatch` — Zero-GC double-buffered `Float32Array` GPU instance buffers (SDF rounded rects, thick/dashed lines, ellipses/pie arcs)
- `GpuSurface` — WebGPU → WebGL2 → Headless backend abstraction with scissor-rect multi-region passes & dirty-frame RAF scheduling
