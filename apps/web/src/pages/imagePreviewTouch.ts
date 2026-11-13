import { pinchImageZoom } from "./imagePreviewZoom";

type Point = { x: number; y: number };
type Box = { left: number; top: number; width: number; height: number };
type Scroll = { scrollLeft: number; scrollTop: number };
type Anchor = { point: Point; x: number; y: number };
type Gesture = { kind: "pan"; point: Point; left: number; top: number } | { kind: "pinch"; distance: number; zoom: number; x: number; y: number };
const center = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Mutable only for one open preview; callers apply pending anchors after layout. */
export class ImagePreviewTouch {
  private points = new Map<number, Point>();
  private gesture: Gesture | null = null;
  private pending: Anchor | null = null;

  reset() { this.points.clear(); this.gesture = null; this.pending = null; }
  has(id: number) { return this.points.has(id); }
  down(id: number, point: Point, scroll: Scroll, box: Box | undefined, zoom: number) {
    this.points.set(id, point); this.start(scroll, box, zoom);
  }
  up(id: number, scroll: Scroll, box: Box | undefined, zoom: number) {
    this.points.delete(id); this.start(scroll, box, zoom);
  }
  move(id: number, point: Point, scroll: Scroll): number | undefined {
    if (!this.points.has(id)) return undefined;
    this.points.set(id, point);
    const all = [...this.points.values()], active = this.gesture;
    if (!active) return undefined;
    if (active.kind === "pan" && all.length === 1) {
      scroll.scrollLeft = active.left + active.point.x - all[0].x;
      scroll.scrollTop = active.top + active.point.y - all[0].y;
    } else if (active.kind === "pinch" && all.length >= 2) {
      this.pending = { point: center(all[0], all[1]), x: active.x, y: active.y };
      return pinchImageZoom(active.zoom, active.distance, distance(all[0], all[1]));
    }
    return undefined;
  }
  align(scroll: Scroll, box: Box | undefined) {
    if (!this.pending || !box) return;
    scroll.scrollLeft += box.left + box.width * this.pending.x - this.pending.point.x;
    scroll.scrollTop += box.top + box.height * this.pending.y - this.pending.point.y;
    if (this.gesture?.kind === "pan") { this.gesture.left = scroll.scrollLeft; this.gesture.top = scroll.scrollTop; }
    this.pending = null;
  }
  private start(scroll: Scroll, box: Box | undefined, zoom: number) {
    const all = [...this.points.values()];
    if (!all.length) { this.gesture = null; return; }
    if (all.length === 1) { this.gesture = { kind: "pan", point: all[0], left: scroll.scrollLeft, top: scroll.scrollTop }; return; }
    const mid = center(all[0], all[1]), dist = distance(all[0], all[1]);
    if (!box || !box.width || !box.height || !dist) { this.gesture = null; return; }
    this.gesture = { kind: "pinch", distance: dist, zoom, x: (mid.x - box.left) / box.width, y: (mid.y - box.top) / box.height };
  }
}
