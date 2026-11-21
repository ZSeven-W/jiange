/**
 * Mermaid parser (`flowchart`/`graph` and `mindmap`) -> `FlowGraph` for `@jiange/whiteboard-sdk`.
 * Zero third-party dependencies.
 */

import type { MindTopic } from "./mindmap.js";
import { autoLayout, measureLabel, SHAPES, type FlowEdge, type FlowGraph, type FlowNode, type Shape } from "./model.js";

export interface FromMermaidOptions {
  theme?: string;
  autoLayout?: boolean;
}

const DEFAULT_DIMS = new Map<Shape, { w: number; h: number }>(SHAPES.map((s) => [s.id, { w: s.w, h: s.h }]));

function cleanLabel(raw: string): string {
  let text = raw.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text.replace(/<br\s*\/?>/gi, "\n").trim();
}

function parseNodeToken(token: string): { id: string; shape?: Shape; text?: string } | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const idMatch = trimmed.match(/^([A-Za-z0-9_-]+)(.*)$/);
  if (!idMatch) return null;
  const id = idMatch[1];
  const rest = idMatch[2].trim();
  if (!rest) return { id };

  const patterns: Array<[string, string, Shape]> = [
    ["([", "])", "terminator"],
    ["((", "))", "ellipse"],
    ["[(", ")]", "cylinder"],
    ["{{", "}}", "hexagon"],
    ["[/", "/]", "parallelogram"],
    ["[\\", "\\]", "parallelogram"],
    ["[", "]", "rect"],
    ["(", ")", "round"],
    ["{", "}", "diamond"],
  ];

  for (const [open, close, shape] of patterns) {
    if (rest.startsWith(open) && rest.endsWith(close) && rest.length >= open.length + close.length) {
      const inner = rest.slice(open.length, rest.length - close.length);
      return { id, shape, text: cleanLabel(inner) };
    }
  }
  return { id, shape: "rect", text: cleanLabel(rest) };
}

function parseMindmapMermaid(lines: string[], theme: string): FlowGraph {
  const mind: MindTopic[] = [];
  const stack: Array<{ indent: number; id: string }> = [];
  const childCount = new Map<string, number>();
  let seq = 1;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    let label = trimmed;
    const nodeParsed = parseNodeToken(trimmed);
    if (nodeParsed?.text) {
      label = nodeParsed.text;
    } else if (/^root\s*[\(\[\{]/.test(trimmed)) {
      const inner = trimmed.replace(/^root\s*/, "");
      label = cleanLabel(inner.replace(/^[\(\[\{]+|[\)\]\}]+$/g, ""));
    }

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack.length > 0 ? stack[stack.length - 1].id : null;
    const id = `m${seq++}`;
    const parentKey = parent ?? "__root__";
    const order = childCount.get(parentKey) ?? 0;
    childCount.set(parentKey, order + 1);

    mind.push(
      parent === null
        ? { id, parent: null, order, text: label, x: 120, y: 120 + order * 160 }
        : { id, parent, order, text: label },
    );
    stack.push({ indent, id });
  }

  return { nodes: [], edges: [], mind, theme };
}

/** Parse Mermaid `flowchart`, `graph`, or `mindmap` syntax into a laid-out `FlowGraph`. */
export function fromMermaid(code: string, options: FromMermaidOptions = {}): FlowGraph {
  const theme = options.theme ?? "feishu";
  const rawLines = code.replace(/\r\n?/g, "\n").split("\n");
  const nonEmpty = rawLines.filter((l) => l.trim() && !l.trim().startsWith("%%"));
  if (nonEmpty.length === 0) {
    return { nodes: [], edges: [], theme };
  }

  const first = nonEmpty[0].trim();
  if (/^mindmap\b/i.test(first)) {
    const firstIdx = rawLines.findIndex((l) => l.trim() === first);
    return parseMindmapMermaid(rawLines.slice(firstIdx + 1), theme);
  }

  let direction: "TB" | "LR" = "TB";
  const dirMatch = first.match(/^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/i);
  let startIdx = 0;
  if (dirMatch) {
    const dir = dirMatch[1].toUpperCase();
    direction = dir === "LR" || dir === "RL" ? "LR" : "TB";
    startIdx = 1;
  }

  const nodesMap = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  let edgeSeq = 1;

  const ensureNode = (token: string): string | null => {
    const parsed = parseNodeToken(token);
    if (!parsed) return null;
    const existing = nodesMap.get(parsed.id);
    if (existing) {
      if (parsed.shape) existing.shape = parsed.shape;
      if (parsed.text !== undefined) {
        existing.text = parsed.text;
        const dims = DEFAULT_DIMS.get(existing.shape)!;
        existing.w = measureLabel(existing.text, dims.w);
      }
      return existing.id;
    }
    const shape: Shape = parsed.shape ?? "rect";
    const dims = DEFAULT_DIMS.get(shape)!;
    const text = parsed.text ?? parsed.id;
    nodesMap.set(parsed.id, {
      id: parsed.id,
      shape,
      text,
      x: 40 + nodesMap.size * 180,
      y: 40,
      w: measureLabel(text, dims.w),
      h: dims.h,
    });
    return parsed.id;
  };

  const edgeRegex =
    /^(.+?)\s+(<-?\.->|<-->|-\.->|-->|-\.-|---|==>|--\s+([^->]+?)\s+-->|-\.\s*([^.]+?)\s*\.->)\s*(?:\|([^|]+)\|)?\s*(.+)$/;

  for (let i = startIdx; i < nonEmpty.length; i++) {
    const line = nonEmpty[i].trim().replace(/;$/, "");
    if (/^(?:subgraph\b|end\b|classDef\b|class\b|style\b|linkStyle\b)/i.test(line)) continue;

    const match = line.match(edgeRegex);
    if (match) {
      const fromToken = match[1];
      const op = match[2].trim();
      const inlineLabel = match[3] ?? match[4];
      const pipeLabel = match[5];
      const toToken = match[6];

      const fromId = ensureNode(fromToken);
      const toId = ensureNode(toToken);
      if (fromId && toId) {
        const dashed = op.includes(".");
        const arrow: FlowEdge["arrow"] =
          op.startsWith("<") && op.endsWith(">")
            ? "both"
            : op.endsWith(">")
              ? "end"
              : "none";
        const labelRaw = pipeLabel ?? inlineLabel;
        const label = labelRaw ? cleanLabel(labelRaw) : undefined;
        edges.push({
          id: `e${edgeSeq++}`,
          from: fromId,
          to: toId,
          ...(label ? { label } : {}),
          ...(dashed ? { dashed: true } : {}),
          ...(arrow !== "end" ? { arrow } : {}),
        });
      }
      continue;
    }

    ensureNode(line);
  }

  const graph: FlowGraph = { nodes: [...nodesMap.values()], edges, theme };
  if (options.autoLayout !== false && graph.nodes.length > 0) {
    return autoLayout(graph, { direction });
  }
  return graph;
}
