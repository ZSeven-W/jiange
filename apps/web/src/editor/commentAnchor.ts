import { eqId, idKey, ROOT, type Doc, type OpId } from "@jiange/collab";
import type { Comment } from "@/lib/api";
import { TEXTLESS, type Sel } from "./model";

export type CommentSelection =
  | { ok: true; anchor: { block: string; startChar: string; endChar: string; quote: string } }
  | { ok: false; reason: "cross-block" | "empty" | "invalid" };

/** Project only live unresolved thread anchors; retain all IDs even when ranges overlap. */
export function projectCommentAnchors(doc: Doc, block: OpId, comments: readonly Comment[], activeThread: number | null = null): { flags: (number | null)[] | undefined; threadIds: number[] } {
  const mine = comments.filter((c) => !c.resolved && !c.parentId && c.block === idKey(block));
  if (!mine.length) return { flags: undefined, threadIds: [] };
  const ids = doc.visibleIds(block);
  const positions = new Map(ids.map((id, index) => [idKey(id), index]));
  const ranges: { id: number; start: number; end: number }[] = [];
  for (const comment of mine) {
    const start = positions.get(comment.startChar), end = positions.get(comment.endChar);
    if (start === undefined || end === undefined) continue;
    ranges.push({ id: comment.id, start: Math.min(start, end), end: Math.max(start, end) });
  }
  if (!ranges.length) return { flags: undefined, threadIds: [] };
  const flags: (number | null)[] = new Array(ids.length).fill(null);
  for (const range of ranges) for (let i = range.start; i <= range.end; i++) flags[i] = range.id;
  // Overlapping comments remain discoverable and selectable via their drawer
  // entries: the selected thread wins its own range on the next render.
  for (const range of ranges) if (range.id === activeThread) for (let i = range.start; i <= range.end; i++) flags[i] = range.id;
  return { flags, threadIds: [...new Set(ranges.map(({ id }) => id))] };
}

/** Navigate only to a currently rendered anchor, never to stale quoted text. */
export function scrollToCommentAnchor(container: ParentNode | null, threadId: number): boolean {
  if (!container || !Number.isSafeInteger(threadId) || threadId < 0) return false;
  const anchor = container.querySelector<HTMLElement>(`[data-comment-anchor="${threadId}"]`);
  if (!anchor) return false;
  anchor.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  return true;
}

/** Locate an opened thread within the comment drawer. */
export function scrollToCommentThread(container: ParentNode | null, threadId: number): boolean {
  if (!container || !Number.isSafeInteger(threadId) || threadId < 0) return false;
  const thread = container.querySelector<HTMLElement>(`[data-thread="${threadId}"]`);
  if (!thread) return false;
  thread.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

/** The comment API stores one block and inclusive first/last character IDs. */
export function commentSelection(doc: Doc, sel: Sel): CommentSelection {
  if (!doc.hasBlock(sel.a.b) || !doc.hasBlock(sel.f.b)) return { ok: false, reason: "invalid" };
  if (!eqId(sel.a.b, sel.f.b)) return { ok: false, reason: "cross-block" };
  // A child can survive deletion or a remote move of its parent. Mirror the
  // body renderer: top-level blocks and direct children of top-level columns.
  const blocks = doc.view().blocks;
  const selected = blocks.find((block) => block.id === idKey(sel.a.b));
  if (!selected) return { ok: false, reason: "invalid" };
  if (selected.parent !== idKey(ROOT)) {
    const parent = blocks.find((block) => block.id === selected.parent);
    if (!parent || parent.parent !== idKey(ROOT) || parent.type !== "columns") return { ok: false, reason: "invalid" };
  }
  if (TEXTLESS.has(doc.blockInfo(sel.a.b).type)) return { ok: false, reason: "invalid" };
  const ids = doc.visibleIds(sel.a.b);
  const start = Math.min(sel.a.o, sel.f.o);
  const end = Math.max(sel.a.o, sel.f.o);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > ids.length) return { ok: false, reason: "invalid" };
  if (start === end) return { ok: false, reason: "empty" };
  return {
    ok: true,
    anchor: {
      block: idKey(sel.a.b),
      startChar: idKey(ids[start]),
      endChar: idKey(ids[end - 1]),
      quote: doc.richChars(sel.a.b).slice(start, end).slice(0, 200).map((c) => c.ch).join(""),
    },
  };
}
