import { escapeXml } from "@zseven-w/ooxml/xml";
import { XlsxError } from "./xlsx.js";
import { xattr, xchildren, type XlsxXmlNode } from "./xlsx-xml.js";

/** Colors are `#RRGGBB`; `numFmt` is an Excel number format code (e.g. `0.00%`). */
export interface XlsxBorder { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean; color?: string }
export interface XlsxStyle {
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean;
  fontName?: string; fontSize?: number; color?: string; fill?: string;
  horizontal?: "left" | "center" | "right"; vertical?: "top" | "center" | "bottom"; wrap?: boolean;
  border?: XlsxBorder; numFmt?: string;
}
/** Zero-based inclusive range. */
export interface XlsxMerge { top: number; left: number; bottom: number; right: number }
export interface XlsxFrozen { rows: number; cols: number }
export interface XlsxDxfStyle { bg?: string; color?: string; bold?: boolean }

const STYLE_KEYS = ["bold", "italic", "underline", "strike", "fontName", "fontSize", "color", "fill", "horizontal", "vertical", "wrap", "border", "numFmt"] as const;
const BORDER_KEYS = ["top", "right", "bottom", "left", "color"] as const;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const BUILTIN_FORMATS: Record<number, string> = {
  1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
};
const BUILTIN_IDS = new Map(Object.entries(BUILTIN_FORMATS).map(([id, code]) => [code, Number(id)]));

function boolField(value: unknown, context: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new XlsxError(`${context} must be a boolean`);
  return value || undefined;
}
function colorField(value: unknown, context: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !COLOR.test(value)) throw new XlsxError(`${context} must be #RRGGBB`);
  return value.toUpperCase();
}
function plainText(value: unknown, limit: number, context: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > limit || /[\u0000-\u001f\ud800-\udfff\ufffe\uffff]/.test(value)) throw new XlsxError(`invalid ${context}`);
  return value;
}

/** Validate a style and drop empty fields; returns undefined for a default style. */
export function normalizeXlsxStyle(raw: unknown): XlsxStyle | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new XlsxError("cell style must be an object");
  if (Object.keys(raw).some((key) => !(STYLE_KEYS as readonly string[]).includes(key))) throw new XlsxError("cell style contains unsupported properties");
  const s = raw as Record<string, unknown>, out: XlsxStyle = {};
  const set = <K extends keyof XlsxStyle>(key: K, value: XlsxStyle[K] | undefined) => { if (value !== undefined) out[key] = value; };
  set("bold", boolField(s.bold, "bold")); set("italic", boolField(s.italic, "italic"));
  set("underline", boolField(s.underline, "underline")); set("strike", boolField(s.strike, "strike"));
  set("fontName", plainText(s.fontName, 31, "font name"));
  if (s.fontSize !== undefined) {
    if (typeof s.fontSize !== "number" || !Number.isFinite(s.fontSize) || s.fontSize < 1 || s.fontSize > 409) throw new XlsxError("font size must be 1 to 409");
    out.fontSize = s.fontSize;
  }
  set("color", colorField(s.color, "font color")); set("fill", colorField(s.fill, "fill color"));
  if (s.horizontal !== undefined && s.horizontal !== "") {
    if (s.horizontal !== "left" && s.horizontal !== "center" && s.horizontal !== "right") throw new XlsxError("invalid horizontal alignment");
    out.horizontal = s.horizontal;
  }
  if (s.vertical !== undefined && s.vertical !== "") {
    if (s.vertical !== "top" && s.vertical !== "center" && s.vertical !== "bottom") throw new XlsxError("invalid vertical alignment");
    out.vertical = s.vertical;
  }
  set("wrap", boolField(s.wrap, "wrap"));
  if (s.border !== undefined) {
    const b = s.border;
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((key) => !(BORDER_KEYS as readonly string[]).includes(key))) throw new XlsxError("invalid border");
    const r = b as Record<string, unknown>, border: XlsxBorder = {};
    for (const side of ["top", "right", "bottom", "left"] as const) { const v = boolField(r[side], `border ${side}`); if (v) border[side] = true; }
    const color = colorField(r.color, "border color");
    if (border.top || border.right || border.bottom || border.left) { if (color) border.color = color; out.border = border; }
  }
  const fmt = plainText(s.numFmt, 255, "number format");
  if (fmt && fmt.toLowerCase() !== "general") out.numFmt = fmt;
  return Object.keys(out).length ? out : undefined;
}

const argb = (hex: string) => `FF${hex.slice(1).toUpperCase()}`;
const attr = (value: string) => escapeXml(value);

