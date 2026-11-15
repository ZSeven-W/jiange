import { describe, expect, it } from "vitest";
import { appliedFlowHistory } from "./history";
import { flowIntentWrites, flowWrites, readFlow, type FlowGraph } from "./model";
import { layoutMindTopics, type MindTopic } from "./mindmap";
import { mindDropAt, moveMindTopic } from "./mindmap-move";

const topics: MindTopic[] = [{ id: "root", parent: null, order: 0, text: "根", x: 0, y: 0 }, { id: "a", parent: "root", order: 0, text: "甲" }, { id: "b", parent: "root", order: 1, text: "乙" }, { id: "c", parent: "root", order: 2, text: "丙" }, { id: "sub", parent: "a", order: 0, text: "子" }];
const graph: FlowGraph = { nodes: [], edges: [], theme: "feishu", mind: topics };
const children = (nodes: readonly MindTopic[], parent: string) => nodes.filter((node) => node.parent === parent).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map((node) => node.id);

describe("mind map moves", () => {
  it("reorders before an order-zero sibling without mutating the original tree", () => {
    const moved = moveMindTopic(topics, "c", { kind: "before", target: "a" })!;
    expect(children(moved, "root")).toEqual(["c", "a", "b"]);
    expect(children(topics, "root")).toEqual(["a", "b", "c"]);
    expect(topics.find((topic) => topic.id === "a")!.order).toBe(0);
    const props = flowWrites({}, graph), intent = flowIntentWrites(props, graph, { ...graph, mind: moved });
    expect(intent.conflicts).toEqual([]);
    const saved = readFlow({ ...props, ...intent.writes }), history = appliedFlowHistory(graph, saved, Object.keys(intent.writes))!;
    const undo = flowIntentWrites({ ...props, ...intent.writes }, saved, history.before);
    expect(children(readFlow({ ...props, ...intent.writes, ...undo.writes }).mind!, "root")).toEqual(["a", "b", "c"]);
  });
  it("moves a whole branch and prevents cycles through hidden descendants", () => {
    const moved = moveMindTopic(topics, "a", { kind: "child", target: "b" })!;
    const props = flowWrites({}, graph), intent = flowIntentWrites(props, graph, { ...graph, mind: moved });
    expect(intent.conflicts).toEqual([]);
    const saved = readFlow({ ...props, ...intent.writes });
    expect(saved.mind?.find((topic) => topic.id === "a")?.parent).toBe("b");
    expect(saved.mind?.find((topic) => topic.id === "sub")?.parent).toBe("a");
    expect(moveMindTopic(topics, "a", { kind: "child", target: "sub" })).toBeNull();
    const positions = layoutMindTopics(topics, new Set(["a"]));
    expect(mindDropAt(topics, positions, "a", { x: 10000, y: 10000 })).toBeNull();
    const b = positions.find((node) => node.topic.id === "b")!;
    expect(mindDropAt(topics, positions, "a", { x: b.x + b.w + 10, y: b.y + b.h / 2 })).toEqual({ kind: "child", target: "b" });
    expect(mindDropAt(topics, positions, "a", { x: b.x + 10, y: b.y - 10 })).toEqual({ kind: "before", target: "b" });
  });
  it("saves root movement and preserves independent node styling", () => {
    const styled: FlowGraph = { ...graph, mindStyles: { a: { shape: "oval" } }, mindPaints: { a: { fill: "#e1e9ff" } } };
    const props = flowWrites({}, styled), movedRoot = { ...styled, mind: topics.map((topic) => topic.id === "root" ? { ...topic, x: 150, y: -50 } : topic) };
    const rootIntent = flowIntentWrites(props, styled, movedRoot), rootSaved = readFlow({ ...props, ...rootIntent.writes });
    expect(rootSaved.mind?.find((topic) => topic.id === "root")).toMatchObject({ x: 150, y: -50 });
    const moved = moveMindTopic(topics, "a", { kind: "child", target: "b" })!;
    const branchIntent = flowIntentWrites(props, styled, { ...styled, mind: moved }), saved = readFlow({ ...props, ...branchIntent.writes });
    expect(saved.mindStyles?.a).toEqual({ shape: "oval" }); expect(saved.mindPaints?.a).toEqual({ fill: "#e1e9ff" });
    const remote = flowWrites(props, { ...styled, mind: topics.map((topic) => topic.id === "root" ? { ...topic, text: "远端" } : topic) });
    expect(flowIntentWrites({ ...props, ...remote }, styled, movedRoot).conflicts).toContain("fc.m.root");
  });
  it("rejects the whole reindex when a sibling changed remotely", () => {
    const moved = moveMindTopic(topics, "c", { kind: "before", target: "a" })!, props = flowWrites({}, graph);
    const remote = flowWrites(props, { ...graph, mind: topics.map((topic) => topic.id === "a" ? { ...topic, text: "远端" } : topic) });
    const intent = flowIntentWrites({ ...props, ...remote }, graph, { ...graph, mind: moved });
    expect(intent.conflicts).toContain("fc.m.a"); expect(intent.conflicts).toContain("fc.m.c");
    expect(intent.writes["fc.m.a"]).toBeUndefined(); expect(intent.writes["fc.m.c"]).toBeUndefined();
  });
  it("rejects stale sibling structure, cycles and descendant depth overflow", () => {
    const props = flowWrites({}, graph), extra = { id: "remote", parent: "b", order: 1, text: "远端" };
    const moved = moveMindTopic(topics, "a", { kind: "child", target: "b" })!;
    const remote = flowWrites(props, { ...graph, mind: [...topics, extra] });
    expect(flowIntentWrites({ ...props, ...remote }, graph, { ...graph, mind: moved }).conflicts).toContain("fc.m.a");
    expect(flowIntentWrites({ ...props, "fc.m.bad": "{" }, graph, { ...graph, mind: moved }).conflicts).toContain("fc.m.a");
    const cycle = topics.map((topic) => topic.id === "a" ? { ...topic, parent: "sub" } : topic);
    expect(flowIntentWrites(props, graph, { ...graph, mind: cycle }).conflicts).toContain("fc.m.a");
    const chain: MindTopic[] = [{ id: "r", parent: null, order: 0, text: "", x: 0, y: 0 }];
    for (let i = 1; i <= 31; i++) chain.push({ id: `d${i}`, parent: i === 1 ? "r" : `d${i - 1}`, order: 0, text: "" });
    chain.push({ id: "branch", parent: "r", order: 1, text: "" }, { id: "leaf", parent: "branch", order: 0, text: "" });
    const base = { ...graph, mind: chain }, deepMove = moveMindTopic(chain, "branch", { kind: "child", target: "d31" })!;
    expect(flowIntentWrites(flowWrites({}, base), base, { ...base, mind: deepMove }).conflicts).toContain("fc.m.branch");
  });
  it("rejects a move if the destination ancestry changed during the gesture", () => {
    const extended: MindTopic[] = [...topics, { id: "d", parent: "b", order: 0, text: "目标" }];
    const base: FlowGraph = { ...graph, mind: extended }, props = flowWrites({}, base);
    const destinationMoved = extended.map((topic) => topic.id === "b" ? { ...topic, parent: "a" } : topic);
    const remote = flowWrites(props, { ...base, mind: destinationMoved });
    const proposed = moveMindTopic(extended, "c", { kind: "child", target: "d" })!;
    expect(flowIntentWrites({ ...props, ...remote }, base, { ...base, mind: proposed }).conflicts).toContain("fc.m.c");
  });
});
