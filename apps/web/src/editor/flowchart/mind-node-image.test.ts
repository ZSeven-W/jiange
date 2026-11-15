import { describe, expect, it } from "vitest";
import { layoutMindTopics, type MindTopic } from "./mindmap";
import { mindNodeImageBounds } from "./mind-node-image";

const topics: MindTopic[] = [
  { id: "root", parent: null, order: 0, text: "主题", x: 10, y: 20 },
  { id: "child", parent: "root", order: 0, text: "需求" },
  { id: "grandchild", parent: "child", order: 0, text: "子节点" },
];

describe("mind node image", () => {
  it("centres the selected node at double resolution without including its child", () => {
    const node = layoutMindTopics(topics).find((item) => item.topic.id === "child")!;
    const child = layoutMindTopics(topics).find((item) => item.topic.id === "grandchild")!;
    const bounds = mindNodeImageBounds(topics, new Set(), {}, "child")!;
    expect(bounds.pixels).toBe(bounds.side * 2);
    expect(bounds.x + bounds.side / 2).toBe(node.x + node.w / 2);
    expect(bounds.y + bounds.side / 2).toBe(node.y + node.h / 2);
    expect(child.x).toBeGreaterThan(bounds.x + bounds.side);
  });
  it("does not export a hidden or missing node and keeps large text inside", () => {
    expect(mindNodeImageBounds(topics, new Set(["root"]), {}, "child")).toBeNull();
    expect(mindNodeImageBounds(topics, new Set(), {}, "missing")).toBeNull();
    const node = layoutMindTopics(topics, new Set(), { child: { size: 96 } }).find((item) => item.topic.id === "child")!;
    const bounds = mindNodeImageBounds(topics, new Set(), { child: { size: 96 } }, "child")!;
    expect(bounds.side).toBeGreaterThan(node.w);
    expect(bounds.side).toBeGreaterThan(node.h);
    expect(bounds.pixels).toBeLessThanOrEqual(2048);
  });
});
