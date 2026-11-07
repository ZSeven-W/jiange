import type { DocView } from "@/lib/api";

export interface DiffRow {
  kind: "same" | "added" | "removed" | "changed";
  type: string;
  oldText?: string;
  newText?: string;
}

const text = (b: DocView["blocks"][number]) => b.spans.map((s) => s.text).join("");

/** 块级 diff：按 (type, text) 对齐，LCS 最长公共子序列。 */
export function diffViews(oldV: DocView, newV: DocView): DiffRow[] {
  const A = oldV.blocks.filter((b) => b.type !== "title");
  const B = newV.blocks.filter((b) => b.type !== "title");
  const n = A.length, m = B.length;
  // LCS 表
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = text(A[i]) === text(B[j]) && A[i].type === B[j].type ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  // 回溯
  const rows: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (text(A[i]) === text(B[j]) && A[i].type === B[j].type) {
      rows.push({ kind: "same", type: A[i].type, oldText: text(A[i]), newText: text(B[j]) });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // 老块被删（或改动：同位置不同文本按对齐走 removed+added 会碎，改为就近配对 changed）
      if (text(A[i]) !== "" && text(B[j]) !== "" && A[i].type === B[j].type && dp[i + 1][j] === dp[i][j + 1]) {
        rows.push({ kind: "changed", type: A[i].type, oldText: text(A[i]), newText: text(B[j]) });
        i++; j++;
      } else {
        rows.push({ kind: "removed", type: A[i].type, oldText: text(A[i]) });
        i++;
      }
    } else {
      rows.push({ kind: "added", type: B[j].type, newText: text(B[j]) });
      j++;
    }
  }
  while (i < n) rows.push({ kind: "removed", type: A[i].type, oldText: text(A[i++]) });
  while (j < m) rows.push({ kind: "added", type: B[j].type, newText: text(B[j++]) });
  return rows;
}
