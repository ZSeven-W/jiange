import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildDocx, docxExportLosses, DOCX_MAX_BYTES, DocxImportError, imageInfo, isDocxFile, parseDocx, readDocxFile, type DocxExportBlock } from "../src/docx.js";
import { createZip, crc32, listZip, readZipEntry } from "../src/zip.js";
import { parseXml, XmlError } from "../src/xml.js";
import type { MdBlock } from "../src/markdown.js";
import { cellAlignKey, cellFillKey, cellTableWrites, stableTableDeleteWrites, stableTableInsertWrites, stableTableReorderWrites, tableCellAlign, tableCellFill, tableRowsOf } from "../src/table-cells.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (type: string, spans: DocxExportBlock["spans"] | string, props: Record<string, string> = {}): DocxExportBlock =>
  ({ type, props, spans: typeof spans === "string" ? (spans ? [{ text: spans, marks: {} }] : []) : spans });

/** Strip falsy props/marks so comparisons ignore "" vs missing and "1" vs "true". */
function normalize(blocks: MdBlock[]) {
  return blocks.map((block) => ({
    type: block.type,
    text: block.text || block.spans.map((s) => s.text).join(""),
    props: Object.fromEntries(Object.entries(block.props).filter(([, v]) => v && !(v === "0"))),
    spans: block.spans.map((s) => ({ text: s.text, marks: Object.fromEntries(Object.entries(s.marks).filter(([, v]) => v).map(([k, v]) => [k, k === "link" || k === "color" || k === "bg" ? v : "on"])) })),
  }));
}

/** Build a docx from raw document.xml body content (for importer-only cases). */
function rawDocx(body: string, extra: { name: string; data: string }[] = [], rels = ""): Uint8Array {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  return createZip([
    { name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`) },
    { name: "word/document.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}</w:body></w:document>`) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`) },
    ...extra.map((e) => ({ name: e.name, data: enc.encode(e.data) })),
  ]);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("zip", () => {
  it("computes standard CRC-32 values", () => {
    expect(crc32(enc.encode(""))).toBe(0);
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(enc.encode("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });

  it("round-trips STORE entries with UTF-8 names and verifies checksums", async () => {
    const zip = createZip([{ name: "a.txt", data: enc.encode("hello") }, { name: "目录/中文.xml", data: enc.encode("<x>你好</x>") }]);
    const entries = listZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "目录/中文.xml"]);
    expect(dec.decode(await readZipEntry(zip, entries[1], 1024))).toBe("<x>你好</x>");
    const corrupt = zip.slice();
    corrupt[30 + 5] ^= 0xff; // flip a byte inside "hello"
    await expect(readZipEntry(corrupt, listZip(corrupt)[0], 1024)).rejects.toThrow(/checksum/);
  });

  it("reads DEFLATE entries and bounds inflated size", async () => {
    const text = enc.encode("x".repeat(100_000));
    const compressed = await deflateRaw(text);
    // Build a deflate entry by hand from a STORE archive layout.
    const stored = createZip([{ name: "d", data: compressed }]);
    const view = new DataView(stored.buffer);
    const cd = view.getUint32(stored.length - 6, true);
    view.setUint16(8, 8, true); view.setUint32(22, text.length, true); view.setUint32(14, crc32(text), true);
    view.setUint16(cd + 10, 8, true); view.setUint32(cd + 24, text.length, true); view.setUint32(cd + 16, crc32(text), true);
    const entry = listZip(stored)[0];
    expect((await readZipEntry(stored, entry, 200_000)).length).toBe(100_000);
    await expect(readZipEntry(stored, entry, 50_000)).rejects.toThrow(/size limit/);
    await expect(readZipEntry(stored, { ...entry, size: 10 }, 50_000)).rejects.toThrow();
  });

  it("rejects archives without a central directory", () => {
    expect(() => listZip(enc.encode("PK not really a zip file at all........"))).toThrow();
  });
});

describe("xml", () => {
  it("parses elements, attributes, entities and CDATA", () => {
    const root = parseXml(`<?xml version="1.0"?><a x="1 &amp; 2"><b>t&lt;&#x4E2D;</b><![CDATA[<raw>]]><c/></a>`);
    expect(root.attrs.x).toBe("1 & 2");
    expect(root.children[0]).toMatchObject({ name: "b", children: ["t<中"] });
    expect(root.children[1]).toBe("<raw>");
  });
  it("rejects malformed XML and DOCTYPE", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(XmlError);
    expect(() => parseXml("<a>")).toThrow(XmlError);
    expect(() => parseXml(`<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>`)).toThrow(XmlError);
    expect(() => parseXml("<a>&bogus;</a>")).toThrow(XmlError);
  });
});

