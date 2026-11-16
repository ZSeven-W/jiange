import { describe, expect, it } from "vitest";
import { patchSlideShape, type SlideShape } from "../src/index.js";

describe("slide shape updates", () => {
  it("updates only the selected shape, retaining other properties and clamping to the canvas", () => {
    const shapes: SlideShape[] = [
      { id: "a", kind: "rectangle", x: 50, y: 50, width: 20, height: 20, color: "#123456" },
      { id: "b", kind: "rectangle", x: 3, y: 4, color: "#abcdef" },
    ];
    const result = patchSlideShape(shapes, "a", { x: 95, y: 99 });
    expect(result[0]).toMatchObject({ x: 80, y: 80, color: "#123456" });
    expect(result[1]).toBe(shapes[1]);
    expect(shapes[0]).toMatchObject({ x: 50, y: 50 });
    expect(patchSlideShape(shapes, "missing", { x: 1 })).toEqual(shapes);
  });
});
