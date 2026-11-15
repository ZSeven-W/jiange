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
});
