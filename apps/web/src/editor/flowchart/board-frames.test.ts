import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { flowIntentWrites, flowWrites, readFlow, THEMES, type FlowEdge, type FlowGraph, type FlowNode } from "./model";
import { ReadOnlyDoc } from "@/pages/read-only-doc";
import { mindLayoutPropWrites } from "./mindmap-layouts";
import { FlowchartBlock, FlowSvg } from "./flowchart-block";
import {
  BOARD_FRAME_PROP_PREFIX,
  boardFramePropKey,
  boardFramePropWrites,
  boardFrameStorageKey,
  createBoardFrame,
  exportFrameToSvg,
  loadBoardFrames,
  moveFrameWithContents,
  nodesInsideFrame,
  readBoardFramesFromProps,
  saveBoardFrames,
  type BoardFrame,
} from "./board-frames";

const frame: BoardFrame = {
  id: "fr_1",
  title: "登录流程",
  x: 100,
  y: 100,
  w: 400,
  h: 300,
  bg: "#F8FAFF",
};

const nodes: FlowNode[] = [
  { id: "n1", x: 140, y: 140, w: 120, h: 60, shape: "round", text: "输入账号" },
  { id: "n2", x: 320, y: 260, w: 120, h: 60, shape: "diamond", text: "校验 & 登录" },
  { id: "n_out", x: 560, y: 140, w: 120, h: 60, shape: "rect", text: "外部节点" },
  // Overlaps frame left edge slightly, but center (60, 200) is outside frame.x = 100
  { id: "n_edge", x: 10, y: 170, w: 100, h: 60, shape: "rect", text: "边缘外部" },
];

const edges: FlowEdge[] = [
  { id: "e1", from: "n1", to: "n2", label: "提交" },
  { id: "e_out", from: "n2", to: "n_out", label: "跨界连线" },
];

beforeEach(() => {
  localStorage.removeItem(boardFrameStorageKey("doc-42"));
});

