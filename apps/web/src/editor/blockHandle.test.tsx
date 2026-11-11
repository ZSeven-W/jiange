import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlockHandle, blockLink, CONVERT_TARGETS, linkedBlock } from "./BlockHandle";
import { blockAbilities, dropPlan, readOnlyBlockAbilities, withPageAbilities } from "./Editor";

const noop = () => {};
const all = blockAbilities("h2", false, true, true);

describe("Feishu-style block handle", () => {
  it("shows only the draggable handle while closed", () => {
    const html = renderToStaticMarkup(<BlockHandle type="h2" open={false} onOpenChange={noop} onDragStart={noop} can={all} />);
    expect(html).toContain("data-block-handle");
    expect(html).toContain('draggable="true"');
    expect(html).not.toContain("data-block-menu");
  });
  it("opens the full block menu for a text block, marking the current type", () => {
    const html = renderToStaticMarkup(<BlockHandle type="h2" indent={0} open onOpenChange={noop} can={all} />);
    for (const t of CONVERT_TARGETS) expect(html).toContain(`data-convert-to="${t.type}"`);
    expect(html).toMatch(/class="[^"]*text-primary[^"]*"[^>]*data-convert-to="h2"/);
    for (const attr of ["data-block-colors", "data-block-layout", "data-block-align", "data-block-indent", "data-block-outdent", "data-block-cut", "data-block-copy", "data-block-link", "data-block-comment", "data-insert-after", "data-delete-block"]) expect(html).toContain(attr);
    // 无缩进时“减少缩进”不可用
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-block-outdent/);
  });
  it("hides copy and comment when copying is restricted or commenting is unavailable", () => {
    const html = renderToStaticMarkup(<BlockHandle type="paragraph" open onOpenChange={noop} can={blockAbilities("paragraph", false, false, false)} />);
    expect(html).not.toContain("data-block-copy");
    expect(html).not.toContain("data-block-cut");
    expect(html).not.toContain("data-block-comment");
    expect(html).toContain("data-block-link");
  });
  it("omits text-only actions for media blocks", () => {
    const html = renderToStaticMarkup(<BlockHandle type="image" open onOpenChange={noop} can={blockAbilities("image", false, true, true)} />);
    expect(html).not.toContain("data-convert-to");
    expect(html).not.toContain("data-block-colors");
    expect(html).toContain("data-block-copy");
    expect(html).toContain("data-delete-block");
  });
  it("shows the selected-block count and bulk actions for a multi-block selection", () => {
    const html = renderToStaticMarkup(<BlockHandle type="paragraph" count={3} open onOpenChange={noop} onDragStart={noop} can={blockAbilities("image", true, true, true)} />);
    expect(html).toContain("已选择 3 个块");
    expect(html).toContain("删除 3 个块");
    expect(html).toContain("data-convert-to");
    expect(html).not.toContain("data-block-link");
    expect(html).not.toContain("data-block-comment");
    expect(html).not.toContain("data-insert-after");
    expect(html).toContain('draggable="true"');
  });
});

describe("page-level block actions (AI / share / template)", () => {
  it("adds AI, translate, share and save-as-template rows only when the page provides them", () => {
    const can = withPageAbilities(all, "h2", { ai: true, share: true, template: true });
    const html = renderToStaticMarkup(<BlockHandle type="h2" open onOpenChange={noop} can={can} />);
    for (const attr of ["data-block-ai", "data-block-translate", "data-block-share", "data-block-template"]) expect(html).toContain(attr);
    const none = renderToStaticMarkup(<BlockHandle type="h2" open onOpenChange={noop} can={withPageAbilities(all, "h2", { ai: false, share: false, template: false })} />);
    for (const attr of ["data-block-ai", "data-block-translate", "data-block-share", "data-block-template"]) expect(none).not.toContain(attr);
  });
  it("offers AI only for text-like blocks", () => {
    expect(withPageAbilities(blockAbilities("image", false, true, true), "image", { ai: true, share: true, template: true }).ai).toBe(false);
  });
});

describe("block links", () => {
  it("adds the block to the hash route and reads it back", () => {
    const url = blockLink("http://h/app#/doc/7?block=1:2", "3:9");
    expect(url).toBe("http://h/app#/doc/7?block=3%3A9");
    expect(linkedBlock(url.slice(url.indexOf("#")))).toBe("3:9");
    expect(linkedBlock("#/doc/7")).toBeNull();
  });
});

describe("read-only block handle", () => {
  it("offers only copy, copy-link and comment to readers who may comment", () => {
    const html = renderToStaticMarkup(<BlockHandle type="paragraph" open onOpenChange={noop} can={readOnlyBlockAbilities("paragraph", true, true)} />);
    for (const attr of ["data-block-copy", "data-block-link", "data-block-comment"]) expect(html).toContain(attr);
    for (const attr of ["data-convert-to", "data-block-colors", "data-block-indent", "data-block-cut", "data-insert-after", "data-delete-block"]) expect(html).not.toContain(attr);
    expect(html).toContain('draggable="false"');
  });
  it("keeps copy-link even when copying and commenting are off", () => {
    const html = renderToStaticMarkup(<BlockHandle type="image" open onOpenChange={noop} can={readOnlyBlockAbilities("image", false, false)} />);
    expect(html).toContain("data-block-link");
    expect(html).not.toContain("data-block-copy");
    expect(html).not.toContain("data-block-comment");
  });
});

describe("dragging several selected blocks", () => {
  const id = (clock: number) => ({ client: 1, clock });
  const body = [1, 2, 3, 4, 5].map(id);
  const keys = (p: ReturnType<typeof dropPlan>) => p && { moving: p.moving.map((x) => x.clock), target: p.target?.clock ?? null };
  it("moves the whole group after the drop target, keeping document order", () => {
    expect(keys(dropPlan(body, [id(3), id(2)], id(5), true))).toEqual({ moving: [2, 3], target: 5 });
    expect(keys(dropPlan(body, [id(4), id(5)], id(1), false))).toEqual({ moving: [4, 5], target: null });
    expect(keys(dropPlan(body, [id(1), id(2)], id(4), false))).toEqual({ moving: [1, 2], target: 3 });
  });
  it("ignores drops onto the group itself or back into its current place", () => {
    expect(dropPlan(body, [id(2), id(3)], id(3), true)).toBeNull();
    expect(dropPlan(body, [id(2), id(3)], id(1), true)).toBeNull();
    expect(dropPlan(body, [id(2), id(3)], id(4), false)).toBeNull();
    expect(dropPlan(body, [], id(4), false)).toBeNull();
  });
  it("lets the multi-block handle be dragged", () => {
    const html = renderToStaticMarkup(<BlockHandle type="paragraph" count={2} open={false} onOpenChange={noop} onDragStart={noop} can={blockAbilities("paragraph", true, true, true)} />);
    expect(html).toContain('draggable="true"');
  });
});
