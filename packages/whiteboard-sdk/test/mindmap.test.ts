import { describe, expect, it } from "vitest";
import { flowIntentWrites, flowWrites, readFlow, toMermaid, type FlowGraph } from "../src/model.js";
import { appliedFlowHistory } from "../src/history.js";
import {
  canonicalMindDescription,
  canonicalMindDescriptionStyle,
  canonicalMindPaint,
  canonicalMindStyle,
  canonicalMindTextFormat,
  canonicalMindTopic,
  layoutMindTopics,
  mindCollapseIntent,
  mindDefaultTextColor,
  mindDescriptionIntent,
  mindDescriptionLines,
  mindDescriptionStyleIntent,
  mindIntentWrites,
  mindPaintIntent,
  mindStyleIntent,
  mindTextFormatIntent,
  normalizeMindDescriptionStyle,
  normalizeMindPaint,
  normalizeMindStyle,
  normalizeMindTextFormat,
  normalizeMindTopic,
  readMindDescriptionStyles,
  readMindDescriptions,
  readMindPaints,
  readMindStyles,
  readMindTextFormats,
  readMindTopics,
  type MindTopic,
} from "../src/mindmap.js";

const blank: FlowGraph = { nodes: [], edges: [], theme: "feishu" };
const root: MindTopic = { id: "r", parent: null, order: 0, text: "主题", x: 10, y: 20 };
const child: MindTopic = { id: "c", parent: "r", order: 0, text: "分支" };

describe("mind map persistence", () => {
  it("round trips a rooted tree and lays out siblings without overlap", () => {
    const graph = { ...blank, mind: [root, child, { id: "d", parent: "r", order: 1, text: "第二项" }] };
    const saved = readFlow(flowWrites({}, graph));
    expect(saved.mind).toHaveLength(3);
    const positions = layoutMindTopics(saved.mind!);
    const a = positions.find((x) => x.topic.id === "c")!, b = positions.find((x) => x.topic.id === "d")!;
    expect(a.x).toBeGreaterThan(positions.find((x) => x.topic.id === "r")!.x);
    expect(a.y + a.h).toBeLessThan(b.y);
    expect(normalizeMindTopic({ ...root, x: Infinity })).toBeNull();
    const exported = toMermaid(saved);
    expect(exported).toContain("主题"); expect(exported).toContain("分支"); expect(exported).toMatch(/M\d+ --- M\d+/);
  });
  it("orders fractional siblings and rejects malformed or cyclic topics", () => {
    const nodes = [root, { ...child, order: 0 }, { id: "between", parent: "r", order: 0.5, text: "中间" }, { id: "last", parent: "r", order: 1, text: "末尾" }];
    const positions = layoutMindTopics(readFlow(flowWrites({}, { ...blank, mind: nodes })).mind!);
    expect(positions.filter((item) => item.topic.parent === "r").map((item) => item.topic.id)).toEqual(["c", "between", "last"]);
    expect(normalizeMindTopic({ ...child, order: Number.NaN })).toBeNull();
    const cyclic = { ...blank, mind: [{ id: "a", parent: "b", order: 0, text: "" }, { id: "b", parent: "a", order: 0, text: "" }] };
    expect(flowIntentWrites({}, blank, cyclic).conflicts).toHaveLength(2);
  });
  it("keeps independent remote edits and protects a parent from a concurrent child", () => {
    const before = { ...blank, mind: [root, child] };
    const remote = { ...blank, mind: [root, child, { id: "remote", parent: "r", order: 2, text: "远端" }] };
    const props = flowWrites({}, remote);
    const removingRoot = flowIntentWrites(props, before, { ...blank, mind: [] });
    expect(removingRoot.conflicts).toContain("fc.m.r");
    expect(removingRoot.writes["fc.m.r"]).toBeUndefined();
    expect(removingRoot.conflicts).toContain("fc.m.c");
    expect(removingRoot.writes["fc.m.c"]).toBeUndefined();
    const edit = flowIntentWrites(props, before, { ...blank, mind: [root, { ...child, text: "本地" }] });
    expect(edit.conflicts).toEqual([]);
    expect(readFlow({ ...props, ...edit.writes }).mind?.find((x) => x.id === "remote")?.text).toBe("远端");
  });
  it("rejects missing parents, excessive depth and node counts without partial inserts", () => {
    const orphan = { id: "orphan", parent: "missing", order: 0, text: "" };
    expect(flowIntentWrites({}, blank, { ...blank, mind: [orphan] }).conflicts).toContain("fc.m.orphan");
    const chain: MindTopic[] = [root];
    for (let i = 1; i <= 32; i++) chain.push({ id: `depth${i}`, parent: i === 1 ? "r" : `depth${i-1}`, order: 0, text: "" });
    const base = { ...blank, mind: chain }, props = flowWrites({}, base);
    const deep = { id: "tooDeep", parent: "depth32", order: 0, text: "" };
    expect(flowIntentWrites(props, base, { ...base, mind: [...chain, deep] }).conflicts).toContain("fc.m.tooDeep");
    const many: MindTopic[] = [root, ...Array.from({ length: 499 }, (_, i) => ({ id: `x${i}`, parent: "r", order: i, text: "" }))];
    const manyBase = { ...blank, mind: many }, extra = { id: "extra", parent: "r", order: 500, text: "" };
    expect(flowIntentWrites(flowWrites({}, manyBase), manyBase, { ...manyBase, mind: [...many, extra] }).conflicts).toContain("fc.m.extra");
  });
  it("refuses stale or malformed topics and supports undo without deleting unrelated trees", () => {
    const target = { ...blank, mind: [root, child] }, created = flowIntentWrites({}, blank, target);
    const after = readFlow(created.writes), step = appliedFlowHistory(blank, after, Object.keys(created.writes))!;
    expect(step.before.mind).toEqual([]);
    const undo = flowIntentWrites(created.writes, after, step.before);
    expect(undo.writes["fc.m.c"]).toBe(""); expect(undo.writes["fc.m.r"]).toBe("");
    const changed = flowWrites({}, { ...blank, mind: [{ ...root, text: "远端" }, child] });
    const conflict = flowIntentWrites(changed, after, { ...blank, mind: [{ ...root, text: "本地" }, child] });
    expect(conflict.conflicts).toContain("fc.m.r");
    expect(flowIntentWrites({ ...created.writes, "fc.m.bad": "{" }, after, { ...blank, mind: [] }).conflicts).toContain("fc.m.r");
    expect(flowIntentWrites(created.writes, after, { ...blank, nodes: [], edges: [] }).writes["fc.m.r"]).toBeUndefined();
  });
});

