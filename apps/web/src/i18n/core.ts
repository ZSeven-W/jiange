import { en } from "./en";

export type Locale = "zh-CN" | "en";

const STORAGE_KEY = "jiange.locale";
const dicts: Record<Locale, Record<string, string>> = { "zh-CN": {}, en };

/** Browser languages → supported locale (default zh-CN). */
export function detectLocale(): Locale {
  if (typeof navigator === "undefined") return "zh-CN";
  for (const lang of navigator.languages ?? [navigator.language]) {
    if (lang.toLowerCase().startsWith("en")) return "en";
    if (lang.toLowerCase().startsWith("zh")) return "zh-CN";
  }
  return "zh-CN";
}

export function getLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh-CN") return saved;
  } catch {
    // storage unavailable (private mode) — fall through to detection
  }
  return detectLocale();
}

// Module-level current locale so t() works outside React (plain utils, tests).
let current: Locale = typeof localStorage === "undefined" ? "zh-CN" : getLocale();
const listeners = new Set<(locale: Locale) => void>();

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // ignore: the in-memory locale still switches for this page
  }
  current = locale;
  for (const listener of listeners) listener(locale);
}

/** The in-memory current locale (agrees with localStorage after setLocale). */
export function currentLocale(): Locale {
  return current;
}

export function i18nSubscribe(listener: () => void): () => void {
  const wrapped = () => listener();
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}

/** Translate the source (Chinese) text, interpolating `{name}` placeholders. */
export const t = (key: string, vars?: Record<string, string | number>): string => {
  let text = dicts[current][key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
};