describe("Word export → import round trip", () => {
  it("warns when document references become ordinary Word hyperlinks", () => {
    const losses = (linkKind: string) => docxExportLosses({ blocks: [b("paragraph", [{ text: "链接", marks: { link: "#/doc/12", linkKind } }])] }, { origin: "https://jiange.test" });
    expect(losses("reference").join("；")).toContain("文档引用将作为普通超链接导出");
    expect(losses("text")).toEqual([]);
  });
  const view = {
    blocks: [
      b("title", "季度计划"),
      b("h1", "一级标题"), b("h2", "二级"), b("h3", "三级"), b("h4", "四级"), b("h5", "五级"), b("h6", "六级"),
      b("paragraph", [
        { text: "普通", marks: {} },
        { text: "粗体", marks: { bold: "true" } },
        { text: "斜体", marks: { italic: "true" } },
        { text: "下划线", marks: { underline: "true" } },
        { text: "删除线", marks: { strike: "true" } },
        { text: "code()", marks: { code: "true" } },
        { text: "链接", marks: { link: "https://example.com/a?b=1&c=2" } },
        { text: "红字", marks: { color: "#D83931" } },
        { text: "黄底", marks: { bg: "#FFF67A" } },
        { text: "组合", marks: { bold: "true", italic: "true", underline: "true" } },
      ], { align: "center" }),
      b("bullet", "项目一"), b("bullet", "子项", { indent: "1" }),
      b("ordered", "第一步"), b("ordered", "第二步"), b("ordered", "嵌套", { indent: "2" }),
      b("todo", "未完成", { indent: "0", checked: "" }), b("todo", "已完成", { indent: "1", checked: "true" }),
      b("quote", "引用 <tag> & \"quotes\""),
      b("code", [{ text: "const a = 1;\n\tif (a < 2) {}\n", marks: {} }]),
      b("callout", "注意事项", { color: "2", emoji: "🔥" }),
      b("divider", ""),
      b("table", "", { tableData: JSON.stringify([["名称", "数量"], ["苹果", "3"], ["多\n行", ""]]) }),
      b("math", "x^2 + y^2"),
      b("diagram", "graph TD; A-->B"),
      b("paragraph", "末尾段落"),
    ],
  };

  it("produces a well-formed OOXML package", async () => {
    const bytes = buildDocx(view, { title: "季度计划", now: new Date(2026, 0, 1) });
    const entries = listZip(bytes);
    const names = entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/_rels/document.xml.rels", "docProps/core.xml"]));
    for (const entry of entries) {
      const xml = dec.decode(await readZipEntry(bytes, entry, 1 << 24));
      expect(() => parseXml(xml)).not.toThrow();
    }
    const doc = dec.decode(await readZipEntry(bytes, entries.find((e) => e.name === "word/document.xml")!, 1 << 24));
    expect(doc).toContain(`<w:pStyle w:val="Heading1"/>`);
    expect(doc).toContain("<w:tbl>");
    expect(doc).toContain("&lt;tag&gt; &amp;");
  });

  it("restores blocks, marks, list structure and the title", async () => {
    const result = await parseDocx(buildDocx(view, { title: "季度计划" }));
    expect(result.title).toBe("季度计划");
    expect(result.warnings).toEqual([]);
    const expected = view.blocks.filter((x) => x.type !== "title").map((x) => ({ type: x.type, text: x.spans.map((s) => s.text).join(""), props: x.props, spans: x.type === "code" || x.type === "math" || x.type === "diagram" || x.type === "table" || x.type === "divider" ? [] : x.spans }));
    expect(normalize(result.blocks)).toEqual(normalize(expected));
  });

  it("embeds images when bytes are available and reports losses otherwise", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40, 0, 0, 0, 20, 8, 6, 0, 0, 0]);
    expect(imageInfo(png)).toEqual({ contentType: "image/png", width: 40, height: 20 });
    const blocks = [b("image", "", { fileId: "f1", name: "图" }), b("image", "", { fileId: "f2", name: "丢失" }), b("file", "", { fileId: "f3", name: "a.pdf" })];
    const images = new Map([["f1", { ...imageInfo(png)!, data: png }]]);
    const bytes = buildDocx({ blocks }, { images, origin: "https://jiange.test" });
    const entries = listZip(bytes);
    expect(entries.some((e) => e.name === "word/media/image1.png")).toBe(true);
    const types = dec.decode(await readZipEntry(bytes, entries.find((e) => e.name === "[Content_Types].xml")!, 1 << 20));
    expect(types).toContain(`Extension="png"`);
    const losses = docxExportLosses({ blocks }, { images, origin: "https://jiange.test" });
    expect(losses.join("；")).toMatch(/图片/);
    expect(losses.join("；")).toMatch(/附件/);
    const imported = await parseDocx(bytes);
    expect(imported.warnings.join("")).toMatch(/图片/);
    expect(imported.blocks.find((x) => x.text.includes("a.pdf"))?.spans[0].marks.link).toBe("https://jiange.test/api/files/f3");
    const withImages = await parseDocx(bytes, { images: true });
    expect(withImages.blocks.some((block) => block.type === "image")).toBe(true);
    expect(withImages.images?.size).toBe(1);
  });

  it("imports embedded images and preserves text and image order", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40, 0, 0, 0, 20]);
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:t>前文</w:t><w:drawing><wp:inline><wp:docPr descr="示意图"/><a:blip r:embed="pic"/></wp:inline></w:drawing><w:t>后文</w:t></w:r></w:p></w:body></w:document>`;
    const zip = createZip([
      { name: "word/document.xml", data: enc.encode(xml) },
      { name: "word/_rels/document.xml.rels", data: enc.encode(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="pic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/p.png"/></Relationships>`) },
      { name: "word/media/p.png", data: png },
    ]);
    const result = await parseDocx(zip, { images: true });
    expect(result.blocks.map((block) => [block.type, block.text])).toEqual([["paragraph", "前文"], ["image", ""], ["paragraph", "后文"]]);
    expect(result.blocks[1].props).toEqual({ importImageId: "pic", name: "示意图", align: "left" });
    expect(result.images?.get("pic")?.data).toEqual(png);
    expect(result.warnings).toContain("行内图片已拆分为独立图片块");
    const legacy = await parseDocx(zip);
    expect(legacy.blocks.map((block) => block.text)).toEqual(["前文后文"]);
    expect(legacy.warnings).toContain("部分图片无法导入，已跳过");
  });

  it("never fetches external images and reports them as skipped", async () => {
    const xml = `<w:p><w:r><w:t>正文</w:t><w:drawing><a:blip r:embed="pic"/></w:drawing></w:r></w:p>`;
    const zip = rawDocx(xml, [], `<Relationship Id="pic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.test/a.png" TargetMode="External"/>`);
    const result = await parseDocx(zip, { images: true });
    expect(result.images).toBeUndefined();
    expect(result.blocks.map((block) => block.text)).toEqual(["正文"]);
    expect(result.warnings).toContain("部分图片无法导入，已跳过");
  });

  it("round-trips image width percentages, paragraph alignment and captions", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0xb0, 0, 0, 2, 0x58]);
    const images = new Map([["f", { ...imageInfo(png)!, data: png }]]);
    const blocks = [b("image", "", { fileId: "f", imageWidth: "50", align: "left", caption: "图片说明" }), b("image", "", { fileId: "f", imageWidth: "75", align: "right" }), b("image", "", { fileId: "f", imageWidth: "100" })];
    const bytes = buildDocx({ blocks }, { images });
    const entry = listZip(bytes).find((e) => e.name === "word/document.xml")!;
    const xml = dec.decode(await readZipEntry(bytes, entry, 1 << 20));
    const widths = [...xml.matchAll(/<wp:extent cx="(\d+)"/g)].map((m) => Number(m[1]));
    const contentWidth = (11906 - 2 * 1440) * 635;
    expect(widths).toEqual([Math.round(contentWidth * 0.5), Math.round(contentWidth * 0.75), contentWidth]);
    const result = await parseDocx(bytes, { images: true });
    expect(result.blocks.map((block) => [block.type, block.props.imageWidth, block.props.align, block.props.caption])).toEqual([
      ["image", "50", "left", "图片说明"], ["image", "75", "right", undefined], ["image", "100", "center", undefined],
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("reports cropping and complex section widths instead of claiming fidelity", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40, 0, 0, 0, 20]);
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:drawing><wp:inline><wp:extent cx="1500000" cy="750000"/><a:srcRect l="10000"/><a:blip r:embed="pic"/></wp:inline></w:drawing></w:r></w:p><w:sectPr><w:pgSz w:w="10000"/><w:pgMar w:left="1000" w:right="1000"/><w:cols w:num="2"/></w:sectPr></w:body></w:document>`;
    const zip = createZip([{ name: "word/document.xml", data: enc.encode(xml) }, { name: "word/_rels/document.xml.rels", data: enc.encode(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="pic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/p.png"/></Relationships>`) }, { name: "word/media/p.png", data: png }]);
    const result = await parseDocx(zip, { images: true });
    expect(result.blocks[0].props.imageWidth).toBe("30");
    expect(result.warnings.join("；")).toMatch(/分节较复杂/);
    expect(result.warnings.join("；")).toMatch(/裁剪/);
  });

  it("does not report losses for fully supported content", () => {
    expect(docxExportLosses(view)).toEqual(["公式和图表以源码文本导出，Word 中不会渲染"]);
    expect(docxExportLosses({ blocks: [b("paragraph", [{ text: "x", marks: { link: "javascript:alert(1)" } }])] })).toEqual(["部分链接协议不受支持，已导出为普通文字"]);
    expect(docxExportLosses({ blocks: [b("table", "", { tableData: '[["a"]]', tableHeaderColumn: "column" })] })).toEqual([]);
  });
});

