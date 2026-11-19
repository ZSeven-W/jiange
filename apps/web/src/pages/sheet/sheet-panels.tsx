import { useState } from "react";
import type {
  Role,
  Share,
  SheetComment,
  SheetCondFormatOp,
  SheetConditionalFormat,
  SheetDataValidation,
  SheetProtectedRange,
  SheetWorksheet,
} from "@/lib/api";
import { t } from "@/lib/i18n";
import { sheetAddress, type SheetPoint } from "@jiange/sheet-sdk/grid";
import { Check, Lock, MessageSquare, RotateCcw, ShieldCheck, Sparkles, Trash2, X, ListChecks } from "lucide-react";
import {
  COND_FMT_OPS,
  COND_FMT_PRESETS,
  formatSheetRectA1,
  makeRuleId,
  type SheetRect,
} from "./sheet-rules";

export type SheetPanelMode = "validation" | "condfmt" | "protect" | "comments";

export interface SheetSidePanelProps {
  mode: SheetPanelMode;
  onChangeMode: (mode: SheetPanelMode) => void;
  onClose: () => void;
  activeSheet: SheetWorksheet;
  selectionBoundsRect: SheetRect;
  focusedPoint: SheetPoint;
  userId: number;
  role: Role;
  canEdit: boolean;
  canComment: boolean;
  comments: SheetComment[];
  rowPosById: Map<number, number>;
  colPosById: Map<number, number>;
  shareMembers: Share[];
  onSelectRange: (rect: SheetRect) => void;
  onUpdateValidations: (next: SheetDataValidation[]) => Promise<void>;
  onUpdateCondFormats: (next: SheetConditionalFormat[]) => Promise<void>;
  onUpdateProtectedRanges: (next: SheetProtectedRange[]) => Promise<void>;
  onCreateComment: (body: string) => Promise<boolean>;
  onToggleResolveComment: (comment: SheetComment) => Promise<void>;
  onDeleteComment: (commentId: number) => Promise<void>;
}

const VALIDATION_TYPE_LABEL: Record<SheetDataValidation["type"], string> = {
  list: "下拉选项",
  number: "数字范围",
  date: "日期范围",
};

function formatRuleSummary(r: SheetDataValidation): string {
  if (r.type === "list") return (r.options ?? []).join(" / ");
  if (r.min && r.max) return `${r.min} ~ ${r.max}`;
  if (r.min) return `>= ${r.min}`;
  if (r.max) return `<= ${r.max}`;
  return r.type === "date" ? "YYYY-MM-DD" : t("有效数字");
}

function formatCondOpLabel(op: SheetCondFormatOp): string {
  return t(COND_FMT_OPS.find((item) => item.op === op)?.label ?? op);
}

function formatCommentTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

