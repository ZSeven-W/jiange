import { describe, expect, it, vi } from "vitest";
import {
  buildDocx,
  docxExportLosses,
  docxImportErrorMessage,
  DOCX_MAX_BYTES,
  DOCX_MIME,
  DocxImportError,
  imageInfo,
  isDocxFile,
  parseDocx,
  readDocxFile,
  safeDocxLink,
  type DocxExportBlock,
  type DocxImage,
} from "../src/docx.js";
import { createZip } from "../src/zip.js";

const enc = new TextEncoder();
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";

const blk = (type: string, spans: DocxExportBlock["spans"] | string = "", props: Record<string, string> = {}, extra: Partial<DocxExportBlock> = {}): DocxExportBlock => ({
  type,
  props,
  spans: typeof spans === "string" ? (spans ? [{ text: spans, marks: {} }] : []) : spans,
  ...extra,
});

function makePng(width = 4, height = 3): Uint8Array {
  const buf = new Uint8Array(24);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x89504e47);
  v.setUint32(4, 0x0d0a1a0a);
  v.setUint32(12, 0x49484452);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return buf;
}

function makeGif(width = 16, height = 12): Uint8Array {
  const buf = new Uint8Array(10);
  buf.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  const v = new DataView(buf.buffer);
  v.setUint16(6, width, true);
  v.setUint16(8, height, true);
  return buf;
}

function makeJpeg(width = 32, height = 24): Uint8Array {
  // SOI + non-0xFF filler + 0xFF padding + RST0 + APP0(len=4) + SOF0(h, w)
  const buf = new Uint8Array([
    0xff, 0xd8, // SOI
    0x00, // non-0xFF filler byte (p++)
    0xff, 0xff, // 0xFF pad (marker===0xff -> p+=1)
    0xd0, // RST0 (marker in 0xd0..0xd7 -> p+=2)
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 length 4 -> p += 2 + 4
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x00, 0x00,
  ]);
  return buf;
}

function rawDocx(
  body: string,
  extra: { name: string; data: string | Uint8Array }[] = [],
  rels = "",
  rootRels?: string,
  docPath = "word/document.xml",
): Uint8Array {
  const dir = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/") + 1) : "";
  const relsPath = `${dir}_rels/${docPath.slice(dir.length)}.rels`;
  const files: { name: string; data: Uint8Array }[] = [
    { name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`) },
    { name: docPath, data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}" xmlns:wp="${WP}" xmlns:mc="${MC}">${body}</w:document>`) },
    { name: relsPath, data: enc.encode(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`) },
  ];
  if (rootRels !== undefined) {
    files.push({ name: "_rels/.rels", data: enc.encode(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rootRels}</Relationships>`) });
  }
  for (const e of extra) {
    files.push({ name: e.name, data: typeof e.data === "string" ? enc.encode(e.data) : e.data });
  }
  return createZip(files);
}

