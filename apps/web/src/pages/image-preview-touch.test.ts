import { describe, expect, it } from "vitest";
import { ImagePreviewTouch } from "./image-preview-touch";

describe("image preview touch gestures", () => {
  it("keeps the touched image point under the moving pinch center after layout", () => {
    const touch = new ImagePreviewTouch(), scroll = { scrollLeft: 50, scrollTop: 10 };
    const before = { left: 0, top: 0, width: 100, height: 100 };
    touch.down(1, { x: 25, y: 50 }, scroll, before, 1);
    touch.down(2, { x: 75, y: 50 }, scroll, before, 1);
    expect(touch.move(1, { x: 0, y: 50 }, scroll)).toBe(1.5);
    touch.align(scroll, { left: 0, top: 0, width: 150, height: 150 });
    expect(scroll.scrollLeft).toBe(87.5);
    expect(scroll.scrollTop).toBe(35);
    touch.align(scroll, { left: 0, top: 0, width: 150, height: 150 });
    expect(scroll.scrollLeft).toBe(87.5);
  });

  it("continues as a one-finger pan after a pinch and clears canceled touches", () => {
    const touch = new ImagePreviewTouch(), scroll = { scrollLeft: 80, scrollTop: 50 }, box = { left: 0, top: 0, width: 200, height: 200 };
    touch.down(1, { x: 30, y: 40 }, scroll, box, 1);
    touch.down(2, { x: 90, y: 40 }, scroll, box, 1);
    touch.up(2, scroll, box, 1);
    expect(touch.move(1, { x: 10, y: 30 }, scroll)).toBeUndefined();
    expect(scroll).toEqual({ scrollLeft: 100, scrollTop: 60 });
    touch.reset();
    expect(touch.has(1)).toBe(false);
    expect(touch.move(1, { x: 0, y: 0 }, scroll)).toBeUndefined();
    expect(scroll).toEqual({ scrollLeft: 100, scrollTop: 60 });
  });

  it("applies the final pinch anchor even if a finger lifts before layout", () => {
    const touch = new ImagePreviewTouch(), scroll = { scrollLeft: 50, scrollTop: 10 }, box = { left: 0, top: 0, width: 100, height: 100 };
    touch.down(1, { x: 25, y: 50 }, scroll, box, 1);
    touch.down(2, { x: 75, y: 50 }, scroll, box, 1);
    expect(touch.move(1, { x: 0, y: 50 }, scroll)).toBe(1.5);
    touch.up(2, scroll, box, 1.5);
    touch.align(scroll, { left: 0, top: 0, width: 150, height: 150 });
    expect(scroll).toEqual({ scrollLeft: 87.5, scrollTop: 35 });
    touch.move(1, { x: -10, y: 50 }, scroll);
    expect(scroll.scrollLeft).toBe(97.5);
  });
});
