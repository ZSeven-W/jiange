import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CornerDownLeft, Loader2, Sparkles, Wand2, X } from "lucide-react";
import type { SheetCell, SheetWorksheet } from "@/lib/api";
import { aiErrorText } from "@/lib/ai";
import { aiSuiteApi, type SheetAssistResponse } from "@/lib/ai-suite-api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { EvaluatedSheetMap } from "./workbook-engine";

export const SHEET_AI_PRESETS = [
  "按首列汇总数值",
  "计算平均值",
  "筛选大于均值行",
  "正则校验邮箱",
] as const;

export interface SheetAiContext {
  headers: string[];
  sampleRows: string[][];
}

function readDisplayText(evalMap: EvaluatedSheetMap, cellByKey: ReadonlyMap<string, SheetCell>, r: number, c: number): string {
  const key = `${r}:${c}`;
  const ev = evalMap[key];
  if (ev) {
    if (ev.kind === "number" && Number.isFinite(ev.value)) return String(ev.value);
    if (ev.kind === "string") return ev.value.trim();
    if (ev.kind === "boolean") return ev.value ? "TRUE" : "FALSE";
  }
  return (cellByKey.get(key)?.raw ?? "").trim();
}

/** Extract column headers (row 0) and up to 20 sample data rows (rows 1..20) from the active sheet. */
export function extractSheetAiContext(
  sheet: Pick<SheetWorksheet, "rows" | "columns">,
  evalMap: EvaluatedSheetMap,
  cellByKey: ReadonlyMap<string, SheetCell>,
): SheetAiContext {
  const maxRowsToScan = Math.min(sheet.rows.length, 21);
  const maxColsToScan = Math.min(sheet.columns.length, 26);

  let maxCol = -1;
  let maxRow = -1;
  for (let r = 0; r < maxRowsToScan; r++) {
    for (let c = 0; c < maxColsToScan; c++) {
      if (readDisplayText(evalMap, cellByKey, r, c) !== "") {
        if (c > maxCol) maxCol = c;
        if (r > maxRow) maxRow = r;
      }
    }
  }
  if (maxCol < 0 || maxRow < 0) {
    return { headers: [], sampleRows: [] };
  }

  const colCount = maxCol + 1;
  const headers: string[] = [];
  for (let c = 0; c < colCount; c++) {
    headers.push(readDisplayText(evalMap, cellByKey, 0, c));
  }
  const sampleRows: string[][] = [];
  for (let r = 1; r <= maxRow; r++) {
    const rowVals: string[] = [];
    let hasValue = false;
    for (let c = 0; c < colCount; c++) {
      const val = readDisplayText(evalMap, cellByKey, r, c);
      if (val !== "") hasValue = true;
      rowVals.push(val);
    }
    if (hasValue) sampleRows.push(rowVals);
  }
  return { headers, sampleRows };
}

export interface SheetAiPopoverProps {
  sheetTitle: string;
  activeCell: string;
  headers: string[];
  sampleRows: string[][];
  canEdit: boolean;
  anchorRect: { left: number; top: number; bottom: number; right: number };
  onApplyFormula: (formula: string) => Promise<void> | void;
  onClose: () => void;
  /** Optional initial response (for testing). */
  initialResult?: SheetAssistResponse | null;
}

