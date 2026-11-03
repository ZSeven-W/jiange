/** Minimal single-region diff between two strings, in code points. */
export function diff(prev: string, next: string): { index: number; remove: number; insert: string } | null {
  const a = [...prev];
  const b = [...next];
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  if (s === ea && s === eb) return null;
  return { index: s, remove: ea - s, insert: b.slice(s, eb).join("") };
}
