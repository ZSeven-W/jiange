import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownAZ, ArrowUpAZ, Check, Search, X } from "lucide-react";
import type { SheetColumnFilter, SheetFilterConfig, SheetWorksheet } from "@/lib/api";
import { t } from "@/lib/i18n";
import { buildWorksheetGridMap, formatCellDisplay, type EvaluatedSheetMap } from "./workbook-engine";

export interface ColumnFilterOption {
  value: string;
  count: number;
  isBlank: boolean;
}

export interface SheetColumnFilterAnchor {
  left: number;
  top: number;
  bottom: number;
  right: number;
  width: number;
}

export interface SheetColumnFilterPopoverProps {
  col: number;
  colLabel: string;
  options: readonly ColumnFilterOption[];
  activeRule: SheetColumnFilter | undefined;
  anchorRect: SheetColumnFilterAnchor;
  canSort?: boolean;
  onSort: (ascending: boolean) => void;
  onApply: (selectedValues: string[] | null) => void;
  onClose: () => void;
}

export function isColumnFilterActive(rule: SheetColumnFilter | undefined): boolean {
  if (!rule) return false;
  if (rule.values && rule.values.length > 0) return true;
  if (rule.query && rule.query.trim().length > 0) return true;
  return false;
}

/**
 * Collect all unique displayed values and their occurrence counts in `col` across
 * the active data region (rows `headerRow + 1` through the last non-empty row in the sheet).
 */
export function collectColumnFilterOptions(
  sheet: SheetWorksheet,
  evalMap: EvaluatedSheetMap,
  col: number,
  headerRow = sheet.filter?.headerRow ?? 0,
): ColumnFilterOption[] {
  const safeHeader = Math.max(0, headerRow);
  const { cellByKey } = buildWorksheetGridMap(sheet);
  let lastDataRow = safeHeader;
  for (let r = safeHeader + 1; r < sheet.rows.length; r++) {
    for (let c = 0; c < sheet.columns.length; c++) {
      const cell = cellByKey.get(`${r}:${c}`);
      if (cell && cell.raw !== "") {
        lastDataRow = r;
        break;
      }
    }
  }
  if (lastDataRow <= safeHeader) return [];

  const counts = new Map<string, number>();
  for (let r = safeHeader + 1; r <= lastDataRow; r++) {
    const cell = cellByKey.get(`${r}:${col}`);
    const ev = evalMap[`${r}:${col}`];
    const text = formatCellDisplay(cell?.raw ?? "", ev, cell?.style);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }

  const options: ColumnFilterOption[] = [];
  for (const [value, count] of counts.entries()) {
    options.push({ value, count, isBlank: value === "" });
  }
  options.sort((a, b) => {
    if (a.isBlank !== b.isBlank) return a.isBlank ? 1 : -1;
    return a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" });
  });
  return options;
}

export function resolveInitialFilterSelection(
  options: readonly ColumnFilterOption[],
  rule: SheetColumnFilter | undefined,
): Set<string> {
  if (!rule || (!rule.values?.length && !rule.query?.trim())) {
    return new Set(options.map((o) => o.value));
  }
  const hasValues = Array.isArray(rule.values) && rule.values.length > 0;
  const valSet = hasValues ? new Set(rule.values) : null;
  const q = rule.query?.trim().toLowerCase() ?? "";
  const selected = new Set<string>();
  for (const opt of options) {
    if (valSet && !valSet.has(opt.value)) continue;
    if (q && !opt.value.toLowerCase().includes(q)) continue;
    selected.add(opt.value);
  }
  return selected;
}

export function buildNextColumnFilterConfig(
  current: SheetFilterConfig | undefined,
  col: number,
  selectedValues: readonly string[] | null,
  totalOptionCount: number,
): SheetFilterConfig {
  const nextRules: Record<string, SheetColumnFilter> = { ...(current?.rules ?? {}) };
  if (selectedValues === null || (totalOptionCount > 0 && selectedValues.length >= totalOptionCount)) {
    delete nextRules[String(col)];
  } else if (selectedValues.length > 0) {
    nextRules[String(col)] = { values: [...selectedValues] };
  }
  return {
    headerRow: current?.headerRow ?? 0,
    ...current,
    enabled: true,
    rules: nextRules,
  };
}

