import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check, Loader2, Sparkles, X } from "lucide-react";
import { baseApi, type BaseRecord, type Cell, type Field } from "@/lib/api";
import { aiErrorText } from "@/lib/ai";
import {
  aiSuiteApi,
  type BaseFillPreset,
  type BaseFillRowInput,
} from "@/lib/ai-suite-api";
import { FeishuSelect } from "@/components/feishu-select";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const BASE_AI_FILL_MAX_ROWS = 50;

export const AI_FILL_PRESETS: readonly { value: BaseFillPreset; label: string }[] = [
  { value: "summarize", label: "智能摘要" },
  { value: "classify", label: "自动分类" },
  { value: "extract_keywords", label: "提取关键词" },
  { value: "translate_en", label: "翻译为英文" },
  { value: "custom", label: "自定义提示词" },
];

export interface BaseAiFillPreviewRow {
  recordId: number;
  sourceText: string;
  generatedValue: string;
}

export function isEligibleSourceField(field: Field): boolean {
  return field.type !== "attachment" && field.type !== "button";
}

export function isEligibleTargetField(field: Field, readonlyFieldIds?: ReadonlySet<number>): boolean {
  if (readonlyFieldIds?.has(field.id)) return false;
  return field.type === "text" || field.type === "select" || field.type === "multi_select";
}

/** Convert a record cell value into clean plain text for AI batch fill input. */
export function formatSourceCellText(cell: Cell | undefined | null): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : "";
  if (typeof cell === "boolean") return cell ? "是" : "否";
  if (Array.isArray(cell)) {
    return cell
      .map((item) => {
        if (typeof item === "string" || typeof item === "number") return String(item);
        if (item && typeof item === "object" && "name" in item && typeof item.name === "string") {
          return item.name;
        }
        return "";
      })
      .filter(Boolean)
      .join("、")
      .trim();
  }
  return "";
}

/** Collect up to 50 non-empty rows from the table for a given source field. */
export function extractBaseFillRows(
  records: readonly BaseRecord[],
  sourceField: Field,
  limit = BASE_AI_FILL_MAX_ROWS,
): BaseFillRowInput[] {
  const rows: BaseFillRowInput[] = [];
  const key = String(sourceField.id);
  for (const rec of records) {
    const text = formatSourceCellText(rec.cells[key]);
    if (!text) continue;
    rows.push({ recordId: rec.id, text });
    if (rows.length >= limit) break;
  }
  return rows;
}

