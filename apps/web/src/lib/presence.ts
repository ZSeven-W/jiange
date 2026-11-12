import type { Anchor, OpId } from "@jiange/collab";

export interface Presence {
  name: string;
  color: string;
  cursor?: { block: OpId; anchor: Anchor; focus?: Anchor } | null;
  /** Pointer and selection inside a flowchart block's editor (block = idKey). */
  flow?: { block: string; x?: number; y?: number; sel?: string[] } | null;
}

// first entries are the design tokens primary, peer-1, peer-2, peer-3
export const PEER_COLORS = ["#3370FF", "#F54A45", "#00B42A", "#FF8800", "#7F3BF5", "#00A6D6"];

export function colorFor(seed: number): string {
  return PEER_COLORS[Math.abs(seed) % PEER_COLORS.length];
}

export function initial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

/** UTF-16 offset → code point index (the collab model counts code points). */
export function cpIndex(s: string, utf16: number): number {
  let n = 0;
  for (let i = 0; i < utf16 && i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) i++;
    n++;
  }
  return n;
}

/** Code point index → UTF-16 offset. */
export function utf16Index(s: string, cp: number): number {
  let i = 0;
  for (let n = 0; n < cp && i < s.length; n++) {
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }
  return i;
}
