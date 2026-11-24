import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { DocFontFamily, DocFontSize, DocPagePrefs, DocPaperBg, DocWidth } from "@/lib/doc-width";

export function DocWidthOptions({
  width,
  onChange,
  prefs,
  onPrefsChange,
}: {
  width: DocWidth;
  onChange: (value: DocWidth) => void;
  prefs?: DocPagePrefs;
  onPrefsChange?: (patch: Partial<DocPagePrefs>) => void;
}) {
  const { t } = useI18n();
  const widthOptions: { value: DocWidth; label: string; lines: number }[] = [
    { value: "default", label: t("默认"), lines: 16 },
    { value: "wider", label: t("较宽"), lines: 22 },
    { value: "full", label: t("全宽"), lines: 28 },
  ];
  const fontSizes: { value: DocFontSize; label: string }[] = [
    { value: "sm", label: t("小") },
    { value: "md", label: t("标准") },
    { value: "lg", label: t("大") },
  ];
  const fontFamilies: { value: DocFontFamily; label: string; sample: string }[] = [
    { value: "default", label: t("默认"), sample: "font-sans" },
    { value: "serif", label: t("衬线"), sample: "font-serif" },
    { value: "mono", label: t("等宽"), sample: "font-mono" },
  ];
  const paperTints: { value: DocPaperBg; label: string; swatch: string }[] = [
    { value: "white", label: t("纯净白"), swatch: "#FFFFFF" },
    { value: "warm", label: t("暖米黄"), swatch: "#FAF6EE" },
    { value: "green", label: t("护眼绿"), swatch: "#EFF7F0" },
    { value: "gray", label: t("淡雅灰"), swatch: "#F5F6F7" },
  ];

  return (
    <div
      className="w-full space-y-3.5 rounded-lg border border-[#DEE0E3] bg-surface p-3.5 shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border sm:w-[264px]"
      role="radiogroup"
      aria-label={t("页面设置")}
      data-doc-width-options
    >
      <div>
        <div className="mb-2 text-[12px] text-[#8F959E]">{t("为当前窗口选择合适页宽")}</div>
        <div className="flex items-center justify-between gap-2">
          {widthOptions.map(({ value, label, lines }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={width === value}
              onClick={() => onChange(value)}
              data-doc-width-option={value}
              className={cn(
                "flex h-[62px] flex-1 flex-col items-center justify-center gap-1 rounded-md border text-[12px] transition-colors",
                width === value ? "border-[#3370FF] bg-[#F2F6FF] font-medium text-[#3370FF]" : "border-[#DEE0E3] text-[#646A73] hover:bg-hover dark:border-border",
              )}
            >
              <span aria-hidden="true" className={cn("grid h-[26px] w-[42px] place-items-center rounded-sm", width === value ? "bg-[#E1EAFF]" : "bg-[#F2F3F5] dark:bg-hover")}>
                <svg width="32" height="18" viewBox="0 0 32 20" fill="none">
                  <path d={`M${(32 - lines) / 2} 5h${lines} M${(32 - lines) / 2} 8h${lines} M${(32 - lines) / 2} 11h${lines} M${(32 - lines) / 2} 14h${lines}`} stroke={width === value ? "#3370FF" : "#BBBFC4"} strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </span>
              {label}
            </button>
          ))}
        </div>
      </div>

      {prefs && onPrefsChange && (
        <>
          <div className="border-t border-[#EFF0F1] pt-3 dark:border-border">
            <div className="mb-2 text-[12px] text-[#8F959E]">{t("字号")}</div>
            <div className="grid grid-cols-3 gap-1 rounded-md bg-[#F5F6F7] p-0.5 dark:bg-sidebar">
              {fontSizes.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  data-doc-fontsize-option={item.value}
                  onClick={() => onPrefsChange({ fontSize: item.value })}
                  className={cn(
                    "h-7 rounded text-[12px] transition-colors",
                    prefs.fontSize === item.value ? "bg-surface font-medium text-[#3370FF] shadow-2xs" : "text-[#646A73] hover:text-foreground",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[12px] text-[#8F959E]">{t("字体")}</div>
            <div className="grid grid-cols-3 gap-1 rounded-md bg-[#F5F6F7] p-0.5 dark:bg-sidebar">
              {fontFamilies.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  data-doc-font-option={item.value}
                  onClick={() => onPrefsChange({ fontFamily: item.value })}
                  className={cn(
                    "h-7 rounded text-[12px] transition-colors",
                    item.sample,
                    prefs.fontFamily === item.value ? "bg-surface font-medium text-[#3370FF] shadow-2xs" : "text-[#646A73] hover:text-foreground",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[12px] text-[#8F959E]">{t("页面背景")}</div>
            <div className="flex items-center gap-2.5">
              {paperTints.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  title={item.label}
                  aria-label={item.label}
                  data-doc-paper-option={item.value}
                  onClick={() => onPrefsChange({ paperBg: item.value })}
                  style={{ backgroundColor: item.swatch }}
                  className={cn(
                    "size-7 rounded-full border transition-shadow",
                    prefs.paperBg === item.value ? "border-[#3370FF] ring-2 ring-[#3370FF]/35" : "border-[#D0D3D6] hover:border-[#8F959E]",
                  )}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-[#EFF0F1] pt-3 dark:border-border">
            <span className="text-[13px] text-foreground">{t("标题自动编号")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={prefs.autoNumberHeadings}
              aria-label={t("标题自动编号")}
              data-doc-autonumber-toggle
              onClick={() => onPrefsChange({ autoNumberHeadings: !prefs.autoNumberHeadings })}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                prefs.autoNumberHeadings ? "bg-[#3370FF]" : "bg-[#D0D3D6] dark:bg-border",
              )}
            >
              <span className={cn("inline-block size-4 rounded-full bg-white shadow-xs transition-transform", prefs.autoNumberHeadings ? "translate-x-[18px]" : "translate-x-0.5")} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
