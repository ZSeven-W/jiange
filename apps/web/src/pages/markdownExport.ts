import { tableDataOf } from "@/editor/tableCells";
import { markdownTableRows } from "@/lib/markdown";

type ExportBlock = {
  type: string;
  props: Record<string, string>;
  spans: { text: string; marks: Record<string, string> }[];
};

const TEXT_BLOCKS = new Set(["paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "quote", "bullet", "ordered", "todo"]);
const SPECIAL_BLOCKS = new Set(["code", "math", "diagram", "divider", "flowchart"]);
const MARKS = new Set(["bold", "italic", "strike", "code", "link"]);
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Describe losses in the current Markdown serializer without exposing document content. */
export function markdownExportLosses(view: { blocks: ExportBlock[] }): string[] {
  const losses = new Set<string>();
  for (const block of view.blocks) {
    const text = block.spans.map((span) => span.text).join("");
    // Blob converts lone UTF-16 surrogate code units to U+FFFD when encoding.
    const rows = block.type === "table" ? markdownTableRows(tableDataOf(block.props)) : null;
    if (UNPAIRED_SURROGATE.test(text) || Object.values(block.props).some((value) => UNPAIRED_SURROGATE.test(value)) || block.spans.some((span) => Object.values(span.marks).some((value) => UNPAIRED_SURROGATE.test(value))) || rows?.some((row) => row.some((cell) => UNPAIRED_SURROGATE.test(cell)))) {
      losses.add("存在无效的 Unicode 字符，导出时可能被替换");
    }
    if (block.type === "title") {
      if (text.trim()) losses.add("文档标题只用于文件名，不包含在正文中");
      continue;
    }
    if (block.type === "columns") losses.add("分栏布局会被展开");
    else if (block.type === "table") {
      if (!rows) losses.add("表格数据格式异常，原始数据会作为代码块导出，无法还原为表格");
      if (text || Object.entries(block.props).some(([key, value]) => key !== "tableData" && !key.startsWith("tbl.") && value)) losses.add("表格的额外内容或设置无法完整保留");
    }
    else if (block.type === "image" || block.type === "file") {
      losses.add("图片和附件不会打包，重新导入也无法还原原文件块");
      if (!block.props.url) losses.add("部分图片或附件没有可导出的链接");
    } else if (block.type === "callout") losses.add("高亮块的图标和样式会丢失");
    else if (block.type === "flowchart") losses.add("流程图会导出为 Mermaid 文本，布局、颜色与风格不保留，重新导入为 Mermaid 图表");
    else if (block.type === "bookmark" || block.type === "video") losses.add("网页卡片或视频及其链接可能无法保留");
    else if (!TEXT_BLOCKS.has(block.type) && !SPECIAL_BLOCKS.has(block.type)) losses.add("部分特殊内容块无法完整导出");

    if (block.type === "math" && text.includes("\n") && text.split("\n").some((line) => line.trim() === "$$")) {
      losses.add("公式包含独立的 $$ 分隔符，重新导入时公式可能被截断");
    }
    if (TEXT_BLOCKS.has(block.type)) {
      if (!text) losses.add("空段落和空文本块可能无法还原");
      if (text.includes("\n")) losses.add("文本块内换行可能无法还原");
      if (block.spans.some((span) => Object.entries(span.marks).some(([key, value]) => value && !MARKS.has(key)))) {
        losses.add("下划线、颜色、提及或公式等文字样式无法保留");
      }
      if (block.spans.some((span) => span.marks.link && /\s/.test(span.marks.link))) {
        losses.add("含空格或换行的链接无法完整保留，重新导入时可能变为普通文字或拆分段落");
      }
    }
  }
  return [...losses];
}
