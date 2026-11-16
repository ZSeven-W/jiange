import { describe, expect, it } from "vitest";
import { autoLayout, edgePath, flowWrites, normalizeNode, readFlow, toMermaid, type FlowGraph } from "../src/model.js";
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
});
