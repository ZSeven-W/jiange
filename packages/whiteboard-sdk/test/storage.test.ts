import { describe, expect, it } from "vitest";
import { flowIntentWrites, flowWrites, normalizeNode, readFlow, type FlowGraph } from "../src/model.js";
const sample: FlowGraph = {
  theme: "classic",
  nodes: [
    { id: "a", shape: "terminator", text: "开始", x: 0, y: 0, w: 120, h: 50 },
    { id: "b", shape: "diamond", text: "通过？", x: 0, y: 120, w: 140, h: 90 },
    { id: "c", shape: "rect", text: "结束", x: 0, y: 280, w: 120, h: 50 },
  ],
  edges: [{ id: "e1", from: "a", to: "b" }, { id: "e2", from: "b", to: "c", label: "是" }],
};

describe("flowchart storage", () => {
  it("writes only local intent after a peer changes or adds other objects", () => {
    const base = readFlow(flowWrites({}, sample));
    const remote = { ...base, nodes: [...base.nodes.map((n) => n.id === "b" ? { ...n, text: "远程修改" } : n), { id: "new", shape: "rect" as const, text: "远程新增", x: 400, y: 0, w: 100, h: 50 }], edges: [...base.edges, { id: "new-edge", from: "b", to: "new" }] };
    const props = flowWrites({}, remote);
    const next = { ...base, nodes: base.nodes.map((n) => n.id === "a" ? { ...n, x: 50 } : n) };
    const result = flowIntentWrites(props, base, next);
    expect(Object.keys(result.writes)).toEqual(["fc.n.a"]);
    expect(result.conflicts).toEqual([]);
    const merged = readFlow({ ...props, ...result.writes });
    expect(merged.nodes.find((n) => n.id === "a")?.x).toBe(50);
    expect(merged.nodes.find((n) => n.id === "b")?.text).toBe("远程修改");
    expect(merged.nodes.some((n) => n.id === "new")).toBe(true);
    expect(merged.edges.some((e) => e.id === "new-edge")).toBe(true);
  });

  it("rejects stale edits to a changed or deleted object", () => {
    const base = readFlow(flowWrites({}, sample));
    const next = { ...base, nodes: base.nodes.map((n) => n.id === "a" ? { ...n, text: "我的输入" } : n) };
    const remote = { ...base, nodes: base.nodes.map((n) => n.id === "a" ? { ...n, text: "他人输入" } : n) };
    const props = flowWrites({}, remote);
    expect(flowIntentWrites(props, base, next)).toEqual({ writes: {}, conflicts: ["fc.n.a"] });
    expect(flowIntentWrites({ ...props, "fc.n.a": "" }, base, next)).toEqual({ writes: {}, conflicts: ["fc.n.a"] });
  });

  it("does not delete a node and its edges when a peer adds a connection", () => {
    const base = readFlow(flowWrites({}, sample));
    const next = { ...base, nodes: base.nodes.filter((n) => n.id !== "b"), edges: base.edges.filter((e) => e.from !== "b" && e.to !== "b") };
    const remote = { ...base, edges: [...base.edges, { id: "remote", from: "a", to: "b" }] };
    const result = flowIntentWrites(flowWrites({}, remote), base, next);
    expect(result.writes).toEqual({});
    expect(result.conflicts).toContain("fc.n.b");
    expect(result.conflicts).toContain("fc.e.e1");
  });

  it("keeps linked nodes when a multi-delete conflicts on one endpoint", () => {
    const base = readFlow(flowWrites({}, sample));
    const proposed = { ...base, nodes: base.nodes.filter((n) => n.id === "c"), edges: [] };
    const live = { ...base, nodes: base.nodes.map((n) => n.id === "b" ? { ...n, text: "同事修改" } : n) };
    const result = flowIntentWrites(flowWrites({}, live), base, proposed);
    expect(result.writes).toEqual({});
    expect(result.conflicts).toEqual(expect.arrayContaining(["fc.n.a", "fc.n.b", "fc.e.e1", "fc.e.e2"]));
  });

  it("applies undo without removing a peer's later changes", () => {
    const before = readFlow(flowWrites({}, sample));
    const after = { ...before, nodes: before.nodes.map((n) => n.id === "a" ? { ...n, x: 80 } : n) };
    const live = { ...after, nodes: [...after.nodes, { id: "peer", shape: "rect" as const, text: "同事", x: 10, y: 10, w: 100, h: 50 }] };
    const props = flowWrites({}, live);
    const result = flowIntentWrites(props, after, before);
    expect(Object.keys(result.writes)).toEqual(["fc.n.a"]);
    expect(readFlow({ ...props, ...result.writes }).nodes.some((n) => n.id === "peer")).toBe(true);
  });

  it("preserves malformed untouched props and refuses edges to deleted nodes", () => {
    const base = readFlow(flowWrites({}, sample));
    const added = { ...base, edges: [...base.edges, { id: "local", from: "a", to: "c" }] };
    const props = { ...flowWrites({}, base), "fc.n.c": "", "fc.n.broken": "{bad" };
    const result = flowIntentWrites(props, base, added);
    expect(result.writes).toEqual({});
    expect(result.conflicts).toEqual(["fc.e.local"]);
  });

  it("does not attach a local edge to a peer's conflicting node id", () => {
    const base = readFlow(flowWrites({}, sample));
    const mine = { id: "same", shape: "rect" as const, text: "我的节点", x: 300, y: 0, w: 100, h: 50 };
    const peer = { ...mine, text: "同事节点" };
    const proposed = { ...base, nodes: [...base.nodes, mine], edges: [...base.edges, { id: "link", from: "a", to: "same" }] };
    const live = { ...base, nodes: [...base.nodes, peer] };
    const result = flowIntentWrites(flowWrites({}, live), base, proposed);
    expect(result.writes).toEqual({});
    expect(result.conflicts).toEqual(["fc.n.same", "fc.e.link"]);
  });

  it("applies an independent local change while preserving a conflicting one", () => {
    const base = readFlow(flowWrites({}, sample));
    const proposed = { ...base, nodes: base.nodes.map((n) => n.id === "a" ? { ...n, text: "本地" } : n.id === "c" ? { ...n, x: 40 } : n) };
    const live = { ...base, nodes: base.nodes.map((n) => n.id === "a" ? { ...n, text: "远程" } : n) };
    const result = flowIntentWrites(flowWrites({}, live), base, proposed);
    expect(Object.keys(result.writes)).toEqual(["fc.n.c"]);
    expect(result.conflicts).toEqual(["fc.n.a"]);
  });
  it("round-trips through per-object props and only writes what changed", () => {
    const first = flowWrites({}, sample);
    expect(Object.keys(first).filter((k) => k.startsWith("fc.n.")).length).toBe(3);
    const props = { ...first };
    expect(readFlow(props).nodes.map((n) => n.text).sort()).toEqual(["开始", "结束", "通过？"].sort());
    expect(readFlow(props).edges.map((e) => e.label ?? "")).toEqual(["", "是"]);
    const moved = { ...sample, nodes: sample.nodes.map((n) => (n.id === "c" ? { ...n, x: 300 } : n)) };
    expect(Object.keys(flowWrites(props, moved))).toEqual(["fc.n.c"]);
    const removed = { ...sample, nodes: sample.nodes.filter((n) => n.id !== "c"), edges: sample.edges.filter((e) => e.to !== "c") };
    expect(flowWrites(props, removed)).toEqual({ "fc.n.c": "", "fc.e.e2": "" });
  });
  it("rejects malformed objects and dangling edges", () => {
    expect(normalizeNode({ x: "1" }, "bad id!")).toBeNull();
    const g = readFlow({ "fc.n.a": '{"x":0,"y":0,"w":10,"h":10,"shape":"weird","text":"x","fill":"red"}', "fc.e.e": '{"from":"a","to":"missing"}', "fc.n.z": "not json" });
    expect(g.nodes[0]).toMatchObject({ shape: "rect", w: 20 });
    expect(g.nodes[0].fill).toBeUndefined();
    expect(g.edges).toEqual([]);
  });
});
