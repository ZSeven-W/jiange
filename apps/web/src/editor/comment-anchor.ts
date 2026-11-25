import { eqId, idKey, ROOT, type Doc, type OpId } from "@zseven-w/collab";
import { isFlowCommentAnchor } from "@zseven-w/whiteboard-sdk/comment-anchor";
import type { Comment } from "@/lib/api";
import { bodyBlocks, cmpPos, orderMap, TEXTLESS, type Sel } from "./model";

/** Non-text blocks that take a whole-block comment (Feishu: 评论图片/附件/表格). */
export const COMMENTABLE_BLOCKS = new Set([...TEXTLESS].filter((type) => type !== "divider" && type !== "columns"));

const isBlockComment = (c: Pick<Comment, "startChar" | "endChar">) =>
  (!c.startChar && !c.endChar) || isFlowCommentAnchor(c.startChar);

/**
 * Cross-paragraph text comment anchors encode the ending block and char ID in
 * `endChar` as `<endBlockId>|<endCharId>` (fits comfortably inside the 64-rune
 * server anchor limit while staying 100% backward-compatible with single-block
 * and canvas comment anchors).
 */
export function parseCrossBlockEndChar(endChar: string): { endBlock: string; endChar: string } | null {
  const sep = endChar.indexOf("|");
  if (sep <= 0 || sep >= endChar.length - 1) return null;
  return { endBlock: endChar.slice(0, sep), endChar: endChar.slice(sep + 1) };
}

export function isCrossBlockComment(c: Pick<Comment, "startChar" | "endChar">): boolean {
  return !isBlockComment(c) && parseCrossBlockEndChar(c.endChar) !== null;
}

const BLOCK_LABEL: Record<string, string> = {
  image: "图片",
  file: "附件",
  table: "表格",
  video: "视频",
  audio: "音频",
  poll: "投票",
  countdown: "倒计时",
  tabs: "标签页",
  bookmark: "网页卡片",
  math: "公式",
  diagram: "图表",
  flowchart: "流程图",
  synced: "同步块",
  subpages: "子页面列表",
  embed: "嵌入资源",
  reminder: "日期提醒",
};

/** Anchor a comment to a whole non-text block, without character IDs. */
export function blockCommentAnchor(doc: Doc, block: OpId): CommentSelection {
  if (!doc.hasBlock(block)) return { ok: false, reason: "invalid" };
  const info = doc.blockInfo(block);
  if (!COMMENTABLE_BLOCKS.has(info.type)) return { ok: false, reason: "invalid" };
  const blocks = doc.view().blocks;
  const selected = blocks.find((b) => b.id === idKey(block));
  if (!selected) return { ok: false, reason: "invalid" };
  if (selected.parent !== idKey(ROOT)) {
    const parent = blocks.find((b) => b.id === selected.parent);
    if (!parent || parent.parent !== idKey(ROOT) || parent.type !== "columns") return { ok: false, reason: "invalid" };
  }
  const label = BLOCK_LABEL[info.type] ?? "块";
  const name = info.props.caption || info.props.title || info.props.question || info.props.label || info.props.name || "";
  return { ok: true, anchor: { block: idKey(block), startChar: "", endChar: "", quote: (name ? `[${label}] ${name}` : `[${label}]`).slice(0, 200) } };
}

export type CommentSelection =
  | { ok: true; anchor: { block: string; startChar: string; endChar: string; quote: string } }
  | { ok: false; reason: "cross-block" | "empty" | "invalid" };