describe("Word table structure and headers", () => {
  it("exports inserted and deleted stable axes with surviving cell styles", async () => {
    const grid = [["标题", "状态"], ["任务", "完成"]], props: Record<string, string> = { tableData: JSON.stringify(grid), tableHeader: "none" };
    Object.assign(props, cellTableWrites(props, grid, 1));
    props[cellFillKey("r1", "c1")] = "#E3ECFF";
    props[cellAlignKey("r1", "c1", "horizontal")] = "right";
    Object.assign(props, stableTableInsertWrites(props, "row", 1, "a1_100"));
    Object.assign(props, stableTableDeleteWrites(props, "column", [0]));
    const imported = (await parseDocx(buildDocx({ blocks: [b("table", "", props)] }))).blocks[0];
    expect(tableRowsOf(imported.props)).toEqual([["状态"], [""], ["完成"]]);
    expect(tableCellFill(imported.props, 2, 0)).toBe("#E3ECFF");
    expect(tableCellAlign(imported.props, 2, 0, "horizontal")).toBe("right");
  });
  it("exports reordered stable axes with their cell styles", async () => {
    const grid = [["标题", "状态"], ["任务", "完成"]], props: Record<string, string> = { tableData: JSON.stringify(grid), tableHeader: "none" };
    Object.assign(props, cellTableWrites(props, grid, 1));
    props[cellFillKey("r0", "c1")] = "#E3ECFF";
    props[cellAlignKey("r0", "c1", "horizontal")] = "right";
    Object.assign(props, stableTableReorderWrites(props, "row", [1, 0]));
    Object.assign(props, stableTableReorderWrites(props, "column", [1, 0]));
    const imported = (await parseDocx(buildDocx({ blocks: [b("table", "", props)] }))).blocks[0];
    expect(tableRowsOf(imported.props)).toEqual([["完成", "任务"], ["状态", "标题"]]);
    expect(tableCellFill(imported.props, 1, 0)).toBe("#E3ECFF");
    expect(tableCellAlign(imported.props, 1, 0, "horizontal")).toBe("right");
  });
  it("round-trips cell horizontal and vertical alignment", async () => {
    const grid = [["名称", "进度"], ["多\n行", "完成"]], props: Record<string, string> = { tableData: JSON.stringify(grid), tableHeader: "none" };
    Object.assign(props, cellTableWrites(props, grid, 1));
    props[cellAlignKey("r0", "c1", "horizontal")] = "right";
    props[cellAlignKey("r0", "c1", "vertical")] = "bottom";
    props[cellAlignKey("r1", "c0", "horizontal")] = "center";
    props[cellAlignKey("r1", "c0", "vertical")] = "middle";
    const imported = (await parseDocx(buildDocx({ blocks: [b("table", "", props)] }))).blocks[0];
    expect(tableCellAlign(imported.props, 0, 1, "horizontal")).toBe("right");
    expect(tableCellAlign(imported.props, 0, 1, "vertical")).toBe("bottom");
    expect(tableCellAlign(imported.props, 1, 0, "horizontal")).toBe("center");
    expect(tableCellAlign(imported.props, 1, 0, "vertical")).toBe("middle");
  });
  it("warns when Word paragraphs in one cell have incompatible alignment", async () => {
    const body = '<w:tbl><w:tr><w:tc><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>一</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>二</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const result = await parseDocx(rawDocx(body));
    expect(result.warnings.join("；")).toContain("段落对齐方式未完整保留");
    expect(tableCellAlign(result.blocks[0].props, 0, 0, "horizontal")).toBe("right");
  });
  it("round-trips explicit cell fills, including white on a header", async () => {
    const grid = [["标题", "状态"], ["任务", "完成"]];
    const props: Record<string, string> = { tableData: JSON.stringify(grid), tableHeader: "row" };
    Object.assign(props, cellTableWrites(props, grid, 1));
    props[cellFillKey("r0", "c0")] = "#FFFFFF";
    props[cellFillKey("r1", "c1")] = "#E3ECFF";
    const bytes = buildDocx({ blocks: [b("table", "", props)] });
    const imported = (await parseDocx(bytes)).blocks[0];
    expect(tableCellFill(imported.props, 0, 0)).toBe("#FFFFFF");
    expect(tableCellFill(imported.props, 1, 1)).toBe("#E3ECFF");
    expect(tableCellFill(imported.props, 0, 1)).toBe("");
  });
  it("round-trips explicit column widths, including the total width of a merged cell", async () => {
    const props = { tableData: '[["计划","","团队"],["开发","完成","小简"]]', tableMerges: '[[0,0,1,2]]', tableHeader: "row", tableWidths: '[180,120,240]' };
    const blocks = [b("table", "", props)];
    expect(docxExportLosses({ blocks })).toEqual([]);
    const bytes = buildDocx({ blocks });
    const xml = dec.decode(await readZipEntry(bytes, listZip(bytes).find((e) => e.name === "word/document.xml")!, 1 << 24));
    expect(xml).toContain('<w:tblW w:w="8100" w:type="dxa"/><w:tblLayout w:type="fixed"/>');
    expect(xml).toContain('<w:tblGrid><w:gridCol w:w="2700"/><w:gridCol w:w="1800"/><w:gridCol w:w="3600"/></w:tblGrid>');
    expect(xml).toContain('<w:tcW w:w="4500" w:type="dxa"/><w:gridSpan w:val="2"/>');
    const result = await parseDocx(bytes);
    expect(result.warnings).toEqual([]);
    expect(result.blocks[0].props).toMatchObject({ tableData: props.tableData, tableMerges: props.tableMerges, tableWidths: props.tableWidths });
    expect(result.blocks[0].props.tableHeader).not.toBe("none");
  });

  it("warns when widths are automatic, invalid, too narrow, or exceed the Word page", () => {
    const data = '[["A","B"]]';
    const losses = (tableWidths: string) => docxExportLosses({ blocks: [b("table", "", { tableData: data, tableWidths })] });
    for (const value of ['[120,null]', '[80,120]', '[120]', 'invalid', '[0,120]']) expect(losses(value)).toContain("部分表格列宽为自动或无效值，Word 中可能不同");
    expect(losses('[400,400]')).toContain("表格宽于 Word 正文，列宽可能缩放");
    expect(losses('[120,180]')).toEqual([]);
  });

  it("imports fixed Word grid widths and warns about conflicting or automatic layout", async () => {
    const cells = '<w:tr><w:tc><w:tcPr><w:tcW w:w="2700" w:type="dxa"/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:tcW w:w="1800" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr>';
    const grid = '<w:tblGrid><w:gridCol w:w="2700"/><w:gridCol w:w="1800"/></w:tblGrid>';
    const fixed = await parseDocx(rawDocx(`<w:tbl><w:tblPr><w:tblW w:w="4500" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>${grid}${cells}</w:tbl>`));
    expect(fixed.blocks[0].props.tableWidths).toBe('[180,120]');
    expect(fixed.warnings).toEqual([]);
    const conflict = await parseDocx(rawDocx(`<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>${grid}${cells}</w:tbl>`));
    expect(conflict.warnings).toContain("表格列宽与网格不一致或小于最小宽度，显示可能不同");
    const auto = await parseDocx(rawDocx(`<w:tbl>${grid}${cells}</w:tbl>`));
    expect(auto.blocks[0].props.tableWidths).toBeUndefined();
    expect(auto.warnings).toContain("Word 表格使用自动布局，列宽可能不同");
    const missing = await parseDocx(rawDocx(`<w:tbl><w:tblPr><w:tblLayout w:type="fixed"/></w:tblPr>${cells}</w:tbl>`));
    expect(missing.warnings).toContain("表格固定列宽无法识别，已使用默认列宽");
  });

  it("retains trailing blank grid columns omitted by Word rows", async () => {
    const body = '<w:tbl><w:tblPr><w:tblW w:w="5700" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="2700"/><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/></w:tblGrid><w:tr><w:trPr><w:gridAfter w:val="2"/></w:trPr><w:tc><w:tcPr><w:tcW w:w="2700" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>保留</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const result = await parseDocx(rawDocx(body));
    expect(JSON.parse(result.blocks[0].props.tableData)).toEqual([["保留", "", ""]]);
    expect(result.blocks[0].props.tableWidths).toBe('[180,100,100]');
    expect(result.warnings).toEqual([]);
  });

  it("keeps an ordinary first row ordinary and round-trips combined horizontal and vertical merges", async () => {
    const rows = [["项目", "", "负责人"], ["", "", "小简"], ["状态", "完成", "备注"]];
    const props = { tableData: JSON.stringify(rows), tableMerges: JSON.stringify([[0, 0, 2, 2]]), tableHeader: "none", tableHeaderColumn: "column" };
    const blocks = [b("table", "", props)];
    const bytes = buildDocx({ blocks });
    const entry = listZip(bytes).find((e) => e.name === "word/document.xml")!;
    const xml = dec.decode(await readZipEntry(bytes, entry, 1 << 24));
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
    expect(xml).toContain('<w:vMerge w:val="restart"/>');
    expect(xml).toContain('<w:vMerge/>');
    expect(xml).not.toContain('<w:tblHeader/>');
    expect(xml).toContain('w:firstRow="0"');
    expect(xml).toContain('w:firstColumn="1"');
    expect(docxExportLosses({ blocks })).toEqual([]);
    const imported = (await parseDocx(bytes)).blocks.find((block) => block.type === "table")!;
    expect(imported.props).toMatchObject(props);
  });

  it("repeats an explicitly enabled title row and preserves a title column independently", async () => {
    for (const [header, column] of [["row", "none"], ["none", "column"], ["row", "column"], ["none", "none"]]) {
      const props = { tableData: '[["标题","状态"],["任务","完成"]]', tableHeader: header, tableHeaderColumn: column };
      const bytes = buildDocx({ blocks: [b("table", "", props)] });
      const xml = dec.decode(await readZipEntry(bytes, listZip(bytes).find((e) => e.name === "word/document.xml")!, 1 << 24));
      expect(xml.includes("<w:tblHeader/>" )).toBe(header === "row");
      const expectedMask = (0x400 | (header === "row" ? 0x20 : 0) | (column === "column" ? 0x80 : 0)).toString(16).padStart(4, "0").toUpperCase();
      expect(xml).toContain(`<w:tblLook w:val="${expectedMask}"`);
      const imported = (await parseDocx(bytes)).blocks[0];
      expect(imported.props.tableHeader !== "none").toBe(header === "row");
      expect(imported.props.tableHeaderColumn === "column").toBe(column === "column");
    }
  });

  it("does not hide populated covered cells when exporting a malformed or concurrent merge", async () => {
    const props = { tableData: '[["可见","隐藏但有值"],["下方","内容"]]', tableHeader: "none", tableMerges: '[[0,0,2,2]]' };
    const blocks = [b("table", "", props)];
    expect(docxExportLosses({ blocks })).toContain("部分合并区域无法无损导出，将拆分并保留单元格内容");
    const imported = (await parseDocx(buildDocx({ blocks }))).blocks[0];
    expect(imported.props.tableMerges).toBeUndefined();
    expect(JSON.parse(imported.props.tableData)).toEqual([["可见", "隐藏但有值"], ["下方", "内容"]]);
  });

  it("warns on out-of-bounds and overlapping merge metadata without losing table data", async () => {
    for (const tableMerges of ['[[0,0,3,2]]', '[[0,0,1,2],[0,1,2,1]]', '{bad']) {
      const props = { tableData: '[["A",""],["B","C"]]', tableHeader: "none", tableMerges };
      const blocks = [b("table", "", props)];
      expect(docxExportLosses({ blocks })).toContain("部分合并区域无法无损导出，将拆分并保留单元格内容");
      const imported = (await parseDocx(buildDocx({ blocks }))).blocks[0];
      expect(JSON.parse(imported.props.tableData)).toEqual([["A", ""], ["B", "C"]]);
    }
  });

  it("keeps text in nonempty Word vertical continuation cells and warns about the split", async () => {
    const body = '<w:tbl><w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>首格</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t>不可丢失</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const result = await parseDocx(rawDocx(body));
    expect(JSON.parse(result.blocks[0].props.tableData)).toEqual([["首格"], ["不可丢失"]]);
    expect(result.blocks[0].props.tableMerges).toBeUndefined();
    expect(result.warnings).toContain("部分合并单元格无法无损导入，已拆分并保留内容");
  });

  it("does not reinterpret third-party first-column styling or silently ignore unsupported merges", async () => {
    const body = '<w:tbl><w:tblPr><w:tblStyle w:val="ThirdParty"/><w:tblLook w:firstColumn="1"/></w:tblPr><w:tr><w:tc><w:tcPr><w:hMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:hMerge/></w:tcPr><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const result = await parseDocx(rawDocx(body));
    expect(result.blocks[0].props.tableHeader).toBe("none");
    expect(result.blocks[0].props.tableHeaderColumn).toBeUndefined();
    expect(JSON.parse(result.blocks[0].props.tableData)).toEqual([["A", "B"]]);
    expect(result.warnings).toContain("部分合并单元格无法无损导入，已拆分并保留内容");
  });

  it("does not treat an unknown vertical merge value as a continuation", async () => {
    const body = '<w:tbl><w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>首格</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:vMerge w:val="invalid"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>';
    const result = await parseDocx(rawDocx(body));
    expect(result.blocks[0].props.tableMerges).toBeUndefined();
    expect(result.warnings).toContain("部分合并单元格无法无损导入，已拆分并保留内容");
  });
});