export function SheetAiPopover({
  sheetTitle,
  activeCell,
  headers,
  sampleRows,
  canEdit,
  anchorRect,
  onApplyFormula,
  onClose,
  initialResult = null,
}: SheetAiPopoverProps) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SheetAssistResponse | null>(initialResult);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest("[data-sheet-ai-btn]")) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const popW = Math.min(416, vw - 16);
  const left = Math.max(8, Math.min(anchorRect.left, vw - popW - 8));
  const top = anchorRect.bottom + 6 + 380 <= vh ? anchorRect.bottom + 6 : Math.max(8, vh - 396);

  const runAssist = async (rawPrompt?: string) => {
    const q = (rawPrompt ?? prompt).trim();
    if (!q || busy) return;
    if (rawPrompt !== undefined) setPrompt(q);
    setBusy(true);
    setError("");
    setApplied(false);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await aiSuiteApi.sheetAssist(
        {
          prompt: q,
          headers,
          sampleRows,
          activeCell,
          sheetTitle,
        },
        controller.signal,
      );
      setResult(res);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(aiErrorText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!result?.suggestedFormula || !canEdit || applying) return;
    setApplying(true);
    try {
      await onApplyFormula(result.suggestedFormula);
      setApplied(true);
      onClose();
    } catch (err) {
      setError(aiErrorText(err));
    } finally {
      setApplying(false);
    }
  };

  const content = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("表格 AI 助手")}
      data-sheet-ai-popover
      style={{ left, top, width: popW }}
      className="fixed z-[125] rounded-xl border border-[#dee0e3] bg-white p-3.5 text-[12.5px] text-[#1f2329] shadow-[0_10px_32px_rgba(31,35,41,0.18)]"
    >
      {/* Header */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="grid size-6 place-items-center rounded-md bg-[#eef3ff] text-[#3370ff]">
            <Wand2 size={13} />
          </span>
          <span className="text-[13.5px] font-semibold text-[#1f2329]">{t("表格 AI 助手")}</span>
          <span className="rounded bg-[#f2f3f5] px-1.5 py-0.5 font-mono text-[11px] text-[#646a73]">
            {activeCell}
          </span>
        </div>
        <button
          type="button"
          aria-label={t("关闭")}
          onClick={onClose}
          className="grid size-6 place-items-center rounded text-[#8f959e] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
        >
          <X size={14} />
        </button>
      </div>

      {/* Input row */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runAssist();
        }}
        className="flex items-center gap-1.5"
      >
        <input
          ref={inputRef}
          type="text"
          value={prompt}
          disabled={busy}
          data-sheet-ai-input
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("输入公式或数据分析需求，如：按部门求和")}
          className="h-8 min-w-0 flex-1 rounded-md border border-[#dee0e3] bg-[#f7f8fa] px-2.5 text-[12.5px] outline-none focus:border-[#3370ff] focus:bg-white"
        />
        <button
          type="submit"
          disabled={busy || !prompt.trim()}
          data-sheet-ai-submit
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-[#3370ff] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#245bdb] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          <span>{busy ? t("生成中…") : t("生成公式")}</span>
        </button>
      </form>

      {/* Quick preset chips */}
      <div className="mt-2.5 flex flex-wrap gap-1.5" data-sheet-ai-presets>
        {SHEET_AI_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={busy}
            data-sheet-ai-preset={preset}
            onClick={() => void runAssist(t(preset))}
            className="inline-flex h-6 items-center rounded-full border border-[#dee0e3] bg-[#f7f8fa] px-2.5 text-[11.5px] text-[#4b5058] transition-colors hover:border-[#3370ff] hover:bg-[#eef3ff] hover:text-[#3370ff] disabled:opacity-45"
          >
            {t(preset)}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="mt-2.5 rounded-md border border-[#ffccc7] bg-[#fff2f0] px-2.5 py-1.5 text-[12px] text-[#d83931]">
          {error}
        </div>
      )}

      {/* Result card */}
      {result && (
        <div className="mt-3 space-y-2.5 rounded-lg border border-[#e5e6eb] bg-[#fafbfc] p-3" data-sheet-ai-result>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11.5px] font-medium text-[#646a73]">{t("推荐结果")}</span>
            <span
              data-sheet-ai-mode={result.mode}
              className={cn(
                "rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                result.mode === "llm"
                  ? "bg-[#eef3ff] text-[#3370ff]"
                  : "bg-[#f2f3f5] text-[#646a73]",
              )}
            >
              {result.mode === "llm" ? t("AI 模型") : t("内置公式引擎")}
            </span>
          </div>

          <p className="text-[12.5px] leading-5 text-[#1f2329]">{result.answer}</p>

          {result.suggestedFormula && (
            <div className="rounded-md border border-[#d6e4ff] bg-[#f0f5ff] p-2.5">
              <div className="flex items-start justify-between gap-2">
                <code
                  data-sheet-ai-formula
                  className="block min-w-0 flex-1 break-all font-mono text-[12.5px] font-medium text-[#1b4ddb]"
                >
                  {result.suggestedFormula}
                </code>
              </div>
              <div className="mt-2 flex items-center justify-end gap-2">
                {!canEdit && (
                  <span className="text-[11px] text-[#8f959e]">{t("只读模式不可写入")}</span>
                )}
                <button
                  type="button"
                  disabled={!canEdit || applying}
                  data-sheet-ai-apply
                  onClick={() => void handleApply()}
                  className="inline-flex h-7 items-center gap-1 rounded bg-[#3370ff] px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-[#245bdb] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {applied ? <Check size={13} /> : <CornerDownLeft size={13} />}
                  <span>{t("填入当前单元格")}</span>
                </button>
              </div>
            </div>
          )}

          {result.explanation && (
            <p data-sheet-ai-explanation className="text-[11.5px] leading-5 text-[#646a73]">
              {result.explanation}
            </p>
          )}
        </div>
      )}
    </div>
  );

  return typeof document !== "undefined" ? createPortal(content, document.body) : content;
}
