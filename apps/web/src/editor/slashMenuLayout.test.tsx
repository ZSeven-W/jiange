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

import { nextSlashIndex, slashGridSize } from "./SlashMenu";

describe("slash grid keyboard navigation", () => {
  const n = SLASH_ITEMS.length;
  const grid = slashGridSize(SLASH_ITEMS);
  it("detects the 10-item basic grid only while browsing", () => {
    expect(grid).toBe(10);
    expect(slashGridSize(SLASH_ITEMS, "h")).toBe(0);
    expect(slashGridSize(filterItems("biao"))).toBe(0);
  });
  it("moves by row in the grid and steps into the list below", () => {
    expect(nextSlashIndex(1, "ArrowDown", n, grid)).toBe(6);
    expect(nextSlashIndex(6, "ArrowDown", n, grid)).toBe(10);
    expect(nextSlashIndex(6, "ArrowUp", n, grid)).toBe(1);
    expect(nextSlashIndex(2, "ArrowRight", n, grid)).toBe(3);
    expect(nextSlashIndex(0, "ArrowLeft", n, grid)).toBe(n - 1);
  });
  it("uses list order outside the grid and leaves ←/→ to the caret", () => {
    expect(nextSlashIndex(10, "ArrowUp", n, grid)).toBe(5);
    expect(nextSlashIndex(11, "ArrowDown", n, grid)).toBe(12);
    expect(nextSlashIndex(n - 1, "ArrowDown", n, grid)).toBe(0);
    expect(nextSlashIndex(11, "ArrowLeft", n, grid)).toBeNull();
    expect(nextSlashIndex(3, "ArrowRight", 5, 0)).toBeNull();
    expect(nextSlashIndex(4, "ArrowDown", 5, 0)).toBe(0);
    expect(nextSlashIndex(0, "ArrowUp", 5, 0)).toBe(4);
  });
});
