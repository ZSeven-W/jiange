import { tableDataOf } from "@/editor/tableCells";
/**
 * Word (.docx) import and export for Jiange documents, entirely client side.
 *
 * Export builds a minimal but valid WordprocessingML package (STORE zip) from
 * the collaborative doc view. Import unzips a .docx, walks word/document.xml
 * and produces the same `MdBlock` seeds the Markdown importer uses, so both
 * formats share one insertion path.
 */
import { CALLOUT_COLORS } from "@/editor/blockStyles";
import { markdownTableRows, type MdBlock, type MdSpan } from "./markdown";
import { createZip, listZip, readZipEntry, ZipError, type ZipEntry } from "./zip";
import { child, children, escapeXml, parseXml, XmlError, type XmlElement } from "./xml";

export const DOCX_MAX_BYTES = 10 * 1024 * 1024;
/** Upper bound for any single inflated part we read from the archive. */
const PART_LIMIT = 64 * 1024 * 1024;
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ---------------------------------------------------------------- shared

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const TODO_UNCHECKED = "☐";
const TODO_CHECKED = "☑";
const MONO_FONT = "Consolas";
const LIST_INDENT = 420; // twips per indent level

/** Only these link schemes are written to or read from Word documents. */
export function safeDocxLink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:" ? url : undefined;
  } catch { return undefined; }
}

// ---------------------------------------------------------------- export

export interface DocxExportBlock {
  type: string;
  props: Record<string, string>;
  spans: MdSpan[];
}

export interface DocxImage {
  data: Uint8Array;
  contentType: "image/png" | "image/jpeg" | "image/gif";
  width: number;
  height: number;
}

export interface DocxExportOptions {
  title?: string;
  /** Embedded image bytes keyed by the image block's fileId. */
  images?: Map<string, DocxImage>;
  /** Origin used to turn in-app links (files, `#/doc/…`) into absolute URLs. */
  origin?: string;
  now?: Date;
}

