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
  // 按当前飞书的基础与常用分组排列，未移除扩展命令。
  { id: "paragraph", label: "文本", group: "基础", icon: "T", py: ["wen", "ben"], en: ["text", "paragraph", "正文", "zhengwen"] },
  { id: "h1", label: "一级标题", group: "基础", icon: "H1", py: ["yi", "ji", "biao", "ti"], en: ["h1", "heading1"] },
  { id: "h2", label: "二级标题", group: "基础", icon: "H2", py: ["er", "ji", "biao", "ti"], en: ["h2", "heading2"] },
  { id: "h3", label: "三级标题", group: "基础", icon: "H3", py: ["san", "ji", "biao", "ti"], en: ["h3", "heading3"] },
  { id: "ordered", label: "有序列表", group: "基础", icon: "1.", py: ["you", "xu", "lie", "biao"], en: ["ordered", "number", "numbered list", "ol"] },
  { id: "bullet", label: "无序列表", group: "基础", icon: "•", py: ["wu", "xu", "lie", "biao"], en: ["bullet", "bulleted list", "list", "ul"] },
  { id: "toggle", label: "折叠列表", group: "基础", icon: "▸", py: ["zhe", "die", "lie", "biao"], en: ["toggle", "collapse", "fold", "zdlb"] },
  { id: "code", label: "代码块", group: "基础", icon: "</>", py: ["dai", "ma", "kuai"], en: ["code"] },
  { id: "quote", label: "引用", group: "基础", icon: "❝", py: ["yin", "yong"], en: ["quote"] },
  { id: "divider", label: "分割线", group: "基础", icon: "—", py: ["fen", "ge", "xian"], en: ["divider", "hr", "line"] },
  { id: "link", label: "链接", group: "基础", icon: "链", py: ["lian", "jie"], en: ["link", "hyperlink", "url"] },
  { id: "todo", label: "待办事项", group: "常用", icon: "☑", py: ["dai", "ban", "shi", "xiang"], en: ["todo", "task", "check", "rw"] },
  { id: "status", label: "状态标签", group: "常用", icon: "标", py: ["zhuang", "tai", "biao", "qian"], en: ["status", "tag", "badge", "label", "zt"] },
  { id: "toc", label: "目录", group: "常用", icon: "目", py: ["mu", "lu"], en: ["toc", "outline", "table of contents", "ml"] },
  { id: "image", label: "图片", group: "常用", icon: "图", py: ["tu", "pian"], en: ["image", "picture", "img"] },
  { id: "file", label: "附件", group: "常用", icon: "附", py: ["fu", "jian"], en: ["file", "attachment", "wj", "sp"] },
  { id: "video", label: "视频", group: "常用", icon: "视", py: ["shi", "pin"], en: ["video", "wj"] },
  { id: "audio", label: "音频", group: "常用", icon: "音", py: ["yin", "pin"], en: ["audio", "music", "sound", "mp3", "yp"] },
  { id: "poll", label: "投票", group: "常用", icon: "投", py: ["tou", "piao"], en: ["poll", "vote", "tp"] },
  { id: "countdown", label: "倒计时", group: "常用", icon: "计", py: ["dao", "ji", "shi"], en: ["countdown", "timer", "djs"] },
  { id: "tabs", label: "标签页", group: "常用", icon: "签", py: ["biao", "qian", "ye"], en: ["tabs", "tab", "bqy"] },
  { id: "table", label: "表格", group: "常用", icon: "表", py: ["biao", "ge"], en: ["table", "grid"] },
  { id: "columns", label: "分栏", group: "常用", icon: "栏", py: ["fen", "lan"], en: ["columns", "cols"] },
  { id: "synced", label: "同步块", group: "常用", icon: "同", py: ["tong", "bu", "kuai"], en: ["synced", "sync block"] },
  { id: "subpages", label: "子页面列表", group: "常用", icon: "子", py: ["zi", "ye", "mian", "lie", "biao"], en: ["subpages", "child pages"] },
  { id: "reminder", label: "日期提醒", group: "常用", icon: "日", py: ["ri", "qi", "ti", "xing"], en: ["date", "reminder", "calendar", "time", "rq", "tx"] },
  { id: "embed-sheet", label: "嵌入电子表格", group: "常用", icon: "表", py: ["qian", "ru", "dian", "zi", "biao", "ge"], en: ["sheet", "spreadsheet", "excel", "embed sheet", "dzbg"] },
  { id: "embed-base", label: "嵌入多维表格", group: "常用", icon: "多", py: ["qian", "ru", "duo", "wei", "biao", "ge"], en: ["base", "bitable", "multitable", "embed base", "dwbg"] },
  { id: "embed-survey", label: "嵌入问卷", group: "常用", icon: "问", py: ["qian", "ru", "wen", "juan"], en: ["survey", "form", "questionnaire", "embed survey"] },
  { id: "embed-slides", label: "嵌入幻灯片", group: "其他", icon: "演", py: ["qian", "ru", "huan", "deng", "pian"], en: ["slides", "ppt", "deck", "embed slides", "hdp"] },
  { id: "bookmark", label: "网页卡片", group: "其他", icon: "链", py: ["wang", "ye", "ka", "pian"], en: ["bookmark", "web"] },
  { id: "callout", label: "高亮块", group: "其他", icon: "亮", py: ["gao", "liang", "kuai"], en: ["callout", "highlight"] },
  { id: "math", label: "公式", group: "其他", icon: "∑", py: ["gong", "shi"], en: ["math", "latex", "formula", "eq"] },
  { id: "flowchart", label: "流程图", group: "其他", icon: "流", py: ["liu", "cheng", "tu"], en: ["flowchart", "flow", "drawio", "liuchengtu"] },
  { id: "diagram", label: "Mermaid 图表", group: "其他", icon: "图", py: ["tu", "biao"], en: ["diagram", "mermaid"] },
  { id: "h4", label: "四级标题", group: "其他", icon: "H4", py: ["si", "ji", "biao", "ti"], en: ["h4", "heading4"] },
  { id: "h5", label: "五级标题", group: "其他", icon: "H5", py: ["wu", "ji", "biao", "ti"], en: ["h5", "heading5"] },
  { id: "h6", label: "六级标题", group: "其他", icon: "H6", py: ["liu", "ji", "biao", "ti"], en: ["h6", "heading6"] },
  { id: "h7", label: "七级标题", group: "其他", icon: "H7", py: ["qi", "ji", "biao", "ti"], en: ["h7", "heading7"] },
  { id: "h8", label: "八级标题", group: "其他", icon: "H8", py: ["ba", "ji", "biao", "ti"], en: ["h8", "heading8"] },
  { id: "h9", label: "九级标题", group: "其他", icon: "H9", py: ["jiu", "ji", "biao", "ti"], en: ["h9", "heading9"] },
];

export function filterItems(q: string, items = SLASH_ITEMS): MenuItem[] {
  const s = q.trim().toLowerCase();
  if (!s) return items;
  return items.filter((it) => it.label.includes(s) || it.en.some((e) => e.startsWith(s)) || pinyinMatch(it.py, s));
}

/** A space remains part of the query only while completing a supported alias. */
export function isMultiwordSlashPrefix(query: string): boolean {
  const lower = query.toLowerCase();
  return SLASH_ITEMS.some((item) => item.en.some((alias) => alias.includes(" ") && alias.startsWith(lower)));
}
