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
  it("describes unapplied node paint changes", () => {
    const original: FlowGraph = { ...before, mind: [{ id: "m", parent: null, order: 0, text: "主题", x: 0, y: 0 }] };
    const proposed: FlowGraph = { ...original, mindPaints: { m: { stroke: "#e86d68", line: "dashed" } } };
    for (const conflict of ["fc.mp.m", "permission"]) {
      const text = describeUnappliedFlows([{ before: original, proposed, conflicts: [conflict] }]);
      expect(text).toContain("修改思维导图节点配色：主题"); expect(text).toContain('"line":"dashed"');
    }
  });
  it("shows the intended parent and root position for unapplied moves", () => {
    const original: FlowGraph = { ...before, mind: [{ id: "r", parent: null, order: 0, text: "根", x: 0, y: 0 }, { id: "a", parent: "r", order: 0, text: "需求" }, { id: "b", parent: "r", order: 1, text: "交付" }] };
    const proposed: FlowGraph = { ...original, mind: [{ ...original.mind![0], x: 50, y: 30 }, original.mind![1], { ...original.mind![2], parent: "a" }] };
    const text = describeUnappliedFlows([{ before: original, proposed, conflicts: ["fc.m.r", "fc.m.b"] }]);
    expect(text).toContain("目标父节点：需求"); expect(text).toContain("目标位置：50, 30");
  });
});
