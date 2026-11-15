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
    expect(removingRoot.writes["fc.m.c"]).toBe("");
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
