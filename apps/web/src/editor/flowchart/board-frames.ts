import { edgePath, textArea, type FlowEdge, type FlowNode, type FlowTheme } from "./model";

export interface BoardFrame {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bg?: string;
}

const FRAME_STORAGE_PREFIX = "jiange.board.frames.v1:";
const MIN_FRAME_W = 160;
const MIN_FRAME_H = 120;
const MAX_COORD = 20_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeBoardFrame(input: unknown): BoardFrame | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > 64) return null;
  if (typeof raw.x !== "number" || !Number.isFinite(raw.x)) return null;
  if (typeof raw.y !== "number" || !Number.isFinite(raw.y)) return null;
  if (typeof raw.w !== "number" || !Number.isFinite(raw.w)) return null;
  if (typeof raw.h !== "number" || !Number.isFinite(raw.h)) return null;
  const title = typeof raw.title === "string" ? raw.title.slice(0, 120) : "Frame";
  const bg =
    typeof raw.bg === "string" && (/^#[0-9a-fA-F]{6}$/.test(raw.bg) || /^rgba?\([^)]{1,40}\)$/.test(raw.bg))
      ? raw.bg
      : undefined;
  return {
    id: raw.id,
    title: title || "Frame",
    x: Math.round(clamp(raw.x, -MAX_COORD, MAX_COORD)),
    y: Math.round(clamp(raw.y, -MAX_COORD, MAX_COORD)),
    w: Math.round(clamp(raw.w, MIN_FRAME_W, 8_000)),
    h: Math.round(clamp(raw.h, MIN_FRAME_H, 8_000)),
    ...(bg ? { bg } : {}),
  };
}

export function boardFrameStorageKey(boardKey: string): string {
  return `${FRAME_STORAGE_PREFIX}${boardKey || "default"}`;
}

export function loadBoardFrames(boardKey: string): BoardFrame[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(boardFrameStorageKey(boardKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, 100)
      .map((item) => normalizeBoardFrame(item))
      .filter((item): item is BoardFrame => item !== null);
  } catch {
    return [];
  }
}

export function saveBoardFrames(boardKey: string, frames: readonly BoardFrame[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    const clean = frames
      .slice(0, 100)
      .map((item) => normalizeBoardFrame(item))
      .filter((item): item is BoardFrame => item !== null);
    if (clean.length === 0) {
      localStorage.removeItem(boardFrameStorageKey(boardKey));
    } else {
      localStorage.setItem(boardFrameStorageKey(boardKey), JSON.stringify(clean));
    }
  } catch {
    /* ignore storage quota / restricted storage errors */
  }
}

