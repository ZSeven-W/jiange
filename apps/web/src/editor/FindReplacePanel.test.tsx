import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FindReplacePanel, type FindReplacePanelProps } from "./FindReplacePanel";

const base: FindReplacePanelProps = {
  mode: "find",
  query: "文档",
  replacement: "笔记",
  matchCount: 3,
  activeIndex: 1,
  canReplace: true,
  scopeNotice: "仅查找普通正文，暂不包含表格和公式。",
  onModeChange: vi.fn(),
  onQueryChange: vi.fn(),
  onReplacementChange: vi.fn(),
  onNavigate: vi.fn(),
  onReplace: vi.fn(),
  onReplaceAll: vi.fn(),
  onClose: vi.fn(),
};

describe("FindReplacePanel", () => {
  it("shows the current match and explicitly describes the search scope", () => {
    const html = renderToStaticMarkup(<FindReplacePanel {...base} />);
    expect(html).toContain("2 / 3");
    expect(html).toContain("仅查找普通正文，暂不包含表格和公式。");
    expect(html).toContain('role="search"');
    expect(html).toContain('aria-label="查找"');
    expect(html).not.toContain("替换为</label>");
  });

  it("disables replacements when the document is read-only", () => {
    const html = renderToStaticMarkup(<FindReplacePanel {...base} mode="replace" canReplace={false} />);
    expect(html).toContain("替换为</label>");
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>全部替换<\/button>/);
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>替换<\/button>/);
    expect(html).not.toMatch(/<button[^>]* disabled=""[^>]*>下一处<\/button>/);
  });

  it("disables navigation when there are no matches", () => {
    const html = renderToStaticMarkup(<FindReplacePanel {...base} matchCount={0} activeIndex={-1} />);
    expect(html).toContain("0 / 0");
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>上一处<\/button>/);
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>下一处<\/button>/);
  });

  it("announces operation feedback without hiding the scope notice", () => {
    const html = renderToStaticMarkup(<FindReplacePanel {...base} statusMessage="已替换 2 处，跳过 1 处冲突。" />);
    expect(html).toContain("仅查找普通正文，暂不包含表格和公式。");
    expect(html).toMatch(/<p role="status" aria-live="polite"[^>]*>已替换 2 处，跳过 1 处冲突。<\/p>/);
  });
});
