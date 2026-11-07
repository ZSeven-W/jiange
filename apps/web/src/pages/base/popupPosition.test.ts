import { describe, expect, it } from "vitest";
import { popupPosition } from "./popupPosition";

describe("grid floating panels", () => {
  it("anchors beneath the field header at desktop widths", () => {
    const p = popupPosition({ left: 578, top: 148, bottom: 184 }, 1440, 900, 322);
    expect(p).toEqual({ left: 578, top: 188, width: 322, maxHeight: 696 });
  });
  it("stays within the screen near the right edge and on narrow screens", () => {
    for (const [w, h, left, top] of [[1440, 900, 1400, 170], [390, 844, 365, 720], [320, 500, 200, 450]]) {
      const p = popupPosition({ left, top, bottom: top + 36 }, w, h, 322);
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.left + p.width).toBeLessThanOrEqual(w);
      expect(p.top).toBeGreaterThanOrEqual(0);
      expect(p.top + p.maxHeight).toBeLessThanOrEqual(h);
    }
  });
});
