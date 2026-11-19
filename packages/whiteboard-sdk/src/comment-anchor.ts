/**
 * Canvas object and coordinate comment anchor codec for Jiange Whiteboards.
 *
 * Encodes anchors cleanly into the existing document `comments.startChar` and
 * `comments.endChar` fields (each <= 64 chars):
 *   - Shape / node object anchor: startChar = "fc:n:<nodeId>",  endChar = "<x>,<y>"
 *   - Mindmap topic anchor:       startChar = "fc:m:<topicId>", endChar = "<x>,<y>"
 *   - Free canvas coordinate pin: startChar = "fc:p:<x>,<y>",   endChar = "<x>,<y>"
 *
 * Storing the fallback coordinate in `endChar` lets pins dynamically follow
 * moved/scaled shapes and mindmap layouts while staying visible at their last
 * known location if the anchored object is later deleted.
 */

import { layoutMindTopics } from "./mindmap.js";
import type { FlowGraph } from "./model.js";

export type FlowCommentAnchor =
  | { kind: "node"; targetId: string; x: number; y: number }
  | { kind: "mind"; targetId: string; x: number; y: number }
  | { kind: "point"; x: number; y: number };

const TARGET_ID = /^[A-Za-z0-9_-]{1,56}$/;

function clampCoord(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-20000, Math.min(20000, Math.round(n)));
}

function parseCoordPair(raw: string): { x: number; y: number } | null {
  const parts = raw.split(",");
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: clampCoord(x), y: clampCoord(y) };
}

export function isFlowCommentAnchor(startChar: string | undefined): boolean {
  return typeof startChar === "string" && startChar.startsWith("fc:");
}

export function encodeFlowCommentAnchor(anchor: FlowCommentAnchor): { startChar: string; endChar: string } {
  const x = clampCoord(anchor.x);
  const y = clampCoord(anchor.y);
  const endChar = `${x},${y}`;
  if (anchor.kind === "node" && TARGET_ID.test(anchor.targetId)) {
    return { startChar: `fc:n:${anchor.targetId}`, endChar };
  }
  if (anchor.kind === "mind" && TARGET_ID.test(anchor.targetId)) {
    return { startChar: `fc:m:${anchor.targetId}`, endChar };
  }
  return { startChar: `fc:p:${endChar}`, endChar };
}

export function parseFlowCommentAnchor(startChar: string, endChar: string): FlowCommentAnchor | null {
  if (!startChar.startsWith("fc:")) return null;
  const fallback = parseCoordPair(endChar) ?? { x: 0, y: 0 };
  if (startChar.startsWith("fc:n:")) {
    const id = startChar.slice(5);
    if (!TARGET_ID.test(id)) return null;
    return { kind: "node", targetId: id, x: fallback.x, y: fallback.y };
  }
  if (startChar.startsWith("fc:m:")) {
    const id = startChar.slice(5);
    if (!TARGET_ID.test(id)) return null;
    return { kind: "mind", targetId: id, x: fallback.x, y: fallback.y };
  }
  if (startChar.startsWith("fc:p:")) {
    const pt = parseCoordPair(startChar.slice(5)) ?? fallback;
    return { kind: "point", x: pt.x, y: pt.y };
  }
  return null;
}

export function resolveFlowCommentPosition(
  anchor: FlowCommentAnchor,
  graph: FlowGraph,
  collapsed?: ReadonlySet<string>,
): { x: number; y: number; orphaned: boolean } {
  if (anchor.kind === "node") {
    const node = graph.nodes.find((n) => n.id === anchor.targetId);
    if (node) {
      return { x: Math.round(node.x + node.w), y: Math.round(node.y), orphaned: false };
    }
    return { x: anchor.x, y: anchor.y, orphaned: true };
  }
  if (anchor.kind === "mind") {
    if (graph.mind?.length) {
      const laid = layoutMindTopics(
        graph.mind,
        collapsed ?? new Set(graph.mindCollapsed ?? []),
        graph.mindStyles,
        graph.mindDescriptions,
        graph.mindDescriptionStyles,
      );
      const pos = laid.find((item) => item.topic.id === anchor.targetId);
      if (pos) {
        return { x: Math.round(pos.x + pos.w), y: Math.round(pos.y), orphaned: false };
      }
    }
    return { x: anchor.x, y: anchor.y, orphaned: true };
  }
  return { x: anchor.x, y: anchor.y, orphaned: false };
}
