import { eqId, idKey, type Doc, type OpId, type Tx } from "@jiange/collab";
import { bodyBlocks } from "./model";

// Only blocks whose text is visibly and directly editable by the body editor.
// The title has a separate editor; table cells and column children have their
// own representations. In particular, math/diagram text is hidden source.
const SEARCHABLE_TYPES = new Set(["paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "bullet", "ordered", "todo", "quote", "code", "callout"]);

/** Whether a block's source is visible, editable text in the body editor. */
export const isSearchableBlockType = (type: string): boolean => SEARCHABLE_TYPES.has(type);

export interface FindMatch {
  /** Ties the snapshot to this live replica; block/character IDs are not document IDs. */
  doc: Doc;
  block: OpId;
  /** Original code-point offsets, useful for displaying the initial selection. */
  start: number;
  end: number;
  /** Visible character IDs and exact source captured at search time. */
  ids: OpId[];
  text: string;
}

export interface FindOptions {
  /** Defaults to false. Uses JavaScript Unicode simple case folding. */
  caseSensitive?: boolean;
}

function literalRegExp(query: string, caseSensitive: boolean): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "gu" : "giu");
}

/**
 * Finds non-overlapping matches in current top-level editable body blocks.
 * Offsets are Unicode code points, never UTF-16 indices. Unicode's simple
 * case folding is used without normalization or length-changing full folding.
 * Inline formula marks form boundaries, since their source is not visible text.
 */
export function findMatches(doc: Doc, query: string, options: FindOptions = {}): FindMatch[] {
  if (!query) return [];
  const result: FindMatch[] = [];
  const pattern = literalRegExp(query, !!options.caseSensitive);
  for (const block of bodyBlocks(doc)) {
    if (!isSearchableBlockType(doc.blockInfo(block).type)) continue;
    const chars = doc.richChars(block);
    const ids = doc.visibleIds(block);
    let from = 0;
    while (from < chars.length) {
      // An inline formula's model characters are source, not its visible glyphs.
      while (from < chars.length && chars[from].marks.math) from++;
      let to = from;
      while (to < chars.length && !chars[to].marks.math) to++;
      if (to === from) break;
      const boundaries = new Map<number, number>([[0, from]]);
      let text = "";
      for (let i = from; i < to; i++) {
        text += chars[i].ch;
        boundaries.set(text.length, i + 1);
      }
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const start = boundaries.get(match.index!);
        const end = boundaries.get(match.index! + match[0].length);
        // Ignore a match that would start/end inside a surrogate pair.
        if (start === undefined || end === undefined || start === end) continue;
        result.push({ doc, block, start, end, ids: ids.slice(start, end).map((id) => ({ ...id })), text: match[0] });
      }
      from = to;
    }
  }
  return result;
}

/** Resolve a snapshot only if the original visible characters still form the same range. */
export function resolveFindMatch(doc: Doc, match: FindMatch): { start: number; end: number } | null {
  if (doc !== match.doc || !match.ids.length || !doc.hasBlock(match.block)) return null;
  if (!isSearchableBlockType(doc.blockInfo(match.block).type) || !bodyBlocks(doc).some((block) => eqId(block, match.block))) return null;
  const ids = doc.visibleIds(match.block);
  const start = ids.findIndex((id) => eqId(id, match.ids[0]));
  const end = start + match.ids.length;
  if (start < 0 || end > ids.length || match.ids.some((id, i) => !eqId(id, ids[start + i]))) return null;
  const chars = doc.richChars(match.block).slice(start, end);
  if (chars.some((char) => !!char.marks.math) || chars.map((char) => char.ch).join("") !== match.text) return null;
  return { start, end };
}

function sharedMarks(marks: Record<string, string>[]): Record<string, string> {
  const common = { ...(marks[0] ?? {}) };
  for (const key of Object.keys(common)) {
    // Mention IDs and inline-math source carry semantics tied to the old text.
    if (key === "mention" || key === "math" || marks.some((m) => m[key] !== common[key])) delete common[key];
  }
  return common;
}

/**
 * Replaces snapshots from the end of the current document towards the start.
 * All operations go into the caller's one Tx for one undo step. Stale, moved
 * outside the body, overlapping or wrong-document snapshots are skipped.
 * Remote inserts arriving later are not deleted: Tx deletes only captured IDs.
 * This function is synchronous: it validates one snapshot of each affected
 * block before mutating any block, so asynchronous remote events cannot land
 * between that validation and application. Non-overlapping ranges are then
 * applied backwards, keeping their original offsets valid.
 */
export function replaceMatches(tx: Tx, matches: readonly FindMatch[], replacement: string): { replaced: number; skipped: number } {
  const doc = tx.doc;
  const order = new Map(bodyBlocks(doc).map((block, i) => [idKey(block), i]));
  type BlockSnapshot = { ids: OpId[]; positions: Map<string, number>; chars: ReturnType<Doc["richChars"]> };
  const snapshots = new Map<string, BlockSnapshot | null>();
  const planned: { match: FindMatch; start: number; end: number; marks: Record<string, string>; order: number }[] = [];
  let skipped = 0;
  for (const match of matches) {
    const key = idKey(match.block);
    const blockOrder = order.get(key);
    if (match.doc !== doc || !match.ids.length || blockOrder === undefined) { skipped++; continue; }
    if (!snapshots.has(key)) {
      if (!doc.hasBlock(match.block) || !isSearchableBlockType(doc.blockInfo(match.block).type)) snapshots.set(key, null);
      else {
        const ids = doc.visibleIds(match.block);
        snapshots.set(key, { ids, positions: new Map(ids.map((id, i) => [idKey(id), i])), chars: doc.richChars(match.block) });
      }
    }
    const state = snapshots.get(key);
    if (!state) { skipped++; continue; }
    const start = state.positions.get(idKey(match.ids[0]));
    if (start === undefined || match.ids.some((id, i) => !state.ids[start + i] || !eqId(id, state.ids[start + i]))) { skipped++; continue; }
    const end = start + match.ids.length;
    const chars = state.chars.slice(start, end);
    if (chars.some((char) => !!char.marks.math) || chars.map((char) => char.ch).join("") !== match.text) { skipped++; continue; }
    planned.push({ match, start, end, marks: sharedMarks(chars.map((char) => char.marks)), order: blockOrder });
  }
  planned.sort((a, b) => {
    return b.order - a.order || b.start - a.start || b.end - a.end;
  });
  let replaced = 0;
  let previousOrder = -1;
  let previousStart = Infinity;
  for (const { match, start, end, marks, order: blockOrder } of planned) {
    if (blockOrder !== previousOrder) { previousOrder = blockOrder; previousStart = Infinity; }
    if (end > previousStart) { skipped++; continue; }
    previousStart = start;
    // Identical replacement is a logical success, but needs no CRDT ops.
    if (replacement !== match.text) {
      tx.delete(match.block, start, end);
      if (replacement) tx.insert(match.block, start, replacement, marks);
    }
    replaced++;
  }
  return { replaced, skipped };
}
