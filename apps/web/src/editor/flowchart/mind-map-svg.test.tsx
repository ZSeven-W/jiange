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
});
