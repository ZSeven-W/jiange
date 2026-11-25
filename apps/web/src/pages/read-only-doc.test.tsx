import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { preloadReadOnlyRenderers, ReadOnlyDoc } from "./read-only-doc";
import { VersionView } from "./version-panel";
import type { DocView } from "@/lib/api";
import type { Comment } from "@/lib/api";
import { Doc, ROOT, Tx, idKey } from "@zseven-w/collab";

// Mermaid is asynchronous and requires a browser; exercise its integration here.
vi.mock("@/editor/diagram-view", () => ({ DiagramView: () => <span data-diagram-preview>流程图预览</span> }));

const b = (id: string, type: string, text = "", props: Record<string, string> = {}, parent = "0:0"): DocView["blocks"][number] => ({
  id, type, parent, props, spans: text ? [{ text, marks: {} }] : [],
});

describe("read-only document snapshots", () => {
  beforeAll(async () => {
    await preloadReadOnlyRenderers();
  });

  it("renders a mind map or ink even when the flowchart has no ordinary nodes", () => {
    const mind = b("1:1", "flowchart", "", { "fc.m.root": JSON.stringify({ parent: null, order: 0, text: "项目计划", x: 0, y: 0 }), "fc.m.child": JSON.stringify({ parent: "root", order: 0, text: "设计评审" }), "fc.mc.root": "1" });
    const ink = b("1:2", "flowchart", "", { "fc.s.ink": JSON.stringify({ points: [{ x: 0, y: 0 }, { x: 40, y: 30 }], color: "#3370ff", width: 3 }) });
    for (const publicToken of [undefined, "example-token"]) {
      const html = renderToStaticMarkup(<ReadOnlyDoc view={{ blocks: [mind, ink] }} publicToken={publicToken} />);
      expect(html).toContain("项目计划");
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain("设计评审");
      expect(html).toContain('data-flow-stroke="ink"');
      expect(html).toContain("min-w-[var(--flow-min-width)]");
      expect(html).not.toContain("空白流程图");
    }
  });
  it("preserves table column widths in normal, shared and presentation snapshots", () => {
    const view: DocView = { blocks: [b("1:1", "table", "", { tableData: '[["A","B"],["C","D"]]', tableWidths: '[180,120]' })] };
    for (const publicToken of [undefined, "example-token"]) {
      const html = renderToStaticMarkup(<ReadOnlyDoc view={view} publicToken={publicToken} />);
      expect(html).toContain('<col style="width:180px"/><col style="width:120px"/>');
      expect(html).toContain('style="width:300px"');
    }
  });
  it("shows an independently enabled title column in public and ordinary views", () => {
    const view: DocView = { blocks: [b("1:1", "table", "", { tableData: JSON.stringify([["A", "B"], ["C", "D"]]), tableHeader: "none", tableHeaderColumn: "column" })] };
    for (const publicToken of [undefined, "example-token"]) {
      const html = renderToStaticMarkup(<ReadOnlyDoc view={view} publicToken={publicToken} />);
      expect((html.match(/bg-\[#F5F6F7\]/g) ?? [])).toHaveLength(2);
      expect((html.match(/data-table-title-row="true"/g) ?? [])).toHaveLength(1);
      expect(html).toContain(">A</td>"); expect(html).toContain(">C</td>");
    }
  });
  it("exposes block link handles only when the public page supplies an action", () => {
    const view: DocView = { blocks: [b("1:1", "paragraph", "段落"), b("1:2", "columns"), b("1:3", "paragraph", "左栏", {}, "1:2")] };
    const ordinary = renderToStaticMarkup(<ReadOnlyDoc view={view} />);
    expect(ordinary).not.toContain("data-public-block");
    const shared = renderToStaticMarkup(<ReadOnlyDoc view={view} onCopyBlockLink={() => {}} />);
    expect(shared).toContain('data-public-block="1:1"');
    expect(shared).toContain('data-public-block="1:3"');
    expect((shared.match(/ data-block-handle="true"/g) ?? [])).toHaveLength(3);
  });
  it("renders formula instances once despite formatting splits, including legacy and copied formulas", () => {
    const paragraph = b("1:1", "paragraph");
    paragraph.spans = [
      { text: "前", marks: {} },
      { text: "x", marks: { math: "x^2", mathId: "1:10", bold: "true" } },
      { text: "^2", marks: { math: "x^2", mathId: "1:10" } },
      { text: "x^2", marks: { math: "x^2", mathId: "1:20" } },
      { text: "x^2x^2", marks: { math: "x^2" } },
      { text: "后😀", marks: {} },
    ];
    const html = renderToStaticMarkup(<ReadOnlyDoc view={{ blocks: [paragraph] }} />);
    expect((html.match(/class="jiange-math"/g) ?? [])).toHaveLength(3);
    expect(html).toContain("前");
    expect(html).toContain("后😀");
    expect(html).not.toContain("x^2");
  });

  it("renders rich content without exposing formula or diagram source", () => {
    const rich = b("1:1", "paragraph");
    rich.spans = [{ text: "重点", marks: { bold: "true", italic: "true" } }, { text: "文档", marks: { link: "https://example.com" } }];
    const view: DocView = { blocks: [rich, b("1:2", "math", "x^2+y^2"), b("1:3", "diagram", "flowchart LR\nA-->B"), b("1:4", "table", "", { tableData: JSON.stringify([["事项", "状态"], ["验收", "完成"]]) })] };
    const html = renderToStaticMarkup(<ReadOnlyDoc view={view} />);
    expect(html).toContain("font-semibold");
    expect(html).toContain("italic");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('class="jiange-math"');
    expect(html).toContain("data-diagram-preview");
    expect(html).toContain("验收");
    expect(html).not.toContain("x^2+y^2");
    expect(html).not.toContain("flowchart LR");
  });

  it("keeps a shared-document reference clickable and styled in read-only views", () => {
    const paragraph = b("1:1", "paragraph");
    paragraph.spans = [{ text: "共享文档", marks: { link: "#/s/valid_token" } }];
    const html = renderToStaticMarkup(<ReadOnlyDoc view={{ blocks: [paragraph] }} publicToken="public-token" />);
    expect(html).toContain('href="#/s/valid_token"');
    expect(html).toContain("bg-[#E1EAFF]");
    expect(html).not.toContain('target="_blank"');
  });
  it("does not style an internal text hyperlink as a document reference", () => {
    const paragraph = b("1:1", "paragraph");
    paragraph.spans = [{ text: "自定义文字", marks: { link: "#/doc/12", linkKind: "text" } }];
    const html = renderToStaticMarkup(<ReadOnlyDoc view={{ blocks: [paragraph] }} publicToken="public-token" />);
    expect(html).toContain('href="#/doc/12"');
    expect(html).not.toContain("bg-[#E1EAFF]");
  });

  it("renders column children only within their parent and rejects unsafe links and file IDs", () => {
    const paragraph = b("1:5", "paragraph");
    paragraph.spans = [{ text: "危险链接", marks: { link: "javascript:alert(1)" } }];
    const view: DocView = { blocks: [b("1:1", "columns"), b("1:2", "paragraph", "左栏", {}, "1:1"), b("1:3", "paragraph", "右栏", {}, "1:1"), b("1:4", "image", "", { fileId: "../../x", name: "图片" }), paragraph, b("1:6", "file", "", { fileId: "12", name: "资料.pdf", size: "1024" })] };
    const html = renderToStaticMarkup(<ReadOnlyDoc view={view} />);
    expect((html.match(/左栏/g) ?? [])).toHaveLength(1);
    expect((html.match(/右栏/g) ?? [])).toHaveLength(1);
    expect(html).toContain("图片不可用或需要登录");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("../../x");
    expect(html).toContain('href="/api/files/12"');
  });

  it("shows each column's alignment in read-only and public views", () => {
    const view: DocView = { blocks: [b("1:1", "columns"), b("1:2", "paragraph", "居中", { align: "center" }, "1:1"), b("1:3", "paragraph", "靠右", { align: "right" }, "1:1"), b("1:4", "paragraph", "默认", { align: "unknown" }, "1:1")] };
    const html = renderToStaticMarkup(<ReadOnlyDoc view={view} publicToken="example-token" />);
    expect(html).toMatch(/style="[^"]*text-align:center"[^>]*>.*居中/);
    expect(html).toMatch(/style="[^"]*text-align:right"[^>]*>.*靠右/);
    expect(html).toMatch(/style="[^"]*text-align:left"[^>]*>.*默认/);
    expect(html).toContain("data-column-scroll");
    expect(html).not.toContain("bg-sidebar/40");
  });

  it("projects saved column weights in presentation and public views", () => {
    const view: DocView = { blocks: [b("1:1", "columns", "", { columnWidths: JSON.stringify({"1:2":1400,"1:3":600}) }), b("1:2", "paragraph", "宽栏", {}, "1:1"), b("1:3", "paragraph", "窄栏", {}, "1:1")] };
    const html = renderToStaticMarkup(<ReadOnlyDoc view={view} publicToken="example-token" />);
    expect(html).toMatch(/style="flex-grow:1400;flex-basis:0%;text-align:left"[^>]*>.*宽栏/);
    expect(html).toMatch(/style="flex-grow:600;flex-basis:0%;text-align:left"[^>]*>.*窄栏/);
  });

  it("uses the current public link for shared media and hides protected downloads", () => {
    const view: DocView = { blocks: [b("1:1", "image", "", { fileId: "12", name: "预览图" }), b("1:2", "file", "", { fileId: "34", name: "方案.pdf" })] };
    const html = renderToStaticMarkup(<ReadOnlyDoc view={view} publicToken="example-token" />);
    expect(html).toContain('src="/api/public/example-token/files/12"');
    expect(html).toContain('href="/api/public/example-token/files/34"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).not.toContain('href="/api/files/34"');
    const protectedHTML = renderToStaticMarkup(<ReadOnlyDoc view={view} publicToken="example-token" disableFileDownloads />);
    expect(protectedHTML).toContain('src="/api/public/example-token/files/12"');
    expect(protectedHTML).not.toContain('/files/34');
    expect(protectedHTML).toContain("下载已关闭");
  });

  it("offers image preview only when a preview handler is supplied", () => {
    const view: DocView = { blocks: [b("1:1", "image", "", { fileId: "12", name: "示例.png", caption: "示意图", imageWidth: "50" })] };
    const normal = renderToStaticMarkup(<ReadOnlyDoc view={view} />);
    const preview = renderToStaticMarkup(<ReadOnlyDoc view={view} onPreviewImage={() => {}} />);
    expect(normal).not.toContain("查看图片：示意图");
    expect(preview).toContain('aria-label="查看图片：示意图"');
    expect(preview).toContain('src="/api/files/12"');
    expect(preview).toContain("width:50%");
  });

  it("projects live comment anchors in text, columns and whole blocks without using stale quotes", () => {
    const doc = new Doc(1), tx = new Tx(doc);
    const paragraph = tx.create("paragraph", null, ROOT);
    tx.insert(paragraph, 0, "前😀目标后");
    const columns = tx.create("columns", paragraph, ROOT);
    const column = tx.create("paragraph", null, columns);
    tx.insert(column, 0, "分栏内容");
    const image = tx.create("image", columns, ROOT);
    tx.setProp(image, "fileId", "12");
    const ids = doc.visibleIds(paragraph), columnIds = doc.visibleIds(column);
    const base: Comment = { id: 11, docId: 1, userId: 1, userName: "测试", block: idKey(paragraph), startChar: idKey(ids[1]), endChar: idKey(ids[3]), quote: "😀目标", body: "评论", resolved: false, createdAt: "", updatedAt: "" };
    const comments: Comment[] = [base, { ...base, id: 12 }, { ...base, id: 13, block: idKey(column), startChar: idKey(columnIds[0]), endChar: idKey(columnIds[1]) }, { ...base, id: 14, block: idKey(image), startChar: "", endChar: "" }, { ...base, id: 15, endChar: "99:99" }, { ...base, id: 16, resolved: true }];
    const html = renderToStaticMarkup(<ReadOnlyDoc view={doc.view()} commentDoc={doc} comments={comments} activeThread={11} onActivateComment={() => {}} />);
    expect(html).toContain('data-comment-anchor="11"');
    expect(html).toContain('data-comment-anchor="13"');
    expect(html).toContain('data-comment-block="14"');
    expect(html).toContain('bg-[#FBDC8D]');
    expect(html).not.toContain('data-comment-anchor="12"');
    expect(html).not.toContain('data-comment-anchor="15"');
    expect(html).not.toContain('data-comment-anchor="16"');
    expect(html).toContain("😀目标");
    const selectedImage = renderToStaticMarkup(<ReadOnlyDoc view={doc.view()} commentDoc={doc} comments={comments} activeThread={14} onActivateComment={() => {}} onPreviewImage={() => {}} />);
    expect(selectedImage).toMatch(/<img[^>]+class="[^"]*outline-\[#F0B400\]/);
    expect(selectedImage).not.toMatch(/data-readonly-block="image"[^>]+class="[^"]*outline/);
    new Tx(doc).delete(paragraph, 1, 3);
    const stale = renderToStaticMarkup(<ReadOnlyDoc view={doc.view()} commentDoc={doc} comments={comments} activeThread={11} onActivateComment={() => {}} />);
    expect(stale).not.toContain('data-comment-anchor="11"');
    expect(stale).not.toContain('data-comment-anchor="12"');
  });

  it("highlights the selected table rather than the full document width", () => {
    const doc = new Doc(1), tx = new Tx(doc), table = tx.create("table", null, ROOT);
    tx.setProp(table, "tableData", JSON.stringify([["事项", "状态"], ["评审", "完成"]]));
    const comment: Comment = { id: 14, docId: 1, userId: 1, userName: "测试", block: idKey(table), startChar: "", endChar: "", quote: "[表格]", body: "评论", resolved: false, createdAt: "", updatedAt: "" };
    const html = renderToStaticMarkup(<ReadOnlyDoc view={doc.view()} commentDoc={doc} comments={[comment]} activeThread={14} onActivateComment={() => {}} />);
    expect(html).toMatch(/class="[^"]*outline-\[#F0B400\][^"]*" data-table-block/);
    expect(html).not.toMatch(/data-readonly-block="table"[^>]+class="[^"]*outline/);
  });

  it("keeps images visible in protected versions without exposing attachment links", () => {
    const view: DocView = { blocks: [b("1:1", "image", "", { fileId: "12", name: "预览图" }), b("1:2", "file", "", { fileId: "34", name: "方案.pdf" })] };
    const protectedHTML = renderToStaticMarkup(<VersionView view={view} disableFileDownloads versionSeq={42} />);
    expect(protectedHTML).toContain('src="/api/files/12?version=42"');
    expect(protectedHTML).not.toContain('href="/api/files/34"');
    expect(protectedHTML).toContain("下载已关闭");
    const managerHTML = renderToStaticMarkup(<VersionView view={view} versionSeq={42} />);
    expect(managerHTML).toContain('src="/api/files/12?version=42"');
    expect(managerHTML).toContain('href="/api/files/34?version=42"');
  });

  it("limits video download controls and disables the external fallback link when downloads are restricted", () => {
    const view: DocView = { blocks: [b("1:1", "video", "", { url: "https://example.com/demo.mp4", name: "示例视频" }), b("1:2", "video", "", { url: "https://example.com/watch", name: "外部视频" })] };
    const restricted = renderToStaticMarkup(<ReadOnlyDoc view={view} disableFileDownloads />);
    expect(restricted).toContain('controlsList="nodownload"');
    expect(restricted).not.toContain('href="https://example.com/watch"');
    expect(restricted).toContain("当前不提供外部链接");
    const allowed = renderToStaticMarkup(<ReadOnlyDoc view={view} />);
    expect(allowed).not.toContain('controlsList="nodownload"');
    expect(allowed).toContain('href="https://example.com/watch"');
  });

  it("renders safe external and internal URL images while rejecting unsafe schemes", () => {
    const view: DocView = {
      blocks: [
        b("1:1", "image", "", { url: "https://cdn.example.com/hero.png", name: "外链图", caption: "说明" }),
        b("1:2", "image", "", { url: "/api/files/88", name: "站内图" }),
        b("1:3", "image", "", { url: "javascript:alert(1)", name: "危险图" }),
      ],
    };
    const html = renderToStaticMarkup(<ReadOnlyDoc view={view} />);
    expect(html).toContain('src="https://cdn.example.com/hero.png"');
    expect(html).toContain('src="/api/files/88"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("图片不可用或需要登录：危险图");
  });

  it("renders inline rich preview triggers for previewable attachments on public links and version previews", () => {
    const previewableFormats = [
      { id: "1:1", fileId: "101", name: "方案.pdf", mime: "application/pdf" },
      { id: "1:2", fileId: "102", name: "需求.docx", mime: "application/octet-stream" },
      { id: "1:3", fileId: "103", name: "预算.xlsx", mime: "application/octet-stream" },
      { id: "1:4", fileId: "104", name: "汇报.pptx", mime: "application/octet-stream" },
      { id: "1:5", fileId: "105", name: "说明.md", mime: "text/markdown" },
      { id: "1:6", fileId: "106", name: "数据.csv", mime: "text/csv" },
      { id: "1:7", fileId: "107", name: "脚本.ts", mime: "application/octet-stream" },
      { id: "1:8", fileId: "108", name: "演示.mp4", mime: "video/mp4" },
      { id: "1:9", fileId: "109", name: "录音.mp3", mime: "audio/mpeg" },
      { id: "1:10", fileId: "110", name: "海报.png", mime: "image/png" },
    ];
    const view: DocView = {
      blocks: [
        ...previewableFormats.map((f) => b(f.id, "file", "", { fileId: f.fileId, name: f.name, mime: f.mime, size: "2048" })),
        b("1:11", "file", "", { fileId: "111", name: "归档.zip", mime: "application/zip", size: "4096" }),
        b("1:12", "file", "", { fileId: "../bad", name: "非法.pdf", mime: "application/pdf", size: "512" }),
      ],
    };

    const publicHtml = renderToStaticMarkup(<ReadOnlyDoc view={view} publicToken="share-tok" allowCopy={false} />);
    expect((publicHtml.match(/data-public-file-preview="true"/g) ?? [])).toHaveLength(previewableFormats.length);
    expect((publicHtml.match(/在线预览/g) ?? [])).toHaveLength(previewableFormats.length);
    expect(publicHtml).toContain('href="/api/public/share-tok/files/101"');
    expect(publicHtml).toContain('href="/api/public/share-tok/files/111"');
    expect(publicHtml).not.toContain("../bad");
    expect(publicHtml).not.toContain("下载已禁止");

    const versionHtml = renderToStaticMarkup(<VersionView view={view} versionSeq={9} />);
    expect((versionHtml.match(/data-public-file-preview="true"/g) ?? [])).toHaveLength(previewableFormats.length);
    expect(versionHtml).toContain('href="/api/files/101?version=9"');
  });

  it("strictly disables inline rich preview and hides file URLs when disableFileDownloads is true", () => {
    const view: DocView = {
      blocks: [
        b("1:1", "file", "", { fileId: "34", name: "机密报告.pdf", mime: "application/pdf", size: "10240" }),
        b("1:2", "file", "", { fileId: "35", name: "财务模型.xlsx", mime: "application/octet-stream", size: "20480" }),
      ],
    };

    const publicRestricted = renderToStaticMarkup(<ReadOnlyDoc view={view} publicToken="secret-tok" disableFileDownloads allowCopy={false} />);
    expect(publicRestricted).not.toContain("data-public-file-preview");
    expect(publicRestricted).not.toContain("data-file-preview");
    expect(publicRestricted).not.toContain("在线预览");
    expect(publicRestricted).not.toContain("/files/34");
    expect(publicRestricted).not.toContain("/files/35");
    expect(publicRestricted).toContain("下载已禁止");
    expect(publicRestricted).toContain("下载已关闭");

    const versionRestricted = renderToStaticMarkup(<VersionView view={view} disableFileDownloads versionSeq={42} />);
    expect(versionRestricted).not.toContain("data-public-file-preview");
    expect(versionRestricted).not.toContain("data-file-preview");
    expect(versionRestricted).not.toContain("/files/34");
    expect(versionRestricted).toContain("下载已禁止");
  });
});
