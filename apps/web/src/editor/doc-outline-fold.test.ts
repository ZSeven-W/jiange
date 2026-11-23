import { describe, expect, it } from "vitest";
import { computeFoldedBlocks, computeHeadingNumbers } from "./doc-outline-fold";

describe("doc-outline-fold", () => {
  it("computes normalized hierarchical Feishu heading numbers", () => {
    const map = computeHeadingNumbers([
      { id: "a", type: "h2", text: "背景" },
      { id: "b", type: "paragraph", text: "正文" },
      { id: "c", type: "h3", text: "现状" },
      { id: "d", type: "h3", text: "目标" },
      { id: "e", type: "h2", text: "方案" },
      { id: "f", type: "h4", text: "深层细节" },
      { id: "g", type: "h2", text: "   " }, // blank headings skipped
    ]);
    expect(map.get("a")).toBe("1");
    expect(map.get("c")).toBe("1.1");
    expect(map.get("d")).toBe("1.2");
    expect(map.get("e")).toBe("2");
    expect(map.get("f")).toBe("2.0.1");
    expect(map.has("g")).toBe(false);
  });

  it("folds subordinate blocks under collapsed headings and indented toggle items", () => {
    const blocks = [
      { id: "h1", type: "h1", indent: 0 },
      { id: "p1", type: "paragraph", indent: 0 },
      { id: "h2", type: "h2", indent: 0 },
      { id: "p2", type: "paragraph", indent: 0 },
      { id: "h1b", type: "h1", indent: 0 },
      { id: "t1", type: "toggle", indent: 0 },
      { id: "tp1", type: "paragraph", indent: 1 },
      { id: "tp2", type: "bullet", indent: 2 },
      { id: "after", type: "paragraph", indent: 0 },
    ];
    const state = computeFoldedBlocks(blocks, new Set(["h1", "t1"]));
    expect([...state.hidden]).toEqual(["p1", "h2", "p2", "tp1", "tp2"]);
    expect(state.hiddenCounts.get("h1")).toBe(3);
    expect(state.hiddenCounts.get("t1")).toBe(2);
    expect(state.hasBody.has("h1")).toBe(true);
    expect(state.hasBody.has("t1")).toBe(true);
    expect(state.hidden.has("h1b")).toBe(false);
    expect(state.hidden.has("after")).toBe(false);
  });
});