/** Project only live unresolved thread anchors; retain all IDs even when ranges overlap. */
export function projectCommentAnchors(doc: Doc, block: OpId, comments: readonly Comment[], activeThread: number | null = null): { flags: (number | null)[] | undefined; threadIds: number[]; blockThreadIds: number[] } {
  const blockKey = idKey(block);
  const liveRoots = comments.filter((c) => !c.resolved && !c.parentId);
  const blockType = doc.hasBlock(block) ? doc.blockInfo(block).type : "";
  // Block-level anchors (images, files, tables, embeds, reminders…) carry no character IDs.
  const blockThreadIds = COMMENTABLE_BLOCKS.has(blockType)
    ? liveRoots.filter((c) => c.block === blockKey && isBlockComment(c)).map((c) => c.id)
    : [];
  const textComments = liveRoots.filter((c) => !isBlockComment(c));
  const singleMine = textComments.filter((c) => c.block === blockKey && !parseCrossBlockEndChar(c.endChar));
  const crossComments = textComments.filter((c) => parseCrossBlockEndChar(c.endChar) !== null);
  if (!singleMine.length && (!crossComments.length || TEXTLESS.has(blockType))) {
    return { flags: undefined, threadIds: blockThreadIds, blockThreadIds };
  }
  const ids = doc.visibleIds(block);
  const positions = new Map(ids.map((id, index) => [idKey(id), index]));
  const ranges: { id: number; start: number; end: number; badge: boolean }[] = [];
  for (const comment of singleMine) {
    const start = positions.get(comment.startChar), end = positions.get(comment.endChar);
    if (start === undefined || end === undefined) continue;
    ranges.push({ id: comment.id, start: Math.min(start, end), end: Math.max(start, end), badge: true });
  }
  if (crossComments.length && !TEXTLESS.has(blockType)) {
    const body = bodyBlocks(doc);
    const ord = orderMap(body);
    const curIdx = ord.get(blockKey);
    if (curIdx !== undefined && ids.length > 0) {
      for (const comment of crossComments) {
        const cross = parseCrossBlockEndChar(comment.endChar);
        if (!cross) continue;
        const startBlockIdx = ord.get(comment.block);
        const endBlockIdx = ord.get(cross.endBlock);
        if (startBlockIdx === undefined || endBlockIdx === undefined || startBlockIdx >= endBlockIdx) continue;
        if (curIdx < startBlockIdx || curIdx > endBlockIdx) continue;
        const startBlock = body[startBlockIdx];
        const endBlock = body[endBlockIdx];
        if (TEXTLESS.has(doc.blockInfo(startBlock).type) || TEXTLESS.has(doc.blockInfo(endBlock).type)) continue;
        const startPos = curIdx === startBlockIdx
          ? positions.get(comment.startChar)
          : doc.visibleIds(startBlock).findIndex((id) => idKey(id) === comment.startChar);
        const endPos = curIdx === endBlockIdx
          ? positions.get(cross.endChar)
          : doc.visibleIds(endBlock).findIndex((id) => idKey(id) === cross.endChar);
        if (startPos === undefined || startPos < 0 || endPos === undefined || endPos < 0) continue;
        const rangeStart = curIdx === startBlockIdx ? startPos : 0;
        const rangeEnd = curIdx === endBlockIdx ? endPos : ids.length - 1;
        if (rangeStart <= rangeEnd && rangeStart < ids.length && rangeEnd >= 0) {
          ranges.push({ id: comment.id, start: rangeStart, end: Math.min(rangeEnd, ids.length - 1), badge: curIdx === startBlockIdx });
        }
      }
    }
  }
  if (!ranges.length) return { flags: undefined, threadIds: blockThreadIds, blockThreadIds };
  const flags: (number | null)[] = new Array(ids.length).fill(null);
  for (const range of ranges) for (let i = range.start; i <= range.end; i++) flags[i] = range.id;
  // Overlapping comments remain discoverable and selectable via their drawer
  // entries: the selected thread wins its own range on the next render.
  for (const range of ranges) if (range.id === activeThread) for (let i = range.start; i <= range.end; i++) flags[i] = range.id;
  return { flags, threadIds: [...new Set([...ranges.filter((r) => r.badge).map(({ id }) => id), ...blockThreadIds])], blockThreadIds };
}