/** Convert AI string result into a valid Bitable cell payload for text / select / multi_select. */
export function formatCellForTargetField(rawValue: string, targetField: Field): Cell | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  if (targetField.type === "text") {
    return trimmed;
  }
  const options = targetField.options ?? [];
  if (targetField.type === "select") {
    if (options.length === 0) return null;
    if (options.includes(trimmed)) return trimmed;
    const lower = trimmed.toLowerCase();
    const ci = options.find((opt) => opt.toLowerCase() === lower);
    if (ci) return ci;
    const partial = options.find((opt) => lower.includes(opt.toLowerCase()));
    return partial ?? options[0];
  }
  if (targetField.type === "multi_select") {
    if (options.length === 0) return [];
    const parts = trimmed
      .split(/[,，、;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const matched: string[] = [];
    for (const part of parts) {
      const lower = part.toLowerCase();
      const found = options.find((opt) => opt.toLowerCase() === lower);
      if (found && !matched.includes(found)) matched.push(found);
    }
    return matched.length > 0 ? matched : [options[0]];
  }
  return trimmed;
}

export function buildBatchFillUpdates(
  previewRows: readonly BaseAiFillPreviewRow[],
  selectedIds: ReadonlySet<number>,
  targetField: Field,
): { id: number; cells: Record<string, Cell | number[] | null> }[] {
  const fieldKey = String(targetField.id);
  const updates: { id: number; cells: Record<string, Cell | number[] | null> }[] = [];
  for (const row of previewRows) {
    if (!selectedIds.has(row.recordId)) continue;
    const formatted = formatCellForTargetField(row.generatedValue, targetField);
    if (formatted === null) continue;
    updates.push({
      id: row.recordId,
      cells: { [fieldKey]: formatted },
    });
  }
  return updates;
}

export interface BaseAiColumnFillDialogProps {
  baseId: number;
  fields: Field[];
  records: BaseRecord[];
  readonlyFieldIds?: ReadonlySet<number>;
  onClose: () => void;
  onApplied: () => Promise<unknown> | void;
  /** Optional initial preview rows (primarily for tests). */
  initialPreview?: BaseAiFillPreviewRow[];
  initialMode?: "llm" | "local";
}

export function BaseAiColumnFillDialog({
  baseId,
  fields,
  records,
  readonlyFieldIds,
  onClose,
  onApplied,
  initialPreview,
  initialMode = "local",
}: BaseAiColumnFillDialogProps) {
  const { t } = useI18n();
  const sourceFields = useMemo(() => fields.filter(isEligibleSourceField), [fields]);
  const targetFields = useMemo(
    () => fields.filter((f) => isEligibleTargetField(f, readonlyFieldIds)),
    [fields, readonlyFieldIds],
  );

  const defaultSourceId = useMemo(() => {
    const textField = sourceFields.find((f) => f.type === "text");
    return textField?.id ?? sourceFields[0]?.id ?? 0;
  }, [sourceFields]);

  const defaultTargetId = useMemo(() => {
    const other = targetFields.find((f) => f.id !== defaultSourceId);
    return other?.id ?? targetFields[0]?.id ?? 0;
  }, [targetFields, defaultSourceId]);

  const [sourceFieldId, setSourceFieldId] = useState<number>(defaultSourceId);
  const [targetFieldId, setTargetFieldId] = useState<number>(defaultTargetId);
  const [preset, setPreset] = useState<BaseFillPreset>("summarize");
  const [customPrompt, setCustomPrompt] = useState("");
  const [preview, setPreview] = useState<BaseAiFillPreviewRow[]>(() => initialPreview ?? []);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(
    () => new Set((initialPreview ?? []).map((r) => r.recordId)),
  );
  const [mode, setMode] = useState<"llm" | "local">(initialMode);
  const [busy, setBusy] = useState<"" | "generate" | "apply">("");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const sourceField = sourceFields.find((f) => f.id === sourceFieldId) ?? sourceFields[0];
  const targetField = targetFields.find((f) => f.id === targetFieldId) ?? targetFields[0];

  useEffect(() => () => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, busy]);

  const candidateRows = useMemo(
    () => (sourceField ? extractBaseFillRows(records, sourceField, BASE_AI_FILL_MAX_ROWS) : []),
    [records, sourceField],
  );

  const allSelected = preview.length > 0 && preview.every((r) => selectedIds.has(r.recordId));
  const selectedCount = preview.filter((r) => selectedIds.has(r.recordId)).length;

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(preview.map((r) => r.recordId)));
    }
  };

  const toggleRow = (recordId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(recordId)) next.delete(recordId);
      else next.add(recordId);
      return next;
    });
  };

  const handleGenerate = async () => {
    if (!sourceField || !targetField || busy) return;
    if (candidateRows.length === 0) {
      setError(t("所选来源列暂无非空数据可供 AI 填充"));
      return;
    }
    if (preset === "custom" && !customPrompt.trim()) {
      setError(t("请输入自定义提示词"));
      return;
    }
    setBusy("generate");
    setError("");
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await aiSuiteApi.baseFill(
        {
          baseId,
          preset,
          customPrompt: preset === "custom" ? customPrompt.trim() : undefined,
          sourceFieldName: sourceField.name,
          targetFieldType: targetField.type,
          options:
            targetField.type === "select" || targetField.type === "multi_select"
              ? targetField.options ?? []
              : undefined,
          rows: candidateRows,
        },
        controller.signal,
      );
      const sourceById = new Map(candidateRows.map((r) => [r.recordId, r.text]));
      const nextPreview: BaseAiFillPreviewRow[] = (res.results ?? []).map((item) => ({
        recordId: item.recordId,
        sourceText: sourceById.get(item.recordId) ?? "",
        generatedValue: item.value,
      }));
      setMode(res.mode);
      setPreview(nextPreview);
      setSelectedIds(new Set(nextPreview.map((r) => r.recordId)));
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(aiErrorText(err));
      }
    } finally {
      setBusy("");
    }
  };

  const handleApply = async () => {
    if (!targetField || busy || selectedCount === 0) return;
    const updates = buildBatchFillUpdates(preview, selectedIds, targetField);
    if (updates.length === 0) {
      setError(t("没有可写入的有效结果，请检查勾选行"));
      return;
    }
    setBusy("apply");
    setError("");
    try {
      await baseApi.batchUpdateRecords(baseId, updates);
      await onApplied();
      onClose();
    } catch (err) {
      setError(aiErrorText(err));
    } finally {
      setBusy("");
    }
  };

  const content = (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("AI 批量填充列")}
        data-base-ai-fill-dialog
        className="flex max-h-[calc(100dvh-32px)] w-full max-w-[680px] flex-col rounded-xl border border-[#dee0e3] bg-surface p-5 text-foreground shadow-[0_12px_40px_rgba(31,35,41,0.2)]"
      >
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-[#eef3ff] text-[#3370ff]">
              <Sparkles size={16} />
            </span>
            <div>
              <h2 className="text-[15.5px] font-semibold text-[#1f2329] dark:text-foreground">
                {t("AI 批量填充列")}
              </h2>
              <p className="text-[12px] text-[#8f959e]">
                {t("基于来源列批量生成摘要、分类、关键词或译文，核对预览后一键写入目标列（单次最多 50 行）")}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label={t("关闭")}
            disabled={!!busy}
            onClick={onClose}
            className="grid size-7 place-items-center rounded-md text-[#646a73] hover:bg-hover disabled:opacity-45"
          >
            <X size={17} />
          </button>
        </header>

        {targetFields.length === 0 ? (
          <div className="my-6 rounded-lg border border-dashed border-[#dee0e3] bg-[#f7f8fa] p-6 text-center text-[13px] text-[#646a73]">
            {t("当前数据表缺少可编辑的文本、单选或多选列，请先新建目标字段。")}
          </div>
        ) : (
          <>
            {/* Configuration controls using FeishuSelect (zero native <select>) */}
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <label className="block text-[12px] font-medium text-[#646a73]">{t("来源字段")}</label>
                <FeishuSelect
                  value={sourceField ? String(sourceField.id) : ""}
                  options={sourceFields.map((f) => ({ value: String(f.id), label: f.name }))}
                  onChange={(val) => {
                    setSourceFieldId(Number(val));
                    setPreview([]);
                    setError("");
                  }}
                  ariaLabel={t("来源字段")}
                  disabled={!!busy}
                  className="h-8 w-full border border-[#dee0e3] bg-surface px-2.5 text-[13px]"
                  menuMinWidth={160}
                  dataAttr={{ "data-ai-fill-source-field": true }}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[12px] font-medium text-[#646a73]">{t("目标字段")}</label>
                <FeishuSelect
                  value={targetField ? String(targetField.id) : ""}
                  options={targetFields.map((f) => ({ value: String(f.id), label: f.name }))}
                  onChange={(val) => {
                    setTargetFieldId(Number(val));
                    setPreview([]);
                    setError("");
                  }}
                  ariaLabel={t("目标字段")}
                  disabled={!!busy}
                  className="h-8 w-full border border-[#dee0e3] bg-surface px-2.5 text-[13px]"
                  menuMinWidth={160}
                  dataAttr={{ "data-ai-fill-target-field": true }}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[12px] font-medium text-[#646a73]">{t("填充预设")}</label>
                <FeishuSelect
                  value={preset}
                  options={AI_FILL_PRESETS.map((p) => ({ value: p.value, label: t(p.label) }))}
                  onChange={(val) => {
                    setPreset(val as BaseFillPreset);
                    setPreview([]);
                    setError("");
                  }}
                  ariaLabel={t("填充预设")}
                  disabled={!!busy}
                  className="h-8 w-full border border-[#dee0e3] bg-surface px-2.5 text-[13px]"
                  menuMinWidth={160}
                  dataAttr={{ "data-ai-fill-preset": true }}
                />
              </div>
            </div>

            {preset === "custom" && (
              <div className="mt-3 space-y-1">
                <label className="block text-[12px] font-medium text-[#646a73]">{t("自定义提示词")}</label>
                <input
                  type="text"
                  value={customPrompt}
                  disabled={!!busy}
                  data-ai-fill-custom-prompt
                  onChange={(e) => {
                    setCustomPrompt(e.target.value);
                    setError("");
                  }}
                  placeholder={t("例如：提取产品型号并用英文逗号分隔")}
                  className="h-9 w-full rounded-md border border-[#dee0e3] bg-surface px-3 text-[13px] outline-none focus:border-[#3370ff]"
                />
              </div>
            )}

            <div className="mt-3 flex items-center justify-between gap-2 text-[12px] text-[#8f959e]">
              <span>
                {t("待处理有效记录：{n} 条", { n: candidateRows.length })}
                {targetField && (targetField.type === "select" || targetField.type === "multi_select") && targetField.options?.length
                  ? ` · ${t("候选项：{opts}", { opts: targetField.options.join(" / ") })}`
                  : ""}
              </span>
              <button
                type="button"
                disabled={!!busy || candidateRows.length === 0}
                data-ai-fill-generate
                onClick={() => void handleGenerate()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#3370ff] bg-[#eef3ff] px-3 text-[12.5px] font-medium text-[#3370ff] transition-colors hover:bg-[#e1eaff] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {busy === "generate" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                <span>{busy === "generate" ? t("正在生成预览…") : t("生成预览")}</span>
              </button>
            </div>

            {error && (
              <div role="alert" className="mt-3 rounded-md border border-[#ffccc7] bg-[#fff2f0] px-3 py-2 text-[12px] text-[#d83931]">
                {error}
              </div>
            )}

            {/* Preview table */}
            {preview.length > 0 && (
              <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[#e5e6eb]" data-ai-fill-preview>
                <div className="flex shrink-0 items-center justify-between border-b border-[#eceef2] bg-[#f7f8fa] px-3 py-2 text-[12px] dark:bg-sidebar">
                  <span className="font-medium text-[#1f2329] dark:text-foreground">
                    {t("预览结果（已勾选 {selected} / {total} 条）", { selected: selectedCount, total: preview.length })}
                  </span>
                  <span
                    data-ai-fill-mode={mode}
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium",
                      mode === "llm" ? "bg-[#eef3ff] text-[#3370ff]" : "bg-[#e8eaed] text-[#4b5058]",
                    )}
                  >
                    {mode === "llm" ? t("AI 模型") : t("本地智能引擎")}
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <table className="w-full border-collapse text-left text-[12.5px]">
                    <thead className="sticky top-0 bg-[#f7f8fa] text-[#646a73] dark:bg-sidebar">
                      <tr className="border-b border-[#eceef2]">
                        <th className="w-9 px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={t("全选预览行")}
                            checked={allSelected}
                            onChange={toggleAll}
                            className="accent-[#3370ff]"
                          />
                        </th>
                        <th className="w-[44%] px-2 py-2 font-medium">{t("原内容")}</th>
                        <th className="w-7 px-1 py-2 text-center" aria-hidden />
                        <th className="px-2 py-2 font-medium">{t("AI 生成结果")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row) => {
                        const checked = selectedIds.has(row.recordId);
                        return (
                          <tr
                            key={row.recordId}
                            className={cn(
                              "border-b border-[#eff0f1] last:border-b-0",
                              checked ? "bg-surface" : "bg-[#fafbfc] opacity-55",
                            )}
                          >
                            <td className="px-3 py-2 align-top">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={!!busy}
                                data-ai-fill-row-check={String(row.recordId)}
                                aria-label={t("勾选记录 #{id}", { id: row.recordId })}
                                onChange={() => toggleRow(row.recordId)}
                                className="mt-0.5 accent-[#3370ff]"
                              />
                            </td>
                            <td className="max-w-[240px] whitespace-pre-wrap break-words px-2 py-2 align-top text-[#646a73]">
                              {row.sourceText}
                            </td>
                            <td className="px-1 py-2 text-center align-top text-[#8f959e]">
                              <ArrowRight size={13} className="mx-auto mt-0.5" aria-hidden />
                            </td>
                            <td className="max-w-[260px] whitespace-pre-wrap break-words px-2 py-2 align-top font-medium text-[#1f2329] dark:text-foreground">
                              {row.generatedValue}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Footer */}
            <footer className="mt-4 flex shrink-0 items-center justify-end gap-2">
              <button
                type="button"
                disabled={!!busy}
                onClick={onClose}
                className="h-8 rounded-md border border-[#dee0e3] px-3 text-[13px] text-[#4b5058] hover:bg-hover disabled:opacity-45"
              >
                {t("取消")}
              </button>
              <button
                type="button"
                disabled={!!busy || selectedCount === 0}
                data-ai-fill-apply
                onClick={() => void handleApply()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#3370ff] px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-[#245bdb] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {busy === "apply" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                <span>{busy === "apply" ? t("正在写入…") : t("批量写入表格")}</span>
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(content, document.body) : content;
}
