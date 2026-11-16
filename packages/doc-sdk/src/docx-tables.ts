/** Word and Jiange both represent a merge as a rectangular region. */
export type TableMerge = [row: number, column: number, rowSpan: number, columnSpan: number];

/** Reject overlapping, invalid and content-hiding merges instead of dropping cells on export. */
export function exportableTableMerges(raw: string | undefined, rows: string[][]): { merges: TableMerge[]; loss: boolean } {
  if (!raw) return { merges: [], loss: false };
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return { merges: [], loss: true }; }
  if (!Array.isArray(list)) return { merges: [], loss: true };
  const merges: TableMerge[] = [];
  let loss = false;
  for (const item of list) {
    if (!Array.isArray(item) || item.length !== 4 || !item.every(Number.isSafeInteger)) { loss = true; continue; }
    const [r, c, rs, cs] = item as TableMerge;
    if (r < 0 || c < 0 || rs < 1 || cs < 1 || rs + cs < 3 || r + rs > rows.length || c + cs > rows[0].length || merges.some(([a, b, h, w]) => r < a + h && a < r + rs && c < b + w && b < c + cs)) { loss = true; continue; }
    let hiddenText = false;
    for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) if ((y !== r || x !== c) && rows[y][x]) hiddenText = true;
    if (hiddenText) { loss = true; continue; }
    merges.push([r, c, rs, cs]);
  }
  return { merges, loss };
}
