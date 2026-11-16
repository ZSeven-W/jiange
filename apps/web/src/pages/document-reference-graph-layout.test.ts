import { describe, expect, it } from "vitest";
import { layoutDocumentReferenceGraph, referenceGraphPath } from "./document-reference-graph-layout";

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
});