describe("whiteboard frame partitions", () => {
  it("selects only nodes whose center point lies inside the frame bounds", () => {
    const inside = nodesInsideFrame(frame, nodes);
    expect(inside.map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("moves a frame together with all nodes inside it while keeping outside nodes fixed", () => {
    const moved = moveFrameWithContents(frame, nodes, 60, -40);
    expect(moved.frame).toEqual({ ...frame, x: 160, y: 60 });
    expect(moved.movedNodeIds).toEqual(["n1", "n2"]);
    expect(moved.nodes.find((n) => n.id === "n1")).toMatchObject({ x: 200, y: 100 });
    expect(moved.nodes.find((n) => n.id === "n2")).toMatchObject({ x: 380, y: 220 });
    expect(moved.nodes.find((n) => n.id === "n_out")).toMatchObject({ x: 560, y: 140 });
    expect(moved.nodes.find((n) => n.id === "n_edge")).toMatchObject({ x: 10, y: 170 });
  });

  it("exports a standalone SVG cropped strictly to the frame bounds", () => {
    const svg = exportFrameToSvg(frame, nodes, edges, THEMES[0]);
    expect(svg).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(svg).toContain('viewBox="100 100 400 300"');
    expect(svg).toContain('width="400" height="300"');
    expect(svg).toContain("<title>登录流程</title>");
    expect(svg).toContain('data-frame-export-node="n1"');
    expect(svg).toContain('data-frame-export-node="n2"');
    expect(svg).toContain("校验 &amp; 登录");
    expect(svg).toContain('data-frame-export-edge="e1"');
    expect(svg).toContain("提交");
    expect(svg).not.toContain('data-frame-export-node="n_out"');
    expect(svg).not.toContain('data-frame-export-node="n_edge"');
    expect(svg).not.toContain('data-frame-export-edge="e_out"');
  });

  it("creates sequentially named frames and persists them cleanly in localStorage", () => {
    const f1 = createBoardFrame([], { x: 300, y: 250 });
    expect(f1.title).toBe("Frame 1");
    expect(f1.w).toBe(520);
    expect(f1.h).toBe(340);

    const f2 = createBoardFrame([f1], { x: 400, y: 300 });
    expect(f2.title).toBe("Frame 2");

    saveBoardFrames("doc-42", [f1, f2]);
    const loaded = loadBoardFrames("doc-42");
    expect(loaded).toHaveLength(2);
    expect(loaded.map((item) => item.title)).toEqual(["Frame 1", "Frame 2"]);

    // Malformed payloads are ignored safely.
    localStorage.setItem(boardFrameStorageKey("doc-42"), "{bad json");
    expect(loadBoardFrames("doc-42")).toEqual([]);
  });

  it("renders Frame partition headers and single-frame export trigger in FlowSvg", () => {
    const html = renderToStaticMarkup(
      createElement(FlowSvg, {
        graph: { nodes, edges, theme: "feishu" },
        frames: [frame],
        selectedFrameId: frame.id,
        onFrameExport: () => {},
        onFrameDelete: () => {},
      }),
    );
    expect(html).toContain('data-board-frame="fr_1"');
    expect(html).toContain('data-board-frame-header="fr_1"');
    expect(html).toContain('data-board-frame-export="fr_1"');
    expect(html).toContain("登录流程");
    expect(html).toContain("导出分区");
  });

  it("reads and writes minimal CRDT fc.fr.<id> props with tombstones on deletion", () => {
    expect(BOARD_FRAME_PROP_PREFIX).toBe("fc.fr.");
    expect(boardFramePropKey("fr_1")).toBe("fc.fr.fr_1");

    const f2: BoardFrame = { id: "fr_2", title: "支付区", x: 600, y: 120, w: 360, h: 240, bg: "#EEF3FE" };
    const createWrites = boardFramePropWrites([], [frame, f2]);
    expect(Object.keys(createWrites).sort()).toEqual(["fc.fr.fr_1", "fc.fr.fr_2"]);
    expect(readBoardFramesFromProps(createWrites)).toEqual([frame, f2]);

    // Untouched frame is omitted from writes; renamed frame is updated; removed frame gets "" tombstone.
    const renamed: BoardFrame = { ...frame, title: "认证流程" };
    const diffWrites = boardFramePropWrites([frame, f2], [renamed]);
    expect(diffWrites).toEqual({
      "fc.fr.fr_1": JSON.stringify(renamed),
      "fc.fr.fr_2": "",
    });
    expect(readBoardFramesFromProps({ ...createWrites, ...diffWrites })).toEqual([renamed]);

    // Identical frames emit zero writes.
    expect(boardFramePropWrites([renamed], [renamed])).toEqual({});

    // Malformed, invalid-ID, mismatched-ID, and tombstoned entries are ignored safely.
    const noisyProps: Record<string, string> = {
      ...createWrites,
      "fc.fr.fr_2": "",
      "fc.fr.bad id!": JSON.stringify({ id: "bad id!", title: "Bad", x: 0, y: 0, w: 200, h: 200 }),
      "fc.fr.mismatch": JSON.stringify({ id: "other", title: "Mismatch", x: 0, y: 0, w: 200, h: 200 }),
      "fc.fr.corrupt": "{bad json",
      "fc.fr.array": "[]",
    };
    expect(readBoardFramesFromProps(noisyProps)).toEqual([frame]);
  });

  it("syncs concurrent frame edits and atomic frame+node moves across CRDT collaborators", () => {
    const docA = new Doc(1);
    const docB = new Doc(2);
    const baseGraph: FlowGraph = { theme: "feishu", nodes, edges };
    const initTx = new Tx(docA);
    const block = initTx.create("flowchart", null, ROOT, {
      ...flowWrites({}, baseGraph),
      ...boardFramePropWrites([], [frame]),
    });
    for (const op of initTx.ops) docB.apply(op);

    // User A drags frame + contained nodes (n1, n2) in ONE atomic CRDT Tx batch.
    const moved = moveFrameWithContents(frame, baseGraph.nodes, 50, 30);
    const txA = new Tx(docA);
    const nodeIntent = flowIntentWrites(docA.blockInfo(block).props, baseGraph, { ...baseGraph, nodes: moved.nodes });
    const framePatch = boardFramePropWrites([frame], [moved.frame]);
    for (const [k, v] of Object.entries({ ...nodeIntent.writes, ...framePatch })) txA.setProp(block, k, v);

    // User B concurrently adds a second frame.
    const frameB: BoardFrame = { id: "fr_b", title: "对端分区", x: 700, y: 100, w: 300, h: 220, bg: "#F8FAFF" };
    const txB = new Tx(docB);
    for (const [k, v] of Object.entries(boardFramePropWrites([frame], [frame, frameB]))) txB.setProp(block, k, v);

    for (const op of txA.ops) docB.apply(op);
    for (const op of txB.ops) docA.apply(op);

    for (const d of [docA, docB]) {
      const syncedProps = d.blockInfo(block).props;
      const syncedFrames = readBoardFramesFromProps(syncedProps);
      expect(syncedFrames).toEqual([moved.frame, frameB]);
      const syncedGraph = readFlow(syncedProps);
      expect(syncedGraph.nodes.find((n) => n.id === "n1")).toMatchObject({ x: 190, y: 170 });
      expect(syncedGraph.nodes.find((n) => n.id === "n2")).toMatchObject({ x: 370, y: 290 });
      expect(syncedGraph.nodes.find((n) => n.id === "n_out")).toMatchObject({ x: 560, y: 140 });
    }
  });

  it("derives FlowchartBlock preview frames strictly from CRDT blockProps without localStorage", () => {
    saveBoardFrames("doc-42", [{ id: "fr_stale", title: "过期本地缓存", x: 0, y: 0, w: 300, h: 200 }]);
    const crdtProps = boardFramePropWrites([], [frame]);
    const html = renderToStaticMarkup(
      createElement(FlowchartBlock, {
        graph: { nodes, edges, theme: "feishu" },
        blockProps: crdtProps,
        height: 360,
        readOnly: true,
        assets: { docId: 42 },
      }),
    );
    expect(html).toContain('data-board-frame="fr_1"');
    expect(html).toContain("登录流程");
    expect(html).not.toContain("fr_stale");
    expect(html).not.toContain("过期本地缓存");
  });

  it("renders CRDT frames, MindMap structure, and cross-branch relations in ReadOnlyDoc snapshots", () => {
    const blockProps: Record<string, string> = {
      ...boardFramePropWrites([], [frame]),
      "fc.m.r": JSON.stringify({ parent: null, order: 0, text: "总览", x: 100, y: 100 }),
      "fc.m.a": JSON.stringify({ parent: "r", order: 0, text: "前端" }),
      "fc.m.b": JSON.stringify({ parent: "r", order: 1, text: "后端" }),
      ...mindLayoutPropWrites(
        { structure: "logic", relations: [] },
        { structure: "org", relations: [{ id: "mr_ro", fromId: "a", toId: "b", label: "联调" }] },
      ),
    };
    const html = renderToStaticMarkup(
      createElement(ReadOnlyDoc, {
        view: {
          blocks: [{ id: "1:1", type: "flowchart", parent: "0:0", props: blockProps, spans: [] }],
        },
        publicToken: "pub-token",
      }),
    );
    expect(html).toContain('data-board-frame="fr_1"');
    expect(html).toContain("登录流程");
    expect(html).toContain('data-mind-structure="org"');
    expect(html).toContain('data-mind-relation="mr_ro"');
    expect(html).toContain("联调");
    expect(html).not.toContain("空白流程图");
  });
});
