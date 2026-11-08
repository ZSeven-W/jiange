import { describe, expect, it } from "vitest";
import type { SlideShape } from "@/lib/api";
import { resizeSlideShape } from "./slides-shape-resize";

const shape: SlideShape = { id: "a", kind: "rectangle", x: 20, y: 20, width: 20, height: 20, color: "#3370ff" };

describe("slide shape resize", () => {
  it("keeps the opposite corner fixed and respects the canvas zoom", () => {
    expect(resizeSlideShape(shape, "nw", -48, -27, 480, 270)).toMatchObject({ x: 10, y: 10, width: 30, height: 30 });
    expect(resizeSlideShape(shape, "se", 96, 54, 960, 540)).toMatchObject({ x: 20, y: 20, width: 30, height: 30 });
  });

  it("enforces minimum dimensions and slide boundaries", () => {
    expect(resizeSlideShape(shape, "se", -1000, -1000, 960, 540)).toMatchObject({ x: 20, y: 20, width: 5, height: 5 });
    const result = resizeSlideShape(shape, "nw", -3000, -3000, 960, 540);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.x + result.width!).toBeLessThanOrEqual(100);
    expect(result.y + result.height!).toBeLessThanOrEqual(100);
  });

  it("resizes a rotated shape in its own axes while preserving the opposite edge", () => {
    // At 90°, dragging the right edge down by 96px adds 10% slide width.
    const result = resizeSlideShape({ ...shape, rotation: 90 }, "e", 0, 96, 960, 540);
    expect(result).toMatchObject({ x: 15, y: 28.9, width: 30, height: 20, rotation: 90 });
  });

  it("does not change the shape when the viewport is unavailable", () => {
    expect(resizeSlideShape(shape, "se", 20, 20, 0, 540)).toBe(shape);
  });
});
