import { AlertTriangle, Check, GitMerge, X } from "lucide-react";
import type { SheetCellConflict } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { formatSheetCellAddress, formatSheetRect, type PendingMergeConflict } from "./sheet-collab";

export function SheetConflictBar({
  cellConflicts,
  mergeConflict,
  busy,
  onResolveCell,
  onResolveAllCells,
  onResolveMerge,
}: {
  cellConflicts: SheetCellConflict[];
  mergeConflict: PendingMergeConflict | null;
  busy: boolean;
  onResolveCell: (conflict: SheetCellConflict, choice: "mine" | "theirs" | "anchor") => void;
  onResolveAllCells: (choice: "mine" | "theirs") => void;
  onResolveMerge: (force: boolean) => void;
}) {
  const { t } = useI18n();
  if (cellConflicts.length === 0 && !mergeConflict) return null;

  return (
    <div
      data-sheet-conflict-bar
      role="region"
      aria-label={t("协作冲突消解")}
      className="shrink-0 border-b border-amber-300/80 bg-amber-50/95 px-3 py-2 text-[12px] text-[#1f2329]"
    >
      {mergeConflict && (
        <div
          data-sheet-merge-conflict
          className="flex flex-wrap items-center justify-between gap-2"
        >
          <div className="flex min-w-0 items-center gap-2">
            <GitMerge size={14} className="shrink-0 text-amber-600" />
            <span className="font-medium text-amber-900">
              {t("区域合并冲突")} ({formatSheetRect(mergeConflict.attemptedRect)})
            </span>
            <span className="truncate text-amber-800">
              {t("与协作者新合并的 {rects} 存在重叠", {
                rects: mergeConflict.conflictingMerges.map(formatSheetRect).join("、"),
              })}
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              data-merge-conflict-force
              onClick={() => onResolveMerge(true)}
              className="inline-flex h-7 items-center gap-1 rounded bg-[#3370ff] px-2.5 text-[12px] font-medium text-white hover:bg-[#2860e1] disabled:opacity-50"
            >
              <Check size={12} />
              {t("强制覆盖合并")}
            </button>
            <button
              type="button"
              disabled={busy}
              data-merge-conflict-keep-theirs
              onClick={() => onResolveMerge(false)}
              className="inline-flex h-7 items-center gap-1 rounded border border-amber-300 bg-white px-2.5 text-[12px] text-[#1f2329] hover:bg-amber-100/60 disabled:opacity-50"
            >
              <X size={12} />
              {t("保留协作者合并")}
            </button>
          </div>
        </div>
      )}

      {cellConflicts.length > 0 && (
        <div className={mergeConflict ? "mt-2 border-t border-amber-200/80 pt-2" : ""}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5 font-medium text-amber-900">
              <AlertTriangle size={14} className="shrink-0 text-amber-600" />
              <span>
                {t("检测到 {count} 处单元格协同冲突（其他非冲突单元格已自动保存）", { count: cellConflicts.length })}
              </span>
            </div>
            {cellConflicts.length > 1 && (
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  data-conflict-keep-all-mine
                  onClick={() => onResolveAllCells("mine")}
                  className="h-6 rounded bg-[#3370ff] px-2 text-[11px] font-medium text-white hover:bg-[#2860e1] disabled:opacity-50"
                >
                  {t("全部保留我的")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  data-conflict-keep-all-theirs
                  onClick={() => onResolveAllCells("theirs")}
                  className="h-6 rounded border border-amber-300 bg-white px-2 text-[11px] text-[#1f2329] hover:bg-amber-100/60 disabled:opacity-50"
                >
                  {t("全部采用对方")}
                </button>
              </div>
            )}
          </div>
          <div className="mt-1.5 space-y-1.5">
            {cellConflicts.slice(0, 5).map((cf) => {
              const addr = formatSheetCellAddress(cf.row, cf.col);
              const isSlave = cf.reason === "merge_slave_conflict";
              const reasonLabel = isSlave
                ? t("已并入合并区域")
                : cf.reason === "style_conflict"
                  ? t("样式冲突")
                  : t("内容冲突");
              return (
                <div
                  key={`${cf.rowId}:${cf.columnId}`}
                  data-sheet-conflict-item={addr}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200/90 bg-white px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-900">
                        {addr}
                      </span>
                      <span className="text-[11px] font-medium text-amber-800">{reasonLabel}</span>
                      {cf.updatedByName && (
                        <span className="text-[11px] text-[#646a73]">
                          · {t("协作者：{name}", { name: cf.updatedByName })}
                        </span>
                      )}
                      {isSlave && cf.mergeRect && (
                        <span className="text-[11px] text-[#646a73]">
                          · {formatSheetRect(cf.mergeRect)}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-[#646a73]">
                      {isSlave ? (
                        <>
                          {t("你尝试写入")} <code className="rounded bg-[#f2f3f5] px-1 text-[#1f2329]">{cf.attemptedRaw || "（空）"}</code>
                          {" · "}
                          {t("合并主格当前值")} <code className="rounded bg-[#f2f3f5] px-1 text-[#1f2329]">{cf.anchorRaw || "（空）"}</code>
                        </>
                      ) : cf.reason === "style_conflict" ? (
                        <>
                          {t("冲突样式项")}：{cf.conflictingFields?.join(", ") || t("单元格格式")}
                        </>
                      ) : (
                        <>
                          {t("我的版本")} <code className="rounded bg-[#eef3ff] px-1 text-[#1f2329]">{cf.attemptedRaw ?? "（空）"}</code>
                          {" vs "}
                          {t("对方版本")} <code className="rounded bg-amber-100/70 px-1 text-[#1f2329]">{cf.currentRaw || "（空）"}</code>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    {isSlave ? (
                      <button
                        type="button"
                        disabled={busy}
                        data-conflict-write-anchor={addr}
                        onClick={() => onResolveCell(cf, "anchor")}
                        className="h-6 rounded bg-[#3370ff] px-2 text-[11px] font-medium text-white hover:bg-[#2860e1] disabled:opacity-50"
                      >
                        {t("写入合并主格")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        data-conflict-keep-mine={addr}
                        onClick={() => onResolveCell(cf, "mine")}
                        className="h-6 rounded bg-[#3370ff] px-2 text-[11px] font-medium text-white hover:bg-[#2860e1] disabled:opacity-50"
                      >
                        {t("保留我的")}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      data-conflict-keep-theirs={addr}
                      onClick={() => onResolveCell(cf, "theirs")}
                      className="h-6 rounded border px-2 text-[11px] text-[#1f2329] hover:bg-[#f2f3f5] disabled:opacity-50"
                    >
                      {t("采用对方")}
                    </button>
                  </div>
                </div>
              );
            })}
            {cellConflicts.length > 5 && (
              <p className="text-[11px] text-amber-800">
                {t("还有 {count} 处冲突，可使用上方「全部保留我的」或「全部采用对方」批量处理", {
                  count: cellConflicts.length - 5,
                })}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
