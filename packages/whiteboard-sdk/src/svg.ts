/**
 * Zero-DOM pure TypeScript SVG renderer for `@zseven-w/whiteboard-sdk`.
 * Renders flowcharts (all shapes + edges + labels), mind maps, and ink strokes.
 */

import { escapeXml } from "@zseven-w/ooxml/xml";
import { layoutMindTopics, mindDefaultTextColor } from "./mindmap.js";
import { edgePath, themeOf, type FlowEdge, type FlowGraph, type FlowNode, type FlowTheme } from "./model.js";

export interface BoardSvgOptions {
  padding?: number;
  background?: string;
}

function renderNodeShape(node: FlowNode, theme: FlowTheme): string {
  const fill = node.fill ?? theme.fill;
  const stroke = node.stroke ?? theme.stroke;
  const sw = theme.strokeWidth;
  const { x, y, w, h } = node;
  const cx = x + w / 2;
  const cy = y + h / 2;

  switch (node.shape) {
    case "round":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(14, h / 2)}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/>`;
    case "terminator":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/>`;
    case "ellipse":
      return `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/>`;
    case "diamond":
      return `<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/>`;
    case "parallelogram": {
      const skew = Math.min(20, w * 0.16);
      return `<polygon points="${x + skew},${y} ${x + w},${y} ${x + w - skew},${y + h} ${x},${y + h}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/>`;
    }
    case "hexagon": {
      const dx = Math.min(22, w * 0.18);
      return `<polygon points="${x + dx},${y} ${x + w - dx},${y} ${x + w},${cy} ${x + w - dx},${y + h} ${x + dx},${y + h} ${x},${cy}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/>`;
    }
    case "triangle":
      return `<polygon points="${cx},${y} ${x + w},${y + h} ${x},${y + h}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/>`;
    case "cylinder": {
      const ry = Math.min(12, h * 0.16);
      return (
        `<path d="M ${x} ${y + ry} L ${x} ${y + h - ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry} L ${x + w} ${y + ry} Z" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/>` +
        `<ellipse cx="${cx}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/>`
      );
    }
    case "text":
      return "";
    default:
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${theme.radius}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${sw}"/>`;
  }
}

function renderNodeText(node: FlowNode, theme: FlowTheme): string {
  if (!node.text) return "";
  const lines = node.text.split("\n");
  const fontSize = node.size ?? 14;
  const lineH = fontSize * 1.35;
  const startY = node.y + node.h / 2 - ((lines.length - 1) * lineH) / 2 + fontSize * 0.35;
  const color = node.color ?? theme.text;
  const align = node.align ?? "center";
  const anchor = align === "left" ? "start" : align === "right" ? "end" : "middle";
  const tx = align === "left" ? node.x + 10 : align === "right" ? node.x + node.w - 10 : node.x + node.w / 2;

  const tspans = lines
    .map((line, i) => `<tspan x="${tx.toFixed(1)}" y="${(startY + i * lineH).toFixed(1)}">${escapeXml(line || " ")}</tspan>`)
    .join("");
  return `<text font-family="${escapeXml(theme.font)}" font-size="${fontSize}" fill="${escapeXml(color)}" text-anchor="${anchor}">${tspans}</text>`;
}

function renderEdgeSvg(edge: FlowEdge, nodesById: Map<string, FlowNode>, theme: FlowTheme): string {
  const from = nodesById.get(edge.from);
  const to = nodesById.get(edge.to);
  if (!from || !to) return "";
  const routed = edgePath(edge, from, to);
  const stroke = edge.color ?? theme.edge;
  const dash = edge.dashed ? ` stroke-dasharray="6 4"` : "";
  const markerEnd = edge.arrow === "none" ? "" : ` marker-end="url(#wb-arrow)"`;
  const markerStart = edge.arrow === "both" ? ` marker-start="url(#wb-arrow-start)"` : "";

  let labelXml = "";
  if (edge.label) {
    const bw = Math.max(36, edge.label.length * 8 + 14);
    const bh = 22;
    labelXml =
      `<rect x="${(routed.mid.x - bw / 2).toFixed(1)}" y="${(routed.mid.y - bh / 2).toFixed(1)}" width="${bw}" height="${bh}" rx="4" fill="${escapeXml(theme.canvas)}"/>` +
      `<text x="${routed.mid.x.toFixed(1)}" y="${(routed.mid.y + 4).toFixed(1)}" font-family="${escapeXml(theme.font)}" font-size="12" fill="${escapeXml(theme.text)}" text-anchor="middle">${escapeXml(edge.label)}</text>`;
  }

  return (
    `<g data-edge-id="${escapeXml(edge.id)}">` +
    `<path d="${routed.d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="1.8"${dash}${markerStart}${markerEnd}/>` +
    labelXml +
    `</g>`
  );
}

