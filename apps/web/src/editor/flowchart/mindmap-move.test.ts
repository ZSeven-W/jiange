import { describe, expect, it } from "vitest";
import { appliedFlowHistory } from "./history";
import { flowIntentWrites, flowWrites, readFlow, type FlowGraph } from "./model";
import { layoutMindTopics, type MindTopic } from "./mindmap";
import { insertMindParent, mindDropAt, moveMindTopic } from "./mindmap-move";

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

describe("insert parent topic", () => {
  it("inserts a parent at the same position while preserving the subtree, styles and undo/redo", () => {
    const before: FlowGraph = { ...graph, mindStyles: { a: { shape: "oval" } }, mindPaints: { a: { fill: "#e1e9ff" } }, mindCollapsed: ["a"] };
    const proposed = insertMindParent(topics, "a", "wrapper")!, props = flowWrites({}, before);
    const applied = flowIntentWrites(props, before, { ...before, mind: proposed });
    expect(applied.conflicts).toEqual([]);
    const savedProps = { ...props, ...applied.writes }, saved = readFlow(savedProps);
    expect(children(saved.mind!, "root")).toEqual(["wrapper", "b", "c"]);
    expect(saved.mind?.find((topic) => topic.id === "a")?.parent).toBe("wrapper");
    expect(saved.mind?.find((topic) => topic.id === "sub")?.parent).toBe("a");
    expect(saved.mindStyles?.a).toEqual({ shape: "oval" }); expect(saved.mindPaints?.a).toEqual({ fill: "#e1e9ff" }); expect(saved.mindCollapsed).toContain("a");
    const history = appliedFlowHistory(before, saved, Object.keys(applied.writes))!;
    const undo = flowIntentWrites(savedProps, saved, history.before);
    expect(undo.conflicts).toEqual([]);
    const undoneProps = { ...savedProps, ...undo.writes }, undone = readFlow(undoneProps);
    expect(children(undone.mind!, "root")).toEqual(["a", "b", "c"]); expect(undone.mind?.some((topic) => topic.id === "wrapper")).toBe(false);
    const redo = flowIntentWrites(undoneProps, undone, history.after);
    expect(redo.conflicts).toEqual([]); expect(readFlow({ ...undoneProps, ...redo.writes }).mind?.find((topic) => topic.id === "a")?.parent).toBe("wrapper");
  });
  it("rejects root insertion, duplicate ids and a subtree that would exceed depth 32", () => {
    expect(insertMindParent(topics, "root", "x")).toBeNull(); expect(insertMindParent(topics, "a", "b")).toBeNull();
    const full: MindTopic[] = [...topics, ...Array.from({ length: 495 }, (_, i) => ({ id: `extra${i}`, parent: "root", order: i + 3, text: "" }))];
    expect(insertMindParent(full, "a", "wrapper")).toBeNull();
    const chain: MindTopic[] = [{ id: "r", parent: null, order: 0, text: "", x: 0, y: 0 }];
    for (let i = 1; i <= 32; i++) chain.push({ id: `d${i}`, parent: i === 1 ? "r" : `d${i - 1}`, order: 0, text: "" });
    expect(insertMindParent(chain, "d1", "wrapper")).toBeNull();
    expect(insertMindParent(chain.slice(0, -1), "d1", "wrapper")).not.toBeNull();
  });
  it("does not partially insert when the selected node or new parent metadata conflicts", () => {
    const proposed = insertMindParent(topics, "a", "wrapper")!, props = flowWrites({}, graph);
    const remote = flowWrites(props, { ...graph, mind: topics.map((topic) => topic.id === "a" ? { ...topic, text: "远端" } : topic) });
    const stale = flowIntentWrites({ ...props, ...remote }, graph, { ...graph, mind: proposed });
    expect(stale.conflicts).toContain("fc.m.a"); expect(stale.writes["fc.m.a"]).toBeUndefined(); expect(stale.writes["fc.m.wrapper"]).toBeUndefined();
    for (const [key, value] of [["fc.ms.wrapper", '{"future":true}'], ["fc.mp.wrapper", '{"future":true}'], ["fc.mc.wrapper", "future"]]) {
      const collision = flowIntentWrites({ ...props, [key]: value }, graph, { ...graph, mind: proposed });
      expect(collision.conflicts).toContain(key); expect(collision.writes["fc.m.a"]).toBeUndefined(); expect(collision.writes["fc.m.wrapper"]).toBeUndefined();
    }
  });
  it("keeps a concurrently received descendant inside the moved subtree", () => {
    const proposed = insertMindParent(topics, "a", "wrapper")!, props = flowWrites({}, graph);
    const remote = flowWrites(props, { ...graph, mind: [...topics, { id: "remote", parent: "a", order: 3, text: "协作者" }] });
    const applied = flowIntentWrites({ ...props, ...remote }, graph, { ...graph, mind: proposed });
    expect(applied.conflicts).toEqual([]);
    const result = readFlow({ ...props, ...remote, ...applied.writes });
    expect(result.mind?.find((topic) => topic.id === "a")?.parent).toBe("wrapper");
    expect(result.mind?.find((topic) => topic.id === "remote")?.parent).toBe("a");
  });
  it("does not partially undo when a collaborator added a child to the new parent", () => {
    const proposed = insertMindParent(topics, "a", "wrapper")!, props = flowWrites({}, graph), applied = flowIntentWrites(props, graph, { ...graph, mind: proposed });
    const savedProps = { ...props, ...applied.writes }, saved = readFlow(savedProps), history = appliedFlowHistory(graph, saved, Object.keys(applied.writes))!;
    const remote = flowWrites(savedProps, { ...saved, mind: [...saved.mind!, { id: "remote", parent: "wrapper", order: 2, text: "协作者" }] });
    const undo = flowIntentWrites({ ...savedProps, ...remote }, saved, history.before);
    expect(undo.conflicts).toContain("fc.m.wrapper"); expect(undo.conflicts).toContain("fc.m.a");
    expect(undo.writes["fc.m.wrapper"]).toBeUndefined(); expect(undo.writes["fc.m.a"]).toBeUndefined();
  });
});
