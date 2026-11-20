import { eqId, idKey, ROOT, type Doc, type OpId, type Tx } from "@jiange/collab";
import { TITLE } from "./model";
import { isDocumentReferenceMarks } from "@/lib/safe-url";

// Body types whose text is visibly and directly editable by the body editor.
// The title is searched separately; table cells have their own representation.
// In particular, math/diagram text is hidden source.
const SEARCHABLE_TYPES = new Set(["paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "bullet", "ordered", "todo", "quote", "code", "callout"]);

/** Whether a block's source is visible, editable text in the body editor. */
export const isSearchableBlockType = (type: string): boolean => SEARCHABLE_TYPES.has(type);

export interface FindMathMatch {
  kind: "block" | "inline";
  /** Inline formula only: original LaTeX source captured from `marks.math`. */
  formula?: string;
  /** Inline formula only: code-point offsets inside `formula`. */
  formulaStart?: number;
  formulaEnd?: number;
  /** Inline formula only: optional `marks.mathId` disambiguator. */
  mathId?: string;
}

export interface FindMatch {
  /** Ties the snapshot to this live replica; block/character IDs are not document IDs. */
  doc: Doc;
  block: OpId;
  /** The visible container at capture time; moving a block invalidates a match. */
  parent: OpId;
  /** Original code-point offsets, useful for displaying the initial selection. */
  start: number;
  end: number;
  /** Visible character IDs and exact source captured at search time. */
  ids: OpId[];
  text: string;
  /** Matches touching a person or document mention can be found, but not replaced. */
  mention?: boolean;
  /** Table text is stored as whole-cell registers rather than character IDs. */
  table?: { row: number; col: number; snapshot: string; cellVersion: string | null };
  /** Formula source match (block `type === "math"` or inline `marks.math`), opt-in via `includeMath`. */
  math?: FindMathMatch;
}

export interface FindOptions {
  /** Defaults to false. Uses JavaScript Unicode simple case folding. */
  caseSensitive?: boolean;
  /** Defaults to false. Includes block formulas (`type === "math"`) and inline formulas (`marks.math`). */
  includeMath?: boolean;
}

/** Partition immutable search results before replacing. Title matches may be
 * selected only by a caller that uses the guarded title-and-directory commit. */
export function planFindReplacement(matches: readonly FindMatch[], active: FindMatch | null, all: boolean, options: { allowTitle?: boolean } = {}): { selected: FindMatch[]; skippedTitles: number; skippedMentions: number } {
  const selected: FindMatch[] = [];
  let skippedTitles = 0, skippedMentions = 0;
  for (const match of all ? matches : active ? [active] : []) {
    if (eqId(match.block, TITLE) && !options.allowTitle) skippedTitles++;
    else if (match.mention) skippedMentions++;
    else selected.push(match);
  }
  return { selected, skippedTitles, skippedMentions };
}

/** Visible title and text blocks in canvas order, with each column at its container's position. */
export function searchableLocations(doc: Doc, options: { includeMath?: boolean } = {}): { block: OpId; parent: OpId }[] {
  const out: { block: OpId; parent: OpId }[] = [];
  const rootKey = idKey(ROOT);
  const columns = new Map<string, OpId>();
  const allowed = (type: string) => isSearchableBlockType(type) || (!!options.includeMath && type === "math");
  const parse = (key: string): OpId => {
    const [client, clock] = key.split(":").map(Number);
    return { client, clock };
  };
  // view() already resolves deleted ancestors/cycles and gives depth-first
  // canvas order. Do not call children() per column: each call rematerializes
  // the entire document including every character.
  for (const item of doc.view().blocks) {
    const block = parse(item.id);
    if (item.parent === rootKey) {
      if (eqId(block, TITLE)) {
        if (item.type === "title") out.push({ block, parent: ROOT });
        continue;
      }
      if (allowed(item.type)) out.push({ block, parent: ROOT });
      else if (item.type === "columns") columns.set(item.id, block);
    } else {
      const parent = columns.get(item.parent);
      if (parent && allowed(item.type)) out.push({ block, parent });
    }
  }
  return out;
}

function literalRegExp(query: string, caseSensitive: boolean): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "gu" : "giu");
}

