import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDocx, readDocxFile } from "@/lib/docx";
import { parseXlsxBytesForWorkbook, writeXlsx } from "@jiange/sheet-sdk";
import { exportSlidesToPptx, parsePptxToSlides } from "@jiange/slides-sdk";
import {
  CodePreviewContent,
  CsvPreviewContent,
  detectCodeLanguage,
  detectPreviewKind,
  DocxPreviewContent,
  isRichPreviewable,
  MarkdownPreviewContent,
  PptxPreviewContent,
  RichFilePreview,
  XLSX_MAX_PREVIEW_COLS,
  XLSX_MAX_PREVIEW_ROWS,
  XlsxPreviewContent,
} from "./rich-file-preview";

describe("RichFilePreview type detection", () => {
  it("detects formats by MIME and falls back to filename extension for octet-stream", () => {
    expect(detectPreviewKind("report.pdf", "application/pdf")).toBe("pdf");
    expect(detectPreviewKind("report.pdf", "application/octet-stream")).toBe("pdf");
    expect(detectPreviewKind("demo.mp4", "application/octet-stream")).toBe("video");
    expect(detectPreviewKind("clip.ogg", "video/ogg")).toBe("video");
    expect(detectPreviewKind("voice.ogg", "audio/ogg")).toBe("audio");
    expect(detectPreviewKind("song.mp3", "application/octet-stream")).toBe("audio");
    expect(detectPreviewKind("spec.docx", "application/octet-stream")).toBe("docx");
    expect(detectPreviewKind("budget.xlsx", "application/octet-stream")).toBe("xlsx");
    expect(detectPreviewKind("deck.pptx", "application/octet-stream")).toBe("pptx");
    expect(detectPreviewKind("README.md", "application/octet-stream")).toBe("markdown");
    expect(detectPreviewKind("data.csv", "application/octet-stream")).toBe("csv");
    expect(detectPreviewKind("data.tsv", "text/tab-separated-values")).toBe("csv");
    expect(detectPreviewKind("index.ts", "application/octet-stream")).toBe("code");
    expect(detectPreviewKind("config.yaml", "application/octet-stream")).toBe("code");
    expect(detectPreviewKind("query.sql", "application/octet-stream")).toBe("code");
    expect(detectPreviewKind("payload.json", "application/json")).toBe("code");
    expect(detectPreviewKind("photo.png", "image/png")).toBe("image");
    expect(detectPreviewKind("archive.zip", "application/zip")).toBe("unknown");
    expect(detectPreviewKind("binary.bin", "application/octet-stream")).toBe("unknown");

    expect(isRichPreviewable("spec.docx", "application/octet-stream")).toBe(true);
    expect(isRichPreviewable("archive.zip", "application/zip")).toBe(false);
    expect(detectCodeLanguage("main.go")).toBe("Go");
    expect(detectCodeLanguage("schema.sql")).toBe("SQL");
    expect(detectCodeLanguage("app.tsx")).toBe("TSX");
    expect(detectCodeLanguage("notes.txt")).toBe("Plain Text");
  });
});

describe("RichFilePreview containers and media controls", () => {
  it("renders typed preview containers and enforces print/copy restrictions", () => {
    const pdfHtml = renderToStaticMarkup(
      <RichFilePreview src="/api/files/1" name="合同.pdf" mime="application/pdf" allowPrint={false} />,
    );
    expect(pdfHtml).toContain('data-rich-file-preview="pdf"');
    expect(pdfHtml).toContain('data-pdf-frame="true"');
    // Does not eagerly navigate iframe to raw attachment endpoint before blob fetch
    expect(pdfHtml).not.toContain('src="/api/files/1"');

    const videoHtml = renderToStaticMarkup(
      <RichFilePreview src="/api/files/2" name="演示.mp4" mime="application/octet-stream" allowPrint={false} />,
    );
    expect(videoHtml).toContain('data-video-preview="true"');
    expect(videoHtml).toContain('controlsList="nodownload"');
    expect(videoHtml).toContain('playsInline=""');

    const audioHtml = renderToStaticMarkup(
      <RichFilePreview src="/api/files/3" name="会议录音.mp3" mime="audio/mpeg" size={2048} allowPrint={false} />,
    );
    expect(audioHtml).toContain('data-audio-preview="true"');
    expect(audioHtml).toContain("会议录音.mp3");
    expect(audioHtml).toContain("2.0 KB");
    expect(audioHtml).toContain('controlsList="nodownload"');

    const fallbackAllowed = renderToStaticMarkup(
      <RichFilePreview src="/api/files/4" name="安装包.zip" mime="application/zip" allowPrint />,
    );
    expect(fallbackAllowed).toContain('data-fallback-preview="true"');
    expect(fallbackAllowed).toContain('href="/api/files/4"');

    const fallbackDenied = renderToStaticMarkup(
      <RichFilePreview src="/api/files/4" name="安装包.zip" mime="application/zip" allowPrint={false} allowCopy={false} />,
    );
    expect(fallbackDenied).toContain("select-none");
    expect(fallbackDenied).not.toContain('href="/api/files/4"');
    expect(fallbackDenied).toContain("下载未开放");
  });
});

