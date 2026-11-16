import { describe, expect, it } from "vitest";
import { clampGraphZoom, fitGraphZoom, graphAnchorScroll, screenToGraph, stepGraphZoom } from "./document-reference-graph-viewport";

describe("reference graph viewport", () => {
  it("clamps and steps zoom predictably", () => {
    expect(clampGraphZoom(0.01)).toBe(0.25); expect(clampGraphZoom(9)).toBe(2); expect(clampGraphZoom(NaN)).toBe(1);
    expect(stepGraphZoom(1, 1)).toBe(1.25); expect(stepGraphZoom(1.12, -1)).toBe(1); expect(stepGraphZoom(0.25, -1)).toBe(0.25);
  });
  it("fits the available viewport within bounds", () => {
    expect(fitGraphZoom({ width: 800, height: 400 }, { width: 432, height: 300 })).toBe(0.5);
    expect(fitGraphZoom({ width: 5000, height: 5000 }, { width: 300, height: 400 })).toBe(0.25);
    expect(fitGraphZoom({ width: 0, height: 10 }, { width: 300, height: 400 })).toBe(1);
  });
  it("retains the point under the cursor after a scale change", () => {
    const graph = { width: 800, height: 400 }, screen = { x: 250, y: 160 };
    const world = screenToGraph(screen, { left: 50, top: 60, width: 800, height: 400 }, graph)!;
    expect(world).toEqual({ x: 200, y: 100 });
    expect(graphAnchorScroll({ x: 100, y: 50 }, { left: 50, top: 60, width: 1200, height: 600 }, graph, world, screen)).toEqual({ x: 200, y: 100 });
    expect(screenToGraph(screen, { left: 0, top: 0, width: 0, height: 2 }, graph)).toBeNull();
  });
});
