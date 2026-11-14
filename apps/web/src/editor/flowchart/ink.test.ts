import { describe, expect, it } from "vitest";
import { flowBounds, flowIntentWrites, flowWrites, moveFlowSelection, normalizeStroke, readFlow, type FlowGraph } from "./model";
import { appliedFlowHistory } from "./history";
import { describeUnappliedFlows } from "./recovery";

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
});
