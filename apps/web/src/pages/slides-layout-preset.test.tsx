import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sameSlideContent } from "./slidesDraft";
import { SlideShapes } from "./slides-shapes";
import { SlideSurface } from "./slides-presenter";
import { slidePresetContent, TWO_COLUMN_SHAPES } from "./slides-layout-preset";

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
});
