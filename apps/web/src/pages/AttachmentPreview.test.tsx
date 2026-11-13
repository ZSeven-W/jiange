import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentPreview } from "./AttachmentPreview";
import { pinchImageZoom, previewImageSize, stepImageZoom } from "./imagePreviewZoom";

describe("attachment image preview", () => {
  it("fits large images, keeps small images at natural size and scales within the viewport", () => {
    expect(previewImageSize({ width: 2000, height: 1000 }, { width: 800, height: 500 }, 1)).toEqual({ width: 800, height: 400 });
    expect(previewImageSize({ width: 200, height: 100 }, { width: 800, height: 500 }, 1.5)).toEqual({ width: 300, height: 150 });
    expect(previewImageSize({ width: 200, height: 100 }, { width: 0, height: 500 }, 1)).toBeUndefined();
    expect(previewImageSize({ width: 200, height: 100 }, { width: 800, height: 500 }, NaN)).toBeUndefined();
    expect(previewImageSize({ width: 2000, height: 1000 }, { width: 800, height: 500 }, 1, 90)).toEqual({ width: 250, height: 500 });
    expect(previewImageSize({ width: 2000, height: 1000 }, { width: 800, height: 500 }, 1, 180)).toEqual({ width: 800, height: 400 });
  });
  it("clamps touch zoom and handles incomplete touch distances", () => {
    expect(pinchImageZoom(1, 100, 150)).toBe(1.5);
    expect(pinchImageZoom(1, 100, 500)).toBe(4);
    expect(pinchImageZoom(1, 100, 1)).toBe(0.25);
    expect(pinchImageZoom(1, 0, 20)).toBe(1);
  });
  it("steps through bounded zoom levels and returns to fit", () => {
    expect(stepImageZoom(1, 1)).toBe(1.25);
    expect(stepImageZoom(1, -1)).toBe(0.75);
    expect(stepImageZoom(4, 1)).toBe(4);
    expect(stepImageZoom(0.25, -1)).toBe(0.25);
  });
  it("exposes image controls while preserving restrictions and does not show them for PDFs", () => {
    const image = renderToStaticMarkup(<AttachmentPreview src="/api/files/1" name="图.png" mime="image/png" allowCopy={false} allowPrint={false} onClose={() => {}} />);
    expect(image).toContain('role="dialog"');
    expect(image).toContain('aria-label="放大图片"');
    expect(image).toContain('aria-label="缩小图片"');
    expect(image).toContain('aria-label="适应窗口"');
    expect(image).toContain('aria-label="顺时针旋转图片"');
    expect(image).toContain('data-document-print-restricted="true"');
    expect(image).toContain('draggable="false"');
    const pdf = renderToStaticMarkup(<AttachmentPreview src="/api/files/2" name="文件.pdf" mime="application/pdf" onClose={() => {}} />);
    expect(pdf).toContain('data-pdf-frame="true"');
    expect(pdf).not.toContain('aria-label="放大图片"');
  });
});
