import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SheetSnapshot, SheetWorksheet } from "@/lib/api";
import type { SheetDefinedName } from "@zseven-w/sheet-sdk/types";
import { sheetAddress, type SheetPoint } from "@zseven-w/sheet-sdk/grid";
import {
  sheetHistoryApi,
  type SheetCellHistoryEntry,
  type SheetDefinedNameRecord,
  type SheetVersionMeta,
} from "@/lib/sheet-history-api";
import { t } from "@/lib/i18n";
import { colorFor } from "@/lib/presence";
import { Avatar } from "@/components/brand";
import { FeishuSelect } from "@/components/feishu-select";
import { ask } from "@/components/ui/ask";
import { ArrowRight, Clock, History, Plus, RefreshCw, RotateCcw, Tag, Trash2 } from "lucide-react";
import { formatSheetRectA1, type SheetRect } from "./sheet-rules";
import { formatSheetRefPrefix } from "./workbook-templates";
import { parseRangeInput } from "./workbook-engine";

export const DEFINED_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
export const MAX_DEFINED_NAMES = 200;
export const MAX_DEFINED_NAME_REF_LENGTH = 512;
const WORKBOOK_SCOPE_VALUE = "__workbook__";

export function formatSheetHistoryTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return "";
  }
}

export function validateDefinedName(
  rawName: string,
  rawRef: string,
  scopeSheetName: string | undefined,
  existing: readonly SheetDefinedName[],
): { ok: true; item: SheetDefinedName } | { ok: false; error: string } {
  const name = rawName.trim();
  const ref = rawRef.trim().replace(/^=/, "");
  if (existing.length >= MAX_DEFINED_NAMES) {
    return { ok: false, error: t("最多支持 200 个定义名称") };
  }
  if (!name) {
    return { ok: false, error: t("请输入名称") };
  }
  if (!DEFINED_NAME_REGEX.test(name)) {
    return { ok: false, error: t("名称需以字母或下划线开头，仅支持字母、数字、下划线和点（最多 64 位）") };
  }
  if (!ref) {
    return { ok: false, error: t("请输入引用区域或常量值") };
  }
  if (ref.length > MAX_DEFINED_NAME_REF_LENGTH) {
    return { ok: false, error: t("引用位置最多支持 512 个字符") };
  }
  const lowerName = name.toLowerCase();
  const lowerScope = (scopeSheetName ?? "").trim().toLowerCase();
  const dup = existing.some(
    (item) =>
      item.name.trim().toLowerCase() === lowerName &&
      (item.sheetName ?? "").trim().toLowerCase() === lowerScope,
  );
  if (dup) {
    return { ok: false, error: t("当前作用域下已存在同名定义") };
  }
  return {
    ok: true,
    item: scopeSheetName ? { name, ref, sheetName: scopeSheetName } : { name, ref },
  };
}

export function parseDefinedNameTarget(
  dn: SheetDefinedName,
  sheets: readonly SheetWorksheet[],
  activeSheet: SheetWorksheet,
): { sheetId: number; rect: SheetRect } | null {
  const cleanRef = dn.ref.trim().replace(/^=/, "");
  if (!cleanRef) return null;
  let targetSheet = dn.sheetName
    ? sheets.find((s) => s.title.toLowerCase() === dn.sheetName!.trim().toLowerCase()) ?? activeSheet
    : activeSheet;
  let rangePart = cleanRef;
  const bangIdx = cleanRef.lastIndexOf("!");
  if (bangIdx > 0) {
    let sheetPart = cleanRef.slice(0, bangIdx).trim();
    if (sheetPart.startsWith("'") && sheetPart.endsWith("'") && sheetPart.length >= 2) {
      sheetPart = sheetPart.slice(1, -1).replace(/''/g, "'");
    }
    const found = sheets.find((s) => s.title.toLowerCase() === sheetPart.toLowerCase());
    if (!found) return null;
    targetSheet = found;
    rangePart = cleanRef.slice(bangIdx + 1).trim();
  }
  const stripped = rangePart.replace(/\$/g, "");
  const parsed = parseRangeInput(stripped);
  if (!parsed) return null;
  const maxRow = Math.max(0, targetSheet.rows.length - 1);
  const maxCol = Math.max(0, targetSheet.columns.length - 1);
  const clampRow = (r: number) => Math.max(0, Math.min(maxRow, r));
  const clampCol = (c: number) => Math.max(0, Math.min(maxCol, c));
  const top = clampRow(Math.min(parsed.anchor.row, parsed.focus.row));
  const bottom = clampRow(Math.max(parsed.anchor.row, parsed.focus.row));
  const left = clampCol(Math.min(parsed.anchor.col, parsed.focus.col));
  const right = clampCol(Math.max(parsed.anchor.col, parsed.focus.col));
  return { sheetId: targetSheet.id, rect: { top, left, bottom, right } };
}