/** Deduplicates styles into `cellXfs`; index 0 is the default style. */
export class XlsxStyleTable {
  private readonly xfs = new Map<string, number>([["", 0]]);
  private readonly fonts = new Map<string, number>([["", 0]]);
  private readonly fills = new Map<string, number>([["", 0], ["gray125", 1]]);
  private readonly borders = new Map<string, number>([["", 0]]);
  private readonly formats = new Map<string, number>();
  private readonly dxfs = new Map<string, number>();
  private readonly fontXml = ['<font><sz val="11"/><name val="Calibri"/></font>'];
  private readonly fillXml = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  private readonly borderXml = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
  private readonly xfXml = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  private readonly dxfXml: string[] = [];
  get used(): boolean { return this.xfXml.length > 1 || this.dxfXml.length > 0; }

  index(style: XlsxStyle | undefined): number {
    if (!style) return 0;
    const key = JSON.stringify(style);
    const existing = this.xfs.get(key); if (existing !== undefined) return existing;
    const fontKey = JSON.stringify([style.bold, style.italic, style.underline, style.strike, style.fontName, style.fontSize, style.color]);
    let fontId = 0;
    if (style.bold || style.italic || style.underline || style.strike || style.fontName || style.fontSize || style.color) {
      fontId = this.fonts.get(fontKey) ?? this.fontXml.length;
      if (!this.fonts.has(fontKey)) {
        this.fonts.set(fontKey, fontId);
        this.fontXml.push(`<font>${style.bold ? "<b/>" : ""}${style.italic ? "<i/>" : ""}${style.strike ? "<strike/>" : ""}${style.underline ? "<u/>" : ""}<sz val="${style.fontSize ?? 11}"/>${style.color ? `<color rgb="${argb(style.color)}"/>` : ""}<name val="${attr(style.fontName ?? "Calibri")}"/></font>`);
      }
    }
    let fillId = 0;
    if (style.fill) {
      fillId = this.fills.get(style.fill) ?? this.fillXml.length;
      if (!this.fills.has(style.fill)) { this.fills.set(style.fill, fillId); this.fillXml.push(`<fill><patternFill patternType="solid"><fgColor rgb="${argb(style.fill)}"/><bgColor indexed="64"/></patternFill></fill>`); }
    }
    let borderId = 0;
    if (style.border) {
      const b = style.border, borderKey = JSON.stringify(b), color = b.color ? `<color rgb="${argb(b.color)}"/>` : '<color auto="1"/>';
      borderId = this.borders.get(borderKey) ?? this.borderXml.length;
      if (!this.borders.has(borderKey)) {
        this.borders.set(borderKey, borderId);
        const side = (name: string, on?: boolean) => on ? `<${name} style="thin">${color}</${name}>` : `<${name}/>`;
        this.borderXml.push(`<border>${side("left", b.left)}${side("right", b.right)}${side("top", b.top)}${side("bottom", b.bottom)}<diagonal/></border>`);
      }
    }
    let numFmtId = 0;
    if (style.numFmt) {
      numFmtId = BUILTIN_IDS.get(style.numFmt) ?? this.formats.get(style.numFmt) ?? 164 + this.formats.size;
      if (!BUILTIN_IDS.has(style.numFmt) && !this.formats.has(style.numFmt)) this.formats.set(style.numFmt, numFmtId);
    }
    const align = style.horizontal || style.vertical || style.wrap
      ? `<alignment${style.horizontal ? ` horizontal="${style.horizontal}"` : ""}${style.vertical ? ` vertical="${style.vertical}"` : ""}${style.wrap ? ' wrapText="1"' : ""}/>` : "";
    const applied = `${numFmtId ? ' applyNumberFormat="1"' : ""}${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${borderId ? ' applyBorder="1"' : ""}${align ? ' applyAlignment="1"' : ""}`;
    const id = this.xfXml.length;
    const open = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${applied}`;
    this.xfXml.push(align ? `${open}>${align}</xf>` : `${open}/>`);
    this.xfs.set(key, id);
    return id;
  }

  dxfIndex(style: XlsxDxfStyle): number | undefined {
    const bg = colorField(style.bg, "conditional format fill color");
    const color = colorField(style.color, "conditional format font color");
    const bold = boolField(style.bold, "conditional format bold");
    if (!bg && !color && !bold) return undefined;
    const key = JSON.stringify([bg, color, bold]);
    const existing = this.dxfs.get(key);
    if (existing !== undefined) return existing;
    const id = this.dxfXml.length;
    const font = bold || color ? `<font>${bold ? "<b/>" : ""}${color ? `<color rgb="${argb(color)}"/>` : ""}</font>` : "";
    const fill = bg ? `<fill><patternFill patternType="solid"><fgColor rgb="${argb(bg)}"/><bgColor rgb="${argb(bg)}"/></patternFill></fill>` : "";
    this.dxfXml.push(`<dxf>${font}${fill}</dxf>`);
    this.dxfs.set(key, id);
    return id;
  }

  xml(ns: string): string {
    const numFmts = this.formats.size ? `<numFmts count="${this.formats.size}">${[...this.formats].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${attr(code)}"/>`).join("")}</numFmts>` : "";
    const dxfs = this.dxfXml.length ? `<dxfs count="${this.dxfXml.length}">${this.dxfXml.join("")}</dxfs>` : "";
    return `<styleSheet xmlns="${ns}">${numFmts}<fonts count="${this.fontXml.length}">${this.fontXml.join("")}</fonts><fills count="${this.fillXml.length}">${this.fillXml.join("")}</fills><borders count="${this.borderXml.length}">${this.borderXml.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${this.xfXml.length}">${this.xfXml.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>${dxfs}</styleSheet>`;
  }
}

type ColorFlag = { themed: boolean };
function rgbOf(node: XlsxXmlNode | undefined, flag: ColorFlag): string | undefined {
  if (!node) return undefined;
  const rgb = xattr(node, "rgb");
  if (rgb && /^[0-9a-fA-F]{8}$/.test(rgb)) return `#${rgb.slice(2).toUpperCase()}`;
  if (rgb && /^[0-9a-fA-F]{6}$/.test(rgb)) return `#${rgb.toUpperCase()}`;
  if (xattr(node, "auto") === "1" || xattr(node, "indexed") === "64") return undefined;
  if (xattr(node, "theme") !== undefined || xattr(node, "indexed") !== undefined) flag.themed = true;
  return undefined;
}
const on = (node: XlsxXmlNode | undefined) => !!node && !["0", "false"].includes(xattr(node, "val") ?? "1");
const index = (value: string | undefined, length: number) => {
  if (value === undefined) return 0;
  if (!/^\d{1,6}$/.test(value) || Number(value) >= length) throw new XlsxError("invalid style reference");
  return Number(value);
};

/** Parse `cellXfs` into per-index styles. Unsupported aspects add warnings. */
export function readXlsxStyles(root: XlsxXmlNode, warn: Set<string>): (XlsxStyle | undefined)[] {
  if (root.name !== "styleSheet") throw new XlsxError("invalid styles part");
  const list = (name: string, item: string) => { const parent = xchildren(root, name)[0]; return parent ? xchildren(parent, item) : []; };
  const formats = new Map<number, string>(Object.entries(BUILTIN_FORMATS).map(([id, code]) => [Number(id), code]));
  for (const fmt of list("numFmts", "numFmt")) {
    const id = xattr(fmt, "numFmtId"), code = xattr(fmt, "formatCode");
    if (!id || !/^\d{1,6}$/.test(id) || code === undefined || code.length > 255) throw new XlsxError("invalid number format");
    formats.set(Number(id), code);
  }
  const fonts = list("fonts", "font").map((font) => {
    const flag: ColorFlag = { themed: false };
    const pick = (name: string) => xchildren(font, name)[0];
    const sz = xattr(pick("sz") ?? font, "val"), name = pick("name") ? xattr(pick("name")!, "val") : undefined;
    return { bold: on(pick("b")), italic: on(pick("i")), strike: on(pick("strike")), underline: !!pick("u") && xattr(pick("u")!, "val") !== "none",
      fontSize: sz && Number.isFinite(Number(sz)) ? Number(sz) : undefined, fontName: name, color: rgbOf(pick("color"), flag), themed: flag.themed };
  });
  const fills = list("fills", "fill").map((fill): { color?: string; lossy: boolean } => {
    const pattern = xchildren(fill, "patternFill")[0];
    if (!pattern) return { lossy: true };
    const type = xattr(pattern, "patternType") ?? "none";
    if (type === "none" || type === "gray125") return { lossy: false };
    const flag: ColorFlag = { themed: false }, color = rgbOf(xchildren(pattern, "fgColor")[0], flag);
    return { color, lossy: type !== "solid" || flag.themed };
  });
  const borders = list("borders", "border").map((border): { border?: XlsxBorder; lossy: boolean } => {
    const out: XlsxBorder = {}, flag: ColorFlag = { themed: false };
    let lossy = false;
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const node = xchildren(border, side)[0], kind = node ? xattr(node, "style") : undefined;
      if (node && kind && kind !== "none") {
        out[side] = true;
        if (kind !== "thin") lossy = true;
        out.color ??= rgbOf(xchildren(node, "color")[0], flag);
      }
    }
    if (!out.color) delete out.color;
    return { border: out.top || out.right || out.bottom || out.left ? out : undefined, lossy: lossy || flag.themed };
  });
  const base = fonts[0];
  return list("cellXfs", "xf").map((xf) => {
    const raw: Record<string, unknown> = {};
    const font = fonts[index(xattr(xf, "fontId"), Math.max(fonts.length, 1))];
    if (font) {
      if (font.themed && font !== base) warn.add("style_colors_not_preserved");
      if (font.bold) raw.bold = true; if (font.italic) raw.italic = true; if (font.underline) raw.underline = true; if (font.strike) raw.strike = true;
      if (font.color) raw.color = font.color;
      if (font.fontName && font.fontName !== base?.fontName && font.fontName.length <= 31) raw.fontName = font.fontName;
      if (font.fontSize && font.fontSize !== base?.fontSize && font.fontSize >= 1 && font.fontSize <= 409) raw.fontSize = font.fontSize;
    }
    const fill = fills[index(xattr(xf, "fillId"), Math.max(fills.length, 1))];
    if (fill?.color) raw.fill = fill.color; if (fill?.lossy) warn.add("cell_formatting_not_preserved");
    const border = borders[index(xattr(xf, "borderId"), Math.max(borders.length, 1))];
    if (border?.border) raw.border = border.border; if (border?.lossy) warn.add("cell_formatting_not_preserved");
    const fmtId = Number(xattr(xf, "numFmtId") ?? "0");
    if (fmtId) { const code = formats.get(fmtId); if (code) raw.numFmt = code; else warn.add("cell_formatting_not_preserved"); }
    const alignment = xchildren(xf, "alignment")[0];
    if (alignment) {
      const h = xattr(alignment, "horizontal"), v = xattr(alignment, "vertical");
      if (h === "left" || h === "center" || h === "right") raw.horizontal = h; else if (h && h !== "general") warn.add("cell_formatting_not_preserved");
      if (v === "top" || v === "center" || v === "bottom") raw.vertical = v;
      const wrap = xattr(alignment, "wrapText");
      if (wrap && !["0", "false"].includes(wrap)) raw.wrap = true;
      if (Object.keys(alignment.attrs).some((key) => !["|horizontal", "|vertical", "|wrapText"].includes(key))) warn.add("cell_formatting_not_preserved");
    }
    try { return normalizeXlsxStyle(raw); } catch { warn.add("cell_formatting_not_preserved"); return undefined; }
  });
}

