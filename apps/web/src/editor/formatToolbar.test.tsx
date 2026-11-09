import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { blockAlign, FormatToolbar } from "./FormatToolbar";
import { ALIGNABLE, CLEARABLE_MARKS } from "./Editor";

const noop = () => {};

describe("floating format toolbar 对齐 / 更多", () => {
  it("shows the alignment and more buttons when the editor provides them", () => {
    const html = renderToStaticMarkup(<FormatToolbar x={0} y={0} marks={{}} blockType="paragraph" align="center" onMark={noop} onLink={noop} onType={noop} onAlign={noop} onClearFormat={noop} onCopyLink={noop} onComment={noop} />);
    expect(html).toContain("data-align-btn");
    expect(html).toContain("data-more-btn");
    expect(html).toContain('title="对齐"');
    // 与飞书一致，“更多”在工具栏最右侧
    expect(html.indexOf("data-more-btn")).toBeGreaterThan(html.indexOf("data-comment-btn"));
  });
  it("hides editing-only controls for read-only commenters", () => {
    const html = renderToStaticMarkup(<FormatToolbar x={0} y={0} marks={{}} blockType="paragraph" readOnly onMark={noop} onLink={noop} onType={noop} onAlign={noop} onClearFormat={noop} onCopyLink={noop} onComment={noop} />);
    expect(html).not.toContain("data-align-btn");
    expect(html).not.toContain("data-more-btn");
    expect(html).toContain("data-comment-btn");
  });
  it("normalizes unknown alignment values to left", () => {
    expect(blockAlign(undefined)).toBe("left");
    expect(blockAlign("justify")).toBe("left");
    expect(blockAlign("center")).toBe("center");
    expect(blockAlign("right")).toBe("right");
  });
  it("aligns text blocks but not code, and clears every inline style", () => {
    expect(ALIGNABLE.has("h4")).toBe(true);
    expect(ALIGNABLE.has("callout")).toBe(true);
    expect(ALIGNABLE.has("code")).toBe(false);
    expect([...CLEARABLE_MARKS]).toEqual(expect.arrayContaining(["bold", "color", "bg", "link", "code"]));
  });
});