/** Navigate only to a currently rendered anchor, never to stale quoted text. */
export function scrollToCommentAnchor(container: ParentNode | null, threadId: number): boolean {
  if (!container || !Number.isSafeInteger(threadId) || threadId < 0) return false;
  const anchor = container.querySelector<HTMLElement>(`[data-comment-anchor="${threadId}"]`) ?? container.querySelector<HTMLElement>(`[data-comment-block~="${threadId}"]`);
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

/** The comment API stores one block and inclusive first/last character IDs, or `<endBlock>|<endChar>` for cross-paragraph selections. */
export function commentSelection(doc: Doc, sel: Sel): CommentSelection {
  if (!doc.hasBlock(sel.a.b) || !doc.hasBlock(sel.f.b)) return { ok: false, reason: "invalid" };
  // A child can survive deletion or a remote move of its parent. Mirror the
  // body renderer: top-level blocks and direct children of top-level columns.
  const blocks = doc.view().blocks;
  if (eqId(sel.a.b, sel.f.b)) {
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
  const blockA = blocks.find((block) => block.id === idKey(sel.a.b));
  const blockF = blocks.find((block) => block.id === idKey(sel.f.b));
  if (!blockA || !blockF) return { ok: false, reason: "invalid" };
  // Cross-column selections remain unsupported; top-level body selections span cleanly.
  if (blockA.parent !== idKey(ROOT) || blockF.parent !== idKey(ROOT)) {
    return { ok: false, reason: "cross-block" };
  }
  const body = bodyBlocks(doc);
  const ord = orderMap(body);
  const idxA = ord.get(idKey(sel.a.b));
  const idxF = ord.get(idKey(sel.f.b));
  if (idxA === undefined || idxF === undefined) return { ok: false, reason: "invalid" };
  const [start, end] = cmpPos(ord, sel.a, sel.f) <= 0 ? [sel.a, sel.f] : [sel.f, sel.a];
  const startIdx = ord.get(idKey(start.b))!;
  const endIdx = ord.get(idKey(end.b))!;
  const startLen = TEXTLESS.has(doc.blockInfo(start.b).type) ? 0 : doc.visibleIds(start.b).length;
  const endLen = TEXTLESS.has(doc.blockInfo(end.b).type) ? 0 : doc.visibleIds(end.b).length;
  if (!Number.isInteger(start.o) || !Number.isInteger(end.o) || start.o < 0 || start.o > startLen || end.o < 0 || end.o > endLen) {
    return { ok: false, reason: "invalid" };
  }
  let first: { block: OpId; charId: OpId } | null = null;
  let last: { block: OpId; charId: OpId } | null = null;
  const quoteParts: string[] = [];
  for (const b of body.slice(startIdx, endIdx + 1)) {
    if (TEXTLESS.has(doc.blockInfo(b).type)) continue;
    const ids = doc.visibleIds(b);
    const from = eqId(b, start.b) ? start.o : 0;
    const to = eqId(b, end.b) ? end.o : ids.length;
    if (to <= from) continue;
    if (!first) first = { block: b, charId: ids[from] };
    last = { block: b, charId: ids[to - 1] };
    quoteParts.push(doc.richChars(b).slice(from, to).map((c) => c.ch).join(""));
  }
  if (!first || !last) return { ok: false, reason: "empty" };
  const quote = [...quoteParts.join("\n")].slice(0, 200).join("");
  if (eqId(first.block, last.block)) {
    return {
      ok: true,
      anchor: {
        block: idKey(first.block),
        startChar: idKey(first.charId),
        endChar: idKey(last.charId),
        quote,
      },
    };
  }
  return {
    ok: true,
    anchor: {
      block: idKey(first.block),
      startChar: idKey(first.charId),
      endChar: `${idKey(last.block)}|${idKey(last.charId)}`,
      quote,
    },
  };
}
