import { describe, expect, it } from "vitest";
import type { SlideShape } from "@/lib/api";
import { alignSlideShape, moveShapeOrder } from "./slides-shape-order";

const shape = (id: string, patch: Partial<SlideShape> = {}): SlideShape => ({ id, kind: "rectangle", x: 10, y: 20, color: "#3370ff", ...patch });
const ids = (shapes: SlideShape[]) => shapes.map((item) => item.id);

describe("moveShapeOrder", () => {
  it("moves a shape to the top and bottom of the stack", () => {
    const shapes = [shape("a"), shape("b"), shape("c")];
    expect(ids(moveShapeOrder(shapes, "a", "front"))).toEqual(["b", "c", "a"]);
    expect(ids(moveShapeOrder(shapes, "c", "back"))).toEqual(["c", "a", "b"]);
  });

  it("steps one layer at a time and stops at the edges", () => {
    const shapes = [shape("a"), shape("b"), shape("c")];
    expect(ids(moveShapeOrder(shapes, "b", "forward"))).toEqual(["a", "c", "b"]);
    expect(ids(moveShapeOrder(shapes, "b", "backward"))).toEqual(["b", "a", "c"]);
    expect(ids(moveShapeOrder(shapes, "a", "backward"))).toEqual(["a", "b", "c"]);
    expect(ids(moveShapeOrder(shapes, "c", "forward"))).toEqual(["a", "b", "c"]);
  });

  it("returns the same array for unknown ids, single shapes, and no-op moves", () => {
    const shapes = [shape("a"), shape("b")];
    expect(moveShapeOrder(shapes, "missing", "front")).toBe(shapes);
    expect(moveShapeOrder([shape("a")], "a", "front")).toEqual([shape("a")]);
    expect(moveShapeOrder(shapes, "b", "forward")).toBe(shapes);
  });
});

describe("alignSlideShape", () => {
  it("aligns horizontally against the slide bounds", () => {
    const item = shape("a", { width: 40 });
    expect(alignSlideShape(item, "left").x).toBe(0);
    expect(alignSlideShape(item, "hcenter").x).toBe(30);
    expect(alignSlideShape(item, "right").x).toBe(60);
  });

  it("aligns vertically against the slide bounds", () => {
    const item = shape("a", { height: 30 });
    expect(alignSlideShape(item, "top").y).toBe(0);
    expect(alignSlideShape(item, "vcenter").y).toBe(35);
    expect(alignSlideShape(item, "bottom").y).toBe(70);
  });

  it("falls back to renderer defaults and keeps aligned shapes unchanged", () => {
    expect(alignSlideShape(shape("a"), "hcenter").x).toBe(42);
    expect(alignSlideShape(shape("a"), "vcenter").y).toBe(40);
    const placed = shape("a", { x: 100 - 16 });
    expect(alignSlideShape(placed, "right")).toBe(placed);
  });
});
