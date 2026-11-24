import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOutlineRows, MindMapOutlineView, resolveOutlineKeyAction } from "./mindmap-outline";
import type { MindTopic } from "./mindmap";

const sampleTopics: MindTopic[] = [
  { id: "r", parent: null, order: 0, text: "中心主题", x: 100, y: 100 },
  { id: "b1", parent: "r", order: 0, text: "分支一" },
  { id: "b2", parent: "r", order: 1, text: "分支二" },
  { id: "s1", parent: "b1", order: 0, text: "子项A" },
];

describe("MindMapOutlineView bidirectional outline editor", () => {
  it("builds deterministic indented rows with branch colors and respects collapsed branches", () => {
    const rows = buildOutlineRows(sampleTopics);
    expect(rows.map((r) => [r.topic.id, r.depth, r.childCount])).toEqual([
      ["r", 0, 2],
      ["b1", 1, 1],
      ["s1", 2, 0],
      ["b2", 1, 0],
    ]);
    // Subtree inherits branch color from depth-1 branch
    expect(rows[1].branchColor).toBe(rows[2].branchColor);
    expect(rows[1].branchColor).not.toBe(rows[3].branchColor);

    const folded = buildOutlineRows(sampleTopics, new Set(["b1"]));
    expect(folded.map((r) => r.topic.id)).toEqual(["r", "b1", "b2"]);
    expect(folded[1].folded).toBe(true);
    expect(folded[1].childCount).toBe(1);
  });

  it("resolves Enter sibling, Tab child, root Enter child, Backspace empty delete, and IME guards", () => {
    const root = sampleTopics[0];
    const branch = sampleTopics[1];
    const emptyBranch: MindTopic = { id: "empty", parent: "r", order: 2, text: "" };

    expect(resolveOutlineKeyAction("Enter", branch)).toBe("add-sibling");
    expect(resolveOutlineKeyAction("Enter", root)).toBe("add-child");
    expect(resolveOutlineKeyAction("Tab", branch)).toBe("add-child");
    expect(resolveOutlineKeyAction("Tab", branch, { shiftKey: true })).toBeNull();
    expect(resolveOutlineKeyAction("Backspace", emptyBranch)).toBe("delete");
    expect(resolveOutlineKeyAction("Backspace", branch)).toBeNull();
    expect(resolveOutlineKeyAction("Backspace", { ...root, text: "" })).toBeNull();
    expect(resolveOutlineKeyAction("Enter", branch, { isComposing: true })).toBeNull();
  });

  it("renders indented hierarchy, branch badges, boundaries, summaries, and collapsed descendant counts", () => {
    const html = renderToStaticMarkup(
      createElement(MindMapOutlineView, {
        topics: sampleTopics,
        badges: { b1: { priority: 1, progress: 50, tag: "核心" } },
        boundaries: { b1: { label: "阶段一", color: "#3370ff" } },
        summaries: { r: { label: "结论", color: "#722ed1" } },
        selectedId: "b1",
      }),
    );
    expect(html).toContain("data-mindmap-outline");
    expect(html).toContain('data-outline-row="r"');
    expect(html).toContain('data-outline-depth="0"');
    expect(html).toContain('data-outline-row="b1"');
    expect(html).toContain('data-outline-depth="1"');
    expect(html).toContain('data-outline-row="s1"');
    expect(html).toContain('data-outline-depth="2"');
    expect(html).toContain("中心主题");
    expect(html).toContain("子项A");
    expect(html).toContain("P1");
    expect(html).toContain("50%");
    expect(html).toContain("核心");
    expect(html).toContain("阶段一");
    expect(html).toContain("结论");

    // Collapsed branch hides children and displays +N count pill
    const foldedHtml = renderToStaticMarkup(
      createElement(MindMapOutlineView, {
        topics: sampleTopics,
        collapsed: new Set(["b1"]),
      }),
    );
    expect(foldedHtml).toContain('data-outline-row="b1"');
    expect(foldedHtml).not.toContain('data-outline-row="s1"');
    expect(foldedHtml).toContain("+1");
  });

  it("renders cleanly in readOnly mode without editable inputs or delete buttons", () => {
    const html = renderToStaticMarkup(
      createElement(MindMapOutlineView, {
        topics: sampleTopics,
        readOnly: true,
        badges: { s1: { priority: 3, progress: 100 } },
      }),
    );
    expect(html).toContain("data-mindmap-outline");
    expect(html).toContain("中心主题");
    expect(html).toContain("子项A");
    expect(html).toContain("P3");
    expect(html).toContain("100%");
    expect(html).not.toContain("data-outline-input");
    expect(html).not.toContain("data-outline-delete");
    expect(html).not.toContain("data-outline-add-child");
  });

  it("exposes all editable inputs, +子主题, delete, fold, and canvas toggle hooks", () => {
    const html = renderToStaticMarkup(
      createElement(MindMapOutlineView, {
        topics: sampleTopics,
        onUpdateTitle: vi.fn(),
        onAddChild: vi.fn(),
        onAddSibling: vi.fn(),
        onDelete: vi.fn(),
        onToggleFold: vi.fn(),
        onSwitchToCanvas: vi.fn(),
      }),
    );
    expect(html).toContain('data-outline-input="r"');
    expect(html).toContain('data-outline-input="b1"');
    expect(html).toContain('data-outline-input="s1"');
    expect(html).toContain('data-outline-add-child="r"');
    expect(html).toContain('data-outline-add-child="b1"');
    expect(html).toContain('data-outline-delete="b1"');
    expect(html).not.toContain('data-outline-delete="r"');
    expect(html).toContain('data-outline-fold="r"');
    expect(html).toContain('data-outline-fold="b1"');
    expect(html).toContain('data-outline-back-canvas="true"');
    expect(html).not.toContain("<select");
  });

  it("contains zero native <select> elements and exposes all required brainstorming & mindmap UI hooks", () => {
    const flowchartSrc = readFileSync(fileURLToPath(new URL("./flowchart-block.tsx", import.meta.url)), "utf8");
    const minimapSrc = readFileSync(fileURLToPath(new URL("./whiteboard-minimap.tsx", import.meta.url)), "utf8");
    const outlineSrc = readFileSync(fileURLToPath(new URL("./mindmap-outline.tsx", import.meta.url)), "utf8");
    const svgSrc = readFileSync(fileURLToPath(new URL("./mind-map-svg.tsx", import.meta.url)), "utf8");

    for (const src of [flowchartSrc, minimapSrc, outlineSrc, svgSrc]) {
      expect(src).not.toMatch(/<select[\s>]/i);
    }

    for (const hook of [
      "data-board-add-sticky",
      'data-board-tool="highlighter"',
      "data-board-voting-toggle",
      "data-mind-boundary-btn",
      "data-mind-summary-btn",
      "data-mind-badge-btn",
      "data-mind-view-toggle",
    ]) {
      expect(flowchartSrc).toContain(hook);
    }
    expect(minimapSrc).toContain("data-board-minimap");
    expect(minimapSrc).toContain("data-board-timer");
  });
});