describe("mind map folding", () => {
  const grandchild: MindTopic = { id: "g", parent: "c", order: 0, text: "详情" };
  const graph: FlowGraph = { ...blank, mind: [root, child, grandchild] };
  it("hides descendants without discarding them, and preserves fold flags across old text writes", () => {
    const props = flowWrites({}, graph);
    const folded = flowIntentWrites(props, graph, { ...graph, mindCollapsed: ["c"] });
    expect(folded.writes["fc.mc.c"]).toBe("1");
    const saved = readFlow({ ...props, ...folded.writes });
    expect(saved.mind).toHaveLength(3);
    expect(layoutMindTopics(saved.mind!, new Set(saved.mindCollapsed)).map((item) => item.topic.id)).toEqual(["r", "c"]);
    // A prior client edits only the topic JSON and leaves the separate fold flag intact.
    const oldEdit = flowWrites({}, { ...blank, mind: [{ ...root }, { ...child, text: "修改" }, grandchild] });
    const reopened = readFlow({ ...props, ...folded.writes, "fc.m.c": oldEdit["fc.m.c"] });
    expect(reopened.mindCollapsed).toEqual(["c"]);
    expect(reopened.mind?.find((item) => item.id === "c")?.text).toBe("修改");
  });
  it("supports undo of folds and deletion without reviving unrelated collapsed branches", () => {
    const props = flowWrites({}, graph), foldedIntent = flowIntentWrites(props, graph, { ...graph, mindCollapsed: ["c"] });
    const foldedProps = { ...props, ...foldedIntent.writes }, folded = readFlow(foldedProps);
    const foldHistory = appliedFlowHistory(graph, folded, Object.keys(foldedIntent.writes))!;
    expect(flowIntentWrites(foldedProps, folded, foldHistory.before).writes["fc.mc.c"]).toBe("");
    const deletion = flowIntentWrites(foldedProps, folded, { ...folded, mind: [root] });
    const deletedProps = { ...foldedProps, ...deletion.writes }, after = readFlow(deletedProps);
    const history = appliedFlowHistory(folded, after, Object.keys(deletion.writes))!;
    const undo = flowIntentWrites(deletedProps, after, history.before);
    const restored = readFlow({ ...deletedProps, ...undo.writes });
    expect(restored.mindCollapsed).toEqual(["c"]);
    expect(restored.mind?.map((item) => item.id)).toEqual(["c", "g", "r"]);
  });
  it("protects unknown fold metadata and does not undo a remote fold during an unrelated edit", () => {
    const props = flowWrites({}, graph);
    const bad = { ...props, "fc.mc.c": "future" };
    const attempt = flowIntentWrites(bad, graph, { ...graph, mindCollapsed: ["c"] });
    expect(attempt.conflicts).toContain("fc.mc.c");
    const remoteFold = { ...props, "fc.mc.c": "1" };
    const textChange = flowIntentWrites(remoteFold, graph, { ...graph, mind: [root, { ...child, text: "新文字" }, grandchild] });
    expect(textChange.conflicts).toEqual([]);
    expect(textChange.writes["fc.mc.c"]).toBeUndefined();
  });
  it("does not change a colliding remote topic's fold marker and rejects unknown markers on new ids", () => {
    const props = { ...flowWrites({}, graph), "fc.mc.c": "1" };
    const before = { ...blank, mind: [root] };
    const collision = flowIntentWrites(props, before, { ...before, mind: [root, { ...child, text: "不同的内容" }] });
    expect(collision.conflicts).toContain("fc.m.c");
    expect(collision.writes["fc.mc.c"]).toBeUndefined();
    const addition = flowIntentWrites({ ...flowWrites({}, before), "fc.mc.new": "future" }, before, { ...before, mind: [root, { id: "new", parent: "r", order: 0, text: "新节点" }] });
    expect(addition.conflicts).toContain("fc.mc.new");
    expect(addition.writes["fc.m.new"]).toBeUndefined();
  });
});