describe("Word import of third-party documents", () => {
  it("imports a compressed python-docx document with renamed Word XML prefixes", async () => {
    const bytes = await readFile(new URL("./fixtures/python-docx-alternate-prefix.docx", import.meta.url));
    const result = await parseDocx(bytes, { images: true });
    expect(result.blocks.find((block) => block.type === "h1")?.text).toBe("项目协作方案");
    expect(result.blocks.find((block) => block.text.includes("完成设计评审"))?.spans.some((span) => span.text.includes("完成设计评审") && span.marks.bold)).toBeTruthy();
    expect(result.blocks.find((block) => block.type === "bullet")?.text).toBe("需求梳理与原型设计");
    expect(JSON.parse(result.blocks.find((block) => block.type === "table")!.props.tableData)).toEqual([["任务", "状态"], ["界面设计", "进行中"]]);
    expect(result.blocks.some((block) => block.type === "image")).toBe(true);
    expect(result.images?.size).toBe(1);
  });

  it("imports equivalent default and alternate namespace prefixes in text, styles, links and images", async () => {
    const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const pkg = "http://schemas.openxmlformats.org/package/2006/relationships";
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40, 0, 0, 0, 20]);
    const xml = `<document xmlns="${w}" xmlns:q="${w}" xmlns:link="${rel}" xmlns:draw="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pos="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><body><p><pPr><pStyle q:val="MyHeading"/></pPr><r><t>兼容标题</t></r></p><p><hyperlink link:id="url"><r><t>官网</t></r></hyperlink></p><p><r><drawing><pos:inline><pos:docPr descr="示意图"/><draw:blip link:embed="pic"/></pos:inline></drawing></r></p></body></document>`;
    const styles = `<s:styles xmlns:s="${w}"><s:style s:styleId="MyHeading"><s:name s:val="heading 1"/></s:style></s:styles>`;
    const rels = `<p:Relationships xmlns:p="${pkg}"><p:Relationship Id="url" Type="${rel}/hyperlink" Target="https://example.test/" TargetMode="External"/><p:Relationship Id="pic" Type="${rel}/image" Target="media/p.png"/></p:Relationships>`;
    const zip = createZip([{name:"word/document.xml",data:enc.encode(xml)}, {name:"word/styles.xml",data:enc.encode(styles)}, {name:"word/_rels/document.xml.rels",data:enc.encode(rels)}, {name:"word/media/p.png",data:png}]);
    const result = await parseDocx(zip, { images: true });
    expect(result.blocks.map((block) => [block.type, block.text])).toEqual([["h1", "兼容标题"], ["paragraph", "官网"], ["image", ""]]);
    expect(result.blocks[1].spans[0].marks.link).toBe("https://example.test/");
    expect(result.blocks[2].props.importImageId).toBe("pic");
    expect(result.images?.get("pic")?.data).toEqual(png);
  });

  it("rejects undeclared prefixes and duplicate expanded attributes", async () => {
    const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const broken = (xml: string) => createZip([{name:"word/document.xml", data:enc.encode(xml)}]);
    await expect(parseDocx(broken(`<w:document><w:body/></w:document>`))).rejects.toThrow(/损坏/);
    await expect(parseDocx(broken(`<w:document xmlns:w="${w}" xmlns:x="${w}"><w:body><w:p><w:pPr><w:pStyle w:val="x" x:val="y"/></w:pPr></w:p></w:body></w:document>`))).rejects.toThrow(/损坏/);
    await expect(parseDocx(broken(`<w:document xmlns:w="https://example.test/foreign"><w:body><w:p><w:r><w:t>不是正文</w:t></w:r></w:p></w:body></w:document>`))).rejects.toThrow(/不是有效/);
  });

  it("uses the namespace in each element's scope when prefixes are rebound", async () => {
    const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const xml = `<q:document xmlns:q="${w}"><q:body><w:p xmlns:w="${w}"><w:r><w:t>有效正文</w:t></w:r></w:p><w:p xmlns:w="https://example.test/foreign"><w:r><w:t>其他命名空间</w:t></w:r></w:p></q:body></q:document>`;
    const result = await parseDocx(createZip([{name:"word/document.xml",data:enc.encode(xml)}]));
    expect(result.blocks.map((block) => block.text)).toEqual(["有效正文"]);
  });

  it("recognizes localized heading styles, numbering, hyperlinks and fields", async () => {
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="a5"><w:name w:val="自定义"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
      <w:style w:type="character" w:styleId="c1"><w:name w:val="强调"/><w:rPr><w:b/></w:rPr></w:style></w:styles>`;
    const numbering = `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
      <w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num></w:numbering>`;
    const body = `
      <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>标题一</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="a5"/></w:pPr><w:r><w:t>大纲三级</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>编号</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>圆点</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:rStyle w:val="c1"/></w:rPr><w:t>样式粗体</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:hyperlink r:id="rId9"><w:r><w:t>官网</w:t></w:r></w:hyperlink><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t xml:space="preserve"> 非粗</w:t></w:r></w:p>
      <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://field.example" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>字段链接</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
      <w:p><w:hyperlink r:id="rId10"><w:r><w:t>坏链接</w:t></w:r></w:hyperlink></w:p>
      <w:p><w:r><w:br w:type="page"/></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:sectPr/>`;
    const rels = `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/" TargetMode="External"/><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>`;
    const result = await parseDocx(rawDocx(body, [{ name: "word/styles.xml", data: styles }, { name: "word/numbering.xml", data: numbering }], rels));
    expect(result.blocks.map((x) => [x.type, x.text, x.props.indent ?? ""])).toEqual([
      ["h1", "标题一", ""], ["h3", "大纲三级", ""], ["ordered", "编号", "0"], ["bullet", "圆点", "1"],
      ["paragraph", "样式粗体官网 非粗", ""], ["paragraph", "字段链接", ""], ["paragraph", "坏链接", ""], ["table", "", ""],
    ]);
    const para = result.blocks[4].spans;
    expect(para[0]).toEqual({ text: "样式粗体", marks: { bold: "true" } });
    expect(para[1]).toEqual({ text: "官网", marks: { link: "https://example.org/" } });
    expect(para[2].marks.bold).toBeUndefined();
    expect(result.blocks[5].spans[0].marks.link).toBe("https://field.example");
    expect(result.blocks[6].spans[0].marks.link).toBeUndefined();
    expect(JSON.parse(result.blocks[7].props.tableData)).toEqual([["合并", ""], ["a", "b\nc"]]);
    expect(JSON.parse(result.blocks[7].props.tableMerges)).toEqual([[0, 0, 1, 2]]);
    expect(result.warnings).not.toContain("合并单元格已拆分为普通单元格");
  });

  it("reads deflate-compressed parts like real Word files", async () => {
    const xml = enc.encode(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>压缩内容</w:t></w:r></w:p></w:body></w:document>`);
    const compressed = await deflateRaw(xml);
    const zip = createZip([{ name: "word/document.xml", data: compressed }]);
    const view = new DataView(zip.buffer);
    const cd = view.getUint32(zip.length - 6, true);
    view.setUint16(8, 8, true); view.setUint32(22, xml.length, true); view.setUint32(14, crc32(xml), true);
    view.setUint16(cd + 10, 8, true); view.setUint32(cd + 24, xml.length, true); view.setUint32(cd + 16, crc32(xml), true);
    expect((await parseDocx(zip)).blocks[0].text).toBe("压缩内容");
  });
});

describe("Word import rejects bad input", () => {
  it("rejects files over 10 MB before reading them", async () => {
    const huge = { size: DOCX_MAX_BYTES + 1, arrayBuffer: () => { throw new Error("must not read"); } } as unknown as Blob;
    await expect(readDocxFile(huge)).rejects.toThrow("Word 文件不能超过 10 MB。");
    await expect(parseDocx(new Uint8Array(DOCX_MAX_BYTES + 1))).rejects.toThrow(/10 MB/);
  });

  it("explains legacy .doc, non-zip, missing parts, corrupt XML and empty documents", async () => {
    await expect(parseDocx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).rejects.toThrow(/旧版 \.doc/);
    await expect(parseDocx(enc.encode("hello world"))).rejects.toThrow("文件不是有效的 Word（.docx）文档。");
    await expect(parseDocx(createZip([{ name: "foo.txt", data: enc.encode("x") }]))).rejects.toThrow("文件不是有效的 Word（.docx）文档。");
    await expect(parseDocx(createZip([{ name: "word/document.xml", data: enc.encode("<w:document><w:body><w:p></w:body></w:document>") }]))).rejects.toThrow("Word 文档已损坏，无法解析。");
    await expect(parseDocx(rawDocx("<w:p/><w:sectPr/>"))).rejects.toThrow("文件没有可导入的内容。");
    const truncated = buildDocx({ blocks: [b("paragraph", "内容")] }).slice(0, 200);
    await expect(parseDocx(truncated)).rejects.toBeInstanceOf(DocxImportError);
  });

  it("recognizes .docx files by name or MIME type", () => {
    expect(isDocxFile({ name: "报告.DOCX" })).toBe(true);
    expect(isDocxFile({ name: "x", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe(true);
    expect(isDocxFile({ name: "a.md", type: "text/markdown" })).toBe(false);
  });
});
