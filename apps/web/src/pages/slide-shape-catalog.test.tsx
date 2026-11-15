import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SLIDE_SHAPES, SlideShapeGraphic } from "./slide-shape-catalog";
import { SlideSurface } from "./slides-presenter";

describe("slide shapes", () => {
  it("renders a real SVG path for every selectable shape", () => {
    for (const item of SLIDE_SHAPES) expect(renderToStaticMarkup(<SlideShapeGraphic kind={item.kind} color="#3370ff"/>)).toMatch(/<path d="[^"]+"/);
    expect(new Set(SLIDE_SHAPES.map((item) => item.kind)).size).toBe(SLIDE_SHAPES.length);
  });
  it("uses the same shape in presentation and thumbnails", () => {
    const html = renderToStaticMarkup(<SlideSurface content={{ title: "", body: "", background: "", layout: "", shapes: [{ id: "s", kind: "star", x: 10, y: 10, color: "#3370ff" }] }}/>);
    expect(html).toContain('d="M50 3L61 35');
  });
  it("renders all five line styles on the slide surface", () => {
    const lines = SLIDE_SHAPES.filter((shape) => shape.group === "线条");
    expect(lines).toHaveLength(5);
    for (const [index, item] of lines.entries()) {
      const html = renderToStaticMarkup(<SlideSurface content={{ title: "", body: "", background: "", layout: "", shapes: [{ id: `line-${index}`, kind: item.kind, x: 10, y: 10, width: 30, height: 5, color: "#1f2329" }] }}/>);
      expect(html).toContain('d="M5 50H95"');
      expect(html).toContain('#1f2329');
    }
  });
});