/** Create a new Feishu-style Frame partition centered at `center` with a unique sequential title. */
export function createBoardFrame(
  existing: readonly BoardFrame[],
  center: { x: number; y: number },
  size: { w?: number; h?: number } = {},
): BoardFrame {
  const w = Math.round(clamp(size.w ?? 520, MIN_FRAME_W, 8_000));
  const h = Math.round(clamp(size.h ?? 340, MIN_FRAME_H, 8_000));
  const usedTitles = new Set(existing.map((f) => f.title));
  let idx = existing.length + 1;
  while (usedTitles.has(`Frame ${idx}`)) idx++;
  const id = `fr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    title: `Frame ${idx}`,
    x: Math.round(clamp(center.x - w / 2, -MAX_COORD, MAX_COORD)),
    y: Math.round(clamp(center.y - h / 2, -MAX_COORD, MAX_COORD)),
    w,
    h,
    bg: "#F8FAFF",
  };
}

/** Return all nodes whose center point lies inside `frame` (inclusive). */
export function nodesInsideFrame(frame: BoardFrame, nodes: readonly FlowNode[]): FlowNode[] {
  const right = frame.x + frame.w;
  const bottom = frame.y + frame.h;
  return nodes.filter((node) => {
    const cx = node.x + node.w / 2;
    const cy = node.y + node.h / 2;
    return cx >= frame.x && cx <= right && cy >= frame.y && cy <= bottom;
  });
}

/** Move `frame` and every node whose center lies inside it together by `(dx, dy)`. */
export function moveFrameWithContents(
  frame: BoardFrame,
  nodes: readonly FlowNode[],
  dx: number,
  dy: number,
): { frame: BoardFrame; nodes: FlowNode[]; movedNodeIds: string[] } {
  const inside = nodesInsideFrame(frame, nodes);
  const insideIds = new Set(inside.map((n) => n.id));

  let clampedDx = Math.round(dx);
  let clampedDy = Math.round(dy);

  // Clamp delta so neither frame nor any contained node escapes the world bounds.
  clampedDx = clamp(clampedDx, -MAX_COORD - frame.x, MAX_COORD - frame.x);
  clampedDy = clamp(clampedDy, -MAX_COORD - frame.y, MAX_COORD - frame.y);
  for (const n of inside) {
    clampedDx = clamp(clampedDx, -MAX_COORD - n.x, MAX_COORD - n.x);
    clampedDy = clamp(clampedDy, -MAX_COORD - n.y, MAX_COORD - n.y);
  }

  const nextFrame: BoardFrame = {
    ...frame,
    x: frame.x + clampedDx,
    y: frame.y + clampedDy,
  };
  const nextNodes = nodes.map((n) =>
    insideIds.has(n.id) ? { ...n, x: n.x + clampedDx, y: n.y + clampedDy } : n,
  );
  return { frame: nextFrame, nodes: nextNodes, movedNodeIds: [...insideIds] };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function readableOn(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return "#1F2329";
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#1F2329" : "#FFFFFF";
}

function resolveNodeColors(n: FlowNode, theme: FlowTheme): { fill: string; stroke: string; text: string } {
  if (theme.palette && !n.fill && !n.stroke) {
    let h = 0;
    for (const ch of n.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const [fill, stroke] = theme.palette[h % theme.palette.length].split("/");
    return { fill, stroke, text: n.color ?? theme.text };
  }
  const text = n.color ?? (n.fill && n.shape !== "text" ? readableOn(n.fill) : theme.text);
  return {
    fill: n.shape === "text" ? "none" : (n.fill ?? theme.fill),
    stroke: n.shape === "text" ? "none" : (n.stroke ?? theme.stroke),
    text,
  };
}

function shapeSvgMarkup(n: FlowNode, theme: FlowTheme, fill: string, stroke: string): string {
  const { x, y, w, h } = n;
  const sw = theme.strokeWidth;
  const common = `fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"`;
  switch (n.shape) {
    case "round":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(16, theme.radius + 6)}" ${common}/>`;
    case "terminator":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ${common}/>`;
    case "ellipse":
      return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${common}/>`;
    case "diamond":
      return `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" ${common}/>`;
    case "parallelogram": {
      const k = Math.min(24, w / 5);
      return `<polygon points="${x + k},${y} ${x + w},${y} ${x + w - k},${y + h} ${x},${y + h}" ${common}/>`;
    }
    case "hexagon": {
      const k = Math.min(24, w / 5);
      return `<polygon points="${x + k},${y} ${x + w - k},${y} ${x + w},${y + h / 2} ${x + w - k},${y + h} ${x + k},${y + h} ${x},${y + h / 2}" ${common}/>`;
    }
    case "triangle":
      return `<polygon points="${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}" ${common}/>`;
    case "document": {
      const k = h * 0.14;
      return `<path d="M${x},${y} H${x + w} V${y + h - k} C${x + w * 0.75},${y + h - 2.6 * k} ${x + w * 0.25},${y + h + 0.6 * k} ${x},${y + h - k} Z" ${common}/>`;
    }
    case "cylinder": {
      const k = Math.min(14, h / 5);
      return `<g><path d="M${x},${y + k} A${w / 2},${k} 0 0 1 ${x + w},${y + k} V${y + h - k} A${w / 2},${k} 0 0 1 ${x},${y + h - k} Z" ${common}/><path d="M${x},${y + k} A${w / 2},${k} 0 0 0 ${x + w},${y + k}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/></g>`;
    }
    case "note": {
      const k = Math.min(18, w / 5, h / 3);
      return `<g><path d="M${x},${y} H${x + w - k} L${x + w},${y + k} V${y + h} H${x} Z" ${common}/><path d="M${x + w - k},${y} V${y + k} H${x + w}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/></g>`;
    }
    case "swimlane":
      return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/><rect x="${x}" y="${y}" width="32" height="${h}" ${common}/></g>`;
    case "swimlaneV":
      return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/><rect x="${x}" y="${y}" width="${w}" height="36" ${common}/></g>`;
    case "class":
      return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(4, theme.radius)}" ${common}/><line x1="${x}" y1="${y + 32}" x2="${x + w}" y2="${y + 32}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/></g>`;
    case "text":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="none"/>`;
    default:
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${theme.radius}" ${common}/>`;
  }
}

