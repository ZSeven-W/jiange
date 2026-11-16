import { afterEach, describe, expect, it, vi } from "vitest";
import { appliedFlowHistory } from "./history";
import { copyMindBranch, parseMindClip, pasteMindBranch } from "./mindmap-clipboard";
import { applyMindTextStyle, captureMindTextStyle, mindTextStyleHtml, mindTextStyleShortcut, parseMindTextStyle } from "./mindmap-text-style";
import { flowIntentWrites, flowWrites, readFlow, type FlowGraph } from "./model";

const graph: FlowGraph = { nodes: [], edges: [], theme: "feishu", mind: [{ id: "r", parent: null, order: 0, text: "主题", x: 0, y: 0 }, { id: "a", parent: "r", order: 0, text: "设计" }, { id: "b", parent: "r", order: 1, text: "需求" }], mindStyles: { a: { shape: "oval", size: 24, color: "#d83931" }, b: { shape: "rect", color: "#3370ff" } }, mindPaints: { a: { fill: "#e1e9ff", stroke: "#e86d68" }, b: { fill: "#ffffff" } }, mindTextFormats: { a: { bold: true, italic: true, underline: true, highlight: "#fff5c7", align: "right" } } };
afterEach(() => vi.unstubAllGlobals());

describe("mind map text style", () => {
  it("copies text formatting without replacing target shape, branch color or text", () => {
    const clip = captureMindTextStyle(graph, "a")!, next = applyMindTextStyle(graph, "b", clip)!;
    expect(next.mindStyles?.b).toEqual({ shape: "rect", size: 24, color: "#d83931" });
    expect(next.mindTextFormats?.b).toEqual(graph.mindTextFormats?.a);
    expect(next.mindPaints?.b).toEqual({ fill: "#ffffff" }); expect(next.mind).toEqual(graph.mind);
    expect(parseMindTextStyle(JSON.stringify(clip))).toEqual(clip);
    expect(mindTextStyleHtml(clip)).toContain("data-jiange-mind-text-style");
  });
  it("resets absent source text attributes and applies the source's effective size", () => {
    const source = captureMindTextStyle(graph, "r")!, next = applyMindTextStyle(graph, "a", source)!;
    expect(next.mindStyles?.a).toEqual({ shape: "oval", size: 16 });
    expect(next.mindTextFormats?.a).toBeUndefined(); expect(next.mindPaints?.a).toEqual(graph.mindPaints?.a);
    expect(parseMindTextStyle('{"version":1,"size":999,"format":{}}')).toBeNull();
    expect(parseMindTextStyle('{"version":1,"size":14,"format":{"future":true}}')).toBeNull();
  });
  it("keeps formats across old-client edits, deletion undo and branch clipboard", () => {
    const props = flowWrites({}, graph), oldClient: FlowGraph = { ...graph }; delete oldClient.mindTextFormats;
    const oldEdit = flowIntentWrites(props, oldClient, { ...oldClient, mindStyles: { ...oldClient.mindStyles, a: { shape: "rect" } } });
    expect(oldEdit.writes["fc.mt.a"]).toBeUndefined();
    const deletion = flowIntentWrites(props, graph, { ...graph, mind: graph.mind!.filter((topic) => topic.id !== "a") });
    const removedProps = { ...props, ...deletion.writes }, removed = readFlow(removedProps), history = appliedFlowHistory(graph, removed, Object.keys(deletion.writes))!;
    const restored = readFlow({ ...removedProps, ...flowIntentWrites(removedProps, removed, history.before).writes });
    expect(restored.mindTextFormats?.a).toEqual(graph.mindTextFormats?.a);
    const clip = parseMindClip(JSON.stringify(copyMindBranch(graph, "a")))!, inserted = pasteMindBranch(graph, clip, "b", null, { x: 0, y: 0 }, () => "new")!;
    const result = flowIntentWrites(props, graph, inserted.graph);
    expect(readFlow({ ...props, ...result.writes }).mindTextFormats?.new).toEqual(graph.mindTextFormats?.a);
  });
  it("rejects unknown or concurrently changed text metadata without partial style application", () => {
    const props = flowWrites({}, graph), clip = captureMindTextStyle(graph, "a")!, next = applyMindTextStyle(graph, "b", clip)!;
    const remote = { ...props, "fc.mt.b": '{"bold":true}' };
    const conflict = flowIntentWrites(remote, graph, next);
    expect(conflict.conflicts).toContain("fc.mt.b"); expect(conflict.writes["fc.ms.b"]).toBeUndefined(); expect(conflict.writes["fc.mt.b"]).toBeUndefined();
    expect(flowIntentWrites({ ...props, "fc.mt.b": '{"future":true}' }, graph, next).conflicts).toContain("fc.mt.b");
  });
  it("checks even unchanged-looking attributes during a complete style replacement", () => {
    const base: FlowGraph = { ...graph, mindStyles: { b: { shape: "rect", size: 14 } }, mindTextFormats: {} };
    const next = applyMindTextStyle(base, "b", { version: 1, size: 14, format: {} })!, props = flowWrites({}, base);
    const future = flowIntentWrites({ ...props, "fc.mt.b": '{"future":true}' }, base, next);
    expect(future.conflicts).toContain("fc.mt.b"); expect(future.writes["fc.ms.b"]).toBeUndefined();
    const remote = flowIntentWrites({ ...props, "fc.ms.b": '{"shape":"rect","size":24}' }, base, next);
    expect(remote.conflicts).toContain("fc.ms.b"); expect(remote.writes["fc.mt.b"]).toBeUndefined();
  });
  it("undoes and redoes a copied style as one operation", () => {
    const props = flowWrites({}, graph), next = applyMindTextStyle(graph, "b", captureMindTextStyle(graph, "a")!)!;
    const intent = flowIntentWrites(props, graph, next), savedProps = { ...props, ...intent.writes }, saved = readFlow(savedProps);
    const step = appliedFlowHistory(graph, saved, Object.keys(intent.writes))!, undo = flowIntentWrites(savedProps, saved, step.before);
    const undoneProps = { ...savedProps, ...undo.writes }, undone = readFlow(undoneProps);
    expect(undone.mindStyles?.b).toEqual(graph.mindStyles?.b); expect(undone.mindTextFormats?.b).toBeUndefined();
    const redo = flowIntentWrites(undoneProps, undone, step.after), restored = readFlow({ ...undoneProps, ...redo.writes });
    expect(restored.mindStyles?.b).toEqual(saved.mindStyles?.b); expect(restored.mindTextFormats?.b).toEqual(saved.mindTextFormats?.b);
  });
  it("clears the in-tab style cache when the authentication session changes", async () => {
    vi.resetModules(); vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("BroadcastChannel", undefined);
    const style = await import("./mindmap-text-style"), session = await import("@/lib/session-cache");
    style.setMindTextStyleSession(style.captureMindTextStyle(graph, "a")!); const revision = style.getMindTextStyleSessionRevision();
    expect(style.getMindTextStyleSession()?.format.bold).toBe(true);
    session.announceAuthChange(); expect(style.getMindTextStyleSession()).toBeNull(); expect(style.getMindTextStyleSessionRevision()).toBeGreaterThan(revision);
  });
  it("recognizes Option-modified Mac keys without intercepting ordinary copy", () => {
    const base = { metaKey: true, ctrlKey: false, altKey: true, shiftKey: false };
    expect(mindTextStyleShortcut({ ...base, code: "KeyC", key: "ç" })).toBe("copy");
    expect(mindTextStyleShortcut({ ...base, code: "KeyV", key: "√" })).toBe("paste");
    expect(mindTextStyleShortcut({ ...base, altKey: false, code: "KeyC", key: "c" })).toBeNull();
  });
});
