import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IMAGE_WIDTHS, ImageBlock, imageAlign, resizedWidth } from "./ImageBlock";

const base = { fileId: "9", name: "a.png", mime: "image/png", version: 0, status: "synced" as const };

describe("Feishu image block", () => {
  it("defaults to centered and only accepts known alignments", () => {
    expect(imageAlign(undefined)).toBe("center");
    expect(imageAlign("left")).toBe("left");
    expect(imageAlign("justify")).toBe("center");
  });
  it("converts a drag into a clamped width percentage", () => {
    expect(resizedWidth(400, 100, 800, "right", "left")).toBe(63);
    expect(resizedWidth(400, 100, 800, "right", "center")).toBe(75);
    expect(resizedWidth(400, 100, 800, "left", "left")).toBe(38);
    expect(resizedWidth(400, -1000, 800, "right", "left")).toBe(10);
    expect(resizedWidth(400, 1000, 800, "right", "left")).toBe(100);
  });
  it("shows the full toolbar, resize handles and caption input to editors", () => {
    const html = renderToStaticMarkup(<ImageBlock {...base} width={50} align="right" caption="示意图" canDownload onProp={() => {}} onReplace={async () => {}} onDelete={() => {}} />);
    for (const attr of ["data-image-toolbar", 'data-image-align-btn="left"', "data-image-replace", "data-image-download", "data-image-delete", 'data-image-resize="left"', 'data-image-resize="right"', "data-image-caption", "data-image-replace-input"]) expect(html).toContain(attr);
    expect(html.match(/data-image-width=/g)).toHaveLength(IMAGE_WIDTHS.length);
    expect(html).toContain('data-image-align="right"');
    expect(html).toContain("width:50%");
    expect(html).toContain('value="示意图"');
  });
  it("gives readers a static caption and download only when allowed", () => {
    const html = renderToStaticMarkup(<ImageBlock {...base} caption="说明" canDownload={false} />);
    expect(html).toContain("<figcaption");
    expect(html).not.toContain("data-image-toolbar");
    expect(html).not.toContain("data-image-resize");
    expect(renderToStaticMarkup(<ImageBlock {...base} canDownload />)).toContain("data-image-download");
  });
  it("overlays upload progress", () => {
    const html = renderToStaticMarkup(<ImageBlock {...base} canDownload uploadProgress={42} onProp={() => {}} />);
    expect(html).toContain("data-image-uploading");
    expect(html).toContain("正在上传 42%");
  });
});
