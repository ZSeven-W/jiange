import { describe, expect, it } from "vitest";
import {
  autoLayout,
  autoPorts,
  boundedFlowOffset,
  bounds,
  edgePath,
  flowBounds,
  flowWrites,
  midIsY,
  moveFlowSelection,
  newFlowId,
  normalizeNode,
  readFlow,
  textArea,
  toMermaid,
  type FlowGraph,
  type FlowNode,
} from "../src/model.js";
const sample: FlowGraph = {
  theme: "classic",
  nodes: [
    { id: "a", shape: "terminator", text: "开始", x: 0, y: 0, w: 120, h: 50 },
    { id: "b", shape: "diamond", text: "通过？", x: 0, y: 120, w: 140, h: 90 },
    { id: "c", shape: "rect", text: "结束", x: 0, y: 280, w: 120, h: 50 },
  ],
  edges: [{ id: "e1", from: "a", to: "b" }, { id: "e2", from: "b", to: "c", label: "是" }],
};

describe("layout, routing and export", () => {
  it("lays out ranks top-to-bottom and survives cycles", () => {
    const cyc = { ...sample, edges: [...sample.edges, { id: "e3", from: "c", to: "a" }] };
    const out = autoLayout(cyc);
    const y = Object.fromEntries(out.nodes.map((n) => [n.id, n.y]));
    expect(y.a).toBeLessThan(y.b);
    expect(y.b).toBeLessThan(y.c);
  });
  it("routes orthogonal edges and writes Mermaid", () => {
    const { d } = edgePath(sample.edges[0], sample.nodes[0], sample.nodes[1]);
    expect(d.startsWith("M60,50")).toBe(true);
    const m = toMermaid(sample);
    expect(m).toContain('N1(["开始"])');
    expect(m).toContain('N2 -->|"是"| N3');
  });
});


describe("image nodes", () => {
  it("keeps a positive file id only on image nodes", () => {
    expect(normalizeNode({ id: "i", shape: "image", fileId: 12 })?.fileId).toBe(12);
    expect(normalizeNode({ id: "i", shape: "image", fileId: -1 })?.fileId).toBeUndefined();
    expect(normalizeNode({ id: "i", shape: "image", fileId: "12" })?.fileId).toBeUndefined();
    expect(normalizeNode({ id: "r", shape: "rect", fileId: 12 })?.fileId).toBeUndefined();
    const g: FlowGraph = { theme: "feishu", nodes: [{ id: "i", shape: "image", text: "", fileId: 5, x: 0, y: 0, w: 100, h: 80 }], edges: [] };
    expect(readFlow(flowWrites({}, g)).nodes[0].fileId).toBe(5);
    expect(toMermaid(g)).toContain("图片");
  });
});