export function SheetSidePanel({
  mode,
  onChangeMode,
  onClose,
  activeSheet,
  selectionBoundsRect,
  focusedPoint,
  userId,
  role,
  canEdit,
  canComment,
  comments,
  rowPosById,
  colPosById,
  shareMembers,
  onSelectRange,
  onUpdateValidations,
  onUpdateCondFormats,
  onUpdateProtectedRanges,
  onCreateComment,
  onToggleResolveComment,
  onDeleteComment,
}: SheetSidePanelProps) {
  const isManager = role === "manage";
  const rangeLabel = formatSheetRectA1(selectionBoundsRect);
  const focusAddr = sheetAddress(focusedPoint);

  // Data Validation form state
  const [valType, setValType] = useState<SheetDataValidation["type"]>("list");
  const [valOptionsText, setValOptionsText] = useState("进行中, 已完成, 已延期");
  const [valMin, setValMin] = useState("");
  const [valMax, setValMax] = useState("");
  const [valStrict, setValStrict] = useState(true);
  const [valHint, setValHint] = useState("");
  const [valFormError, setValFormError] = useState("");

  // Conditional Format form state
  const [cfOp, setCfOp] = useState<SheetCondFormatOp>("gt");
  const [cfVal1, setCfVal1] = useState("100");
  const [cfVal2, setCfVal2] = useState("");
  const [cfPresetId, setCfPresetId] = useState("green");
  const [cfBold, setCfBold] = useState(true);
  const [cfFormError, setCfFormError] = useState("");

  // Protected Range form state
  const [prDesc, setPrDesc] = useState("");
  const [prAllowedIds, setPrAllowedIds] = useState<number[]>([]);

  // Comments panel state
  const [commentScope, setCommentScope] = useState<"all" | "cell">("all");
  const [showResolved, setShowResolved] = useState(true);
  const [commentDraft, setCommentDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const validations = activeSheet.validations ?? [];
  const condFormats = activeSheet.conditionalFormats ?? [];
  const protectedRanges = activeSheet.protectedRanges ?? [];

  const activeSheetComments = comments.filter((c) => c.worksheetId === activeSheet.id);
  const focusedRowId = activeSheet.rows[focusedPoint.row]?.id;
  const focusedColId = activeSheet.columns[focusedPoint.col]?.id;
  const focusedCellComments = activeSheetComments.filter(
    (c) => c.rowId === focusedRowId && c.columnId === focusedColId,
  );
  const visibleComments = (commentScope === "cell" ? focusedCellComments : activeSheetComments).filter(
    (c) => showResolved || !c.resolved,
  );

  const editorCandidates = shareMembers.filter((m) => m.role === "edit" && m.userId !== userId);

  const handleAddValidation = async (e: React.FormEvent) => {
    e.preventDefault();
    setValFormError("");
    const rule: SheetDataValidation = {
      id: makeRuleId("val"),
      top: selectionBoundsRect.top,
      left: selectionBoundsRect.left,
      bottom: selectionBoundsRect.bottom,
      right: selectionBoundsRect.right,
      type: valType,
      strict: valStrict,
      hint: valHint.trim() || undefined,
    };
    if (valType === "list") {
      const opts = Array.from(
        new Set(
          valOptionsText
            .split(/[\n,，]/)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      );
      if (opts.length === 0) {
        setValFormError(t("请至少填写一个下拉选项"));
        return;
      }
      rule.options = opts;
    } else if (valType === "number") {
      const minS = valMin.trim();
      const maxS = valMax.trim();
      if (minS && !Number.isFinite(Number(minS))) {
        setValFormError(t("最小值必须是有效数字"));
        return;
      }
      if (maxS && !Number.isFinite(Number(maxS))) {
        setValFormError(t("最大值必须是有效数字"));
        return;
      }
      if (minS && maxS && Number(minS) > Number(maxS)) {
        setValFormError(t("最小值不能大于最大值"));
        return;
      }
      if (minS) rule.min = minS;
      if (maxS) rule.max = maxS;
    } else if (valType === "date") {
      const minS = valMin.trim();
      const maxS = valMax.trim();
      const iso = /^\d{4}-\d{2}-\d{2}$/;
      if ((minS && !iso.test(minS)) || (maxS && !iso.test(maxS))) {
        setValFormError(t("日期格式需为 YYYY-MM-DD"));
        return;
      }
      if (minS && maxS && minS > maxS) {
        setValFormError(t("开始日期不能晚于结束日期"));
        return;
      }
      if (minS) rule.min = minS;
      if (maxS) rule.max = maxS;
    }
    setSubmitting(true);
    try {
      await onUpdateValidations([...validations, rule]);
      setValHint("");
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddCondFormat = async (e: React.FormEvent) => {
    e.preventDefault();
    setCfFormError("");
    const opMeta = COND_FMT_OPS.find((item) => item.op === cfOp);
    if (opMeta?.needsValue1 && !cfVal1.trim()) {
      setCfFormError(t("请输入条件比较值"));
      return;
    }
    if (opMeta?.needsValue2 && !cfVal2.trim()) {
      setCfFormError(t("请输入区间上限值"));
      return;
    }
    const preset = COND_FMT_PRESETS.find((p) => p.id === cfPresetId) ?? COND_FMT_PRESETS[0];
    const rule: SheetConditionalFormat = {
      id: makeRuleId("cf"),
      top: selectionBoundsRect.top,
      left: selectionBoundsRect.left,
      bottom: selectionBoundsRect.bottom,
      right: selectionBoundsRect.right,
      op: cfOp,
      value1: opMeta?.needsValue1 ? cfVal1.trim() : undefined,
      value2: opMeta?.needsValue2 ? cfVal2.trim() : undefined,
      bg: preset.bg,
      color: preset.color,
      bold: cfBold,
    };
    setSubmitting(true);
    try {
      await onUpdateCondFormats([...condFormats, rule]);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddProtected = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isManager) return;
    const rule: SheetProtectedRange = {
      id: makeRuleId("pr"),
      top: selectionBoundsRect.top,
      left: selectionBoundsRect.left,
      bottom: selectionBoundsRect.bottom,
      right: selectionBoundsRect.right,
      description: prDesc.trim() || `${rangeLabel} ${t("保护区域")}`,
      allowedUserIds: prAllowedIds.length > 0 ? prAllowedIds : undefined,
    };
    setSubmitting(true);
    try {
      await onUpdateProtectedRanges([...protectedRanges, rule]);
      setPrDesc("");
      setPrAllowedIds([]);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = commentDraft.trim();
    if (!text || !canComment) return;
    setSubmitting(true);
    try {
      const ok = await onCreateComment(text);
      if (ok) setCommentDraft("");
    } finally {
      setSubmitting(false);
    }
  };

  const opMeta = COND_FMT_OPS.find((item) => item.op === cfOp);

  return (
    <aside
      data-sheet-panel={mode}
      aria-label={t("表格侧边栏")}
      className="fixed inset-y-0 right-0 z-40 flex w-[min(100vw,340px)] flex-col border-l border-[#e5e6eb] bg-white shadow-xl sm:static sm:z-auto sm:w-80 sm:shrink-0 sm:shadow-none"
    >
      {/* Header + 4-mode switcher */}
      <div className="flex items-center justify-between border-b border-[#e5e6eb] px-3 py-2.5">
        <div className="flex items-center gap-1">
          {(
            [
              { id: "validation", label: t("验证"), icon: <ListChecks size={13} /> },
              { id: "condfmt", label: t("条件"), icon: <Sparkles size={13} /> },
              { id: "protect", label: t("保护"), icon: <Lock size={13} /> },
              { id: "comments", label: t("评论"), icon: <MessageSquare size={13} /> },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              data-sheet-panel-tab={tab.id}
              onClick={() => onChangeMode(tab.id)}
              className={`inline-flex h-7 items-center gap-1 rounded px-2 text-[12px] transition-colors ${
                mode === tab.id
                  ? "bg-[#e8efff] font-medium text-[#3370ff]"
                  : "text-[#646a73] hover:bg-[#f2f3f5]"
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label={t("关闭侧边栏")}
          data-sheet-panel-close
          onClick={onClose}
          className="grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"
        >
          <X size={15} />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[12px]">
        {mode === "validation" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="font-medium text-[#1f2329]">{t("数据验证")}</span>
              <span className="rounded bg-[#f2f3f5] px-1.5 py-0.5 font-mono text-[11px] text-[#3370ff]">{rangeLabel}</span>
            </div>

            {canEdit && (
              <form onSubmit={(e) => void handleAddValidation(e)} className="space-y-2.5 rounded-lg border border-[#e5e6eb] bg-[#fafbfc] p-3">
                <label className="grid gap-1">
                  <span className="text-[11px] text-[#646a73]">{t("验证类型")}</span>
                  <select
                    aria-label={t("验证类型")}
                    data-sheet-val-type
                    value={valType}
                    onChange={(e) => {
                      setValType(e.target.value as SheetDataValidation["type"]);
                      setValFormError("");
                    }}
                    className="h-8 rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
                  >
                    <option value="list">{t("下拉选项")}</option>
                    <option value="number">{t("数字范围")}</option>
                    <option value="date">{t("日期范围")}</option>
                  </select>
                </label>

                {valType === "list" ? (
                  <label className="grid gap-1">
                    <span className="text-[11px] text-[#646a73]">{t("选项列表（逗号或换行分隔）")}</span>
                    <textarea
                      rows={2}
                      data-sheet-val-options
                      value={valOptionsText}
                      onChange={(e) => setValOptionsText(e.target.value)}
                      placeholder={t("例如：进行中, 已完成, 已延期")}
                      className="rounded border border-[#dee0e3] bg-white p-2 text-[12px] outline-none focus:border-[#3370ff]"
                    />
                  </label>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="grid gap-1">
                      <span className="text-[11px] text-[#646a73]">{valType === "date" ? t("最早日期") : t("最小值")}</span>
                      <input
                        type={valType === "date" ? "date" : "text"}
                        data-sheet-val-min
                        value={valMin}
                        onChange={(e) => setValMin(e.target.value)}
                        placeholder={valType === "date" ? "2026-01-01" : "0"}
                        className="h-8 rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className="text-[11px] text-[#646a73]">{valType === "date" ? t("最晚日期") : t("最大值")}</span>
                      <input
                        type={valType === "date" ? "date" : "text"}
                        data-sheet-val-max
                        value={valMax}
                        onChange={(e) => setValMax(e.target.value)}
                        placeholder={valType === "date" ? "2026-12-31" : "100"}
                        className="h-8 rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
                      />
                    </label>
                  </div>
                )}

                <label className="grid gap-1">
                  <span className="text-[11px] text-[#646a73]">{t("校验提示（可选）")}</span>
                  <input
                    value={valHint}
                    onChange={(e) => setValHint(e.target.value)}
                    placeholder={t("输入不符合规则时的提示文案")}
                    className="h-8 rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
                  />
                </label>

                <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[#1f2329]">
                  <input
                    type="checkbox"
                    data-sheet-val-strict
                    checked={valStrict}
                    onChange={(e) => setValStrict(e.target.checked)}
                    className="rounded border-[#c9cdd4] text-[#3370ff]"
                  />
                  <span>{t("严格校验（拒绝非法输入）")}</span>
                </label>

                {valFormError && <p className="text-[11px] text-[#d83931]">{valFormError}</p>}

                <button
                  type="submit"
                  disabled={submitting}
                  data-sheet-add-validation
                  className="h-8 w-full rounded bg-[#3370ff] font-medium text-white hover:bg-[#245bdb] disabled:opacity-50"
                >
                  {t("应用到所选区域")} ({rangeLabel})
                </button>
              </form>
            )}

            <div className="space-y-2">
              <div className="text-[11px] font-medium text-[#646a73]">{t("已有验证规则")} ({validations.length})</div>
              {validations.length === 0 ? (
                <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">{t("暂无数据验证规则")}</p>
              ) : (
                validations.map((r) => (
                  <div key={r.id} data-sheet-validation-item={r.id} className="rounded-md border border-[#e5e6eb] p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onSelectRange(r)}
                        className="rounded bg-[#eef3ff] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#3370ff] hover:bg-[#dce7ff]"
                      >
                        {formatSheetRectA1(r)}
                      </button>
                      <div className="flex items-center gap-1">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${r.strict ? "bg-[#fff1f0] text-[#cf1322]" : "bg-[#fff7e6] text-[#d46b08]"}`}>
                          {r.strict ? t("严格") : t("警告")}
                        </span>
                        {canEdit && (
                          <button
                            type="button"
                            aria-label={t("删除规则")}
                            onClick={() => void onUpdateValidations(validations.filter((item) => item.id !== r.id))}
                            className="grid size-6 place-items-center rounded text-[#8f959e] hover:bg-[#fff2f0] hover:text-[#d83931]"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-1.5 text-[12px] text-[#1f2329]">
                      <span className="font-medium">{t(VALIDATION_TYPE_LABEL[r.type])}：</span>
                      <span className="break-words text-[#646a73]">{formatRuleSummary(r)}</span>
                    </div>
                    {r.hint && <p className="mt-1 text-[11px] text-[#8f959e]">{r.hint}</p>}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {mode === "condfmt" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="font-medium text-[#1f2329]">{t("条件格式")}</span>
              <span className="rounded bg-[#f2f3f5] px-1.5 py-0.5 font-mono text-[11px] text-[#3370ff]">{rangeLabel}</span>
            </div>

            {canEdit && (
              <form onSubmit={(e) => void handleAddCondFormat(e)} className="space-y-2.5 rounded-lg border border-[#e5e6eb] bg-[#fafbfc] p-3">
                <label className="grid gap-1">
                  <span className="text-[11px] text-[#646a73]">{t("满足条件")}</span>
                  <select
                    aria-label={t("满足条件")}
                    data-sheet-cf-op
                    value={cfOp}
                    onChange={(e) => {
                      setCfOp(e.target.value as SheetCondFormatOp);
                      setCfFormError("");
                    }}
                    className="h-8 rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
                  >
                    {COND_FMT_OPS.map((item) => (
                      <option key={item.op} value={item.op}>{t(item.label)}</option>
                    ))}
                  </select>
                </label>

                {opMeta?.needsValue1 && (
                  <div className={opMeta.needsValue2 ? "grid grid-cols-2 gap-2" : ""}>
                    <input
                      data-sheet-cf-val1
                      value={cfVal1}
                      onChange={(e) => setCfVal1(e.target.value)}
                      placeholder={opMeta.needsValue2 ? t("下限值") : t("比较值，例如 100")}
                      className="h-8 w-full rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
                    />
                    {opMeta.needsValue2 && (
                      <input
                        data-sheet-cf-val2
                        value={cfVal2}
                        onChange={(e) => setCfVal2(e.target.value)}
                        placeholder={t("上限值")}
                        className="h-8 w-full rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
                      />
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  <span className="block text-[11px] text-[#646a73]">{t("高亮样式")}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {COND_FMT_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        data-sheet-cf-preset={preset.id}
                        onClick={() => {
                          setCfPresetId(preset.id);
                          setCfBold(!!preset.bold);
                        }}
                        style={{ backgroundColor: preset.bg, color: preset.color }}
                        className={`rounded border px-2 py-1 text-[11px] font-medium ${
                          cfPresetId === preset.id ? "ring-2 ring-[#3370ff] ring-offset-1" : "border-black/10"
                        }`}
                      >
                        {t(preset.label)}
                      </button>
                    ))}
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 pt-1 text-[12px] text-[#1f2329]">
                    <input
                      type="checkbox"
                      checked={cfBold}
                      onChange={(e) => setCfBold(e.target.checked)}
                      className="rounded border-[#c9cdd4]"
                    />
                    <span>{t("文字加粗")}</span>
                  </label>
                </div>

                {cfFormError && <p className="text-[11px] text-[#d83931]">{cfFormError}</p>}

                <button
                  type="submit"
                  disabled={submitting}
                  data-sheet-add-condfmt
                  className="h-8 w-full rounded bg-[#3370ff] font-medium text-white hover:bg-[#245bdb] disabled:opacity-50"
                >
                  {t("添加条件格式")} ({rangeLabel})
                </button>
              </form>
            )}

            <div className="space-y-2">
              <div className="text-[11px] font-medium text-[#646a73]">{t("已有条件格式")} ({condFormats.length})</div>
              {condFormats.length === 0 ? (
                <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">{t("暂无条件格式规则")}</p>
              ) : (
                condFormats.map((r) => (
                  <div key={r.id} data-sheet-condfmt-item={r.id} className="rounded-md border border-[#e5e6eb] p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onSelectRange(r)}
                        className="rounded bg-[#eef3ff] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#3370ff] hover:bg-[#dce7ff]"
                      >
                        {formatSheetRectA1(r)}
                      </button>
                      <div className="flex items-center gap-1.5">
                        <span
                          className="rounded border border-black/10 px-1.5 py-0.5 text-[11px]"
                          style={{ backgroundColor: r.bg || "#ffffff", color: r.color || "#1f2329", fontWeight: r.bold ? 600 : 400 }}
                        >
                          Aa
                        </span>
                        {canEdit && (
                          <button
                            type="button"
                            aria-label={t("删除规则")}
                            onClick={() => void onUpdateCondFormats(condFormats.filter((item) => item.id !== r.id))}
                            className="grid size-6 place-items-center rounded text-[#8f959e] hover:bg-[#fff2f0] hover:text-[#d83931]"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-1.5 text-[12px] text-[#4b5058]">
                      {formatCondOpLabel(r.op)}
                      {r.value1 ? ` ${r.value1}` : ""}
                      {r.op === "between" && r.value2 ? ` ~ ${r.value2}` : ""}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {mode === "protect" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="font-medium text-[#1f2329]">{t("保护区域")}</span>
              <span className="rounded bg-[#f2f3f5] px-1.5 py-0.5 font-mono text-[11px] text-[#3370ff]">{rangeLabel}</span>
            </div>

            {isManager ? (
              <form onSubmit={(e) => void handleAddProtected(e)} className="space-y-2.5 rounded-lg border border-[#e5e6eb] bg-[#fafbfc] p-3">
                <label className="grid gap-1">
                  <span className="text-[11px] text-[#646a73]">{t("保护说明")}</span>
                  <input
                    data-sheet-protect-desc
                    value={prDesc}
                    onChange={(e) => setPrDesc(e.target.value)}
                    placeholder={t("例如：财务汇总公式区，禁止修改")}
                    className="h-8 rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
                  />
                </label>

                <div className="space-y-1">
                  <span className="block text-[11px] text-[#646a73]">{t("允许编辑的协作者（管理员默认可编辑）")}</span>
                  {editorCandidates.length === 0 ? (
                    <p className="text-[11px] text-[#8f959e]">{t("当前仅管理员可编辑此保护区域")}</p>
                  ) : (
                    <div className="max-h-28 space-y-1 overflow-y-auto rounded border border-[#dee0e3] bg-white p-2">
                      {editorCandidates.map((m) => {
                        const checked = prAllowedIds.includes(m.userId);
                        return (
                          <label key={m.userId} className="flex cursor-pointer items-center gap-2 text-[12px]">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setPrAllowedIds((prev) =>
                                  checked ? prev.filter((id) => id !== m.userId) : [...prev, m.userId],
                                )
                              }
                            />
                            <span className="truncate">{m.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  data-sheet-add-protect
                  className="h-8 w-full rounded bg-[#3370ff] font-medium text-white hover:bg-[#245bdb] disabled:opacity-50"
                >
                  {t("保护所选区域")} ({rangeLabel})
                </button>
              </form>
            ) : (
              <div className="flex items-start gap-2 rounded-md border border-[#e5e6eb] bg-[#f7f8fa] p-2.5 text-[12px] text-[#646a73]">
                <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[#3370ff]" />
                <span>{t("仅表格管理员可创建或移除保护区域。")}</span>
              </div>
            )}

            <div className="space-y-2">
              <div className="text-[11px] font-medium text-[#646a73]">{t("已保护范围")} ({protectedRanges.length})</div>
              {protectedRanges.length === 0 ? (
                <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">{t("暂无保护区域")}</p>
              ) : (
                protectedRanges.map((r) => (
                  <div key={r.id} data-sheet-protect-item={r.id} className="rounded-md border border-[#e5e6eb] p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onSelectRange(r)}
                        className="inline-flex items-center gap-1 rounded bg-[#fff7e6] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#d46b08] hover:bg-[#ffe7ba]"
                      >
                        <Lock size={11} />
                        <span>{formatSheetRectA1(r)}</span>
                      </button>
                      {isManager && (
                        <button
                          type="button"
                          aria-label={t("解除保护")}
                          onClick={() => void onUpdateProtectedRanges(protectedRanges.filter((item) => item.id !== r.id))}
                          className="grid size-6 place-items-center rounded text-[#8f959e] hover:bg-[#fff2f0] hover:text-[#d83931]"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                    <p className="mt-1.5 text-[12px] text-[#1f2329]">{r.description || t("受保护区域")}</p>
                    <p className="mt-0.5 text-[11px] text-[#8f959e]">
                      {(r.allowedUserIds?.length ?? 0) > 0
                        ? t("管理员及 {count} 位授权编辑者可修改", { count: r.allowedUserIds!.length })
                        : t("仅管理员可修改")}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {mode === "comments" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setCommentScope("all")}
                  className={`rounded px-2 py-1 text-[11px] ${commentScope === "all" ? "bg-[#e8efff] font-medium text-[#3370ff]" : "text-[#646a73] hover:bg-[#f2f3f5]"}`}
                >
                  {t("全部")} ({activeSheetComments.length})
                </button>
                <button
                  type="button"
                  onClick={() => setCommentScope("cell")}
                  className={`rounded px-2 py-1 text-[11px] ${commentScope === "cell" ? "bg-[#e8efff] font-medium text-[#3370ff]" : "text-[#646a73] hover:bg-[#f2f3f5]"}`}
                >
                  {focusAddr} ({focusedCellComments.length})
                </button>
              </div>
              <label className="flex cursor-pointer items-center gap-1 text-[11px] text-[#646a73]">
                <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
                <span>{t("已解决")}</span>
              </label>
            </div>

            {canComment ? (
              <form onSubmit={(e) => void handleSubmitComment(e)} className="space-y-2 rounded-lg border border-[#e5e6eb] bg-[#fafbfc] p-2.5">
                <div className="flex items-center justify-between text-[11px] text-[#646a73]">
                  <span>{t("评论单元格")}</span>
                  <span className="rounded bg-[#fff7e6] px-1.5 py-0.5 font-mono font-medium text-[#d46b08]">{focusAddr}</span>
                </div>
                <textarea
                  rows={2}
                  data-sheet-comment-input
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  placeholder={t("输入单元格评论，按按钮发送…")}
                  className="w-full rounded border border-[#dee0e3] bg-white p-2 text-[12px] outline-none focus:border-[#3370ff]"
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={submitting || !commentDraft.trim()}
                    data-sheet-comment-submit
                    className="h-7 rounded bg-[#3370ff] px-3 text-[12px] font-medium text-white hover:bg-[#245bdb] disabled:opacity-45"
                  >
                    {t("发送评论")}
                  </button>
                </div>
              </form>
            ) : (
              <p className="rounded bg-[#f7f8fa] p-2.5 text-[11px] text-[#8f959e]">{t("当前权限下仅支持查看评论。")}</p>
            )}

            <div className="space-y-2">
              {visibleComments.length === 0 ? (
                <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">{t("暂无单元格评论")}</p>
              ) : (
                visibleComments.map((cm) => {
                  const rPos = rowPosById.get(cm.rowId);
                  const cPos = colPosById.get(cm.columnId);
                  const addr = rPos !== undefined && cPos !== undefined ? sheetAddress({ row: rPos, col: cPos }) : "?";
                  const canDelete = cm.authorId === userId || isManager;
                  const canResolve = canComment || cm.authorId === userId || isManager;
                  return (
                    <div
                      key={cm.id}
                      data-sheet-comment-item={cm.id}
                      data-sheet-comment-resolved={cm.resolved ? "true" : "false"}
                      className={`rounded-md border p-2.5 ${cm.resolved ? "border-[#eceef2] bg-[#fafbfc] opacity-75" : "border-[#e5e6eb] bg-white"}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <button
                            type="button"
                            disabled={rPos === undefined || cPos === undefined}
                            onClick={() => {
                              if (rPos !== undefined && cPos !== undefined) {
                                onSelectRange({ top: rPos, left: cPos, bottom: rPos, right: cPos });
                              }
                            }}
                            className="shrink-0 rounded bg-[#fff7e6] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#d46b08] hover:bg-[#ffe7ba]"
                          >
                            {addr}
                          </button>
                          <span className="truncate font-medium text-[#1f2329]">{cm.authorName || `#${cm.authorId}`}</span>
                          <span className="shrink-0 text-[10px] text-[#8f959e]">{formatCommentTime(cm.createdAt)}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          {canResolve && (
                            <button
                              type="button"
                              title={cm.resolved ? t("重新打开") : t("标记已解决")}
                              aria-label={cm.resolved ? t("重新打开") : t("标记已解决")}
                              data-sheet-comment-resolve={cm.id}
                              onClick={() => void onToggleResolveComment(cm)}
                              className={`grid size-6 place-items-center rounded hover:bg-[#f2f3f5] ${cm.resolved ? "text-[#00b42a]" : "text-[#646a73]"}`}
                            >
                              {cm.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
                            </button>
                          )}
                          {canDelete && (
                            <button
                              type="button"
                              title={t("删除评论")}
                              aria-label={t("删除评论")}
                              data-sheet-comment-delete={cm.id}
                              onClick={() => void onDeleteComment(cm.id)}
                              className="grid size-6 place-items-center rounded text-[#8f959e] hover:bg-[#fff2f0] hover:text-[#d83931]"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                      <p className={`mt-1.5 whitespace-pre-wrap break-words text-[12px] ${cm.resolved ? "text-[#8f959e] line-through" : "text-[#1f2329]"}`}>
                        {cm.body}
                      </p>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
