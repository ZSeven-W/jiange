import { eqId, idKey, ROOT, type Doc, type OpId } from "@zseven-w/collab";
import type { FindMatch } from "@/editor/find-replace";

/** Resolve current title characters without trusting offsets from a stale result. */
export function titleFindFlags(doc: Doc | null, block: OpId, matches: readonly FindMatch[], active: FindMatch | null): (0 | 1 | 2)[] {
  if (!doc || !matches.length || !doc.hasBlock(block)) return [];
  const info = doc.blockInfo(block);
  if (info.type !== "title" || !eqId(info.parent, ROOT)) return [];
  const ids = doc.visibleIds(block), chars = doc.richChars(block), offsets = new Map(ids.map((id, index) => [idKey(id), index]));
  const flags: (0 | 1 | 2)[] = new Array(chars.length).fill(0);
  for (const match of matches) {
    if (match.doc !== doc || match.table || !eqId(match.block, block) || !eqId(match.parent, ROOT) || !match.ids.length) continue;
    const start = offsets.get(idKey(match.ids[0]));
    if (start === undefined || match.ids.some((id, index) => !ids[start + index] || !eqId(ids[start + index], id))) continue;
    const end = start + match.ids.length, span = chars.slice(start, end);
    if (span.some((char) => !!char.marks.math) || span.map((char) => char.ch).join("") !== match.text) continue;
    for (let index = start; index < end; index++) flags[index] = match === active ? 2 : Math.max(flags[index], 1) as 1 | 2;
  }
  return flags;
}

/** Highlight spans remain transparent: the textarea draws the actual text. */
export function titleMirrorRange(chars: string[], flags: readonly (0 | 1 | 2)[], from: number, to: number, key: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  for (let index = from; index < to;) {
    const flag = flags[index] ?? 0;
    let end = index + 1;
    while (end < to && (flags[end] ?? 0) === flag) end++;
    const text = chars.slice(index, end).join("");
    nodes.push(flag ? <mark key={`${key}:${index}`} data-find-match data-find-active={flag === 2 ? "true" : undefined} className={flag === 2 ? "bg-[#f3adad] text-transparent" : "bg-[#ffe69b] text-transparent"}>{text}</mark> : text);
    index = end;
  }
  return nodes;
}