describe("mind map styles", () => {
  const graph: FlowGraph = { ...blank, mind: [root, child] };
  it("saves node shape, font size and color separately from text and supports undo", () => {
    const props = flowWrites({}, graph), proposed = { ...graph, mindStyles: { c: { shape: "oval" as const, size: 24, color: "#EE1122" } } };
    const intent = flowIntentWrites(props, graph, proposed), styledProps = { ...props, ...intent.writes }, styled = readFlow(styledProps);
    expect(styled.mindStyles?.c).toEqual({ shape: "oval", size: 24, color: "#ee1122" });
    expect(intent.writes["fc.m.c"]).toBeUndefined();
    const history = appliedFlowHistory(graph, styled, Object.keys(intent.writes))!;
    expect(flowIntentWrites(styledProps, styled, history.before).writes["fc.ms.c"]).toBe("");
    const oldClientEdit = flowWrites(styledProps, { ...graph, mind: [root, { ...child, text: "旧客户端" }] });
    expect(readFlow({ ...styledProps, ...oldClientEdit }).mindStyles?.c).toEqual(styled.mindStyles?.c);
  });
  it("preserves remote styles, rejects unknown metadata and restores deleted styled nodes", () => {
    const graphWithStyle = { ...graph, mindStyles: { c: { size: 24 } } }, props = flowWrites({}, graphWithStyle);
    const remoteProps = { ...props, "fc.ms.c": '{"size":36}' };
    const localText = { ...graphWithStyle, mind: [root, { ...child, text: "本地" }] };
    expect(flowIntentWrites(remoteProps, graphWithStyle, localText).writes["fc.ms.c"]).toBeUndefined();
    const localStyle = { ...graphWithStyle, mindStyles: { c: { size: 18 } } };
    expect(flowIntentWrites(remoteProps, graphWithStyle, localStyle).conflicts).toContain("fc.ms.c");
    expect(flowIntentWrites({ ...props, "fc.ms.c": '{"future":true}' }, graphWithStyle, localStyle).conflicts).toContain("fc.ms.c");
    const deleted = flowIntentWrites(props, graphWithStyle, { ...graphWithStyle, mind: [root] });
    const deletedProps = { ...props, ...deleted.writes }, after = readFlow(deletedProps), history = appliedFlowHistory(graphWithStyle, after, Object.keys(deleted.writes))!;
    const undo = flowIntentWrites(deletedProps, after, history.before);
    expect(readFlow({ ...deletedProps, ...undo.writes }).mindStyles?.c).toEqual({ size: 24 });
  });
  it("reserves room for large text and rejects a new id with unknown style metadata", () => {
    const sibling: MindTopic = { id: "s", parent: "r", order: 1, text: "其他" };
    const positions = layoutMindTopics([root, child, sibling], new Set(), { c: { size: 96 } });
    const big = positions.find((item) => item.topic.id === "c")!, other = positions.find((item) => item.topic.id === "s")!;
    expect(big.h).toBeGreaterThanOrEqual(96);
    expect(big.y + big.h).toBeLessThan(other.y);
    const addition = flowIntentWrites({ ...flowWrites({}, graph), "fc.ms.s": '{"unknown":true}' }, graph, { ...graph, mind: [root, child, sibling] });
    expect(addition.conflicts).toContain("fc.ms.s"); expect(addition.writes["fc.m.s"]).toBeUndefined();
  });
});

