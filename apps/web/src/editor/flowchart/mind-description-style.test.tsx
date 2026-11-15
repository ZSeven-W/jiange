import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { appliedFlowHistory } from "./history";
import { MindMapSvg } from "./mind-map-svg";
import { copyMindBranch, parseMindClip, pasteMindBranch } from "./mindmap-clipboard";
import { flowIntentWrites, flowWrites, readFlow, type FlowGraph } from "./model";
import { describeUnappliedFlows } from "./recovery";

const base: FlowGraph = { nodes: [], edges: [], theme: "feishu", mind: [{ id: "r", parent: null, order: 0, text: "主题", x: 0, y: 0 }, { id: "c", parent: "r", order: 0, text: "需求" }], mindDescriptions: { c: "第一行\n第二行" }, mindStyles: { c: { size: 14, color: "#1f2329" } } };
const style = { size: 18, color: "#d83931", highlight: "#fff5c7" };

describe("mind description styling", () => {
  it("persists separately from the node title and protects concurrent changes", () => {
    const props = flowWrites({}, base), next = { ...base, mindDescriptionStyles: { c: style } }, applied = flowIntentWrites(props, base, next), savedProps = { ...props, ...applied.writes }, saved = readFlow(savedProps);
    expect(saved.mindDescriptionStyles?.c).toEqual(style);
    expect(saved.mindStyles?.c).toEqual(base.mindStyles?.c);
    const stale = flowIntentWrites(savedProps, base, { ...base, mindDescriptionStyles: { c: { size: 24 } } });
    expect(stale.conflicts).toContain("fc.mds.c");
    expect(stale.writes["fc.mds.c"]).toBeUndefined();
    const remove = flowIntentWrites(savedProps, base, { ...base, mind: [base.mind![0]] });
    expect(remove.conflicts).toContain("fc.m.c");
    expect(remove.writes["fc.m.c"]).toBeUndefined();
    expect(describeUnappliedFlows([{ before: base, proposed: next, conflicts: ["fc.mds.c"] }])).toContain("#d83931");
  });
  it("undoes and redoes a description style without changing its text", () => {
    const props = flowWrites({}, base), next = { ...base, mindDescriptionStyles: { c: style } }, applied = flowIntentWrites(props, base, next), savedProps = { ...props, ...applied.writes }, saved = readFlow(savedProps);
    const history = appliedFlowHistory(base, saved, Object.keys(applied.writes))!;
    const undo = flowIntentWrites(savedProps, history.after, history.before), undoneProps = { ...savedProps, ...undo.writes }, undone = readFlow(undoneProps);
    expect(undone.mindDescriptionStyles?.c).toBeUndefined();
    expect(undone.mindDescriptions?.c).toBe(base.mindDescriptions?.c);
    const redo = flowIntentWrites(undoneProps, history.before, history.after);
    expect(readFlow({ ...undoneProps, ...redo.writes }).mindDescriptionStyles?.c).toEqual(style);
  });
  it("copies description styles in a version older clients reject", () => {
    const graph = { ...base, mindDescriptionStyles: { c: style } }, clip = copyMindBranch(graph, "c")!;
    expect(clip.version).toBe(3);
    expect(parseMindClip(JSON.stringify(clip))?.descriptionStyles?.c).toEqual(style);
    expect(parseMindClip(JSON.stringify({ ...clip, version: 2 }))).toBeNull();
    const inserted = pasteMindBranch(base, clip, "r", "c", { x: 0, y: 0 }, () => "copy")!;
    const change = flowIntentWrites(flowWrites({}, base), base, inserted.graph);
    expect(readFlow({ ...flowWrites({}, base), ...change.writes }).mindDescriptionStyles?.copy).toEqual(style);
  });
  it("renders the description with its own font, color and highlight", () => {
    const html = renderToStaticMarkup(<svg><MindMapSvg topics={base.mind!} styles={base.mindStyles} descriptions={base.mindDescriptions} descriptionStyles={{ c: style }}/></svg>);
    expect(html).toContain('font-size="18"');
    expect(html).toContain('fill="#d83931"');
    expect(html).toContain('fill="#fff5c7"');
    expect(html).toContain('font-size="14"');
  });
  it("does not combine a concurrent large font with a description that would exceed the line limit", () => {
    const long = "字".repeat(400);
    const remoteLarge = { ...base, mindDescriptionStyles: { c: { size: 96 } } };
    const localText = { ...base, mindDescriptions: { c: long } };
    const textChange = flowIntentWrites(flowWrites({}, remoteLarge), base, localText);
    expect(textChange.conflicts).toContain("fc.md.c");
    expect(textChange.writes["fc.md.c"]).toBeUndefined();
    const remoteText = { ...base, mindDescriptions: { c: long } };
    const styleChange = flowIntentWrites(flowWrites({}, remoteText), base, remoteLarge);
    expect(styleChange.conflicts).toContain("fc.mds.c");
    expect(styleChange.writes["fc.mds.c"]).toBeUndefined();
  });
  it("preserves description styles when older clients edit the node label", () => {
    const graph: FlowGraph = { ...base, mindDescriptionStyles: { c: style } }, props = flowWrites({}, graph);
    const old: FlowGraph = { ...graph }; delete old.mindDescriptionStyles;
    const renamed = { ...old, mind: old.mind!.map((topic) => topic.id === "c" ? { ...topic, text: "改名" } : topic) };
    const change = flowIntentWrites(props, old, renamed);
    expect(readFlow({ ...props, ...change.writes }).mindDescriptionStyles?.c).toEqual(style);
  });
  it("protects unreadable future style data from edits and node deletion", () => {
    const props = { ...flowWrites({}, base), "fc.mds.c": '{"future":true}' };
    const edit = flowIntentWrites(props, base, { ...base, mindDescriptionStyles: { c: style } });
    expect(edit.conflicts).toContain("fc.mds.c");
    expect(edit.writes["fc.mds.c"]).toBeUndefined();
    const remove = flowIntentWrites(props, base, { ...base, mind: [base.mind![0]] });
    expect(remove.conflicts).toContain("fc.m.c");
    expect(remove.writes["fc.m.c"]).toBeUndefined();
  });
});
