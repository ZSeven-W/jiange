import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, idKey } from "@jiange/collab";
import { blockCommentAnchor, projectCommentAnchors, scrollToCommentAnchor } from "./commentAnchor";
import { blockAbilities, readOnlyBlockAbilities } from "./Editor";
import type { Comment } from "@/lib/api";

function setup() {
  const doc = new Doc(1);
  const tx = new Tx(doc);
  const p = tx.create("paragraph", null, ROOT);
  tx.insert(p, 0, "正文");
  const img = tx.create("image", p, ROOT, { fileId: "3", name: "a.png", caption: "架构图" });
  const hr = tx.create("divider", img, ROOT);
  return { doc, p, img, hr };
}
const c = (id: number, block: string, extra: Partial<Comment> = {}) => ({ id, docId: 1, userId: 1, userName: "k", block, startChar: "", endChar: "", quote: "", body: "x", resolved: false, createdAt: "", updatedAt: "", ...extra }) as Comment;

describe("block-level comments", () => {
  it("anchors images to the whole block with a labelled quote", () => {
    const { doc, img, hr, p } = setup();
    expect(blockCommentAnchor(doc, img)).toEqual({ ok: true, anchor: { block: idKey(img), startChar: "", endChar: "", quote: "[图片] 架构图" } });
    expect(blockCommentAnchor(doc, hr).ok).toBe(false);
    expect(blockCommentAnchor(doc, p).ok).toBe(false);
  });
  it("projects block threads without character flags and skips resolved ones", () => {
    const { doc, img } = setup();
    const k = idKey(img);
    expect(projectCommentAnchors(doc, img, [c(5, k), c(6, k, { resolved: true }), c(7, k, { parentId: 5 })])).toEqual({ flags: undefined, threadIds: [5], blockThreadIds: [5] });
  });
  it("offers 评论 in the block menu for non-text blocks", () => {
    expect(blockAbilities("image", false, true, true).comment).toBe(true);
    expect(blockAbilities("divider", false, true, true).comment).toBe(false);
    expect(readOnlyBlockAbilities("table", true, true).comment).toBe(true);
  });
  it("scrolls to a block-level thread", () => {
    let scrolled = false;
    const el = { scrollIntoView: () => { scrolled = true; } };
    const container = { querySelector: (q: string) => (q.includes("data-comment-block~=") ? el : null) } as unknown as ParentNode;
    expect(scrollToCommentAnchor(container, 5)).toBe(true);
    expect(scrolled).toBe(true);
  });
});
