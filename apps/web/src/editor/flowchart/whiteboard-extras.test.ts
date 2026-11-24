import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { ReadOnlyDoc } from "@/pages/read-only-doc";
import { boardContentBounds, FlowchartBlock, FlowSvg } from "./flowchart-block";
import { MindMapSvg } from "./mind-map-svg";
import { formatCountdown, WhiteboardMinimap, WhiteboardTimer } from "./whiteboard-minimap";
import { flowWrites, readFlow, type FlowGraph, type FlowNode } from "./model";
import type { MindTopic } from "./mindmap";
import { layoutMindTopicsWithStructure } from "./mindmap-layouts";
import {
  BOARD_VOTE_PROP_PREFIX,
  boardVotePropKey,
  boardVotePropWrites,
  computeBoundaryBox,
  computeSummaryBrace,
  createStickyNode,
  EMPTY_WHITEBOARD_EXTRAS,
  MIND_BADGE_PROP_PREFIX,
  MIND_BOUNDARY_PROP_PREFIX,
  MIND_SUMMARY_PROP_PREFIX,
  mindBadgePropKey,
  mindBadgePropWrites,
  mindBoundaryPropKey,
  mindBoundaryPropWrites,
  mindSummaryPropKey,
  mindSummaryPropWrites,
  priorityBadgeMeta,
  progressWedgePath,
  readBoardVotesFromProps,
  readMindBadgesFromProps,
  readMindBoundariesFromProps,
  readMindSummariesFromProps,
  readWhiteboardExtrasFromProps,
  STICKY_DEFAULT_SIZE,
  STICKY_PRESETS,
  stickyPresetForFill,
  toggleNodeVote,
  topVotedNodes,
  whiteboardExtrasPropWrites,
  type WhiteboardExtras,
} from "./whiteboard-extras";

const sampleMind: MindTopic[] = [
  { id: "r", parent: null, order: 0, text: "年度规划", x: 100, y: 120 },
  { id: "b1", parent: "r", order: 0, text: "产品迭代" },
  { id: "b2", parent: "r", order: 1, text: "增长拉新" },
  { id: "s1", parent: "b1", order: 0, text: "白板升级" },
  { id: "s2", parent: "b1", order: 1, text: "导图大纲" },
];

describe("whiteboard sticky notes & presets", () => {
  it("exports 5 Feishu warm pastel presets and round-trips sticky nodes through CRDT props", () => {
    expect(STICKY_PRESETS).toHaveLength(5);
    expect(STICKY_PRESETS.map((p) => p.fill)).toEqual([
      "#fff3b0",
      "#ffd6e7",
      "#d9f4e6",
      "#dcebff",
      "#efe4ff",
    ]);
    expect(stickyPresetForFill("#FFD6E7").id).toBe("pink");
    expect(stickyPresetForFill("#000000").id).toBe("yellow");

    const sticky = createStickyNode({ x: 240, y: 180 }, [], STICKY_PRESETS[1]);
    expect(sticky.shape).toBe("sticky");
    expect(sticky.w).toBe(STICKY_DEFAULT_SIZE.w);
    expect(sticky.h).toBe(STICKY_DEFAULT_SIZE.h);
    expect(sticky.fill).toBe("#ffd6e7");
    expect(sticky.x).toBe(150);
    expect(sticky.y).toBe(105);

    const graph: FlowGraph = { theme: "feishu", nodes: [{ ...sticky, text: "头脑风暴灵感" }], edges: [] };
    const props = flowWrites({}, graph);
    const restored = readFlow(props);
    expect(restored.nodes).toHaveLength(1);
    expect(restored.nodes[0]).toMatchObject({
      shape: "sticky",
      w: 180,
      h: 150,
      fill: "#ffd6e7",
      text: "头脑风暴灵感",
    });

    const html = renderToStaticMarkup(createElement(FlowSvg, { graph: restored }));
    expect(html).toContain(`data-sticky-shape="${sticky.id}"`);
    expect(html).toContain("sticky-shadow");
    expect(html).toContain("头脑风暴灵感");
  });
});

