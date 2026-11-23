import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronUp, Copy } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  formatSheetStatNumber,
  SHEET_STAT_META,
  sheetStatRawValue,
  type SheetSelectionStats,
  type SheetStatKey,
} from "./sheet-selection-stats";

const DEFAULT_PINNED: SheetStatKey[] = ["sum", "avg", "count"];

export function SheetSelectionStatsBar({ stats }: { stats: SheetSelectionStats }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState<SheetStatKey[]>(DEFAULT_PINNED);
  const [copiedKey, setCopiedKey] = useState<SheetStatKey | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const computePos = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const width = 236;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const bottom = Math.max(8, window.innerHeight - rect.top + 6);
    return { left, bottom };
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onResize = () => setPos(computePos());
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const visibleKeys = pinned.filter((key) => {
    const meta = SHEET_STAT_META.find((m) => m.key === key);
    if (!meta) return false;
    return !meta.numericOnly || stats.numericCount > 0;
  });
  const inlineKeys: SheetStatKey[] = visibleKeys.length > 0 ? visibleKeys : ["count"];

  const togglePin = (key: SheetStatKey) => {
    setPinned((prev) => {
      if (prev.includes(key)) {
        return prev.length > 1 ? prev.filter((k) => k !== key) : prev;
      }
      return SHEET_STAT_META.map((m) => m.key).filter((k) => prev.includes(k) || k === key);
    });
  };

  const handleCopy = async (key: SheetStatKey) => {
    const val = sheetStatRawValue(stats, key);
    if (val === null) return;
    try {
      await navigator.clipboard?.writeText(String(val));
    } catch {
      // Clipboard may be unavailable in non-secure/headless environments
    }
    setCopiedKey(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedKey(null), 1400);
  };

  const toggleOpen = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setPos(computePos());
    setOpen(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-sheet-aggregates
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t("点击查看或复制全部统计项")}
        onClick={toggleOpen}
        className={`inline-flex h-6 items-center gap-2 rounded px-2 text-[11px] transition-colors ${
          open ? "bg-[#eef3ff] text-[#3370ff]" : "text-[#4e5969] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
        }`}
      >
        {inlineKeys.map((key) => {
          const meta = SHEET_STAT_META.find((m) => m.key === key)!;
          return (
            <span key={key} className="inline-flex items-center gap-1 whitespace-nowrap">
              <span className="text-[#8f959e]">{t(meta.shortLabel)}:</span>
              <span className="font-medium tabular-nums text-[#1f2329]">{formatSheetStatNumber(sheetStatRawValue(stats, key))}</span>
            </span>
          );
        })}
        <ChevronUp size={12} className={`shrink-0 text-[#8f959e] transition-transform ${open ? "rotate-180 text-[#3370ff]" : ""}`} aria-hidden />
      </button>

      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t("选区统计")}
          data-sheet-stats-popover
          style={{ left: pos.left, bottom: pos.bottom }}
          onPointerDown={(e) => e.stopPropagation()}
          className="fixed z-[120] w-[236px] rounded-lg border border-[#dee0e3] bg-white p-1.5 text-[12px] text-[#1f2329] shadow-[0_8px_28px_rgba(31,35,41,0.16)]"
        >
          <div className="flex items-center justify-between border-b border-[#eff0f1] px-2 pb-1.5 pt-0.5 text-[11px] text-[#8f959e]">
            <span>{t("选区统计")}</span>
            <span className="tabular-nums">{t("已选 {n} 个单元格", { n: stats.totalCells })}</span>
          </div>
          <div className="mt-1 space-y-0.5">
            {SHEET_STAT_META.map((meta) => {
              const rawVal = sheetStatRawValue(stats, meta.key);
              const formatted = formatSheetStatNumber(rawVal);
              const isPinned = pinned.includes(meta.key);
              const isCopied = copiedKey === meta.key;
              return (
                <div
                  key={meta.key}
                  data-sheet-stat-row={meta.key}
                  className="group flex h-8 items-center justify-between gap-2 rounded-md px-2 hover:bg-[#f5f6f7]"
                >
                  <button
                    type="button"
                    onClick={() => togglePin(meta.key)}
                    title={isPinned ? t("从状态栏取消显示") : t("固定到状态栏")}
                    className="flex min-w-0 items-center gap-1.5 text-left"
                  >
                    <span
                      className={`grid size-3.5 shrink-0 place-items-center rounded border ${
                        isPinned
                          ? "border-[#3370ff] bg-[#3370ff] text-white"
                          : "border-[#c9cdd4] bg-white text-transparent"
                      }`}
                    >
                      <Check size={10} strokeWidth={2.5} aria-hidden />
                    </span>
                    <span className="text-[#4e5969]">{t(meta.label)}</span>
                  </button>
                  <button
                    type="button"
                    disabled={rawVal === null}
                    onClick={() => void handleCopy(meta.key)}
                    aria-label={t("复制{label}", { label: t(meta.label) })}
                    title={rawVal === null ? undefined : t("点击复制数值")}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium tabular-nums text-[#1f2329] hover:bg-[#e8efff] hover:text-[#3370ff] disabled:cursor-default disabled:text-[#bbbfc4] disabled:hover:bg-transparent"
                  >
                    {isCopied ? (
                      <span className="text-[11px] text-[#00b42a]">{t("已复制")}</span>
                    ) : (
                      <>
                        <span>{formatted}</span>
                        {rawVal !== null && <Copy size={11} className="text-[#8f959e] opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />}
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
