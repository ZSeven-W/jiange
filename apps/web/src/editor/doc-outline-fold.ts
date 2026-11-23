export interface OutlineFoldBlock {
  id: string;
  type: string;
  indent: number;
  text?: string;
}

export function headingLevel(type: string): number | null {
  return /^h[1-9]$/.test(type) ? Number(type[1]) : null;
}

/**
 * Compute Feishu-style hierarchical heading numbers ("1", "1.1", "1.1.1", "2")
 * normalized against the shallowest heading level present in the document so
 * documents that start at H2 still number cleanly as 1, 1.1, 2.
 */
export function computeHeadingNumbers(blocks: readonly { id: string; type: string; text?: string }[]): Map<string, string> {
  const headings: { id: string; level: number }[] = [];
  let minLevel = 9;
  for (const b of blocks) {
    const lv = headingLevel(b.type);
    if (lv === null) continue;
    if (b.text !== undefined && !b.text.trim()) continue;
    if (lv < minLevel) minLevel = lv;
    headings.push({ id: b.id, level: lv });
  }
  const result = new Map<string, string>();
  const counters: number[] = [];
  for (const h of headings) {
    const depth = Math.max(0, h.level - minLevel);
    while (counters.length <= depth) counters.push(0);
    counters[depth] += 1;
    counters.length = depth + 1;
    result.set(h.id, counters.join("."));
  }
  return result;
}

export interface FoldState {
  /** Blocks hidden because an ancestor heading or toggle is collapsed. */
  hidden: Set<string>;
  /** Number of body blocks hidden under each collapsed heading/toggle. */
  hiddenCounts: Map<string, number>;
  /** Headings/toggles that currently have at least one nested/subordinate block. */
  hasBody: Set<string>;
}

/**
 * Compute Feishu-style heading and toggle folding:
 * - A heading `hN` folds all following blocks until the next heading with level <= N.
 * - A `toggle` block at indent `k` folds all immediately following blocks with indent > k.
 */
export function computeFoldedBlocks(
  blocks: readonly OutlineFoldBlock[],
  collapsedIds: ReadonlySet<string>,
): FoldState {
  const hidden = new Set<string>();
  const hiddenCounts = new Map<string, number>();
  const hasBody = new Set<string>();

  for (let i = 0; i < blocks.length; i++) {
    const cur = blocks[i];
    const lv = headingLevel(cur.type);
    if (lv !== null) {
      let count = 0;
      for (let j = i + 1; j < blocks.length; j++) {
        const nextLv = headingLevel(blocks[j].type);
        if (nextLv !== null && nextLv <= lv) break;
        count++;
        if (collapsedIds.has(cur.id)) hidden.add(blocks[j].id);
      }
      if (count > 0) hasBody.add(cur.id);
      if (collapsedIds.has(cur.id)) hiddenCounts.set(cur.id, count);
    } else if (cur.type === "toggle") {
      let count = 0;
      for (let j = i + 1; j < blocks.length; j++) {
        if (blocks[j].indent <= cur.indent) break;
        count++;
        if (collapsedIds.has(cur.id)) hidden.add(blocks[j].id);
      }
      if (count > 0) hasBody.add(cur.id);
      if (collapsedIds.has(cur.id)) hiddenCounts.set(cur.id, count);
    }
  }

  return { hidden, hiddenCounts, hasBody };
}
