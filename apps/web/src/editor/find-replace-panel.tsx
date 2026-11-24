import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CircleHelp, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type FindReplaceMode = "find" | "replace";

export interface FindReplacePanelProps {
  mode: FindReplaceMode;
  query: string;
  replacement: string;
  matchCount: number;
  /** Zero-based current match, or -1 if there is no active match. */
  activeIndex: number;
  canReplace: boolean;
  canReplaceAll?: boolean;
  caseSensitive?: boolean;
  includeMath?: boolean;
  scopeNotice?: string;
  /** Constraints that affect the current results and should remain visible. */
  warningMessage?: string;
  /** Result, conflict, or limit feedback from the caller. */
  statusMessage?: string;
  /** Touch-accessible history for a confirmed replacement. */
  historyAction?: { label: string; disabled: boolean; onClick: () => void };
  className?: string;
  onModeChange: (mode: FindReplaceMode) => void;
  onQueryChange: (value: string) => void;
  onReplacementChange: (value: string) => void;
  onCaseSensitiveChange?: (value: boolean) => void;
  onIncludeMathChange?: (value: boolean) => void;
  onNavigate: (direction: -1 | 1) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

/** Controlled document find/replace panel. The caller owns matching and edits. */
export function FindReplacePanel({
  mode, query, replacement, matchCount, activeIndex, canReplace, canReplaceAll = canReplace, caseSensitive = false, includeMath = false, scopeNotice, warningMessage, statusMessage, historyAction, className,
  onModeChange, onQueryChange, onReplacementChange, onCaseSensitiveChange, onIncludeMathChange, onNavigate, onReplace, onReplaceAll, onClose,
}: FindReplacePanelProps) {
  const { t } = useI18n();
  const id = useId();
  const queryRef = useRef<HTMLInputElement>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const count = Math.max(0, matchCount);
  const current = count > 0 && activeIndex >= 0 ? Math.min(activeIndex + 1, count) : 0;
  const hasMatch = count > 0 && activeIndex >= 0;
  const replaceMode = mode === "replace";

  useEffect(() => {
    // Opening a floating tool should not summon a mobile soft keyboard.
    if (!window.matchMedia("(pointer: coarse)").matches) queryRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const onQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing && hasMatch) {
      event.preventDefault();
      onNavigate(event.shiftKey ? -1 : 1);
    }
  };

  const action = "h-8 min-w-0 rounded-[5px] border px-2 text-[14px] text-foreground hover:bg-hover disabled:cursor-not-allowed disabled:text-[#b6bbc1] disabled:hover:bg-transparent";
  return (
    <section
      role="search"
      aria-label={t("文档内查找和替换")}
      className={cn("absolute bottom-4 right-4 top-auto z-40 max-h-[calc(100dvh-88px)] w-[405px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-lg border bg-surface px-6 pb-6 shadow-[0_4px_16px_rgba(31,35,41,0.16)] min-[480px]:bottom-auto min-[480px]:top-[72px]", className)}
      data-find-replace-panel
    >
      <div className="flex h-12 items-stretch border-b" role="tablist" aria-label={t("查找和替换")}>
        {([ ["find", t("查找")], ["replace", t("替换")] ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            id={`${id}-${value}`}
            role="tab"
            aria-selected={mode === value}
            aria-controls={`${id}-content`}
            onClick={() => onModeChange(value)}
            className={cn("relative mr-7 text-[16px] text-foreground hover:text-primary", mode === value && "font-medium text-[#1456f0] after:absolute after:inset-x-0 after:bottom-[-1px] after:h-[3px] after:rounded-full after:bg-[#1456f0]")}
          >{label}</button>
        ))}
        {scopeNotice && <button type="button" aria-label={t("搜索范围")} aria-expanded={scopeOpen} aria-controls={`${id}-scope`} onClick={() => setScopeOpen((open) => !open)} className="ml-auto grid size-8 self-center place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground"><CircleHelp size={15} strokeWidth={1.5} /></button>}
        <button type="button" aria-label={t("关闭查找和替换")} onClick={onClose} className={cn("grid size-8 self-center place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground", !scopeNotice && "ml-auto")}><X size={18} strokeWidth={1.5} /></button>
      </div>

      <div id={`${id}-content`} role="tabpanel" aria-labelledby={`${id}-${mode}`} className={replaceMode ? "pt-[17px]" : "pt-6"}>
        {replaceMode && <label htmlFor={`${id}-query`} className="mb-2 block text-[14px] text-foreground">{t("查找")}</label>}
        <div className="relative">
          <input
            ref={queryRef}
            id={`${id}-query`}
            aria-label={replaceMode ? undefined : t("查找")}
            aria-describedby={scopeNotice ? `${id}-scope` : undefined}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onQueryKeyDown}
            autoComplete="off"
            placeholder={t("在文档内查找")}
            className="h-8 w-full rounded-[5px] border bg-surface pl-2.5 pr-16 text-base outline-none placeholder:text-subtle focus:border-[#1456f0] sm:text-[14px]"
          />
          <span aria-live="polite" aria-atomic="true" className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[14px] tabular-nums text-muted-foreground">{current} / {count}</span>
        </div>
        {replaceMode && <div className="mt-[17px]">
          <label htmlFor={`${id}-replacement`} className="mb-2 block text-[14px] text-foreground">{t("替换为")}</label>
          <input id={`${id}-replacement`} value={replacement} onChange={(event) => onReplacementChange(event.target.value)} autoComplete="off" placeholder={t("请输入文字")} className="h-8 w-full rounded-[5px] border bg-surface px-2.5 text-base outline-none placeholder:text-subtle focus:border-[#1456f0] sm:text-[14px]" />
        </div>}
        {(onCaseSensitiveChange || onIncludeMathChange) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {onCaseSensitiveChange && (
              <button
                type="button"
                aria-pressed={caseSensitive}
                data-find-case-sensitive
                onClick={() => onCaseSensitiveChange(!caseSensitive)}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-[5px] border px-2 text-[12px]",
                  caseSensitive
                    ? "border-[#1456f0] bg-[#1456f0]/10 font-medium text-[#1456f0]"
                    : "border-border text-muted-foreground hover:bg-hover hover:text-foreground",
                )}
              >
                <span className="font-mono text-[11px] font-semibold">Aa</span>
                <span>{t("区分大小写")}</span>
              </button>
            )}
            {onIncludeMathChange && (
              <button
                type="button"
                aria-pressed={includeMath}
                data-find-include-math
                onClick={() => onIncludeMathChange(!includeMath)}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-[5px] border px-2 text-[12px]",
                  includeMath
                    ? "border-[#1456f0] bg-[#1456f0]/10 font-medium text-[#1456f0]"
                    : "border-border text-muted-foreground hover:bg-hover hover:text-foreground",
                )}
              >
                <span className="font-serif text-[13px] font-semibold leading-none">Σ</span>
                <span>{t("包含公式")}</span>
              </button>
            )}
          </div>
        )}
        {scopeNotice && <p id={`${id}-scope`} className={scopeOpen ? "mt-3 text-[12px] leading-5 text-subtle" : "sr-only"}>{scopeNotice}</p>}
        {warningMessage && <p role="status" className="mt-3 text-[12px] leading-5 text-muted-foreground">{warningMessage}</p>}
        {statusMessage && <p role="status" aria-live="polite" className="mt-2 text-[12px] leading-5 text-muted-foreground">{statusMessage}</p>}
        {historyAction && <button type="button" disabled={historyAction.disabled} onClick={historyAction.onClick} className="mt-2 text-[13px] text-primary hover:underline disabled:opacity-50 min-[480px]:hidden">{historyAction.label}</button>}
        <div className={cn("mt-6 grid gap-3", replaceMode ? "grid-cols-2 min-[480px]:grid-cols-4" : "grid-cols-[80px_80px] justify-end")}>
          {replaceMode && <>
            <button type="button" className={cn(action, "border-[#1456f0] bg-[#1456f0] text-white hover:bg-[#0f4dd6] disabled:border-[#b6bbc1] disabled:bg-[#b6bbc1] disabled:text-white disabled:hover:bg-[#b6bbc1]")} disabled={!hasMatch || !canReplaceAll} onClick={onReplaceAll}>{t("全部替换")}</button>
            <button type="button" className={action} disabled={!hasMatch || !canReplace} onClick={onReplace}>{t("替换")}</button>
          </>}
          <button type="button" className={action} disabled={!hasMatch} onClick={() => onNavigate(-1)}>{t("上一处")}</button>
          <button type="button" className={action} disabled={!hasMatch} onClick={() => onNavigate(1)}>{t("下一处")}</button>
        </div>
      </div>
    </section>
  );
}
