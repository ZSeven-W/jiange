/**
 * Headless OOXML PresentationML (.pptx) exporter and importer for Jiange Slides.
 *
 * Pure ES2022 over `@zseven-w/ooxml` (zero DOM dependencies). Exports valid
 * 16:9 widescreen `.pptx` archives preserving slide order, solid backgrounds,
 * hidden flag (`show="0"`), layouts (`title`, `blank`, `blank-title`, default),
 * title/body placeholders, geometric/line/text shapes (0..100% <-> EMU,
 * rotation, colors, font size, bold, alignment), and speaker notes.
 */

import { createZip, createZipAsync, listZip, readZipEntry, ZipError, type ZipEntry, type ZipEntryInput } from "@zseven-w/ooxml/zip";
import { child, children, escapeXml, parseXml, textContent, XmlError, type XmlElement } from "@zseven-w/ooxml/xml";
import type { SlideLayout, SlideMediaAsset, SlideShape, SlideTableData, SlideTextParagraph, SlideTheme, SlidesPage } from "./model.js";

const SLIDE_CX = 12192000; // 13.333 in (16:9 widescreen) in EMUs
const SLIDE_CY = 6858000;  // 7.5 in in EMUs
const NOTES_CX = 6858000;
const NOTES_CY = 9144000;

const MAX_IMPORT_PAGES = 100;
const MAX_IMPORT_SHAPES_PER_SLIDE = 100;
const MAX_XML_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_XML_NODES = 50000;

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";

const REL_OFFICE_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const REL_SLIDE_MASTER = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";
const REL_SLIDE_LAYOUT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";
const REL_THEME = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme";
const REL_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const REL_NOTES_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
const REL_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const REL_CORE_PROPS = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";

export type PptxSlideInput = Pick<
  SlidesPage,
  "title" | "body" | "background" | "layout" | "notes" | "shapes" | "hidden"
>;

export interface ImportedSlidePage {
  title: string;
  body: string;
  background: string;
  layout: SlideLayout;
  notes: string;
  hidden: boolean;
  shapes: SlideShape[];
}

export interface PptxImportResult {
  pages: ImportedSlidePage[];
  shapeCount: number;
  warnings: string[];
  media?: Record<string, SlideMediaAsset>;
}

export interface ExportPptxOptions {
  title?: string;
  modified?: Date;
  media?: Record<string, SlideMediaAsset>;
  theme?: Partial<SlideTheme>;
}

export class PptxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PptxError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

function normalizeHex6(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
  if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
    return (trimmed[0] + trimmed[0] + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2]).toUpperCase();
  }
  return null;
}

