import { describe, expect, it } from "vitest";
import { flowIntentWrites, flowWrites, normalizeEdge, normalizeNode, normalizeStroke, readFlow, type FlowGraph } from "../src/model.js";
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

  it("normalizes edge cases for nodes, edges, strokes, and flowWrites tombstones/mind metadata", () => {
    expect(normalizeNode(null)).toBeNull();
    expect(normalizeNode({ x: 0 })).toBeNull();
    expect(normalizeNode({ id: "n1", color: "#112233" })?.color).toBe("#112233");

    expect(normalizeEdge(null)).toBeNull();
    expect(normalizeEdge({ from: "a", to: "b" })).toBeNull();
    expect(normalizeEdge({ id: "bad!", from: "a", to: "b" })).toBeNull();
    expect(normalizeEdge({ id: "e1", from: "a", to: "b", pts: [{ x: Number.NaN, y: 0 }] })?.pts).toBeUndefined();

    expect(normalizeStroke(null)).toBeNull();
    expect(normalizeStroke({ points: [{ x: 0, y: 0 }], color: "#000000", width: 2 })).toBeNull();

    // flowWrites with invalid objects (canonical returns null), corrupt stored props, tombstones, and all mind metadata maps
    const root = { id: "r", parent: null, order: 0, text: "Root", x: 0, y: 0 };
    const existingProps: Record<string, string> = {
      "fc.n.a": "{corrupt",
      "fc.n.empty": "",
      "fc.e.e1": "{corrupt",
      "fc.s.s1": "{corrupt",
      "fc.s.s_old": JSON.stringify({ points: [{ x: 0, y: 0 }], color: "#000000", width: 2 }),
      "fc.m.m_old": JSON.stringify({ parent: null, order: 0, text: "Old", x: 0, y: 0 }),
      "fc.mc.r": "1",
    };
    const nextGraph: FlowGraph = {
      theme: "feishu",
      nodes: [
        { id: "a", shape: "rect", text: "A", x: 0, y: 0, w: 100, h: 50 },
        { id: "bad!", shape: "rect", text: "Bad", x: 0, y: 0, w: 100, h: 50 },
      ],
      edges: [
        { id: "e1", from: "a", to: "a" },
        { id: "bad!", from: "a", to: "a" },
      ],
      strokes: [
        { id: "s1", points: [{ x: 0, y: 0 }], color: "#000000", width: 2 },
        { id: "bad!", points: [{ x: 0, y: 0 }], color: "#000000", width: 2 },
      ],
      mind: [root],
      mindCollapsed: [],
      mindStyles: { r: { size: 18 } },
      mindPaints: { r: { fill: "#ffffff" } },
      mindTextFormats: { r: { bold: true } },
      mindDescriptions: { r: "Desc" },
      mindDescriptionStyles: { r: { size: 14, color: "#112233" } },
    };
    const w = flowWrites(existingProps, nextGraph);
    expect(w["fc.s.s_old"]).toBe("");
    expect(w["fc.m.m_old"]).toBe("");
    expect(w["fc.mc.r"]).toBe("");
    expect(w["fc.ms.r"]).toBeTruthy();
    expect(w["fc.mp.r"]).toBeTruthy();
    expect(w["fc.mt.r"]).toBeTruthy();
    expect(w["fc.md.r"]).toBe(JSON.stringify("Desc"));
    expect(w["fc.mds.r"]).toBeTruthy();

    // flowWrites folding a topic from empty props (hits collapsed.has ? "1" and props[key] ?? "")
    expect(flowWrites({}, { theme: "feishu", nodes: [], edges: [], mind: [root], mindCollapsed: ["r"] })["fc.mc.r"]).toBe("1");

    // flowWrites when mind metadata maps are defined while next.mind is undefined (hits next.mind ?? [])
    expect(
      flowWrites(
        { "fc.v": "1", "fc.theme": "feishu" },
        {
          theme: "feishu",
          nodes: [],
          edges: [],
          mindCollapsed: [],
          mindStyles: {},
          mindPaints: {},
          mindTextFormats: {},
          mindDescriptions: {},
          mindDescriptionStyles: {},
        },
      ),
    ).toEqual({});
  });

  it("handles flowIntentWrites for edge conflicts, clean node/edge deletes, invalid base nodes, theme changes, and mindmap compound conflicts", () => {
    // Clean deletion of isolated node + edge edit + corrupt remote edge prop + invalid base node deletion conflict
    const isolated: FlowGraph = {
      theme: "classic",
      nodes: [
        { id: "a", shape: "rect", text: "A", x: 0, y: 0, w: 100, h: 50 },
        { id: "b", shape: "rect", text: "B", x: 200, y: 0, w: 100, h: 50 },
        { id: "iso", shape: "rect", text: "Iso", x: 400, y: 0, w: 100, h: 50 },
        { id: "bad!", shape: "rect", text: "InvalidBase", x: 0, y: 0, w: 100, h: 50 },
      ],
      edges: [
        { id: "e1", from: "a", to: "b", label: "old" },
        { id: "e2", from: "a", to: "b", label: "keep" },
      ],
    };
    const props: Record<string, string> = {
      ...flowWrites({}, { ...isolated, nodes: isolated.nodes.filter((n) => n.id !== "bad!") }),
      "fc.n.bad!": '{"shape":"rect"}',
      "fc.e.corrupt": "{bad",
      "fc.e.invalid": '{"from":"a"}',
      "fc.e.e2": JSON.stringify({ from: "a", to: "b", label: "remote" }),
    };
    const nextIso: FlowGraph = {
      theme: "dark",
      nodes: isolated.nodes.filter((n) => n.id !== "iso" && n.id !== "bad!"),
      edges: [
        { id: "e1", from: "a", to: "b", label: "new" },
        { id: "e2", from: "a", to: "b", label: "local" },
      ],
    };
    const res = flowIntentWrites(props, isolated, nextIso);
    expect(res.writes["fc.n.iso"]).toBe("");
    expect(res.writes["fc.e.e1"]).toBeTruthy();
    expect(res.writes["fc.theme"]).toBe("dark");
    expect(res.conflicts).toEqual(expect.arrayContaining(["fc.n.bad!", "fc.e.e2"]));

    // Clean deletion of an edge writes tombstone "" (L316 after ?? "")
    const delEdge = flowIntentWrites(props, isolated, { ...isolated, edges: isolated.edges.filter((e) => e.id !== "e1") });
    expect(delEdge.writes["fc.e.e1"]).toBe("");

    // Theme conflict (remote changed theme to minimal) and theme already matching next (no-op)
    expect(flowIntentWrites({ ...props, "fc.theme": "minimal" }, isolated, nextIso).conflicts).toContain("fc.theme");
    expect(flowIntentWrites({ ...props, "fc.theme": "dark" }, isolated, nextIso).writes["fc.theme"]).toBeUndefined();

    // Mindmap compound conflicts in flowIntentWrites:
    const root = { id: "r", parent: null, order: 0, text: "R", x: 0, y: 0 };
    const c1 = { id: "c1", parent: "r", order: 0, text: "C1" };
    const c2 = { id: "c2", parent: "r", order: 1, text: "C2" };
    const mindBase: FlowGraph = {
      theme: "feishu",
      nodes: [],
      edges: [],
      mind: [root, c1, c2],
      mindStyles: { c1: { size: 16 } },
      mindTextFormats: { c1: { bold: true } },
      mindDescriptions: { c1: "old" },
      mindDescriptionStyles: { c1: { size: 14 } },
    };
    const mindProps = flowWrites({}, mindBase);

    // 1. Atomic rollback of description + descriptionStyle when one conflicts
    const descBoth = flowIntentWrites(
      { ...mindProps, "fc.mds.c1": JSON.stringify({ size: 24 }) },
      mindBase,
      {
        ...mindBase,
        mindDescriptions: { c1: "new" },
        mindDescriptionStyles: { c1: { size: 18 } },
      },
    );
    expect(descBoth.writes["fc.md.c1"]).toBeUndefined();
    expect(descBoth.writes["fc.mds.c1"]).toBeUndefined();
    expect(descBoth.conflicts).toEqual(expect.arrayContaining(["fc.md.c1", "fc.mds.c1"]));

    // Single-sided description or descriptionStyle conflict with the other map omitted in `next`
    const descOnly = flowIntentWrites(
      { ...mindProps, "fc.md.c1": JSON.stringify("remote") },
      mindBase,
      { theme: "feishu", nodes: [], edges: [], mind: mindBase.mind, mindDescriptions: { c1: "local" } },
    );
    expect(descOnly.conflicts).toContain("fc.md.c1");
    const descStyleOnly = flowIntentWrites(
      { ...mindProps, "fc.mds.c1": JSON.stringify({ size: 24 }) },
      mindBase,
      { theme: "feishu", nodes: [], edges: [], mind: mindBase.mind, mindDescriptionStyles: { c1: { size: 18 } } },
    );
    expect(descStyleOnly.conflicts).toContain("fc.mds.c1");

    // 2. mindTextStyleIntent guard: skips missing ids, passes clean ids, rolls back on remote or corrupt text format
    const cleanTextStyle = flowIntentWrites(mindProps, mindBase, {
      ...mindBase,
      mindStyles: { c1: { size: 20 } },
      mindTextStyleIntent: ["missing", "c1"],
    });
    expect(cleanTextStyle.conflicts).toEqual([]);
    expect(cleanTextStyle.writes["fc.ms.c1"]).toBeTruthy();

    const blockedTextStyle = flowIntentWrites(
      { ...mindProps, "fc.mt.c1": "{corrupt" },
      mindBase,
      {
        ...mindBase,
        mindStyles: { c1: { size: 20 } },
        mindTextStyleIntent: ["c1"],
      },
    );
    expect(blockedTextStyle.writes["fc.ms.c1"]).toBeUndefined();
    expect(blockedTextStyle.conflicts).toContain("fc.mt.c1");

    const remoteDiffTextStyle = flowIntentWrites(
      { ...mindProps, "fc.mt.c1": JSON.stringify({ italic: true }) },
      mindBase,
      {
        ...mindBase,
        mindStyles: { c1: { size: 20 } },
        mindTextStyleIntent: ["c1"],
      },
    );
    expect(remoteDiffTextStyle.writes["fc.ms.c1"]).toBeUndefined();
    expect(remoteDiffTextStyle.conflicts).toContain("fc.mt.c1");

    // 3. New topic blocked by fc.mds. metadata (hits key.startsWith("fc.mds.") ? 7),
    //    existing topic reparented under blocked new topic (L382),
    //    blocked new root (L384 !parent continue),
    //    and reordered sibling under blocked child's parent (L386)
    const blockedAddedProps = {
      ...mindProps,
      "fc.mds.newp": '{"bad":1}',
      "fc.ms.newroot": '{"bad":1}',
    };
    const blockedAddedNext: FlowGraph = {
      ...mindBase,
      mind: [
        root,
        { id: "newroot", parent: null, order: 1, text: "NewRoot", x: 0, y: 200 },
        { id: "newp", parent: "r", order: 2, text: "NewParent" },
        { ...c1, parent: "newp", order: 0 },
        { ...c2, order: 5 },
      ],
    };
    const blockedAdded = flowIntentWrites(blockedAddedProps, mindBase, blockedAddedNext);
    expect(blockedAdded.writes["fc.m.newp"]).toBeUndefined();
    expect(blockedAdded.writes["fc.m.newroot"]).toBeUndefined();
    expect(blockedAdded.writes["fc.m.c1"]).toBeUndefined();
    expect(blockedAdded.writes["fc.m.c2"]).toBeUndefined();
    expect(blockedAdded.conflicts).toEqual(expect.arrayContaining(["fc.m.newp", "fc.m.newroot", "fc.m.c1", "fc.m.c2"]));
  });
});