describe("mind map paint", () => {
  const sibling: MindTopic = { id: "s", parent: "r", order: 1, text: "同级" };
  const graph: FlowGraph = { ...blank, mind: [root, child, sibling], mindStyles: { c: { shape: "oval", size: 24 } } };
  it("persists fill and branch style independently from older clients and supports undo", () => {
    const props = flowWrites({}, graph), proposed: FlowGraph = { ...graph, mindPaints: { c: { fill: "#E1E9FF", fillOpacity: 70, stroke: "#E86D68", line: "dashed", width: 3, opacity: 80 } } };
    const intent = flowIntentWrites(props, graph, proposed), savedProps = { ...props, ...intent.writes }, saved = readFlow(savedProps);
    expect(saved.mindPaints?.c).toEqual({ fill: "#e1e9ff", fillOpacity: 70, stroke: "#e86d68", line: "dashed", width: 3, opacity: 80 });
    expect(intent.writes["fc.ms.c"]).toBeUndefined();
    const oldStyleEdit = flowIntentWrites(savedProps, graph, { ...graph, mindStyles: { c: { shape: "rect", size: 24 } } });
    expect(readFlow({ ...savedProps, ...oldStyleEdit.writes }).mindPaints?.c).toEqual(saved.mindPaints?.c);
    const history = appliedFlowHistory(graph, saved, Object.keys(intent.writes))!;
    expect(flowIntentWrites(savedProps, saved, history.before).writes["fc.mp.c"]).toBe("");
  });
  it("retains paint after delete and undo, and rejects unknown metadata on new ids", () => {
    const styled = { ...graph, mindPaints: { c: { fill: "none" } } }, props = flowWrites({}, styled);
    const deletion = flowIntentWrites(props, styled, { ...styled, mind: [root, sibling] }), deleted = { ...props, ...deletion.writes }, after = readFlow(deleted);
    const history = appliedFlowHistory(styled, after, Object.keys(deletion.writes))!;
    const undo = flowIntentWrites(deleted, after, history.before);
    expect(readFlow({ ...deleted, ...undo.writes }).mindPaints?.c).toEqual({ fill: "none" });
    const newTopic: MindTopic = { id: "n", parent: "r", order: 2, text: "新" };
    const conflict = flowIntentWrites({ ...props, "fc.mp.n": '{"future":true}' }, styled, { ...styled, mind: [...styled.mind!, newTopic] });
    expect(conflict.conflicts).toContain("fc.mp.n"); expect(conflict.writes["fc.m.n"]).toBeUndefined();
  });
  it("does not half-apply copied style when that sibling's paint changed remotely", () => {
    const base: FlowGraph = { ...graph, mindPaints: { s: { stroke: "#5b7ff1" } } }, props = flowWrites({}, base);
    const remote = { ...props, "fc.mp.s": '{"stroke":"#e86d68"}' };
    const desired: FlowGraph = { ...base, mindStyles: { ...base.mindStyles, s: { shape: "oval" } }, mindPaints: { ...base.mindPaints, s: { stroke: "#79c968" } } };
    const conflict = flowIntentWrites(remote, base, desired);
    expect(conflict.conflicts).toContain("fc.mp.s"); expect(conflict.writes["fc.ms.s"]).toBeUndefined(); expect(conflict.writes["fc.mp.s"]).toBeUndefined();
  });
});

