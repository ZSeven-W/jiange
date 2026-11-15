import { describe, expect, it } from "vitest";
import { appliedFlowHistory } from "./history";
import { copyMindBranch, mindClipHtml, mindClipText, parseMindClip, pasteMindBranch } from "./mindmap-clipboard";
import { flowIntentWrites, flowWrites, readFlow, type FlowGraph } from "./model";
import type { MindTopic } from "./mindmap";

const nodes: MindTopic[] = [{ id: "r", parent: null, order: 0, text: "项目", x: 20, y: 30 }, { id: "a", parent: "r", order: 0, text: "需求" }, { id: "b", parent: "r", order: 1, text: "设计" }, { id: "c", parent: "a", order: 0, text: "交付" }];
const graph: FlowGraph = { nodes: [], edges: [], theme: "feishu", mind: nodes, mindStyles: { a: { shape: "oval" }, c: { size: 24 } }, mindPaints: { a: { fill: "#e1e9ff" } }, mindCollapsed: ["a"] };
const ids = () => { let i = 0; return () => `new${++i}`; };
const ordered = (topics: readonly MindTopic[], parent: string) => topics.filter((node) => node.parent === parent).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map((node) => node.text);

describe("mind map clipboard", () => {
  it("copies folded descendants and pastes a styled clone under another topic", () => {
    const clip = copyMindBranch(graph, "a")!;
    expect(mindClipText(clip)).toBe("需求\n\t交付");
    expect(parseMindClip(JSON.stringify(clip))).toEqual(clip);
    const pasted = pasteMindBranch(graph, clip, "b", null, { x: 0, y: 0 }, ids())!;
    const props = flowWrites({}, graph), intent = flowIntentWrites(props, graph, pasted.graph), saved = readFlow({ ...props, ...intent.writes });
    expect(intent.conflicts).toEqual([]);
    expect(saved.mind?.find((node) => node.id === pasted.root)?.parent).toBe("b");
    expect(ordered(saved.mind!, pasted.root)).toEqual(["交付"]);
    expect(saved.mindStyles?.[pasted.root]).toEqual({ shape: "oval" }); expect(saved.mindPaints?.[pasted.root]).toEqual({ fill: "#e1e9ff" });
    expect(saved.mindCollapsed).toContain(pasted.root);
    const undo = appliedFlowHistory(graph, saved, Object.keys(intent.writes))!;
    expect(readFlow({ ...props, ...intent.writes, ...flowIntentWrites({ ...props, ...intent.writes }, saved, undo.before).writes }).mind).toHaveLength(nodes.length);
  });
  it("duplicates immediately after a sibling and preserves the original data", () => {
    const clip = copyMindBranch(graph, "a")!, result = pasteMindBranch(graph, clip, "r", "a", { x: 0, y: 0 }, ids())!;
    expect(ordered(result.graph.mind!, "r")).toEqual(["需求", "需求", "设计"]);
    expect(nodes.find((node) => node.id === "b")?.order).toBe(1);
    const saved = readFlow({ ...flowWrites({}, graph), ...flowIntentWrites(flowWrites({}, graph), graph, result.graph).writes });
    expect(ordered(saved.mind!, "r")).toEqual(["需求", "需求", "设计"]);
  });
  it("rejects malformed or excessive clipboard data and overly deep insertion", () => {
    const clip = copyMindBranch(graph, "a")!;
    expect(parseMindClip("{" )).toBeNull();
    expect(parseMindClip(JSON.stringify({ ...clip, styles: { a: { future: true } } }))).toBeNull();
    expect(parseMindClip(JSON.stringify({ ...clip, topics: [...clip.topics, clip.topics[0]] }))).toBeNull();
    expect(parseMindClip(JSON.stringify({ ...clip, topics: clip.topics.map((node) => node.id === "c" ? { ...node, parent: "missing" } : node) }))).toBeNull();
    const deep: MindTopic[] = [nodes[0]];
    for (let i = 1; i <= 31; i++) deep.push({ id: `d${i}`, parent: i === 1 ? "r" : `d${i - 1}`, order: 0, text: "" });
    expect(pasteMindBranch({ ...graph, mind: deep }, clip, "d31", null, { x: 0, y: 0 }, ids())).toBeNull();
  });
  it("escapes copied text in the HTML representation", () => {
    const clip = copyMindBranch({ ...graph, mind: nodes.map((node) => node.id === "a" ? { ...node, text: '<img src=x onerror="x">&' } : node) }, "a")!;
    const html = mindClipHtml(clip);
    expect(html).toContain("&lt;img src=x onerror="); expect(html).toContain("&gt;&amp;"); expect(html).not.toContain("<img");
  });
  it("treats special object names as data, not prototypes", () => {
    const raw = '{"version":1,"root":"__proto__","topics":[{"id":"__proto__","parent":null,"order":0,"text":"x","x":0,"y":0}],"styles":{"__proto__":{"size":24}},"paints":{"__proto__":{"fill":"#e1e9ff"}},"collapsed":[]}';
    const clip = parseMindClip(raw)!;
    expect(Object.hasOwn(clip.styles, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(clip.styles)).toBe(Object.prototype);
    expect(clip.styles["__proto__"]).toEqual({ size: 24 });
  });
  it("does not partially cut a branch when an unseen child arrived", () => {
    const props = flowWrites({}, graph), remote = flowWrites(props, { ...graph, mind: [...nodes, { id: "remote", parent: "a", order: 2, text: "远端" }] });
    const cut = flowIntentWrites({ ...props, ...remote }, graph, { ...graph, mind: nodes.filter((node) => node.id !== "a" && node.id !== "c") });
    expect(cut.conflicts).toContain("fc.m.a"); expect(cut.conflicts).toContain("fc.m.c");
    expect(cut.writes["fc.m.a"]).toBeUndefined(); expect(cut.writes["fc.m.c"]).toBeUndefined();
  });
  it("rolls back the whole insertion and reindex on an unknown new-node style", () => {
    const dense: FlowGraph = { ...graph, mind: nodes.map((node) => node.id === "b" ? { ...node, order: Number.MIN_VALUE } : node) };
    const clip = copyMindBranch(dense, "a")!, result = pasteMindBranch(dense, clip, "r", "a", { x: 0, y: 0 }, ids())!;
    const props = { ...flowWrites({}, dense), "fc.ms.new1": '{"future":true}' };
    const attempt = flowIntentWrites(props, dense, result.graph);
    expect(attempt.conflicts).toContain("fc.ms.new1"); expect(attempt.writes["fc.m.new1"]).toBeUndefined(); expect(attempt.writes["fc.m.new2"]).toBeUndefined(); expect(attempt.writes["fc.m.b"]).toBeUndefined();
  });
});
