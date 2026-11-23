// View and reading preferences scoped to the local account and document.
export type DocWidth = "default" | "wider" | "full";
export type DocFontFamily = "default" | "serif" | "mono";
export type DocFontSize = "sm" | "md" | "lg";
export type DocPaperBg = "white" | "warm" | "green" | "gray";

export interface DocPagePrefs {
  fontFamily: DocFontFamily;
  fontSize: DocFontSize;
  paperBg: DocPaperBg;
  autoNumberHeadings: boolean;
  locked: boolean;
}

export const DEFAULT_DOC_PREFS: DocPagePrefs = {
  fontFamily: "default",
  fontSize: "md",
  paperBg: "white",
  autoNumberHeadings: false,
  locked: false,
};

const key = (user: number, doc: number) => `jiange:doc-wide:${user}:${doc}`;
const prefsKey = (user: number, doc: number) => `jiange:doc-prefs:v1:${user}:${doc}`;

export function readDocWidth(user: number, doc: number): DocWidth {
  try {
    const value = typeof localStorage !== "undefined" ? localStorage.getItem(key(user, doc)) : null;
    // "1" is the previous version's full-width setting.
    return value === "1" || value === "full" ? "full" : value === "wider" ? "wider" : "default";
  } catch { return "default"; }
}

export function writeDocWidth(user: number, doc: number, width: DocWidth) {
  try {
    if (width === "default") localStorage.removeItem(key(user, doc));
    else localStorage.setItem(key(user, doc), width === "full" ? "1" : width);
  } catch { /* The preference remains active for this session. */ }
}

export function readDocPrefs(user: number, doc: number): DocPagePrefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(prefsKey(user, doc)) : null;
    if (!raw) return DEFAULT_DOC_PREFS;
    const parsed = JSON.parse(raw) as Partial<DocPagePrefs>;
    return {
      fontFamily: parsed.fontFamily === "serif" || parsed.fontFamily === "mono" ? parsed.fontFamily : "default",
      fontSize: parsed.fontSize === "sm" || parsed.fontSize === "lg" ? parsed.fontSize : "md",
      paperBg: parsed.paperBg === "warm" || parsed.paperBg === "green" || parsed.paperBg === "gray" ? parsed.paperBg : "white",
      autoNumberHeadings: parsed.autoNumberHeadings === true,
      locked: parsed.locked === true,
    };
  } catch {
    return DEFAULT_DOC_PREFS;
  }
}

export function writeDocPrefs(user: number, doc: number, prefs: DocPagePrefs) {
  try {
    localStorage.setItem(prefsKey(user, doc), JSON.stringify(prefs));
  } catch { /* Keep preference in memory for this session. */ }
}

export const docWidthClass = (width: DocWidth) => width === "full" ? "max-w-none" : width === "wider" ? "max-w-[1200px]" : "max-w-[960px]";

export const docFontFamilyClass = (font: DocFontFamily) =>
  font === "serif" ? "font-serif" : font === "mono" ? "font-mono" : "font-sans";

export const docFontSizeClass = (size: DocFontSize) =>
  size === "sm" ? "[&_[data-editor]_[data-type='paragraph']]:text-[14px] [&_[data-editor]_[data-type='bullet']]:text-[14px] [&_[data-editor]_[data-type='ordered']]:text-[14px] [&_[data-editor]_[data-type='todo']]:text-[14px] [&_[data-editor]_[data-type='toggle']]:text-[14px]" :
  size === "lg" ? "[&_[data-editor]_[data-type='paragraph']]:text-[18px] [&_[data-editor]_[data-type='bullet']]:text-[18px] [&_[data-editor]_[data-type='ordered']]:text-[18px] [&_[data-editor]_[data-type='todo']]:text-[18px] [&_[data-editor]_[data-type='toggle']]:text-[18px]" : "";

export const docPaperBgClass = (bg: DocPaperBg) =>
  bg === "warm" ? "bg-[#FAF6EE] dark:bg-[#1f1d18]" :
  bg === "green" ? "bg-[#EFF7F0] dark:bg-[#161f18]" :
  bg === "gray" ? "bg-[#F5F6F7] dark:bg-[#191b1f]" : "";
