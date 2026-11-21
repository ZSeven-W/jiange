/**
 * Zero-DOM pure TypeScript 16:9 SVG renderer for Jiange Slides.
 * Works identically in Node.js, Edge runtimes, Workers, and browsers.
 */

import { escapeXml } from "@jiange/ooxml/xml";
import type {
  SlideChartData,
  SlideMediaAsset,
  SlideShape,
  SlideTableData,
  SlideTheme,
  SlidesPage,
} from "./model.js";
import { DEFAULT_SLIDE_THEME } from "./model.js";

export interface SlideSvgOptions {
  width?: number;
  height?: number;
  theme?: Partial<SlideTheme>;
  media?: Record<string, SlideMediaAsset>;
}

const CHART_PALETTE = ["#3370ff", "#00b42a", "#ff7d00", "#f53f3f", "#722ed1", "#14c9c9"];

function parseHexRgb(color: string | undefined): [number, number, number] | null {
  if (!color) return null;
  const clean = color.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [
      Number.parseInt(clean.slice(0, 2), 16),
      Number.parseInt(clean.slice(2, 4), 16),
      Number.parseInt(clean.slice(4, 6), 16),
    ];
  }
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return [
      Number.parseInt(clean[0] + clean[0], 16),
      Number.parseInt(clean[1] + clean[1], 16),
      Number.parseInt(clean[2] + clean[2], 16),
    ];
  }
  return null;
}

function isDarkColor(color: string | undefined): boolean {
  const rgb = parseHexRgb(color);
  if (!rgb) return false;
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 135;
}

function wrapLines(text: string, maxCharsPerLine: number): string[] {
  const limit = Math.max(4, Math.floor(maxCharsPerLine));
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) {
      out.push("");
      continue;
    }
    let current = "";
    let width = 0;
    for (const ch of Array.from(rawLine)) {
      const charWidth = ch.codePointAt(0)! > 0x2e80 ? 1.85 : 1;
      if (width + charWidth > limit && current) {
        out.push(current);
        current = ch;
        width = charWidth;
      } else {
        current += ch;
        width += charWidth;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

function renderTextBlock(
  text: string,
  rect: { x: number; y: number; w: number; h: number },
  opts: { fontSize: number; color: string; bold?: boolean; align?: "left" | "center" | "right"; fontFamily: string },
): string {
  if (!text) return "";
  const charsPerLine = Math.max(6, (rect.w / (opts.fontSize * 0.58)));
  const lines = wrapLines(text, charsPerLine);
  const lineHeight = opts.fontSize * 1.35;
  const maxLines = Math.max(1, Math.floor(rect.h / lineHeight));
  const visible = lines.slice(0, maxLines);
  const anchor = opts.align === "center" ? "middle" : opts.align === "right" ? "end" : "start";
  const textX = opts.align === "center" ? rect.x + rect.w / 2 : opts.align === "right" ? rect.x + rect.w : rect.x;
  const weight = opts.bold ? "700" : "400";

  const tspans = visible
    .map((line, i) => `<tspan x="${textX.toFixed(1)}" y="${(rect.y + opts.fontSize + i * lineHeight).toFixed(1)}">${escapeXml(line || " ")}</tspan>`)
    .join("");
  return `<text font-family="${escapeXml(opts.fontFamily)}" font-size="${opts.fontSize}" font-weight="${weight}" fill="${escapeXml(opts.color)}" text-anchor="${anchor}">${tspans}</text>`;
}

function regularPolygonPoints(cx: number, cy: number, rx: number, ry: number, sides: number, offsetDeg = -90): string {
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const rad = ((offsetDeg + (360 / sides) * i) * Math.PI) / 180;
    pts.push(`${(cx + rx * Math.cos(rad)).toFixed(1)},${(cy + ry * Math.sin(rad)).toFixed(1)}`);
  }
  return pts.join(" ");
}

function star5Points(cx: number, cy: number, rx: number, ry: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rFactor = i % 2 === 0 ? 1 : 0.42;
    const rad = ((-90 + 36 * i) * Math.PI) / 180;
    pts.push(`${(cx + rx * rFactor * Math.cos(rad)).toFixed(1)},${(cy + ry * rFactor * Math.sin(rad)).toFixed(1)}`);
  }
  return pts.join(" ");
}