describe("CRDT team voting (fc.vt.*)", () => {
  const nodes: FlowNode[] = [
    { id: "st1", shape: "sticky", x: 0, y: 0, w: 180, h: 150, text: "方案A\n细节", fill: "#fff3b0" },
    { id: "st2", shape: "sticky", x: 220, y: 0, w: 180, h: 150, text: "方案B", fill: "#dcebff" },
    { id: "n1", shape: "rect", x: 440, y: 0, w: 140, h: 60, text: "" },
  ];

  it("toggles votes, writes minimal CRDT tombstones, ranks top voted cards, and converges across peers", () => {
    expect(BOARD_VOTE_PROP_PREFIX).toBe("fc.vt.");
    expect(boardVotePropKey("st1")).toBe("fc.vt.st1");

    let votes = toggleNodeVote({}, "st1", "u2");
    votes = toggleNodeVote(votes, "st1", "u1");
    votes = toggleNodeVote(votes, "st2", "u1");
    expect(votes).toEqual({ st1: ["u1", "u2"], st2: ["u1"] });

    const ranked = topVotedNodes(votes, nodes, 5);
    expect(ranked.map((r) => [r.nodeId, r.label, r.count])).toEqual([
      ["st1", "方案A", 2],
      ["st2", "方案B", 1],
    ]);

    const writes = boardVotePropWrites({}, votes);
    expect(writes).toEqual({
      "fc.vt.st1": JSON.stringify({ voters: ["u1", "u2"] }),
      "fc.vt.st2": JSON.stringify({ voters: ["u1"] }),
    });
    expect(readBoardVotesFromProps(writes)).toEqual(votes);

    // Toggling off the only voter on st2 emits a "" tombstone.
    const nextVotes = toggleNodeVote(votes, "st2", "u1");
    expect(boardVotePropWrites(votes, nextVotes)).toEqual({ "fc.vt.st2": "" });
    expect(readBoardVotesFromProps({ ...writes, "fc.vt.st2": "" })).toEqual({ st1: ["u1", "u2"] });

    // Malformed / invalid entries are ignored safely.
    expect(
      readBoardVotesFromProps({
        ...writes,
        "fc.vt.bad id!": '{"voters":["u1"]}',
        "fc.vt.corrupt": "{bad",
        "fc.vt.empty": '{"voters":[]}',
      }),
    ).toEqual(votes);

    // 2-peer CRDT convergence on concurrent votes on different stickies
    const docA = new Doc(1);
    const docB = new Doc(2);
    const initTx = new Tx(docA);
    const block = initTx.create("flowchart", null, ROOT, flowWrites({}, { theme: "feishu", nodes, edges: [] }));
    for (const op of initTx.ops) docB.apply(op);

    const txA = new Tx(docA);
    for (const [k, v] of Object.entries(boardVotePropWrites({}, { st1: ["u1"] }))) txA.setProp(block, k, v);
    const txB = new Tx(docB);
    for (const [k, v] of Object.entries(boardVotePropWrites({}, { st2: ["u2"] }))) txB.setProp(block, k, v);

    for (const op of txA.ops) docB.apply(op);
    for (const op of txB.ops) docA.apply(op);

    expect(readBoardVotesFromProps(docA.blockInfo(block).props)).toEqual({ st1: ["u1"], st2: ["u2"] });
    expect(readBoardVotesFromProps(docB.blockInfo(block).props)).toEqual({ st1: ["u1"], st2: ["u2"] });

    const svgHtml = renderToStaticMarkup(
      createElement(FlowSvg, {
        graph: { theme: "feishu", nodes, edges: [] },
        votes,
        currentUserId: "u1",
      }),
    );
    expect(svgHtml).toContain('data-board-vote-badge="st1"');
    expect(svgHtml).toContain('data-board-vote-count="2"');
    expect(svgHtml).toContain("👍 2");
  });
});

