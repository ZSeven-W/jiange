import type { DocumentReferenceItem, DocumentReferences } from "./document-references";

export interface ReferenceGraphNode extends DocumentReferenceItem { incoming: boolean; outgoing: boolean; x: number; y: number }
export interface ReferenceGraphLayout { width: number; height: number; centerX: number; centerY: number; nodes: ReferenceGraphNode[] }

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