function renderTableSvg(table: SlideTableData, rect: { x: number; y: number; w: number; h: number }, fontFamily: string): string {
  const rows = table.rows.length > 0 ? table.rows : [[""]];
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const cw = rect.w / cols;
  const rh = rect.h / rows.length;
  const headerFill = table.headerFill || "#3370ff";
  const border = table.borderColor || "#d0d5dd";
  const parts: string[] = [];

  for (let r = 0; r < rows.length; r++) {
    const isHeader = Boolean(table.headerRow && r === 0);
    for (let c = 0; c < cols; c++) {
      const cx = rect.x + c * cw;
      const cy = rect.y + r * rh;
      const fill = isHeader ? headerFill : r % 2 === 1 ? "#f5f7fb" : "#ffffff";
      const txtColor = isHeader ? "#ffffff" : "#1f2329";
      const cellVal = rows[r]?.[c] ?? "";
      parts.push(
        `<rect x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" width="${cw.toFixed(1)}" height="${rh.toFixed(1)}" fill="${escapeXml(fill)}" stroke="${escapeXml(border)}" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="${(cx + 8).toFixed(1)}" y="${(cy + rh * 0.62).toFixed(1)}" font-family="${escapeXml(fontFamily)}" font-size="14" font-weight="${isHeader ? "700" : "400"}" fill="${txtColor}">${escapeXml(cellVal)}</text>`,
      );
    }
  }
  return `<g data-kind="table">${parts.join("")}</g>`;
}

