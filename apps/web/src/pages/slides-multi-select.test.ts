import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SlideShape } from "@/lib/api";
import {
  alignMultipleShapes,
  distributeShapesHorizontally,
  distributeShapesVertically,
  expandSelectionWithGroups,
  findShapeGroup,
  groupShapes,
  isSelectionSingleGroup,
  loadSlideShapeGroups,
  moveMultipleShapes,
  multiSelectionBounds,
  pruneShapeGroups,
  saveSlideShapeGroups,
  shapesInMarquee,
  slideShapeGroupsStorageKey,
  snapMultipleShapes,
  toggleShapeSelection,
  ungroupShapes,
} from "./slides-multi-select";
import { SlideMultiShapeControls } from "./slides-shape-controls";

function makeRect(id: string, x: number, y: number, width = 10, height = 10): SlideShape {
  return { id, kind: "rectangle", x, y, width, height, color: "#3370ff" };
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

describe("slides multi-select geometry, distribution, alignment, and grouping", () => {
  const originalStorage = globalThis.localStorage;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalStorage,
      configurable: true,
      writable: true,
    });
  });

  it("finds all shapes intersecting a percentage marquee rectangle (including reverse drags)", () => {
    const shapes = [
      makeRect("a", 10, 10, 15, 15),
      makeRect("b", 40, 20, 15, 15),
      makeRect("c", 75, 60, 15, 15),
    ];
    expect(shapesInMarquee(shapes, { x: 20, y: 15, width: 30, height: 15 })).toEqual(["a", "b"]);
    // Negative width/height (dragged bottom-right to top-left)
    expect(shapesInMarquee(shapes, { x: 50, y: 30, width: -30, height: -15 })).toEqual(["a", "b"]);
    // Zero-area click selects nothing
    expect(shapesInMarquee(shapes, { x: 15, y: 15, width: 0, height: 0 })).toEqual([]);
    // Strictly touching outside edge does not select
    expect(shapesInMarquee(shapes, { x: 25, y: 10, width: 15, height: 15 })).toEqual([]);
  });

  it("computes the collective bounding box of selected shapes", () => {
    const shapes = [
      makeRect("a", 10, 15, 20, 10),
      makeRect("b", 45, 30, 15, 25),
      makeRect("c", 80, 5, 10, 10),
    ];
    expect(multiSelectionBounds(shapes, ["a", "b"])).toEqual({
      x: 10,
      y: 15,
      width: 50,
      height: 40,
    });
    expect(multiSelectionBounds(shapes, ["missing"])).toBeNull();
    expect(multiSelectionBounds(shapes, [])).toBeNull();
  });

  it("distributes 3+ shapes evenly horizontally and vertically while leaving <3 unchanged", () => {
    const equalH = [
      makeRect("left", 10, 20, 10, 10),
      makeRect("mid", 22, 20, 10, 10),
      makeRect("right", 70, 20, 10, 10),
      makeRect("other", 5, 5, 10, 10),
    ];
    // < 3 selected -> unchanged
    expect(distributeShapesHorizontally(equalH, ["left", "right"])).toEqual(equalH);

    // 3 equal-width shapes: span = 70, widths = 30, gap = 20 -> x = 10, 40, 70
    const distH = distributeShapesHorizontally(equalH, ["left", "mid", "right"]);
    expect(distH.find((s) => s.id === "left")?.x).toBe(10);
    expect(distH.find((s) => s.id === "mid")?.x).toBe(40);
    expect(distH.find((s) => s.id === "right")?.x).toBe(70);
    expect(distH.find((s) => s.id === "other")?.x).toBe(5);

    // Unequal-width shapes: A(10..20), B(w=20), C(70..80) -> gap = (70-40)/2 = 15 -> B at x=35
    const unequalH = [
      makeRect("a", 10, 20, 10, 10),
      makeRect("b", 21, 20, 20, 10),
      makeRect("c", 70, 20, 10, 10),
    ];
    const distUnequalH = distributeShapesHorizontally(unequalH, ["a", "b", "c"]);
    expect(distUnequalH.map((s) => s.x)).toEqual([10, 35, 70]);

    // Vertical distribution with 4 shapes
    const vertical = [
      makeRect("t1", 20, 5, 10, 10),
      makeRect("t2", 20, 18, 10, 10),
      makeRect("t3", 20, 25, 10, 10),
      makeRect("t4", 20, 80, 10, 10),
    ];
    // span = 90 - 5 = 85, totalH = 40, gap = 45 / 3 = 15 -> y = 5, 30, 55, 80
    const distV = distributeShapesVertically(vertical, ["t1", "t2", "t3", "t4"]);
    expect(distV.map((s) => s.y)).toEqual([5, 30, 55, 80]);
  });

  it("aligns multiple shapes relative to their shared selection bounding box", () => {
    const shapes = [
      makeRect("a", 10, 10, 10, 10),
      makeRect("b", 40, 50, 20, 20),
      makeRect("c", 80, 80, 10, 10),
    ];
    // Bounds of a & b: x=10..60 (w=50, center=35), y=10..70 (h=60, center=40)
    const ids = ["a", "b"];
    expect(alignMultipleShapes(shapes, ids, "left").slice(0, 2).map((s) => s.x)).toEqual([10, 10]);
    expect(alignMultipleShapes(shapes, ids, "hcenter").slice(0, 2).map((s) => s.x)).toEqual([30, 25]);
    expect(alignMultipleShapes(shapes, ids, "right").slice(0, 2).map((s) => s.x)).toEqual([50, 40]);
    expect(alignMultipleShapes(shapes, ids, "top").slice(0, 2).map((s) => s.y)).toEqual([10, 10]);
    expect(alignMultipleShapes(shapes, ids, "vcenter").slice(0, 2).map((s) => s.y)).toEqual([35, 30]);
    expect(alignMultipleShapes(shapes, ids, "bottom").slice(0, 2).map((s) => s.y)).toEqual([60, 50]);
    // Unselected shape c is untouched
    expect(alignMultipleShapes(shapes, ids, "left")[2]).toBe(shapes[2]);
  });

  it("moves multiple shapes rigidly together with slide boundary clamping and collective snap", () => {
    const shapes = [
      makeRect("a", 10, 10, 10, 10),
      makeRect("b", 30, 20, 10, 10),
      makeRect("target", 70, 50, 10, 10),
    ];
    // Rigid clamp against left edge: a is at x=10, so dx=-25 clamps to dx=-10 for both
    const clamped = moveMultipleShapes(shapes, ["a", "b"], -25, 5);
    expect(clamped[0]).toMatchObject({ x: 0, y: 15 });
    expect(clamped[1]).toMatchObject({ x: 20, y: 25 });

    // Collective bounds of a & b: x=10..40 (w=30, center=25). Shifting by dx=24.4 puts center at 49.4 -> snaps to slide center 50 (+0.6)!
    const snapped = snapMultipleShapes(shapes, ["a", "b"], 24.4, 0);
    expect(snapped.guides).toContainEqual({ axis: "x", pos: 50 });
    expect(snapped.shapes[0].x).toBe(35);
    expect(snapped.shapes[1].x).toBe(55);
  });

  it("groups, ungroups, expands selection, and persists SlideShapeGroups in localStorage", () => {
    const existing = new Set(["a", "b", "c", "d"]);
    const g1 = groupShapes({}, ["a", "b"], "grp-1");
    expect(g1).toEqual({ "grp-1": ["a", "b"] });
    expect(findShapeGroup(g1, "b")).toEqual({ groupId: "grp-1", memberIds: ["a", "b"] });
    expect(isSelectionSingleGroup(g1, ["a", "b"])).toBe(true);
    expect(isSelectionSingleGroup(g1, ["a", "b", "c"])).toBe(false);

    // Clicking any member selects the entire group
    expect(toggleShapeSelection([], "b", false, g1, existing)).toEqual(["a", "b"]);
    // Shift+clicking an ungrouped shape adds it to the selection
    expect(toggleShapeSelection(["a", "b"], "c", true, g1, existing)).toEqual(["a", "b", "c"]);
    // Shift+clicking a member of an already-selected group removes the whole group
    expect(toggleShapeSelection(["a", "b", "c"], "a", true, g1, existing)).toEqual(["c"]);
    // Marquee hitting one group member expands to include its group sibling
    expect(expandSelectionWithGroups(["a"], g1, existing)).toEqual(["a", "b"]);

    // Persistence round-trip
    saveSlideShapeGroups(12, { 101: g1 });
    expect(slideShapeGroupsStorageKey(12)).toBe("jiange:slides:shape-groups:12");
    expect(loadSlideShapeGroups(12)).toEqual({ 101: { "grp-1": ["a", "b"] } });

    // Pruning deleted shapes dissolves groups with <2 members
    expect(pruneShapeGroups(g1, new Set(["a", "c"]))).toEqual({});

    // Ungroup splits them cleanly
    expect(ungroupShapes(g1, ["a", "b"])).toEqual({});
  });

  it("renders floating Feishu multi-select pill with group/ungroup, align, distribute, and bulk delete", () => {
    const twoHtml = renderToStaticMarkup(
      createElement(SlideMultiShapeControls, {
        count: 2,
        grouped: false,
        onGroup: () => {},
        onUngroup: () => {},
        onAlign: () => {},
        onDistributeHorizontal: () => {},
        onDistributeVertical: () => {},
        onDelete: () => {},
      }),
    );
    expect(twoHtml).toContain("data-slides-multi-controls");
    expect(twoHtml).toContain('role="group"');
    expect(twoHtml).toContain('aria-label="多选对象操作"');
    expect(twoHtml).toContain("已选 2 项");
    expect(twoHtml).toContain("编组");
    expect(twoHtml).toContain("左对齐");
    expect(twoHtml).toContain("水平居中");
    expect(twoHtml).toContain("右对齐");
    expect(twoHtml).toContain("顶对齐");
    expect(twoHtml).toContain("垂直居中");
    expect(twoHtml).toContain("底对齐");
    expect(twoHtml).toContain('aria-label="水平等距分布"');
    expect(twoHtml).toContain('aria-label="垂直等距分布"');
    expect(twoHtml).toContain("disabled");
    expect(twoHtml).toContain("批量删除");

    const threeGroupedHtml = renderToStaticMarkup(
      createElement(SlideMultiShapeControls, {
        count: 3,
        grouped: true,
        onGroup: () => {},
        onUngroup: () => {},
        onAlign: () => {},
        onDistributeHorizontal: () => {},
        onDistributeVertical: () => {},
        onDelete: () => {},
      }),
    );
    expect(threeGroupedHtml).toContain("已选 3 项");
    expect(threeGroupedHtml).toContain("取消编组");
    expect(threeGroupedHtml).not.toContain('aria-label="水平等距分布" title="水平等距分布" disabled');
  });
});
