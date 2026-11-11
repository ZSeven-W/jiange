import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SlashMenu } from "./SlashMenu";
import { filterItems, SLASH_ITEMS } from "./pinyin";

const render = (items = SLASH_ITEMS, query?: string) => renderToStaticMarkup(<SlashMenu x={0} y={0} items={items} index={2} query={query} onPick={() => {}} onHover={() => {}} />);

describe("Feishu-style slash menu layout", () => {
  it("lists blocks under group headers in Feishu's basic order, without an icon grid", () => {
    const html = render();
    expect(html).not.toContain("data-slash-grid");
    const order = ["paragraph", "h1", "h2", "h3", "h4", "ordered", "bullet", "code"].map((id) => html.indexOf(`data-value="${id}"`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    expect(html.indexOf("基础")).toBeLessThan(order[0]);
    expect(html).toContain("文本");
  });
  it("keeps search results as a list and still finds 正文 by its old name", () => {
    expect(render(filterItems("biao"))).not.toContain("data-slash-grid");
    expect(filterItems("正文").map((it) => it.id)).toContain("paragraph");
    expect(filterItems("zhengwen").map((it) => it.id)).toContain("paragraph");
  });
});

import { nextSlashIndex, slashGridSize } from "./SlashMenu";

describe("slash menu keyboard navigation", () => {
  const n = SLASH_ITEMS.length;
  it("never uses a grid now that the menu is a list", () => {
    expect(slashGridSize(SLASH_ITEMS)).toBe(0);
    expect(slashGridSize(SLASH_ITEMS, "h")).toBe(0);
  });
  it("moves through the list and leaves ←/→ to the caret", () => {
    expect(nextSlashIndex(1, "ArrowDown", n, 0)).toBe(2);
    expect(nextSlashIndex(n - 1, "ArrowDown", n, 0)).toBe(0);
    expect(nextSlashIndex(0, "ArrowUp", n, 0)).toBe(n - 1);
    expect(nextSlashIndex(3, "ArrowRight", n, 0)).toBeNull();
    // The grid branch is kept for callers that still pass a grid size.
    expect(nextSlashIndex(1, "ArrowDown", 12, 10, 5)).toBe(6);
  });
});