function renderChartSvg(chart: SlideChartData, rect: { x: number; y: number; w: number; h: number }, fontFamily: string): string {
  const parts: string[] = [
    `<rect x="${rect.x.toFixed(1)}" y="${rect.y.toFixed(1)}" width="${rect.w.toFixed(1)}" height="${rect.h.toFixed(1)}" rx="8" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1"/>`,
  ];
  const pad = 28;
  const titleH = chart.title ? 24 : 8;
  if (chart.title) {
    parts.push(
      `<text x="${(rect.x + rect.w / 2).toFixed(1)}" y="${(rect.y + 22).toFixed(1)}" font-family="${escapeXml(fontFamily)}" font-size="15" font-weight="700" fill="#1f2329" text-anchor="middle">${escapeXml(chart.title)}</text>`,
    );
  }
  const plotX = rect.x + pad;
  const plotY = rect.y + titleH + 8;
  const plotW = Math.max(20, rect.w - pad * 2);
  const plotH = Math.max(20, rect.h - titleH - pad - 14);
  const allValues = chart.series.flatMap((s) => s.values);
  const maxVal = Math.max(1, ...allValues.map((v) => Math.abs(v)));

  if (chart.type === "pie") {
    const firstSeries = chart.series[0]?.values ?? [];
    const total = firstSeries.reduce((acc, v) => acc + Math.max(0, v), 0) || 1;
    const cx = plotX + plotW / 2;
    const cy = plotY + plotH / 2;
    const r = Math.min(plotW, plotH) * 0.42;
    let angle = -Math.PI / 2;
    for (let i = 0; i < firstSeries.length; i++) {
      const val = Math.max(0, firstSeries[i]);
      const slice = (val / total) * Math.PI * 2;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(angle + slice);
      const y2 = cy + r * Math.sin(angle + slice);
      const large = slice > Math.PI ? 1 : 0;
      const color = CHART_PALETTE[i % CHART_PALETTE.length];
      parts.push(
        `<path d="M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${color}"/>`,
      );
      angle += slice;
    }
  } else if (chart.type === "line") {
    const cats = Math.max(1, chart.categories.length);
    for (let sIdx = 0; sIdx < chart.series.length; sIdx++) {
      const s = chart.series[sIdx];
      const color = s.color || CHART_PALETTE[sIdx % CHART_PALETTE.length];
      const pts = s.values.map((v, idx) => {
        const px = plotX + (cats === 1 ? plotW / 2 : (idx / (cats - 1)) * plotW);
        const py = plotY + plotH - (Math.max(0, v) / maxVal) * plotH;
        return `${px.toFixed(1)},${py.toFixed(1)}`;
      });
      parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${escapeXml(color)}" stroke-width="2.5"/>`);
    }
  } else {
    const cats = Math.max(1, chart.categories.length);
    const sCount = Math.max(1, chart.series.length);
    if (chart.type === "bar") {
      const groupH = plotH / cats;
      const barH = Math.max(4, (groupH * 0.72) / sCount);
      for (let c = 0; c < cats; c++) {
        for (let sIdx = 0; sIdx < chart.series.length; sIdx++) {
          const s = chart.series[sIdx];
          const val = Math.max(0, s.values[c] ?? 0);
          const bw = (val / maxVal) * plotW;
          const by = plotY + c * groupH + groupH * 0.14 + sIdx * barH;
          const color = s.color || CHART_PALETTE[sIdx % CHART_PALETTE.length];
          parts.push(`<rect x="${plotX.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${(barH - 1).toFixed(1)}" fill="${escapeXml(color)}"/>`);
        }
      }
    } else {
      const groupW = plotW / cats;
      const barW = Math.max(4, (groupW * 0.72) / sCount);
      for (let c = 0; c < cats; c++) {
        for (let sIdx = 0; sIdx < chart.series.length; sIdx++) {
          const s = chart.series[sIdx];
          const val = Math.max(0, s.values[c] ?? 0);
          const bh = (val / maxVal) * plotH;
          const bx = plotX + c * groupW + groupW * 0.14 + sIdx * barW;
          const by = plotY + plotH - bh;
          const color = s.color || CHART_PALETTE[sIdx % CHART_PALETTE.length];
          parts.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(barW - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="${escapeXml(color)}"/>`);
        }
      }
    }
  }
  return `<g data-kind="chart">${parts.join("")}</g>`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += chars[(triple >> 18) & 0x3f];
    out += chars[(triple >> 12) & 0x3f];
    out += i + 1 < bytes.length ? chars[(triple >> 6) & 0x3f] : "=";
    out += i + 2 < bytes.length ? chars[triple & 0x3f] : "=";
  }
  return out;
}

function renderShapeSvg(
  shape: SlideShape,
  slideW: number,
  slideH: number,
  fontFamily: string,
  media?: Record<string, SlideMediaAsset>,
): string {
  const x = (shape.x / 100) * slideW;
  const y = (shape.y / 100) * slideH;
  const w = ((shape.width ?? 16) / 100) * slideW;
  const h = ((shape.height ?? 20) / 100) * slideH;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const color = shape.color || "#3370ff";
  const rot = shape.rotation ? ` transform="rotate(${shape.rotation} ${cx.toFixed(1)} ${cy.toFixed(1)})"` : "";
  const opacity = shape.opacity !== undefined ? ` opacity="${shape.opacity}"` : "";

  let inner = "";
  switch (shape.kind) {
    case "rectangle":
      inner = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${escapeXml(color)}"/>`;
      break;
    case "rounded-rectangle":
      inner = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(w, h) * 0.15}" fill="${escapeXml(color)}"/>`;
      break;
    case "ellipse":
      inner = `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(w / 2).toFixed(1)}" ry="${(h / 2).toFixed(1)}" fill="${escapeXml(color)}"/>`;
      break;
    case "triangle":
      inner = `<polygon points="${cx.toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + h).toFixed(1)} ${x.toFixed(1)},${(y + h).toFixed(1)}" fill="${escapeXml(color)}"/>`;
      break;
    case "right-triangle":
      inner = `<polygon points="${x.toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + h).toFixed(1)} ${x.toFixed(1)},${(y + h).toFixed(1)}" fill="${escapeXml(color)}"/>`;
      break;
    case "diamond":
      inner = `<polygon points="${cx.toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${cy.toFixed(1)} ${cx.toFixed(1)},${(y + h).toFixed(1)} ${x.toFixed(1)},${cy.toFixed(1)}" fill="${escapeXml(color)}"/>`;
      break;
    case "pentagon":
      inner = `<polygon points="${regularPolygonPoints(cx, cy, w / 2, h / 2, 5)}" fill="${escapeXml(color)}"/>`;
      break;
    case "hexagon":
      inner = `<polygon points="${regularPolygonPoints(cx, cy, w / 2, h / 2, 6, 0)}" fill="${escapeXml(color)}"/>`;
      break;
    case "star":
      inner = `<polygon points="${star5Points(cx, cy, w / 2, h / 2)}" fill="${escapeXml(color)}"/>`;
      break;
    case "parallelogram":
      inner = `<polygon points="${(x + w * 0.2).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${y.toFixed(1)} ${(x + w * 0.8).toFixed(1)},${(y + h).toFixed(1)} ${x.toFixed(1)},${(y + h).toFixed(1)}" fill="${escapeXml(color)}"/>`;
      break;
    case "trapezoid":
      inner = `<polygon points="${(x + w * 0.18).toFixed(1)},${y.toFixed(1)} ${(x + w * 0.82).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + h).toFixed(1)} ${x.toFixed(1)},${(y + h).toFixed(1)}" fill="${escapeXml(color)}"/>`;
      break;
    case "arrow-right":
      inner = `<polygon points="${x.toFixed(1)},${(y + h * 0.25).toFixed(1)} ${(x + w * 0.62).toFixed(1)},${(y + h * 0.25).toFixed(1)} ${(x + w * 0.62).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${cy.toFixed(1)} ${(x + w * 0.62).toFixed(1)},${(y + h).toFixed(1)} ${(x + w * 0.62).toFixed(1)},${(y + h * 0.75).toFixed(1)} ${x.toFixed(1)},${(y + h * 0.75).toFixed(1)}" fill="${escapeXml(color)}"/>`;
      break;
    case "line":
    case "line-arrow":
    case "line-arrow-filled":
    case "line-dot":
    case "line-double-arrow": {
      const markerEnd =
        shape.kind === "line-dot"
          ? ` marker-end="url(#jg-dot)"`
          : shape.kind !== "line"
            ? ` marker-end="url(#jg-arrow)"`
            : "";
      const markerStart = shape.kind === "line-double-arrow" ? ` marker-start="url(#jg-arrow-start)"` : "";
      inner = `<line x1="${x.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(x + w).toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${escapeXml(color)}" stroke-width="${shape.strokeWidth ?? 3}"${markerStart}${markerEnd}/>`;
      break;
    }
    case "text": {
      const content = shape.paragraphs
        ? shape.paragraphs.map((p) => `${p.bullet ? "• " : ""}${p.runs.map((r) => r.text).join("")}`).join("\n")
        : (shape.text ?? "");
      inner = renderTextBlock(content, { x, y, w, h }, {
        fontSize: shape.fontSize ?? 24,
        color,
        bold: shape.bold,
        align: shape.align ?? "left",
        fontFamily,
      });
      break;
    }
    case "table":
      inner = shape.table ? renderTableSvg(shape.table, { x, y, w, h }, fontFamily) : "";
      break;
    case "chart":
      inner = shape.chart ? renderChartSvg(shape.chart, { x, y, w, h }, fontFamily) : "";
      break;
    case "image": {
      const asset = shape.mediaId ? media?.[shape.mediaId] : undefined;
      if (asset) {
        const href = `data:${asset.mimeType};base64,${bytesToBase64(asset.data)}`;
        inner = `<image x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" href="${href}" preserveAspectRatio="xMidYMid meet"/>`;
      } else {
        inner = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#e2e8f0" stroke="#94a3b8" stroke-dasharray="6 4"/>`;
      }
      break;
    }
  }
  return `<g data-shape-id="${escapeXml(shape.id)}"${rot}${opacity}>${inner}</g>`;
}

/** Render a single slide page to a standalone deterministic 16:9 SVG document string. */
export function renderSlideToSvg(
  page: Pick<SlidesPage, "title" | "body" | "background" | "layout" | "shapes">,
  options: SlideSvgOptions = {},
): string {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const theme: SlideTheme = { ...DEFAULT_SLIDE_THEME, ...options.theme };
  const bg = page.background || theme.background;
  const dark = isDarkColor(bg);
  const titleColor = dark ? theme.textLight : theme.textDark;
  const bodyColor = dark ? "#e5e7eb" : "#374151";
  const layout = page.layout ?? "";

  const nodes: string[] = [
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${escapeXml(bg)}"/>`,
  ];

  if (layout === "title") {
    nodes.push(
      renderTextBlock(
        page.title,
        { x: width * 0.08, y: height * 0.28, w: width * 0.84, h: height * 0.22 },
        { fontSize: 48, color: titleColor, bold: true, align: "center", fontFamily: theme.fontFamily },
      ),
    );
    if (page.body) {
      nodes.push(
        renderTextBlock(
          page.body,
          { x: width * 0.12, y: height * 0.54, w: width * 0.76, h: height * 0.24 },
          { fontSize: 24, color: bodyColor, align: "center", fontFamily: theme.fontFamily },
        ),
      );
    }
  } else {
    if (page.title) {
      nodes.push(
        renderTextBlock(
          page.title,
          { x: width * 0.06, y: height * 0.07, w: width * 0.88, h: height * 0.14 },
          { fontSize: 36, color: titleColor, bold: true, align: "left", fontFamily: theme.fontFamily },
        ),
      );
    }
    if (page.body) {
      nodes.push(
        renderTextBlock(
          page.body,
          { x: width * 0.06, y: height * 0.24, w: width * 0.88, h: height * 0.66 },
          { fontSize: 22, color: bodyColor, align: "left", fontFamily: theme.fontFamily },
        ),
      );
    }
  }

  for (const shape of page.shapes ?? []) {
    nodes.push(renderShapeSvg(shape, width, height, theme.fontFamily, options.media));
  }

  const defs =
    `<defs>` +
    `<marker id="jg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker>` +
    `<marker id="jg-arrow-start" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 10 0 L 0 5 L 10 10 z" fill="context-stroke"/></marker>` +
    `<marker id="jg-dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6"><circle cx="5" cy="5" r="4" fill="context-stroke"/></marker>` +
    `</defs>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${defs}${nodes.join("")}</svg>`;
}

/** Render every slide in a deck to an array of SVG strings. */
export function renderDeckToSvg(
  pages: ReadonlyArray<Pick<SlidesPage, "title" | "body" | "background" | "layout" | "shapes">>,
  options: SlideSvgOptions = {},
): string[] {
  return pages.map((page) => renderSlideToSvg(page, options));
}