function wrapTextLines(text: string, maxWidth: number, fontSize: number): string[] {
  const limit = Math.max(24, maxWidth - 16);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    let width = 0;
    for (const ch of [...para]) {
      const cw = /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.56;
      if (line && width + cw > limit) {
        out.push(line);
        line = "";
        width = 0;
      }
      line += ch;
      width += cw;
    }
    out.push(line);
  }
  return out.slice(0, 8);
}

function nodeTextMarkup(n: FlowNode, fill: string): string {
  if (!n.text || n.shape === "image") return "";
  const fs = n.size ?? 14;
  const lh = Math.round(fs * 1.3);
  const box = textArea(n);
  const lines = wrapTextLines(n.text, box.w, fs);
  const anchor = n.align === "left" ? "start" : n.align === "right" ? "end" : "middle";
  const tx = n.align === "left" ? box.x + 10 : n.align === "right" ? box.x + box.w - 10 : box.x + box.w / 2;
  const startY = box.y + box.h / 2 - ((lines.length - 1) * lh) / 2 + fs * 0.36;
  const tspans = lines
    .map((line, i) => `<tspan x="${tx}" dy="${i ? lh : 0}">${escapeXml(line)}</tspan>`)
    .join("");
  return `<text x="${tx}" y="${startY}" text-anchor="${anchor}" font-size="${fs}" fill="${escapeXml(fill)}">${tspans}</text>`;
}

/**
 * Generate a crisp standalone SVG document cropped strictly to `frame`'s bounds,
 * including only the nodes inside the frame and edges connecting them.
 */
export function exportFrameToSvg(
  frame: BoardFrame,
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  theme: FlowTheme,
): string {
  const insideNodes = nodesInsideFrame(frame, nodes).sort(
    (a, b) => (a.z ?? 0) - (b.z ?? 0) || a.id.localeCompare(b.id),
  );
  const byId = new Map(insideNodes.map((n) => [n.id, n]));
  const insideEdges = edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const bg = frame.bg ?? theme.canvas;
  const markerId = "frame-export-arrow";

  const edgesSvg = insideEdges
    .map((e) => {
      const from = byId.get(e.from)!;
      const to = byId.get(e.to)!;
      const { d, mid } = edgePath(e, from, to);
      const color = e.color ?? theme.edge;
      const dash = e.dashed ? ` stroke-dasharray="6 4"` : "";
      const markerEnd = e.arrow === "none" ? "" : ` marker-end="url(#${markerId})"`;
      const markerStart = e.arrow === "both" ? ` marker-start="url(#${markerId})"` : "";
      const label = e.label
        ? `<text x="${mid.x}" y="${mid.y - 4}" text-anchor="middle" font-size="12" fill="${escapeXml(theme.text)}">${escapeXml(e.label)}</text>`
        : "";
      return `<g data-frame-export-edge="${escapeXml(e.id)}"><path d="${escapeXml(d)}" fill="none" stroke="${escapeXml(color)}" stroke-width="1.5"${dash}${markerStart}${markerEnd}/>${label}</g>`;
    })
    .join("");

  const nodesSvg = insideNodes
    .map((n) => {
      const colors = resolveNodeColors(n, theme);
      const transform = n.rot
        ? ` transform="rotate(${n.rot} ${n.x + n.w / 2} ${n.y + n.h / 2})"`
        : "";
      return `<g data-frame-export-node="${escapeXml(n.id)}"${transform}>${shapeSvgMarkup(n, theme, colors.fill, colors.stroke)}${nodeTextMarkup(n, colors.text)}</g>`;
    })
    .join("");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.w}" height="${frame.h}" viewBox="${frame.x} ${frame.y} ${frame.w} ${frame.h}" style="font-family:${escapeXml(theme.font)}">`,
    `<title>${escapeXml(frame.title)}</title>`,
    `<defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${escapeXml(theme.edge)}"/></marker></defs>`,
    `<rect x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" fill="${escapeXml(bg)}"/>`,
    edgesSvg,
    nodesSvg,
    `</svg>`,
  ].join("\n");
}
