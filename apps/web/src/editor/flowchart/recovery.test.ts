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
});
