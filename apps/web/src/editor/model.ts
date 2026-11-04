import { eqId, idKey, ROOT, Tx, type Doc, type OpId } from "@jiange/collab";

export const TITLE: OpId = { client: 0, clock: 1 };
export interface Pos {
  b: OpId;
  o: number;
}
export interface Sel {
  a: Pos;
  f: Pos;
}

export const LIST_TYPES = new Set(["bullet", "ordered", "todo"]);
export const TEXTLESS = new Set(["divider", "image", "file", "table"]);
export const INLINE_MARKS = ["bold", "italic", "underline", "strike", "code", "link"] as const;

/** Body blocks in document order (the title block is edited separately). */
export function bodyBlocks(doc: Doc): OpId[] {
  return doc.children(ROOT).filter((b) => !eqId(b, TITLE));
}

export const len = (doc: Doc, b: OpId) => doc.visibleIds(b).length;

export function cmpPos(order: Map<string, number>, x: Pos, y: Pos): number {
  const d = (order.get(idKey(x.b)) ?? 0) - (order.get(idKey(y.b)) ?? 0);
  return d !== 0 ? d : x.o - y.o;
}

export function orderMap(blocks: OpId[]) {
  return new Map(blocks.map((b, i) => [idKey(b), i]));
}

export function normalize(doc: Doc, sel: Sel): { start: Pos; end: Pos; blocks: OpId[] } {
  const blocks = bodyBlocks(doc);
  const ord = orderMap(blocks);
  const [start, end] = cmpPos(ord, sel.a, sel.f) <= 0 ? [sel.a, sel.f] : [sel.f, sel.a];
  const i = ord.get(idKey(start.b)) ?? 0, j = ord.get(idKey(end.b)) ?? 0;
  return { start, end, blocks: blocks.slice(i, j + 1) };
}

export const collapsed = (s: Sel) => eqId(s.a.b, s.f.b) && s.a.o === s.f.o;

/** Deletes the selected range (possibly spanning blocks); returns the caret. */
export function deleteRange(tx: Tx, sel: Sel): Pos {
  const doc = tx.doc;
  const { start, end, blocks } = normalize(doc, sel);
  if (eqId(start.b, end.b)) {
    tx.delete(start.b, start.o, end.o);
    return start;
  }
  const tail = doc.richChars(end.b).slice(end.o);
  tx.delete(start.b, start.o, len(doc, start.b));
  for (const b of blocks.slice(1)) tx.deleteBlock(b);
  if (tail.length && !TEXTLESS.has(doc.blockInfo(start.b).type)) {
    tx.insert(start.b, start.o, tail.map((c) => c.ch).join(""), tail.map((c) => c.marks));
  }
  return start;
}

/** Splits a block at pos (Enter). Returns the caret. */
export function splitBlock(tx: Tx, pos: Pos): Pos {
  const doc = tx.doc;
  const info = doc.blockInfo(pos.b);
  const n = len(doc, pos.b);
  if (LIST_TYPES.has(info.type) && n === 0) {
    if ((info.props.indent ?? "0") !== "0") tx.setProp(pos.b, "indent", String(Number(info.props.indent) - 1));
    else tx.setProp(pos.b, "type", "paragraph");
    return pos;
  }
  if (info.type === "code") {
    // Enter on an empty last line leaves the code block
    const text = doc.text(pos.b);
    if (pos.o === n && text.endsWith("\n")) {
      tx.delete(pos.b, n - 1, n);
      return { b: tx.create("paragraph", pos.b, info.parent), o: 0 };
    }
    tx.insert(pos.b, pos.o, "\n");
    return { b: pos.b, o: pos.o + 1 };
  }
  const tail = doc.richChars(pos.b).slice(pos.o);
  tx.delete(pos.b, pos.o, n);
  const type = LIST_TYPES.has(info.type) ? info.type : info.type === "quote" ? "quote" : "paragraph";
  const props: Record<string, string> = {};
  if (info.props.indent && LIST_TYPES.has(type)) props.indent = info.props.indent;
  const nb = tx.create(type, pos.b, info.parent, props);
  if (tail.length) tx.insert(nb, 0, tail.map((c) => c.ch).join(""), tail.map((c) => c.marks));
  return { b: nb, o: 0 };
}