const isMention = (marks: Record<string, string>) => !!marks.mention || isDocumentReferenceMarks(marks);

function codePointMatches(text: string, pattern: RegExp): { start: number; end: number; text: string }[] {
  const boundaries = new Map<number, number>([[0, 0]]);
  let cp = 0;
  let utf16 = 0;
  for (const ch of text) {
    cp++;
    utf16 += ch.length;
    boundaries.set(utf16, cp);
  }
  const out: { start: number; end: number; text: string }[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const start = boundaries.get(match.index!);
    const end = boundaries.get(match.index! + match[0].length);
    if (start === undefined || end === undefined || start === end) continue;
    out.push({ start, end, text: match[0] });
  }
  return out;
}

/**
 * Finds non-overlapping matches in the title and visible body/column blocks.
 * Offsets are Unicode code points, never UTF-16 indices. Unicode's simple
 * case folding is used without normalization or length-changing full folding.
 * By default inline and block formulas are excluded; pass `includeMath: true`
 * to include formula LaTeX source safely.
 */
export function findMatches(doc: Doc, query: string, options: FindOptions = {}): FindMatch[] {
  if (!query) return [];
  const result: FindMatch[] = [];
  const pattern = literalRegExp(query, !!options.caseSensitive);
  const includeMath = !!options.includeMath;
  for (const { block, parent } of searchableLocations(doc, { includeMath })) {
    const type = doc.blockInfo(block).type;
    const chars = doc.richChars(block);
    const ids = doc.visibleIds(block);
    if (type === "math") {
      const src = chars.map((c) => c.ch).join("");
      for (const found of codePointMatches(src, pattern)) {
        result.push({
          doc,
          block,
          parent: { ...parent },
          start: found.start,
          end: found.end,
          ids: ids.slice(found.start, found.end).map((id) => ({ ...id })),
          text: found.text,
          math: { kind: "block" },
        });
      }
      continue;
    }
    let from = 0;
    while (from < chars.length) {
      if (chars[from].marks.math) {
        const formula = chars[from].marks.math;
        const mathId = chars[from].marks.mathId;
        let to = from + 1;
        while (to < chars.length && chars[to].marks.math === formula && chars[to].marks.mathId === mathId) to++;
        if (includeMath) {
          const atomIds = ids.slice(from, to).map((id) => ({ ...id }));
          for (const found of codePointMatches(formula, pattern)) {
            result.push({
              doc,
              block,
              parent: { ...parent },
              start: from,
              end: to,
              ids: atomIds.map((id) => ({ ...id })),
              text: found.text,
              math: {
                kind: "inline",
                formula,
                formulaStart: found.start,
                formulaEnd: found.end,
                ...(mathId ? { mathId } : {}),
              },
            });
          }
        }
        from = to;
        continue;
      }
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
        result.push({ doc, block, parent: { ...parent }, start, end, ids: ids.slice(start, end).map((id) => ({ ...id })), text: match[0], mention: chars.slice(start, end).some((char) => isMention(char.marks)) });
      }
      from = to;
    }
  }
  return result;
}

/** Resolve a snapshot only if the original visible characters still form the same range. */
export function resolveFindMatch(doc: Doc, match: FindMatch): { start: number; end: number } | null {
  if (doc !== match.doc || !match.ids.length || !doc.hasBlock(match.block)) return null;
  const includeMath = match.math?.kind === "block";
  if (!searchableLocations(doc, { includeMath }).some(({ block, parent }) => eqId(block, match.block) && eqId(parent, match.parent))) return null;
  const ids = doc.visibleIds(match.block);
  const start = ids.findIndex((id) => eqId(id, match.ids[0]));
  const end = start + match.ids.length;
  if (start < 0 || end > ids.length || match.ids.some((id, i) => !eqId(id, ids[start + i]))) return null;
  const allChars = doc.richChars(match.block);
  const chars = allChars.slice(start, end);
  if (match.math?.kind === "block") {
    if (doc.blockInfo(match.block).type !== "math") return null;
    if (chars.map((char) => char.ch).join("") !== match.text) return null;
    return { start, end };
  }
  if (match.math?.kind === "inline") {
    const formula = match.math.formula;
    const fStart = match.math.formulaStart;
    const fEnd = match.math.formulaEnd;
    if (!formula || fStart === undefined || fEnd === undefined || fStart < 0 || fEnd <= fStart) return null;
    const mathId = match.math.mathId;
    if (chars.some((char) => char.marks.math !== formula || char.marks.mathId !== mathId)) return null;
    const prev = start > 0 ? allChars[start - 1] : undefined;
    const next = end < allChars.length ? allChars[end] : undefined;
    if (prev && prev.marks.math === formula && prev.marks.mathId === mathId) return null;
    if (next && next.marks.math === formula && next.marks.mathId === mathId) return null;
    const points = [...formula];
    if (fEnd > points.length || points.slice(fStart, fEnd).join("") !== match.text) return null;
    return { start, end };
  }
  if (chars.some((char) => !!char.marks.math) || chars.map((char) => char.ch).join("") !== match.text) return null;
  return { start, end };
}

