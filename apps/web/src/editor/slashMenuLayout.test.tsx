import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SlashMenu } from "./SlashMenu";
import { filterItems, SLASH_ITEMS } from "./pinyin";

const render = (items = SLASH_ITEMS, query?: string) => renderToStaticMarkup(<SlashMenu x={0} y={0} items={items} index={2} query={query} onPick={() => {}} onHover={() => {}} />);

describe("Feishu-style slash menu layout", () => {
  it("tiles basic and list blocks as an icon grid when browsing", () => {
    const html = render();
    expect(html).toContain("data-slash-grid");
    const grid = html.slice(html.indexOf("data-slash-grid"), html.indexOf("其他"));
    for (const id of ["paragraph", "h1", "h3", "bullet", "ordered", "todo"]) expect(grid).toContain(`data-value="${id}"`);
    expect(grid).not.toContain('data-value="table"');
    // 网格中被键盘选中的项在标题行显示名称
    expect(grid).toContain("二级标题");
  });
  it("falls back to a plain list for search results", () => {
    expect(render(filterItems("biao"))).not.toContain("data-slash-grid");
    expect(render(SLASH_ITEMS, "表")).not.toContain("data-slash-grid");
  });
});