export function SheetColumnFilterPopover({
  col,
  colLabel,
  options,
  activeRule,
  anchorRect,
  canSort = true,
  onSort,
  onApply,
  onClose,
}: SheetColumnFilterPopoverProps) {
  const [search, setSearch] = useState("");
  const [selectedValues, setSelectedValues] = useState<Set<string>>(() =>
    resolveInitialFilterSelection(options, activeRule),
  );
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearch("");
    setSelectedValues(resolveInitialFilterSelection(options, activeRule));
  }, [col, options, activeRule]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(`[data-sheet-col-filter-btn="${col}"]`)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target && popoverRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    const blankLabel = t("(空白)").toLowerCase();
    return options.filter((opt) =>
      opt.isBlank ? blankLabel.includes(q) : opt.value.toLowerCase().includes(q),
    );
  }, [options, search]);

  const toggleValue = (val: string) => {
    setSelectedValues((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedValues((prev) => {
      const next = new Set(prev);
      for (const opt of filteredOptions) next.add(opt.value);
      return next;
    });
  };

  const clearAllVisible = () => {
    setSelectedValues((prev) => {
      const next = new Set(prev);
      for (const opt of filteredOptions) next.delete(opt.value);
      return next;
    });
  };

  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const width = 272;
  const estHeight = 368;
  const left = Math.max(8, Math.min(anchorRect.left, vw - width - 8));
  const fitsBelow = anchorRect.bottom + 4 + estHeight <= vh - 8;
  const top = fitsBelow ? anchorRect.bottom + 4 : Math.max(8, anchorRect.top - estHeight - 4);

  const hasActiveFilter = isColumnFilterActive(activeRule);
  const allSelected = options.length > 0 && selectedValues.size >= options.length;
  const confirmDisabled = options.length > 0 && selectedValues.size === 0;

  const content = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={t("筛选列 {col}", { col: colLabel })}
      data-sheet-col-filter={col}
      style={{ left, top, width }}
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-[125] flex flex-col rounded-lg border border-[#dee0e3] bg-white p-2.5 text-[12px] text-[#1f2329] shadow-[0_8px_28px_rgba(31,35,41,0.16)]"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 pb-2">
        <span className="truncate font-medium text-[#1f2329]">{colLabel}</span>
        <button
          type="button"
          aria-label={t("关闭")}
          onClick={onClose}
          className="grid size-6 shrink-0 place-items-center rounded text-[#8f959e] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
        >
          <X size={14} />
        </button>
      </div>

      {/* Sort shortcuts */}
      {canSort && (
        <div className="grid grid-cols-2 gap-1.5 border-y border-[#eff0f1] py-2">
          <button
            type="button"
            data-sheet-col-sort="asc"
            onClick={() => {
              onSort(true);
              onClose();
            }}
            className="flex h-7 items-center justify-center gap-1 rounded border border-[#dee0e3] bg-white text-[11.5px] text-[#4b5058] hover:border-[#3370ff] hover:bg-[#f5f8ff] hover:text-[#3370ff]"
          >
            <ArrowUpAZ size={13} />
            <span>{t("升序 A→Z")}</span>
          </button>
          <button
            type="button"
            data-sheet-col-sort="desc"
            onClick={() => {
              onSort(false);
              onClose();
            }}
            className="flex h-7 items-center justify-center gap-1 rounded border border-[#dee0e3] bg-white text-[11.5px] text-[#4b5058] hover:border-[#3370ff] hover:bg-[#f5f8ff] hover:text-[#3370ff]"
          >
            <ArrowDownAZ size={13} />
            <span>{t("降序 Z→A")}</span>
          </button>
        </div>
      )}

      {/* Search input */}
      <div className="relative mt-2">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8f959e]" />
        <input
          autoFocus
          data-sheet-col-filter-search
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("搜索选项")}
          aria-label={t("搜索选项")}
          className="h-8 w-full rounded-md border border-[#dee0e3] bg-[#fafbfc] pl-7 pr-6 text-[12px] text-[#1f2329] outline-none placeholder:text-[#8f959e] focus:border-[#3370ff] focus:bg-white"
        />
        {search && (
          <button
            type="button"
            aria-label={t("清空")}
            onClick={() => setSearch("")}
            className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-[#8f959e] hover:text-[#1f2329]"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Select all / Clear controls */}
      <div className="mt-2 flex items-center justify-between text-[11px]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-sheet-col-filter-select-all
            onClick={selectAllVisible}
            className="font-medium text-[#3370ff] hover:underline"
          >
            {t("全选")}
          </button>
          <span className="text-[#dee0e3]">|</span>
          <button
            type="button"
            data-sheet-col-filter-clear-all
            onClick={clearAllVisible}
            className="text-[#646a73] hover:text-[#1f2329] hover:underline"
          >
            {t("清空")}
          </button>
        </div>
        <span className="tabular-nums text-[#8f959e]">
          {selectedValues.size}/{options.length}
        </span>
      </div>

      {/* Unique value checklist */}
      <div className="mt-1.5 max-h-[200px] min-h-[72px] overflow-y-auto rounded-md border border-[#eff0f1] bg-[#fafbfc] p-1">
        {options.length === 0 ? (
          <p className="py-5 text-center text-[11.5px] text-[#8f959e]">{t("当前列暂无可筛选数据")}</p>
        ) : filteredOptions.length === 0 ? (
          <p className="py-5 text-center text-[11.5px] text-[#8f959e]">{t("无匹配选项")}</p>
        ) : (
          filteredOptions.map((opt) => {
            const checked = selectedValues.has(opt.value);
            return (
              <button
                key={opt.isBlank ? "__blank__" : opt.value}
                type="button"
                role="checkbox"
                aria-checked={checked}
                data-sheet-col-filter-option={opt.isBlank ? "__blank__" : opt.value}
                onClick={() => toggleValue(opt.value)}
                className="flex h-7 w-full items-center justify-between gap-2 rounded px-1.5 text-left hover:bg-[#edf1f7]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={`grid size-3.5 shrink-0 place-items-center rounded border transition-colors ${
                      checked
                        ? "border-[#3370ff] bg-[#3370ff] text-white"
                        : "border-[#c9cdd4] bg-white text-transparent"
                    }`}
                  >
                    <Check size={10} strokeWidth={2.5} aria-hidden />
                  </span>
                  <span className={`truncate text-[12px] ${opt.isBlank ? "italic text-[#8f959e]" : "text-[#1f2329]"}`}>
                    {opt.isBlank ? t("(空白)") : opt.value}
                  </span>
                </span>
                <span className="shrink-0 rounded bg-[#eff0f1] px-1.5 py-0.5 text-[10.5px] tabular-nums text-[#646a73]">
                  {opt.count}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="mt-2.5 flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          data-sheet-col-filter-reset
          disabled={!hasActiveFilter}
          onClick={() => {
            onApply(null);
            onClose();
          }}
          className="rounded px-2 py-1 text-[12px] text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("重置")}
        </button>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClose}
            className="h-7 rounded border border-[#dee0e3] px-2.5 text-[12px] text-[#4b5058] hover:bg-[#f2f3f5]"
          >
            {t("取消")}
          </button>
          <button
            type="button"
            data-sheet-col-filter-confirm
            disabled={confirmDisabled}
            onClick={() => {
              if (options.length === 0 || allSelected) {
                onApply(null);
              } else {
                onApply([...selectedValues]);
              }
              onClose();
            }}
            className="h-7 rounded bg-[#3370ff] px-3 text-[12px] font-medium text-white hover:bg-[#245bdb] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {t("确定")}
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document !== "undefined") {
    return createPortal(content, document.body);
  }
  return content;
}
