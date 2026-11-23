import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { THEMES, type FlowEdge, type FlowNode } from "./model";
import { FlowSvg } from "./flowchart-block";
import {
  boardFrameStorageKey,
  createBoardFrame,
  exportFrameToSvg,
  loadBoardFrames,
  moveFrameWithContents,
  nodesInsideFrame,
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
});
