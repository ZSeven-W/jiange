import { describe, expect, it } from "vitest";
import { flowBounds, flowIntentWrites, flowWrites, moveFlowSelection, normalizeStroke, readFlow, type FlowGraph } from "../src/model.js";
import { appliedFlowHistory } from "../src/history.js";
import { inkHitByEraser, scaleInk, scaleSelectionProportionally, selectionBounds } from "../src/ink-geometry.js";

describe("canvas ink", () => {
  const blank: FlowGraph = { nodes: [], edges: [], theme: "feishu" };
  const stroke = { id: "s1", points: [{ x: 10, y: 20 }, { x: 100, y: 80 }], color: "#1F2329", width: 3 };
  it("persists independent strokes and includes them in bounds", () => {
    const writes = flowWrites({}, { ...blank, strokes: [stroke] });
    expect(readFlow(writes).strokes).toEqual([stroke]);
    expect(flowBounds(readFlow(writes))).toEqual({ x: 8.5, y: 18.5, w: 93, h: 63 });
    expect(normalizeStroke({ ...stroke, points: [{ x: Infinity, y: 0 }] })).toBeNull();
    expect(normalizeStroke({ ...stroke, points: Array.from({ length: 401 }, () => ({ x: 0, y: 0 })) })).toBeNull();
  });
  it("does not overwrite another editor's changes and makes ink undoable", () => {
    const target = { ...blank, strokes: [stroke] };
    const writes = flowIntentWrites({}, blank, target);
    const after = readFlow(writes.writes);
    const history = appliedFlowHistory(blank, after, Object.keys(writes.writes));
    expect(history?.before.strokes).toEqual([]);
    expect(flowIntentWrites(writes.writes, after, history!.before).writes["fc.s.s1"]).toBe("");
    const changed = flowWrites({}, { ...blank, strokes: [{ ...stroke, color: "#3370FF" }] });
    expect(flowIntentWrites(changed, after, history!.before).conflicts).toContain("fc.s.s1");
  });
  it("preserves independent ink when an older graph updates nodes", () => {
    const withInk = flowWrites({}, { ...blank, strokes: [stroke] });
    const oldClient = { ...blank, nodes: [{ id: "n1", shape: "rect" as const, text: "A", x: 0, y: 0, w: 100, h: 60 }] };
    const intent = flowIntentWrites(withInk, blank, oldClient);
    expect(intent.writes["fc.s.s1"]).toBeUndefined();
    expect(readFlow({ ...withInk, ...intent.writes }).strokes).toEqual([stroke]);
  });
  it("moves selected ink and nodes together without exceeding bounds or changing other objects", () => {
    const node = { id: "n1", shape: "rect" as const, text: "A", x: 0, y: 0, w: 100, h: 60 };
    const nearEdge = { ...stroke, points: [{ x: 19990, y: 20 }, { x: 19998, y: 80 }] };
    const other = { ...stroke, id: "s2" };
    const graph: FlowGraph = { ...blank, nodes: [node], strokes: [nearEdge, other] };
    const next = moveFlowSelection(graph, new Set(["n1", "s1"]), 50, -10);
    expect(next.nodes[0].x).toBe(2);
    expect(next.strokes?.[0].points).toEqual([{ x: 19992, y: 10 }, { x: 20000, y: 70 }]);
    expect(next.strokes?.[1]).toEqual(other);
    const undo = flowIntentWrites(flowWrites({}, next), next, graph);
    expect(Object.keys(undo.writes).sort()).toEqual(["fc.n.n1", "fc.s.s1"]);
    const fractional = { ...graph, nodes: [{ ...node, x: 19999.4 }], strokes: [] };
    expect(moveFlowSelection(fractional, new Set(["n1"]), 1, 0).nodes[0].x).toBe(19999.4);
  });
  it("detects swept eraser intersections without deleting nearby unrelated ink", () => {
    const line = { ...stroke, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    expect(inkHitByEraser(line, { x: 50, y: -30 }, { x: 50, y: 30 }, 2)).toBe(true);
    expect(inkHitByEraser(line, { x: 50, y: 20 }, { x: 80, y: 20 }, 2)).toBe(false);
    expect(inkHitByEraser({ ...line, points: [{ x: 2, y: 2 }] }, { x: 0, y: 0 }, { x: 5, y: 5 }, 1)).toBe(true);
    expect(inkHitByEraser(line, { x: 110, y: 0 }, { x: 120, y: 0 }, 2)).toBe(false);
  });
  it("scales a stroke uniformly and clamps it at canvas boundaries", () => {
    const near = { ...stroke, points: [{ x: 19900, y: 20 }, { x: 19950, y: 70 }] };
    expect(scaleInk(near, 4).points).toEqual([{ x: 19900, y: 20 }, { x: 20000, y: 120 }]);
    expect(scaleInk(near, 0.01).points).toEqual([{ x: 19900, y: 20 }, { x: 19905, y: 25 }]);
    expect(scaleInk({ ...stroke, points: [{ x: 3, y: 4 }] }, 2).points).toEqual([{ x: 3, y: 4 }]);
    expect(scaleInk({ ...stroke, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, 0.1).points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  });
  it("keeps a remotely changed stroke when erasing and records only applied removals", () => {
    const second = { ...stroke, id: "s2" };
    const base = { ...blank, strokes: [stroke, second] };
    const remote = { ...blank, strokes: [{ ...stroke, color: "#3370FF" }, second] };
    const props = flowWrites({}, remote);
    const erase = flowIntentWrites(props, base, { ...blank, strokes: [] });
    expect(erase.conflicts).toEqual(["fc.s.s1"]);
    expect(erase.writes["fc.s.s2"]).toBe("");
    const after = readFlow({ ...props, ...erase.writes });
    const step = appliedFlowHistory(base, after, Object.keys(erase.writes))!;
    const undo = flowIntentWrites(flowWrites({}, after), step.after, step.before);
    const restored = readFlow({ ...flowWrites({}, after), ...undo.writes });
    expect(restored.strokes?.map((s) => [s.id, s.color])).toEqual([["s1", "#3370FF"], ["s2", "#1F2329"]]);
  });
});

describe("highlighter compatibility", () => {
  const blank: FlowGraph = { nodes: [], edges: [], theme: "feishu" };
  const marker = { id: "smarker", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], color: "#FFEE24", width: 20, marker: true as const };
  it("retains marker style through creation, old-client stroke updates, erase and undo", () => {
    const created = flowIntentWrites({}, blank, { ...blank, strokes: [marker] });
    expect(created.writes["fc.marker.smarker"]).toBe("1");
    let props = created.writes;
    expect(readFlow(props).strokes).toEqual([marker]);
    // An older client rewrites the original stroke JSON without knowing the marker key.
    props = { ...props, "fc.s.smarker": JSON.stringify({ points: [{ x: 1, y: 1 }, { x: 101, y: 1 }], color: marker.color, width: marker.width }) };
    const moved = readFlow(props);
    expect(moved.strokes?.[0].marker).toBe(true);
    const erased = flowIntentWrites(props, moved, { ...blank, strokes: [] });
    expect(erased.writes["fc.s.smarker"]).toBe("");
    expect(erased.writes["fc.marker.smarker"]).toBeUndefined();
    props = { ...props, ...erased.writes };
    const undo = flowIntentWrites(props, readFlow(props), moved);
    expect(readFlow({ ...props, ...undo.writes }).strokes).toEqual(moved.strokes);
  });
  it("rejects stale or malformed marker metadata and preserves unrelated strokes", () => {
    const graph = { ...blank, strokes: [marker] };
    const props = flowWrites({}, graph);
    const moved = { ...graph, strokes: [{ ...marker, points: [{ x: 10, y: 10 }] }] };
    expect(flowIntentWrites({ ...props, "fc.marker.smarker": "future" }, graph, moved).conflicts).toContain("fc.s.smarker");
    expect(flowIntentWrites({ ...props, "fc.marker.smarker": "" }, graph, moved).conflicts).toContain("fc.s.smarker");
    const replacement = { ...blank, strokes: [{ ...marker, marker: undefined }] };
    expect(flowIntentWrites(props, graph, replacement).conflicts).toContain("fc.s.smarker");
    expect(flowIntentWrites({ ...props, "fc.s.smarker": "" }, blank, replacement).conflicts).toContain("fc.s.smarker");
    expect(readFlow(props).strokes).toEqual([marker]);
  });
});

describe("multi-selection proportional scaling", () => {
  it("computes combined bounds and uniformly scales mixed nodes and ink strokes", () => {
    const nodes = [
      { id: "n1", shape: "rect" as const, text: "A", x: 100, y: 100, w: 120, h: 60, size: 14 },
      { id: "n2", shape: "ellipse" as const, text: "B", x: 260, y: 180, w: 80, h: 40 },
    ];
    const strokes = [
      { id: "s1", points: [{ x: 100, y: 200 }, { x: 200, y: 300 }], color: "#1F2329", width: 4 },
      { id: "s2", points: [{ x: 220, y: 200 }, { x: 320, y: 250 }], color: "#3370FF", width: 2 },
    ];
    const box = selectionBounds(nodes, strokes);
    expect(box).toEqual({ x: 100, y: 100, w: 240, h: 200 });

    const scaled = scaleSelectionProportionally(nodes, strokes, { x: box!.x, y: box!.y }, 1.5);
    expect(scaled.scale).toBe(1.5);
    expect(scaled.nodes[0]).toMatchObject({ x: 100, y: 100, w: 180, h: 90, size: 21 });
    expect(scaled.nodes[1]).toMatchObject({ x: 340, y: 220, w: 120, h: 60 });
    expect(scaled.strokes[0]).toMatchObject({
      width: 6,
      points: [{ x: 100, y: 250 }, { x: 250, y: 400 }],
    });
    expect(scaled.strokes[1]).toMatchObject({
      width: 3,
      points: [{ x: 280, y: 250 }, { x: 430, y: 325 }],
    });
  });

  it("clamps proportional scaling against node minimums and canvas boundary", () => {
    const small = [{ id: "n1", shape: "rect" as const, text: "S", x: 0, y: 0, w: 40, h: 32 }];
    const shrunk = scaleSelectionProportionally(small, [], { x: 0, y: 0 }, 0.1);
    expect(shrunk.scale).toBe(0.5);
    expect(shrunk.nodes[0]).toMatchObject({ w: 20, h: 16 });

    const nearEdge = [{ id: "s1", points: [{ x: 19900, y: 0 }, { x: 19950, y: 50 }], color: "#000000", width: 2 }];
    const clamped = scaleSelectionProportionally([], nearEdge, { x: 19900, y: 0 }, 5);
    expect(clamped.scale).toBe(2);
    expect(clamped.strokes[0].points).toEqual([{ x: 19900, y: 0 }, { x: 20000, y: 100 }]);
  });
});