function isDarkHex(hex6: string): boolean {
  const r = Number.parseInt(hex6.slice(0, 2), 16);
  const g = Number.parseInt(hex6.slice(2, 4), 16);
  const b = Number.parseInt(hex6.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 135;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function truncateRunes(text: string, maxRunes: number): string {
  const arr = Array.from(text);
  return arr.length <= maxRunes ? text : arr.slice(0, maxRunes).join("");
}

function truncateBytes(text: string, maxBytes: number): string {
  if (encoder.encode(text).length <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

function shapeKindToPrst(kind: SlideShape["kind"]): string | null {
  switch (kind) {
    case "rectangle": return "rect";
    case "rounded-rectangle": return "roundRect";
    case "ellipse": return "ellipse";
    case "triangle": return "triangle";
    case "right-triangle": return "rtTriangle";
    case "diamond": return "diamond";
    case "pentagon": return "pentagon";
    case "hexagon": return "hexagon";
    case "star": return "star5";
    case "parallelogram": return "parallelogram";
    case "trapezoid": return "trapezoid";
    case "arrow-right": return "rightArrow";
    default: return null;
  }
}

function prstToShapeKind(prst: string | undefined): SlideShape["kind"] {
  switch (prst) {
    case "roundRect":
    case "snip1Rect":
    case "snip2SameRect":
    case "round1Rect":
    case "round2SameRect":
      return "rounded-rectangle";
    case "ellipse":
    case "oval":
      return "ellipse";
    case "triangle":
      return "triangle";
    case "rtTriangle":
      return "right-triangle";
    case "diamond":
      return "diamond";
    case "pentagon":
    case "homePlate":
      return "pentagon";
    case "hexagon":
      return "hexagon";
    case "star4":
    case "star5":
    case "star6":
    case "star7":
    case "star8":
      return "star";
    case "parallelogram":
      return "parallelogram";
    case "trapezoid":
      return "trapezoid";
    case "rightArrow":
    case "chevron":
    case "notchedRightArrow":
      return "arrow-right";
    default:
      return "rectangle";
  }
}

function isLineKind(kind: SlideShape["kind"]): boolean {
  return (
    kind === "line" ||
    kind === "line-arrow" ||
    kind === "line-arrow-filled" ||
    kind === "line-dot" ||
    kind === "line-double-arrow"
  );
}

function alignToOoxml(align: SlideShape["align"]): string {
  if (align === "center") return "ctr";
  if (align === "right") return "r";
  return "l";
}

function ooxmlToAlign(algn: string | undefined): "left" | "center" | "right" {
  if (algn === "ctr") return "center";
  if (algn === "r") return "right";
  return "left";
}

function buildParagraphsXml(
  text: string,
  opts: { fontSizePt: number; bold?: boolean; colorHex: string; align: "l" | "ctr" | "r" },
): string {
  const lines = text.split(/\r?\n/);
  const sz = Math.round(clamp(opts.fontSizePt, 8, 120) * 100);
  const bAttr = opts.bold ? ` b="1"` : "";
  const algnAttr = ` algn="${opts.align}"`;
  return lines
    .map((line) => {
      const content = line
        ? `<a:r><a:rPr lang="zh-CN" sz="${sz}"${bAttr} dirty="0"><a:solidFill><a:srgbClr val="${opts.colorHex}"/></a:solidFill></a:rPr><a:t>${escapeXml(line)}</a:t></a:r>`
        : `<a:endParaRPr lang="zh-CN" sz="${sz}"${bAttr}/>`;
      return `<a:p><a:pPr${algnAttr}/>${content}</a:p>`;
    })
    .join("");
}

function pctToEmuX(pct: number): number {
  return Math.round((clamp(pct, 0, 100) / 100) * SLIDE_CX);
}

function pctToEmuY(pct: number): number {
  return Math.round((clamp(pct, 0, 100) / 100) * SLIDE_CY);
}

function buildPlaceholderShapeXml(
  id: number,
  name: string,
  phType: "ctrTitle" | "title" | "subTitle" | "body",
  rectPct: { x: number; y: number; w: number; h: number },
  text: string,
  style: { fontSizePt: number; bold?: boolean; colorHex: string; align: "l" | "ctr" | "r" },
): string {
  const x = pctToEmuX(rectPct.x);
  const y = pctToEmuY(rectPct.y);
  const cx = pctToEmuX(rectPct.w);
  const cy = pctToEmuY(rectPct.h);
  const phAttr = phType === "body" ? ` type="body" idx="1"` : phType === "subTitle" ? ` type="subTitle" idx="1"` : ` type="${phType}"`;
  return (
    `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${phAttr}/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${buildParagraphsXml(text, style)}</p:txBody>` +
    `</p:sp>`
  );
}

function buildRichParagraphsXml(
  paragraphs: readonly SlideTextParagraph[],
  defaults: { fontSizePt: number; bold?: boolean; colorHex: string; align: "l" | "ctr" | "r" },
): string {
  return paragraphs
    .map((p) => {
      const algn = p.align ? alignToOoxml(p.align) : defaults.align;
      const lvlAttr = p.level && p.level > 0 ? ` lvl="${clamp(Math.floor(p.level), 0, 8)}"` : "";
      const buXml = p.bullet ? `<a:buChar char="•"/>` : "";
      const runsXml = p.runs
        .map((r) => {
          const sz = Math.round(clamp(r.fontSize ?? defaults.fontSizePt, 8, 120) * 100);
          const bAttr = (r.bold ?? defaults.bold) ? ` b="1"` : "";
          const iAttr = r.italic ? ` i="1"` : "";
          const uAttr = r.underline ? ` u="sng"` : "";
          const colorHex = normalizeHex6(r.color) ?? defaults.colorHex;
          return `<a:r><a:rPr lang="zh-CN" sz="${sz}"${bAttr}${iAttr}${uAttr} dirty="0"><a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill></a:rPr><a:t>${escapeXml(r.text)}</a:t></a:r>`;
        })
        .join("");
      const body = runsXml || `<a:endParaRPr lang="zh-CN" sz="${Math.round(clamp(defaults.fontSizePt, 8, 120) * 100)}"/>`;
      return `<a:p><a:pPr algn="${algn}"${lvlAttr}>${buXml}</a:pPr>${body}</a:p>`;
    })
    .join("");
}

function buildTableGraphicFrameXml(
  id: number,
  shape: SlideShape,
  table: SlideTableData,
  rect: { x: number; y: number; cx: number; cy: number },
): string {
  const rows = table.rows.length > 0 ? table.rows : [[""]];
  const colCount = Math.max(1, ...rows.map((r) => r.length));
  const colWidth = Math.max(1, Math.round(rect.cx / colCount));
  const rowHeight = Math.max(1, Math.round(rect.cy / rows.length));
  const headerFill = normalizeHex6(table.headerFill) ?? "3370FF";
  const gridCols = Array.from({ length: colCount }, () => `<a:gridCol w="${colWidth}"/>`).join("");
  const trs = rows
    .map((row, rIdx) => {
      const isHeader = Boolean(table.headerRow && rIdx === 0);
      const tcs = Array.from({ length: colCount }, (_, cIdx) => {
        const cellText = row[cIdx] ?? "";
        const fillXml = isHeader
          ? `<a:solidFill><a:srgbClr val="${headerFill}"/></a:solidFill>`
          : rIdx % 2 === 1
            ? `<a:solidFill><a:srgbClr val="F5F7FB"/></a:solidFill>`
            : `<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>`;
        const txtColor = isHeader ? "FFFFFF" : "1F2329";
        return (
          `<a:tc>` +
          `<a:txBody><a:bodyPr/><a:lstStyle/>${buildParagraphsXml(cellText, { fontSizePt: 14, bold: isHeader, colorHex: txtColor, align: "l" })}</a:txBody>` +
          `<a:tcPr>${fillXml}</a:tcPr>` +
          `</a:tc>`
        );
      }).join("");
      return `<a:tr h="${rowHeight}">${tcs}</a:tr>`;
    })
    .join("");

  return (
    `<p:graphicFrame>` +
    `<p:nvGraphicFramePr><p:cNvPr id="${id}" name="${escapeXml(shape.id)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${rect.x}" y="${rect.y}"/><a:ext cx="${rect.cx}" cy="${rect.cy}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl><a:tblPr firstRow="${table.headerRow ? "1" : "0"}" bandRow="1"/><a:tblGrid>${gridCols}</a:tblGrid>${trs}</a:tbl>` +
    `</a:graphicData></a:graphic>` +
    `</p:graphicFrame>`
  );
}

interface SlideMediaCollector {
  media?: Record<string, SlideMediaAsset>;
  addImage(asset: SlideMediaAsset): string;
}

function buildSlideShapeXml(id: number, shape: SlideShape, mediaCollector?: SlideMediaCollector): string {
  const wPct = clamp(shape.width ?? 16, 5, 100);
  const hPct = clamp(shape.height ?? 20, 5, 100);
  const xPct = clamp(shape.x, 0, 100 - wPct);
  const yPct = clamp(shape.y, 0, 100 - hPct);
  const x = pctToEmuX(xPct);
  const y = pctToEmuY(yPct);
  const cx = pctToEmuX(wPct);
  const cy = pctToEmuY(hPct);
  const rotDeg = ((Math.round(shape.rotation ?? 0) % 360) + 360) % 360;
  const rotAttr = rotDeg !== 0 ? ` rot="${rotDeg * 60000}"` : "";
  const colorHex = normalizeHex6(shape.color) ?? "3370FF";

  if (shape.kind === "image") {
    const asset = shape.mediaId ? mediaCollector?.media?.[shape.mediaId] : undefined;
    if (!asset || !mediaCollector) return "";
    const rId = mediaCollector.addImage(asset);
    let srcRectXml = "";
    const crop = shape.crop;
    if (
      crop &&
      Number.isFinite(crop.x) &&
      Number.isFinite(crop.y) &&
      Number.isFinite(crop.w) &&
      Number.isFinite(crop.h) &&
      crop.x >= 0 &&
      crop.y >= 0 &&
      crop.w > 0 &&
      crop.h > 0 &&
      crop.x + crop.w <= 1.001 &&
      crop.y + crop.h <= 1.001 &&
      (crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1)
    ) {
      const l = Math.round(clamp(crop.x, 0, 1) * 100000);
      const t = Math.round(clamp(crop.y, 0, 1) * 100000);
      const r = Math.round(clamp(1 - crop.x - crop.w, 0, 1) * 100000);
      const b = Math.round(clamp(1 - crop.y - crop.h, 0, 1) * 100000);
      srcRectXml = `<a:srcRect l="${l}" t="${t}" r="${r}" b="${b}"/>`;
    }
    return (
      `<p:pic>` +
      `<p:nvPicPr><p:cNvPr id="${id}" name="${escapeXml(shape.id)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="${rId}"/>${srcRectXml}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr><a:xfrm${rotAttr}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
      `</p:pic>`
    );
  }

  if (shape.kind === "video" || shape.kind === "audio") {
    const isVideo = shape.kind === "video";
    const fillHex = isVideo ? "1F2329" : "F0F5FF";
    const textHex = isVideo ? "FFFFFF" : "1F2329";
    const label = isVideo
      ? (shape.mediaUrl ? `[Video] ${shape.mediaUrl}` : "[Video]")
      : (shape.mediaUrl ? `[Audio] ${shape.mediaUrl}` : "[Audio]");
    return (
      `<p:sp>` +
      `<p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(shape.id)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr>` +
      `<a:xfrm${rotAttr}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>` +
      `<a:solidFill><a:srgbClr val="${fillHex}"/></a:solidFill>` +
      `<a:ln w="12700"><a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill></a:ln>` +
      `</p:spPr>` +
      `<p:txBody><a:bodyPr wrap="square" anchor="ctr"/><a:lstStyle/>${buildParagraphsXml(truncateRunes(label, 200), { fontSizePt: 14, bold: true, colorHex: textHex, align: "ctr" })}</p:txBody>` +
      `</p:sp>`
    );
  }

  if (shape.kind === "table" && shape.table) {
    return buildTableGraphicFrameXml(id, shape, shape.table, { x, y, cx, cy });
  }

  if (shape.kind === "chart" && shape.chart) {
    const chartRows: string[][] = [
      [shape.chart.title || "Category", ...shape.chart.series.map((s) => s.name)],
      ...shape.chart.categories.map((cat, idx) => [
        cat,
        ...shape.chart!.series.map((s) => String(s.values[idx] ?? 0)),
      ]),
    ];
    return buildTableGraphicFrameXml(id, shape, { rows: chartRows, headerRow: true, headerFill: colorHex }, { x, y, cx, cy });
  }

  if (isLineKind(shape.kind)) {
    const headEnd = shape.kind === "line-double-arrow" ? `<a:headEnd type="arrow" w="med" len="med"/>` : "";
    const tailEnd =
      shape.kind === "line-arrow" || shape.kind === "line-double-arrow"
        ? `<a:tailEnd type="arrow" w="med" len="med"/>`
        : shape.kind === "line-arrow-filled"
          ? `<a:tailEnd type="triangle" w="med" len="med"/>`
          : shape.kind === "line-dot"
            ? `<a:tailEnd type="oval" w="med" len="med"/>`
            : "";
    return (
      `<p:cxnSp>` +
      `<p:nvCxnSpPr><p:cNvPr id="${id}" name="${escapeXml(shape.id)}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
      `<p:spPr>` +
      `<a:xfrm${rotAttr}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="line"><a:avLst/></a:prstGeom>` +
      `<a:ln w="28575"><a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill>${headEnd}${tailEnd}</a:ln>` +
      `</p:spPr>` +
      `</p:cxnSp>`
    );
  }

  if (shape.kind === "text") {
    const align = alignToOoxml(shape.align) as "l" | "ctr" | "r";
    const fontSizePt = clamp(shape.fontSize ?? 24, 12, 96);
    const bodyXml = shape.paragraphs && shape.paragraphs.length > 0
      ? buildRichParagraphsXml(shape.paragraphs, { fontSizePt, bold: Boolean(shape.bold), colorHex, align })
      : buildParagraphsXml(shape.text ?? "", { fontSizePt, bold: Boolean(shape.bold), colorHex, align });
    return (
      `<p:sp>` +
      `<p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(shape.id)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm${rotAttr}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
      `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${bodyXml}</p:txBody>` +
      `</p:sp>`
    );
  }

  const prst = shapeKindToPrst(shape.kind) ?? "rect";
  return (
    `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(shape.id)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>` +
    `<a:xfrm${rotAttr}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${colorHex}"/></a:solidFill>` +
    `<a:ln><a:noFill/></a:ln>` +
    `</p:spPr>` +
    `<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:endParaRPr lang="zh-CN"/></a:p></p:txBody>` +
    `</p:sp>`
  );
}

function buildSlideXml(page: PptxSlideInput, mediaCollector?: SlideMediaCollector): string {
  const bgHex = normalizeHex6(page.background);
  const dark = bgHex ? isDarkHex(bgHex) : false;
  const titleColor = dark ? "FFFFFF" : "1F2329";
  const bodyColor = dark ? "E5E7EB" : "374151";
  const showAttr = page.hidden ? ` show="0"` : "";
  const bgXml = bgHex
    ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bgHex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
    : "";

  const layout: SlideLayout = page.layout ?? "";
  let nextId = 2;
  const nodes: string[] = [];

  if (layout === "title") {
    nodes.push(
      buildPlaceholderShapeXml(nextId++, "Title", "ctrTitle", { x: 8, y: 28, w: 84, h: 20 }, page.title, {
        fontSizePt: 40,
        bold: true,
        colorHex: titleColor,
        align: "ctr",
      }),
    );
    if (page.body) {
      nodes.push(
        buildPlaceholderShapeXml(nextId++, "Subtitle", "subTitle", { x: 12, y: 52, w: 76, h: 24 }, page.body, {
          fontSizePt: 20,
          colorHex: bodyColor,
          align: "ctr",
        }),
      );
    }
  } else if (layout === "blank-title") {
    nodes.push(
      buildPlaceholderShapeXml(nextId++, "Title", "title", { x: 6, y: 7, w: 88, h: 14 }, page.title, {
        fontSizePt: 30,
        bold: true,
        colorHex: titleColor,
        align: "l",
      }),
    );
    if (page.body) {
      nodes.push(
        buildPlaceholderShapeXml(nextId++, "Body", "body", { x: 6, y: 24, w: 88, h: 66 }, page.body, {
          fontSizePt: 18,
          colorHex: bodyColor,
          align: "l",
        }),
      );
    }
  } else if (layout === "blank") {
    if (page.title) {
      nodes.push(
        buildPlaceholderShapeXml(nextId++, "Title", "title", { x: 6, y: 7, w: 88, h: 14 }, page.title, {
          fontSizePt: 30,
          bold: true,
          colorHex: titleColor,
          align: "l",
        }),
      );
    }
    if (page.body) {
      nodes.push(
        buildPlaceholderShapeXml(nextId++, "Body", "body", { x: 6, y: 24, w: 88, h: 66 }, page.body, {
          fontSizePt: 18,
          colorHex: bodyColor,
          align: "l",
        }),
      );
    }
  } else {
    nodes.push(
      buildPlaceholderShapeXml(nextId++, "Title", "title", { x: 6, y: 7, w: 88, h: 14 }, page.title, {
        fontSizePt: 30,
        bold: true,
        colorHex: titleColor,
        align: "l",
      }),
    );
    nodes.push(
      buildPlaceholderShapeXml(nextId++, "Body", "body", { x: 6, y: 24, w: 88, h: 66 }, page.body, {
        fontSizePt: 18,
        colorHex: bodyColor,
        align: "l",
      }),
    );
  }

  for (const shape of page.shapes ?? []) {
    const xml = buildSlideShapeXml(nextId++, shape, mediaCollector);
    if (xml) nodes.push(xml);
  }

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"${showAttr}>` +
    `<p:cSld>${bgXml}<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    nodes.join("") +
    `</p:spTree></p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:sld>`
  );
}

function buildNotesSlideXml(notes: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    `<p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="685800" y="4343400"/><a:ext cx="5486400" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${buildParagraphsXml(notes, { fontSizePt: 12, colorHex: "1F2329", align: "l" })}</p:txBody>` +
    `</p:sp>` +
    `</p:spTree></p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:notes>`
  );
}

function buildThemeXml(theme?: Partial<SlideTheme>): string {
  const dk1 = normalizeHex6(theme?.textDark) ?? "1F2329";
  const lt1 = normalizeHex6(theme?.background) ?? "FFFFFF";
  const accent1 = normalizeHex6(theme?.primary) ?? "3370FF";
  const accent2 = normalizeHex6(theme?.secondary) ?? "00B42A";
  const accent3 = normalizeHex6(theme?.accent) ?? "FF7D00";
  const themeName = escapeXml(theme?.name ?? "Jiange Theme");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<a:theme xmlns:a="${NS_A}" name="${themeName}">` +
    `<a:themeElements>` +
    `<a:clrScheme name="Jiange">` +
    `<a:dk1><a:srgbClr val="${dk1}"/></a:dk1><a:lt1><a:srgbClr val="${lt1}"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="374151"/></a:dk2><a:lt2><a:srgbClr val="F5F7FB"/></a:lt2>` +
    `<a:accent1><a:srgbClr val="${accent1}"/></a:accent1><a:accent2><a:srgbClr val="${accent2}"/></a:accent2>` +
    `<a:accent3><a:srgbClr val="${accent3}"/></a:accent3><a:accent4><a:srgbClr val="F53F3F"/></a:accent4>` +
    `<a:accent5><a:srgbClr val="722ED1"/></a:accent5><a:accent6><a:srgbClr val="14C9C9"/></a:accent6>` +
    `<a:hlink><a:srgbClr val="${accent1}"/></a:hlink><a:folHlink><a:srgbClr val="722ED1"/></a:folHlink>` +
    `</a:clrScheme>` +
    `<a:fontScheme name="Jiange"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface="PingFang SC"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="PingFang SC"/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="Jiange"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>` +
    `</a:themeElements>` +
    `</a:theme>`
  );
}

function mediaExtForMime(mime: SlideMediaAsset["mimeType"]): { ext: string; contentType: string } {
  switch (mime) {
    case "image/jpeg":
      return { ext: "jpeg", contentType: "image/jpeg" };
    case "image/svg+xml":
      return { ext: "svg", contentType: "image/svg+xml" };
    case "image/webp":
      return { ext: "webp", contentType: "image/webp" };
    default:
      return { ext: "png", contentType: "image/png" };
  }
}

function mimeForMediaExt(path: string): SlideMediaAsset["mimeType"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function buildPptxEntries(pages: readonly PptxSlideInput[], options: ExportPptxOptions): { entries: ZipEntryInput[]; modified: Date } {
  const safePages: PptxSlideInput[] =
    pages.length > 0
      ? [...pages]
      : [{ title: "", body: "", background: "", layout: "", notes: "", shapes: [], hidden: false }];
  const title = (options.title ?? "Presentation").trim() || "Presentation";
  const modified = options.modified ?? new Date();
  const isoNow = modified.toISOString();

  const entries: ZipEntryInput[] = [];
  const ctDefaults = new Map<string, string>([
    ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
    ["xml", "application/xml"],
  ]);
  const ctOverrides: string[] = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
  ];

  const presRels: string[] = [
    `<Relationship Id="rId1" Type="${REL_SLIDE_MASTER}" Target="slideMasters/slideMaster1.xml"/>`,
  ];
  const sldIdLst: string[] = [];
  let mediaSeq = 0;
  const writtenMedia = new Map<string, string>();

  for (let i = 0; i < safePages.length; i++) {
    const idx = i + 1;
    const page = safePages[i];
    const rId = `rId${idx + 1}`;
    const sldId = 256 + i;
    presRels.push(`<Relationship Id="${rId}" Type="${REL_SLIDE}" Target="slides/slide${idx}.xml"/>`);
    sldIdLst.push(`<p:sldId id="${sldId}" r:id="${rId}"/>`);
    ctOverrides.push(
      `<Override PartName="/ppt/slides/slide${idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    );

    const slideRels: string[] = [
      `<Relationship Id="rId1" Type="${REL_SLIDE_LAYOUT}" Target="../slideLayouts/slideLayout1.xml"/>`,
    ];
    let nextSlideRelId = 2;

    if (page.notes && page.notes.trim() !== "") {
      const notesRelId = `rId${nextSlideRelId++}`;
      slideRels.push(
        `<Relationship Id="${notesRelId}" Type="${REL_NOTES_SLIDE}" Target="../notesSlides/notesSlide${idx}.xml"/>`,
      );
      ctOverrides.push(
        `<Override PartName="/ppt/notesSlides/notesSlide${idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
      );
      entries.push({
        name: `ppt/notesSlides/notesSlide${idx}.xml`,
        data: utf8(buildNotesSlideXml(page.notes)),
      });
      entries.push({
        name: `ppt/notesSlides/_rels/notesSlide${idx}.xml.rels`,
        data: utf8(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<Relationships xmlns="${NS_RELS}">` +
            `<Relationship Id="rId1" Type="${REL_SLIDE}" Target="../slides/slide${idx}.xml"/>` +
            `</Relationships>`,
        ),
      });
    }

    const mediaCollector: SlideMediaCollector = {
      media: options.media,
      addImage(asset: SlideMediaAsset): string {
        let targetRel = writtenMedia.get(asset.id);
        if (!targetRel) {
          mediaSeq++;
          const { ext, contentType } = mediaExtForMime(asset.mimeType);
          ctDefaults.set(ext, contentType);
          const fileName = `image${mediaSeq}.${ext}`;
          entries.push({ name: `ppt/media/${fileName}`, data: asset.data });
          targetRel = `../media/${fileName}`;
          writtenMedia.set(asset.id, targetRel);
        }
        const relId = `rId${nextSlideRelId++}`;
        slideRels.push(`<Relationship Id="${relId}" Type="${REL_IMAGE}" Target="${targetRel}"/>`);
        return relId;
      },
    };

    entries.push({ name: `ppt/slides/slide${idx}.xml`, data: utf8(buildSlideXml(page, mediaCollector)) });
    entries.push({
      name: `ppt/slides/_rels/slide${idx}.xml.rels`,
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="${NS_RELS}">${slideRels.join("")}</Relationships>`,
      ),
    });
  }

  const defaultTags = [...ctDefaults.entries()]
    .map(([ext, ct]) => `<Default Extension="${ext}" ContentType="${ct}"/>`)
    .join("");

  entries.unshift(
    {
      name: "[Content_Types].xml",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="${NS_CT}">` +
          defaultTags +
          ctOverrides.join("") +
          `</Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="${NS_RELS}">` +
          `<Relationship Id="rId1" Type="${REL_OFFICE_DOC}" Target="ppt/presentation.xml"/>` +
          `<Relationship Id="rId2" Type="${REL_CORE_PROPS}" Target="docProps/core.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: "docProps/core.xml",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
          `<dc:title>${escapeXml(title)}</dc:title>` +
          `<dcterms:created xsi:type="dcterms:W3CDTF">${isoNow}</dcterms:created>` +
          `<dcterms:modified xsi:type="dcterms:W3CDTF">${isoNow}</dcterms:modified>` +
          `</cp:coreProperties>`,
      ),
    },
    {
      name: "ppt/presentation.xml",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
          `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
          `<p:sldIdLst>${sldIdLst.join("")}</p:sldIdLst>` +
          `<p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}" type="screen16x9"/>` +
          `<p:notesSz cx="${NOTES_CX}" cy="${NOTES_CY}"/>` +
          `</p:presentation>`,
      ),
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="${NS_RELS}">${presRels.join("")}</Relationships>`,
      ),
    },
    {
      name: "ppt/slideMasters/slideMaster1.xml",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
          `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
          `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
          `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
          `</p:sldMaster>`,
      ),
    },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="${NS_RELS}">` +
          `<Relationship Id="rId1" Type="${REL_SLIDE_LAYOUT}" Target="../slideLayouts/slideLayout1.xml"/>` +
          `<Relationship Id="rId2" Type="${REL_THEME}" Target="../theme/theme1.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: "ppt/slideLayouts/slideLayout1.xml",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1">` +
          `<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
          `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
          `</p:sldLayout>`,
      ),
    },
    {
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      data: utf8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="${NS_RELS}">` +
          `<Relationship Id="rId1" Type="${REL_SLIDE_MASTER}" Target="../slideMasters/slideMaster1.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: "ppt/theme/theme1.xml",
      data: utf8(buildThemeXml(options.theme)),
    },
  );

  return { entries, modified };
}

/** Export Jiange Slides pages into a standard 16:9 OOXML `.pptx` byte array (STORE ZIP). */
export function exportSlidesToPptx(pages: readonly PptxSlideInput[], options: ExportPptxOptions = {}): Uint8Array {
  const { entries, modified } = buildPptxEntries(pages, options);
  return createZip(entries, modified);
}

/** Export Jiange Slides pages into a DEFLATE-compressed 16:9 OOXML `.pptx` byte array. */
export async function exportSlidesToPptxAsync(
  pages: readonly PptxSlideInput[],
  options: ExportPptxOptions = {},
): Promise<Uint8Array> {
  const { entries, modified } = buildPptxEntries(pages, options);
  return createZipAsync(entries, { modified });
}

// ---------------------------------------------------------------------------
// Importer (.pptx -> ImportedSlidePage[])
// ---------------------------------------------------------------------------

function resolveRelTarget(basePath: string, target: string): string {
  const cleanTarget = target.replace(/\\/g, "/");
  if (cleanTarget.startsWith("/")) return cleanTarget.slice(1);
  const baseParts = basePath.split("/").slice(0, -1);
  for (const segment of cleanTarget.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") baseParts.pop();
    else baseParts.push(segment);
  }
  return baseParts.join("/");
}

function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  if (slash < 0) return `_rels/${partPath}.rels`;
  return `${partPath.slice(0, slash)}/_rels/${partPath.slice(slash + 1)}.rels`;
}

function extractTxBodyText(txBody: XmlElement | undefined): {
  text: string;
  fontSize?: number;
  bold?: boolean;
  align?: "left" | "center" | "right";
  color?: string;
} {
  if (!txBody) return { text: "" };
  const paragraphs = children(txBody, "a:p");
  const lines: string[] = [];
  let fontSize: number | undefined;
  let bold: boolean | undefined;
  let align: "left" | "center" | "right" | undefined;
  let color: string | undefined;

  for (const p of paragraphs) {
    const pPr = child(p, "a:pPr");
    if (!align && pPr?.attrs["algn"]) {
      align = ooxmlToAlign(pPr.attrs["algn"]);
    }
    let line = "";
    for (const node of p.children) {
      if (typeof node === "string") continue;
      if (node.name === "a:r" || node.name === "a:fld") {
        const rPr = child(node, "a:rPr");
        if (rPr) {
          if (fontSize === undefined && rPr.attrs["sz"]) {
            const parsed = Number.parseInt(rPr.attrs["sz"], 10);
            if (Number.isFinite(parsed) && parsed > 0) fontSize = clamp(Math.round(parsed / 100), 12, 96);
          }
          if (bold === undefined && rPr.attrs["b"]) {
            bold = rPr.attrs["b"] === "1" || rPr.attrs["b"] === "true";
          }
          if (!color) {
            const solid = child(rPr, "a:solidFill");
            const srgb = child(solid, "a:srgbClr");
            const hex = normalizeHex6(srgb?.attrs["val"]);
            if (hex) color = `#${hex.toLowerCase()}`;
          }
        }
        const t = child(node, "a:t");
        if (t) line += textContent(t);
      } else if (node.name === "a:br") {
        line += "\n";
      }
    }
    lines.push(line);
  }
  return { text: lines.join("\n"), fontSize, bold, align, color };
}