function sharedMarks(marks: Record<string, string>[]): Record<string, string> {
  const common = { ...(marks[0] ?? {}) };
  for (const key of Object.keys(common)) {
    // Mention IDs and inline-math source carry semantics tied to the old text.
    if (key === "mention" || key === "math" || key === "mathId" || marks.some((m) => m[key] !== common[key])) delete common[key];
  }
  if (!common.link) delete common.linkKind;
  return common;
}

/**
 * Replaces snapshots from the end of the current document towards the start.
 * Title matches remain disabled by default; callers opting in must use an
 * isolated replica and a guarded title-and-directory commit. Operations go
 * into the caller's one Tx for one undo step. Stale, moved
 * outside the body, overlapping or wrong-document snapshots are skipped.
 * Remote inserts arriving later are not deleted: Tx deletes only captured IDs.
 * This function is synchronous: it validates one snapshot of each affected
 * block before mutating any block, so asynchronous remote events cannot land
 * between that validation and application. Non-overlapping ranges are then
 * applied backwards, keeping their original offsets valid.
 */
export function replaceMatches(tx: Tx, matches: readonly FindMatch[], replacement: string, options: { allowTitle?: boolean } = {}): { replaced: number; skipped: number } {
  const doc = tx.doc;
  const includeMathBlocks = matches.some((match) => match.math?.kind === "block");
  const order = new Map(searchableLocations(doc, { includeMath: includeMathBlocks }).map(({ block, parent }, i) => [idKey(block), { index: i, parent }]));
  type BlockSnapshot = { type: string; ids: OpId[]; positions: Map<string, number>; chars: ReturnType<Doc["richChars"]> };
  const snapshots = new Map<string, BlockSnapshot | null>();
  type PlannedEdit =
    | { kind: "text"; match: FindMatch; start: number; end: number; marks: Record<string, string>; order: number }
    | {
        kind: "inline-math";
        block: OpId;
        start: number;
        end: number;
        order: number;
        formula: string;
        mathId?: string;
        baseMarks: Record<string, string>;
        subMatches: { start: number; end: number; text: string }[];
      };
  const planned: PlannedEdit[] = [];
  const inlineMathGroups = new Map<string, Extract<PlannedEdit, { kind: "inline-math" }>>();
  let skipped = 0;
  for (const match of matches) {
    const key = idKey(match.block);
    const location = order.get(key);
    if (match.doc !== doc || !match.ids.length || !location || !eqId(location.parent, match.parent)) { skipped++; continue; }
    if (!snapshots.has(key)) {
      if (!doc.hasBlock(match.block)) {
        snapshots.set(key, null);
      } else {
        const blockType = doc.blockInfo(match.block).type;
        const okType =
          isSearchableBlockType(blockType) ||
          (includeMathBlocks && blockType === "math") ||
          (options.allowTitle && eqId(match.block, TITLE) && blockType === "title");
        if (!okType) snapshots.set(key, null);
        else {
          const ids = doc.visibleIds(match.block);
          snapshots.set(key, { type: blockType, ids, positions: new Map(ids.map((id, i) => [idKey(id), i])), chars: doc.richChars(match.block) });
        }
      }
    }
    const state = snapshots.get(key);
    if (!state) { skipped++; continue; }
    const start = state.positions.get(idKey(match.ids[0]));
    if (start === undefined || match.ids.some((id, i) => !state.ids[start + i] || !eqId(id, state.ids[start + i]))) { skipped++; continue; }
    const end = start + match.ids.length;
    const chars = state.chars.slice(start, end);
    if (match.math?.kind === "block") {
      if (state.type !== "math" || chars.map((char) => char.ch).join("") !== match.text) { skipped++; continue; }
      planned.push({ kind: "text", match, start, end, marks: {}, order: location.index });
      continue;
    }
    if (match.math?.kind === "inline") {
      const formula = match.math.formula;
      const fStart = match.math.formulaStart;
      const fEnd = match.math.formulaEnd;
      const mathId = match.math.mathId;
      if (!formula || fStart === undefined || fEnd === undefined || fStart < 0 || fEnd <= fStart) { skipped++; continue; }
      if (chars.some((char) => char.marks.math !== formula || char.marks.mathId !== mathId || isMention(char.marks))) { skipped++; continue; }
      const prev = start > 0 ? state.chars[start - 1] : undefined;
      const next = end < state.chars.length ? state.chars[end] : undefined;
      if ((prev && prev.marks.math === formula && prev.marks.mathId === mathId) || (next && next.marks.math === formula && next.marks.mathId === mathId)) { skipped++; continue; }
      const points = [...formula];
      if (fEnd > points.length || points.slice(fStart, fEnd).join("") !== match.text) { skipped++; continue; }
      const groupKey = `${key}:${start}:${end}`;
      let group = inlineMathGroups.get(groupKey);
      if (!group) {
        group = {
          kind: "inline-math",
          block: match.block,
          start,
          end,
          order: location.index,
          formula,
          mathId,
          baseMarks: sharedMarks(chars.map((char) => char.marks)),
          subMatches: [],
        };
        inlineMathGroups.set(groupKey, group);
        planned.push(group);
      }
      group.subMatches.push({ start: fStart, end: fEnd, text: match.text });
      continue;
    }
    if (state.type === "math") { skipped++; continue; }
    if (chars.some((char) => !!char.marks.math || isMention(char.marks)) || chars.map((char) => char.ch).join("") !== match.text) { skipped++; continue; }
    // The title is a plain-text control; title operations must not attach
    // formatting marks, which conditional title commits do not accept.
    planned.push({ kind: "text", match, start, end, marks: eqId(match.block, TITLE) ? {} : sharedMarks(chars.map((char) => char.marks)), order: location.index });
  }
  planned.sort((a, b) => {
    return b.order - a.order || b.start - a.start || b.end - a.end;
  });
  let replaced = 0;
  let previousOrder = -1;
  let previousStart = Infinity;
  for (const item of planned) {
    if (item.order !== previousOrder) { previousOrder = item.order; previousStart = Infinity; }
    if (item.end > previousStart) {
      skipped += item.kind === "inline-math" ? item.subMatches.length : 1;
      continue;
    }
    previousStart = item.start;
    if (item.kind === "inline-math") {
      const sorted = [...item.subMatches].sort((a, b) => b.start - a.start || b.end - a.end);
      const points = [...item.formula];
      let prevSub = points.length;
      const parts: string[] = [];
      let applied = 0;
      for (const sub of sorted) {
        if (sub.end > prevSub) { skipped++; continue; }
        parts.push(points.slice(sub.end, prevSub).join(""), replacement);
        prevSub = sub.start;
        applied++;
      }
      parts.push(points.slice(0, prevSub).join(""));
      const nextFormula = parts.reverse().join("");
      if (applied > 0 && nextFormula !== item.formula) {
        tx.delete(item.block, item.start, item.end);
        if (nextFormula) {
          const nextMarks: Record<string, string> = { ...item.baseMarks, math: nextFormula, ...(item.mathId ? { mathId: item.mathId } : {}) };
          tx.insert(item.block, item.start, nextFormula, nextMarks);
        }
      }
      replaced += applied;
      continue;
    }
    // Identical replacement is a logical success, but needs no CRDT ops.
    if (replacement !== item.match.text) {
      tx.delete(item.match.block, item.start, item.end);
      if (replacement) tx.insert(item.match.block, item.start, replacement, item.marks);
    }
    replaced++;
  }
  return { replaced, skipped };
}
