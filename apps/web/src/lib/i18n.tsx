import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { currentLocale, getLocale, i18nSubscribe, setLocale, t, type Locale } from "@/i18n/core";

export type { Locale };
export { getLocale, setLocale, t };
export type TFunc = typeof t;

const I18nContext = createContext(currentLocale());

/**
 * 语言环境：中文是源语言（key 即文案），英文走 @/i18n/en 字典。
 * `t()` 在 React 之外也可用（读模块级当前语言）；组件通过本 hook
 * 订阅语言变化，切换时重渲染。
 */
export function useI18n(): { locale: Locale; t: TFunc; setLocale: (locale: Locale) => void } {
  const locale = useContext(I18nContext);
  const change = useCallback((next: Locale) => setLocale(next), []);
  return useMemo(() => ({ locale, t, setLocale: change }), [locale, change]);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(currentLocale());
  useEffect(() => i18nSubscribe(() => setLocaleState(currentLocale())), []);
  return <I18nContext.Provider value={locale}>{children}</I18nContext.Provider>;
}
