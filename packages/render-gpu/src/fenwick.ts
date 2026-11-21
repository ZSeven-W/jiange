/**
 * Sparse Fenwick Tree (Binary Indexed Tree) virtualizer for 1,000,000+ variable-size items.
 *
 * Only non-default size overrides are stored in sparse maps (`Map<number, number>`), so
 * a 1,000,000-row sheet with 500 custom row heights consumes O(500) memory while providing
 * O(log N) prefix sum (`indexToOffset`) and binary-lifting inverse lookup (`offsetToIndex`).
 */

export interface VisibleRange {
  start: number;
  end: number;
  startOffset: number;
  endOffset: number;
  totalSize: number;
}

export class FenwickVirtualizer {
  private count: number;
  private defaultSize: number;
  /** 0-based index -> custom size delta (size - defaultSize) */
  private overrides = new Map<number, number>();
  /** 1-based Fenwick tree storing prefix sums of deltas */
  private tree = new Map<number, number>();
  private totalDelta = 0;

  constructor(count: number, defaultSize: number) {
    this.count = Math.max(0, Math.floor(count));
    this.defaultSize = Math.max(1, defaultSize);
  }

  get itemCount(): number {
    return this.count;
  }

  get defaultItemSize(): number {
    return this.defaultSize;
  }

  get overrideCount(): number {
    return this.overrides.size;
  }

  /** Total scrollable span in pixels in O(1). */
  get totalSize(): number {
    return this.count * this.defaultSize + this.totalDelta;
  }

  /** Resize item count while keeping valid overrides intact. */
  setCount(nextCount: number): void {
    const clamped = Math.max(0, Math.floor(nextCount));
    if (clamped < this.count && this.overrides.size > 0) {
      for (const idx of [...this.overrides.keys()]) {
        if (idx >= clamped) this.setSize(idx, this.defaultSize);
      }
    }
    this.count = clamped;
  }

  /** Get the size of item `index` in O(1). */
  getSize(index: number): number {
    if (index < 0 || index >= this.count) return 0;
    return this.defaultSize + (this.overrides.get(index) ?? 0);
  }

  private addFenwick(oneBasedIdx: number, delta: number): void {
    let i = oneBasedIdx;
    const limit = this.count;
    while (i <= limit) {
      const next = (this.tree.get(i) ?? 0) + delta;
      if (next === 0) this.tree.delete(i);
      else this.tree.set(i, next);
      i += i & -i;
    }
  }

  private prefixDelta(countExclusive: number): number {
    let sum = 0;
    let i = countExclusive;
    while (i > 0) {
      const v = this.tree.get(i);
      if (v !== undefined) sum += v;
      i -= i & -i;
    }
    return sum;
  }

  /** Update the size of a single item in O(log N). Set to 0 to represent a hidden row/column. */
  setSize(index: number, size: number): void {
    if (index < 0 || index >= this.count) return;
    const clamped = Math.max(0, Number.isFinite(size) ? size : this.defaultSize);
    const newDelta = clamped - this.defaultSize;
    const oldDelta = this.overrides.get(index) ?? 0;
    const diff = newDelta - oldDelta;
    if (diff === 0) return;
    if (newDelta === 0) this.overrides.delete(index);
    else this.overrides.set(index, newDelta);
    this.totalDelta += diff;
    this.addFenwick(index + 1, diff);
  }

  /** Batch-update multiple item sizes. */
  setSizes(entries: ReadonlyArray<[number, number]>): void {
    for (const [idx, size] of entries) this.setSize(idx, size);
  }

  /** Reset all custom sizes back to `defaultSize` in O(1). */
  resetAll(nextDefaultSize?: number): void {
    if (nextDefaultSize !== undefined) this.defaultSize = Math.max(1, nextDefaultSize);
    this.overrides.clear();
    this.tree.clear();
    this.totalDelta = 0;
  }

  /** Cumulative pixel offset of the start of item `index` in O(log N). */
  indexToOffset(index: number): number {
    if (index <= 0) return 0;
    const clamped = Math.min(index, this.count);
    if (this.overrides.size === 0) return clamped * this.defaultSize;
    return clamped * this.defaultSize + this.prefixDelta(clamped);
  }

  /**
   * Binary-lifting inverse lookup: returns the 0-based index of the item containing `offsetPx`
   * in strictly O(log N) time (fast-path O(1) when no overrides exist).
   */
  offsetToIndex(offsetPx: number): number {
    if (this.count === 0) return 0;
    if (offsetPx <= 0) return 0;
    const total = this.totalSize;
    if (offsetPx >= total) return this.count - 1;
    if (this.overrides.size === 0) {
      return Math.min(this.count - 1, Math.floor(offsetPx / this.defaultSize));
    }

    let pos = 0;
    let accDelta = 0;
    let bit = 1;
    while ((bit << 1) <= this.count) bit <<= 1;

    while (bit > 0) {
      const next = pos + bit;
      if (next <= this.count) {
        const nextDelta = accDelta + (this.tree.get(next) ?? 0);
        const nextOffset = next * this.defaultSize + nextDelta;
        if (nextOffset <= offsetPx) {
          pos = next;
          accDelta = nextDelta;
        }
      }
      bit >>= 1;
    }
    return Math.min(this.count - 1, pos);
  }

  /** Compute the inclusive `[start, end]` visible item range with optional overscan. */
  visibleRange(scrollPx: number, viewportPx: number, overscan = 2): VisibleRange {
    const total = this.totalSize;
    if (this.count === 0 || viewportPx <= 0) {
      return { start: 0, end: -1, startOffset: 0, endOffset: 0, totalSize: total };
    }
    const clampedScroll = Math.max(0, Math.min(scrollPx, Math.max(0, total - 1)));
    const firstVisible = this.offsetToIndex(clampedScroll);
    const lastVisible = this.offsetToIndex(Math.min(total, clampedScroll + viewportPx));
    const start = Math.max(0, firstVisible - Math.max(0, overscan));
    const end = Math.min(this.count - 1, lastVisible + Math.max(0, overscan));
    return {
      start,
      end,
      startOffset: this.indexToOffset(start),
      endOffset: this.indexToOffset(end + 1),
      totalSize: total,
    };
  }
}
