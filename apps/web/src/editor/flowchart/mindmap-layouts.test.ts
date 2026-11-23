import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { layoutMindTopics, type MindTopic } from "./mindmap";
import {
  layoutMindTopicsWithStructure,
  loadMindLayoutConfig,
  mindLayoutStorageKey,
  mindRelationCurvePath,
  mindRelationLabelPoint,
  saveMindLayoutConfig,
  type MindRelation,
} from "./mindmap-layouts";
import { MindMapSvg } from "./mind-map-svg";

const sampleTree: MindTopic[] = [
  { id: "r", parent: null, order: 0, text: "核心目标", x: 400, y: 200 },
  { id: "b1", parent: "r", order: 0, text: "需求分析" },
  { id: "b2", parent: "r", order: 1, text: "技术方案" },
  { id: "b3", parent: "r", order: 2, text: "测试上线" },
  { id: "s1", parent: "b1", order: 0, text: "用户访谈" },
  { id: "s2", parent: "b1", order: 1, text: "竞品调研" },
  { id: "s3", parent: "b2", order: 0, text: "架构设计" },
];

beforeEach(() => {
  localStorage.removeItem(mindLayoutStorageKey("doc-99"));
});

describe("MindMap multi-structure layouts", () => {
  it("delegates logic layout directly to layoutMindTopics for 100% compatibility", () => {
    const collapsed = new Set(["b2"]);
    const styles = { r: { size: 18 } };
    expect(layoutMindTopicsWithStructure(sampleTree, "logic", collapsed, styles)).toEqual(
      layoutMindTopics(sampleTree, collapsed, styles),
    );
  });

  it("arranges org-chart top-down with balanced non-overlapping horizontal subtrees", () => {
    const placed = layoutMindTopicsWithStructure(sampleTree, "org");
    const byId = new Map(placed.map((p) => [p.topic.id, p]));
    const r = byId.get("r")!;
    const b1 = byId.get("b1")!;
    const b2 = byId.get("b2")!;
    const b3 = byId.get("b3")!;
    const s1 = byId.get("s1")!;
    const s2 = byId.get("s2")!;

    expect(b1.y).toBeGreaterThan(r.y + r.h);
    expect(b1.y).toBe(b2.y);
    expect(b2.y).toBe(b3.y);
    expect(b1.x + b1.w).toBeLessThan(b2.x);
    expect(b2.x + b2.w).toBeLessThan(b3.x);
    expect(s1.y).toBeGreaterThan(b1.y + b1.h);
    expect(s1.x + s1.w).toBeLessThan(s2.x);

    // Collapsed branch hides descendants cleanly.
    const folded = layoutMindTopicsWithStructure(sampleTree, "org", new Set(["b1"]));
    expect(folded.some((p) => p.topic.id === "s1")).toBe(false);
    expect(folded.some((p) => p.topic.id === "b1")).toBe(true);
  });

  it("arranges fishbone with root on the right and alternating ribs above/below the spine", () => {
    const placed = layoutMindTopicsWithStructure(sampleTree, "fishbone");
    const byId = new Map(placed.map((p) => [p.topic.id, p]));
    const r = byId.get("r")!;
    const spineY = r.y + r.h / 2;
    const b1 = byId.get("b1")!;
    const b2 = byId.get("b2")!;
    const b3 = byId.get("b3")!;
    const s1 = byId.get("s1")!;
    const s2 = byId.get("s2")!;

    for (const branch of [b1, b2, b3, s1, s2]) {
      expect(branch.x + branch.w).toBeLessThan(r.x);
    }
    // b1 (idx 0) and b3 (idx 2) sit above the spine; b2 (idx 1) sits below.
    expect(b1.y + b1.h).toBeLessThan(spineY);
    expect(b3.y + b3.h).toBeLessThan(spineY);
    expect(b2.y).toBeGreaterThan(spineY);
    // b3 sits cleanly to the left of b1's rib without horizontal overlap.
    expect(b3.x + b3.w).toBeLessThan(Math.min(b1.x, s1.x, s2.x));
    // Subtopics of b1 are stacked above spine without overlapping vertically.
    expect(s1.y + s1.h).toBeLessThan(spineY);
    expect(s2.y + s2.h).toBeLessThanOrEqual(s1.y);
  });

  it("arranges timeline horizontally left-to-right alternating above and below the axis", () => {
    const placed = layoutMindTopicsWithStructure(sampleTree, "timeline");
    const byId = new Map(placed.map((p) => [p.topic.id, p]));
    const r = byId.get("r")!;
    const axisY = r.y + r.h / 2;
    const b1 = byId.get("b1")!;
    const b2 = byId.get("b2")!;
    const b3 = byId.get("b3")!;
    const s1 = byId.get("s1")!;

    expect(b1.x).toBeGreaterThan(r.x + r.w);
    expect(b2.x).toBeGreaterThan(b1.x + b1.w);
    expect(b3.x).toBeGreaterThan(b2.x + b2.w);
    expect(b1.y + b1.h).toBeLessThan(axisY);
    expect(b2.y).toBeGreaterThan(axisY);
    expect(b3.y + b3.h).toBeLessThan(axisY);
    expect(s1.y + s1.h).toBeLessThan(b1.y);
  });

  it("computes smooth quadratic bezier cross-branch relation curves and persists config", () => {
    const placed = layoutMindTopicsWithStructure(sampleTree, "org");
    const from = placed.find((p) => p.topic.id === "s1")!;
    const to = placed.find((p) => p.topic.id === "s3")!;
    const d = mindRelationCurvePath(from, to);
    expect(d).toMatch(/^M-?\d+(\.\d+)?,-?\d+(\.\d+)? Q-?\d+(\.\d+)?,-?\d+(\.\d+)? -?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
    expect(d).not.toContain("NaN");

    const mid = mindRelationLabelPoint(from, to);
    expect(Number.isFinite(mid.x)).toBe(true);
    expect(Number.isFinite(mid.y)).toBe(true);

    // Coincident boxes still produce a valid finite curve.
    expect(mindRelationCurvePath(from, from)).not.toContain("NaN");

    const relations: MindRelation[] = [{ id: "mr_1", fromId: "s1", toId: "s3", label: "依赖" }];
    saveMindLayoutConfig("doc-99", { structure: "timeline", relations });
    expect(loadMindLayoutConfig("doc-99")).toEqual({ structure: "timeline", relations });
  });

  it("renders MindMapSvg with multi-structure connectors and dashed cross-branch relation arrows", () => {
    const relations: MindRelation[] = [{ id: "mr_1", fromId: "s1", toId: "s3", label: "依赖" }];
    const fishHtml = renderToStaticMarkup(
      createElement("svg", null, createElement(MindMapSvg, { topics: sampleTree, structure: "fishbone", relations })),
    );
    expect(fishHtml).toContain('data-mind-structure="fishbone"');
    expect(fishHtml).toContain('data-mind-fishbone-spine="r"');
    expect(fishHtml).toContain('data-mind-relation="mr_1"');
    expect(fishHtml).toContain('stroke-dasharray="6 4"');
    expect(fishHtml).toContain("依赖");

    const timelineHtml = renderToStaticMarkup(
      createElement("svg", null, createElement(MindMapSvg, { topics: sampleTree, structure: "timeline", relations })),
    );
    expect(timelineHtml).toContain('data-mind-structure="timeline"');
    expect(timelineHtml).toContain('data-mind-timeline-spine="r"');
  });
});
