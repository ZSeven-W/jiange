import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { blockAlign, FormatToolbar } from "./FormatToolbar";
import { ALIGNABLE, CLEARABLE_MARKS } from "./Editor";

const noop = () => {};

describe("floating format toolbar 对齐 / 更多", () => {
  it("offers AI only when the page provides it, and a combined text/background colour button", () => {
    const html = renderToStaticMarkup(<FormatToolbar x={0} y={0} marks={{}} blockType="paragraph" onMark={noop} onLink={noop} onType={noop} onAI={noop} />);
    expect(html).toContain("data-toolbar-ai");
    expect(html).toContain("data-color-btn");
    expect(html).not.toContain("data-bg-btn");
    expect(renderToStaticMarkup(<FormatToolbar x={0} y={0} marks={{}} blockType="paragraph" onMark={noop} onLink={noop} onType={noop} />)).not.toContain("data-toolbar-ai");
  });
  it("shows the alignment and more buttons when the editor provides them", () => {
    const html = renderToStaticMarkup(<FormatToolbar x={0} y={0} marks={{}} blockType="paragraph" align="center" onMark={noop} onLink={noop} onType={noop} onAlign={noop} onClearFormat={noop} onCopyLink={noop} onComment={noop} />);
    expect(html).toContain("data-align-btn");
    expect(html).toContain("data-more-btn");
    expect(html).toContain('title="对齐"');
    // 飞书实测（2026-11-11）：评论在最右侧，“更多”紧挨其左
    expect(html.indexOf("data-comment-btn")).toBeGreaterThan(html.indexOf("data-more-btn"));
    // 对齐在加粗等文字样式之前
    expect(html.indexOf("data-align-btn")).toBeLessThan(html.indexOf('title="加粗"'));
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
