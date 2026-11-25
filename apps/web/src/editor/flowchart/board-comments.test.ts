import { describe, expect, it } from "vitest";
import { Doc, idKey, ROOT, Tx } from "@zseven-w/collab";
import { projectCommentAnchors } from "../comment-anchor";
import { resolveBoardCommentPins } from "./board-comments";
import type { Comment } from "@/lib/api";
import type { FlowGraph } from "./model";

describe("board anchored comments integration", () => {
  it("projects canvas-anchored comments into flowchart block threads and resolves live pin positions", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const block = tx.create("flowchart", null, ROOT);
    const blockKey = idKey(block);

    const comments: Comment[] = [
      {
        id: 11,
        docId: 5,
        userId: 1,
        userName: "Alice",
        block: blockKey,
        startChar: "fc:n:n1",
        endChar: "100,80",
        quote: "[画板] 网关",
        body: "检查限流配置",
        resolved: false,
        createdAt: "2026-11-19T12:00:00Z",
        updatedAt: "2026-11-19T12:00:00Z",
      },
      {
        id: 12,
        docId: 5,
        userId: 2,
        userName: "Bob",
        parentId: 11,
        block: "",
        startChar: "",
        endChar: "",
        quote: "",
        body: "已补充令牌桶",
        resolved: false,
        createdAt: "2026-11-19T12:01:00Z",
        updatedAt: "2026-11-19T12:01:00Z",
      },
      {
        id: 13,
        docId: 5,
        userId: 1,
        userName: "Alice",
        block: blockKey,
        startChar: "fc:p:420,260",
        endChar: "420,260",
        quote: "[画板] 画布 (420, 260)",
        body: "这里补一个缓存层",
        resolved: false,
        createdAt: "2026-11-19T12:02:00Z",
        updatedAt: "2026-11-19T12:02:00Z",
      },
      {
        id: 14,
        docId: 5,
        userId: 1,
        userName: "Alice",
        block: blockKey,
        startChar: "fc:p:10,10",
        endChar: "10,10",
        quote: "[画板] 已解决",
        body: "旧评论",
        resolved: true,
        createdAt: "2026-11-19T11:00:00Z",
        updatedAt: "2026-11-19T11:30:00Z",
      },
    ];

    const projected = projectCommentAnchors(doc, block, comments);
    expect(projected.blockThreadIds).toEqual([11, 13]);
    expect(projected.threadIds).toEqual([11, 13]);

    const graph: FlowGraph = {
      theme: "feishu",
      nodes: [{ id: "n1", shape: "rect", text: "网关", x: 300, y: 120, w: 140, h: 60 }],
      edges: [],
    };
    const pins = resolveBoardCommentPins(comments, graph);
    expect(pins).toHaveLength(2);
    expect(pins[0]).toMatchObject({ index: 1, x: 440, y: 120, orphaned: false });
    expect(pins[0].replies).toHaveLength(1);
    expect(pins[0].replies[0].body).toBe("已补充令牌桶");
    expect(pins[1]).toMatchObject({ index: 2, x: 420, y: 260, orphaned: false });
  });
});
