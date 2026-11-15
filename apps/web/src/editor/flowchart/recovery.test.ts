import { describe, expect, it } from "vitest";
import { describeUnappliedFlows } from "./recovery";
import type { FlowGraph } from "./model";

const before: FlowGraph = { theme: "feishu", nodes: [{ id: "a", shape: "rect", text: "原文", x: 10, y: 20, w: 100, h: 50 }], edges: [] };

describe("flowchart unapplied content", () => {
  it("shows the user's text and geometry without exposing the entire graph as the main view", () => {
    const proposed = { ...before, nodes: [{ ...before.nodes[0], text: "我的输入", x: 40 }] };
    const text = describeUnappliedFlows([{ before, proposed, conflicts: ["fc.n.a"] }]);
    expect(text).toContain("我的输入");
    expect(text).toContain("位置 40, 20");
    expect(text).not.toContain('"nodes"');
  });
  it("describes deleted nodes and permission changes", () => {
    const proposed = { ...before, nodes: [] };
    expect(describeUnappliedFlows([{ before, proposed, conflicts: ["fc.n.a"] }])).toContain("删除矩形");
    expect(describeUnappliedFlows([{ before, proposed, conflicts: ["permission"] }])).toContain("删除矩形");
  });
  it("preserves the intended node style in conflict and permission recovery", () => {
    const original: FlowGraph = { ...before, mind: [{ id: "m", parent: null, order: 0, text: "主题", x: 0, y: 0 }] };
    const proposed: FlowGraph = { ...original, mindStyles: { m: { shape: "oval", size: 24 } } };
    for (const conflict of ["fc.ms.m", "permission"]) {
      const text = describeUnappliedFlows([{ before: original, proposed, conflicts: [conflict] }]);
      expect(text).toContain("修改思维导图节点样式：主题");
      expect(text).toContain('"size":24');
    }
  });
});
