import type { DocView } from "@/lib/api";

export interface DiffRow {
  kind: "same" | "added" | "removed" | "changed";
  type: string;
  oldText?: string;
  newText?: string;
}

const MAX_DIFF_CELLS = 250_000;
const MAX_DIFF_BLOCKS = 5_000;
const count = (v: DocView) => v.blocks.filter((b) => b.type !== "title").length;
/** Avoid allocating an unbounded quadratic table for long documents. */
export function canDiffViews(oldV: DocView, newV: DocView): boolean {
  const a = count(oldV), b = count(newV);
  return a + b <= MAX_DIFF_BLOCKS && (a + 1) * (b + 1) <= MAX_DIFF_CELLS;
}

type Projected = { type: string; text: string; signature: string; identity?: number };
function project(block: DocView["blocks"][number]): Projected {
  const raw = block.spans.map((span) => span.text).join("");
  const text =
    block.type === "math" ? "[公式]"
    : block.type === "diagram" ? "[Mermaid 图表]"
    : block.type === "toc" ? "[目录]"
    : block.type === "status" ? "[状态]"
    : block.type === "embed" ? "[嵌入视图]"
    : block.type === "image" ? "[图片]"
    : block.type === "divider" ? "[分割线]"
    : block.spans.map((span) => span.marks.math ? "[公式]" : span.text).join("");
  return { type: block.type, text, signature: raw };
}

/** Block-level text comparison. Raw formula and diagram source is never rendered. */
export function diffViews(oldV: DocView, newV: DocView): DiffRow[] {
  if (!canDiffViews(oldV, newV)) throw new RangeError("document too large to compare");
  const A = oldV.blocks.filter((b) => b.type !== "title").map(project);
  const B = newV.blocks.filter((b) => b.type !== "title").map(project);
  const signatures = new Map<string, Map<string, number>>();
  let nextIdentity = 1;
  for (const item of [...A, ...B]) {
    let byText = signatures.get(item.type);
    if (!byText) { byText = new Map(); signatures.set(item.type, byText); }
    let identity = byText.get(item.signature);
    if (identity === undefined) { identity = nextIdentity++; byText.set(item.signature, identity); }
    item.identity = identity;
  }
  const n = A.length, m = B.length;
  const equal = (i: number, j: number) => A[i].identity === B[j].identity;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = equal(i,j) ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j],dp[i][j+1]);
  const rows: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (equal(i,j)) { rows.push({ kind: "same", type: A[i].type, oldText: A[i].text, newText: B[j].text }); i++; j++; }
    else if (dp[i+1][j] >= dp[i][j+1]) {
      if (A[i].text !== "" && B[j].text !== "" && A[i].type === B[j].type && dp[i+1][j] === dp[i][j+1]) { rows.push({ kind: "changed", type: A[i].type, oldText: A[i].text, newText: B[j].text }); i++; j++; }
      else { rows.push({ kind: "removed", type: A[i].type, oldText: A[i].text }); i++; }
    } else { rows.push({ kind: "added", type: B[j].type, newText: B[j].text }); j++; }
  }
  while (i < n) { rows.push({ kind: "removed", type: A[i].type, oldText: A[i].text }); i++; }
  while (j < m) { rows.push({ kind: "added", type: B[j].type, newText: B[j].text }); j++; }
  return rows;
}

export interface InlineDiffToken {
  kind: "same" | "added" | "removed";
  text: string;
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  total: number;
}

const MAX_INLINE_DIFF_CELLS = 160_000;
const MAX_INLINE_TOKENS = 4_000;
const INLINE_TOKEN_RE = /[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*|\s+|./gsu;

function tokenizeInline(text: string): string[] {
  if (!text) return [];
  return text.match(INLINE_TOKEN_RE) ?? [...text];
}

function pushCoalesced(out: InlineDiffToken[], kind: InlineDiffToken["kind"], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    out.push({ kind, text });
  }
}

/** Bounded word/character-level inline diff over CJK chars, Latin words, and punctuation. */
export function diffInlineTokens(oldText: string, newText: string): InlineDiffToken[] {
  if (oldText === newText) return oldText ? [{ kind: "same", text: oldText }] : [];
  if (!oldText) return [{ kind: "added", text: newText }];
  if (!newText) return [{ kind: "removed", text: oldText }];

  const oldTokens = tokenizeInline(oldText);
  const newTokens = tokenizeInline(newText);

  let prefix = 0;
  const minLen = Math.min(oldTokens.length, newTokens.length);
  while (prefix < minLen && oldTokens[prefix] === newTokens[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (
    suffix < maxSuffix &&
    oldTokens[oldTokens.length - 1 - suffix] === newTokens[newTokens.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: InlineDiffToken[] = [];
  if (prefix > 0) {
    pushCoalesced(out, "same", oldTokens.slice(0, prefix).join(""));
  }

  const a = oldTokens.slice(prefix, oldTokens.length - suffix);
  const b = newTokens.slice(prefix, newTokens.length - suffix);
  const n = a.length;
  const m = b.length;

  if (n === 0 && m > 0) {
    pushCoalesced(out, "added", b.join(""));
  } else if (m === 0 && n > 0) {
    pushCoalesced(out, "removed", a.join(""));
  } else if (n > 0 && m > 0) {
    if (n + m > MAX_INLINE_TOKENS || (n + 1) * (m + 1) > MAX_INLINE_DIFF_CELLS) {
      // Bounded fallback: keep matched prefix/suffix and show middle replacement cleanly.
      pushCoalesced(out, "removed", a.join(""));
      pushCoalesced(out, "added", b.join(""));
    } else {
      const cols = m + 1;
      const dp = new Uint32Array((n + 1) * cols);
      for (let i = n - 1; i >= 0; i--) {
        const rowOff = i * cols;
        const nextRowOff = (i + 1) * cols;
        for (let j = m - 1; j >= 0; j--) {
          if (a[i] === b[j]) {
            dp[rowOff + j] = dp[nextRowOff + j + 1] + 1;
          } else {
            const down = dp[nextRowOff + j];
            const right = dp[rowOff + j + 1];
            dp[rowOff + j] = down >= right ? down : right;
          }
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          pushCoalesced(out, "same", a[i]);
          i++;
          j++;
        } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
          pushCoalesced(out, "removed", a[i]);
          i++;
        } else {
          pushCoalesced(out, "added", b[j]);
          j++;
        }
      }
      while (i < n) {
        pushCoalesced(out, "removed", a[i]);
        i++;
      }
      while (j < m) {
        pushCoalesced(out, "added", b[j]);
        j++;
      }
    }
  }

  if (suffix > 0) {
    pushCoalesced(out, "same", oldTokens.slice(oldTokens.length - suffix).join(""));
  }
  return out;
}

/** Count added, removed, changed, and total modified blocks across diff rows. */
export function summarizeDiff(rows: readonly DiffRow[]): DiffSummary {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const row of rows) {
    if (row.kind === "added") added++;
    else if (row.kind === "removed") removed++;
    else if (row.kind === "changed") changed++;
  }
  return { added, removed, changed, total: added + removed + changed };
}