describe("CRDT MindMap boundaries (fc.mb.*), summaries (fc.msu.*), and badges (fc.mg.*)", () => {
  it("encodes, decodes, tombstones, and never collides with fc.ms.* MindStyle", () => {
    expect(MIND_BOUNDARY_PROP_PREFIX).toBe("fc.mb.");
    expect(MIND_SUMMARY_PROP_PREFIX).toBe("fc.msu.");
    expect(MIND_BADGE_PROP_PREFIX).toBe("fc.mg.");
    expect(mindBoundaryPropKey("b1")).toBe("fc.mb.b1");
    expect(mindSummaryPropKey("r")).toBe("fc.msu.r");
    expect(mindBadgePropKey("s1")).toBe("fc.mg.s1");

    const extras: WhiteboardExtras = {
      votes: {},
      mindBoundaries: { b1: { label: "阶段一", color: "#3370ff" } },
      mindSummaries: { r: { label: "核心结论", color: "#722ed1" } },
      mindBadges: { s1: { priority: 1, progress: 50, tag: "核心" }, s2: { progress: 100 } },
    };

    const props: Record<string, string> = {
      ...flowWrites({}, { theme: "feishu", nodes: [], edges: [], mind: sampleMind, mindStyles: { r: { shape: "rect", size: 18 } } }),
      ...whiteboardExtrasPropWrites(EMPTY_WHITEBOARD_EXTRAS, extras),
    };
    // Verify MindStyle fc.ms.r and MindSummary fc.msu.r coexist cleanly!
    expect(props["fc.ms.r"]).toBe(JSON.stringify({ shape: "rect", size: 18 }));
    expect(props["fc.msu.r"]).toBe(JSON.stringify({ label: "核心结论", color: "#722ed1" }));
    expect(readFlow(props).mindStyles?.r).toEqual({ shape: "rect", size: 18 });
    expect(readWhiteboardExtrasFromProps(props)).toEqual(extras);

    // Tombstone removals emit ""
    expect(mindBoundaryPropWrites(extras.mindBoundaries, {})).toEqual({ "fc.mb.b1": "" });
    expect(mindSummaryPropWrites(extras.mindSummaries, {})).toEqual({ "fc.msu.r": "" });
    expect(mindBadgePropWrites(extras.mindBadges, { s2: { progress: 100 } })).toEqual({ "fc.mg.s1": "" });

    // Malformed payloads are ignored safely
    expect(
      readMindBoundariesFromProps({ "fc.mb.b1": '{"color":"invalid"}', "fc.mb.b2": "{bad" }),
    ).toEqual({});
    expect(
      readMindSummariesFromProps({ "fc.msu.r": '{"color":"bad"}', "fc.msu.x": "[]" }),
    ).toEqual({});
    expect(
      readMindBadgesFromProps({
        "fc.mg.a": '{"priority":9}',
        "fc.mg.b": '{"progress":33}',
        "fc.mg.c": `{"tag":"${"字".repeat(17)}"}`,
        "fc.mg.d": "{}",
      }),
    ).toEqual({});
  });

  it("computes boundary boxes, cubic bezier summary braces across structures, and badge SVG geometry", () => {
    const placedLogic = layoutMindTopicsWithStructure(sampleMind, "logic");
    const box = computeBoundaryBox("b1", sampleMind, placedLogic);
    expect(box).not.toBeNull();
    const b1 = placedLogic.find((p) => p.topic.id === "b1")!;
    const s2 = placedLogic.find((p) => p.topic.id === "s2")!;
    expect(box!.x).toBeLessThan(b1.x);
    expect(box!.x + box!.w).toBeGreaterThan(s2.x + s2.w);
    expect(box!.y).toBeLessThan(b1.y);
    expect(box!.y + box!.h).toBeGreaterThan(s2.y + s2.h);

    for (const structure of ["logic", "org", "fishbone", "timeline"] as const) {
      const placed = layoutMindTopicsWithStructure(sampleMind, structure);
      const brace = computeSummaryBrace("r", sampleMind, placed, structure, "核心结论");
      expect(brace).not.toBeNull();
      expect(brace!.path).toContain(" C");
      expect(brace!.path).not.toContain("NaN");
    }

    expect(priorityBadgeMeta(1).label).toBe("P1");
    expect(priorityBadgeMeta(2).label).toBe("P2");
    expect(priorityBadgeMeta(3).label).toBe("P3");
    expect(progressWedgePath(6, 6, 4, 0)).toBe("");
    expect(progressWedgePath(6, 6, 4, 50)).toContain("A4,4");
    expect(progressWedgePath(6, 6, 4, 100)).toContain("A4,4");

    const svgHtml = renderToStaticMarkup(
      createElement(
        "svg",
        null,
        createElement(MindMapSvg, {
          topics: sampleMind,
          boundaries: { b1: { label: "阶段一", color: "#3370ff" } },
          summaries: { r: { label: "核心结论", color: "#722ed1" } },
          badges: { s1: { priority: 1, progress: 50, tag: "核心" } },
        }),
      ),
    );
    expect(svgHtml).toContain('data-mind-boundary="b1"');
    expect(svgHtml).toContain("阶段一");
    expect(svgHtml).toContain('data-mind-summary="r"');
    expect(svgHtml).toContain("核心结论");
    expect(svgHtml).toContain('data-mind-badge="s1"');
    expect(svgHtml).toContain("P1");
    expect(svgHtml).toContain("50%");
    expect(svgHtml).toContain("核心");

    // boardContentBounds expands to cover boundaries and summaries
    const baseBounds = boardContentBounds({ theme: "feishu", nodes: [], edges: [], mind: sampleMind });
    const extendedBounds = boardContentBounds(
      { theme: "feishu", nodes: [], edges: [], mind: sampleMind },
      "logic",
      [],
      undefined,
      undefined,
      { b1: { label: "阶段一", color: "#3370ff" } },
      { r: { label: "核心结论", color: "#722ed1" } },
      { s1: { priority: 1, progress: 50, tag: "核心" } },
    );
    expect(extendedBounds.w).toBeGreaterThan(baseBounds.w);
  });

  it("renders sticky notes, votes, boundaries, summaries, and badges identically in FlowchartBlock and ReadOnlyDoc", () => {
    const sticky = createStickyNode({ x: 120, y: 120 }, [], STICKY_PRESETS[0]);
    const stickyWithText = { ...sticky, text: "便利贴卡片" };
    const graph: FlowGraph = {
      theme: "feishu",
      nodes: [stickyWithText],
      edges: [],
      mind: sampleMind,
    };
    const extras: WhiteboardExtras = {
      votes: { [sticky.id]: ["u1", "u2"] },
      mindBoundaries: { b1: { label: "核心研发", color: "#3370ff" } },
      mindSummaries: { r: { label: "全年总结", color: "#722ed1" } },
      mindBadges: { s1: { priority: 2, progress: 75, tag: "里程碑" } },
    };
    const blockProps: Record<string, string> = {
      ...flowWrites({}, graph),
      ...whiteboardExtrasPropWrites(EMPTY_WHITEBOARD_EXTRAS, extras),
    };

    const previewHtml = renderToStaticMarkup(
      createElement(FlowchartBlock, {
        graph,
        blockProps,
        height: 360,
        readOnly: true,
      }),
    );
    const readOnlyHtml = renderToStaticMarkup(
      createElement(ReadOnlyDoc, {
        view: {
          blocks: [{ id: "1:1", type: "flowchart", parent: "0:0", props: blockProps, spans: [] }],
        },
        publicToken: "pub-tok",
      }),
    );

    for (const html of [previewHtml, readOnlyHtml]) {
      expect(html).toContain(`data-sticky-shape="${sticky.id}"`);
      expect(html).toContain("便利贴卡片");
      expect(html).toContain(`data-board-vote-badge="${sticky.id}"`);
      expect(html).toContain("👍 2");
      expect(html).toContain('data-mind-boundary="b1"');
      expect(html).toContain("核心研发");
      expect(html).toContain('data-mind-summary="r"');
      expect(html).toContain("全年总结");
      expect(html).toContain('data-mind-badge="s1"');
      expect(html).toContain("P2");
      expect(html).toContain("75%");
      expect(html).toContain("里程碑");
    }
  });
});