export function definedNameRecordsToSdk(
  records: readonly SheetDefinedNameRecord[],
  sheets: readonly SheetWorksheet[],
): SheetDefinedName[] {
  const sheetById = new Map<number, SheetWorksheet>();
  for (const ws of sheets) {
    sheetById.set(ws.id, ws);
  }
  const out: SheetDefinedName[] = [];
  for (const item of records) {
    const name = item.name.trim();
    const ref = item.ref.trim();
    if (!name || !ref) continue;
    if (item.sheetId !== undefined && item.sheetId !== null) {
      const ws = sheetById.get(item.sheetId);
      out.push({ name, ref, sheetName: ws ? ws.title : `#${item.sheetId}` });
    } else {
      out.push({ name, ref });
    }
  }
  return out;
}

export function sdkDefinedNamesToRecords(
  names: readonly SheetDefinedName[],
  sheets: readonly SheetWorksheet[],
  prevRecords: readonly SheetDefinedNameRecord[] = [],
): SheetDefinedNameRecord[] {
  const sheetIdByLowerTitle = new Map<string, number>();
  for (const ws of sheets) {
    sheetIdByLowerTitle.set(ws.title.trim().toLowerCase(), ws.id);
  }
  const prevComments = new Map<string, string>();
  for (const rec of prevRecords) {
    if (rec.comment) {
      prevComments.set(`${rec.sheetId ?? ""}::${rec.name.trim().toLowerCase()}`, rec.comment);
    }
  }
  return names.map((dn) => {
    const name = dn.name.trim();
    const ref = dn.ref.trim().replace(/^=/, "");
    let sheetId: number | undefined;
    const scopeName = dn.sheetName?.trim();
    if (scopeName) {
      const found = sheetIdByLowerTitle.get(scopeName.toLowerCase());
      if (found !== undefined) {
        sheetId = found;
      } else {
        const orphanMatch = /^#(\d+)$/.exec(scopeName);
        if (orphanMatch) {
          const parsedId = Number(orphanMatch[1]);
          if (Number.isSafeInteger(parsedId) && parsedId > 0) {
            sheetId = parsedId;
          }
        }
      }
    }
    const comment = prevComments.get(`${sheetId ?? ""}::${name.toLowerCase()}`);
    const record: SheetDefinedNameRecord = { name, ref };
    if (sheetId !== undefined) record.sheetId = sheetId;
    if (comment) record.comment = comment;
    return record;
  });
}

export interface SheetVersionsPanelProps {
  sheetId: number;
  userId: number;
  canEdit: boolean;
  onVersionRestored: (snapshot: SheetSnapshot) => void;
  onVersionSaved?: (version: SheetVersionMeta) => void;
}