/** Identify PNG/JPEG/GIF bytes and read their pixel size from the header. */
export function imageInfo(data: Uint8Array): Omit<DocxImage, "data"> | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452) {
    return { contentType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return { contentType: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let p = 2;
    while (p + 9 < data.length) {
      if (data[p] !== 0xff) { p++; continue; }
      const marker = data[p + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { p += marker === 0xff ? 1 : 2; continue; }
      const length = view.getUint16(p + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { contentType: "image/jpeg", width: view.getUint16(p + 7), height: view.getUint16(p + 5) };
      }
      p += 2 + length;
    }
  }
  return null;
}

const TEXT_TYPES = new Set(["paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "quote", "bullet", "ordered", "todo", "callout"]);
const SOURCE_TYPES = new Set(["code", "math", "diagram"]);
const DOCX_MARKS = new Set(["bold", "italic", "underline", "strike", "code", "link", "color", "bg"]);
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function absoluteLink(url: string | undefined, origin: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("#/") && origin) return `${origin}/${url}`;
  return safeDocxLink(url);
}

/** Describe what the Word export cannot faithfully keep, without exposing document content. */
export function docxExportLosses(view: { blocks: DocxExportBlock[] }, options: { images?: Map<string, DocxImage>; origin?: string } = {}): string[] {
  const losses = new Set<string>();
  for (const block of view.blocks) {
    const text = block.spans.map((span) => span.text).join("");
    const rows = block.type === "table" ? markdownTableRows(tableDataOf(block.props)) : null;
    if (UNPAIRED_SURROGATE.test(text) || Object.values(block.props).some((value) => UNPAIRED_SURROGATE.test(value)) || rows?.some((row) => row.some((cell) => UNPAIRED_SURROGATE.test(cell)))) {
      losses.add("存在无效的 Unicode 字符，导出时会被替换");
    }
    if (block.type === "title") continue;
    if (block.type === "columns") losses.add("分栏布局会被展开为普通段落");
    else if (block.type === "table") {
      if (!rows) losses.add("表格数据格式异常，原始数据会作为文本导出");
      if (text || Object.entries(block.props).some(([key, value]) => key !== "tableData" && !key.startsWith("tbl.") && value)) losses.add("表格的额外内容或设置无法完整保留");
    } else if (block.type === "image") {
      if (!block.props.fileId || !options.images?.has(block.props.fileId)) losses.add("部分图片无法读取或格式不受支持（仅支持 PNG/JPEG/GIF），只导出图片名称");
    } else if (block.type === "file") losses.add("附件只导出为链接，不包含文件本身");
    else if (block.type === "bookmark" || block.type === "video") losses.add("网页卡片或视频只导出为链接");
    else if (block.type === "math" || block.type === "diagram") losses.add("公式和图表以源码文本导出，Word 中不会渲染");
    else if (block.type === "code" && block.props.lang) losses.add("代码块的语言设置不会保留");
    else if (block.type !== "divider" && !TEXT_TYPES.has(block.type) && !SOURCE_TYPES.has(block.type)) losses.add("部分特殊内容块无法完整导出");
    if (TEXT_TYPES.has(block.type)) {
      if (block.spans.some((span) => Object.entries(span.marks).some(([key, value]) => value && !DOCX_MARKS.has(key)))) losses.add("提及、行内公式等特殊文字样式以纯文本导出");
      if (block.spans.some((span) => span.marks.link && !absoluteLink(span.marks.link, options.origin))) losses.add("部分链接协议不受支持，已导出为普通文字");
    }
  }
  return [...losses];
}

function hexColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
  if (!match) return undefined;
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return hex.toUpperCase();
}

class DocxWriter {
  rels: { id: string; type: string; target: string; external?: boolean }[] = [];
  media: { name: string; data: Uint8Array; ext: string }[] = [];
  nums: number[] = []; // extra numIds for ordered lists (restart numbering)
  docPrId = 1;
  private nextRel = 1;
  constructor(readonly options: DocxExportOptions) {
    this.rel(`${REL_BASE}/styles`, "styles.xml");
    this.rel(`${REL_BASE}/numbering`, "numbering.xml");
    this.rel(`${REL_BASE}/settings`, "settings.xml");
  }
  rel(type: string, target: string, external = false): string {
    const id = `rId${this.nextRel++}`;
    this.rels.push({ id, type, target, external });
    return id;
  }
  hyperlink(url: string): string { return this.rel(`${REL_BASE}/hyperlink`, url, true); }

  runs(spans: MdSpan[], extraRPr = ""): string {
    let out = "";
    let i = 0;
    while (i < spans.length) {
      const link = absoluteLink(spans[i].marks.link, this.options.origin);
      if (!link) { out += this.run(spans[i].text, spans[i].marks, extraRPr); i++; continue; }
      let inner = "";
      while (i < spans.length && absoluteLink(spans[i].marks.link, this.options.origin) === link) {
        inner += this.run(spans[i].text, spans[i].marks, extraRPr, true);
        i++;
      }
      out += `<w:hyperlink r:id="${this.hyperlink(link)}" w:history="1">${inner}</w:hyperlink>`;
    }
    return out;
  }

  run(text: string, marks: Record<string, string>, extraRPr = "", link = false): string {
    if (!text) return "";
    let rPr = "";
    if (marks.code) rPr += `<w:rStyle w:val="JiangeInlineCode"/>`;
    else if (link) rPr += `<w:rStyle w:val="Hyperlink"/>`;
    if (marks.code) rPr += `<w:rFonts w:ascii="${MONO_FONT}" w:hAnsi="${MONO_FONT}" w:cs="${MONO_FONT}"/>`;
    if (marks.bold) rPr += "<w:b/><w:bCs/>";
    if (marks.italic) rPr += "<w:i/><w:iCs/>";
    if (marks.strike) rPr += "<w:strike/>";
    const color = hexColor(marks.color);
    if (color) rPr += `<w:color w:val="${color}"/>`;
    if (marks.underline) rPr += `<w:u w:val="single"/>`;
    const bg = hexColor(marks.bg);
    if (bg) rPr += `<w:shd w:val="clear" w:color="auto" w:fill="${bg}"/>`;
    rPr += extraRPr;
    return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}${textContentXml(text)}</w:r>`;
  }

  image(image: DocxImage, name: string, widthPx: number | undefined): string {
    const ext = image.contentType === "image/png" ? "png" : image.contentType === "image/gif" ? "gif" : "jpeg";
    const file = `image${this.media.length + 1}.${ext}`;
    this.media.push({ name: file, data: image.data, ext });
    const rid = this.rel(`${REL_BASE}/image`, `media/${file}`);
    const natural = Math.max(1, image.width);
    let width = Math.min(624, widthPx && widthPx > 0 ? widthPx : natural);
    const height = Math.max(1, Math.round((width * Math.max(1, image.height)) / natural));
    width = Math.max(1, Math.round(width));
    const cx = width * 9525, cy = height * 9525;
    const id = this.docPrId++;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="图片 ${id}" descr="${escapeXml(name)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="${NS_PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${file}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }
}

function textContentXml(text: string): string {
  let out = "";
  const parts = text.split(/(\n|\t)/);
  for (const part of parts) {
    if (part === "\n") out += "<w:br/>";
    else if (part === "\t") out += "<w:tab/>";
    else if (part) out += `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`;
  }
  return out;
}

function paragraph(pPr: string, content: string): string {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${content}</w:p>`;
}

function alignXml(props: Record<string, string>): string {
  return props.align === "center" ? `<w:jc w:val="center"/>` : props.align === "right" ? `<w:jc w:val="right"/>` : "";
}

function indentLevel(props: Record<string, string>): number {
  const n = Number(props.indent ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.min(8, Math.floor(n))) : 0;
}

function tableXml(rows: string[][]): string {
  const cols = rows[0].length;
  const width = Math.max(600, Math.floor(9026 / cols));
  const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join("");
  const body = rows.map((row, r) => `<w:tr>${r === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${row.map((cell) => {
    const paras = cell.split("\n").map((line) => paragraph("", line ? `<w:r>${r === 0 ? "<w:rPr><w:b/><w:bCs/></w:rPr>" : ""}${textContentXml(line)}</w:r>` : "")).join("");
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${r === 0 ? `<w:shd w:val="clear" w:color="auto" w:fill="F5F6F7"/>` : ""}</w:tcPr>${paras}</w:tc>`;
  }).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblStyle w:val="JiangeTable"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

function bodyXml(blocks: DocxExportBlock[], w: DocxWriter): string {
  const out: string[] = [];
  let orderedNum = 0;
  let inList = false;
  for (const block of blocks) {
    const spans = block.spans.filter((span) => span.text);
    const text = spans.map((span) => span.text).join("");
    const isList = block.type === "bullet" || block.type === "ordered" || block.type === "todo";
    if (!isList) { inList = false; orderedNum = 0; }
    switch (block.type) {
      case "title":
        if (text.trim()) out.push(paragraph(`<w:pStyle w:val="Title"/>`, w.runs(spans)));
        break;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        out.push(paragraph(`<w:pStyle w:val="Heading${block.type[1]}"/>${alignXml(block.props)}`, w.runs(spans)));
        break;
      case "bullet":
        out.push(paragraph(`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${indentLevel(block.props)}"/><w:numId w:val="1"/></w:numPr>${alignXml(block.props)}`, w.runs(spans)));
        break;
      case "ordered":
        if (!inList || !orderedNum) { w.nums.push(w.nums.length + 2); orderedNum = w.nums.at(-1)!; }
        out.push(paragraph(`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${indentLevel(block.props)}"/><w:numId w:val="${orderedNum}"/></w:numPr>${alignXml(block.props)}`, w.runs(spans)));
        break;
      case "todo": {
        const level = indentLevel(block.props);
        const box = block.props.checked === "true" ? TODO_CHECKED : TODO_UNCHECKED;
        out.push(paragraph(`<w:pStyle w:val="JiangeTodo"/><w:ind w:left="${LIST_INDENT * (level + 1)}" w:hanging="${LIST_INDENT}"/>${alignXml(block.props)}`, w.run(`${box} `, {}) + w.runs(spans)));
        break;
      }
      case "quote":
        out.push(paragraph(`<w:pStyle w:val="Quote"/>${alignXml(block.props)}`, w.runs(spans)));
        break;
      case "callout": {
        const [fill, border] = CALLOUT_COLORS[Number(block.props.color ?? 0)] ?? CALLOUT_COLORS[0];
        const b = `w:val="single" w:sz="6" w:space="4" w:color="${border.slice(1)}"`;
        const icon = block.props.emoji ? w.run(`${block.props.emoji} `, {}, `<w:rStyle w:val="JiangeCalloutIcon"/>`) : "";
        out.push(paragraph(`<w:pStyle w:val="JiangeCallout"/><w:pBdr><w:top ${b}/><w:left ${b}/><w:bottom ${b}/><w:right ${b}/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${fill.slice(1)}"/>${alignXml(block.props)}`, icon + w.runs(spans)));
        break;
      }
      case "code":
        out.push(paragraph(`<w:pStyle w:val="JiangeCode"/>`, text ? `<w:r><w:rPr><w:rFonts w:ascii="${MONO_FONT}" w:hAnsi="${MONO_FONT}" w:cs="${MONO_FONT}"/></w:rPr>${textContentXml(text)}</w:r>` : ""));
        break;
      case "math":
      case "diagram":
        out.push(paragraph(`<w:pStyle w:val="${block.type === "math" ? "JiangeMath" : "JiangeDiagram"}"/>`, text ? `<w:r><w:rPr><w:rFonts w:ascii="${MONO_FONT}" w:hAnsi="${MONO_FONT}" w:cs="${MONO_FONT}"/></w:rPr>${textContentXml(text)}</w:r>` : ""));
        break;
      case "divider":
        out.push(paragraph(`<w:pStyle w:val="JiangeDivider"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="DEE0E3"/></w:pBdr>`, ""));
        break;
      case "table": {
        const rows = markdownTableRows(tableDataOf(block.props));
        if (rows) { out.push(tableXml(rows)); out.push(paragraph("", "")); }
        else out.push(paragraph(`<w:pStyle w:val="JiangeCode"/>`, w.run(tableDataOf(block.props), { code: "true" })));
        break;
      }
      case "image": {
        const image = block.props.fileId ? w.options.images?.get(block.props.fileId) : undefined;
        const name = block.props.name || "图片";
        const width = Number(block.props.imageWidth) || undefined;
        if (image) out.push(paragraph(alignXml(block.props), w.image(image, name, width)));
        else out.push(paragraph(alignXml(block.props), w.run(`[图片：${name}]`, {})));
        if (block.props.caption) out.push(paragraph(`<w:pStyle w:val="Caption"/>${alignXml(block.props)}`, w.run(block.props.caption, {})));
        break;
      }
      case "file": {
        const name = block.props.name || text || "附件";
        const url = block.props.fileId && w.options.origin ? `${w.options.origin}/api/files/${encodeURIComponent(block.props.fileId)}` : block.props.url;
        out.push(paragraph("", w.runs([{ text: `📎 ${name}`, marks: url ? { link: url } : {} }])));
        break;
      }
      case "bookmark":
      case "video": {
        const url = block.props.url;
        const label = block.props.title || url || text || (block.type === "video" ? "视频" : "网页");
        out.push(paragraph("", w.runs([{ text: label, marks: url ? { link: url } : {} }])));
        break;
      }
      case "columns":
        break;
      default:
        out.push(paragraph(alignXml(block.props), w.runs(spans)));
    }
    if (isList) inList = true;
  }
  return out.join("");
}

const STYLES_XML = (() => {
  const heading = (n: number, size: number) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${n <= 2 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  const mono = `<w:rFonts w:ascii="${MONO_FONT}" w:hAnsi="${MONO_FONT}" w:cs="${MONO_FONT}"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${NS_W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Microsoft YaHei" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>
${heading(1, 40)}${heading(2, 32)}${heading(3, 28)}${heading(4, 26)}${heading(5, 24)}${heading(6, 22)}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BBBFC4"/></w:pBdr><w:ind w:left="240"/></w:pPr><w:rPr><w:color w:val="646A73"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="JiangeTodo"><w:name w:val="Jiange Todo"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="JiangeCode"><w:name w:val="Jiange Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F6F7"/><w:spacing w:after="120" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr>${mono}<w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="JiangeMath"><w:name w:val="Jiange Math"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr>${mono}</w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="JiangeDiagram"><w:name w:val="Jiange Diagram"/><w:basedOn w:val="JiangeCode"/></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="JiangeCallout"><w:name w:val="Jiange Callout"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="120" w:right="120"/></w:pPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="JiangeDivider"><w:name w:val="Jiange Divider"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="8F959E"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:color w:val="245BDB"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="character" w:customStyle="1" w:styleId="JiangeInlineCode"><w:name w:val="Jiange Inline Code"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr>${mono}<w:shd w:val="clear" w:color="auto" w:fill="EFF0F1"/></w:rPr></w:style>
<w:style w:type="character" w:customStyle="1" w:styleId="JiangeCalloutIcon"><w:name w:val="Jiange Callout Icon"/><w:basedOn w:val="DefaultParagraphFont"/></w:style>
<w:style w:type="table" w:customStyle="1" w:styleId="JiangeTable"><w:name w:val="Jiange Table"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="DEE0E3"/><w:left w:val="single" w:sz="4" w:space="0" w:color="DEE0E3"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="DEE0E3"/><w:right w:val="single" w:sz="4" w:space="0" w:color="DEE0E3"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="DEE0E3"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="DEE0E3"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;
})();

function numberingXml(orderedNums: number[]): string {
  const bulletChars = ["•", "◦", "▪"];
  const orderedFormats = ["decimal", "lowerLetter", "lowerRoman"];
  const level = (l: number, format: string, text: string, font = "") => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${escapeXml(text)}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${LIST_INDENT * (l + 1)}" w:hanging="${LIST_INDENT}"/></w:pPr>${font}</w:lvl>`;
  const bullets = Array.from({ length: 9 }, (_, l) => level(l, "bullet", bulletChars[l % 3])).join("");
  const ordered = Array.from({ length: 9 }, (_, l) => level(l, orderedFormats[l % 3], `%${l + 1}.`)).join("");
  const restart = Array.from({ length: 9 }, (_, l) => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="1"/></w:lvlOverride>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${NS_W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bullets}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${ordered}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>${orderedNums.map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/>${restart}</w:num>`).join("")}</w:numbering>`;
}

/** Build a .docx package from a document view (title block included as the Word title). */
export function buildDocx(view: { blocks: DocxExportBlock[] }, options: DocxExportOptions = {}): Uint8Array {
  const w = new DocxWriter(options);
  const blocks = view.blocks.some((b) => b.type === "title") || !options.title
    ? view.blocks
    : [{ type: "title", props: {}, spans: [{ text: options.title, marks: {} }] }, ...view.blocks];
  const body = bodyXml(blocks, w);
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:wp="${NS_WP}" xmlns:a="${NS_A}" xmlns:pic="${NS_PIC}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const encoder = new TextEncoder();
  const title = options.title ?? blocks.find((b) => b.type === "title")?.spans.map((s) => s.text).join("") ?? "";
  const now = (options.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  const mediaTypes = [...new Set(w.media.map((m) => m.ext))].map((ext) => `<Default Extension="${ext}" ContentType="image/${ext}"/>`).join("");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${mediaTypes}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_DOC}" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL_BASE}/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${w.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${escapeXml(r.target)}"${r.external ? ` TargetMode="External"` : ""}/>`).join("")}</Relationships>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>Jiange</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Jiange</Application></Properties>`;
  const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${NS_W}"><w:defaultTabStop w:val="420"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  return createZip([
    { name: "[Content_Types].xml", data: encoder.encode(contentTypes) },
    { name: "_rels/.rels", data: encoder.encode(rootRels) },
    { name: "docProps/core.xml", data: encoder.encode(core) },
    { name: "docProps/app.xml", data: encoder.encode(app) },
    { name: "word/document.xml", data: encoder.encode(document) },
    { name: "word/styles.xml", data: encoder.encode(STYLES_XML) },
    { name: "word/numbering.xml", data: encoder.encode(numberingXml(w.nums)) },
    { name: "word/settings.xml", data: encoder.encode(settings) },
    { name: "word/_rels/document.xml.rels", data: encoder.encode(docRels) },
    ...w.media.map((m) => ({ name: `word/media/${m.name}`, data: m.data })),
  ], options.now);
}

// ---------------------------------------------------------------- import

export class DocxImportError extends Error {}

export interface DocxImportResult {
  blocks: MdBlock[];
  /** Text of the first Title-styled paragraph, if any (not included in blocks). */
  title?: string;
  warnings: string[];
}

interface StyleInfo {
  id: string;
  name: string;
  basedOn?: string;
  pPr?: XmlElement;
  rPr?: XmlElement;
}

interface NumberingInfo {
  /** numId → ilvl → numFmt */
  formats: Map<string, Map<number, string>>;
}

const HIGHLIGHT: Record<string, string> = {
  yellow: "#FFF67A", green: "#B7EDB1", cyan: "#BACEFD", magenta: "#F8DEF8", blue: "#4E83FD", red: "#F76964",
  darkBlue: "#245BDB", darkCyan: "#4E83FD", darkGreen: "#62D256", darkMagenta: "#935AF6", darkRed: "#D83931",
  darkYellow: "#FFA53D", darkGray: "#BBBFC4", lightGray: "#DEE0E3", black: "#1F2329",
};

const MONO = /^(consolas|courier|courier new|menlo|monaco|source code pro|fira code|jetbrains mono|sf mono|lucida console|monospace)$/i;

function on(element: XmlElement | undefined): boolean {
  if (!element) return false;
  const value = element.attrs["w:val"];
  return value === undefined || !/^(0|false|off|none)$/i.test(value);
}

function relTarget(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

function parseRels(xml: XmlElement | undefined): Map<string, { type: string; target: string; external: boolean }> {
  const map = new Map<string, { type: string; target: string; external: boolean }>();
  for (const rel of children(xml, "Relationship")) {
    if (rel.attrs.Id) map.set(rel.attrs.Id, { type: rel.attrs.Type ?? "", target: rel.attrs.Target ?? "", external: rel.attrs.TargetMode === "External" });
  }
  return map;
}

function parseStyles(xml: XmlElement | undefined): Map<string, StyleInfo> {
  const map = new Map<string, StyleInfo>();
  for (const style of children(xml, "w:style")) {
    const id = style.attrs["w:styleId"];
    if (!id) continue;
    map.set(id, {
      id,
      name: (child(style, "w:name")?.attrs["w:val"] ?? "").toLowerCase(),
      basedOn: child(style, "w:basedOn")?.attrs["w:val"],
      pPr: child(style, "w:pPr"),
      rPr: child(style, "w:rPr"),
    });
  }
  return map;
}

function styleChain(styles: Map<string, StyleInfo>, id: string | undefined): StyleInfo[] {
  const chain: StyleInfo[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id) && chain.length < 16) {
    seen.add(id);
    const style = styles.get(id);
    if (!style) break;
    chain.push(style);
    id = style.basedOn;
  }
  return chain;
}

function parseNumbering(xml: XmlElement | undefined): NumberingInfo {
  const abstract = new Map<string, Map<number, string>>();
  for (const a of children(xml, "w:abstractNum")) {
    const levels = new Map<number, string>();
    for (const lvl of children(a, "w:lvl")) levels.set(Number(lvl.attrs["w:ilvl"] ?? 0), child(lvl, "w:numFmt")?.attrs["w:val"] ?? "decimal");
    abstract.set(a.attrs["w:abstractNumId"] ?? "", levels);
  }
  const formats = new Map<string, Map<number, string>>();
  for (const num of children(xml, "w:num")) {
    const levels = new Map(abstract.get(child(num, "w:abstractNumId")?.attrs["w:val"] ?? "") ?? []);
    for (const override of children(num, "w:lvlOverride")) {
      const fmt = child(child(override, "w:lvl"), "w:numFmt")?.attrs["w:val"];
      if (fmt) levels.set(Number(override.attrs["w:ilvl"] ?? 0), fmt);
    }
    formats.set(num.attrs["w:numId"] ?? "", levels);
  }
  return { formats };
}

type ParaKind = "paragraph" | "title" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "quote" | "code" | "jcode" | "math" | "diagram" | "callout" | "divider" | "todo" | "bullet" | "ordered";

function styleKind(style: StyleInfo): ParaKind | undefined {
  const byId: Record<string, ParaKind> = { JiangeCode: "jcode", JiangeMath: "math", JiangeDiagram: "diagram", JiangeCallout: "callout", JiangeDivider: "divider", JiangeTodo: "todo" };
  if (byId[style.id]) return byId[style.id];
  const heading = style.name.match(/^heading ([1-9])$/) ?? style.id.match(/^Heading([1-9])$/);
  if (heading) return `h${Math.min(6, Number(heading[1]))}` as ParaKind;
  if (style.name === "title" || style.id === "Title") return "title";
  if (style.name === "quote" || style.name === "intense quote") return "quote";
  if (style.name === "html preformatted" || /\bcode\b/.test(style.name)) return "code";
  if (/^list bullet/.test(style.name)) return "bullet";
  if (/^list number/.test(style.name)) return "ordered";
  return undefined;
}

class DocxReader {
  warnings = new Set<string>();
  title?: string;
  private field: { instr: string; phase: "instr" | "result"; link?: string }[] = [];
  constructor(
    private styles: Map<string, StyleInfo>,
    private numbering: NumberingInfo,
    private rels: Map<string, { type: string; target: string; external: boolean }>,
  ) {}

  paragraphKind(pPr: XmlElement | undefined): { kind: ParaKind; numbered?: { numId: string; ilvl: number } } {
    const chain = styleChain(this.styles, child(pPr, "w:pStyle")?.attrs["w:val"]);
    let kind: ParaKind | undefined;
    for (const style of chain) { kind = styleKind(style); if (kind) break; }
    const direct = child(pPr, "w:outlineLvl")?.attrs["w:val"];
    const outline = direct ?? chain.map((s) => child(s.pPr, "w:outlineLvl")?.attrs["w:val"]).find((v) => v !== undefined);
    if (!kind && outline !== undefined && Number(outline) >= 0 && Number(outline) <= 5) kind = `h${Number(outline) + 1}` as ParaKind;
    const numPr = child(pPr, "w:numPr") ?? chain.map((s) => child(s.pPr, "w:numPr")).find(Boolean);
    const numId = child(numPr, "w:numId")?.attrs["w:val"];
    const ilvl = Number(child(numPr, "w:ilvl")?.attrs["w:val"] ?? 0) || 0;
    return { kind: kind ?? "paragraph", numbered: numId && numId !== "0" ? { numId, ilvl } : undefined };
  }

  runMarks(rPr: XmlElement | undefined): { marks: Record<string, string>; hidden: boolean; icon: boolean } {
    const marks: Record<string, string> = {};
    const styleId = child(rPr, "w:rStyle")?.attrs["w:val"];
    const chain = styleChain(this.styles, styleId);
    const icon = styleId === "JiangeCalloutIcon";
    if (styleId === "JiangeInlineCode" || chain.some((s) => /\bcode\b/.test(s.name) || s.name === "html code")) marks.code = "true";
    const props = [...chain.map((s) => s.rPr).reverse(), rPr];
    let hidden = false;
    for (const p of props) {
      if (!p) continue;
      for (const [tag, key] of [["w:b", "bold"], ["w:i", "italic"], ["w:strike", "strike"], ["w:dstrike", "strike"]] as const) {
        const el = child(p, tag);
        if (el) { if (on(el)) marks[key] = "true"; else delete marks[key]; }
      }
      const u = child(p, "w:u");
      if (u) { if (on(u)) marks.underline = "true"; else delete marks.underline; }
      const vanish = child(p, "w:vanish");
      if (vanish) hidden = on(vanish);
      const fonts = child(p, "w:rFonts");
      if (fonts && MONO.test(fonts.attrs["w:ascii"] ?? fonts.attrs["w:hAnsi"] ?? "")) marks.code = "true";
      const color = child(p, "w:color")?.attrs["w:val"];
      if (color) { const hex = hexColor(color); if (hex && hex !== "000000") marks.color = `#${hex}`; else delete marks.color; }
      const shd = child(p, "w:shd")?.attrs["w:fill"];
      if (shd) { const hex = hexColor(shd); if (hex && hex !== "FFFFFF") marks.bg = `#${hex}`; else delete marks.bg; }
      const highlight = child(p, "w:highlight")?.attrs["w:val"];
      if (highlight) { if (HIGHLIGHT[highlight]) marks.bg = HIGHLIGHT[highlight]; else if (highlight === "none") delete marks.bg; }
    }
    // Styles of hyperlinks/inline code are presentation, not user formatting.
    if (styleId === "Hyperlink" || styleId === "JiangeInlineCode") { delete marks.color; delete marks.underline; delete marks.bg; }
    return { marks, hidden, icon };
  }

  private linkFor(rid: string | undefined): string | undefined {
    const rel = rid ? this.rels.get(rid) : undefined;
    return rel?.external ? safeDocxLink(rel.target) : undefined;
  }

  private fieldLink(): string | undefined {
    for (let i = this.field.length - 1; i >= 0; i--) if (this.field[i].phase === "result" && this.field[i].link) return this.field[i].link;
    return undefined;
  }

  /** Collect spans of a paragraph-like container. */
  inline(node: XmlElement, out: { spans: MdSpan[]; icon: string; image: boolean }, link?: string): void {
    for (const c of node.children) {
      if (typeof c === "string") continue;
      switch (c.name) {
        case "w:r": this.runInto(c, out, link); break;
        case "w:hyperlink": this.inline(c, out, this.linkFor(c.attrs["r:id"]) ?? link); break;
        case "w:fldSimple": {
          const m = (c.attrs["w:instr"] ?? "").match(/^\s*HYPERLINK\s+"([^"]+)"/i);
          this.inline(c, out, (m && safeDocxLink(m[1])) || link);
          break;
        }
        case "w:sdt": this.inline(child(c, "w:sdtContent") ?? c, out, link); break;
        case "w:ins": case "w:moveTo": case "w:smartTag": case "w:customXml": case "w:sdtContent": case "w:dir": case "w:bdo":
          this.inline(c, out, link); break;
        case "w:del": case "w:moveFrom": this.warnings.add("修订中被删除的内容未导入，插入的修订按已接受处理"); break;
        case "mc:AlternateContent": out.image = true; break;
        default: break;
      }
    }
  }

  private runInto(r: XmlElement, out: { spans: MdSpan[]; icon: string; image: boolean }, link?: string): void {
    const { marks, hidden, icon } = this.runMarks(child(r, "w:rPr"));
    const push = (text: string) => {
      if (!text || hidden) return;
      if (this.field.some((f) => f.phase === "instr")) return;
      if (icon) { out.icon += text; return; }
      const href = link ?? this.fieldLink();
      const m = href ? { ...marks, link: href } : { ...marks };
      const prev = out.spans.at(-1);
      if (prev && JSON.stringify(prev.marks) === JSON.stringify(m)) prev.text += text;
      else out.spans.push({ text, marks: m });
    };
    for (const c of r.children) {
      if (typeof c === "string") continue;
      switch (c.name) {
        case "w:t": push(c.children.filter((x): x is string => typeof x === "string").join("")); break;
        case "w:tab": case "w:ptab": push("\t"); break;
        case "w:br": if (!c.attrs["w:type"] || c.attrs["w:type"] === "textWrapping") push("\n"); break;
        case "w:cr": push("\n"); break;
        case "w:noBreakHyphen": push("-"); break;
        case "w:sym": {
          const code = Number.parseInt(c.attrs["w:char"] ?? "", 16);
          if (Number.isFinite(code) && code >= 0x20 && !(code >= 0xf000 && code <= 0xf0ff)) push(String.fromCodePoint(code));
          break;
        }
        case "w:fldChar": {
          const type = c.attrs["w:fldCharType"];
          if (type === "begin") this.field.push({ instr: "", phase: "instr" });
          else if (type === "separate" && this.field.length) {
            const f = this.field[this.field.length - 1];
            f.phase = "result";
            const m = f.instr.match(/^\s*HYPERLINK\s+"([^"]+)"/i);
            if (m && !/\\l\b/.test(f.instr.slice(0, m.index))) f.link = safeDocxLink(m[1]);
          } else if (type === "end") this.field.pop();
          break;
        }
        case "w:instrText": {
          const f = this.field.at(-1);
          if (f && f.phase === "instr") f.instr += c.children.filter((x): x is string => typeof x === "string").join("");
          break;
        }
        case "w:drawing": case "w:pict": case "w:object": case "mc:AlternateContent": out.image = true; break;
        case "w:footnoteReference": case "w:endnoteReference": this.warnings.add("脚注和尾注未导入"); break;
        case "w:commentReference": this.warnings.add("Word 批注未导入"); break;
        default: break;
      }
    }
  }

  paragraph(p: XmlElement, blocks: MdBlock[], state: { lastCode: boolean }): void {
    const pPr = child(p, "w:pPr");
    let { kind, numbered } = this.paragraphKind(pPr);
    const out = { spans: [] as MdSpan[], icon: "", image: false };
    this.inline(p, out);
    if (out.image) this.warnings.add(hasTextBox(p) ? "文本框中的内容未导入" : "文档中的图片暂不支持导入，已跳过");
    let spans = out.spans;
    const text = spans.map((s) => s.text).join("");
    const props: Record<string, string> = {};
    const jc = child(pPr, "w:jc")?.attrs["w:val"];
    if (jc === "center") props.align = "center";
    else if (jc === "right" || jc === "end") props.align = "right";
    const wasCode = state.lastCode;
    state.lastCode = false;

    if (kind === "divider") { blocks.push({ type: "divider", text: "", props: {}, spans: [] }); return; }
    if (!text.trim()) {
      if (kind === "paragraph" && !numbered && child(child(pPr, "w:pBdr"), "w:bottom") && !out.image) blocks.push({ type: "divider", text: "", props: {}, spans: [] });
      return;
    }
    if (kind === "title") {
      if (this.title === undefined) { this.title = text.trim(); return; }
      kind = "h1";
    }
    if (kind === "code" || kind === "jcode" || kind === "math" || kind === "diagram") {
      const plain = text;
      // Generic Word code styles write one paragraph per line; merge them.
      if (kind === "code" && wasCode && blocks.at(-1)?.type === "code") {
        const prev = blocks.at(-1)!;
        prev.text += "\n" + plain;
      } else blocks.push({ type: kind === "jcode" ? "code" : kind, text: plain, props: {}, spans: [] });
      state.lastCode = kind === "code";
      return;
    }
    // A leading checkbox glyph marks a to-do item (our export writes "☐ " / "☑ ").
    const box = text.match(/^\s*([☐☑☒])\s?/u);
    if (kind === "todo" || box) {
      if (box) spans = dropPrefix(spans, box[0].length);
      const left = Number(child(pPr, "w:ind")?.attrs["w:left"] ?? child(pPr, "w:ind")?.attrs["w:start"] ?? NaN);
      const level = numbered ? numbered.ilvl : Number.isFinite(left) ? Math.round(left / LIST_INDENT) - 1 : 0;
      props.indent = String(Math.max(0, Math.min(4, level)));
      props.checked = box && box[1] !== "☐" ? "true" : "";
      blocks.push(textBlock("todo", spans, props));
      return;
    }
    if (kind === "callout") {
      const fill = hexColor(child(pPr, "w:shd")?.attrs["w:fill"]);
      const index = CALLOUT_COLORS.findIndex(([bg]) => bg.slice(1).toUpperCase() === fill);
      if (index > 0) props.color = String(index);
      const emoji = out.icon.trim();
      if (emoji) props.emoji = emoji;
      blocks.push(textBlock("callout", spans, props));
      return;
    }
    if (numbered && !/^h[1-6]$/.test(kind)) {
      const format = this.numbering.formats.get(numbered.numId)?.get(numbered.ilvl);
      const type = kind === "bullet" || kind === "ordered" ? (format ? (format === "bullet" ? "bullet" : "ordered") : kind) : format === undefined || format === "bullet" ? "bullet" : "ordered";
      props.indent = String(Math.max(0, Math.min(4, numbered.ilvl)));
      blocks.push(textBlock(type, spans, props));
      return;
    }
    if (kind === "bullet" || kind === "ordered") props.indent = "0";
    blocks.push(textBlock(kind, spans, props));
  }

  cellText(tc: XmlElement, header = false): { text: string; styled: boolean } {
    const lines: string[] = [];
    let styled = false;
    const walk = (node: XmlElement) => {
      for (const c of children(node)) {
        if (c.name === "w:p") {
          const out = { spans: [] as MdSpan[], icon: "", image: false };
          this.inline(c, out);
          if (out.image) this.warnings.add("文档中的图片暂不支持导入，已跳过");
          // Bold header rows are presentation (our own export writes them).
          if (out.spans.some((s) => Object.keys(s.marks).some((k) => !(header && k === "bold")))) styled = true;
          lines.push(out.icon + out.spans.map((s) => s.text).join(""));
        } else if (c.name === "w:tbl") { this.warnings.add("嵌套表格已展开为单元格文字"); walk(c); }
        else if (c.name === "w:tr" || c.name === "w:tc" || c.name === "w:sdt" || c.name === "w:sdtContent" || c.name === "w:customXml") walk(c);
      }
    };
    walk(tc);
    while (lines.length > 1 && lines.at(-1) === "") lines.pop();
    return { text: lines.join("\n"), styled };
  }

  table(tbl: XmlElement, blocks: MdBlock[]): void {
    const rows: string[][] = [];
    let styled = false, merged = false;
    const rowEls: XmlElement[] = [];
    const collect = (node: XmlElement) => {
      for (const c of children(node)) {
        if (c.name === "w:tr") rowEls.push(c);
        else if (c.name === "w:sdt" || c.name === "w:sdtContent" || c.name === "w:customXml") collect(c);
      }
    };
    collect(tbl);
    for (const [rowIndex, tr] of rowEls.entries()) {
      const row: string[] = [];
      const cells: XmlElement[] = [];
      const gather = (node: XmlElement) => {
        for (const c of children(node)) {
          if (c.name === "w:tc") cells.push(c);
          else if (c.name === "w:sdt" || c.name === "w:sdtContent" || c.name === "w:customXml") gather(c);
        }
      };
      gather(tr);
      const before = Number(child(child(tr, "w:trPr"), "w:gridBefore")?.attrs["w:val"] ?? 0) || 0;
      for (let k = 0; k < Math.min(before, 64); k++) row.push("");
      for (const tc of cells) {
        const tcPr = child(tc, "w:tcPr");
        const span = Math.max(1, Math.min(64, Number(child(tcPr, "w:gridSpan")?.attrs["w:val"] ?? 1) || 1));
        const vMerge = child(tcPr, "w:vMerge");
        const continued = vMerge && vMerge.attrs["w:val"] !== "restart";
        if (span > 1 || vMerge) merged = true;
        const cell = continued ? { text: "", styled: false } : this.cellText(tc, rowIndex === 0);
        styled ||= cell.styled;
        row.push(cell.text);
        for (let k = 1; k < span; k++) row.push("");
      }
      rows.push(row);
    }
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (!rows.length || !width) return;
    for (const row of rows) while (row.length < width) row.push("");
    if (styled) this.warnings.add("表格单元格中的文字样式不会导入");
    if (merged) this.warnings.add("合并单元格已拆分为普通单元格");
    blocks.push({ type: "table", text: "", props: { tableData: JSON.stringify(rows) }, spans: [] });
  }

  body(node: XmlElement, blocks: MdBlock[], state: { lastCode: boolean }): void {
    for (const c of children(node)) {
      if (c.name === "w:p") this.paragraph(c, blocks, state);
      else if (c.name === "w:tbl") { state.lastCode = false; this.table(c, blocks); }
      else if (c.name === "w:sdt") this.body(child(c, "w:sdtContent") ?? c, blocks, state);
      else if (c.name === "w:customXml" || c.name === "w:ins" || c.name === "w:moveTo") this.body(c, blocks, state);
      else if (c.name === "mc:AlternateContent") this.warnings.add("部分特殊内容未导入");
    }
  }
}

function hasTextBox(node: XmlElement): boolean {
  if (node.name === "w:txbxContent") return true;
  return children(node).some(hasTextBox);
}

function dropPrefix(spans: MdSpan[], length: number): MdSpan[] {
  const out: MdSpan[] = [];
  let skip = length;
  for (const span of spans) {
    if (skip >= span.text.length) { skip -= span.text.length; continue; }
    out.push({ text: span.text.slice(skip), marks: span.marks });
    skip = 0;
  }
  return out;
}

function textBlock(type: string, spans: MdSpan[], props: Record<string, string>): MdBlock {
  return { type, text: spans.map((s) => s.text).join(""), props, spans };
}

const NOT_DOCX = "文件不是有效的 Word（.docx）文档。";

/** Parse .docx bytes into import seeds. Throws DocxImportError with a user-facing Chinese message. */
export async function parseDocx(bytes: Uint8Array): Promise<DocxImportResult> {
  if (bytes.length > DOCX_MAX_BYTES) throw new DocxImportError("Word 文件不能超过 10 MB。");
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new DocxImportError("暂不支持旧版 .doc 或已加密的 Word 文件，请在 Word 中另存为 .docx 后重试。");
  }
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new DocxImportError(NOT_DOCX);
  let entries: ZipEntry[];
  try { entries = listZip(bytes); } catch { throw new DocxImportError(NOT_DOCX); }
  const byName = new Map(entries.map((e) => [e.name.replace(/^\/+/, ""), e]));
  const read = async (name: string): Promise<XmlElement | undefined> => {
    const entry = byName.get(name);
    if (!entry) return undefined;
    try {
      const data = await readZipEntry(bytes, entry, PART_LIMIT);
      return parseXml(new TextDecoder("utf-8", { fatal: true }).decode(data));
    } catch (error) {
      if (error instanceof ZipError && /encrypted/.test(error.message)) throw new DocxImportError("Word 文件已加密，无法导入。");
      if (error instanceof ZipError || error instanceof XmlError || error instanceof TypeError) throw new DocxImportError("Word 文档已损坏，无法解析。");
      throw error;
    }
  };
  let main = "word/document.xml";
  const rootRels = parseRels(await read("_rels/.rels"));
  for (const rel of rootRels.values()) if (rel.type === REL_DOC || rel.type.endsWith("/officeDocument")) main = relTarget("", rel.target);
  const document = await read(main);
  if (!document || document.name !== "w:document") throw new DocxImportError(NOT_DOCX);
  const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
  const docRels = parseRels(await read(`${dir}_rels/${main.slice(dir.length)}.rels`));
  let stylesPath = `${dir}styles.xml`, numberingPath = `${dir}numbering.xml`;
  for (const rel of docRels.values()) {
    if (rel.type.endsWith("/styles")) stylesPath = relTarget(main, rel.target);
    else if (rel.type.endsWith("/numbering")) numberingPath = relTarget(main, rel.target);
  }
  const reader = new DocxReader(parseStyles(await read(stylesPath)), parseNumbering(await read(numberingPath)), docRels);
  const body = child(document, "w:body");
  const blocks: MdBlock[] = [];
  if (body) reader.body(body, blocks, { lastCode: false });
  if ([...byName.keys()].some((name) => /^word\/(header|footer)\d*\.xml$/.test(name))) reader.warnings.add("页眉和页脚未导入");
  if (!blocks.length) throw new DocxImportError("文件没有可导入的内容。");
  return { blocks, title: reader.title, warnings: [...reader.warnings] };
}

/** Read a picked File (size-checked before loading it into memory). */
export async function readDocxFile(file: Blob): Promise<DocxImportResult> {
  if (file.size > DOCX_MAX_BYTES) throw new DocxImportError("Word 文件不能超过 10 MB。");
  let buffer: ArrayBuffer;
  try { buffer = await file.arrayBuffer(); } catch { throw new DocxImportError("读取文件失败，请重试。"); }
  return parseDocx(new Uint8Array(buffer));
}

export function docxImportErrorMessage(error: unknown): string {
  return error instanceof DocxImportError ? error.message : "Word 文档解析失败，未导入任何内容。";
}

export function isDocxFile(file: { name: string; type?: string }): boolean {
  return /\.docx$/i.test(file.name) || file.type === DOCX_MIME;
}
