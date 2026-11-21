/**
 * Headless `.xmind` exporter and importer for Jiange Mind Maps.
 *
 * Pure ES2022 over `@jiange/ooxml` (zero DOM dependencies).
 * - Exports valid XMind ZEN (2020+) `.xmind` archives (`content.json`,
 *   `metadata.json`, `manifest.json`, `META-INF/manifest.xml`) preserving
 *   multi-root sheets, hierarchy & sibling order, topic descriptions/notes,
 *   folded branches, shapes, colors, line widths, and text formatting.
 * - Imports BOTH modern XMind (`content.json`) and legacy XMind 8 (`content.xml`).
 */

import { createZip, createZipAsync, listZip, readZipEntry, ZipError, type ZipEntry, type ZipEntryInput } from "@jiange/ooxml/zip";
import { child, children, parseXml, textContent, XmlError, type XmlElement } from "@jiange/ooxml/xml";
import {
  mindDescriptionAt,
  mindDescriptionLines,
  type MindDescriptions,
  type MindPaint,
  type MindPaints,
  type MindStyle,
  type MindStyles,
  type MindTextFormat,
  type MindTextFormats,
  type MindTopic,
} from "./mindmap.js";
import type { FlowGraph } from "./model.js";

const MAX_XMIND_TOPICS = 500;
const MAX_XMIND_DEPTH = 32;
const MAX_XMIND_ENTRY_BYTES = 4 * 1024 * 1024;
const ALLOWED_SIZES = [12, 14, 16, 18, 24, 36, 48, 72, 96] as const;

export class XmindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmindError";
  }
}

export type XmindExportInput = Pick<
  FlowGraph,
  "mind" | "mindCollapsed" | "mindStyles" | "mindPaints" | "mindTextFormats" | "mindDescriptions" | "mindDescriptionStyles"
>;

export interface XmindExportOptions {
  title?: string;
  modified?: Date;
}

export interface XmindImportOptions {
  startX?: number;
  startY?: number;
  existingCount?: number;
}

export interface XmindImportResult {
  mind: MindTopic[];
  mindCollapsed: string[];
  mindStyles: MindStyles;
  mindPaints: MindPaints;
  mindTextFormats: MindTextFormats;
  mindDescriptions: MindDescriptions;
  topicCount: number;
  sheetCount: number;
  warnings: string[];
}

interface XMindJsonTopic {
  id: string;
  class?: string;
  title?: string;
  branch?: string;
  notes?: { plain?: { content?: string } };
  style?: { id?: string; properties?: Record<string, string> };
  children?: { attached?: XMindJsonTopic[]; detached?: XMindJsonTopic[] };
}

interface XMindJsonSheet {
  id: string;
  class?: string;
  title?: string;
  rootTopic?: XMindJsonTopic;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

function normalizeHex(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const h = trimmed.slice(1);
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
  }
  return undefined;
}

function nearestMindSize(pt: number): number {
  let best: number = ALLOWED_SIZES[0];
  let bestDiff = Math.abs(pt - best);
  for (const s of ALLOWED_SIZES) {
    const diff = Math.abs(pt - s);
    if (diff < bestDiff) {
      best = s;
      bestDiff = diff;
    }
  }
  return best;
}

function shapeToXmindClass(shape: MindStyle["shape"] | undefined): string | undefined {
  if (shape === "oval") return "org.xmind.topicShape.ellipse";
  if (shape === "rect") return "org.xmind.topicShape.roundedRect";
  if (shape === "text") return "org.xmind.topicShape.underline";
  return undefined;
}

function xmindClassToShape(cls: string | undefined): MindStyle["shape"] | undefined {
  if (!cls) return undefined;
  if (cls.includes("ellipse") || cls.includes("circle") || cls.includes("oval")) return "oval";
  if (cls.includes("underline") || cls.includes("none")) return "text";
  if (cls.includes("Rect") || cls.includes("rect") || cls.includes("diamond") || cls.includes("parallelogram")) return "rect";
  return undefined;
}

function clampDescription(raw: string): string | undefined {
  const clean = raw.replace(/\0/g, "").replace(/\r\n/g, "\n").trim();
  if (!clean) return undefined;
  let text = clean.slice(0, 2000);
  while (mindDescriptionLines(text).length > 128) {
    text = text.slice(0, Math.floor(text.length * 0.85));
  }
  return text;
}

function makeTopicId(prefix: string, seq: number): string {
  return `xm${prefix}_${seq.toString(36)}`;
}

