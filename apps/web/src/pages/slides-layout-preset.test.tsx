import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sameSlideContent, SlidesDraftQueue } from "./slidesDraft";
import { SlideShapes } from "./slides-shapes";
import { SlideSurface } from "./slides-presenter";
import { SlideFormatPanel } from "./SlideFormatPanel";
import { isTwoColumnSlide, planSlideLayout, slidePresetContent, TWO_COLUMN_SHAPES } from "./slides-layout-preset";

describe("two-column creation preset", () => {
  it("uses three independent editable text shapes on a compatible blank page", () => {
    const content = slidePresetContent("two-column");
    expect(content.layout).toBe("blank");
    expect(content.shapes.map((shape) => shape.id)).toEqual(["preset-two-title", "preset-two-left", "preset-two-right"]);
    expect(content.shapes.every((shape) => shape.kind === "text" && shape.text === "")).toBe(true);
    expect(sameSlideContent(content, { ...content, shapes: [...content.shapes] })).toBe(true);
    expect(sameSlideContent(content, { ...content, shapes: content.shapes.slice(1) })).toBe(false);
  });
  it("shows editor prompts but never renders them in presentation", () => {
    const edit = renderToStaticMarkup(<SlideShapes shapes={TWO_COLUMN_SHAPES} editable selected={null}/>);
    expect(edit).toContain("点击添加左栏内容");
    expect(edit).toContain("点击添加右栏内容");
    const audience = renderToStaticMarkup(<SlideSurface content={slidePresetContent("two-column")}/>);
    expect(audience).not.toContain("点击添加标题");
    expect(audience).not.toContain("点击添加内容");
  });
  it("keeps only the active text editor mounted and read-only while editing is disabled", () => {
    const selected = renderToStaticMarkup(<SlideShapes shapes={TWO_COLUMN_SHAPES} editable={false} selected="preset-two-left"/>);
    expect(selected).toMatch(/<textarea[^>]*readonly=""[^>]*aria-label="文本框内容"/i);
    expect(selected).not.toContain("调整图形左上边界");
    const unselected = renderToStaticMarkup(<SlideShapes shapes={TWO_COLUMN_SHAPES} editable={false} selected={null}/>);
    expect(unselected).not.toContain("<textarea");
    const checking = renderToStaticMarkup(<SlideShapes shapes={TWO_COLUMN_SHAPES} editable={false} textEditable selected="preset-two-left"/>);
    expect(checking).toContain('aria-label="文本框内容"');
    expect(checking).not.toMatch(/<textarea[^>]*readonly/i);
    expect(checking).not.toContain("调整图形左上边界");
  });
  it("moves existing title and body into editable columns without losing other objects", () => {
    const extra = { id: "existing", kind: "rectangle" as const, x: 2, y: 2, color: "#3370ff" };
    const before = { ...slidePresetContent(""), title: "项目进展", body: "现有正文", notes: "备注", background: "#abcdef", shapes: [extra] };
    const result = planSlideLayout(before, "two-column");
    if (!result.ok) throw new Error(result.message);
    expect(result.content).toMatchObject({ layout: "blank", title: "", body: "", notes: "备注", background: "#abcdef" });
    expect(result.content.shapes).toHaveLength(4);
    expect(result.content.shapes[0]).toEqual(extra);
    expect(result.content.shapes.find((shape) => shape.id === "preset-two-title")?.text).toBe("项目进展");
    expect(result.content.shapes.find((shape) => shape.id === "preset-two-left")?.text).toBe("现有正文");
    expect(before.title).toBe("项目进展");
    expect(isTwoColumnSlide(result.content)).toBe(true);
  });
  it("keeps modified placeholders as regular objects and removes only pristine empty ones", () => {
    const content = slidePresetContent("two-column");
    content.shapes = [...content.shapes.map((shape) => shape.id === "preset-two-title" ? { ...shape, text: "标题" } : shape.id === "preset-two-left" ? { ...shape, x: 8 } : shape), { id: "shape-detached-1", kind: "text", x: 1, y: 1, color: "#111111", text: "已有" }];
    const result = planSlideLayout(content, "title");
    if (!result.ok) throw new Error(result.message);
    expect(result.content.shapes.map((shape) => shape.id)).toEqual(["shape-detached-2", "shape-detached-3", "shape-detached-1"]);
    expect(result.content.shapes[0].text).toBe("标题");
    expect(result.content.shapes[1].x).toBe(8);
    expect(isTwoColumnSlide(result.content)).toBe(false);
  });
  it("refuses content or object collisions rather than losing data", () => {
    const before = { ...slidePresetContent(""), body: "字".repeat(1001) };
    expect(planSlideLayout(before, "two-column")).toMatchObject({ ok: false });
    expect(before.body).toHaveLength(1001);
    const collision = { ...slidePresetContent(""), shapes: [{ ...TWO_COLUMN_SHAPES[0], text: "保留" }] };
    expect(planSlideLayout(collision, "two-column")).toMatchObject({ ok: false });
    expect(collision.shapes[0].text).toBe("保留");
    const crowded = { ...slidePresetContent(""), shapes: Array.from({ length: 98 }, (_, i) => ({ id: `s${i}`, kind: "text" as const, x: 1, y: 1, color: "#111111", text: "" })) };
    expect(planSlideLayout(crowded, "two-column")).toMatchObject({ ok: false });
  });
  it("does not alter partial preset objects on an unrelated page", () => {
    const shapes = [{ ...TWO_COLUMN_SHAPES[0] }];
    const result = planSlideLayout({ ...slidePresetContent(""), shapes }, "title");
    expect(result).toMatchObject({ ok: true, content: { layout: "title", shapes } });
  });
  it("marks the two-column format rather than blank in the sidebar", () => {
    const html = renderToStaticMarkup(<SlideFormatPanel background="" layout="blank" shapes={TWO_COLUMN_SHAPES} usedColors={[]} canEdit busy={false} applying={false} onChange={() => {}} onLayoutChange={() => {}} onMore={() => {}} onApplyAll={() => {}} onClose={() => {}}/>);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>[^]*?标题与两栏内容<\/span><\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>[^]*?空白<\/span><\/button>/);
  });
  it("undoes and redoes a layout conversion as one page edit", () => {
    const page = { id: 1, slidesId: 2, pos: 1, title: "标题", body: "正文", notes: "备注", background: "", layout: "" as const, shapes: [], hidden: false, revision: 1, updatedAt: "" };
    const queue = new SlidesDraftQueue(() => new Promise(() => {}), () => {}, () => {});
    const plan = planSlideLayout(queue.get(page).content, "two-column");
    if (!plan.ok) throw new Error(plan.message);
    queue.edit(page, plan.content);
    expect(isTwoColumnSlide(queue.get(page).content)).toBe(true);
    queue.undo(page);
    expect(queue.get(page).content).toMatchObject({ title: "标题", body: "正文", shapes: [] });
    queue.redo(page);
    expect(isTwoColumnSlide(queue.get(page).content)).toBe(true);
  });
});
