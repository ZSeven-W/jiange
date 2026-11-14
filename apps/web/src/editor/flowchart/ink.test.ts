import { describe, expect, it } from "vitest";
import { flowBounds, flowIntentWrites, flowWrites, moveFlowSelection, normalizeStroke, readFlow, type FlowGraph } from "./model";
import { appliedFlowHistory } from "./history";
import { describeUnappliedFlows } from "./recovery";
import { inkHitByEraser, scaleInk } from "./inkGeometry";

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
    expect(describeUnappliedFlows([{ before: after, proposed: history!.before, conflicts: ["fc.s.s1"] }])).toContain("删除笔迹");
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