function extractSolidColor(parent: XmlElement | undefined): string | null {
  const solid = child(parent, "a:solidFill");
  const srgb = child(solid, "a:srgbClr");
  const hex = normalizeHex6(srgb?.attrs["val"]);
  return hex ? `#${hex.toLowerCase()}` : null;
}

function parseXfrmRect(
  spPr: XmlElement | undefined,
  slideCx: number,
  slideCy: number,
): { x: number; y: number; width: number; height: number; rotation: number } | null {
  return parseXfrmElement(child(spPr, "a:xfrm"), slideCx, slideCy);
}

function parseConnectorKind(ln: XmlElement | undefined): SlideShape["kind"] {
  const headType = child(ln, "a:headEnd")?.attrs["type"];
  const tailType = child(ln, "a:tailEnd")?.attrs["type"];
  const hasHead = headType && headType !== "none";
  const hasTail = tailType && tailType !== "none";
  if (hasHead && hasTail) return "line-double-arrow";
  if (tailType === "triangle" || tailType === "stealth") return "line-arrow-filled";
  if (tailType === "oval") return "line-dot";
  if (hasTail || hasHead) return "line-arrow";
  return "line";
}

function parseXfrmElement(
  xfrm: XmlElement | undefined,
  slideCx: number,
  slideCy: number,
): { x: number; y: number; width: number; height: number; rotation: number } | null {
  const off = child(xfrm, "a:off");
  const ext = child(xfrm, "a:ext");
  if (!off || !ext) return null;
  const rawX = Number(off.attrs["x"]);
  const rawY = Number(off.attrs["y"]);
  const rawCx = Number(ext.attrs["cx"]);
  const rawCy = Number(ext.attrs["cy"]);
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY) || !Number.isFinite(rawCx) || !Number.isFinite(rawCy)) {
    return null;
  }
  const width = round2(clamp((rawCx / slideCx) * 100, 5, 100));
  const height = round2(clamp((rawCy / slideCy) * 100, 5, 100));
  const x = round2(clamp((rawX / slideCx) * 100, 0, Math.max(0, 100 - width)));
  const y = round2(clamp((rawY / slideCy) * 100, 0, Math.max(0, 100 - height)));
  const rawRot = Number(xfrm?.attrs["rot"] ?? "0");
  const rotation = Number.isFinite(rawRot) ? ((Math.round(rawRot / 60000) % 360) + 360) % 360 : 0;
  return { x, y, width, height, rotation };
}

