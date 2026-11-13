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
  const text = block.type === "math" ? "[公式]" : block.type === "diagram" ? "[Mermaid 图表]" : block.spans.map((span) => span.marks.math ? "[公式]" : span.text).join("");
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
