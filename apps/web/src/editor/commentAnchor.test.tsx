import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx, idKey } from "@jiange/collab";
import { commentSelection, projectCommentAnchors, scrollToCommentAnchor, scrollToCommentThread } from "./commentAnchor";
import { FormatToolbar } from "./FormatToolbar";
import { Editor } from "./Editor";
import { findMatches } from "./findReplace";
import type { Comment } from "@/lib/api";
import type { SyncDoc } from "@/lib/useSyncDoc";

function setup() {
  const doc = new Doc(1);
  const tx = new Tx(doc);
  const first = tx.create("paragraph", null, ROOT);
  tx.insert(first, 0, "甲😀乙丙");
  const second = tx.create("paragraph", first, ROOT);
  tx.insert(second, 0, "另一段");
  return { doc, first, second };
}

describe("comment selection anchors", () => {
  it("uses the same inclusive IDs and quote for forward and reverse selections", () => {
    const { doc, first } = setup();
    const a = { b: first, o: 1 };
    const f = { b: first, o: 3 };
    const forward = commentSelection(doc, { a, f });
    const backward = commentSelection(doc, { a: f, f: a });
    expect(backward).toEqual(forward);
    expect(forward).toEqual({ ok: true, anchor: { block: idKey(first), startChar: idKey(doc.visibleIds(first)[1]), endChar: idKey(doc.visibleIds(first)[2]), quote: "😀乙" } });
  });

  it("handles the first and last character and rejects empty or invalid offsets", () => {
    const { doc, first } = setup();
    const pos = (o: number) => ({ b: first, o });
    expect(commentSelection(doc, { a: pos(0), f: pos(4) })).toEqual({ ok: true, anchor: { block: idKey(first), startChar: idKey(doc.visibleIds(first)[0]), endChar: idKey(doc.visibleIds(first)[3]), quote: "甲😀乙丙" } });
    expect(commentSelection(doc, { a: pos(0), f: pos(0) })).toEqual({ ok: false, reason: "empty" });
    expect(commentSelection(doc, { a: pos(4), f: pos(4) })).toEqual({ ok: false, reason: "empty" });
    expect(commentSelection(doc, { a: pos(-1), f: pos(1) })).toEqual({ ok: false, reason: "invalid" });
    expect(commentSelection(doc, { a: pos(1), f: pos(5) })).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects selections across blocks in either direction", () => {
    const { doc, first, second } = setup();
    const a = { b: first, o: 2 };
    const f = { b: second, o: 1 };
    expect(commentSelection(doc, { a, f })).toEqual({ ok: false, reason: "cross-block" });
    expect(commentSelection(doc, { a: f, f: a })).toEqual({ ok: false, reason: "cross-block" });
  });

  it("does not anchor hidden formula source", () => {
    const { doc, first } = setup();
    new Tx(doc).setProp(first, "type", "math");
    expect(commentSelection(doc, { a: { b: first, o: 0 }, f: { b: first, o: 1 } })).toEqual({ ok: false, reason: "invalid" });
  });

  it("anchors a single column by character ID and rejects a cross-column selection", () => {
    const doc = new Doc(1), tx = new Tx(doc);
    const columns = tx.create("columns", null, ROOT);
    const left = tx.create("paragraph", null, columns), right = tx.create("paragraph", left, columns);
    tx.insert(left, 0, "前😀目标后"); tx.insert(right, 0, "另一栏");
    const selection = commentSelection(doc, { a: { b: left, o: 1 }, f: { b: left, o: 4 } });
    expect(selection).toEqual({ ok: true, anchor: { block: idKey(left), startChar: idKey(doc.visibleIds(left)[1]), endChar: idKey(doc.visibleIds(left)[3]), quote: "😀目标" } });
    expect(commentSelection(doc, { a: { b: left, o: 1 }, f: { b: right, o: 1 } })).toEqual({ ok: false, reason: "cross-block" });
    const unrelated = tx.create("paragraph", columns, ROOT);
    tx.move(left, null, unrelated);
    expect(commentSelection(doc, { a: { b: left, o: 1 }, f: { b: left, o: 4 } })).toEqual({ ok: false, reason: "invalid" });
    tx.move(left, null, columns);
    // A removed container can leave its child block alive but no longer visible.
    tx.deleteBlock(columns);
    expect(commentSelection(doc, { a: { b: left, o: 1 }, f: { b: left, o: 4 } })).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("comment navigation and column rendering", () => {
  it("preserves all overlapping live threads and gives the selected one precedence", () => {
    const { doc, first } = setup();
    const ids = doc.visibleIds(first);
    const base: Comment = { id: 11, docId: 1, userId: 1, userName: "测试", block: idKey(first), startChar: idKey(ids[1]), endChar: idKey(ids[2]), quote: "😀乙", body: "评论", resolved: false, createdAt: "", updatedAt: "" };
    const overlap = { ...base, id: 12 };
    const resolved = { ...base, id: 13, resolved: true };
    const missing = { ...base, id: 14, endChar: "99:99" };
    const reply = { ...base, id: 15, parentId: 11 };
    const comments = [base, overlap, resolved, missing, reply];
    expect(projectCommentAnchors(doc, first, comments)).toEqual({ flags: [null, 12, 12, null], threadIds: [11, 12], blockThreadIds: [] });
    expect(projectCommentAnchors(doc, first, comments, 11)).toEqual({ flags: [null, 11, 11, null], threadIds: [11, 12], blockThreadIds: [] });
    new Tx(doc).delete(first, 1, 2);
    expect(projectCommentAnchors(doc, first, comments, 11)).toEqual({ flags: undefined, threadIds: [], blockThreadIds: [] });
  });

  it("scrolls to a rendered anchor and ignores missing or invalid threads", () => {
    const scrollIntoView = vi.fn();
    const querySelector = vi.fn((selector: string) => selector === '[data-comment-anchor="11"]' ? { scrollIntoView } : null);
    const container = { querySelector } as unknown as ParentNode;
    expect(scrollToCommentAnchor(container, 11)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest", behavior: "smooth" });
    expect(scrollToCommentAnchor(container, 12)).toBe(false);
    expect(scrollToCommentAnchor(container, NaN)).toBe(false);
    expect(scrollToCommentAnchor(null, 11)).toBe(false);
  });

  it("scrolls a selected thread into view in the comment drawer", () => {
    const scrollIntoView = vi.fn();
    const querySelector = vi.fn((selector: string) => selector === '[data-thread="11"]' ? { scrollIntoView } : null);
    const container = { querySelector } as unknown as ParentNode;
    expect(scrollToCommentThread(container, 11)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(scrollToCommentThread(container, 12)).toBe(false);
    expect(scrollToCommentThread(container, -1)).toBe(false);
  });

  it("shows unresolved column anchors, active highlight and search without altering content", () => {
    const doc = new Doc(1), tx = new Tx(doc);
    const columns = tx.create("columns", null, ROOT);
    const left = tx.create("paragraph", null, columns), right = tx.create("paragraph", left, columns);
    tx.insert(left, 0, "前😀目标后"); tx.insert(right, 0, "另一栏");
    tx.format(left, 1, 4, "bold", "true");
    const ids = doc.visibleIds(left);
    const comment: Comment = { id: 11, docId: 1, userId: 1, userName: "测试", block: idKey(left), startChar: idKey(ids[1]), endChar: idKey(ids[3]), quote: "😀目标", body: "评论", resolved: false, createdAt: "", updatedAt: "" };
    const matches = findMatches(doc, "目标");
    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const html = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} comments={[comment]} activeThread={11} findMatches={matches} activeFindMatch={matches[0]} />);
    expect(html).toContain(`data-column="${idKey(left)}"`);
    expect(html).toContain('data-comment-anchor="11"');
    expect(html).toContain('data-comment-bubble');
    expect(html).toContain('bg-[#FBDC8D]');
    expect(html).toContain('data-find-active="true"');
    expect(html.replace(/<[^>]*>/g, "")).toContain("前😀目标后");
    expect(doc.text(left)).toBe("前😀目标后");
    const overlap = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} comments={[comment, { ...comment, id: 12 }]} activeThread={11} />);
    expect(overlap).toContain('data-comment-anchor="11"');
    expect(overlap).toContain('title="2 条评论"');
    const resolved = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} comments={[{ ...comment, resolved: true }]} />);
    expect(resolved).not.toContain('data-comment-anchor="11"');
    // A late deletion of an endpoint must not point to a different character.
    tx.delete(left, 1, 2);
    const stale = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} comments={[comment]} />);
    expect(stale).not.toContain('data-comment-anchor="11"');
  });

  it.each(["paragraph", "code", "callout"])("renders comment anchors in %s text", (type) => {
    const doc = new Doc(1), tx = new Tx(doc);
    const block = tx.create(type, null, ROOT);
    tx.insert(block, 0, "前目标后");
    const ids = doc.visibleIds(block);
    const comment: Comment = { id: 21, docId: 1, userId: 1, userName: "测试", block: idKey(block), startChar: idKey(ids[1]), endChar: idKey(ids[2]), quote: "目标", body: "评论", resolved: false, createdAt: "", updatedAt: "" };
    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const html = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} comments={[comment]} />);
    expect(html).toContain('data-comment-anchor="21"');
    expect(html.replace(/<[^>]*>/g, "")).toContain("前目标后");
  });
});

describe("selection toolbar permissions", () => {
  const props = { x: 0, y: 0, marks: {}, blockType: "paragraph", onMark: vi.fn(), onLink: vi.fn(), onType: vi.fn() };
  it("shows comment but no formatting actions in read-only mode", () => {
    const html = renderToStaticMarkup(<FormatToolbar {...props} readOnly onComment={() => {}} />);
    expect(html).toContain('aria-label="评论"');
    expect(html).not.toContain('aria-label="加粗"');
    expect(html).not.toContain('title="文字颜色"');
    expect(html).not.toContain('title="链接"');
  });
  it("does not show comment when no callback is supplied", () => {
    const html = renderToStaticMarkup(<FormatToolbar {...props} />);
    expect(html).not.toContain('aria-label="评论"');
    expect(html).toContain('aria-label="加粗"');
  });
});