describe("docx utility functions", () => {
  it("validates links, image headers, file reading, MIME detection, and error messages", async () => {
    expect(safeDocxLink(undefined)).toBeUndefined();
    expect(safeDocxLink("not a url")).toBeUndefined();
    expect(safeDocxLink("ftp://example.com")).toBeUndefined();
    expect(safeDocxLink("https://example.com")).toBe("https://example.com");
    expect(safeDocxLink("mailto:a@b.com")).toBe("mailto:a@b.com");

    expect(imageInfo(makePng(10, 20))).toEqual({ contentType: "image/png", width: 10, height: 20 });
    expect(imageInfo(makeGif(16, 12))).toEqual({ contentType: "image/gif", width: 16, height: 12 });
    expect(imageInfo(makeJpeg(32, 24))).toEqual({ contentType: "image/jpeg", width: 32, height: 24 });
    // Truncated / non-image / JPEG without SOF
    expect(imageInfo(new Uint8Array([0x01, 0x02]))).toBeNull();
    expect(imageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(imageInfo(new Uint8Array([0x47, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull();

    // readDocxFile: valid, too big, arrayBuffer error
    const validBytes = buildDocx({ blocks: [blk("paragraph", "hello")] });
    const res = await readDocxFile({ size: validBytes.length, arrayBuffer: async () => validBytes.buffer.slice(validBytes.byteOffset, validBytes.byteOffset + validBytes.byteLength) as ArrayBuffer });
    expect(res.blocks[0].text).toBe("hello");
    await expect(readDocxFile({ size: DOCX_MAX_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) })).rejects.toThrow(DocxImportError);
    await expect(readDocxFile({ size: 10, arrayBuffer: async () => { throw new Error("io"); } })).rejects.toThrow(/读取文件失败/);

    // docxImportErrorMessage & isDocxFile
    expect(docxImportErrorMessage(new DocxImportError("自定义错误"))).toBe("自定义错误");
    expect(docxImportErrorMessage(new Error("boom"))).toBe("Word 文档解析失败，未导入任何内容。");
    expect(isDocxFile({ name: "a.docx" })).toBe(true);
    expect(isDocxFile({ name: "a.bin", type: DOCX_MIME })).toBe(true);
    expect(isDocxFile({ name: "a.txt", type: "text/plain" })).toBe(false);
  });
});

describe("docx export losses and writer branches", () => {
  it("reports all export loss categories and builds DOCX for all block types, columns, images, and comments", async () => {
    const gifImg: DocxImage = { data: makeGif(16, 12), contentType: "image/gif", width: 16, height: 12 };
    const jpgImg: DocxImage = { data: makeJpeg(32, 24), contentType: "image/jpeg", width: 32, height: 24 };
    const images = new Map<string, DocxImage>([["gif1", gifImg], ["jpg1", jpgImg]]);

    const blocks: DocxExportBlock[] = [
      blk("title", "Block Title"),
      // Unpaired surrogate + non-DOCX mark + 3-digit & invalid hex colors + invalid indent
      blk("paragraph", [
        { text: "bad\uD800surr", marks: { mention: "1", color: "#abc", bg: "not-a-color" } },
      ]),
      blk("bullet", "indented", { indent: "not-a-number" }),
      // Columns: (1) without id, (2) with id & no children, (3) with id, children, nested child, empty-rendering child, and comment
      blk("columns", ""),
      blk("columns", "", {}, { id: "col-empty" }),
      blk("columns", "", {}, { id: "col-full" }),
      blk("paragraph", "Col 1", {}, { id: "c1", parent: "col-full" }),
      blk("paragraph", "Nested in Col 1", {}, { id: "c1-sub", parent: "c1" }),
      blk("title", "   ", {}, { id: "c2-blank", parent: "col-full" }), // bodyXml -> "" -> "<w:p/>"
      // Table with merges + fill + align + extra prop + bad header + unpaired surrogate in prop
      blk("table", "", {
        tableData: '[["A",""],["C","D"]]',
        tableMerges: "[[0,0,1,2]]",
        "tbl.fill.r0.c0": "#FF0000",
        "tbl.halign.r0.c0": "center",
        extraProp: "yes",
        tableHeader: "weird",
      }),
      // Malformed tableData -> exported as JiangeCode
      blk("table", "", { tableData: "{bad" }),
      // Images: GIF, JPEG, missing fileId, bad imageWidth
      blk("image", "", { fileId: "gif1", name: "g", imageWidth: "5" }),
      blk("image", "", { fileId: "jpg1", name: "j", imageWidth: "150" }),
      blk("image", "", { name: "no-id", imageWidth: "NaN" }),
      // Callout: no color/emoji, invalid color index
      blk("callout", "Default callout", {}),
      blk("callout", "Fallback color", { color: "99", emoji: "" }),
      // Empty code / math / diagram
      blk("code", ""),
      blk("math", ""),
      blk("diagram", ""),
      // File variants: text fallback, "附件" fallback, props.url fallback, no url
      blk("file", "FileText", { url: "https://example.com/f.pdf" }),
      blk("file", "", {}),
      // Bookmark & Video variants
      blk("bookmark", "", { title: "Site", url: "https://example.com" }),
      blk("bookmark", "", {}),
      blk("video", "VidText", {}),
      blk("video", "", {}),
      // Embed variants
      blk("embed", "", { resourceKind: "sheet", resourceId: "s1", title: "S" }),
      blk("embed", "", { resourceKind: "base", resourceId: "b1" }),
      blk("embed", "", { resourceKind: "survey", resourceId: "q1" }),
      blk("embed", "", { resourceKind: "slides", resourceId: "p1" }),
      blk("embed", "", {}),
      // Reminder variants
      blk("reminder", "", { done: "true", date: "2026-11-21", time: "10:00", label: "Meet" }),
      blk("reminder", "", {}),
      // Unknown block type
      blk("customWidget", "Custom text"),
    ];

    const losses = docxExportLosses({ blocks }, { images });
    expect(losses).toContain("存在无效的 Unicode 字符，导出时会被替换");
    expect(losses).toContain("分栏布局会被展开为普通段落");
    expect(losses).toContain("合并单元格中隐藏的背景色可能无法保留");
    expect(losses).toContain("合并单元格中隐藏的对齐方式可能无法保留");
    expect(losses).toContain("表格的额外内容或设置无法完整保留");
    expect(losses).toContain("部分图片宽度异常，导出时会使用受限的宽度或原始大小");
    expect(losses).toContain("网页卡片或视频只导出为链接");
    expect(losses).toContain("部分特殊内容块无法完整导出");
    expect(losses).toContain("提及、行内公式等特殊文字样式以纯文本导出");

    const bytes = buildDocx(
      { blocks },
      {
        images,
        origin: "https://jiange.test",
        comments: [
          // Skipped empty comment
          { author: "Empty", body: "   ", replies: [{ author: "R", body: "  " }] },
          // Empty body with non-empty reply + blank author + invalid date + resolved + anchored on columns block
          {
            blockId: "col-full",
            author: "   ",
            date: "not-a-date",
            body: "",
            resolved: true,
            replies: [
              { author: "   ", body: "Reply body" },
              { author: "Skip", body: "   " },
            ],
          },
          // Multiline unplaced comment (blockId not in document)
          { blockId: "missing-block", author: "Alice", body: "Line 1\nLine 2" },
        ],
      },
    );
    expect(bytes.byteLength).toBeGreaterThan(0);

    const parsed = await parseDocx(bytes, { images: true });
    expect(parsed.title).toBe("Block Title");
    expect(parsed.comments?.length).toBe(2);
    expect(parsed.images?.size).toBe(2);
  });
});

describe("docx import deep branches", () => {
  it("handles headers/footers with complex fields, tables, missing targets, and empty cleaned footers", async () => {
    const headerXml = `<?xml version="1.0"?><w:hdr xmlns:w="${W}">
      <w:tbl><w:tr><w:tc><w:p>
        <w:fldSimple w:instr="DATE"><w:r><w:t>2026</w:t></w:r></w:fldSimple>
        <w:fldSimple><w:r><w:t>NoInstr</w:t></w:r></w:fldSimple>
        <w:r><w:fldChar w:fldCharType="begin"/><w:instrText>TITLE</w:instrText><w:br/><w:tab/><w:fldChar w:fldCharType="separate"/><w:t>Hdr</w:t><w:br/><w:tab/><w:cr/><w:fldChar w:fldCharType="end"/></w:r>
        <w:del><w:r><w:t>deleted</w:t></w:r></w:del>
        <w:moveFrom><w:r><w:t>moved</w:t></w:r></w:moveFrom>
      </w:p></w:tc></w:tr></w:tbl>
    </w:hdr>`;
    // Footer that only contains PAGE / NUMPAGES -> cleaned becomes "" -> footerText undefined
    const pageOnlyFooter = `<?xml version="1.0"?><w:ftr xmlns:w="${W}"><w:p><w:r><w:t>第 </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t> 页 / 共 </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>2</w:t></w:r></w:fldSimple><w:r><w:t> 页</w:t></w:r></w:p></w:ftr>`;

    const docx1 = rawDocx(
      `<w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p><w:sectPr><w:headerReference r:id="rIdH"/><w:footerReference w:type="first" r:id="rIdF"/></w:sectPr></w:body>`,
      [
        { name: "word/header1.xml", data: headerXml },
        { name: "word/footer1.xml", data: pageOnlyFooter },
      ],
      `<Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="/word/header1.xml"/><Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="../word/footer1.xml"/><Relationship Id="rIdEmpty"/>`,
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document.xml"/>`,
    );
    const r1 = await parseDocx(docx1);
    expect(r1.headerText).toContain("2026");
    expect(r1.headerText).toContain("NoInstr");
    expect(r1.headerText).toContain("Hdr");
    expect(r1.footerText).toBeUndefined();

    // Missing header target xml (!xml -> undefined) & headerReference without r:id & root-level document.xml (dir === "")
    const docx2 = rawDocx(
      `<w:body><w:p><w:r><w:t>RootDoc</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rIdMissing"/><w:footerReference w:type="default"/><w:pgSz w:w="1000"/><w:pgMar w:left="800" w:right="800"/></w:sectPr></w:body>`,
      [],
      `<Relationship Id="rIdMissing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="missing-hdr.xml"/>`,
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="document.xml"/>`,
      "document.xml",
    );
    const r2 = await parseDocx(docx2);
    expect(r2.blocks[0].text).toBe("RootDoc");
    expect(r2.headerText).toBeUndefined();
    expect(r2.footerText).toBeUndefined();

    // Document without <w:body> exercises wordBodyWidth(undefined) before throwing empty content
    const noBody = rawDocx(``);
    await expect(parseDocx(noBody)).rejects.toThrow(/没有可导入的内容/);
  });

  it("handles styles, numbering, runMarks, inline wrappers, fields, symbols, pict, object, AlternateContent, notes, and comments", async () => {
    const stylesXml = `<?xml version="1.0"?><w:styles xmlns:w="${W}">
      <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
      <w:style w:type="paragraph"><w:name w:val="NoId"/></w:style>
      <w:style w:type="paragraph" w:styleId="NoName"><w:basedOn w:val="DoesNotExist"/></w:style>
      <w:style w:type="paragraph" w:styleId="Pre"><w:name w:val="HTML Preformatted"/></w:style>
      <w:style w:type="paragraph" w:styleId="LNum"><w:name w:val="List Number"/></w:style>
      <w:style w:type="paragraph" w:styleId="LBul"><w:name w:val="List Bullet"/></w:style>
      <w:style w:type="paragraph" w:styleId="ImgStyled"><w:pPr><w:jc w:val="right"/></w:pPr></w:style>
    </w:styles>`;

    const numberingXml = `<?xml version="1.0"?><w:numbering xmlns:w="${W}">
      <w:abstractNum><w:lvl/></w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
      <w:num><w:abstractNumId w:val="missing"/></w:num>
      <w:num w:numId="7"/>
      <w:num w:numId="5"><w:abstractNumId w:val="1"/><w:lvlOverride><w:lvl><w:numFmt w:val="bullet"/></w:lvl></w:lvlOverride></w:num>
      <w:num w:numId="6"><w:abstractNumId w:val="1"/></w:num>
    </w:numbering>`;

    const footnotesXml = `<?xml version="1.0"?><w:footnotes xmlns:w="${W}">
      <w:footnote w:id="0"><w:p><w:r><w:t>zero</w:t></w:r></w:p></w:footnote>
      <w:footnote w:id="1"><w:p><w:r><w:t>Valid fn</w:t></w:r></w:p></w:footnote>
    </w:footnotes>`;

    const commentsXml = `<?xml version="1.0"?><w:comments xmlns:w="${W}">
      <w:comment><w:p><w:r><w:t>NoId</w:t></w:r></w:p></w:comment>
      <w:comment w:id="9"><w:p><w:r><w:t>   </w:t></w:r></w:p></w:comment>
      <w:comment w:id="1"><w:p><w:r><w:t>Note 1</w:t></w:r></w:p></w:comment>
    </w:comments>`;

    const png = makePng(20, 10);
    const body = `<w:body>
      <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>First Title</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Second Title Becomes H1</w:t></w:r></w:p>
      <w:p><w:pPr><w:outlineLvl w:val="2"/><w:jc w:val="end"/></w:pPr><w:r><w:t>Outline H3 Right</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Pre"/></w:pPr><w:r><w:t>line 1</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Pre"/></w:pPr><w:r><w:t>line 2</w:t></w:r></w:p>
      <w:p><w:pPr><w:pBdr><w:bottom w:val="single"/></w:pBdr></w:pPr></w:p>
      <w:p><w:pPr><w:pStyle w:val="LNum"/></w:pPr><w:r><w:t>Plain List Number</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="LBul"/><w:numPr><w:numId w:val="5"/><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Override Bullet</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="LBul"/><w:numPr><w:numId w:val="6"/><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Ordered Format On Bullet</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="LNum"/><w:numPr><w:numId w:val="999"/><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Missing Num Format</w:t></w:r></w:p>
      <w:p><w:pPr><w:ind w:start="840"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>☐</w:t></w:r><w:r><w:t> Multi-span todo</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:numId w:val="6"/><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>☑ Numbered todo</w:t></w:r></w:p>
      <w:p><w:r><w:t>☐ No indent todo</w:t></w:r></w:p>
      <w:p>
        <w:r><w:rPr><w:u w:val="none"/><w:rFonts w:hAnsi="Consolas"/><w:color w:val="000000"/><w:shd w:fill="FFFFFF"/><w:highlight w:val="yellow"/></w:rPr><w:t>Styled</w:t></w:r>
        <w:r><w:rPr><w:rFonts/><w:highlight w:val="none"/></w:rPr><w:t>Clear</w:t></w:r>
        <w:r><w:rPr><w:vanish/></w:rPr><w:t>Hidden</w:t><w:drawing><a:blip r:embed="rIdImg"/></w:drawing><w:pict/></w:r>
        <w:hyperlink><w:r><w:t>NoRidLink</w:t></w:r></w:hyperlink>
        <w:hyperlink r:id="rIdInternal"><w:r><w:t>InternalLink</w:t></w:r></w:hyperlink>
        <w:fldSimple w:instr='HYPERLINK "https://jiange.dev"'><w:r><w:t>FldLink</w:t></w:r></w:fldSimple>
        <w:fldSimple><w:r><w:t>FldNoInstr</w:t></w:r></w:fldSimple>
        <w:sdt><w:sdtContent><w:r><w:t>Sdt1</w:t></w:r></w:sdtContent></w:sdt>
        <w:sdt><w:r><w:t>SdtDirect</w:t></w:r></w:sdt>
        <w:ins><w:r><w:t>Ins</w:t></w:r></w:ins>
        <w:moveTo><w:r><w:t>MoveTo</w:t></w:r></w:moveTo>
        <w:smartTag><w:r><w:t>Smart</w:t></w:r></w:smartTag>
        <w:customXml><w:r><w:t>Custom</w:t></w:r></w:customXml>
        <w:sdtContent><w:r><w:t>SdtC</w:t></w:r></w:sdtContent>
        <w:dir><w:r><w:t>Dir</w:t></w:r></w:dir>
        <w:bdo><w:r><w:t>Bdo</w:t></w:r></w:bdo>
        <w:del><w:r><w:t>Del</w:t></w:r></w:del>
        <w:moveFrom><w:r><w:t>MoveFrom</w:t></w:r></w:moveFrom>
        <w:r>
          <w:cr/><w:noBreakHyphen/>
          <w:sym w:char="00A9"/><w:sym w:char="F06E"/><w:sym/>
          <w:fldChar w:fldCharType="begin"/><w:t>SkipInInstr</w:t><w:fldChar w:fldCharType="end"/>
          <w:pict><w:txbxContent><w:p><w:r><w:t>PictTB</w:t></w:r></w:p></w:txbxContent></w:pict>
          <w:pict/>
          <w:object/>
          <mc:AlternateContent><mc:Choice><w:pict><w:txbxContent><w:p><w:r><w:t>AltPict</w:t></w:r></w:p></w:txbxContent></w:pict><w:r><w:t>AltRun</w:t></w:r><w:ins><w:r><w:t>AltIns</w:t></w:r></w:ins></mc:Choice></mc:AlternateContent>
          <mc:AlternateContent><mc:Fallback><w:r><w:t>AltFallbackRun</w:t></w:r></mc:Fallback></mc:AlternateContent>
          <mc:AlternateContent><mc:Choice><w:empty/></mc:Choice><mc:Fallback><w:empty/></mc:Fallback></mc:AlternateContent>
          <w:footnoteReference w:id="1"/><w:footnoteReference/><w:endnoteReference w:id="99"/>
          <w:commentReference w:id="999"/><w:commentReference/>
        </w:r>
        <mc:AlternateContent><mc:Choice><w:r><w:t>ParaAlt</w:t></w:r></mc:Choice></mc:AlternateContent>
        <mc:AlternateContent><mc:Choice><w:empty/></mc:Choice></mc:AlternateContent>
      </w:p>
      <w:p><w:r><w:commentReference w:id="1"/></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="ImgStyled"/><w:ind w:left="200"/></w:pPr><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" descr="Grouped"/><a:blip r:embed="rIdImg"/><a:blip r:embed="rIdImg"/></wp:inline></w:drawing></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Bold Caption</w:t></w:r></w:p>
      <w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="2" descr="Img2"/><a:blip r:embed="rIdImg"/></wp:inline></w:drawing></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t></w:t></w:r></w:p>
      <w:p><w:r><w:drawing><wp:inline><a:blip r:embed="rIdMissing"/></wp:inline></w:drawing><w:txbxContent/></w:r></w:p>
      <w:sdt><w:sdtContent><w:p><w:r><w:t>BodySdt</w:t></w:r></w:p></w:sdtContent></w:sdt>
      <w:sdt><w:p><w:r><w:t>BodySdtDirect</w:t></w:r></w:p></w:sdt>
      <w:customXml><w:p><w:r><w:t>BodyCustom</w:t></w:r></w:p></w:customXml>
      <w:ins><w:p><w:r><w:t>BodyIns</w:t></w:r></w:p></w:ins>
      <w:moveTo><w:p><w:r><w:t>BodyMoveTo</w:t></w:r></w:p></w:moveTo>
      <mc:AlternateContent><mc:Choice><w:p><w:r><w:t>BodyAlt</w:t></w:r></w:p></mc:Choice></mc:AlternateContent>
      <mc:AlternateContent><mc:Choice><w:empty/></mc:Choice></mc:AlternateContent>
    </w:body>`;

    const docx = rawDocx(
      body,
      [
        { name: "word/styles.xml", data: stylesXml },
        { name: "word/numbering.xml", data: numberingXml },
        { name: "word/footnotes.xml", data: footnotesXml },
        { name: "word/comments.xml", data: commentsXml },
        { name: "word/media/img1.png", data: png },
        { name: "word/media/bad.png", data: enc.encode("not-a-valid-image") },
      ],
      `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/img1.png"/>` +
        `<Relationship Id="rIdMissing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/missing.png"/>` +
        `<Relationship Id="rIdBadImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/bad.png"/>` +
        `<Relationship Id="rIdInternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="other.xml"/>`,
    );

    const res = await parseDocx(docx, { images: true });
    expect(res.title).toBe("First Title");
    expect(res.blocks.some((b) => b.type === "h1" && b.text === "Second Title Becomes H1")).toBe(true);
    expect(res.blocks.some((b) => b.type === "h3" && b.props.align === "right")).toBe(true);
    expect(res.blocks.some((b) => b.type === "code" && b.text === "line 1\nline 2")).toBe(true);
    expect(res.blocks.some((b) => b.type === "divider")).toBe(true);
    expect(res.warnings).toContain("修订中被删除的内容未导入，插入的修订按已接受处理");
    expect(res.warnings).toContain("组合图形只导入了第一张图片");
    expect(res.warnings).toContain("图片所在段落的缩进未保留");
    expect(res.warnings).toContain("图片说明中的文字样式未保留");
    expect(res.warnings).toContain("脚注和尾注未导入");
    expect(res.warnings).toContain("Word 批注未导入");
    expect(res.warnings).toContain("文本框中的内容未导入");
    expect(res.warnings).toContain("部分特殊内容未导入");
  });

  it("handles advanced table import edge cases and ZIP/XML/UTF-8 error handling", async () => {
    const png = makePng(10, 10);
    const commentsXml = `<?xml version="1.0"?><w:comments xmlns:w="${W}"><w:comment w:id="7" w:author="T"><w:p><w:r><w:t>CellCmt</w:t></w:r></w:p></w:comment></w:comments>`;
    const stylesXml = `<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:style w:type="character" w:styleId="JiangeCalloutIcon"><w:name w:val="Icon"/></w:style></w:styles>`;

    // 1025 gridCols to trigger > 1024 warning
    const bigGrid = `<w:tblGrid>${"<w:gridCol w:w=\"100\"/>".repeat(1025)}</w:tblGrid>`;
    const body = `<w:body>
      <w:tbl/>
      <w:tbl>
        <w:tblPr><w:tblLayout w:type="fixed"/></w:tblPr>
        <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
        <w:sdt><w:sdtContent>
          <w:tr>
            <w:trPr><w:tblHeader/><w:gridBefore w:val="1"/></w:trPr>
            <w:sdt><w:sdtContent>
              <w:tc>
                <w:tcPr><w:tcW w:type="auto"/><w:gridSpan w:val="999"/><w:vAlign w:val="both"/><w:shd w:val="pct10" w:fill="FF0000"/><w:vMerge w:val="restart"/></w:tcPr>
                <w:p><w:pPr><w:jc w:val="start"/></w:pPr><w:r><w:rPr><w:rStyle w:val="JiangeCalloutIcon"/></w:rPr><w:t>★</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Consolas"/><w:shd w:fill="F2F3F5"/></w:rPr><w:t>code</w:t></w:r><w:hyperlink r:id="rIdExt"><w:r><w:t>lnk</w:t></w:r></w:hyperlink><w:r><w:commentReference w:id="7"/></w:r></w:p>
                <w:p><w:r><w:t>Prefix</w:t><w:drawing><wp:inline><wp:docPr id="5" descr="CellPic"/><a:blip r:embed="rIdImg"/></wp:inline></w:drawing><w:pict><w:txbxContent><w:p><w:r><w:t>CellTB1</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>
                <w:p><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>CellTBOnly</w:t></w:r></w:p></w:txbxContent></w:pict><w:object/></w:r></w:p>
                <w:tbl><w:tr><w:tc><w:p><w:r><w:t>NestedCell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
                <w:sdt><w:sdtContent><w:p><w:r><w:t>SdtCell</w:t></w:r></w:p></w:sdtContent></w:sdt>
                <w:p/>
              </w:tc>
            </w:sdtContent></w:sdt>
            <w:tc><w:tcPr><w:shd w:themeFill="accent1"/></w:tcPr></w:tc>
          </w:tr>
        </w:sdtContent></w:sdt>
        <w:tr>
          <w:trPr><w:tblHeader/></w:trPr>
          <w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:p><w:pPr><w:jc w:val="end"/></w:pPr><w:r><w:t>OrphanSpan</w:t></w:r></w:p></w:tc>
          <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>TrailingVMerge</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
      <w:tbl>${bigGrid}<w:tr><w:tc><w:p><w:r><w:t>WideGrid</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body>`;

    const rels =
      `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/img1.png"/>` +
      `<Relationship Id="rIdExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://jiange.dev" TargetMode="External"/>`;

    const docx = rawDocx(
      body,
      [
        { name: "word/comments.xml", data: commentsXml },
        { name: "word/styles.xml", data: stylesXml },
        { name: "word/media/img1.png", data: png },
      ],
      rels,
    );

    // Import with images: true
    const withImgs = await parseDocx(docx, { images: true });
    expect(withImgs.warnings).toContain("多行表头仅保留首行");
    expect(withImgs.warnings).toContain("部分表格单元格垂直对齐方式未保留");
    expect(withImgs.warnings).toContain("部分表格背景样式无法完整导入");
    expect(withImgs.warnings).toContain("嵌套表格已展开为单元格文字");
    expect(withImgs.warnings).toContain("表格单元格中的部分扩展样式（如链接或底色）未保留");
    expect(withImgs.warnings).toContain("表格网格列数过多，已按实际单元格导入");
    expect(withImgs.warnings).toContain("表格单元格中的图片已提取为表格下方独立图片块");
    expect(withImgs.comments?.some((c) => c.id === "7" && c.blockIndex === 0)).toBe(true);

    // Import with images: false -> exercises L1352-1357 (table cell image skipped warning)
    const noImgs = await parseDocx(docx, { images: false });
    expect(noImgs.warnings).toContain("表格单元格中的图片暂不支持导入，已跳过");

    // Corrupt image CRC inside zip -> exercises catch in image loop (L1670)
    const corruptImgZip = rawDocx(
      `<w:body><w:p><w:r><w:t>Ok</w:t><w:drawing><wp:inline><a:blip r:embed="rIdImg"/></wp:inline></w:drawing></w:r></w:p></w:body>`,
      [{ name: "word/media/img1.png", data: png }],
      `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/img1.png"/>`,
    );
    // Flip a byte inside the PNG entry's data so readZipEntry throws checksum ZipError
    const pngOffset = corruptImgZip.findIndex((_, i) => corruptImgZip[i] === 0x89 && corruptImgZip[i + 1] === 0x50 && corruptImgZip[i + 2] === 0x4e);
    corruptImgZip[pngOffset + 10] ^= 0xff;
    const skippedCorruptImg = await parseDocx(corruptImgZip, { images: true });
    expect(skippedCorruptImg.warnings).toContain("部分图片无法导入，已跳过");

    // Encrypted ZIP entry -> ZipError(/encrypted/) -> DocxImportError("Word 文件已加密，无法导入。")
    const encZip = createZip([{ name: "word/document.xml", data: enc.encode("<w:document/>") }]);
    // Set bit 0 (encrypted) in general purpose bit flag of local header (offset 6) and central directory
    const view = new DataView(encZip.buffer, encZip.byteOffset, encZip.byteLength);
    const cdOffset = view.getUint32(encZip.length - 6, true);
    view.setUint16(6, view.getUint16(6, true) | 1, true);
    view.setUint16(cdOffset + 8, view.getUint16(cdOffset + 8, true) | 1, true);
    await expect(parseDocx(encZip)).rejects.toThrow(/Word 文件已加密/);

    // Invalid UTF-8 bytes in word/document.xml -> TextDecoder throws TypeError -> DocxImportError("Word 文档已损坏")
    const badUtf8Zip = createZip([{ name: "word/document.xml", data: new Uint8Array([0xff, 0xfe, 0xfd]) }]);
    await expect(parseDocx(badUtf8Zip)).rejects.toThrow(/Word 文档已损坏/);

    // Unexpected non-ZipError/XmlError/TypeError inside read() -> rethrown (L1638)
    const validZip = buildDocx({ blocks: [blk("paragraph", "hi")] });
    const origDecode = TextDecoder.prototype.decode;
    const spy = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, input?: AllowSharedBufferSource, opts?: TextDecodeOptions) {
      if (this.fatal) throw new RangeError("unexpected");
      return origDecode.call(this, input, opts);
    });
    await expect(parseDocx(validZip)).rejects.toThrow(RangeError);
    spy.mockRestore();
  });
});
