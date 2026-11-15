import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SlideShapePicker, slideShapePickerPosition } from "./SlideShapePicker";

describe("slide shape picker", () => {
  it("renders supported categories together with their working shape buttons", () => {
    const html = renderToStaticMarkup(<SlideShapePicker onSelect={() => {}}/>);
    expect(html).toContain('aria-label="基础图形"');
    expect(html).toContain('aria-label="箭头图形"');
    expect(html).toContain('aria-label="矩形"');
    expect(html).toContain('aria-label="向右箭头"');
    expect(html).not.toContain('aria-label="线条图形"');
  });
  it("fits the entire picker within desktop and short mobile viewports", () => {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 360 }]) {
      const rect = slideShapePickerPosition({ left: 340, top: 290, bottom: 320 }, viewport.width, viewport.height);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.left + rect.width).toBeLessThanOrEqual(viewport.width);
      expect(rect.top + rect.height).toBeLessThanOrEqual(viewport.height);
    }
  });
});
