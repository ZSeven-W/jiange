import { describe, expect, it } from "vitest";
import { samePositions, slideDropIndex, verifySlideOrder } from "./slides-order";
describe("slide order", () => {
  it("resolves before and after drop targets after removing the source", () => {
    expect(slideDropIndex(0, 2, true)).toBe(2);
    expect(slideDropIndex(2, 0, false)).toBe(0);
    expect(slideDropIndex(1, 2, false)).toBe(1);
  });
  it("accepts only the exact reordered receipt and detects stale positions", () => {
    const before = [{ id: 1, pos: 1 }, { id: 2, pos: 2 }, { id: 3, pos: 3 }];
    const after = [{ id: 2, pos: 1 }, { id: 3, pos: 2 }, { id: 1, pos: 3 }];
    expect(verifySlideOrder(before, 1, 2, after)).toEqual(after);
    expect(verifySlideOrder(before, 1, 2, [...after].reverse())).toBeNull();
    expect(samePositions(before, [{ id: 1, pos: 1 }, { id: 2, pos: 2.5 }, { id: 3, pos: 3 }])).toBe(false);
  });
});
