import type { DocumentReferenceItem, DocumentReferences } from "./document-references";

export interface ReferenceGraphNode extends DocumentReferenceItem { incoming: boolean; outgoing: boolean; x: number; y: number }
export interface ReferenceGraphLayout { width: number; height: number; centerX: number; centerY: number; nodes: ReferenceGraphNode[] }

/** Conservative bounds include labels rather than the canvas's empty margin. */
export function referenceGraphBounds(layout: ReferenceGraphLayout): { left: number; top: number; width: number; height: number } {
  let left = layout.centerX - 100, right = layout.centerX + 100;
  let top = layout.centerY - 55, bottom = layout.centerY + 85;
  for (const node of layout.nodes) {
    left = Math.min(left, node.x - 100); right = Math.max(right, node.x + 100);
    top = Math.min(top, node.y - 30); bottom = Math.max(bottom, node.y + 55);
  }
  return { left, top, width: right - left, height: bottom - top };
}

/** Stable concentric rings keep every permitted relation reachable by scrolling. */
export function layoutDocumentReferenceGraph(data: DocumentReferences): ReferenceGraphLayout {
  const nodes = new Map<number, ReferenceGraphNode>();
  for (const item of data.incoming) nodes.set(item.id, { ...item, incoming: true, outgoing: false, x: 0, y: 0, href: undefined });
  for (const item of data.outgoing) {
    const previous = nodes.get(item.id);
    if (previous) previous.outgoing = true;
    else nodes.set(item.id, { ...item, incoming: false, outgoing: true, x: 0, y: 0 });
  }
  const all = [...nodes.values()].sort((a, b) => a.id - b.id);
  let radius = 150, offset = 0, maxRadius = 0;
  while (offset < all.length) {
    const capacity = Math.max(6, Math.floor(2 * Math.PI * radius / 150));
    const count = Math.min(capacity, all.length - offset);
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + 2 * Math.PI * i / count;
      all[offset + i].x = Math.cos(angle) * radius;
      all[offset + i].y = Math.sin(angle) * radius;
    }
    maxRadius = radius; offset += count; radius += 110;
  }
  const width = Math.max(816, 2 * (maxRadius + 160));
  const height = Math.max(456, 2 * (maxRadius + 100));
  const centerX = width / 2, centerY = height / 2;
  for (const node of all) { node.x += centerX; node.y += centerY; }
  return { width, height, centerX, centerY, nodes: all };
}

/** The path runs from the citing document to the referenced document. */
export function referenceGraphPath(layout: ReferenceGraphLayout, node: ReferenceGraphNode, incoming: boolean): string {
  const dx = node.x - layout.centerX, dy = node.y - layout.centerY, distance = Math.hypot(dx, dy) || 1;
  const nx = dx / distance, ny = dy / distance, shift = node.incoming && node.outgoing ? (incoming ? -3 : 3) : 0;
  const px = -ny * shift, py = nx * shift;
  const center = { x: layout.centerX + nx * 30 + px, y: layout.centerY + ny * 30 + py };
  const edge = { x: node.x - nx * 17 + px, y: node.y - ny * 17 + py };
  const from = incoming ? edge : center, to = incoming ? center : edge;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} L ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

export interface MultiHopGraphNodeInput {
  id: number;
  title: string;
  kind: string;
  docType?: string;
  href?: string;
  depth: number;
}

export interface MultiHopGraphEdgeInput {
  sourceId: number;
  targetId: number;
  relationKind: string;
}

export interface MultiHopReferenceGraph {
  centerId: number;
  depth: number;
  nodes: MultiHopGraphNodeInput[];
  edges: MultiHopGraphEdgeInput[];
  truncated: boolean;
  indexed?: boolean;
}

export interface PositionedMultiHopNode extends MultiHopGraphNodeInput {
  x: number;
  y: number;
  radius: number;
}

