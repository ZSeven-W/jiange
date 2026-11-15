import { describe, expect, it } from "vitest";
import { flowIntentWrites, flowWrites, readFlow, toMermaid, type FlowGraph } from "./model";
import { appliedFlowHistory } from "./history";
import { layoutMindTopics, normalizeMindTopic, type MindTopic } from "./mindmap";

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