/** Backspace at the start of a block. */
export function joinBackward(tx: Tx, b: OpId): Pos {
  const doc = tx.doc;
  const info = doc.blockInfo(b);
  if ((info.props.indent ?? "0") !== "0") {
    tx.setProp(b, "indent", String(Number(info.props.indent) - 1));
    return { b, o: 0 };
  }
  if (info.type !== "paragraph") {
    tx.setProp(b, "type", "paragraph");
    return { b, o: 0 };
  }
  const blocks = bodyBlocks(doc);
  const i = blocks.findIndex((x) => eqId(x, b));
  if (i <= 0) return { b, o: 0 };
  const prev = blocks[i - 1];
  if (TEXTLESS.has(doc.blockInfo(prev).type)) {
    tx.deleteBlock(prev);
    return { b, o: 0 };
  }
  const at = len(doc, prev);
  const chars = doc.richChars(b);
  if (chars.length) tx.insert(prev, at, chars.map((c) => c.ch).join(""), chars.map((c) => c.marks));
  tx.deleteBlock(b);
  return { b: prev, o: at };
}

/** Delete at the end of a block: pull the next block in. */
export function joinForward(tx: Tx, b: OpId): Pos {
  const doc = tx.doc;
  const blocks = bodyBlocks(doc);
  const i = blocks.findIndex((x) => eqId(x, b));
  const at = len(doc, b);
  if (i < 0 || i === blocks.length - 1) return { b, o: at };
  const next = blocks[i + 1];
  if (TEXTLESS.has(doc.blockInfo(next).type)) {
    tx.deleteBlock(next);
    return { b, o: at };
  }
  const chars = doc.richChars(next);
  if (chars.length) tx.insert(b, at, chars.map((c) => c.ch).join(""), chars.map((c) => c.marks));
  tx.deleteBlock(next);
  return { b, o: at };
}

