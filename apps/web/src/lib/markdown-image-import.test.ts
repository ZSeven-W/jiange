import { describe, expect, it, vi } from "vitest";
import { Doc, ROOT, Tx } from "@zseven-w/collab";
import { bodyBlocks } from "@/editor/model";
import { appendBlocksOps } from "./md-import";
import { insertStarterBlocks } from "@/pages/starter-template-ops";
import {
  decodeDataUriImage,
  extractMarkdownImages,
  importMarkdownBlocksWithImages,
  isSafeMarkdownImageUrl,
} from "./markdown-image-import";

// Minimal 1x1 transparent PNG
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TINY_PNG_DATA_URI = `data:image/png;base64,${TINY_PNG_BASE64}`;

describe("Markdown image URL validation & data URI decoding", () => {
  it("accepts safe http(s) and internal /api/files URLs and rejects unsafe schemes", () => {
    expect(isSafeMarkdownImageUrl("https://cdn.example.com/a.png")).toBe(true);
    expect(isSafeMarkdownImageUrl("http://example.com/pic.jpg")).toBe(true);
    expect(isSafeMarkdownImageUrl("/api/files/42")).toBe(true);
    expect(isSafeMarkdownImageUrl("/api/files/42?version=3")).toBe(true);

    expect(isSafeMarkdownImageUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeMarkdownImageUrl("JAVASCRIPT:alert(1)")).toBe(false);
    expect(isSafeMarkdownImageUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeMarkdownImageUrl(TINY_PNG_DATA_URI)).toBe(false);
    expect(isSafeMarkdownImageUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeMarkdownImageUrl("./local.png")).toBe(false);
    expect(isSafeMarkdownImageUrl("//evil.example/x.png")).toBe(false);
    expect(isSafeMarkdownImageUrl("/api/files/../../etc")).toBe(false);
  });

  it("decodes safe raster base64 data URIs into File objects and rejects SVG/HTML", () => {
    const file = decodeDataUriImage(TINY_PNG_DATA_URI, "系统架构");
    expect(file).not.toBeNull();
    expect(file!.type).toBe("image/png");
    expect(file!.name).toBe("系统架构.png");
    expect(file!.size).toBeGreaterThan(20);

    expect(decodeDataUriImage("data:image/svg+xml;base64,PHN2Zy8+")).toBeNull();
    expect(decodeDataUriImage("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(decodeDataUriImage("not-a-data-uri")).toBeNull();
  });
});

describe("extractMarkdownImages", () => {
  it("recognizes inline, reference-style, and HTML <img> images while ignoring code and math blocks", () => {
    const md = [
      "# 标题",
      "",
      '![架构图](https://example.com/arch.png "核心架构")',
      "行内图片 ![图标][logo] 与 <img alt='横幅' src=\"https://example.com/banner.jpg\" title=\"顶部横幅\" />",
      "![内嵌](data:image/png;base64," + TINY_PNG_BASE64 + ")",
      "![平衡括号](https://en.wikipedia.org/wiki/Foo_(bar).png)",
      "[![构建状态](https://example.com/badge.png)](https://example.com/ci)",
      "",
      "行内代码 `![不算](https://example.com/inline-code.png)`",
      "",
      "```markdown",
      "![代码块不算](https://example.com/fenced.png)",
      '<img src="https://example.com/fenced-html.png" />',
      "```",
      "",
      "[logo]: https://example.com/logo.png \"Logo 标题\"",
    ].join("\n");

    const images = extractMarkdownImages(md);
    expect(images).toHaveLength(6);
    expect(images[0]).toMatchObject({ kind: "inline", alt: "架构图", title: "核心架构", src: "https://example.com/arch.png", safe: true });
    expect(images[1]).toMatchObject({ kind: "reference", alt: "图标", title: "Logo 标题", src: "https://example.com/logo.png", ref: "logo", safe: true });
    expect(images[2]).toMatchObject({ kind: "html", alt: "横幅", title: "顶部横幅", src: "https://example.com/banner.jpg", safe: true });
    expect(images[3]).toMatchObject({ kind: "inline", alt: "内嵌", isDataUri: true, safe: true });
    expect(images[4]).toMatchObject({ kind: "inline", alt: "平衡括号", src: "https://en.wikipedia.org/wiki/Foo_(bar).png", safe: true });
    expect(images[5]).toMatchObject({ kind: "inline", alt: "构建状态", src: "https://example.com/badge.png", safe: true });
  });
});

describe("importMarkdownBlocksWithImages", () => {
  it("uploads base64 data URI images (with deduplication), preserves safe URLs, and rejects unsafe schemes", async () => {
    const uploadImage = vi.fn(async (file: File) => ({
      id: 901,
      name: file.name,
      mime: file.type,
    }));

    const md = [
      "# 导入测试",
      "",
      `第一段 ![内嵌图](${TINY_PNG_DATA_URI}) 尾段`,
      `![重复内嵌](${TINY_PNG_DATA_URI})`,
      '![外链图](https://cdn.example.com/chart.png "季度趋势")',
      "![站内图](/api/files/77)",
      "![引用图][fig1]",
      '<img src="http://example.com/photo.jpg" alt="照片" />',
      "![恶意1](javascript:alert(1))",
      '<img src="vbscript:msgbox(1)" alt="恶意2" />',
      "![恶意SVG](data:image/svg+xml;base64,PHN2Zy8+)",
      "",
      "[fig1]: https://cdn.example.com/ref.webp",
    ].join("\n");

    const res = await importMarkdownBlocksWithImages(md, { uploadImage });
    // Identical data URI should only upload once
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(res.uploadedCount).toBe(2);
    expect(res.externalCount).toBe(4);
    expect(res.skippedCount).toBe(3);
    expect(res.warnings).toHaveLength(3);

    const imageBlocks = res.blocks.filter((b) => b.type === "image");
    expect(imageBlocks).toHaveLength(6);
    expect(imageBlocks[0].props).toEqual({
      fileId: "901",
      mime: "image/png",
      name: "内嵌图",
      caption: "内嵌图",
    });
    expect(imageBlocks[1].props).toEqual({
      fileId: "901",
      mime: "image/png",
      name: "重复内嵌",
      caption: "重复内嵌",
    });
    expect(imageBlocks[2].props).toEqual({
      url: "https://cdn.example.com/chart.png",
      name: "外链图",
      caption: "季度趋势",
    });
    expect(imageBlocks[3].props).toEqual({
      url: "/api/files/77",
      name: "站内图",
      caption: "站内图",
    });
    expect(imageBlocks[4].props).toEqual({
      url: "https://cdn.example.com/ref.webp",
      name: "引用图",
      caption: "引用图",
    });
    expect(imageBlocks[5].props).toEqual({
      url: "http://example.com/photo.jpg",
      name: "照片",
      caption: "照片",
    });

    // Consumed reference definition line must not leak as a paragraph
    expect(res.blocks.some((b) => b.text.includes("[fig1]:"))).toBe(false);
    // Surrounding text preserved
    expect(res.blocks.some((b) => b.type === "h1" && b.text === "导入测试")).toBe(true);
    expect(res.blocks.some((b) => b.type === "paragraph" && b.text === "第一段")).toBe(true);
    expect(res.blocks.some((b) => b.type === "paragraph" && b.text === "尾段")).toBe(true);
    // Zero unsafe URLs anywhere
    expect(JSON.stringify(res.blocks)).not.toContain("javascript:");
    expect(JSON.stringify(res.blocks)).not.toContain("vbscript:");
    expect(JSON.stringify(res.blocks)).not.toContain("svg+xml");

    // Inserts cleanly into both an empty starter CRDT doc and an existing doc
    const starterDoc = new Doc(1);
    new Tx(starterDoc).create("paragraph", null, ROOT);
    const starterTx = insertStarterBlocks(starterDoc, res.blocks, true, true);
    expect(starterTx).not.toBeNull();
    const createdTypes = bodyBlocks(starterDoc).map((id) => starterDoc.blockInfo(id).type);
    expect(createdTypes.filter((t) => t === "image")).toHaveLength(6);

    const existingDoc = new Doc(2);
    const existingTx = appendBlocksOps(existingDoc, res.blocks);
    expect(existingTx.ops.length).toBeGreaterThan(0);
  });
});
