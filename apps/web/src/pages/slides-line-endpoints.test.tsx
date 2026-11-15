import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SlideShape } from "@/lib/api";
import { slideLineEndpoints, moveSlideLineEndpoint } from "./slides-line-endpoints";
import { SlideShapes } from "./slides-shapes";

const line: SlideShape = { id: "line", kind: "line-arrow", x: 35, y: 48, width: 30, height: 5, color: "#1f2329" };
const W = 960, H = 540;
const distance = (a: {x:number;y:number}, b: {x:number;y:number}) => Math.hypot(a.x - b.x, a.y - b.y);

describe("slide line endpoint editing", () => {
  it("moves an end diagonally while keeping the other end fixed", () => {
    const before = slideLineEndpoints(line, W, H);
    const changed = moveSlideLineEndpoint(line, "end", 80, 90, W, H);
    const after = slideLineEndpoints(changed, W, H);
    expect(changed.rotation).toBeGreaterThan(0);
    expect(distance(before.start, after.start)).toBeLessThan(2);
    expect(distance(after.end, {x:before.end.x + 80,y:before.end.y + 90})).toBeLessThan(2);
  });
  it("supports an already-rotated line and crossing the stationary end", () => {
    const rotated = { ...line, rotation: 90 };
    const original = slideLineEndpoints(rotated, W, H);
    const changed = moveSlideLineEndpoint(rotated, "start", 120, 0, W, H);
    expect(distance(slideLineEndpoints(changed, W, H).end, original.end)).toBeLessThan(2);
    const flipped = moveSlideLineEndpoint(line, "end", -320, 0, W, H);
    expect(flipped.rotation).toBe(180);
    expect(distance(slideLineEndpoints(flipped, W, H).start, slideLineEndpoints(line, W, H).start)).toBeLessThan(2);
  });
  it("rejects unrepresentable or invalid geometry instead of corrupting the shape", () => {
    expect(moveSlideLineEndpoint(line, "end", -259.2, 0, W, H)).toBe(line);
    expect(moveSlideLineEndpoint(line, "end", NaN, 0, W, H)).toBe(line);
    expect(moveSlideLineEndpoint(line, "end", 10, 0, 0, H)).toBe(line);
  });
  it("uses two labelled endpoint controls for lines and resize handles for shapes", () => {
    const markup = renderToStaticMarkup(<SlideShapes shapes={[line]} editable selected="line"/>);
    expect(markup).toContain('aria-label="调整线条起点"');
    expect(markup).toContain('aria-label="调整线条终点"');
    expect(markup).not.toContain('aria-label="调整图形左上边界"');
    const rectangle = renderToStaticMarkup(<SlideShapes shapes={[{...line,kind:"rectangle"}]} editable selected="line"/>);
    expect(rectangle).toContain('aria-label="调整图形左上边界"');
  });
});
