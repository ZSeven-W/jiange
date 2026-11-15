import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { appliedFlowHistory } from "./history";
import { MindMapSvg } from "./mind-map-svg";
import { copyMindBranch, parseMindClip, pasteMindBranch } from "./mindmap-clipboard";
import { flowIntentWrites, flowWrites, readFlow, type FlowGraph } from "./model";
import { describeUnappliedFlows } from "./recovery";
import { canonicalMindDescription, mindDescriptionAt, mindDescriptionLines } from "./mindmap";

const base: FlowGraph = { nodes: [], edges: [], theme: "feishu", mind: [{ id: "r", parent: null, order: 0, text: "主题", x: 0, y: 0 }, { id: "c", parent: "r", order: 0, text: "需求" }] };

describe("mind node descriptions", () => {
  it("persists separately and protects concurrent edits or deletion", () => {
    const next = { ...base, mindDescriptions: { c: "第一行\n第二行" } }, props = flowWrites({}, base);
    const change = flowIntentWrites(props, base, next);
    expect(change.writes["fc.md.c"]).toBe(JSON.stringify("第一行\n第二行"));
    const savedProps = { ...props, ...change.writes }, saved = readFlow(savedProps);
    expect(saved.mindDescriptions?.c).toBe("第一行\n第二行");
    const stale = flowIntentWrites(savedProps, base, { ...base, mindDescriptions: { c: "本地" } });
    expect(stale.conflicts).toContain("fc.md.c");
    expect(stale.writes["fc.md.c"]).toBeUndefined();
    const deleting = flowIntentWrites(savedProps, base, { ...base, mind: [base.mind![0]] });
    expect(deleting.conflicts).toContain("fc.m.c");
    expect(deleting.writes["fc.m.c"]).toBeUndefined();
    expect(describeUnappliedFlows([{ before: base, proposed: { ...base, mindDescriptions: { c: "本地" } }, conflicts: ["fc.md.c"] }])).toContain("本地");
  });
  it("undoes and redoes only the description that was applied", () => {
    const props = flowWrites({}, base), next = { ...base, mindDescriptions: { c: "说明" } };
    const applied = flowIntentWrites(props, base, next), savedProps = { ...props, ...applied.writes }, saved = readFlow(savedProps);
    const history = appliedFlowHistory(base, saved, Object.keys(applied.writes))!;
    const undo = flowIntentWrites(savedProps, history.after, history.before);
    const undoneProps = { ...savedProps, ...undo.writes }, undone = readFlow(undoneProps);
    expect(undone.mindDescriptions?.c).toBeUndefined();
    const redo = flowIntentWrites(undoneProps, history.before, history.after);
    expect(readFlow({ ...undoneProps, ...redo.writes }).mindDescriptions?.c).toBe("说明");
  });
  it("retains description through node deletion and undo, and through older label edits", () => {
    const withDescription: FlowGraph = { ...base, mindDescriptions: { c: "说明" } }, props = flowWrites({}, withDescription);
    const oldClient: FlowGraph = { ...withDescription }; delete oldClient.mindDescriptions;
    const renamed = { ...oldClient, mind: oldClient.mind!.map((topic) => topic.id === "c" ? { ...topic, text: "改名" } : topic) };
    const oldEdit = flowIntentWrites(props, oldClient, renamed);
    expect(readFlow({ ...props, ...oldEdit.writes }).mindDescriptions?.c).toBe("说明");
    const removed = { ...withDescription, mind: [withDescription.mind![0]] };
    const del = flowIntentWrites(props, withDescription, removed), afterProps = { ...props, ...del.writes }, after = readFlow(afterProps);
    const history = appliedFlowHistory(withDescription, after, Object.keys(del.writes))!;
    const undo = flowIntentWrites(afterProps, history.after, history.before);
    expect(readFlow({ ...afterProps, ...undo.writes }).mindDescriptions?.c).toBe("说明");
  });
  it("copies descriptions with a version older clients reject", () => {
    const graph = { ...base, mindDescriptions: { c: "保留描述" } }, clip = copyMindBranch(graph, "c")!;
    expect(clip.version).toBe(2);
    expect(parseMindClip(JSON.stringify(clip))?.descriptions?.c).toBe("保留描述");
    expect(parseMindClip(JSON.stringify({ ...clip, version: 1 }))).toBeNull();
    const inserted = pasteMindBranch(base, clip, "r", "c", { x: 0, y: 0 }, () => "copy")!;
    expect(inserted.graph.mindDescriptions?.copy).toBe("保留描述");
    const result = flowIntentWrites(flowWrites({}, base), base, inserted.graph);
    expect(readFlow({ ...flowWrites({}, base), ...result.writes }).mindDescriptions?.copy).toBe("保留描述");
  });
  it("renders description inside the node in muted text", () => {
    const html = renderToStaticMarkup(<svg><MindMapSvg topics={base.mind!} descriptions={{ c: "项目背景\n第二行" }}/></svg>);
    expect(html).toContain("data-mind-description");
    expect(html).toContain("项目背景");
    expect(html).toContain("第二行");
    expect(html).toContain('fill="#8f959e"');
  });
  it("keeps permitted long descriptions visible and rejects excessive line counts", () => {
    const description = Array.from({ length: 20 }, (_, i) => `第${i + 1}行`).join("\n");
    expect(mindDescriptionLines(description)).toHaveLength(20);
    expect(canonicalMindDescription(description)).not.toBeNull();
    expect(canonicalMindDescription("\n".repeat(128))).toBeNull();
    const html = renderToStaticMarkup(<svg><MindMapSvg topics={base.mind!} descriptions={{ c: description }}/></svg>);
    expect(html).toContain("第20行");
  });
  it("handles node ids that are also object prototype names", () => {
    const graph: FlowGraph = { ...base, mind: [{ id: "constructor", parent: null, order: 0, text: "主题", x: 0, y: 0 }], mindDescriptions: { ["constructor"]: "描述" } };
    const saved = readFlow(flowWrites({}, graph));
    expect(mindDescriptionAt(saved.mindDescriptions, "constructor")).toBe("描述");
    expect(mindDescriptionAt({}, "constructor")).toBeUndefined();
  });
  it("does not overwrite or delete an unreadable newer description", () => {
    const props = { ...flowWrites({}, base), "fc.md.c": '{"future":"data"}' };
    const edit = flowIntentWrites(props, base, { ...base, mindDescriptions: { c: "新描述" } });
    expect(edit.conflicts).toContain("fc.md.c");
    expect(edit.writes["fc.md.c"]).toBeUndefined();
    const remove = flowIntentWrites(props, base, { ...base, mind: [base.mind![0]] });
    expect(remove.conflicts).toContain("fc.m.c");
    expect(remove.writes["fc.m.c"]).toBeUndefined();
  });
});