function parseSlideElement(
  sld: XmlElement,
  slideCx: number,
  slideCy: number,
  slideNum: number,
  notes: string,
  slideImageRels?: Map<string, string>,
): { page: ImportedSlidePage; skippedMedia: number } {
  const hidden = sld.attrs["show"] === "0" || sld.attrs["show"] === "false";
  const cSld = child(sld, "p:cSld");
  const bg = child(cSld, "p:bg");
  const bgPr = child(bg, "p:bgPr");
  const background = extractSolidColor(bgPr) ?? "";

  const spTree = child(cSld, "p:spTree");
  let title = "";
  let body = "";
  let hasCtrTitle = false;
  let hasTitlePh = false;
  let hasBodyPh = false;
  let skippedMedia = 0;
  const shapes: SlideShape[] = [];
  let shapeSeq = 0;

  for (const node of children(spTree)) {
    if (node.name === "p:pic") {
      const blipFill = child(node, "p:blipFill");
      const blip = child(blipFill, "a:blip");
      const srcRect = child(blipFill, "a:srcRect");
      const embedId = blip?.attrs["r:embed"];
      const mediaId = embedId ? slideImageRels?.get(embedId) : undefined;
      const rect = parseXfrmRect(child(node, "p:spPr"), slideCx, slideCy);
      if (mediaId && rect && shapes.length < MAX_IMPORT_SHAPES_PER_SLIDE) {
        let crop: SlideShape["crop"];
        if (srcRect) {
          const l = clamp((Number(srcRect.attrs["l"] ?? "0") || 0) / 100000, 0, 0.99);
          const t = clamp((Number(srcRect.attrs["t"] ?? "0") || 0) / 100000, 0, 0.99);
          const r = clamp((Number(srcRect.attrs["r"] ?? "0") || 0) / 100000, 0, 0.99);
          const b = clamp((Number(srcRect.attrs["b"] ?? "0") || 0) / 100000, 0, 0.99);
          const w = round2(Math.max(0.01, 1 - l - r));
          const h = round2(Math.max(0.01, 1 - t - b));
          if ((l > 0 || t > 0 || r > 0 || b > 0) && l + w <= 1.001 && t + h <= 1.001) {
            crop = { x: round2(l), y: round2(t), w, h };
          }
        }
        shapeSeq++;
        shapes.push({
          id: `imp-${slideNum}-img-${shapeSeq}`,
          kind: "image",
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          rotation: rect.rotation,
          color: "#ffffff",
          mediaId,
          ...(crop ? { crop } : {}),
        });
      } else {
        skippedMedia++;
      }
      continue;
    }
    if (node.name === "p:graphicFrame") {
      const graphic = child(node, "a:graphic");
      const graphicData = child(graphic, "a:graphicData");
      const tbl = child(graphicData, "a:tbl");
      const rect = parseXfrmElement(child(node, "p:xfrm"), slideCx, slideCy);
      if (tbl && rect && shapes.length < MAX_IMPORT_SHAPES_PER_SLIDE) {
        const tblPr = child(tbl, "a:tblPr");
        const headerRow = tblPr?.attrs["firstRow"] === "1" || tblPr?.attrs["firstRow"] === "true";
        const rows: string[][] = [];
        let headerFill: string | undefined;
        for (const tr of children(tbl, "a:tr")) {
          const cells: string[] = [];
          for (const tc of children(tr, "a:tc")) {
            if (rows.length === 0 && !headerFill) {
              headerFill = extractSolidColor(child(tc, "a:tcPr")) ?? undefined;
            }
            cells.push(extractTxBodyText(child(tc, "a:txBody")).text);
          }
          rows.push(cells);
        }
        shapeSeq++;
        shapes.push({
          id: `imp-${slideNum}-tbl-${shapeSeq}`,
          kind: "table",
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          rotation: rect.rotation,
          color: headerFill ?? "#3370ff",
          table: { rows, headerRow, headerFill },
        });
      } else {
        skippedMedia++;
      }
      continue;
    }
    if (node.name === "p:cxnSp") {
      if (shapes.length >= MAX_IMPORT_SHAPES_PER_SLIDE) continue;
      const spPr = child(node, "p:spPr");
      const rect = parseXfrmRect(spPr, slideCx, slideCy);
      if (!rect) continue;
      const ln = child(spPr, "a:ln");
      const color = extractSolidColor(ln) ?? "#3370ff";
      shapeSeq++;
      shapes.push({
        id: `imp-${slideNum}-ln-${shapeSeq}`,
        kind: parseConnectorKind(ln),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        rotation: rect.rotation,
        color,
      });
      continue;
    }
    if (node.name !== "p:sp") continue;

    const nvSpPr = child(node, "p:nvSpPr");
    const cNvSpPr = child(nvSpPr, "p:cNvSpPr");
    const nvPr = child(nvSpPr, "p:nvPr");
    const ph = child(nvPr, "p:ph");
    const phType = ph?.attrs["type"];
    const txBody = child(node, "p:txBody");
    const extracted = extractTxBodyText(txBody);

    if (ph) {
      if (phType === "sldNum" || phType === "dt" || phType === "ftr" || phType === "hdr") {
        continue;
      }
      if (phType === "ctrTitle") {
        hasCtrTitle = true;
        title = title ? `${title} ${extracted.text}` : extracted.text;
        continue;
      }
      if (phType === "title") {
        hasTitlePh = true;
        title = title ? `${title} ${extracted.text}` : extracted.text;
        continue;
      }
      // Body / subtitle / untyped placeholder
      hasBodyPh = true;
      if (extracted.text) {
        body = body ? `${body}\n${extracted.text}` : extracted.text;
      }
      continue;
    }

    // Non-placeholder shape or text box
    if (shapes.length >= MAX_IMPORT_SHAPES_PER_SLIDE) continue;
    const spPr = child(node, "p:spPr");
    const rect = parseXfrmRect(spPr, slideCx, slideCy);
    if (!rect) continue;
    const prst = child(spPr, "a:prstGeom")?.attrs["prst"];
    const fillColor = extractSolidColor(spPr);
    const lineColor = extractSolidColor(child(spPr, "a:ln"));
    const isTxBox = cNvSpPr?.attrs["txBox"] === "1" || cNvSpPr?.attrs["txBox"] === "true";

    if (isTxBox || (!fillColor && extracted.text.trim() !== "")) {
      shapeSeq++;
      shapes.push({
        id: `imp-${slideNum}-txt-${shapeSeq}`,
        kind: "text",
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        rotation: rect.rotation,
        color: extracted.color ?? "#1f2329",
        text: truncateRunes(extracted.text, 1000),
        fontSize: extracted.fontSize ?? 24,
        bold: Boolean(extracted.bold),
        align: extracted.align ?? "left",
      });
    } else {
      shapeSeq++;
      shapes.push({
        id: `imp-${slideNum}-shp-${shapeSeq}`,
        kind: prstToShapeKind(prst),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        rotation: rect.rotation,
        color: fillColor ?? lineColor ?? "#3370ff",
      });
    }
  }

  let layout: SlideLayout = "";
  if (hasCtrTitle) layout = "title";
  else if (hasTitlePh && !hasBodyPh && body === "") layout = "blank-title";
  else if (!hasTitlePh && !hasBodyPh && title === "" && body === "") layout = "blank";

  return {
    page: {
      title: truncateRunes(title.trim(), 200),
      body: truncateBytes(body, 20000),
      background,
      layout,
      notes: truncateBytes(notes.trim(), 20000),
      hidden,
      shapes,
    },
    skippedMedia,
  };
}

