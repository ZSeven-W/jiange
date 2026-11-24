import { useI18n } from "@/lib/i18n";
import { Languages } from "lucide-react";

/** 语言切换：显示目标语言名，点击在 中文/English 之间切换。 */
export function LocaleToggle({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  const label = locale === "zh-CN" ? t("切换到 English") : t("切换到中文");
  return (
    <button
      type="button"
      className={
        className ??
        (compact
          ? "grid size-6 shrink-0 place-items-center rounded text-[11px] font-medium text-subtle hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
          : "inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground")
      }
      onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")}
      title={label}
      aria-label={label}
      data-locale-toggle
    >
      {compact ? (locale === "zh-CN" ? "EN" : "中") : <><Languages size={13} strokeWidth={1.7} />{locale === "zh-CN" ? "English" : "中文"}</>}
    </button>
  );
}