export function SheetVersionsPanel({
  sheetId,
  userId,
  canEdit,
  onVersionRestored,
  onVersionSaved,
}: SheetVersionsPanelProps) {
  const qc = useQueryClient();
  const versionsQueryKey = ["sheet-versions", sheetId, userId] as const;
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const versionsQuery = useQuery({
    queryKey: versionsQueryKey,
    queryFn: ({ signal }) => sheetHistoryApi.listVersions(sheetId, userId, signal),
    retry: false,
  });

  const versions = versionsQuery.data?.versions ?? [];

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || saving) return;
    setErrorMsg("");
    setSaving(true);
    try {
      const res = await sheetHistoryApi.createVersion(sheetId, userId, label.trim());
      setLabel("");
      qc.setQueryData<{ versions: SheetVersionMeta[] }>(versionsQueryKey, (old) => ({
        versions: [res.version, ...(old?.versions ?? []).filter((v) => v.id !== res.version.id)],
      }));
      onVersionSaved?.(res.version);
      void qc.invalidateQueries({ queryKey: versionsQueryKey });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t("保存历史版本失败"));
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async (version: SheetVersionMeta) => {
    if (!canEdit || restoringId !== null) return;
    const confirmed = await ask(
      t("恢复此版本"),
      t("将工作簿恢复到「{label}」？恢复前会自动保存当前内容的备份版本。", { label: version.label || t("未命名版本") }),
      true,
    );
    if (!confirmed) return;
    setErrorMsg("");
    setRestoringId(version.id);
    try {
      const snapshot = await sheetHistoryApi.restoreVersion(sheetId, userId, version.id);
      onVersionRestored(snapshot);
      void qc.invalidateQueries({ queryKey: versionsQueryKey });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t("恢复历史版本失败"));
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="space-y-4" data-sheet-versions-panel>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <History size={14} className="text-[#3370ff]" />
          <span className="font-medium text-[#1f2329]">{t("历史版本")}</span>
        </div>
        <button
          type="button"
          title={t("刷新版本列表")}
          aria-label={t("刷新版本列表")}
          onClick={() => void versionsQuery.refetch()}
          className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
        >
          <RefreshCw size={12} className={versionsQuery.isFetching ? "animate-spin" : ""} />
        </button>
      </div>

      {canEdit ? (
        <form onSubmit={(e) => void handleSave(e)} className="space-y-2 rounded-lg border border-[#e5e6eb] bg-[#fafbfc] p-3">
          <label className="grid gap-1">
            <span className="text-[11px] text-[#646a73]">{t("版本名称（可选）")}</span>
            <input
              data-sheet-version-input
              value={label}
              maxLength={120}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("例如：Q3 财务定稿")}
              className="h-8 rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
            />
          </label>
          <button
            type="submit"
            disabled={saving}
            data-sheet-version-save
            className="h-8 w-full rounded bg-[#3370ff] font-medium text-white hover:bg-[#245bdb] disabled:opacity-50"
          >
            {saving ? t("正在保存…") : t("保存版本")}
          </button>
        </form>
      ) : (
        <p className="rounded bg-[#f7f8fa] p-2.5 text-[11px] text-[#8f959e]">
          {t("只读权限下可浏览历史版本，仅编辑者可保存或恢复版本。")}
        </p>
      )}

      {errorMsg && (
        <p className="rounded bg-[#fff1f0] px-2.5 py-1.5 text-[11px] text-[#cf1322]">{errorMsg}</p>
      )}

      <div className="space-y-2">
        <div className="text-[11px] font-medium text-[#646a73]">
          {t("版本快照")} ({versions.length})
        </div>
        {versionsQuery.isLoading ? (
          <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">
            {t("正在加载历史版本…")}
          </p>
        ) : versionsQuery.isError ? (
          <p className="rounded border border-[#ffccc7] bg-[#fff1f0] px-3 py-4 text-center text-[#cf1322]">
            {versionsQuery.error instanceof Error ? versionsQuery.error.message : t("加载历史版本失败")}
          </p>
        ) : versions.length === 0 ? (
          <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">
            {t("暂无历史版本，点击上方「保存版本」记录当前工作簿快照")}
          </p>
        ) : (
          versions.map((v) => (
            <div
              key={v.id}
              data-sheet-version-item={v.id}
              className="rounded-md border border-[#e5e6eb] bg-white p-2.5 transition-colors hover:border-[#c9d4ea]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium text-[#1f2329]">
                      {v.label || t("未命名版本")}
                    </span>
                    <span
                      data-sheet-version-badge={v.autoSaved ? "auto" : "manual"}
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        v.autoSaved
                          ? "bg-[#fff7e6] text-[#d46b08]"
                          : "bg-[#eef3ff] text-[#3370ff]"
                      }`}
                    >
                      {v.autoSaved ? t("自动备份") : t("手动命名")}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#8f959e]">
                    <span>{v.actorName || `#${v.createdBy}`}</span>
                    <span>·</span>
                    <span>{formatSheetHistoryTime(v.createdAt)}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-[#646a73]">
                    {t("{sheets} 个工作表 · {cells} 个单元格", {
                      sheets: v.worksheetCount,
                      cells: v.cellCount,
                    })}
                  </div>
                </div>
              </div>
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  disabled={!canEdit || restoringId !== null}
                  data-sheet-version-restore={v.id}
                  onClick={() => void handleRestore(v)}
                  className="inline-flex h-7 items-center gap-1 rounded border border-[#dee0e3] bg-white px-2.5 text-[11px] font-medium text-[#1f2329] hover:border-[#3370ff] hover:text-[#3370ff] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <RotateCcw size={11} />
                  <span>{restoringId === v.id ? t("正在恢复…") : t("恢复此版本")}</span>
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function renderCellDiffChip(value: string, formula: string, tone: "prev" | "next") {
  const hasFormula = formula.length > 0;
  const display = hasFormula ? formula : value;
  const baseCls =
    tone === "prev"
      ? "border-[#e5e6eb] bg-[#f7f8fa] text-[#646a73] line-through"
      : "border-[#b7d0ff] bg-[#eef3ff] text-[#1f2329] font-medium";
  if (!display) {
    return (
      <span className="inline-flex items-center rounded border border-dashed border-[#dee0e3] bg-[#fafbfc] px-1.5 py-0.5 text-[11px] italic text-[#8f959e]">
        {t("(空)")}
      </span>
    );
  }
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] break-all ${baseCls}`}>
      {hasFormula && (
        <span className="shrink-0 rounded bg-[#3370ff]/12 px-1 font-mono text-[9.5px] font-semibold text-[#3370ff] no-underline">
          fx
        </span>
      )}
      <span className={hasFormula ? "font-mono" : ""}>{display}</span>
    </span>
  );
}

export interface SheetCellHistoryPanelProps {
  sheetId: number;
  userId: number;
  activeSheet: SheetWorksheet;
  focusedPoint: SheetPoint;
}

export function SheetCellHistoryPanel({
  sheetId,
  userId,
  activeSheet,
  focusedPoint,
}: SheetCellHistoryPanelProps) {
  const focusAddr = sheetAddress(focusedPoint);
  const query = useQuery({
    queryKey: ["sheet-cell-history", sheetId, userId, activeSheet.id, focusedPoint.row, focusedPoint.col],
    queryFn: ({ signal }) =>
      sheetHistoryApi.listCellHistory(
        sheetId,
        userId,
        activeSheet.id,
        focusedPoint.row,
        focusedPoint.col,
        50,
        signal,
      ),
    retry: false,
  });

  const entries: SheetCellHistoryEntry[] = query.data?.entries ?? [];

  return (
    <div className="space-y-3" data-sheet-cell-history-panel>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Clock size={14} className="shrink-0 text-[#3370ff]" />
          <span className="font-medium text-[#1f2329]">{t("单元格修改记录")}</span>
          <span
            data-sheet-cell-history-addr
            className="rounded bg-[#eef3ff] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#3370ff]"
          >
            {focusAddr}
          </span>
        </div>
        <button
          type="button"
          title={t("刷新修改记录")}
          aria-label={t("刷新修改记录")}
          onClick={() => void query.refetch()}
          className="grid size-6 shrink-0 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
        >
          <RefreshCw size={12} className={query.isFetching ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="rounded-md bg-[#f7f8fa] px-2.5 py-1.5 text-[11px] text-[#646a73]">
        {t("当前工作表：{title} · 选中单元格 {addr}", { title: activeSheet.title, addr: focusAddr })}
      </div>

      {query.isLoading ? (
        <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">
          {t("正在加载修改记录…")}
        </p>
      ) : query.isError ? (
        <p className="rounded border border-[#ffccc7] bg-[#fff1f0] px-3 py-4 text-center text-[#cf1322]">
          {query.error instanceof Error ? query.error.message : t("加载修改记录失败")}
        </p>
      ) : entries.length === 0 ? (
        <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">
          {t("该单元格暂无修改记录")}
        </p>
      ) : (
        <div className="relative space-y-2.5 pl-3 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-[#e5e6eb]">
          {entries.map((entry) => {
            const actorLabel = entry.actorName || (entry.actorId > 0 ? `#${entry.actorId}` : t("协作者"));
            const formulaChanged = entry.prevFormula !== entry.nextFormula;
            return (
              <div
                key={entry.id}
                data-sheet-cell-history-item={entry.id}
                className="relative rounded-md border border-[#e5e6eb] bg-white p-2.5"
              >
                <span
                  aria-hidden="true"
                  className="absolute -left-[10px] top-3.5 size-2 rounded-full border border-white bg-[#3370ff]"
                />
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Avatar
                      name={actorLabel}
                      color={colorFor(Math.max(0, entry.actorId - 1))}
                      size={18}
                    />
                    <span className="truncate font-medium text-[#1f2329]">{actorLabel}</span>
                  </div>
                  <span className="shrink-0 text-[10px] text-[#8f959e]">
                    {formatSheetHistoryTime(entry.createdAt)}
                  </span>
                </div>

                {formulaChanged && (
                  <div className="mt-1 text-[10.5px] font-medium text-[#3370ff]">
                    {t("公式变更")}
                  </div>
                )}

                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {renderCellDiffChip(entry.prevValue, entry.prevFormula, "prev")}
                  <ArrowRight size={12} className="shrink-0 text-[#8f959e]" aria-hidden="true" />
                  {renderCellDiffChip(entry.nextValue, entry.nextFormula, "next")}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface SheetDefinedNamesPanelProps {
  sheets: SheetWorksheet[];
  activeSheet: SheetWorksheet;
  selectionBoundsRect: SheetRect;
  definedNames: SheetDefinedName[];
  canEdit: boolean;
  onUpdateDefinedNames: (next: SheetDefinedName[]) => void;
  onJumpToNamedRange?: (dn: SheetDefinedName) => void;
}

export function SheetDefinedNamesPanel({
  sheets,
  activeSheet,
  selectionBoundsRect,
  definedNames,
  canEdit,
  onUpdateDefinedNames,
  onJumpToNamedRange,
}: SheetDefinedNamesPanelProps) {
  const defaultRef = `${formatSheetRefPrefix(activeSheet.title)}${formatSheetRectA1(selectionBoundsRect)}`;
  const [nameInput, setNameInput] = useState("");
  const [scopeValue, setScopeValue] = useState<string>(WORKBOOK_SCOPE_VALUE);
  const [refInput, setRefInput] = useState(defaultRef);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    setRefInput(`${formatSheetRefPrefix(activeSheet.title)}${formatSheetRectA1(selectionBoundsRect)}`);
  }, [activeSheet.title, selectionBoundsRect.top, selectionBoundsRect.left, selectionBoundsRect.bottom, selectionBoundsRect.right]);

  const scopeOptions = [
    { value: WORKBOOK_SCOPE_VALUE, label: t("工作簿全局") },
    ...sheets.map((ws) => ({ value: ws.title, label: ws.title })),
  ];

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;
    setFormError("");
    const scopeSheet = scopeValue === WORKBOOK_SCOPE_VALUE ? undefined : scopeValue;
    const result = validateDefinedName(nameInput, refInput, scopeSheet, definedNames);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    onUpdateDefinedNames([...definedNames, result.item]);
    setNameInput("");
  };

  const handleDelete = (target: SheetDefinedName) => {
    if (!canEdit) return;
    const lowerName = target.name.toLowerCase();
    const lowerScope = (target.sheetName ?? "").toLowerCase();
    onUpdateDefinedNames(
      definedNames.filter(
        (item) =>
          !(item.name.toLowerCase() === lowerName && (item.sheetName ?? "").toLowerCase() === lowerScope),
      ),
    );
  };

  return (
    <div className="space-y-4" data-sheet-names-panel>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Tag size={14} className="text-[#3370ff]" />
          <span className="font-medium text-[#1f2329]">{t("名称管理器")}</span>
        </div>
        <span className="rounded bg-[#f2f3f5] px-1.5 py-0.5 font-mono text-[11px] text-[#3370ff]">
          {formatSheetRectA1(selectionBoundsRect)}
        </span>
      </div>

      {canEdit ? (
        <form onSubmit={handleAdd} className="space-y-2.5 rounded-lg border border-[#e5e6eb] bg-[#fafbfc] p-3">
          <label className="grid gap-1">
            <span className="text-[11px] text-[#646a73]">{t("名称")}</span>
            <input
              data-sheet-name-input
              value={nameInput}
              maxLength={64}
              onChange={(e) => {
                setNameInput(e.target.value);
                setFormError("");
              }}
              placeholder={t("例如：TaxRate 或 Q1_Sales")}
              className="h-8 rounded border border-[#dee0e3] bg-white px-2 font-mono text-[12px] outline-none focus:border-[#3370ff]"
            />
          </label>

          <div className="grid gap-1">
            <span className="text-[11px] text-[#646a73]">{t("作用域")}</span>
            <FeishuSelect
              ariaLabel={t("作用域")}
              dataAttr={{ "data-sheet-name-scope": true }}
              value={scopeValue}
              options={scopeOptions}
              onChange={(val) => {
                setScopeValue(val);
                setFormError("");
              }}
              className="h-8 w-full border border-[#dee0e3] bg-white px-2 text-[12px]"
              menuMinWidth={160}
            />
          </div>

          <label className="grid gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#646a73]">{t("引用位置")}</span>
              <button
                type="button"
                onClick={() => setRefInput(defaultRef)}
                className="text-[11px] text-[#3370ff] hover:underline"
              >
                {t("填入当前选区")}
              </button>
            </div>
            <input
              data-sheet-name-ref
              value={refInput}
              onChange={(e) => {
                setRefInput(e.target.value);
                setFormError("");
              }}
              placeholder="Sheet1!A1:C10"
              className="h-8 rounded border border-[#dee0e3] bg-white px-2 font-mono text-[12px] outline-none focus:border-[#3370ff]"
            />
          </label>

          {formError && (
            <p data-sheet-name-error className="text-[11px] text-[#d83931]">
              {formError}
            </p>
          )}

          <button
            type="submit"
            data-sheet-name-add
            className="inline-flex h-8 w-full items-center justify-center gap-1 rounded bg-[#3370ff] font-medium text-white hover:bg-[#245bdb]"
          >
            <Plus size={13} />
            <span>{t("新增定义名称")}</span>
          </button>
        </form>
      ) : (
        <p className="rounded bg-[#f7f8fa] p-2.5 text-[11px] text-[#8f959e]">
          {t("只读权限下可查看已有名称，仅编辑者可新增或删除。")}
        </p>
      )}

      <div className="space-y-2">
        <div className="text-[11px] font-medium text-[#646a73]">
          {t("已定义名称")} ({definedNames.length})
        </div>
        {definedNames.length === 0 ? (
          <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">
            {t("暂无定义名称，可在公式中直接引用自定义名称")}
          </p>
        ) : (
          definedNames.map((dn) => {
            const key = `${dn.sheetName ?? ""}::${dn.name}`;
            return (
              <div
                key={key}
                data-sheet-name-item={dn.name}
                className="rounded-md border border-[#e5e6eb] bg-white p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[12px] font-semibold text-[#1f2329]">
                    {dn.name}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="rounded bg-[#f2f3f5] px-1.5 py-0.5 text-[10px] text-[#646a73]">
                      {dn.sheetName ? dn.sheetName : t("工作簿")}
                    </span>
                    {canEdit && (
                      <button
                        type="button"
                        aria-label={t("删除名称")}
                        data-sheet-name-delete={dn.name}
                        onClick={() => handleDelete(dn)}
                        className="grid size-6 place-items-center rounded text-[#8f959e] hover:bg-[#fff2f0] hover:text-[#d83931]"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onJumpToNamedRange?.(dn)}
                    className="truncate rounded bg-[#eef3ff] px-1.5 py-0.5 font-mono text-[11px] text-[#3370ff] hover:bg-[#dce7ff]"
                    title={dn.ref}
                  >
                    ={dn.ref}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
