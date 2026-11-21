import { describe, expect, it } from "vitest";
import {
  encodeFlowCommentAnchor,
  isFlowCommentAnchor,
  parseFlowCommentAnchor,
  resolveFlowCommentPosition,
} from "../src/comment-anchor.js";
import type { FlowGraph } from "../src/model.js";

describe("whiteboard comment anchor codec and resolver", () => {
  const graph: FlowGraph = {
    theme: "feishu",
    nodes: [{ id: "n_box", shape: "rect", text: "核心模块", x: 120, y: 80, w: 160, h: 70 }],
    edges: [],
    mind: [
      { id: "m_root", parent: null, order: 0, text: "中心主题", x: 400, y: 200 },
      { id: "m_child", parent: "m_root", order: 1000, text: "子分支" },
    ],
  };

  it("round-trips node, mindmap topic, and free canvas point anchors within 64 chars", () => {
    const nodeEnc = encodeFlowCommentAnchor({ kind: "node", targetId: "n_box", x: 280, y: 80 });
    expect(nodeEnc).toEqual({ startChar: "fc:n:n_box", endChar: "280,80" });
    expect(isFlowCommentAnchor(nodeEnc.startChar)).toBe(true);
    expect(nodeEnc.startChar.length).toBeLessThanOrEqual(64);
    expect(parseFlowCommentAnchor(nodeEnc.startChar, nodeEnc.endChar)).toEqual({
      kind: "node",
      targetId: "n_box",
      x: 280,
      y: 80,
    });

    const mindEnc = encodeFlowCommentAnchor({ kind: "mind", targetId: "m_child", x: 520, y: 210 });
    expect(mindEnc).toEqual({ startChar: "fc:m:m_child", endChar: "520,210" });
    expect(parseFlowCommentAnchor(mindEnc.startChar, mindEnc.endChar)).toEqual({
      kind: "mind",
      targetId: "m_child",
      x: 520,
      y: 210,
    });

    const ptEnc = encodeFlowCommentAnchor({ kind: "point", x: -120.4, y: 345.7 });
    expect(ptEnc).toEqual({ startChar: "fc:p:-120,346", endChar: "-120,346" });
    expect(parseFlowCommentAnchor(ptEnc.startChar, ptEnc.endChar)).toEqual({
      kind: "point",
      x: -120,
      y: 346,
    });
  });

  it("tracks moved nodes & live mindmap positions and falls back cleanly when orphaned", () => {
    const movedGraph: FlowGraph = {
      ...graph,
      nodes: [{ ...graph.nodes[0], x: 500, y: 300 }],
    };
    const liveNodePos = resolveFlowCommentPosition({ kind: "node", targetId: "n_box", x: 280, y: 80 }, movedGraph);
    expect(liveNodePos).toEqual({ x: 660, y: 300, orphaned: false });

    const orphanNodePos = resolveFlowCommentPosition({ kind: "node", targetId: "n_deleted", x: 280, y: 80 }, movedGraph);
    expect(orphanNodePos).toEqual({ x: 280, y: 80, orphaned: true });

    const liveMindPos = resolveFlowCommentPosition({ kind: "mind", targetId: "m_child", x: 0, y: 0 }, graph);
    expect(liveMindPos.orphaned).toBe(false);
    expect(liveMindPos.x).toBeGreaterThan(400);

    const ptPos = resolveFlowCommentPosition({ kind: "point", x: 99, y: 88 }, graph);
    expect(ptPos).toEqual({ x: 99, y: 88, orphaned: false });
  });

  it("handles invalid coordinates, malformed anchors, unknown prefixes, and orphaned/collapsed mind topics", () => {
    expect(isFlowCommentAnchor(undefined)).toBe(false);
    expect(isFlowCommentAnchor("other:1")).toBe(false);

    // Non-finite coords clamp to 0; invalid target ids fall back to point anchor
    expect(encodeFlowCommentAnchor({ kind: "point", x: Number.NaN, y: Infinity })).toEqual({
      startChar: "fc:p:0,0",
      endChar: "0,0",
    });
    expect(encodeFlowCommentAnchor({ kind: "node", targetId: "bad id!", x: 25000, y: -25000 })).toEqual({
      startChar: "fc:p:20000,-20000",
      endChar: "20000,-20000",
    });
    expect(encodeFlowCommentAnchor({ kind: "mind", targetId: "", x: 10, y: 20 })).toEqual({
      startChar: "fc:p:10,20",
      endChar: "10,20",
    });

    // Parsing malformed / unknown anchors
    expect(parseFlowCommentAnchor("plain", "10,20")).toBeNull();
    expect(parseFlowCommentAnchor("fc:n:bad id!", "10,20")).toBeNull();
    expect(parseFlowCommentAnchor("fc:m:bad id!", "10,20")).toBeNull();
    expect(parseFlowCommentAnchor("fc:x:unknown", "10,20")).toBeNull();
    // Invalid endChar falls back to { x: 0, y: 0 }
    expect(parseFlowCommentAnchor("fc:n:n_box", "not-a-pair")).toEqual({ kind: "node", targetId: "n_box", x: 0, y: 0 });
    expect(parseFlowCommentAnchor("fc:m:m_child", "NaN,10")).toEqual({ kind: "mind", targetId: "m_child", x: 0, y: 0 });
    expect(parseFlowCommentAnchor("fc:m:m_child", "10,Infinity")).toEqual({ kind: "mind", targetId: "m_child", x: 0, y: 0 });
    // Point anchor with bad coord in startChar falls back to endChar
    expect(parseFlowCommentAnchor("fc:p:invalid", "30,40")).toEqual({ kind: "point", x: 30, y: 40 });

    // Orphaned mind topic: missing topic, collapsed parent, or graph without mind topics
    expect(resolveFlowCommentPosition({ kind: "mind", targetId: "m_missing", x: 11, y: 22 }, graph)).toEqual({
      x: 11,
      y: 22,
      orphaned: true,
    });
    expect(
      resolveFlowCommentPosition({ kind: "mind", targetId: "m_child", x: 33, y: 44 }, graph, new Set(["m_root"])),
    ).toEqual({
      x: 33,
      y: 44,
      orphaned: true,
    });
    expect(
      resolveFlowCommentPosition({ kind: "mind", targetId: "m_child", x: 55, y: 66 }, { nodes: [], edges: [], theme: "feishu" }),
    ).toEqual({
      x: 55,
      y: 66,
      orphaned: true,
    });
  });
});