export interface PositionedMultiHopEdge extends MultiHopGraphEdgeInput {
  key: string;
  category: "incoming" | "outgoing" | "embed" | "indirect";
  color: string;
  dashed: boolean;
  animated: boolean;
  path: string;
}

export interface MultiHopGraphLayout {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  centerNode: PositionedMultiHopNode | null;
  nodes: PositionedMultiHopNode[];
  edges: PositionedMultiHopEdge[];
}

function nodeRadiusForDepth(depth: number): number {
  if (depth <= 0) return 28;
  if (depth === 1) return 17;
  return 14;
}

/**
 * Multi-hop radial cluster layout:
 * - Depth 0 sits at center.
 * - Depth 1 occupies inner concentric ring(s).
 * - Depth 2 & 3 nodes align near their previous-hop anchor angle on outer ring(s),
 *   spaced cleanly so labels never overlap.
 */
export function layoutMultiHopReferenceGraph(data: MultiHopReferenceGraph): MultiHopGraphLayout {
  const byId = new Map<number, PositionedMultiHopNode>();
  const angles = new Map<number, number>();
  const byDepth = new Map<number, MultiHopGraphNodeInput[]>();

  for (const n of data.nodes) {
    const bucket = byDepth.get(n.depth) ?? [];
    bucket.push(n);
    byDepth.set(n.depth, bucket);
  }

  const centerInput = (byDepth.get(0) ?? []).find((n) => n.id === data.centerId) ?? data.nodes.find((n) => n.id === data.centerId) ?? null;
  if (centerInput) {
    byId.set(centerInput.id, { ...centerInput, x: 0, y: 0, radius: nodeRadiusForDepth(0) });
    angles.set(centerInput.id, -Math.PI / 2);
  }

  // Adjacency to find each outer node's parent anchor angle from depth - 1.
  const neighbors = new Map<number, number[]>();
  for (const e of data.edges) {
    const a = neighbors.get(e.sourceId) ?? [];
    a.push(e.targetId);
    neighbors.set(e.sourceId, a);
    const b = neighbors.get(e.targetId) ?? [];
    b.push(e.sourceId);
    neighbors.set(e.targetId, b);
  }

  let currentRadius = 165;
  let maxRadius = 0;

  const depths = [...byDepth.keys()].filter((d) => d > 0).sort((a, b) => a - b);
  for (const depth of depths) {
    const group = [...(byDepth.get(depth) ?? [])].sort((a, b) => a.id - b.id);
    if (!group.length) continue;

    // Sort outer rings by their anchor angle from the previous depth so edges stay untangled.
    if (depth > 1) {
      const desiredAngle = new Map<number, number>();
      for (const n of group) {
        const prevNeighbors = (neighbors.get(n.id) ?? []).filter((nid) => {
          const p = byId.get(nid);
          return p && p.depth === depth - 1;
        });
        if (prevNeighbors.length > 0) {
          let sx = 0, sy = 0;
          for (const pid of prevNeighbors) {
            const ang = angles.get(pid) ?? 0;
            sx += Math.cos(ang);
            sy += Math.sin(ang);
          }
          desiredAngle.set(n.id, Math.atan2(sy, sx));
        } else {
          desiredAngle.set(n.id, -Math.PI / 2);
        }
      }
      group.sort((a, b) => {
        const diff = (desiredAngle.get(a.id) ?? 0) - (desiredAngle.get(b.id) ?? 0);
        return Math.abs(diff) > 1e-6 ? diff : a.id - b.id;
      });
    }

    const minSpacing = depth === 1 ? 155 : 145;
    let offset = 0;
    while (offset < group.length) {
      const ringRadius = Math.max(currentRadius, Math.ceil((Math.min(group.length - offset, 24) * minSpacing) / (2 * Math.PI)));
      const capacity = Math.max(6, Math.floor((2 * Math.PI * ringRadius) / minSpacing));
      const count = Math.min(capacity, group.length - offset);
      const startAngle = depth === 1 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / Math.max(count, 6);
      for (let i = 0; i < count; i++) {
        const item = group[offset + i];
        const angle = startAngle + (2 * Math.PI * i) / count;
        angles.set(item.id, angle);
        byId.set(item.id, {
          ...item,
          x: Math.cos(angle) * ringRadius,
          y: Math.sin(angle) * ringRadius,
          radius: nodeRadiusForDepth(depth),
        });
      }
      maxRadius = Math.max(maxRadius, ringRadius);
      currentRadius = ringRadius + 135;
      offset += count;
    }
  }

  const width = Math.max(840, 2 * (maxRadius + 170));
  const height = Math.max(480, 2 * (maxRadius + 115));
  const centerX = width / 2;
  const centerY = height / 2;

  const positionedNodes: PositionedMultiHopNode[] = [];
  for (const node of byId.values()) {
    node.x += centerX;
    node.y += centerY;
    if (node.id !== data.centerId) positionedNodes.push(node);
  }
  positionedNodes.sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.id - b.id));

  // Detect opposite-direction edge pairs so bidirectional arrows never overlap.
  const pairSet = new Set<string>();
  for (const e of data.edges) pairSet.add(`${e.sourceId}->${e.targetId}`);

  const positionedEdges: PositionedMultiHopEdge[] = [];
  for (let i = 0; i < data.edges.length; i++) {
    const e = data.edges[i];
    const src = byId.get(e.sourceId);
    const dst = byId.get(e.targetId);
    if (!src || !dst || src.id === dst.id) continue;

    const isBi = pairSet.has(`${e.targetId}->${e.sourceId}`);
    const dx = dst.x - src.x;
    const dy = dst.y - src.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist;
    const ny = dy / dist;
    const shift = isBi ? 3.5 : 0;
    const px = -ny * shift;
    const py = nx * shift;

    const startPad = src.radius + 3;
    const endPad = dst.radius + 4;
    const x1 = src.x + nx * startPad + px;
    const y1 = src.y + ny * startPad + py;
    const x2 = dst.x - nx * endPad + px;
    const y2 = dst.y - ny * endPad + py;

    const isDirectIncoming = dst.id === data.centerId;
    const isDirectOutgoing = src.id === data.centerId;
    const isEmbed = e.relationKind === "embed";

    let category: PositionedMultiHopEdge["category"] = "indirect";
    let color = "#94A3B8";
    let animated = false;
    if (isEmbed && (isDirectIncoming || isDirectOutgoing)) {
      category = "embed";
      color = "#7B67EE";
      animated = true;
    } else if (isDirectIncoming) {
      category = "incoming";
      color = "#26A7FF";
      animated = true;
    } else if (isDirectOutgoing) {
      category = "outgoing";
      color = "#FFB800";
      animated = true;
    } else if (isEmbed) {
      category = "embed";
      color = "#A78BFA";
    }

    positionedEdges.push({
      ...e,
      key: `${e.sourceId}:${e.targetId}:${e.relationKind}:${i}`,
      category,
      color,
      dashed: isEmbed,
      animated: animated && positionedEdges.length < 80,
      path: `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`,
    });
  }

  return {
    width,
    height,
    centerX,
    centerY,
    centerNode: centerInput ? byId.get(centerInput.id) ?? null : null,
    nodes: positionedNodes,
    edges: positionedEdges,
  };
}

export function multiHopGraphBounds(layout: MultiHopGraphLayout): { left: number; top: number; width: number; height: number } {
  let left = layout.centerX - 105, right = layout.centerX + 105;
  let top = layout.centerY - 55, bottom = layout.centerY + 85;
  for (const node of layout.nodes) {
    left = Math.min(left, node.x - 105); right = Math.max(right, node.x + 105);
    top = Math.min(top, node.y - 32); bottom = Math.max(bottom, node.y + 56);
  }
  return { left, top, width: right - left, height: bottom - top };
}
