import { useI18n } from "@/lib/i18n";
import { Languages } from "lucide-react";

/** 语言切换：显示目标语言名，点击在 中文/English 之间切换。 */
export function LocaleToggle({ className }: { className?: string }) {
  const { locale, setLocale } = useI18n();
  return (
    <button
      type="button"
      className={className ?? "inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"}
      onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")}
      aria-label={locale === "zh-CN" ? "切换到 English" : "切换到中文"}
      data-locale-toggle
    >
      <Languages size={13} strokeWidth={1.7} />
      {locale === "zh-CN" ? "English" : "中文"}
    </button>
  );
}