describe("mind map structural edits, validation, descriptions, text formats, and layout edge cases", () => {
  const root2: MindTopic = { id: "r2", parent: null, order: 1, text: "根二", x: 10, y: 200 };
  const c1: MindTopic = { id: "c1", parent: "r", order: 0, text: "一" };
  const c2: MindTopic = { id: "c2", parent: "r", order: 1, text: "二" };
  const gc: MindTopic = { id: "gc", parent: "c1", order: 0, text: "孙" };

  it("computes root default text color for default fill, light/dark fills, none fill, and low fillOpacity", () => {
    expect(mindDefaultTextColor(false, "rect")).toBe("#1f2329");
    expect(mindDefaultTextColor(true, "text")).toBe("#1f2329");
    expect(mindDefaultTextColor(true, "rect")).toBe("#ffffff");
    expect(mindDefaultTextColor(true, "rect", { fill: "none" })).toBe("#1f2329");
    expect(mindDefaultTextColor(true, "rect", { fill: "#111111", fillOpacity: 30 })).toBe("#1f2329");
    expect(mindDefaultTextColor(true, "rect", { fill: "#ffffff", fillOpacity: 80 })).toBe("#1f2329");
    expect(mindDefaultTextColor(true, "rect", { fill: "#112233", fillOpacity: 100 })).toBe("#ffffff");
  });

  it("validates topics, filters cycles & deep chains in readMindTopics, wraps descriptions, and ties sibling layout", () => {
    expect(normalizeMindTopic(null)).toBeNull();
    expect(normalizeMindTopic([])).toBeNull();
    expect(canonicalMindTopic({ id: "bad!", parent: null, order: 0, text: "x", x: 0, y: 0 })).toBeNull();

    // Cycles and depth > 32 dropped by readMindTopics
    const cyclicProps: Record<string, string> = {
      "fc.m.a": JSON.stringify({ parent: "b", order: 0, text: "A" }),
      "fc.m.b": JSON.stringify({ parent: "a", order: 0, text: "B" }),
      "fc.m.r": JSON.stringify({ parent: null, order: 0, text: "R", x: 0, y: 0 }),
    };
    for (let i = 1; i <= 34; i++) {
      cyclicProps[`fc.m.d${i}`] = JSON.stringify({ parent: i === 1 ? "r" : `d${i - 1}`, order: 0, text: `D${i}` });
    }
    const read = readMindTopics(cyclicProps);
    expect(read.some((t) => t.id === "a" || t.id === "b")).toBe(false);
    expect(read.some((t) => t.id === "d32")).toBe(true);
    expect(read.some((t) => t.id === "d33")).toBe(false);

    // Description line wrapping & layout tie-breaking + root without x/y
    expect(mindDescriptionLines("w".repeat(80), 12).length).toBeGreaterThan(1);
    const laid = layoutMindTopics([
      { id: "r0", parent: null, order: 0, text: "NoCoords" },
      { id: "b", parent: "r0", order: 0, text: "B" },
      { id: "a", parent: "r0", order: 0, text: "A" },
    ]);
    expect(laid.map((p) => p.topic.id)).toEqual(["r0", "a", "b"]);
  });

  it("handles reordering, reparenting, ancestry/sibling checks, deletion with reparented child, and blocked parent propagation", () => {
    const base = [root, root2, c1, c2, gc];
    const props = flowWrites({}, { ...blank, mind: base });

    // Clean reorder + reparent (including moving c1+gc under root2)
    const reparented = [root, root2, { ...c1, parent: "r2", order: 0 }, { ...c2, order: 0 }, gc];
    const ok = mindIntentWrites(props, base, reparented);
    expect(ok.conflicts).toEqual([]);
    expect(ok.writes["fc.m.c1"]).toBeTruthy();

    // Reparenting when props already matches desired (no-op structural)
    const alreadyDone = flowWrites({}, { ...blank, mind: reparented });
    expect(mindIntentWrites(alreadyDone, base, reparented)).toEqual({ writes: {}, conflicts: [] });

    // Structural edit rejected when sibling set changed remotely
    const remoteAddedSibling = flowWrites({}, { ...blank, mind: [...base, { id: "c3", parent: "r", order: 2, text: "远端" }] });
    const reorderConflict = mindIntentWrites(remoteAddedSibling, base, [root, root2, { ...c1, order: 1 }, { ...c2, order: 0 }, gc]);
    expect(reorderConflict.conflicts).toEqual(expect.arrayContaining(["fc.m.c1", "fc.m.c2"]));

    // Structural edit rejected when ancestry changed remotely (c1 moved under r2 remotely, locally moving gc)
    const remoteReparented = flowWrites({}, { ...blank, mind: [root, root2, { ...c1, parent: "r2", order: 0 }, c2, gc] });
    const ancestryConflict = mindIntentWrites(remoteReparented, base, [root, root2, c1, c2, { ...gc, parent: "c2", order: 0 }]);
    expect(ancestryConflict.conflicts).toContain("fc.m.gc");

    // Same-ancestry with newly planned cyclic parent & newly planned colliding parent
    const plannedCycle = mindIntentWrites(props, base, [
      ...base.filter((t) => t.id !== "gc"),
      { id: "px", parent: "py", order: 0, text: "X" },
      { id: "py", parent: "px", order: 0, text: "Y" },
      { ...gc, parent: "px", order: 0 },
    ]);
    expect(plannedCycle.conflicts).toContain("fc.m.gc");

    const collidingProps = { ...props, "fc.m.newp": JSON.stringify({ parent: "r", order: 9, text: "Remote" }) };
    const plannedCollide = mindIntentWrites(collidingProps, base, [
      ...base.filter((t) => t.id !== "gc"),
      { id: "newp", parent: "r", order: 5, text: "Local" },
      { ...gc, parent: "newp", order: 0 },
    ]);
    expect(plannedCollide.conflicts).toContain("fc.m.gc");

    // Reparenting under a brand-new valid parent (hits !was -> planned -> id = planned.parent -> root)
    const validNewParent = mindIntentWrites(props, base, [
      ...base.filter((t) => t.id !== "gc"),
      { id: "np", parent: "r2", order: 0, text: "NewParent" },
      { ...gc, parent: "np", order: 0 },
    ]);
    expect(validNewParent.conflicts).toEqual([]);

    // Trying to demote root to child or promote child to root conflicts (L81), as does invalid prior/target
    expect(mindIntentWrites(props, base, [{ ...root, parent: "r2" }, root2, c1, c2, gc]).conflicts).toContain("fc.m.r");
    expect(mindIntentWrites(props, base, [root, root2, { ...c1, parent: null, x: 0, y: 0 }, c2, gc]).conflicts).toContain("fc.m.c1");
    expect(mindIntentWrites(props, base, [root, root2, { ...c1, order: -1 }, c2, gc]).conflicts).toContain("fc.m.c1");

    // Deletion blocked when description or description style differs/corrupt in props
    const descProps = { ...props, "fc.md.c2": JSON.stringify("remote desc"), "fc.mds.c2": JSON.stringify({ size: 16 }) };
    const delDescConflict = mindIntentWrites(descProps, base, [root, root2, c1, gc], {}, {});
    expect(delDescConflict.conflicts).toEqual(expect.arrayContaining(["fc.m.c2", "fc.md.c2"]));
    const delStyleConflict = mindIntentWrites(
      { ...props, "fc.mds.c2": "{" },
      base,
      [root, root2, c1, gc],
      undefined,
      {},
    );
    expect(delStyleConflict.conflicts).toEqual(expect.arrayContaining(["fc.m.c2", "fc.mds.c2"]));

    // Deleting parent c1 while simultaneously reparenting its child gc to c2 succeeds (L118 safe delete)
    const delParentMoveChild = mindIntentWrites(props, base, [root, root2, c2, { ...gc, parent: "c2", order: 0 }]);
    expect(delParentMoveChild.conflicts).toEqual([]);
    expect(delParentMoveChild.writes["fc.m.c1"]).toBe("");
    expect(delParentMoveChild.writes["fc.m.gc"]).toBeTruthy();

    // Multi-node addition group rollback when child conflicts (L110) + adding new child under blocked parent (L115)
    const addGroupConflict = mindIntentWrites(
      { ...props, "fc.m.nb": JSON.stringify({ parent: "r", order: 9, text: "Conflict" }) },
      base,
      [
        ...base,
        { id: "na", parent: "r", order: 2, text: "NewA" },
        { id: "nb", parent: "na", order: 0, text: "NewB" },
        { id: "nc", parent: "r", order: 3, text: "UnderBlockedParent" },
      ],
    );
    expect(addGroupConflict.conflicts).toEqual(expect.arrayContaining(["fc.m.na", "fc.m.nb", "fc.m.nc"]));

    // Blocked parent chain expansion across structural moves (L113-L114):
    // c1 conflicts on r -> blocks r -> blocks moving c2 from r to r2 (blocks r2!) -> blocks moving gc2 under r2
    const c2b: MindTopic = { id: "c2b", parent: "r2", order: 0, text: "R2Child" };
    const baseChain = [root, root2, c1, c2, gc, c2b];
    const propsChain = {
      ...flowWrites({}, { ...blank, mind: baseChain }),
      "fc.m.c1": JSON.stringify({ parent: "r", order: 0, text: "RemoteC1" }),
    };
    const chainConflict = mindIntentWrites(propsChain, baseChain, [
      root,
      root2,
      { ...c1, order: 5 },
      { ...c2, parent: "r2", order: 1 },
      gc,
      { ...c2b, parent: "gc", order: 0 },
    ]);
    expect(chainConflict.conflicts).toEqual(expect.arrayContaining(["fc.m.c1", "fc.m.c2", "fc.m.c2b"]));

    // Reparenting checks (L131-137):
    // 1. Orphan/malformed stored topic blocks reparent
    const orphanProps = { ...props, "fc.m.ghost": JSON.stringify({ parent: "nonexistent", order: 0, text: "Ghost" }) };
    expect(mindIntentWrites(orphanProps, base, [root, root2, { ...c1, parent: "r2", order: 0 }, c2, gc]).conflicts).toContain("fc.m.c1");
    // 2. Reparenting c1 under its own descendant gc creates a cycle in projected tree
    expect(mindIntentWrites(props, base, [root, root2, { ...c1, parent: "gc", order: 0 }, c2, gc]).conflicts).toContain("fc.m.c1");
    // 3. Reparenting c1 (with child gc) under a depth-32 chain exceeds max depth 32 for descendant gc
    const deepChain: MindTopic[] = [root, root2, c1, gc];
    for (let i = 1; i <= 31; i++) {
      deepChain.push({ id: `dp${i}`, parent: i === 1 ? "r2" : `dp${i - 1}`, order: 0, text: `D${i}` });
    }
    const deepProps = flowWrites({}, { ...blank, mind: deepChain });
    const tooDeepReparent = mindIntentWrites(deepProps, deepChain, deepChain.map((t) => (t.id === "c1" ? { ...t, parent: "dp31", order: 0 } : t)));
    expect(tooDeepReparent.conflicts).toContain("fc.m.c1");
    // 4. Reparenting gc while deleting target parent c2 in the same batch hits projected.delete + !cursor
    expect(mindIntentWrites(props, base, [root, root2, c1, { ...gc, parent: "c2", order: 0 }]).conflicts).toContain("fc.m.gc");
  });

  it("covers description, descriptionStyle, style, paint, textFormat, and collapse validators & intents", () => {
    // Validators: null/array/unknown keys/out-of-range/bad hex/corrupt JSON
    expect(canonicalMindDescription("a".repeat(2001))).toBeNull();
    expect(canonicalMindDescription("a\0b")).toBeNull();
    expect(canonicalMindDescription("x\n".repeat(130))).toBeNull();
    expect(normalizeMindDescriptionStyle(null)).toBeNull();
    expect(normalizeMindDescriptionStyle([])).toBeNull();
    expect(normalizeMindDescriptionStyle({ unknown: 1 })).toBeNull();
    expect(normalizeMindDescriptionStyle({ size: 10 })).toBeNull();
    expect(normalizeMindDescriptionStyle({ color: "red" })).toBeNull();
    expect(normalizeMindDescriptionStyle({ highlight: "red" })).toBeNull();
    expect(canonicalMindDescriptionStyle({})).toBe("");

    expect(normalizeMindStyle(null)).toBeNull();
    expect(normalizeMindStyle({ shape: "bad" })).toBeNull();
    expect(normalizeMindStyle({ size: 999 })).toBeNull();
    expect(normalizeMindStyle({ color: "red" })).toBeNull();
    expect(canonicalMindStyle({})).toBe("");

    expect(normalizeMindPaint(null)).toBeNull();
    expect(normalizeMindPaint({ stroke: "bad" })).toBeNull();
    expect(normalizeMindPaint({ line: "wavy" })).toBeNull();
    expect(normalizeMindPaint({ width: 9 })).toBeNull();
    expect(normalizeMindPaint({ opacity: 200 })).toBeNull();
    expect(canonicalMindPaint({})).toBe("");

    expect(normalizeMindTextFormat(null)).toBeNull();
    expect(normalizeMindTextFormat({ extra: true })).toBeNull();
    expect(normalizeMindTextFormat({ bold: false })).toBeNull();
    expect(normalizeMindTextFormat({ highlight: "bad" })).toBeNull();
    expect(normalizeMindTextFormat({ align: "justify" })).toBeNull();
    expect(canonicalMindTextFormat(undefined)).toBe("");
    expect(canonicalMindTextFormat({})).toBe("");
    expect(canonicalMindTextFormat({ bold: false } as never)).toBeNull();

    // Corrupt JSON ignored by readers
    const corruptProps: Record<string, string> = {
      "fc.ms.c": "{bad",
      "fc.mp.c": "{bad",
      "fc.mt.c": "{bad",
      "fc.md.c": "{bad",
      "fc.mds.c": "{bad",
    };
    expect(readMindStyles(corruptProps, [child])).toEqual({});
    expect(readMindPaints(corruptProps, [child])).toEqual({});
    expect(readMindTextFormats(corruptProps, [child])).toEqual({});
    expect(readMindDescriptions(corruptProps, [child])).toEqual({});
    expect(readMindDescriptionStyles(corruptProps, [child])).toEqual({});

    const topics = [root, child];
    const baseProps = flowWrites({}, { ...blank, mind: topics });

    // Style & paint intent corrupt JSON
    expect(mindStyleIntent({ ...baseProps, "fc.ms.c": "{bad" }, {}, { c: { size: 16 } }, topics, topics, {}).conflicts).toContain("fc.ms.c");
    expect(mindPaintIntent({ ...baseProps, "fc.mp.c": "{bad" }, {}, { c: { width: 2 } }, topics, topics, {}).conflicts).toContain("fc.mp.c");

    // TextFormat intent: unchanged skip, corrupt JSON, remote conflict, write, already-matching no-op
    expect(mindTextFormatIntent(baseProps, { c: { bold: true } }, { c: { bold: true } }, topics, topics, {})).toEqual({ writes: {}, conflicts: [] });
    expect(mindTextFormatIntent({ ...baseProps, "fc.mt.c": "{bad" }, {}, { c: { bold: true } }, topics, topics, {}).conflicts).toContain("fc.mt.c");
    expect(mindTextFormatIntent({ ...baseProps, "fc.mt.c": JSON.stringify({ italic: true }) }, {}, { c: { bold: true } }, topics, topics, {}).conflicts).toContain("fc.mt.c");
    expect(mindTextFormatIntent(baseProps, {}, { c: { bold: true, highlight: "#FFEEAA", align: "left" } }, topics, topics, {}).writes["fc.mt.c"]).toBeTruthy();
    expect(mindTextFormatIntent({ ...baseProps, "fc.mt.c": JSON.stringify({ bold: true }) }, {}, { c: { bold: true } }, topics, topics, {}).writes).toEqual({});

    // Description intent: unchanged skip, remote conflict, new topic conflict, corrupt/invalid style, size-induced >128 lines, normal write, no-op
    expect(mindDescriptionIntent(baseProps, { c: "same" }, { c: "same" }, topics, topics, {})).toEqual({ writes: {}, conflicts: [] });
    expect(mindDescriptionIntent({ ...baseProps, "fc.md.c": JSON.stringify("remote") }, {}, { c: "local" }, topics, topics, {}).conflicts).toContain("fc.md.c");
    const newTopic: MindTopic = { id: "nt", parent: "r", order: 2, text: "New" };
    const newTopicWrites = { "fc.m.nt": canonicalMindTopic(newTopic)! };
    expect(mindDescriptionIntent({ ...baseProps, "fc.md.nt": JSON.stringify("stale") }, {}, { nt: "fresh" }, topics, [...topics, newTopic], newTopicWrites).conflicts).toContain("fc.md.nt");
    expect(mindDescriptionIntent({ ...baseProps, "fc.mds.c": "{bad" }, {}, { c: "hello" }, topics, topics, {}).conflicts).toContain("fc.md.c");
    expect(mindDescriptionIntent(baseProps, {}, { c: "hello" }, topics, topics, {}, { c: { size: 5 } }).conflicts).toContain("fc.md.c");
    // Large size makes a medium description exceed 128 wrapped lines
    const mediumDesc = "中".repeat(400);
    expect(
      mindDescriptionIntent(
        { ...baseProps, "fc.mds.c": JSON.stringify({ color: "#112233" }) },
        {},
        { c: mediumDesc },
        topics,
        topics,
        {},
        { c: { size: 96 } },
      ).conflicts,
    ).toContain("fc.md.c");
    expect(
      mindDescriptionIntent(
        { ...baseProps, "fc.mds.c": JSON.stringify({ size: 24 }) },
        {},
        { c: "short" },
        topics,
        topics,
        {},
        { c: { color: "#112233" } },
      ).writes["fc.md.c"],
    ).toBe(JSON.stringify("short"));
    expect(mindDescriptionIntent({ ...baseProps, "fc.md.c": JSON.stringify("ok") }, {}, { c: "ok" }, topics, topics, {}).writes).toEqual({});

    // DescriptionStyle intent: unchanged skip, remote conflict, new topic conflict, corrupt/invalid desc, >128 lines with big size, normal write, no-op
    expect(mindDescriptionStyleIntent(baseProps, { c: { size: 16 } }, { c: { size: 16 } }, topics, topics, {})).toEqual({ writes: {}, conflicts: [] });
    expect(mindDescriptionStyleIntent({ ...baseProps, "fc.mds.c": JSON.stringify({ size: 18 }) }, {}, { c: { size: 20 } }, topics, topics, {}).conflicts).toContain("fc.mds.c");
    expect(mindDescriptionStyleIntent({ ...baseProps, "fc.mds.nt": JSON.stringify({ size: 18 }) }, {}, { nt: { size: 20 } }, topics, [...topics, newTopic], newTopicWrites).conflicts).toContain("fc.mds.nt");
    expect(mindDescriptionStyleIntent({ ...baseProps, "fc.md.c": "{bad" }, {}, { c: { size: 16 } }, topics, topics, {}).conflicts).toContain("fc.mds.c");
    expect(mindDescriptionStyleIntent({ ...baseProps, "fc.md.c": JSON.stringify(mediumDesc) }, {}, { c: { size: 96 } }, topics, topics, {}).conflicts).toContain("fc.mds.c");
    expect(mindDescriptionStyleIntent(baseProps, {}, { c: { color: "#112233", highlight: "#ffeeaa" } }, topics, topics, {}, { c: "short" }).writes["fc.mds.c"]).toBeTruthy();
    expect(mindDescriptionStyleIntent({ ...baseProps, "fc.mds.c": JSON.stringify({ size: 16 }) }, {}, { c: { size: 16 } }, topics, topics, {}).writes).toEqual({});

    // Collapse intent: unchanged skip + remotely deleted topic conflict
    expect(mindCollapseIntent(baseProps, ["c"], ["c"], topics, topics, {})).toEqual({ writes: {}, conflicts: [] });
    expect(mindCollapseIntent({ ...baseProps, "fc.m.c": "" }, [], ["c"], topics, topics, {}).conflicts).toContain("fc.mc.c");
  });
});