function buildXmindEntries(graph: XmindExportInput, options: XmindExportOptions): { entries: ZipEntryInput[]; modified: Date } {
  const topics = graph.mind ?? [];
  const roots = topics.filter((t) => t.parent === null).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  if (roots.length === 0) {
    throw new XmindError("画布中没有思维导图主题，无法导出 .xmind");
  }

  const collapsedSet = new Set(graph.mindCollapsed ?? []);
  const byParent = new Map<string, MindTopic[]>();
  for (const t of topics) {
    if (t.parent === null) continue;
    const arr = byParent.get(t.parent);
    if (arr) arr.push(t);
    else byParent.set(t.parent, [t]);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  const serializeTopic = (topic: MindTopic, seen: Set<string>): XMindJsonTopic => {
    seen.add(topic.id);
    const props: Record<string, string> = {};
    const style = graph.mindStyles?.[topic.id];
    const paint = graph.mindPaints?.[topic.id];
    const fmt = graph.mindTextFormats?.[topic.id];

    const shapeCls = shapeToXmindClass(style?.shape);
    if (shapeCls) props["shape-class"] = shapeCls;
    if (style?.size) props["fo:font-size"] = `${style.size}pt`;
    if (style?.color) props["fo:color"] = style.color;

    if (paint?.fill && paint.fill !== "none") props["svg:fill"] = paint.fill;
    if (paint?.stroke) {
      props["border-line-color"] = paint.stroke;
      props["line-color"] = paint.stroke;
    }
    if (paint?.width) props["line-width"] = `${paint.width}pt`;

    if (fmt?.bold) props["fo:font-weight"] = "bold";
    if (fmt?.italic) props["fo:font-style"] = "italic";
    if (fmt?.underline && fmt?.strike) props["fo:text-decoration"] = "underline line-through";
    else if (fmt?.underline) props["fo:text-decoration"] = "underline";
    else if (fmt?.strike) props["fo:text-decoration"] = "line-through";
    if (fmt?.align) props["fo:text-align"] = fmt.align;

    const kids = (byParent.get(topic.id) ?? []).filter((k) => !seen.has(k.id)).map((k) => serializeTopic(k, seen));
    const desc = mindDescriptionAt(graph.mindDescriptions, topic.id);

    const out: XMindJsonTopic = {
      id: topic.id,
      class: "topic",
      title: topic.text,
    };
    if (collapsedSet.has(topic.id) && kids.length > 0) {
      out.branch = "folded";
    }
    if (desc) {
      out.notes = { plain: { content: desc } };
    }
    if (Object.keys(props).length > 0) {
      out.style = { id: `st-${topic.id}`, properties: props };
    }
    if (kids.length > 0) {
      out.children = { attached: kids };
    }
    return out;
  };

  const sheets: XMindJsonSheet[] = roots.map((root, index) => ({
    id: `sheet-${index + 1}`,
    class: "sheet",
    title: root.text.trim() || options.title?.trim() || `画布 ${index + 1}`,
    rootTopic: serializeTopic(root, new Set<string>()),
  }));

  const modified = options.modified ?? new Date();
  const metadata = {
    creator: { name: "Jiange", version: "1.0.0" },
    dataStructureVersion: "2",
    activeSheetId: sheets[0].id,
    createdAt: modified.toISOString(),
  };
  const manifest = {
    "file-entries": {
      "content.json": {},
      "metadata.json": {},
    },
  };
  const manifestXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
    `<manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0">` +
    `<file-entry full-path="content.json" media-type="application/json"/>` +
    `<file-entry full-path="metadata.json" media-type="application/json"/>` +
    `<file-entry full-path="manifest.json" media-type="application/json"/>` +
    `</manifest>`;

  return {
    modified,
    entries: [
      { name: "content.json", data: utf8(JSON.stringify(sheets, null, 2)) },
      { name: "metadata.json", data: utf8(JSON.stringify(metadata, null, 2)) },
      { name: "manifest.json", data: utf8(JSON.stringify(manifest, null, 2)) },
      { name: "META-INF/manifest.xml", data: utf8(manifestXml) },
    ],
  };
}

/** Export Jiange Mind Map topics into a standard XMind ZEN `.xmind` archive. */
export function exportMindMapToXmind(graph: XmindExportInput, options: XmindExportOptions = {}): Uint8Array {
  const { entries, modified } = buildXmindEntries(graph, options);
  return createZip(entries, modified);
}

/** Export Jiange Mind Map topics into a DEFLATE-compressed XMind ZEN `.xmind` archive. */
export async function exportMindMapToXmindAsync(
  graph: XmindExportInput,
  options: XmindExportOptions = {},
): Promise<Uint8Array> {
  const { entries, modified } = buildXmindEntries(graph, options);
  return createZipAsync(entries, { modified });
}

// ---------------------------------------------------------------------------
// Importer (.xmind ZEN content.json + XMind 8 content.xml)
// ---------------------------------------------------------------------------

interface RawParsedTopic {
  title: string;
  notes?: string;
  folded?: boolean;
  style?: MindStyle;
  paint?: MindPaint;
  textFormat?: MindTextFormat;
  children: RawParsedTopic[];
}

function parseJsonTopicStyle(props: Record<string, string> | undefined): {
  style?: MindStyle;
  paint?: MindPaint;
  textFormat?: MindTextFormat;
} {
  if (!props || typeof props !== "object") return {};
  const style: MindStyle = {};
  const paint: MindPaint = {};
  const textFormat: MindTextFormat = {};

  const shape = xmindClassToShape(props["shape-class"]);
  if (shape) style.shape = shape;
  const fontSizeStr = props["fo:font-size"];
  if (fontSizeStr) {
    const pt = Number.parseFloat(fontSizeStr);
    if (Number.isFinite(pt) && pt >= 8 && pt <= 120) style.size = nearestMindSize(pt);
  }
  const color = normalizeHex(props["fo:color"]);
  if (color) style.color = color;

  const fill = normalizeHex(props["svg:fill"]);
  if (fill) paint.fill = fill;
  const stroke = normalizeHex(props["border-line-color"] ?? props["line-color"]);
  if (stroke) paint.stroke = stroke;
  const lineWidthStr = props["line-width"];
  if (lineWidthStr) {
    const w = Math.round(Number.parseFloat(lineWidthStr));
    if (Number.isFinite(w) && w >= 1 && w <= 4) paint.width = w;
  }

  const fw = props["fo:font-weight"];
  if (fw === "bold" || Number(fw) >= 600) textFormat.bold = true;
  if (props["fo:font-style"] === "italic") textFormat.italic = true;
  const td = props["fo:text-decoration"] ?? "";
  if (td.includes("underline")) textFormat.underline = true;
  if (td.includes("line-through")) textFormat.strike = true;
  const align = props["fo:text-align"];
  if (align === "left" || align === "center" || align === "right") textFormat.align = align;

  return {
    style: Object.keys(style).length ? style : undefined,
    paint: Object.keys(paint).length ? paint : undefined,
    textFormat: Object.keys(textFormat).length ? textFormat : undefined,
  };
}

function convertJsonTopic(raw: XMindJsonTopic): RawParsedTopic {
  const title = typeof raw.title === "string" ? raw.title.replace(/\0/g, "").trim().slice(0, 500) : "";
  const notes = typeof raw.notes?.plain?.content === "string" ? clampDescription(raw.notes.plain.content) : undefined;
  const folded = raw.branch === "folded";
  const { style, paint, textFormat } = parseJsonTopicStyle(raw.style?.properties);
  const attached = Array.isArray(raw.children?.attached) ? raw.children.attached : [];
  const detached = Array.isArray(raw.children?.detached) ? raw.children.detached : [];
  return {
    title: title || "主题",
    notes,
    folded,
    style,
    paint,
    textFormat,
    children: [...attached, ...detached].filter((item): item is XMindJsonTopic => !!item && typeof item === "object").map(convertJsonTopic),
  };
}

function convertXmlTopic(el: XmlElement): RawParsedTopic {
  const titleEl = child(el, "title");
  const title = (titleEl ? textContent(titleEl) : "").replace(/\0/g, "").trim().slice(0, 500);
  const notesPlain = child(child(el, "notes"), "plain");
  const notes = notesPlain ? clampDescription(textContent(notesPlain)) : undefined;
  const folded = el.attrs["branch"] === "folded";
  const kids: RawParsedTopic[] = [];
  const childrenEl = child(el, "children");
  for (const topicsGroup of children(childrenEl, "topics")) {
    for (const topicEl of children(topicsGroup, "topic")) {
      kids.push(convertXmlTopic(topicEl));
    }
  }
  return {
    title: title || "主题",
    notes,
    folded,
    children: kids,
  };
}

/** Parse a `.xmind` archive (modern JSON or legacy XMind 8 XML) into Jiange Mind Map structures. */
export async function parseXmindToMindMap(bytes: Uint8Array, options: XmindImportOptions = {}): Promise<XmindImportResult> {
  let entries: ZipEntry[];
  try {
    entries = listZip(bytes);
  } catch (err) {
    throw new XmindError(err instanceof ZipError ? `无效的 XMind 压缩包：${err.message}` : "无法解析 XMind 文件");
  }

  const byName = new Map<string, ZipEntry>();
  for (const e of entries) {
    byName.set(e.name.replace(/\\/g, "/"), e);
  }

  const roots: RawParsedTopic[] = [];
  const warnings: string[] = [];

  const jsonEntry = byName.get("content.json");
  const xmlEntry = byName.get("content.xml");

  if (jsonEntry) {
    let rawText: string;
    try {
      rawText = decoder.decode(await readZipEntry(bytes, jsonEntry, MAX_XMIND_ENTRY_BYTES));
    } catch (err) {
      throw new XmindError(err instanceof ZipError ? `读取 content.json 失败：${err.message}` : "读取 XMind 内容失败");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new XmindError("XMind content.json 格式损坏");
    }
    const sheets = Array.isArray(parsed) ? parsed : [parsed];
    for (const s of sheets) {
      if (s && typeof s === "object" && "rootTopic" in s && (s as XMindJsonSheet).rootTopic) {
        roots.push(convertJsonTopic((s as XMindJsonSheet).rootTopic!));
      }
    }
  } else if (xmlEntry) {
    let xmlRoot: XmlElement;
    try {
      const rawText = decoder.decode(await readZipEntry(bytes, xmlEntry, MAX_XMIND_ENTRY_BYTES));
      xmlRoot = parseXml(rawText, { maxNodes: 50000 });
    } catch (err) {
      throw new XmindError(err instanceof ZipError || err instanceof XmlError ? `解析 content.xml 失败：${err.message}` : "解析 XMind XML 失败");
    }
    for (const sheetEl of children(xmlRoot, "sheet")) {
      const rootEl = child(sheetEl, "topic");
      if (rootEl) roots.push(convertXmlTopic(rootEl));
    }
  } else {
    throw new XmindError("未找到 content.json 或 content.xml，请确认文件为标准 .xmind 思维导图");
  }

  if (roots.length === 0) {
    throw new XmindError("XMind 文件中未包含任何思维导图主题");
  }

  const maxAllowed = Math.max(0, MAX_XMIND_TOPICS - Math.max(0, options.existingCount ?? 0));
  if (maxAllowed === 0) {
    throw new XmindError(`当前画布思维导图主题已达上限（${MAX_XMIND_TOPICS} 个）`);
  }

  const prefix = Date.now().toString(36).slice(-5);
  let seq = 0;
  let truncatedTopics = false;
  let truncatedDepth = false;

  const mind: MindTopic[] = [];
  const mindCollapsed: string[] = [];
  const mindStyles: MindStyles = {};
  const mindPaints: MindPaints = {};
  const mindTextFormats: MindTextFormats = {};
  const mindDescriptions: MindDescriptions = {};

  const startX = Math.max(-18000, Math.min(18000, Math.round(options.startX ?? 160)));
  let cursorY = Math.max(-18000, Math.min(18000, Math.round(options.startY ?? 220)));

  const countLeaves = (node: RawParsedTopic): number =>
    node.children.length === 0 ? 1 : node.children.reduce((acc, c) => acc + countLeaves(c), 0);

  const visit = (node: RawParsedTopic, parentId: string | null, order: number, depth: number, rootPos?: { x: number; y: number }) => {
    if (mind.length >= maxAllowed) {
      truncatedTopics = true;
      return;
    }
    if (depth > MAX_XMIND_DEPTH) {
      truncatedDepth = true;
      return;
    }
    const id = makeTopicId(prefix, ++seq);
    mind.push({
      id,
      parent: parentId,
      order,
      text: node.title,
      ...(parentId === null && rootPos ? { x: rootPos.x, y: rootPos.y } : {}),
    });
    if (node.notes) mindDescriptions[id] = node.notes;
    if (node.style) mindStyles[id] = node.style;
    if (node.paint) mindPaints[id] = node.paint;
    if (node.textFormat) mindTextFormats[id] = node.textFormat;

    const addedChildStart = mind.length;
    node.children.forEach((childNode, idx) => visit(childNode, id, (idx + 1) * 1000, depth + 1));
    if (node.folded && mind.length > addedChildStart) {
      mindCollapsed.push(id);
    }
  };

  roots.forEach((root, idx) => {
    if (mind.length >= maxAllowed) {
      truncatedTopics = true;
      return;
    }
    const leaves = Math.max(1, countLeaves(root));
    const rootY = Math.max(-18000, Math.min(18000, cursorY));
    visit(root, null, (idx + 1) * 1000, 0, { x: startX, y: rootY });
    cursorY += Math.max(220, leaves * 56 + 80);
  });

  if (truncatedTopics) {
    warnings.push(`主题总数超过上限（${MAX_XMIND_TOPICS}），已自动截取前 ${mind.length} 个主题`);
  }
  if (truncatedDepth) {
    warnings.push(`部分分支嵌套超过 ${MAX_XMIND_DEPTH} 层，已截断更深层级`);
  }

  return {
    mind,
    mindCollapsed,
    mindStyles,
    mindPaints,
    mindTextFormats,
    mindDescriptions,
    topicCount: mind.length,
    sheetCount: roots.length,
    warnings,
  };
}
