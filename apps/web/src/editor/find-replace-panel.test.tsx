import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FindReplacePanel, type FindReplacePanelProps } from "./find-replace-panel";

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
    expect(html).toMatch(/aria-label="搜索范围" aria-expanded="false"/);
    expect(html).toMatch(/class="sr-only">仅查找普通正文/);
    expect(html).toContain('role="search"');
    expect(html).toContain('aria-label="查找"');
    expect(html).not.toContain("替换为</label>");
  });

  it("keeps result-specific restrictions visible", () => {
    const html = renderToStaticMarkup(<FindReplacePanel {...base} mode="replace" warningMessage="标题暂不支持替换。" />);
    expect(html).toMatch(/<p role="status"[^>]*>标题暂不支持替换。<\/p>/);
  });

  it("disables replacements when the document is read-only", () => {
    const html = renderToStaticMarkup(<FindReplacePanel {...base} mode="replace" canReplace={false} />);
    expect(html).toContain("替换为</label>");
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>全部替换<\/button>/);
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>替换<\/button>/);
    expect(html).not.toMatch(/<button[^>]* disabled=""[^>]*>下一处<\/button>/);
  });

  it("can allow a single replacement while disabling replacement of a mixed result set", () => {
    const html = renderToStaticMarkup(<FindReplacePanel {...base} mode="replace" canReplace canReplaceAll={false} />);
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>全部替换<\/button>/);
    expect(html).not.toMatch(/<button[^>]* disabled=""[^>]*>替换<\/button>/);
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

  it("exposes a touch history action and disables it while a request is pending", () => {
    const html = renderToStaticMarkup(<FindReplacePanel {...base} historyAction={{ label: "撤销本次替换", disabled: true, onClick: vi.fn() }} />);
    expect(html).toContain("撤销本次替换");
    expect(html).toContain("min-[480px]:hidden");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>撤销本次替换<\/button>/);
  });
});
