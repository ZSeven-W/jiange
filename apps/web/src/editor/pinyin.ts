/**
 * Pinyin matching for menu labels: a query matches if it covers a run of
 * syllables where each syllable is typed fully or by a prefix (so "bt",
 * "yjbt", "biaoti", "yijibiaot" all match 一级标题 = yi ji biao ti).
 */
export function pinyinMatch(syllables: string[], query: string): boolean {
  const q = query.toLowerCase();
  if (!q) return true;
  const n = syllables.length;
  // can(i, j): q[j..] can be matched starting at syllable i
  const memo = new Map<string, boolean>();
  const can = (i: number, j: number): boolean => {
    if (j === q.length) return true;
    if (i === n) return false;
    const key = i + ":" + j;
    if (memo.has(key)) return memo.get(key)!;
    const s = syllables[i];
    let ok = false;
    for (let k = 1; k <= s.length && j + k <= q.length && !ok; k++) {
      if (q.slice(j, j + k) !== s.slice(0, k)) break;
      ok = can(i + 1, j + k);
      if (!ok && j + k === q.length) ok = true; // partial last syllable
    }
    memo.set(key, ok);
    return ok;
  };
  for (let start = 0; start < n; start++) if (can(start, 0)) return true;
  return false;
}

export interface MenuItem {
  id: string;
  label: string;
  group: string;
  icon: string;
  py: string[];
  en: string[];
}

export const SLASH_ITEMS: MenuItem[] = [
  { id: "paragraph", label: "正文", group: "基础", icon: "T", py: ["zheng", "wen"], en: ["text", "paragraph"] },
  { id: "h1", label: "一级标题", group: "基础", icon: "H1", py: ["yi", "ji", "biao", "ti"], en: ["h1", "heading1"] },
  { id: "h2", label: "二级标题", group: "基础", icon: "H2", py: ["er", "ji", "biao", "ti"], en: ["h2", "heading2"] },
  { id: "h3", label: "三级标题", group: "基础", icon: "H3", py: ["san", "ji", "biao", "ti"], en: ["h3", "heading3"] },
  { id: "bullet", label: "无序列表", group: "列表", icon: "•", py: ["wu", "xu", "lie", "biao"], en: ["bullet", "list", "ul"] },
  { id: "ordered", label: "有序列表", group: "列表", icon: "1.", py: ["you", "xu", "lie", "biao"], en: ["ordered", "number", "ol"] },
  { id: "todo", label: "待办事项", group: "列表", icon: "☑", py: ["dai", "ban", "shi", "xiang"], en: ["todo", "task", "check"] },
  { id: "quote", label: "引用", group: "其他", icon: "❝", py: ["yin", "yong"], en: ["quote"] },
  { id: "code", label: "代码块", group: "其他", icon: "</>", py: ["dai", "ma", "kuai"], en: ["code"] },
  { id: "image", label: "图片", group: "媒体", icon: "🖼", py: ["tu", "pian"], en: ["image", "picture", "img"] },
  { id: "file", label: "附件", group: "媒体", icon: "📎", py: ["fu", "jian"], en: ["file", "attachment"] },
  { id: "divider", label: "分割线", group: "其他", icon: "—", py: ["fen", "ge", "xian"], en: ["divider", "hr", "line"] },
];

export function filterItems(q: string, items = SLASH_ITEMS): MenuItem[] {
  const s = q.trim().toLowerCase();
  if (!s) return items;
  return items.filter((it) => it.label.includes(s) || it.en.some((e) => e.startsWith(s)) || pinyinMatch(it.py, s));
}
