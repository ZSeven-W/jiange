import { describe, expect, it } from "vitest";
import type { SlideShape } from "@/lib/api";
import { computeSlideShapeSnap } from "./slides-snap";

const makeShape = (id: string, x: number, y: number, width = 20, height = 20): SlideShape => ({
  id,
  kind: "rectangle",
  x,
  y,
  width,
  height,
  color: "#3370ff",
});

describe("computeSlideShapeSnap", () => {
  it("snaps a shape center to the slide 50% horizontal and vertical centerlines", () => {
    // width 20 -> center at x + 10. With x = 40.8, center is 50.8 (within 1.2% of 50)
    const moving = makeShape("a", 40.8, 39.4, 20, 20);
    const res = computeSlideShapeSnap(moving, [moving]);
    expect(res.shape.x).toBe(40);
    expect(res.shape.y).toBe(40);
    expect(res.guides).toEqual([
      { axis: "x", pos: 50 },
      { axis: "y", pos: 50 },
    ]);
  });

  it("snaps a shape edge to a sibling shape edge", () => {
    const sibling = makeShape("sib", 20, 15, 25, 18);
    const moving = makeShape("a", 20.9, 60, 16, 20);
    const res = computeSlideShapeSnap(moving, [sibling, moving]);
    expect(res.shape.x).toBe(20);
    expect(res.guides).toContainEqual({ axis: "x", pos: 20 });
  });

  it("leaves shape unchanged with no guides when far from all snap targets", () => {
    const moving = makeShape("a", 25, 25, 16, 20);
    const res = computeSlideShapeSnap(moving, [moving]);
    expect(res.shape.x).toBe(25);
    expect(res.shape.y).toBe(25);
    expect(res.guides).toEqual([]);
  });
});
