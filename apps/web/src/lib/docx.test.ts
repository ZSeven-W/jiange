import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { bodyBlocks } from "@/editor/model";
import { buildDocx, docxExportLosses, DOCX_MAX_BYTES, DocxImportError, imageInfo, isDocxFile, parseDocx, readDocxFile, type DocxExportBlock } from "./docx";
import { appendBlocksOps } from "./mdImport";
import { createZip, crc32, listZip, readZipEntry } from "./zip";
import { parseXml, XmlError } from "./xml";
import type { MdBlock } from "./markdown";

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
    { name: "word/document.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`) },
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

  it("imports into a collaborative document through the shared append path", async () => {
    const doc = new Doc(1);
    const init = new Tx(doc);
    const first = init.create("paragraph", null, ROOT);
    init.insert(first, 0, "原内容");
    const { blocks } = await parseDocx(buildDocx({ blocks: [b("h2", "标题"), b("paragraph", [{ text: "粗", marks: { bold: "true" } }, { text: "下", marks: { underline: "true" } }])] }));
    appendBlocksOps(doc, blocks);
    const ids = bodyBlocks(doc);
    expect(doc.text(first)).toBe("原内容");
    expect(doc.blockInfo(ids[1]).type).toBe("h2");
    expect(doc.richChars(ids[2]).map((c) => [c.ch, !!c.marks.bold, !!c.marks.underline])).toEqual([["粗", true, false], ["下", false, true]]);
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
  });

  it("does not report losses for fully supported content", () => {
    expect(docxExportLosses(view)).toEqual(["公式和图表以源码文本导出，Word 中不会渲染"]);
    expect(docxExportLosses({ blocks: [b("paragraph", [{ text: "x", marks: { link: "javascript:alert(1)" } }])] })).toEqual(["部分链接协议不受支持，已导出为普通文字"]);
  });
});

describe("Word import of third-party documents", () => {
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
    expect(result.warnings).toContain("合并单元格已拆分为普通单元格");
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