/** Render a whiteboard `FlowGraph` (nodes, edges, mindmap, strokes) to a standalone SVG string. */
export function renderBoardToSvg(graph: FlowGraph, options: BoardSvgOptions = {}): string {
  const padding = options.padding ?? 32;
  const theme = themeOf(graph.theme);
  const bg = options.background ?? theme.canvas;

  const positionedMind = graph.mind && graph.mind.length > 0
    ? layoutMindTopics(
        graph.mind,
        new Set(graph.mindCollapsed ?? []),
        graph.mindStyles,
        graph.mindDescriptions,
        graph.mindDescriptionStyles,
      )
    : [];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const n of graph.nodes) {
    include(n.x, n.y);
    include(n.x + n.w, n.y + n.h);
  }
  for (const item of positionedMind) {
    include(item.x, item.y);
    include(item.x + item.w, item.y + item.h);
  }
  for (const stroke of graph.strokes ?? []) {
    for (const p of stroke.points) include(p.x, p.y);
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 400;
    maxY = 240;
  }

  const vx = Math.floor(minX - padding);
  const vy = Math.floor(minY - padding);
  const vw = Math.max(120, Math.ceil(maxX - minX + padding * 2));
  const vh = Math.max(80, Math.ceil(maxY - minY + padding * 2));

  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const parts: string[] = [
    `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${escapeXml(bg)}"/>`,
  ];

  // Edges
  for (const edge of graph.edges) {
    parts.push(renderEdgeSvg(edge, nodesById, theme));
  }

  // Flowchart nodes
  for (const node of graph.nodes) {
    const cx = node.x + node.w / 2;
    const cy = node.y + node.h / 2;
    const rot = node.rot ? ` transform="rotate(${node.rot} ${cx} ${cy})"` : "";
    parts.push(`<g data-node-id="${escapeXml(node.id)}"${rot}>${renderNodeShape(node, theme)}${renderNodeText(node, theme)}</g>`);
  }

  // Mindmap connections & nodes
  if (positionedMind.length > 0) {
    const posById = new Map(positionedMind.map((p) => [p.topic.id, p]));
    for (const item of positionedMind) {
      if (!item.topic.parent) continue;
      const parentPos = posById.get(item.topic.parent)!;
      const x1 = parentPos.x + parentPos.w;
      const y1 = parentPos.y + parentPos.h / 2;
      const x2 = item.x;
      const y2 = item.y + item.h / 2;
      const mx = (x1 + x2) / 2;
      parts.push(`<path d="M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="${escapeXml(theme.edge)}" stroke-width="1.6"/>`);
    }
    for (const item of positionedMind) {
      const style = graph.mindStyles?.[item.topic.id];
      const paint = graph.mindPaints?.[item.topic.id];
      const isRoot = item.topic.parent === null;
      const fill = paint?.fill && paint.fill !== "none" ? paint.fill : isRoot ? "#5b7ff1" : "#eef3fe";
      const stroke = paint?.stroke ?? "#3370ff";
      const txtColor = style?.color ?? mindDefaultTextColor(isRoot, style?.shape, paint);
      const rx = style?.shape === "oval" ? item.h / 2 : 8;
      parts.push(
        `<g data-mind-id="${escapeXml(item.topic.id)}">` +
          `<rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" rx="${rx}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${paint?.width ?? 1.5}"/>` +
          `<text x="${(item.x + item.w / 2).toFixed(1)}" y="${(item.y + item.h / 2 + 5).toFixed(1)}" font-family="${escapeXml(theme.font)}" font-size="${style?.size ?? 14}" fill="${escapeXml(txtColor)}" text-anchor="middle">${escapeXml(item.topic.text)}</text>` +
          `</g>`,
      );
    }
  }

  // Ink strokes
  for (const stroke of graph.strokes ?? []) {
    if (stroke.points.length === 0) continue;
    const d = stroke.points.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
    const opacity = stroke.marker ? ` opacity="0.4"` : "";
    parts.push(
      `<path data-stroke-id="${escapeXml(stroke.id)}" d="${d}" fill="none" stroke="${escapeXml(stroke.color)}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"${opacity}/>`,
    );
  }

  const defs =
    `<defs>` +
    `<marker id="wb-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker>` +
    `<marker id="wb-arrow-start" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 10 0 L 0 5 L 10 10 z" fill="context-stroke"/></marker>` +
    `</defs>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}">${defs}${parts.join("")}</svg>`;
}