describe("RichFilePreview Office, Markdown, CSV, and Code renderers", () => {
  it("renders parsed DOCX headings, lists, quotes, code blocks, and tables", async () => {
    const docxBytes = buildDocx(
      {
        blocks: [
          { type: "h1", props: {}, spans: [{ text: "项目方案", marks: {} }] },
          { type: "paragraph", props: {}, spans: [{ text: "核心目标与背景", marks: { bold: "true" } }] },
          { type: "bullet", props: { indent: "0" }, spans: [{ text: "支持在线预览", marks: {} }] },
          { type: "quote", props: {}, spans: [{ text: "重要引用说明", marks: {} }] },
          { type: "code", props: { lang: "ts" }, spans: [{ text: "const ok = true;", marks: {} }] },
          { type: "table", props: { tableData: JSON.stringify([["字段", "值"], ["状态", "完成"]]) }, spans: [] },
        ],
      },
      { title: "方案文档" },
    );
    const parsed = await readDocxFile({
      size: docxBytes.byteLength,
      arrayBuffer: async () => docxBytes.slice().buffer as ArrayBuffer,
    });
    const html = renderToStaticMarkup(<DocxPreviewContent result={parsed} name="方案文档.docx" />);
    expect(html).toContain("DOCX");
    expect(html).toContain("项目方案");
    expect(html).toContain("核心目标与背景");
    expect(html).toContain("支持在线预览");
    expect(html).toContain("重要引用说明");
    expect(html).toContain("const ok = true;");
    expect(html).toContain("完成");
  });

  it("renders parsed XLSX sheets with worksheet tabs and truncation hint when exceeding preview caps", async () => {
    const bytes = writeXlsx({
      sheets: [
        {
          name: "销售汇总",
          cells: [
            { row: 0, col: 0, value: "地区", style: { bold: true } },
            { row: 0, col: 1, value: "金额" },
            { row: 1, col: 0, value: "华东" },
            { row: 1, col: 1, value: 12800 },
            { row: XLSX_MAX_PREVIEW_ROWS + 5, col: 0, value: "超出行" },
          ],
        },
        {
          name: "明细表",
          cells: [{ row: 0, col: 0, value: "订单号" }],
        },
      ],
    });
    const workbook = await parseXlsxBytesForWorkbook(bytes);
    const html = renderToStaticMarkup(<XlsxPreviewContent workbook={workbook} name="Q4报表.xlsx" />);
    expect(html).toContain("XLSX");
    expect(html).toContain("销售汇总");
    expect(html).toContain("明细表");
    expect(html).toContain("华东");
    expect(html).toContain("12800");
    expect(html).toContain('data-xlsx-truncated="true"');
    expect(html).toContain(`${XLSX_MAX_PREVIEW_ROWS}`);
    expect(html).toContain(`${XLSX_MAX_PREVIEW_COLS}`);
    expect(html).not.toContain("超出行");
  });

  it("renders parsed PPTX slides with page counter, thumbnails, and speaker notes", async () => {
    const pptxBytes = exportSlidesToPptx(
      [
        {
          title: "年度复盘",
          body: "核心成果与明年规划",
          background: "#1f2329",
          layout: "title",
          notes: "开场强调团队目标达成率",
          shapes: [],
          hidden: false,
        },
        {
          title: "关键指标",
          body: "DAU 提升 45%",
          background: "#ffffff",
          layout: "",
          notes: "",
          shapes: [],
          hidden: false,
        },
      ],
      { title: "年度复盘" },
    );
    const parsed = await parsePptxToSlides(pptxBytes);
    const html = renderToStaticMarkup(<PptxPreviewContent presentation={parsed} name="复盘.pptx" />);
    expect(html).toContain("PPTX");
    expect(html).toContain("年度复盘");
    expect(html).toContain("核心成果与明年规划");
    expect(html).toContain("开场强调团队目标达成率");
    expect(html).toContain('data-pptx-notes="true"');
    expect(html).toContain("1 / 2");
    expect(html).toContain('data-pptx-thumb="0"');
    expect(html).toContain('data-pptx-thumb="1"');
  });

  it("renders Markdown safely without XSS and exposes mode toggle buttons", () => {
    const md = [
      "# 文档标题",
      "",
      "- **加粗** 与 `行内代码`",
      "- [安全链接](https://example.com) 与 [危险链接](javascript:alert(1))",
      "",
      "<script>alert('xss')</script>",
    ].join("\n");
    const html = renderToStaticMarkup(<MarkdownPreviewContent text={md} name="README.md" />);
    expect(html).toContain('data-md-mode="preview"');
    expect(html).toContain('data-md-mode="source"');
    expect(html).toContain("文档标题");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders CSV and TSV data into table view with source toggle", () => {
    const csvHtml = renderToStaticMarkup(<CsvPreviewContent text={'姓名,部门\n"张三",研发部\n李四,产品部'} name="名单.csv" />);
    expect(csvHtml).toContain("CSV");
    expect(csvHtml).toContain('data-csv-mode="table"');
    expect(csvHtml).toContain('data-csv-mode="source"');
    expect(csvHtml).toContain("张三");
    expect(csvHtml).toContain("研发部");

    const tsvHtml = renderToStaticMarkup(<CsvPreviewContent text={"ID\tName\n1\tAlpha"} name="export.tsv" tsv />);
    expect(tsvHtml).toContain("TSV");
    expect(tsvHtml).toContain("Alpha");
  });

  it("pretty-prints valid JSON, shows line numbers and language badge, and respects allowCopy", () => {
    const jsonHtml = renderToStaticMarkup(
      <CodePreviewContent text='{"ok":true,"count":3}' name="config.json" mime="application/json" allowCopy />,
    );
    expect(jsonHtml).toContain('data-code-lang="true"');
    expect(jsonHtml).toContain("JSON");
    expect(jsonHtml).toContain('data-json-pretty-toggle="true"');
    expect(jsonHtml).toContain("复制");
    expect(jsonHtml).toContain("&quot;ok&quot;: true");

    const noCopyHtml = renderToStaticMarkup(
      <CodePreviewContent text={"const x = 1;\nconsole.log(x);"} name="app.ts" allowCopy={false} />,
    );
    expect(noCopyHtml).toContain("TypeScript");
    expect(noCopyHtml).not.toContain("复制");
  });
});