/** Parse `<dxfs>` differential styles used by conditional formatting rules. */
export function readXlsxDxfs(root: XlsxXmlNode, warn: Set<string>): XlsxDxfStyle[] {
  const parent = xchildren(root, "dxfs")[0];
  if (!parent) return [];
  return xchildren(parent, "dxf").map((dxf): XlsxDxfStyle => {
    const out: XlsxDxfStyle = {};
    const flag: ColorFlag = { themed: false };
    const font = xchildren(dxf, "font")[0];
    if (font) {
      if (on(xchildren(font, "b")[0])) out.bold = true;
      const color = rgbOf(xchildren(font, "color")[0], flag);
      if (color) out.color = color;
    }
    const fill = xchildren(dxf, "fill")[0];
    const pattern = fill ? xchildren(fill, "patternFill")[0] : undefined;
    if (pattern) {
      const bg = rgbOf(xchildren(pattern, "fgColor")[0], flag) ?? rgbOf(xchildren(pattern, "bgColor")[0], flag);
      if (bg) out.bg = bg;
    }
    if (flag.themed) warn.add("style_colors_not_preserved");
    return out;
  });
}

/** `A1:B2` → zero-based range; single cells are rejected because they are not merges. */
export function parseMergeRef(ref: string, address: (value: string) => { row: number; col: number }): XlsxMerge {
  const parts = ref.split(":");
  if (parts.length !== 2) throw new XlsxError("invalid merge range");
  const a = address(parts[0]), b = address(parts[1]);
  const merge = { top: Math.min(a.row, b.row), left: Math.min(a.col, b.col), bottom: Math.max(a.row, b.row), right: Math.max(a.col, b.col) };
  if (merge.top === merge.bottom && merge.left === merge.right) throw new XlsxError("invalid merge range");
  return merge;
}
