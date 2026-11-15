import { describe, expect, it } from "vitest";
import { samePositions, slideDropIndex, slideEdgeScrollSpeed, verifySlideOrder } from "./slides-order";
describe("slide order", () => {
  it("resolves before and after drop targets after removing the source", () => {
    expect(slideDropIndex(0, 2, true)).toBe(2);
    expect(slideDropIndex(2, 0, false)).toBe(0);
    expect(slideDropIndex(1, 2, false)).toBe(1);
  });
  it("scrolls only near an edge inside the page list", () => {
    const rect = { left: 10, right: 110, top: 100, bottom: 500 };
    expect(slideEdgeScrollSpeed(rect, 50, 101)).toBeLessThan(0);
    expect(slideEdgeScrollSpeed(rect, 50, 499)).toBeGreaterThan(0);
    expect(slideEdgeScrollSpeed(rect, 50, 300)).toBe(0);
    expect(slideEdgeScrollSpeed(rect, 111, 499)).toBe(0);
    expect(slideEdgeScrollSpeed(rect, 50, 501)).toBe(0);
  });
  it("accepts only the exact reordered receipt and detects stale positions", () => {
    const before = [{ id: 1, pos: 1 }, { id: 2, pos: 2 }, { id: 3, pos: 3 }];
    const after = [{ id: 2, pos: 1 }, { id: 3, pos: 2 }, { id: 1, pos: 3 }];
    expect(verifySlideOrder(before, 1, 2, after)).toEqual(after);
    expect(verifySlideOrder(before, 1, 2, [...after].reverse())).toBeNull();
    expect(samePositions(before, [{ id: 1, pos: 1 }, { id: 2, pos: 2.5 }, { id: 3, pos: 3 }])).toBe(false);
  });
});
