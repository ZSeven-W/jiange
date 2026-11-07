import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadOnlyDoc } from "./ReadOnlyDoc";
import { VersionView } from "./VersionPanel";
import type { DocView } from "@/lib/api";

// Mermaid is asynchronous and requires a browser; exercise its integration here.
vi.mock("@/editor/DiagramView", () => ({ DiagramView: () => <span data-diagram-preview>流程图预览</span> }));

const b = (id: string, type: string, text = "", props: Record<string, string> = {}, parent = "0:0"): DocView["blocks"][number] => ({
  id, type, parent, props, spans: text ? [{ text, marks: {} }] : [],
});

describe("read-only document snapshots", () => {
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

  it("keeps images visible in protected versions without exposing attachment links", () => {
    const view: DocView = { blocks: [b("1:1", "image", "", { fileId: "12", name: "预览图" }), b("1:2", "file", "", { fileId: "34", name: "方案.pdf" })] };
    const protectedHTML = renderToStaticMarkup(<VersionView view={view} disableFileDownloads versionSeq={42} />);
    expect(protectedHTML).toContain('src="/api/files/12?version=42"');
    expect(protectedHTML).not.toContain('href="/api/files/34"');
    expect(protectedHTML).toContain("下载已关闭");
    const managerHTML = renderToStaticMarkup(<VersionView view={view} versionSeq={42} />);
    expect(managerHTML).toContain('src="/api/files/12?version=42"');
    expect(managerHTML).toContain('href="/api/files/34"');
  });
});
