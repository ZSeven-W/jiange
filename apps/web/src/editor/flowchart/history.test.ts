import { describe, expect, it } from "vitest";
import { appliedFlowHistory } from "./history";
import { flowIntentWrites, flowWrites, readFlow, type FlowGraph } from "./model";

const node = (id: string, text: string) => ({ id, shape: "rect" as const, text, x: 0, y: 0, w: 100, h: 60 });
const original: FlowGraph = { nodes: [node("a", "A"), node("b", "B")], edges: [], theme: "default" };

describe("flowchart undo history", () => {
  it("records only applied parts of a partially conflicting change", () => {
    const proposed = { ...original, nodes: [node("a", "我的 A"), node("b", "我的 B")] };
    const live = { ...original, nodes: [node("a", "同事的 A"), node("b", "B"), node("peer", "同事新建")] };
    const props = flowWrites({}, live);
    const change = flowIntentWrites(props, original, proposed);
    const saved = readFlow({ ...props, ...change.writes });
    const history = appliedFlowHistory(original, saved, Object.keys(change.writes))!;
    expect(change.conflicts).toEqual(["fc.n.a"]);
    const undo = flowIntentWrites(flowWrites({}, saved), history.after, history.before);
    expect(Object.keys(undo.writes)).toEqual(["fc.n.b"]);
    const undone = readFlow({ ...flowWrites({}, saved), ...undo.writes });
    expect(undone.nodes.find((n) => n.id === "a")?.text).toBe("同事的 A");
    expect(undone.nodes.find((n) => n.id === "peer")?.text).toBe("同事新建");
    expect(undone.nodes.find((n) => n.id === "b")?.text).toBe("B");
  });

  it("redo after partial undo only repeats the writes that actually succeeded", () => {
    const changed = { ...original, nodes: [node("a", "我的 A"), node("b", "我的 B")] };
    const live = { ...changed, nodes: [node("a", "同事的 A"), node("b", "我的 B")] };
    const props = flowWrites({}, live);
    const undo = flowIntentWrites(props, changed, original);
    const undone = readFlow({ ...props, ...undo.writes });
    const actual = appliedFlowHistory(changed, undone, Object.keys(undo.writes))!;
    const redo = flowIntentWrites(flowWrites({}, undone), actual.after, actual.before);
    expect(undo.conflicts).toEqual(["fc.n.a"]);
    expect(Object.keys(redo.writes)).toEqual(["fc.n.b"]);
    const redone = readFlow({ ...flowWrites({}, undone), ...redo.writes });
    expect(redone.nodes.find((n) => n.id === "a")?.text).toBe("同事的 A");
    expect(redone.nodes.find((n) => n.id === "b")?.text).toBe("我的 B");
  });

  it("ignores the format marker and restores removed objects without touching others", () => {
    expect(appliedFlowHistory(original, original, ["fc.v"])).toBeNull();
    const after = { ...original, nodes: [original.nodes[1], node("peer", "同事")], theme: "colorful" as FlowGraph["theme"] };
    const entry = appliedFlowHistory(original, after, ["fc.n.a", "fc.theme"])!;
    expect(entry.before.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "peer"]);
    expect(entry.before.theme).toBe(original.theme);
    expect(entry.after).toBe(after);
  });
});
