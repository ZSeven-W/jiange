import { describe, expect, it } from "vitest";
import { markdownExportLosses } from "./markdownExport";

const block = (type: string, text = "", props: Record<string, string> = {}, marks: Record<string, string> = {}) => ({
  type, props, spans: text ? [{ text, marks }] : [],
});

describe("Markdown export loss preflight", () => {
  it("allows supported text and common marks without a loss warning", () => {
    expect(markdownExportLosses({ blocks: [
      block("paragraph", "正文", {}, { bold: "true", link: "https://example.com" }),
      block("h1", "标题"), block("todo", "任务", { checked: "true" }),
      block("code", "source"), block("diagram", "flowchart LR"),
    ] })).toEqual([]);
  });

  it("identifies data, layout, and file loss without including the content in the warning", () => {
    const losses = markdownExportLosses({ blocks: [
      block("title", "私密标题"),
      block("columns"),
      block("table", "", { tableData: '{"私密单元格":true}' }),
      block("image", "", { fileId: "123" }),
      block("file", "", { url: "https://example.com/private" }),
      block("bookmark", "", { url: "https://example.com/private" }),
    ] });
    expect(losses.join("；")).toContain("文档标题");
    expect(losses.join("；")).toContain("分栏");
    expect(losses.join("；")).toContain("表格数据格式异常");
    expect(losses.join("；")).toContain("没有可导出的链接");
    expect(losses.join("；")).toContain("图片和附件");
    expect(losses.join("；")).toContain("网页卡片或视频");
    expect(losses.join("；")).not.toMatch(/私密|example\.com/);
  });

  it("allows rectangular plain-text tables while warning about unsupported table data", () => {
    expect(markdownExportLosses({ blocks: [block("table", "", { tableData: JSON.stringify([["标题", "状态"], ["研发", "进行中"]]) })] })).toEqual([]);
    for (const data of ['[["a"],["b","c"]]', '[["a", 1]]', '[]', 'not-json']) {
      expect(markdownExportLosses({ blocks: [block("table", "", { tableData: data })] }).join("；")).toContain("表格数据格式异常");
    }
    expect(markdownExportLosses({ blocks: [block("table", "附加文字", { tableData: '[["a"]]', style: "custom" })] }).join("；")).toContain("表格的额外内容或设置");
  });

  it("warns when UTF-8 export would replace lone surrogates in cells, text, or links", () => {
    for (const item of [
      block("table", "", { tableData: JSON.stringify([["\ud800"]]) }),
      block("paragraph", "\udc00"),
      block("paragraph", "链接", {}, { link: "https://example.com/\ud800" }),
    ]) {
      expect(markdownExportLosses({ blocks: [item] }).join("；")).toContain("无效的 Unicode 字符");
    }
    expect(markdownExportLosses({ blocks: [block("paragraph", "😀"), block("table", "", { tableData: JSON.stringify([["😀"]]) })] })).toEqual([]);
  });

  it("warns for unsupported styles, empty blocks, and multi-line text", () => {
    const losses = markdownExportLosses({ blocks: [
      block("paragraph", "张三", {}, { mention: "user:1" }),
      block("paragraph", ""),
      block("paragraph", "第一行\n第二行"),
      block("unrecognized", "内容"),
    ] });
    expect(losses.join("；")).toContain("提及");
    expect(losses.join("；")).toContain("空段落");
    expect(losses.join("；")).toContain("换行");
    expect(losses.join("；")).toContain("特殊内容块");
  });

  it("flags whitespace in link targets and ambiguous formula fences without exposing contents", () => {
    for (const url of ["https://example.com/a b", "https://example.com/a\nb", "https://example.com/a\tb"]) {
      const losses = markdownExportLosses({ blocks: [block("paragraph", "链接", {}, { link: url })] });
      expect(losses.join("；")).toContain("含空格或换行的链接");
      expect(losses.join("；")).not.toContain("example.com");
    }
    for (const formula of ["x\n$$\ny", "x\n  $$  \ny"]) {
      expect(markdownExportLosses({ blocks: [block("math", formula)] }).join("；")).toContain("公式包含独立的 $$ 分隔符");
    }
    expect(markdownExportLosses({ blocks: [block("math", "$$"), block("math", "x\n$$y")] })).toEqual([]);
  });
});