describe("edge geometry", () => {
  const left = { id: "left", shape: "rect" as const, text: "", x: 0, y: 0, w: 100, h: 40 };
  const right = { ...left, id: "right", x: 300 };

  it("keeps endpoints on their shapes for straight and curved connections", () => {
    const straight = edgePath({ id: "e", from: "left", to: "right", kind: "straight" }, left, right);
    expect(straight).toMatchObject({ start: { x: 100, y: 20 }, end: { x: 300, y: 20 }, mid: { x: 200, y: 20 } });
    expect(straight.d).toBe("M100,20 L300,20");
    const curve = edgePath({ id: "e", from: "left", to: "right", kind: "curve" }, left, right);
    expect(curve.start).toEqual(straight.start);
    expect(curve.end).toEqual(straight.end);
    expect(curve.d).toContain(" C");
  });

  it("routes straight and curved paths through explicit waypoints", () => {
    const waypoint = { x: 180, y: 100 };
    const straight = edgePath({ id: "e", from: "left", to: "right", kind: "straight", pts: [waypoint] }, left, right);
    const curve = edgePath({ id: "e", from: "left", to: "right", kind: "curve", pts: [waypoint] }, left, right);
    expect(straight.d).toContain(" L180,100");
    expect(curve.d).toContain("180,100");
    for (const path of [straight, curve]) {
      expect(Number.isFinite(path.mid.x)).toBe(true);
      expect(Number.isFinite(path.mid.y)).toBe(true);
    }
  });

  it("rotates a node port and limits long labels", async () => {
    const { measureLabel, portPoint, worldSide } = await import("../src/model.js");
    const rotated = { ...left, rot: 90 };
    expect(portPoint(rotated, "top")).toEqual({ x: 70, y: 20 });
    expect(worldSide(rotated, "top")).toBe("right");
    expect(measureLabel("中文", 20)).toBe(60);
    expect(measureLabel("a".repeat(100), 20)).toBe(360);
  });

  it("computes textArea for container/UML shapes, generates unique ids, and handles empty bounds & movement edge cases", () => {
    const baseNode = (shape: FlowNode["shape"]): FlowNode => ({ id: "n", shape, text: "T", x: 10, y: 20, w: 200, h: 100 });
    expect(textArea(baseNode("swimlane"))).toEqual({ x: 10, y: 20, w: 32, h: 100, vertical: true });
    expect(textArea(baseNode("swimlaneV"))).toEqual({ x: 10, y: 20, w: 200, h: 36 });
    expect(textArea(baseNode("class"))).toEqual({ x: 10, y: 20, w: 200, h: 32 });
    expect(textArea(baseNode("actor"))).toEqual({ x: -20, y: 100, w: 260, h: 20 });
    expect(textArea(baseNode("lifeline"))).toEqual({ x: 10, y: 20, w: 200, h: 44 });
    expect(textArea(baseNode("rect"))).toEqual({ x: 10, y: 20, w: 200, h: 100 });

    const ids = new Set([newFlowId("n"), newFlowId("e"), newFlowId("s"), newFlowId("m")]);
    expect(ids.size).toBe(4);
    expect([...ids].map((id) => id[0])).toEqual(["n", "e", "s", "m"]);

    // Empty bounds, empty stroke points, non-finite offsets, and selection moves without strokes
    expect(bounds([])).toEqual({ x: 0, y: 0, w: 400, h: 240 });
    expect(flowBounds({ nodes: [], edges: [], strokes: [{ id: "s0", points: [], color: "#000000", width: 2 }], theme: "feishu" })).toEqual({ x: 0, y: 0, w: 400, h: 240 });
    expect(boundedFlowOffset([], [], Number.NaN, Infinity)).toEqual({ x: 0, y: 0 });

    const twoNodes: FlowGraph = {
      theme: "feishu",
      nodes: [
        { id: "a", shape: "rect", text: "A", x: 0, y: 0, w: 100, h: 40 },
        { id: "b", shape: "rect", text: "B", x: 200, y: 0, w: 100, h: 40 },
      ],
      edges: [],
    };
    expect(moveFlowSelection(twoNodes, new Set(["missing"]), 10, 10)).toBe(twoNodes);
    const movedA = moveFlowSelection(twoNodes, new Set(["a"]), 15, 25);
    expect(movedA.nodes[0]).toMatchObject({ x: 15, y: 25 });
    expect(movedA.nodes[1]).toEqual(twoNodes.nodes[1]);
    expect(movedA.strokes).toBeUndefined();
  });

  it("covers autoPorts directions, midIsY, orthogonal waypoints, zero-length polylines, autoLayout dangling/multi-child, and all Mermaid arrows", () => {
    const topNode: FlowNode = { id: "t", shape: "rect", text: "", x: 0, y: 0, w: 100, h: 40 };
    const bottomNode: FlowNode = { id: "b", shape: "rect", text: "", x: 0, y: 200, w: 100, h: 40 };
    const rightNode: FlowNode = { id: "r", shape: "rect", text: "", x: 300, y: 0, w: 100, h: 40 };

    expect(autoPorts(bottomNode, topNode)).toEqual(["top", "bottom"]);
    expect(autoPorts(rightNode, topNode)).toEqual(["left", "right"]);
    expect(midIsY({ id: "e1", from: "t", to: "b" }, topNode, bottomNode)).toBe(true);
    expect(midIsY({ id: "e2", from: "t", to: "r", fromPort: "right" }, topNode, rightNode)).toBe(false);

    // Orthogonal waypoints: diagonal legs (both vertical and horizontal) + axis-aligned horizontal and vertical legs
    const orthoDiag = edgePath(
      { id: "eo", from: "t", to: "r", fromPort: "bottom", toPort: "left", pts: [{ x: 50, y: 120 }, { x: 180, y: 120 }, { x: 240, y: 60 }] },
      topNode,
      rightNode,
    );
    expect(orthoDiag.d).toContain("L50,120");
    expect(orthoDiag.d).toContain("L180,120");

    // Midpoint falling in the very last segment (short first segment, very long last segment)
    const longLast = edgePath(
      { id: "el", from: "t", to: "r", kind: "straight", fromPort: "right", toPort: "left", pts: [{ x: 105, y: 20 }] },
      topNode,
      rightNode,
    );
    expect(longLast.mid.x).toBeGreaterThan(150);

    // Zero-length polyline hits lens[i] === 0 fallback in halfway
    const zeroNode: FlowNode = { id: "z", shape: "rect", text: "", x: 0, y: 0, w: 0, h: 0 };
    const zeroPath = edgePath({ id: "ez", from: "z", to: "z", kind: "straight", pts: [{ x: 0, y: 0 }] }, zeroNode, zeroNode);
    expect(zeroPath.mid).toEqual({ x: 0, y: 0 });

    // autoLayout with self-loop, dangling edge, and multi-node layer sorted by parent average position
    const layoutGraph: FlowGraph = {
      theme: "feishu",
      nodes: [
        { id: "p1", shape: "rect", text: "P1", x: 0, y: 0, w: 100, h: 40 },
        { id: "p2", shape: "rect", text: "P2", x: 0, y: 0, w: 100, h: 40 },
        { id: "c1", shape: "rect", text: "C1", x: 0, y: 0, w: 100, h: 40 },
        { id: "c2", shape: "rect", text: "C2", x: 0, y: 0, w: 100, h: 40 },
      ],
      edges: [
        { id: "e_self", from: "p1", to: "p1" },
        { id: "e_dangle", from: "p1", to: "missing" },
        { id: "e1", from: "p1", to: "c1" },
        { id: "e2", from: "p2", to: "c2" },
        { id: "e3", from: "p1", to: "c2" },
      ],
    };
    const laid = autoLayout(layoutGraph, { direction: "TB" });
    expect(laid.nodes).toHaveLength(4);

    // toMermaid with empty node/mind texts and all 6 arrow/dashed combinations
    const mermaid = toMermaid({
      theme: "feishu",
      nodes: [
        { id: "a", shape: "rect", text: "", x: 0, y: 0, w: 100, h: 40 },
        { id: "b", shape: "rect", text: "B", x: 200, y: 0, w: 100, h: 40 },
      ],
      edges: [
        { id: "e1", from: "a", to: "b", arrow: "none", dashed: true },
        { id: "e2", from: "a", to: "b", arrow: "none", dashed: false },
        { id: "e3", from: "a", to: "b", arrow: "both", dashed: true },
        { id: "e4", from: "a", to: "b", arrow: "both", dashed: false },
        { id: "e5", from: "a", to: "b", dashed: true },
        { id: "e6", from: "a", to: "b", dashed: false },
      ],
      mind: [{ id: "m1", parent: null, order: 0, text: "", x: 0, y: 0 }],
    });
    expect(mermaid).toContain('N1[" "]');
    expect(mermaid).toContain('M1[" "]');
    expect(mermaid).toContain(" -.- ");
    expect(mermaid).toContain(" --- ");
    expect(mermaid).toContain(" <-.-> ");
    expect(mermaid).toContain(" <--> ");
    expect(mermaid).toContain(" -.-> ");
    expect(mermaid).toContain(" --> ");
  });
});
