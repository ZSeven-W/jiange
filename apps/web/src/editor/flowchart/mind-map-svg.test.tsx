import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MindMapSvg } from "./mind-map-svg";
import type { MindTopic } from "./mindmap";

const topics: MindTopic[] = [{ id: "r", parent: null, order: 0, text: "项目计划", x: 0, y: 0 }, { id: "c", parent: "r", order: 0, text: "" }];
describe("mind map rendering", () => {
  it("renders placeholders only in the editor", () => {
    expect(renderToStaticMarkup(<svg><MindMapSvg topics={topics} onSelect={() => {}}/></svg>)).toContain("输入文本");
    const exported = renderToStaticMarkup(<svg><MindMapSvg topics={topics}/></svg>);
    expect(exported).toContain("项目计划");
    expect(exported).not.toContain("输入文本");
  });
  it("shows the hidden descendant count and exposes a fold control in read-only views", () => {
    const tree: MindTopic[] = [topics[0], { ...topics[1], text: "子节点" }, { id: "g", parent: "c", order: 0, text: "隐藏内容" }, { id: "gg", parent: "g", order: 0, text: "更多内容" }];
    const markup = renderToStaticMarkup(<svg><MindMapSvg topics={tree} collapsed={new Set(["c"])} onFold={() => {}}/></svg>);
    expect(markup).toContain('aria-label="展开「子节点」"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(">2</text>");
    expect(markup).not.toContain("隐藏内容");
    const exported = renderToStaticMarkup(<svg><MindMapSvg topics={tree} collapsed={new Set(["c"])}/></svg>);
    expect(exported).toContain(">2</text>");
    expect(exported).not.toContain('role="button"');
  });
  it("shows the add control only for the selected editable node", () => {
    const editor = renderToStaticMarkup(<svg><MindMapSvg topics={topics} selected="c" onSelect={() => {}} onAddChild={() => {}}/></svg>);
    expect(editor).toContain('aria-label="为「节点」添加子节点"');
    expect(editor).toContain('data-mind-add="c"');
    expect(editor).not.toContain('data-mind-add="r"');
    const editing = renderToStaticMarkup(<svg><MindMapSvg topics={topics} selected="c" editing={{ id: "c", value: "" }} onAddChild={() => {}}/></svg>);
    expect(editing).not.toContain("data-mind-add");
    const readOnly = renderToStaticMarkup(<svg><MindMapSvg topics={topics} selected="c"/></svg>);
    expect(readOnly).not.toContain("data-mind-add");
  });
  it("renders a styled node without putting its outline in the selection layer", () => {
    const styled = renderToStaticMarkup(<svg><MindMapSvg topics={[topics[0], { ...topics[1], text: "示例" }]} styles={{ c: { shape: "oval", size: 24, color: "#ee1122" } }}/></svg>);
    expect(styled).toContain('font-size="24"');
    expect(styled).toContain('fill="#ee1122"');
    expect(styled).toContain('rx="20"');
    expect(styled).toContain('stroke="#5b7ff1"');
  });
  it("paints only the selected branch and retains fill and line style in SVG", () => {
    const tree: MindTopic[] = [topics[0], { ...topics[1], text: "一" }, { id: "s", parent: "r", order: 1, text: "二" }];
    const markup = renderToStaticMarkup(<svg><MindMapSvg topics={tree} styles={{ c: { shape: "oval" } }} paints={{ c: { fill: "#e1e9ff", stroke: "#e86d68", line: "dashed", width: 3, opacity: 80 } }}/></svg>);
    expect(markup).toContain('fill="#e1e9ff"');
    expect(markup).toMatch(/data-mind-branch="c"[^>]*stroke="#e86d68"[^>]*stroke-width="3"[^>]*stroke-opacity="0.8"[^>]*stroke-dasharray="6 4"/);
    expect(markup).toMatch(/data-mind-branch="s"[^>]*stroke="#5b7ff1"/);
  });
  it("keeps root text readable when its fill is light or transparent", () => {
    for (const fill of ["none", "#e1e9ff"]) {
      const markup = renderToStaticMarkup(<svg><MindMapSvg topics={[topics[0]]} paints={{ r: { fill } }}/></svg>);
      expect(markup).toContain('fill="#1f2329"');
    }
  });
});