describe("WhiteboardMinimap & WhiteboardTimer", () => {
  it("plots nodes, stickies, frames, mind topics and current viewport box in WhiteboardMinimap", () => {
    const sticky = createStickyNode({ x: 300, y: 200 }, [], STICKY_PRESETS[2]);
    const graph: FlowGraph = {
      theme: "feishu",
      nodes: [sticky, { id: "n1", shape: "rect", x: 0, y: 0, w: 140, h: 60, text: "节点" }],
      edges: [],
      mind: sampleMind,
    };
    const html = renderToStaticMarkup(
      createElement(WhiteboardMinimap, {
        graph,
        frames: [{ id: "fr1", title: "分区", x: -40, y: -40, w: 500, h: 360 }],
        view: { x: -80, y: -60, zoom: 1 },
        viewportSize: { w: 1200, h: 800 },
        onPanTo: () => {},
      }),
    );
    expect(html).toContain("data-board-minimap");
    expect(html).toContain('data-board-minimap-viewport="true"');
    expect(html).toContain(`data-minimap-node="${sticky.id}"`);
    expect(html).toContain('data-minimap-frame="fr1"');
    expect(html).toContain('data-minimap-mind="r"');
  });

  it("formats countdown durations and renders presets & expired pulse state in WhiteboardTimer", () => {
    expect(formatCountdown(300)).toBe("05:00");
    expect(formatCountdown(65)).toBe("01:05");
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(-5)).toBe("00:00");

    const activeHtml = renderToStaticMarkup(createElement(WhiteboardTimer, { initialSeconds: 300 }));
    expect(activeHtml).toContain("data-board-timer");
    expect(activeHtml).toContain("05:00");
    expect(activeHtml).toContain("1分");
    expect(activeHtml).toContain("3分");
    expect(activeHtml).toContain("5分");
    expect(activeHtml).toContain("10分");
    expect(activeHtml).not.toContain('data-board-timer-expired="true"');

    const expiredHtml = renderToStaticMarkup(createElement(WhiteboardTimer, { initialSeconds: 0 }));
    expect(expiredHtml).toContain('data-board-timer-expired="true"');
    expect(expiredHtml).toContain("animate-pulse");
    expect(expiredHtml).toContain("00:00");
    expect(expiredHtml).toContain("时间到");
  });
});
