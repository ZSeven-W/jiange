import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlockHandle, CONVERT_TARGETS } from "./BlockHandle";

const noop = () => {};

describe("Feishu-style block handle", () => {
  it("shows only the draggable handle while closed", () => {
    const html = renderToStaticMarkup(<BlockHandle type="h2" open={false} onOpenChange={noop} onDragStart={noop} onDelete={noop} onConvert={noop} />);
    expect(html).toContain("data-block-handle");
    expect(html).toContain('draggable="true"');
    expect(html).not.toContain("data-block-menu");
  });
  it("opens a menu with convert targets, insert below and delete, marking the current type", () => {
    const html = renderToStaticMarkup(<BlockHandle type="h2" open onOpenChange={noop} onInsertAfter={noop} onDelete={noop} onConvert={noop} />);
    for (const t of CONVERT_TARGETS) expect(html).toContain(`data-convert-to="${t.type}"`);
    expect(html).toMatch(/class="[^"]*text-primary[^"]*"[^>]*data-convert-to="h2"/);
    expect(html).toContain("data-insert-after");
    expect(html).toContain("data-delete-block");
  });
  it("omits conversion for non-text blocks", () => {
    const html = renderToStaticMarkup(<BlockHandle type="image" open onOpenChange={noop} onDelete={noop} />);
    expect(html).not.toContain("data-convert-to");
    expect(html).toContain("data-delete-block");
  });
});