const BLOCK_RULES: [RegExp, string, Record<string, string>?][] = [
  [/^#$/, "h1"],
  [/^##$/, "h2"],
  [/^###$/, "h3"],
  [/^[-*+]$/, "bullet"],
  [/^1[.)]$/, "ordered"],
  [/^\[ ?\]$/, "todo"],
  [/^\[x\]$/i, "todo", { checked: "true" }],
  [/^>$/, "quote"],
  [/^```$/, "code"],
];

/** Markdown shortcuts applied after the user typed `typed` and the caret is at pos. */
export function markdownShortcut(tx: Tx, pos: Pos, typed: string): Pos | null {
  const doc = tx.doc;
  const info = doc.blockInfo(pos.b);
  const text = [...doc.text(pos.b)];
  const before = text.slice(0, pos.o).join("");
  if (typed === " " && info.type === "paragraph") {
    const prefix = before.slice(0, -1);
    for (const [re, type, props] of BLOCK_RULES) {
      if (re.test(prefix)) {
        tx.delete(pos.b, 0, pos.o);
        tx.setProp(pos.b, "type", type);
        for (const [k, v] of Object.entries(props ?? {})) tx.setProp(pos.b, k, v);
        return { b: pos.b, o: 0 };
      }
    }
  }
  if (typed === "-" && info.type === "paragraph" && text.join("") === "---") {
    tx.delete(pos.b, 0, 3);
    tx.setProp(pos.b, "type", "divider");
    const nb = tx.create("paragraph", pos.b, info.parent);
    return { b: nb, o: 0 };
  }
  if (info.type === "code") return null;
  for (const [re, key, w] of [
    [/\*\*([^*]+)\*\*$/, "bold", 2],
    [/~~([^~]+)~~$/, "strike", 2],
    [/`([^`]+)`$/, "code", 1],
    [/(?:^|[^*])\*([^*]+)\*$/, "italic", 1],
  ] as const) {
    const m = re.exec(before);
    if (!m || !before.endsWith(typed)) continue;
    const inner = [...m[1]].length;
    const end = pos.o; // after closing marker
    const s = end - w - inner - w;
    tx.delete(pos.b, end - w, end);
    tx.delete(pos.b, s, s + w);
    tx.format(pos.b, s, s + inner, key, "true");
    return { b: pos.b, o: s + inner };
  }
  return null;
}

/** Toggles an inline mark over the selection (on if any char lacks it). */
export function toggleMark(tx: Tx, sel: Sel, key: string, value = "true"): void {
  const doc = tx.doc;
  const { start, end, blocks } = normalize(doc, sel);
  const segs = blocks.map((b) => ({
    b,
    from: eqId(b, start.b) ? start.o : 0,
    to: eqId(b, end.b) ? end.o : len(doc, b),
  }));
  const all = segs.every((s) => doc.richChars(s.b).slice(s.from, s.to).every((c) => c.marks[key] === value));
  for (const s of segs) tx.format(s.b, s.from, s.to, key, all ? null : value);
}

export function setBlockType(tx: Tx, sel: Sel, type: string) {
  const { blocks } = normalize(tx.doc, sel);
  for (const b of blocks) tx.setProp(b, "type", type);
}

/** Marks active over the whole selection (for toolbar state). */
export function activeMarks(doc: Doc, sel: Sel): Record<string, string> {
  const { start, end, blocks } = normalize(doc, sel);
  let acc: Record<string, string> | null = null;
  for (const b of blocks) {
    const from = eqId(b, start.b) ? start.o : 0, to = eqId(b, end.b) ? end.o : len(doc, b);
    for (const c of doc.richChars(b).slice(from, to)) {
      if (!acc) acc = { ...c.marks };
      else for (const k of Object.keys(acc)) if (acc[k] !== c.marks[k]) delete acc[k];
    }
  }
  return acc ?? {};
}

export interface ClipBlock {
  type: string;
  props: Record<string, string>;
  chars: { ch: string; marks: Record<string, string> }[];
}

export function copyRange(doc: Doc, sel: Sel): ClipBlock[] {
  const { start, end, blocks } = normalize(doc, sel);
  return blocks.map((b) => {
    const info = doc.blockInfo(b);
    const from = eqId(b, start.b) ? start.o : 0, to = eqId(b, end.b) ? end.o : len(doc, b);
    return { type: info.type, props: info.props, chars: doc.richChars(b).slice(from, to) };
  });
}

export function clipText(blocks: ClipBlock[]): string {
  return blocks.map((b) => b.chars.map((c) => c.ch).join("")).join("\n");
}

/** Parses pasted plain text: one block per line, with markdown line prefixes. */
export function parseText(text: string): ClipBlock[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    let type = "paragraph";
    let t = line;
    const rules: [RegExp, string][] = [[/^### /, "h3"], [/^## /, "h2"], [/^# /, "h1"], [/^[-*+] \[[ x]\] /i, "todo"], [/^[-*+] /, "bullet"], [/^\d+[.)] /, "ordered"], [/^> /, "quote"]];
    for (const [re, ty] of rules) {
      const m = re.exec(t);
      if (m) {
        type = ty;
        t = t.slice(m[0].length);
        break;
      }
    }
    return { type, props: {}, chars: [...t].map((ch) => ({ ch, marks: {} })) };
  });
}

/** Inserts clipboard blocks at pos: the first merges inline, the rest become blocks. */
export function pasteBlocks(tx: Tx, pos: Pos, clip: ClipBlock[]): Pos {
  const doc = tx.doc;
  if (clip.length === 0) return pos;
  const first = clip[0];
  if (clip.length === 1) {
    const n = tx.insert(pos.b, pos.o, first.chars.map((c) => c.ch).join(""), first.chars.map((c) => c.marks));
    return { b: pos.b, o: pos.o + n };
  }
  const info = doc.blockInfo(pos.b);
  const tail = doc.richChars(pos.b).slice(pos.o);
  tx.delete(pos.b, pos.o, len(doc, pos.b));
  if (first.chars.length) tx.insert(pos.b, pos.o, first.chars.map((c) => c.ch).join(""), first.chars.map((c) => c.marks));
  if (info.type === "paragraph" && pos.o === 0 && first.type !== "paragraph") tx.setProp(pos.b, "type", first.type);
  let after = pos.b;
  let caret: Pos = pos;
  clip.slice(1).forEach((cb, i) => {
    const nb = tx.create(cb.type || "paragraph", after, info.parent, cb.props);
    const text = cb.chars.map((c) => c.ch).join("");
    if (text) tx.insert(nb, 0, text, cb.chars.map((c) => c.marks));
    after = nb;
    caret = { b: nb, o: cb.chars.length };
    if (i === clip.length - 2 && tail.length) tx.insert(nb, cb.chars.length, tail.map((c) => c.ch).join(""), tail.map((c) => c.marks));
  });
  return caret;
}

/** 编辑表格块数据的纯变换（r=-1 加行、-2 加列、-3 删行，否则写单元格）。 */
export function applyTableEdit(rows: string[][], r: number, c: number, v: string): string[][] {
  if (!rows.length) rows = [["", "", ""], ["", "", ""]];
  if (r === -1) return [...rows, Array.from({ length: rows[0].length }, () => "")];
  if (r === -2) return rows.map((row) => [...row, ""]);
  if (r === -3) return rows.length > 1 ? rows.filter((_, i) => i !== c) : rows;
  return rows.map((row, ri) => (ri === r && row[c] !== undefined ? row.map((cell, ci) => (ci === c ? v : cell)) : row));
}

/** 解析 tableData prop，非法输入回退到默认 2×3。 */
export function parseTableData(data: string | undefined): string[][] {
  try {
    const parsed = JSON.parse(data || "null");
    if (Array.isArray(parsed) && parsed.length && Array.isArray(parsed[0])) return parsed;
  } catch {
    /* fall through */
  }
  return [["列 1", "列 2", "列 3"], ["", "", ""]];
}
