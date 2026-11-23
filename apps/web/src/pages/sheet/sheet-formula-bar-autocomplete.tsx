import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";
import {
  FORMULA_CATEGORY_LABELS,
  resolveActiveArgHighlightIndex,
  type FormulaCaretInspection,
} from "./sheet-formula-autocomplete";

export interface FormulaPopoverAnchorRect {
  left: number;
  bottom: number;
  width: number;
}

export interface SheetFormulaBarAutocompleteProps {
  inspection: FormulaCaretInspection;
  anchorRect: FormulaPopoverAnchorRect | null;
  selectedIndex: number;
  onHoverIndex: (idx: number) => void;
  onSelectFunction: (fnName: string) => void;
}

function renderMatchedName(name: string, prefix: string) {
  const upperPrefix = prefix.toUpperCase();
  const idx = upperPrefix ? name.indexOf(upperPrefix) : -1;
  if (idx < 0) return <span>{name}</span>;
  const before = name.slice(0, idx);
  const match = name.slice(idx, idx + upperPrefix.length);
  const after = name.slice(idx + upperPrefix.length);
  return (
    <>
      {before && <span>{before}</span>}
      <span className="text-[#3370ff]">{match}</span>
      {after && <span>{after}</span>}
    </>
  );
}

export function SheetFormulaBarAutocomplete({
  inspection,
  anchorRect,
  selectedIndex,
  onHoverIndex,
  onSelectFunction,
}: SheetFormulaBarAutocompleteProps) {
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (inspection.mode === "complete") {
      activeItemRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [inspection.mode, selectedIndex]);

  if (inspection.mode === "none" || !anchorRect) return null;

  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;

  let content: React.ReactNode = null;

  if (inspection.mode === "complete") {
    const width = 348;
    const left = Math.max(8, Math.min(anchorRect.left, vw - width - 8));
    const top = Math.min(anchorRect.bottom + 4, Math.max(8, vh - 280));
    const safeIdx = Math.max(0, Math.min(selectedIndex, inspection.matches.length - 1));

    content = (
      <div
        role="listbox"
        aria-label={t("公式自动补全")}
        data-sheet-formula-autocomplete
        style={{ left, top, width }}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.preventDefault()}
        className="fixed z-[130] overflow-hidden rounded-lg border border-[#dee0e3] bg-white text-[12px] text-[#1f2329] shadow-[0_8px_28px_rgba(31,35,41,0.16)]"
      >
        <div className="max-h-[244px] overflow-y-auto py-1">
          {inspection.matches.map((spec, idx) => {
            const active = idx === safeIdx;
            return (
              <button
                key={spec.name}
                ref={active ? activeItemRef : undefined}
                type="button"
                role="option"
                aria-selected={active}
                data-sheet-formula-option={spec.name}
                onMouseEnter={() => onHoverIndex(idx)}
                onClick={() => onSelectFunction(spec.name)}
                className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors ${
                  active ? "bg-[#eef3ff]" : "hover:bg-[#f5f6f7]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[12.5px] font-semibold tracking-tight text-[#1f2329]">
                    {renderMatchedName(spec.name, inspection.prefix)}
                    <span className="font-normal text-[#8f959e]">
                      ({spec.args.slice(0, 3).join(", ")}
                      {spec.args.length > 3 ? ", ..." : ""})
                    </span>
                  </span>
                  <span className="shrink-0 rounded bg-[#f2f3f5] px-1.5 py-0.5 text-[10px] text-[#646a73]">
                    {t(FORMULA_CATEGORY_LABELS[spec.category])}
                  </span>
                </div>
                <span className="truncate text-[11px] text-[#646a73]">{spec.description}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between border-t border-[#eff0f1] bg-[#fafbfc] px-3 py-1 text-[10.5px] text-[#8f959e]">
          <span>{t("↑↓ 选择 · Tab / Enter 插入")}</span>
          <span>{t("Esc 关闭")}</span>
        </div>
      </div>
    );
  } else if (inspection.mode === "signature") {
    const width = 416;
    const left = Math.max(8, Math.min(anchorRect.left, vw - width - 8));
    const top = Math.min(anchorRect.bottom + 4, Math.max(8, vh - 120));
    const { spec, activeArgIndex } = inspection;
    const highlightIdx = resolveActiveArgHighlightIndex(spec.args, activeArgIndex);

    content = (
      <div
        role="tooltip"
        aria-label={t("函数参数提示")}
        data-sheet-formula-signature={spec.name}
        style={{ left, top, maxWidth: width }}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.preventDefault()}
        className="fixed z-[130] rounded-lg border border-[#dee0e3] bg-white px-3 py-2 text-[12px] text-[#1f2329] shadow-[0_8px_28px_rgba(31,35,41,0.16)]"
      >
        <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1 font-mono text-[12.5px] leading-snug">
          <span className="font-semibold text-[#1f2329]">{spec.name}(</span>
          {spec.args.length === 0 ? (
            <span className="text-[#8f959e]">{t("无参数")}</span>
          ) : (
            spec.args.map((arg, idx) => {
              const isActive = idx === highlightIdx;
              return (
                <span key={`${arg}-${idx}`} className="inline-flex items-center">
                  <span
                    data-sheet-formula-active-arg={isActive ? String(activeArgIndex) : undefined}
                    className={
                      isActive
                        ? "rounded bg-[#eef3ff] px-1 py-0.5 font-bold text-[#3370ff]"
                        : "text-[#646a73]"
                    }
                  >
                    {arg}
                  </span>
                  {idx < spec.args.length - 1 && <span className="pr-1 text-[#8f959e]">,</span>}
                </span>
              );
            })
          )}
          <span className="font-semibold text-[#1f2329]">)</span>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[#646a73]">{spec.description}</p>
      </div>
    );
  }

  if (!content) return null;
  if (typeof document !== "undefined") {
    return createPortal(content, document.body);
  }
  return <>{content}</>;
}
