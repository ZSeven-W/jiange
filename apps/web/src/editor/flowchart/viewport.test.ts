import { describe, expect, it } from "vitest";
import { fitInsertedImage, pinchViewport, placeMindMenu, placeSelectionToolbar, resizeViewportCenter } from "./viewport";

describe("flowchart pinch", () => {
  it("keeps the same canvas centre as the viewport narrows", () => {
    const view = { x: 100, y: 50, zoom: 2 };
    const next = resizeViewportCenter(view, { w: 1000, h: 800 }, { w: 400, h: 600 });
    expect(next).toEqual({ x: 250, y: 100, zoom: 2 });
    expect(next.x + 400 / (2 * next.zoom)).toBe(view.x + 1000 / (2 * view.zoom));
  });
  it("keeps the touched point anchored while zooming and moving", () => {
    const initial = { x: 100, y: 50, zoom: 1 };
    const result = pinchViewport(initial, { x: 80, y: 100 }, { x: 110, y: 120 }, 100, 200);
    expect(result).toEqual({ x: 125, y: 90, zoom: 2 });
    expect(result.x + 110 / result.zoom).toBe(180);
    expect(result.y + 120 / result.zoom).toBe(150);
  });
  it("clamps zoom and ignores invalid distances", () => {
    const initial = { x: 0, y: 0, zoom: 1 };
    expect(pinchViewport(initial, { x: 0, y: 0 }, { x: 0, y: 0 }, 100, 1000).zoom).toBe(3);
    expect(pinchViewport(initial, { x: 0, y: 0 }, { x: 0, y: 0 }, 100, 1).zoom).toBe(0.2);
    expect(pinchViewport(initial, { x: 0, y: 0 }, { x: 0, y: 0 }, 0, 10)).toBe(initial);
  });
});

describe("mind map menu", () => {
  it("avoids the tree and floating toolbar when room exists", () => {
    const obstacles = [{ x: 460, y: 290, w: 110, h: 50 }, { x: 625, y: 292, w: 90, h: 30 }, { x: 850, y: 292, w: 90, h: 30 }, { x: 508, y: 242, w: 320, h: 42 }];
    const pos = placeMindMenu({ x: 800, y: 8 }, { w: 1280, h: 720 }, obstacles);
    expect(pos.left).toBeGreaterThanOrEqual(940);
    expect(pos.left + 192).toBeLessThanOrEqual(1272);
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });
  it("stays within a narrow viewport when no position can avoid every node", () => {
    const pos = placeMindMenu({ x: 200, y: 600 }, { w: 320, h: 400 }, [{ x: 40, y: 120, w: 240, h: 160 }]);
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left + 192).toBeLessThanOrEqual(312);
    expect(pos.top).toBeGreaterThanOrEqual(8);
    expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(392);
  });
  it("uses a scrollable shorter menu to leave a mobile tree uncovered", () => {
    const obstacles = [{ x: 12, y: 12, w: 100, h: 40 }, { x: 172, y: 12, w: 205, h: 40 }, { x: 24, y: 334, w: 90, h: 48 }, { x: 160, y: 334, w: 80, h: 30 }, { x: 295, y: 334, w: 75, h: 30 }, { x: 12, y: 683, w: 365, h: 42 }];
    const pos = placeMindMenu({ x: 190, y: 8 }, { w: 390, h: 844 }, obstacles);
    expect(pos.maxHeight).toBeLessThan(454);
    expect(obstacles.every((box) => pos.left + 192 <= box.x || pos.left >= box.x + box.w || pos.top + pos.maxHeight <= box.y || pos.top >= box.y + box.h)).toBe(true);
  });
});

describe("inserted image sizing", () => {
  it("fits a wide image on a zoomed mobile canvas", () => {
    const result = fitInsertedImage({ w: 1922, h: 512 }, { w: 390, h: 498 }, 1.5);
    expect(result.w * 1.5).toBeLessThanOrEqual(342);
    expect(result.h * 1.5).toBeLessThanOrEqual(450);
    expect(result.w / result.h).toBeCloseTo(1922 / 512, 1);
  });
  it("fits a tall image vertically and keeps small images small", () => {
    expect(fitInsertedImage({ w: 100, h: 1000 }, { w: 320, h: 250 }, 1)).toEqual({ w: 20, h: 202 });
    expect(fitInsertedImage({ w: 80, h: 60 }, { w: 900, h: 600 }, 1)).toEqual({ w: 80, h: 60 });
  });
});

describe("flowchart selection toolbar", () => {
  it("moves below a top-edge node and stays clear of the header", () => {
    expect(placeSelectionToolbar({ x: 40, y: 75, w: 100, h: 50 }, { w: 800, h: 700 }, { w: 300, h: 40 })).toEqual({ left: 158, top: 137 });
  });
  it("uses the space above lower nodes and clamps the horizontal position", () => {
    expect(placeSelectionToolbar({ x: 760, y: 400, w: 50, h: 50 }, { w: 800, h: 700 }, { w: 300, h: 40 })).toEqual({ left: 642, top: 348 });
  });
  it("keeps the toolbar visible when the selected node is offscreen", () => {
    expect(placeSelectionToolbar({ x: -200, y: -200, w: 40, h: 40 }, { w: 800, h: 700 }, { w: 300, h: 40 })).toEqual({ left: 158, top: 64 });
  });
  it("moves beside a node when the space below contains another node", () => {
    const anchor = { x: 350, y: 70, w: 100, h: 50 };
    const pos = placeSelectionToolbar(anchor, { w: 1000, h: 700 }, { w: 300, h: 40 }, [anchor, { x: 330, y: 130, w: 140, h: 80 }]);
    const left = pos.left - 150, right = pos.left + 150;
    expect(right <= 330 || left >= 470 || pos.top + 40 <= 130 || pos.top >= 210).toBe(true);
  });
});