/** Parse a standard `.pptx` byte buffer into sanitized Jiange slide pages. */
export async function parsePptxToSlides(bytes: Uint8Array): Promise<PptxImportResult> {
  let entries: ZipEntry[];
  try {
    entries = listZip(bytes);
  } catch (err) {
    throw new PptxError(err instanceof ZipError ? `无效的 PPTX 压缩包：${err.message}` : "无法解析 PPTX 文件");
  }

  const byName = new Map<string, ZipEntry>();
  for (const entry of entries) {
    byName.set(entry.name.replace(/\\/g, "/"), entry);
  }

  const readXml = async (path: string): Promise<XmlElement | undefined> => {
    const entry = byName.get(path);
    if (!entry) return undefined;
    try {
      const raw = await readZipEntry(bytes, entry, MAX_XML_ENTRY_BYTES);
      return parseXml(decoder.decode(raw), { maxNodes: MAX_XML_NODES });
    } catch (err) {
      if (err instanceof ZipError || err instanceof XmlError) {
        throw new PptxError(`解析 ${path} 失败：${err.message}`);
      }
      throw err;
    }
  };

  const presXml = await readXml("ppt/presentation.xml");
  if (!presXml) {
    throw new PptxError("未找到 ppt/presentation.xml，请确认文件为标准 .pptx 演示文稿");
  }

  let slideCx = SLIDE_CX;
  let slideCy = SLIDE_CY;
  const sldSz = child(presXml, "p:sldSz");
  if (sldSz) {
    const cx = Number(sldSz.attrs["cx"]);
    const cy = Number(sldSz.attrs["cy"]);
    if (Number.isFinite(cx) && cx > 0 && Number.isFinite(cy) && cy > 0) {
      slideCx = cx;
      slideCy = cy;
    }
  }

  // Build presentation relationship map rId -> target path
  const presRelMap = new Map<string, string>();
  const presRelsXml = await readXml("ppt/_rels/presentation.xml.rels");
  for (const rel of children(presRelsXml, "Relationship")) {
    const id = rel.attrs["Id"];
    const target = rel.attrs["Target"];
    if (id && target) presRelMap.set(id, resolveRelTarget("ppt/presentation.xml", target));
  }

  let slidePaths: string[] = [];
  const sldIdLst = child(presXml, "p:sldIdLst");
  for (const sldId of children(sldIdLst, "p:sldId")) {
    const rId = sldId.attrs["r:id"];
    const target = rId ? presRelMap.get(rId) : undefined;
    if (target && byName.has(target)) {
      slidePaths.push(target);
    }
  }
  if (slidePaths.length === 0) {
    slidePaths = [...byName.keys()]
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((a, b) => {
        const na = Number.parseInt(a.match(/(\d+)\.xml$/i)![1], 10);
        const nb = Number.parseInt(b.match(/(\d+)\.xml$/i)![1], 10);
        return na - nb;
      });
  }
  if (slidePaths.length === 0) {
    throw new PptxError("PPTX 文件中未包含任何幻灯片页面");
  }

  const warnings: string[] = [];
  if (slidePaths.length > MAX_IMPORT_PAGES) {
    warnings.push(`演示文稿共 ${slidePaths.length} 页，已按上限截取前 ${MAX_IMPORT_PAGES} 页`);
    slidePaths = slidePaths.slice(0, MAX_IMPORT_PAGES);
  }

  const pages: ImportedSlidePage[] = [];
  const media: Record<string, SlideMediaAsset> = {};
  const mediaByPath = new Map<string, string>();
  let mediaCount = 0;
  let totalShapes = 0;
  let totalSkippedMedia = 0;

  for (let i = 0; i < slidePaths.length; i++) {
    const slidePath = slidePaths[i];
    const sldXml = (await readXml(slidePath))!;

    // Resolve optional speaker notes and embedded images via slide relationships
    let notesText = "";
    const slideImageRels = new Map<string, string>();
    const slideRelsXml = await readXml(relsPathFor(slidePath));
    for (const rel of children(slideRelsXml, "Relationship")) {
      const relType = rel.attrs["Type"] ?? "";
      const target = rel.attrs["Target"];
      const rId = rel.attrs["Id"];
      if (!target) continue;

      if (relType.endsWith("/notesSlide")) {
        const notesPath = resolveRelTarget(slidePath, target);
        const notesXml = await readXml(notesPath);
        if (notesXml) {
          const nSpTree = child(child(notesXml, "p:cSld"), "p:spTree");
          const parts: string[] = [];
          for (const sp of children(nSpTree, "p:sp")) {
            const ph = child(child(child(sp, "p:nvSpPr"), "p:nvPr"), "p:ph");
            if (ph?.attrs["type"] === "sldNum" || ph?.attrs["type"] === "sldImg") continue;
            const extracted = extractTxBodyText(child(sp, "p:txBody")).text.trim();
            if (extracted) parts.push(extracted);
          }
          notesText = parts.join("\n");
        }
      } else if (relType.endsWith("/image") && rId) {
        const mediaPath = resolveRelTarget(slidePath, target);
        const mediaEntry = byName.get(mediaPath);
        if (mediaEntry) {
          let mediaId = mediaByPath.get(mediaPath);
          if (!mediaId) {
            try {
              const raw = await readZipEntry(bytes, mediaEntry, 10 * 1024 * 1024);
              mediaCount++;
              mediaId = `media-${mediaCount}`;
              mediaByPath.set(mediaPath, mediaId);
              media[mediaId] = {
                id: mediaId,
                mimeType: mimeForMediaExt(mediaPath),
                data: raw,
                name: mediaPath.split("/").pop(),
              };
            } catch {
              continue;
            }
          }
          slideImageRels.set(rId, mediaId);
        }
      }
    }

    const { page, skippedMedia } = parseSlideElement(sldXml, slideCx, slideCy, i + 1, notesText, slideImageRels);
    totalSkippedMedia += skippedMedia;
    totalShapes += page.shapes.length;
    pages.push(page);
  }

  if (totalSkippedMedia > 0) {
    warnings.push(`已跳过 ${totalSkippedMedia} 个嵌入图片、图表或 SmartArt 元素（当前支持文本、基础图形、连接线与备注导入）`);
  }

  return Object.keys(media).length > 0
    ? { pages, shapeCount: totalShapes, warnings, media }
    : { pages, shapeCount: totalShapes, warnings };
}
