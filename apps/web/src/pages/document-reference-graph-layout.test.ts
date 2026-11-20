import { describe, expect, it } from "vitest";
import {
  layoutDocumentReferenceGraph,
  layoutMultiHopReferenceGraph,
  multiHopGraphBounds,
  referenceGraphBounds,
  referenceGraphPath,
} from "./document-reference-graph-layout";

describe("document reference graph layout", () => {
  it("merges reciprocal relations and keeps both directions", () => {
    const graph = layoutDocumentReferenceGraph({ incoming: [{ id: 2, title: "来源" }], outgoing: [{ id: 2, title: "来源", href: "#/s/token" }, { id: 3, title: "目标" }] });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0]).toMatchObject({ id: 2, incoming: true, outgoing: true, href: undefined });
    expect(referenceGraphPath(graph, graph.nodes[0], true)).not.toBe(referenceGraphPath(graph, graph.nodes[0], false));
    const coordinates = (path: string) => [...path.matchAll(/-?\d+\.\d+/g)].map((match) => Number(match[0]));
    const incoming = coordinates(referenceGraphPath(graph, graph.nodes[0], true)), outgoing = coordinates(referenceGraphPath(graph, graph.nodes[0], false));
    const distance = (x: number, y: number) => Math.hypot(x - graph.centerX, y - graph.centerY);
    expect(distance(incoming[0], incoming[1])).toBeGreaterThan(distance(incoming[2], incoming[3]));
    expect(distance(outgoing[0], outgoing[1])).toBeLessThan(distance(outgoing[2], outgoing[3]));
  });
  it("keeps all 400 nodes inside a scrollable finite canvas", () => {
    const graph = layoutDocumentReferenceGraph({ incoming: Array.from({ length: 200 }, (_, i) => ({ id: i + 1, title: String(i) })), outgoing: Array.from({ length: 200 }, (_, i) => ({ id: i + 201, title: String(i) })) });
    expect(graph.nodes).toHaveLength(400);
    for (const node of graph.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(100); expect(node.x).toBeLessThanOrEqual(graph.width - 100);
      expect(node.y).toBeGreaterThanOrEqual(40); expect(node.y).toBeLessThanOrEqual(graph.height - 40);
    }
  });
  it("has a centered empty state", () => {
    expect(layoutDocumentReferenceGraph({ incoming: [], outgoing: [] })).toEqual({ width: 816, height: 456, centerX: 408, centerY: 228, nodes: [] });
  });
  it("fits node labels rather than the empty canvas margin", () => {
    const graph = layoutDocumentReferenceGraph({ incoming: [{ id: 1, title: "文档" }], outgoing: [] });
    const bounds = referenceGraphBounds(graph);
    expect(bounds.width).toBe(200);
    expect(bounds.height).toBe(265);
    expect(bounds.width).toBeLessThan(graph.width);
    expect(bounds.top).toBeLessThan(graph.centerY);
  });
  it("lays out multi-hop concentric clusters, bidirectional offsets, and embed edges", () => {
    const layout = layoutMultiHopReferenceGraph({
      centerId: 1,
      depth: 3,
      truncated: false,
      nodes: [
        { id: 1, title: "总纲", kind: "doc", depth: 0 },
        { id: 2, title: "架构", kind: "doc", depth: 1 },
        { id: 3, title: "预算表", kind: "sheet", depth: 1 },
        { id: 4, title: "二跳多维表", kind: "base", depth: 2 },
        { id: 5, title: "三跳幻灯片", kind: "slides", depth: 3 },
      ],
      edges: [
        { sourceId: 1, targetId: 2, relationKind: "link" },
        { sourceId: 2, targetId: 1, relationKind: "link" },
        { sourceId: 1, targetId: 3, relationKind: "embed" },
        { sourceId: 2, targetId: 4, relationKind: "link" },
        { sourceId: 4, targetId: 5, relationKind: "link" },
      ],
    });
    expect(layout.centerNode?.id).toBe(1);
    expect(layout.nodes).toHaveLength(4);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const dist = (id: number) => Math.hypot(byId.get(id)!.x - layout.centerX, byId.get(id)!.y - layout.centerY);
    expect(dist(4)).toBeGreaterThan(dist(2));
    expect(dist(5)).toBeGreaterThan(dist(4));
    const embedEdge = layout.edges.find((e) => e.targetId === 3);
    expect(embedEdge).toMatchObject({ category: "embed", dashed: true });
    const indirectEdge = layout.edges.find((e) => e.sourceId === 4 && e.targetId === 5);
    expect(indirectEdge?.category).toBe("indirect");
    const biA = layout.edges.find((e) => e.sourceId === 1 && e.targetId === 2)!;
    const biB = layout.edges.find((e) => e.sourceId === 2 && e.targetId === 1)!;
    expect(biA.path).not.toBe(biB.path);
    const bounds = multiHopGraphBounds(layout);
    expect(bounds.width).toBeGreaterThan(400);
    expect(bounds.height).toBeGreaterThan(200);
  });
});
