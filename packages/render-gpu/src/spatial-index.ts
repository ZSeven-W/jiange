/**
 * Uniform-grid 2D Spatial Hash Index for O(1) frustum culling & point hit-testing
 * across 10,000+ whiteboard nodes, slides shapes, and Gantt bars.
 */

export interface Box2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class SpatialIndex<T = string> {
  private readonly cellSize: number;
  private buckets = new Map<string, Set<T>>();
  private boxes = new Map<T, Box2D>();
  private cellKeys = new Map<T, string[]>();

  constructor(cellSize = 256) {
    this.cellSize = Math.max(16, cellSize);
  }

  get size(): number {
    return this.boxes.size;
  }

  private bucketKey(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  insert(id: T, box: Box2D): void {
    if (this.boxes.has(id)) this.remove(id);
    const minCx = Math.floor(box.minX / this.cellSize);
    const maxCx = Math.floor(box.maxX / this.cellSize);
    const minCy = Math.floor(box.minY / this.cellSize);
    const maxCy = Math.floor(box.maxY / this.cellSize);

    const keys: string[] = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const k = this.bucketKey(cx, cy);
        let bucket = this.buckets.get(k);
        if (!bucket) {
          bucket = new Set<T>();
          this.buckets.set(k, bucket);
        }
        bucket.add(id);
        keys.push(k);
      }
    }
    this.boxes.set(id, { ...box });
    this.cellKeys.set(id, keys);
  }

  update(id: T, box: Box2D): void {
    this.insert(id, box);
  }

  remove(id: T): boolean {
    const keys = this.cellKeys.get(id);
    if (!keys) return false;
    for (const k of keys) {
      const bucket = this.buckets.get(k);
      if (bucket) {
        bucket.delete(id);
        if (bucket.size === 0) this.buckets.delete(k);
      }
    }
    this.cellKeys.delete(id);
    this.boxes.delete(id);
    return true;
  }

  clear(): void {
    this.buckets.clear();
    this.boxes.clear();
    this.cellKeys.clear();
  }

  getBox(id: T): Box2D | undefined {
    return this.boxes.get(id);
  }

  /** Return all item IDs whose bounding boxes intersect `viewBox`. */
  queryRect(viewBox: Box2D): T[] {
    const minCx = Math.floor(viewBox.minX / this.cellSize);
    const maxCx = Math.floor(viewBox.maxX / this.cellSize);
    const minCy = Math.floor(viewBox.minY / this.cellSize);
    const maxCy = Math.floor(viewBox.maxY / this.cellSize);

    const seen = new Set<T>();
    const results: T[] = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.buckets.get(this.bucketKey(cx, cy));
        if (!bucket) continue;
        for (const id of bucket) {
          if (seen.has(id)) continue;
          seen.add(id);
          const b = this.boxes.get(id)!;
          if (b.maxX >= viewBox.minX && b.minX <= viewBox.maxX && b.maxY >= viewBox.minY && b.minY <= viewBox.maxY) {
            results.push(id);
          }
        }
      }
    }
    return results;
  }

  /** Return all item IDs whose bounding box contains `(x, y)`. */
  hitTest(x: number, y: number): T[] {
    const bucket = this.buckets.get(this.bucketKey(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)));
    if (!bucket) return [];
    const hits: T[] = [];
    for (const id of bucket) {
      const b = this.boxes.get(id)!;
      if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) hits.push(id);
    }
    return hits;
  }
}
