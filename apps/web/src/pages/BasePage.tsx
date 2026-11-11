import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, baseApi, docsApi, type FillRule, type FilterRule, type RowHeight, type ViewConfig } from "@/lib/api";
import { ROW_HEIGHT_LABEL } from "./base/fill";
import { Dashboard } from "./base/Dashboard";
import { PALETTE, REGISTRY } from "./base/registry";
import { TypeGlyph } from "./base/cells";
import { Grid } from "./base/Grid";
import { Kanban } from "./base/Kanban";
import { Gallery } from "./base/Gallery";
import { CalendarView } from "./base/CalendarView";
import { Gantt } from "./base/Gantt";
import { AutomationsPanel } from "./base/Automations";
import { MemberRuleValue, personRuleValue } from "./base/MemberRuleValue";
import { RecordDetail } from "./base/RecordDetail";
import { useBaseSync } from "./base/sync";
import { t, useI18n } from "@/lib/i18n";
import { view } from "./base/view";
import { popupPosition } from "./base/popupPosition";
import { baseLoadError } from "./base/loadError";
import { canExportBase } from "./base/csvAvailability";
import { blocksBaseCopy, guardBaseClipboard } from "./base/copyPolicy";
import { formatBaseChange, lastBaseChange } from "./base/viewPresentation";
import { ViewTabs } from "./base/ViewTabs";
import { ViewConfigActions } from "./base/ViewConfigActions";
import { CsvImport } from "./base/CsvImport";
import { FormPublication } from "./base/FormPublication";
import { FormSetup, validFormSelection } from "./base/FormSetup";
import { saveFormConfig } from "./base/publicFormApi";
import { BaseAuthorizationEpoch, BaseAuthorizationFence, isBaseAuthorizationError, newBaseQueryScope, recordsForAuthorizedQuery } from "./base/queryAuthorization";
import { refreshWrites, useWriteLedger, WriteIssues } from "./base/writeSafety";
import { ShareDialog } from "@/components/ShareDialog";
import { go } from "@/lib/route";
import { cn } from "@/lib/utils";
import { BaseUndoStack, definedCells, type UndoApi } from "./base/undo";
import { ArrowDownUp, BarChart3, Calendar, Check, ChevronDown, ChevronRight, CircleChevronDown, ClipboardList, Eye, Filter, Home, Images, Info, KanbanSquare, LayoutDashboard, LayoutPanelTop, ListFilter, PaintBucket, PanelsTopLeft, Plus, Redo2, Rows3, Search, Settings2, Share2, Table2, Undo2, Workflow, Zap } from "lucide-react";

export { view } from "./base/view";

const OP_LABEL: Record<string, string> = {
  contains: "包含",
  not_contains: "不包含",
  is: "等于",
  is_not: "不等于",
  empty: "为空",
  not_empty: "不为空",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  checked: "已勾选",
  unchecked: "未勾选",
};

const EMPTY_CONFIG: ViewConfig = {};

/** Bitable page: views, filters/sorts (temporary until saved), grid. */
export function BasePage({ id }: { id: number }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const key = ["base", id];
  // A fresh object is required on each successful access check. The filtered
  // query is scoped to that exact authorization snapshot, never an old cache.
  const q = useQuery({ queryKey: key, queryFn: ({ signal }) => baseApi.get(id, signal), refetchOnMount: "always", structuralSharing: false });
  const [queryScope] = useState(newBaseQueryScope);
  const authorizationEpoch = useRef(new BaseAuthorizationEpoch());
  const queryEpoch = authorizationEpoch.current.read(id, q.data, q.isFetching);
  const accessReady = q.isFetchedAfterMount && q.isSuccess;
  useBaseSync(id, { ready: accessReady, restricted: !!q.data?.writeRestricted });
  const [viewId, setViewId] = useState<number | null>(null);
  // 撤销/重做：本人在本页的单元格编辑与新增记录（条件写入，不覆盖他人更新）。
  const [undoStack] = useState(() => new BaseUndoStack());
  useSyncExternalStore(undoStack.subscribe, undoStack.snapshot, undoStack.snapshot);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const [detailRecord, setDetailRecord] = useState<number | null>(null);
  const [gridDetailOpen, setGridDetailOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const { ledger, issues } = useWriteLedger(id);
  const [saveError, setSaveError] = useState(false);
  const [formSaveError, setFormSaveError] = useState<{ viewId: number; message: string } | null>(null);
  const [savingView, setSavingView] = useState(false);
  const savingKey = useRef<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const shareAnchor = useRef<HTMLButtonElement>(null);
  const [cfg, setCfgState] = useState<ViewConfig>(EMPTY_CONFIG);
  const configDrafts = useRef(new Map<string, ViewConfig>());
  const [filter, setFilter] = useState("");
  const [pane, setPane] = useState<"table" | "dashboard">("table");
  const refresh = () => qc.invalidateQueries({ queryKey: ["base", id] });

  useEffect(() => {
    if (detailRecord === null || !q.isFetchedAfterMount || q.isFetching) return;
    if (q.isError || (q.isSuccess && !q.data.records.some((record) => record.id === detailRecord))) setDetailRecord(null);
  }, [detailRecord, q.isFetchedAfterMount, q.isFetching, q.isError, q.isSuccess, q.data]);

  useEffect(() => { document.title = `${q.data?.base.title || t("未命名多维表格")} - Jiange`; }, [q.data?.base.title, locale]);
  const views = q.data?.views ?? [];
  const current = views.find((v) => v.id === viewId) ?? views[0];
  const setCfg = (next: ViewConfig) => {
    if (current) {
      const draftKey = `${id}:${current.id}`;
      if (savingKey.current !== draftKey && JSON.stringify(next) === JSON.stringify(current.config ?? EMPTY_CONFIG)) configDrafts.current.delete(draftKey);
      else configDrafts.current.set(draftKey, next);
    }
    setCfgState(next);
  };
  useEffect(() => {
    setViewId(current?.id ?? null);
    setCfgState(current ? configDrafts.current.get(`${id}:${current.id}`) ?? current.config ?? EMPTY_CONFIG : EMPTY_CONFIG);
  }, [id, current?.id, current?.config, current && JSON.stringify(current.config)]);
  // ^ load a view's saved config when switching views; JSON dep covers server updates

  const filtersActive = (cfg.filters?.rules?.length ?? 0) > 0;
  const sortsActive = (cfg.sorts?.length ?? 0) > 0;
  const queryActive = filtersActive || sortsActive;
  const serverQuery = useQuery({
    queryKey: ["base", id, "query", queryScope, queryEpoch, cfg],
    queryFn: ({ signal }) => baseApi.query(id, { filters: cfg.filters, sorts: cfg.sorts }, signal),
    enabled: queryActive && accessReady && !q.isFetching,
  });
  const queryDenied = queryActive && serverQuery.isError && isBaseAuthorizationError(serverQuery.error);
  const authorizationFence = useRef(new BaseAuthorizationFence());
  const queryAccessBlocked = authorizationFence.current.observe(q.data, q.isSuccess, q.isFetching, queryDenied, queryActive && serverQuery.isSuccess);
  const revalidateBase = q.refetch;
  useEffect(() => {
    if (!authorizationFence.current.takeAutomaticRetry(queryDenied)) return;
    void revalidateBase();
  }, [queryDenied, revalidateBase]);

  // A retained write draft may contain values or field names from a prior
  // authorization snapshot. Hide it while that snapshot is unverified.
  ledger.setAuthorization(accessReady && !q.isFetching && !queryAccessBlocked && q.data ? {
    base: q.data.base,
    fields: q.data.fields,
    records: q.data.records,
    views: q.data.views,
    expansions: q.data.expansions ?? {},
    writeRestricted: q.data.writeRestricted,
  } : null);

  if (q.isError) {
    return <div className="grid flex-1 place-items-center text-muted-foreground"><div className="space-y-3 text-center"><p role="alert">{baseLoadError(q.error)}</p><button type="button" onClick={() => void q.refetch()} className="rounded-md border px-3 py-1.5 text-[13px] hover:bg-hover">{t("重试")}</button></div></div>;
  }
  if (queryAccessBlocked) return <div className="grid flex-1 place-items-center text-muted-foreground"><div className="space-y-3 text-center"><p role="alert">{t("无法确认多维表格访问权限，已隐藏数据。")}</p><button type="button" onClick={() => void q.refetch()} className="rounded-md border px-3 py-1.5 text-[13px] hover:bg-hover">{t("重新验证")}</button></div></div>;
  if (!accessReady || !q.data) return <div className="grid flex-1 place-items-center text-[13px] text-subtle" role="status">{t("正在确认多维表格访问权限…")}</div>;
  const { base, fields, members } = q.data;
  // The previous policy is not authorization evidence while it is refreshed.
  const preventCopy = blocksBaseCopy(base, q.isFetching);
  // link/lookup 展开值写进展示缓存（cells），真值在 bt_links
  const canEdit = (base.role === "edit" || base.role === "manage") && !q.data.writeRestricted;
  const hidden = new Set(cfg.hidden ?? []);
  const visibleFields = fields.filter((f) => !hidden.has(f.id));
  const queryRecords = queryActive ? recordsForAuthorizedQuery(q.data.records, serverQuery.data?.records, q.isFetching, serverQuery.isSuccess) : [];
  const source = foldExpansions(q.data.fields, queryActive ? queryRecords : q.data.records, q.data.expansions ?? {});
  const records = view(source, visibleFields, members, null, filter);
  const directDetailOpen = !q.isFetching && detailRecord !== null && q.data.records.some((record) => record.id === detailRecord);
  const dirty = current ? JSON.stringify(cfg) !== JSON.stringify(current.config ?? EMPTY_CONFIG) : false;

  const save = async () => {
    if (!current || savingKey.current) return;
    if (current.type === "form" && (base.role !== "manage" || !validFormSelection(cfg, fields))) return;
    const draftKey = `${id}:${current.id}`;
    savingKey.current = draftKey;
    setSavingView(true);
    setSaveError(false);
    setFormSaveError(null);
    try {
      if (current.type === "form") {
        const request = new AbortController();
        const timeout = window.setTimeout(() => request.abort(), 15_000);
        try { await saveFormConfig(id, current.id, current.config ?? EMPTY_CONFIG, fields, cfg, request.signal); }
        finally { window.clearTimeout(timeout); }
      } else await baseApi.patchView(id, current.id, { config: cfg });
      if (configDrafts.current.get(draftKey) === cfg) configDrafts.current.delete(draftKey);
      await refresh();
    }
    catch (error) {
      if (current.type === "form") {
        const message = error instanceof ApiError && error.status === 409 ? t("表单或字段已变化，未保存。请检查当前配置后重试。")
          : error instanceof ApiError && [401, 403, 404].includes(error.status) ? t("权限已变化或表单不存在，未保存配置。")
          : error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status) ? t("未保存：{msg}", { msg: error.message || t("配置无效。") })
          : t("无法确认配置是否保存，请检查当前配置后重试。");
        setFormSaveError({ viewId: current.id, message });
        void refresh();
      } else setSaveError(true);
    }
    finally { savingKey.current = null; setSavingView(false); }
  };
  const newView = async (type: import("@/lib/api").View["type"], name: string) => {
    setViewMenuOpen(false);
    setViewError(null);
    const op = ledger.begin(t("新建视图"), name, "view:write");
    if (op === null) return;
    let v: import("@/lib/api").View;
    try {
      v = await baseApi.addView(id, { type, name });
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        ledger.complete(op);
        setViewError(t("无法新建视图，请检查权限或视图配置。"));
      } else {
        ledger.fail(op, t("无法确认视图是否创建，请刷新并核对后再操作。"));
        setViewError(t("无法确认视图是否创建，请核对列表。"));
      }
      refreshWrites(refresh);
      return;
    }
    ledger.complete(op);
    try { await refresh(); setViewId(v.id); setCfgState(v.config ?? EMPTY_CONFIG); }
    catch { setViewError(t("视图已创建，但列表刷新失败，请重新加载。")); }
  };
  const undoApi: UndoApi = {
    setCellsIf: (rid, expected, cells) => baseApi.setCellsIf(id, rid, expected, cells),
    deleteRecordIf: (rid, expected) => baseApi.deleteRecordIf(id, rid, expected),
    addRecord: (cells) => baseApi.addRecord(id, cells as Record<string, import("@/lib/api").Cell>),
  };
  const runUndo = async (redo: boolean) => {
    if (!canEdit || ledger.blocked("batch") || ledger.hasCellWrites()) return;
    const outcome = await (redo ? undoStack.redo(undoApi) : undoStack.undo(undoApi));
    refreshWrites(refresh);
    if (!outcome) return;
    setUndoNotice(outcome.ok ? t(redo ? "已重做：{label}" : "已撤销：{label}", { label: outcome.label }) : outcome.conflict ? t("内容已被他人修改，无法{action}「{label}」。", { action: t(redo ? "重做" : "撤销"), label: outcome.label }) : t("{action}未完成，请刷新后核对。", { action: t(redo ? "重做" : "撤销") }));
  };
  const addRecord = async () => {
    if (ledger.blocked("batch")) return;
    const op = ledger.begin(t("新增记录"), "", "record:create");
    if (op === null) return;
    try { const rec = await baseApi.addRecord(id); ledger.complete(op); undoStack.record({ label: t("新增记录"), cells: [], created: [{ rid: rec.id, cells: definedCells(rec.cells) }] }); }
    catch { ledger.fail(op, t("无法确认是否创建，请刷新并核对记录，勿直接重复新增。")); }
    finally { refreshWrites(refresh); }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-surface" onCopyCapture={(event) => guardBaseClipboard(event, preventCopy)} onCutCapture={(event) => guardBaseClipboard(event, preventCopy)}>
      <header className="flex h-16 shrink-0 items-center gap-2 border-b bg-surface pl-14 pr-3 md:px-4" data-base-header>
        <button onClick={() => go("#/")} className="hidden size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover md:grid" title={t("返回云文档")} aria-label={t("返回云文档")}><Home size={17} strokeWidth={1.6} /></button>
        <span className="hidden h-8 w-px bg-border md:block" />
        <div className="min-w-0 flex-1 px-1">
          <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
            {base.workspaceName && <><span className="hidden max-w-28 truncate text-muted-foreground sm:inline">{base.workspaceName}</span><ChevronRight size={13} className="hidden shrink-0 text-subtle sm:block" /></>}
            <span className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-[#8d6cdf] text-white"><Table2 size={11} strokeWidth={2} /></span>
            <BaseTitle id={id} title={base.title || t("未命名多维表格")} canEdit={canEdit} onRenamed={refresh} />
          </div>
          <p className="pt-0.5 text-[11px] text-subtle">{t("最近修改：{time}", { time: formatBaseChange(lastBaseChange(base.updatedAt, q.data.records)) })}{!canEdit && t(" · 只读")}</p>
        </div>
        <button ref={shareAnchor} onClick={() => setSharing(true)} className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-hover"><Share2 size={14} />{t("分享")}</button>
        {base.role === "manage" && <button onClick={() => setAutoOpen(true)} className="hidden h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] text-muted-foreground hover:bg-hover sm:flex"><Zap size={15} />{t("自动化")}</button>}
      </header>
      {!directDetailOpen && !gridDetailOpen && <WriteIssues ledger={ledger} issues={issues} />}
      {q.data.writeRestricted && <div role="status" className="border-b bg-[#fff8e8] px-4 py-2 text-[12px] text-[#8f6200]">{t("此表启用了权限视图，当前暂不支持在受限权限下编辑。你可以查看允许访问的数据。")}</div>}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[240px] shrink-0 flex-col border-r bg-surface px-3 py-3 md:flex" data-base-sidebar>
          <label className="mb-2 flex h-8 items-center gap-2 rounded-md px-2 text-subtle focus-within:bg-hover"><Search size={15}/><span className="sr-only">{t("搜索记录")}</span><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("搜索")} className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none" /></label>
          <button type="button" onClick={() => setPane("table")} aria-current={pane === "table" ? "page" : undefined} className={cn("flex h-9 items-center gap-2 rounded-md px-2.5 text-left text-[13px]", pane === "table" ? "bg-[#edf2ff] font-medium text-primary dark:bg-accent" : "text-muted-foreground hover:bg-hover")}><Table2 size={16} strokeWidth={1.7} />{t("数据表")}</button>
          <button type="button" onClick={() => setPane("dashboard")} aria-current={pane === "dashboard" ? "page" : undefined} className={cn("mt-1 flex h-9 items-center gap-2 rounded-md px-2.5 text-left text-[13px]", pane === "dashboard" ? "bg-[#edf2ff] font-medium text-primary dark:bg-accent" : "text-muted-foreground hover:bg-hover")} data-sidebar-dashboard><LayoutDashboard size={16} strokeWidth={1.7} />{t("仪表盘")}</button>
          {base.role === "manage" && <button onClick={() => setAutoOpen(true)} className="mt-1 flex h-9 items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-muted-foreground hover:bg-hover"><Workflow size={16} strokeWidth={1.7} />{t("工作流")}</button>}
          {canEdit && <button disabled={ledger.blocked("view:write")} onClick={() => setViewMenuOpen(true)} className="mt-auto flex h-8 items-center justify-center gap-1 rounded-md border text-[13px] text-muted-foreground hover:bg-hover disabled:opacity-50"><Plus size={15}/>{t("新建视图")}</button>}
        </aside>
        {pane === "dashboard" && <Dashboard records={q.data.records} fields={fields} members={members} />}
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", pane === "dashboard" && "hidden")}>
          <div className="flex min-h-0 flex-1 flex-col bg-surface">
      {/* 视图导航 */}
      <div className="flex h-11 min-w-0 shrink-0 items-center gap-1 whitespace-nowrap border-b bg-[#f7f8fa] px-3 text-[13px] dark:bg-sidebar" data-base-view-bar>
        <ViewTabs baseId={id} views={views} activeId={current?.id} canEdit={canEdit} dirty={dirty} icon={(type) => <ViewIcon type={type} />} onSelect={setViewId} onRefresh={refresh} />
        {canEdit && (
          <div className="relative shrink-0">
            <button disabled={ledger.blocked("view:write")} className="flex h-8 items-center gap-1 rounded px-2 text-subtle hover:bg-hover hover:text-foreground disabled:opacity-50" title={t("新建视图")} aria-label={t("新建视图")} aria-expanded={viewMenuOpen} onClick={() => setViewMenuOpen((v) => !v)}><Plus size={15} /><span className="hidden sm:inline">{t("新建视图")}</span></button>
            {viewMenuOpen && <div className="absolute left-0 top-8 z-30 w-44 rounded-lg border bg-surface p-1.5 shadow-lg max-sm:fixed max-sm:left-4 max-sm:top-24">
              <div className="px-2.5 pb-1 pt-1 text-[12px] text-subtle">{t("基础视图")}</div>
              {([ ["grid", "表格视图", Table2, "text-[#3370ff]"], ["kanban", "看板视图", KanbanSquare, "text-[#19a55b]"], ["calendar", "日历视图", Calendar, "text-[#0ea5a4]"], ["gantt", "甘特视图", BarChart3, "text-[#df4f9a]"], ["gallery", "画册视图", Images, "text-[#8758d8]"], ["form", "表单视图", ClipboardList, "text-[#ed823d]"] ] as const).map(([type, name, Icon, color]) => <button key={type} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-hover" onClick={() => void newView(type, t(name))}><Icon size={16} className={color} />{t(name)}</button>)}
            </div>}
          </div>
        )}
        {viewError && <span role="alert" title={viewError} className="min-w-0 max-w-28 truncate text-xs text-destructive">{viewError}</span>}
        {saveError && <span role="alert" title={t("无法确认视图是否已保存，请检查后重试")} className="min-w-0 max-w-28 truncate text-xs text-destructive">{t("无法确认视图是否已保存，请检查后重试")}</span>}
        <span className="ml-auto" aria-hidden />
        {canEdit && current && current.type !== "form" && <ViewConfigActions locked={!!cfg.locked} dirty={dirty} saving={savingView} onLockedChange={(locked) => setCfg({ ...cfg, locked: locked || undefined })} onClear={() => setCfg(current.config ?? EMPTY_CONFIG)} onSave={() => void save()} />}
      </div>
      {/* 第二行：工具栏 */}
      <div className={cn("flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap px-3 text-[13px]", current?.type !== "grid" && current?.type !== "kanban" && "border-b")} data-base-toolbar>
        {canEdit && current?.type !== "form" && <span className="mr-1 flex shrink-0 items-center gap-0.5 border-r pr-1.5">
          <button type="button" disabled={!undoStack.canUndo} onClick={() => void runUndo(false)} aria-label={t("撤销")} title={undoStack.undoLabel ? `${t("撤销")}：${undoStack.undoLabel} (⌘/Ctrl+Z)` : t("撤销")} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover disabled:opacity-30" data-base-undo><Undo2 size={16} /></button>
          <button type="button" disabled={!undoStack.canRedo} onClick={() => void runUndo(true)} aria-label={t("重做")} title={undoStack.redoLabel ? `${t("重做")}：${undoStack.redoLabel} (⌘/Ctrl+Shift+Z)` : t("重做")} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover disabled:opacity-30" data-base-redo><Redo2 size={16} /></button>
        </span>}
        {canEdit && current?.type !== "form" && <button disabled={ledger.blocked("record:create") || ledger.blocked("batch")} className="flex h-8 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-primary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50" onClick={() => void addRecord()}><Plus size={15} />{t("添加记录")}<ChevronDown size={13} className="opacity-70" aria-hidden /></button>}
        {undoNotice && <span role="status" className="mx-1 max-w-72 truncate text-xs text-subtle" title={undoNotice}>{undoNotice}</span>}
        {queryActive && serverQuery.isError && <span role="alert" className="text-xs text-destructive">{t("筛选结果不可用，请重试")}</span>}
        {queryActive && (q.isFetching || serverQuery.isLoading) && <span role="status" className="text-xs text-subtle">{t("正在加载筛选结果…")}</span>}
        {queryActive && q.data.records.length >= 10_000 && <span role="status" className="text-xs text-subtle">{t("筛选仅覆盖当前加载的记录，更多记录可能未显示。")}</span>}
        {current?.type === "grid" && <HiddenBar fields={fields} cfg={cfg} onChange={setCfg} />}
        {current?.type === "grid" && <ViewSettingsBar fields={visibleFields} cfg={cfg} onChange={setCfg} />}
        {current?.type === "kanban" && (
          <label className="flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-hover">
            <CircleChevronDown size={15} strokeWidth={1.7} aria-hidden />
            <span>{t("分组依据")}</span>
            <select
              className="cursor-pointer bg-transparent text-foreground outline-none"
              value={cfg.group ?? ""}
              onChange={(e) => setCfg({ ...cfg, group: Number(e.target.value) || undefined })}
              aria-label={t("分组依据")}
              data-group-field
            >
              <option value="">{t("选择字段")}</option>
              {fields.filter((f) => f.type === "select").map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {current?.type === "kanban" && <CardConfigBar fields={visibleFields} cfg={cfg} onChange={setCfg} />}
        {(current?.type === "grid" || current?.type === "kanban") && <FilterBar fields={fields} members={members} cfg={cfg} onChange={setCfg} />}
        {current?.type === "grid" && <GroupBar fields={fields} cfg={cfg} onChange={setCfg} />}
        {(current?.type === "grid" || current?.type === "kanban") && (
          <SortBar fields={fields} cfg={cfg} onChange={setCfg} />
        )}
        {current?.type === "grid" && <RowHeightBar cfg={cfg} onChange={setCfg} />}
        {current?.type === "grid" && <FillBar fields={fields} cfg={cfg} onChange={setCfg} />}
        <span className="ml-auto" aria-hidden />
        {(current?.type === "grid" || current?.type === "kanban") && <ToolbarSearch value={filter} onChange={setFilter} />}
        {current?.type === "form" && <FormPublication key={`${id}:${current.id}`} baseId={id} viewId={current.id} canManage={base.role === "manage" && canEdit} canPublish={!dirty && validFormSelection(current.config ?? EMPTY_CONFIG, fields)} config={current.config ?? EMPTY_CONFIG} fields={fields} onAccessChange={() => { void refresh(); }} />}
        {current?.type === "calendar" && (
          <select
            className="h-8 rounded-md bg-surface px-2 text-muted-foreground hover:bg-hover"
            value={cfg.group ?? ""}
            onChange={(e) => setCfg({ ...cfg, group: Number(e.target.value) || undefined })}
            data-calendar-field
          >
            <option value="">{t("选择日期字段")}</option>
            {fields.filter((f) => f.type === "date").map((f) => (
              <option key={f.id} value={f.id}>
                {t("按「{name}」排布", { name: f.name })}
              </option>
            ))}
          </select>
        )}
        {base.role === "manage" && (
          <button className="rounded-md px-2 py-1 text-muted-foreground hover:bg-hover hover:text-foreground sm:hidden" onClick={() => setAutoOpen(true)} data-open-automations>
            {t("自动化")}
          </button>
        )}
        {canEdit && current?.type === "grid" && <CsvImport key={id} baseId={id} onRefresh={refresh} />}
        {!canExportBase(base, q.data.writeRestricted) ? (
          <span className="rounded-md px-2 py-1 text-subtle" title={t("当前权限不支持导出")} data-export-csv>{t("导出 CSV（不可用）")}</span>
        ) : (
          <a href={`/api/bases/${id}/export`} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-hover hover:text-foreground" data-export-csv>{t("导出 CSV")}</a>
        )}
        <label className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-subtle focus-within:bg-hover md:hidden"><Search size={14} /><span className="sr-only">{t("搜索记录")}</span><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("搜索记录")} className="w-24 bg-transparent text-[12px] text-foreground outline-none" /></label>
        {current?.type !== "grid" && <span className="px-2 text-subtle">
          {records.length === source.length ? t("{n} 条记录", { n: records.length }) : t("{n} / {total} 条记录", { n: records.length, total: source.length })}
        </span>}
      </div>
      {current?.type === "gallery" && (
        <Gallery
          baseId={id}
          canEdit={canEdit}
          fields={visibleFields}
          records={records}
          members={members}
          onMutate={refresh}
          onOpen={(r) => setDetailRecord(r.id)}
        />
      )}
      {current?.type === "calendar" && (
        <CalendarView
          baseId={id}
          canEdit={canEdit}
          fields={visibleFields}
          records={records}
          members={members}
          dateFieldId={cfg.group}
          onMutate={refresh}
          onOpen={(r) => setDetailRecord(r.id)}
        />
      )}
      {current?.type === "gantt" && (
        <Gantt baseId={id} canEdit={canEdit} fields={visibleFields} records={records} members={members} startFieldId={cfg.group} onMutate={refresh} onOpen={(r) => setDetailRecord(r.id)} />
      )}
      {autoOpen && (
        <AutomationsPanel baseId={id} fields={fields} members={members} onClose={() => setAutoOpen(false)} />
      )}
      {!q.isFetching && detailRecord !== null && (() => {
        const rec = q.data.records.find((r) => r.id === detailRecord);
        const at = records.findIndex((r) => r.id === detailRecord);
        return rec ? (
          <RecordDetail
            baseId={id}
            canEdit={canEdit}
            preventCopy={preventCopy}
            fields={fields}
            record={rec}
            members={members}
            onClose={() => setDetailRecord(null)}
            onMutate={refresh}
            position={at >= 0 ? { index: at + 1, total: records.length } : undefined}
            onPrev={at > 0 ? () => setDetailRecord(records[at - 1].id) : undefined}
            onNext={at >= 0 && at < records.length - 1 ? () => setDetailRecord(records[at + 1].id) : undefined}
          />
        ) : null;
      })()}
      {current?.type === "form" && <FormSetup config={cfg} fields={fields} canEdit={base.role === "manage" && canEdit} saving={savingView} dirty={dirty} error={formSaveError?.viewId === current.id ? formSaveError.message : null} onChange={setCfg} onSave={() => void save()} onReset={() => { setCfg(current.config ?? EMPTY_CONFIG); setFormSaveError(null); }} />}
      {current?.type === "kanban" ? (
        <Kanban
          baseId={id}
          canEdit={canEdit}
          fields={visibleFields}
          records={records}
          members={members}
          groupFieldId={cfg.group}
          cardFields={cfg.card?.fields}
          coverField={cfg.card?.cover}
          onMutate={refresh}
        />
      ) : current?.type === "grid" ? (
        <Grid baseId={id} canEdit={canEdit} preventCopy={preventCopy} fields={visibleFields} allFields={fields} records={records} authorizedRecords={q.data.records} detailAccessReady={!q.isFetching} selectionAccessReady={!q.isFetching && (!queryActive || (serverQuery.isSuccess && !serverQuery.isFetching))} members={members} groupBy={cfg.group} rowHeight={cfg.rowHeight} fills={cfg.fills} frozen={cfg.frozen} undo={canEdit ? { stack: undoStack, run: (redo) => void runUndo(redo) } : undefined} onMutate={refresh} onDetailVisibilityChange={setGridDetailOpen} onFieldAction={(action, field) => {
          if (action === "sort-asc" || action === "sort-desc") setCfg({ ...cfg, sorts: [{ f: field.id, asc: action === "sort-asc" }] });
          else if (action === "group") setCfg({ ...cfg, group: field.id });
          else if (action === "freeze") setCfg({ ...cfg, frozen: visibleFields.findIndex((f) => f.id === field.id) + 1 });
          else if (action === "unfreeze") setCfg({ ...cfg, frozen: field.isPrimary ? 0 : undefined });
          else if (action === "hide") setCfg({ ...cfg, hidden: [...new Set([...(cfg.hidden ?? []), field.id])] });
          else if (action === "filter") {
            const filters = cfg.filters ?? { conj: "and" as const, rules: [] };
            setCfg({ ...cfg, filters: { ...filters, rules: [...filters.rules, { f: field.id, op: opsFor(field.type)[0], v: "" }] } });
          }
        }} />
      ) : null}
          </div>
        </div>
      </div>
      {sharing && <ShareDialog meta={base} anchorRef={shareAnchor} onClose={() => setSharing(false)} />}
    </div>
  );
}

function ViewIcon({ type }: { type: import("@/lib/api").View["type"] }) {
  const icons = { grid: Table2, kanban: KanbanSquare, gallery: Images, calendar: Calendar, gantt: BarChart3, form: ClipboardList };
  const colors = { grid: "text-[#3370ff]", kanban: "text-[#19a55b]", gallery: "text-[#8758d8]", calendar: "text-[#0ea5a4]", gantt: "text-[#df4f9a]", form: "text-[#ed823d]" };
  const Icon = icons[type] ?? Table2;
  return <Icon size={15} strokeWidth={1.7} className={colors[type]} />;
}

/** Toolbar popover: the label button toggles; outside clicks close; inner clicks stay. */
function Popover({ label, active, width = 320, icon, children }: { label: string; active?: boolean; width?: number; icon?: React.ReactNode; children: React.ReactNode | ((close: () => void) => React.ReactNode) }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof popupPosition> | null>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition(popupPosition(rect, window.innerWidth, window.innerHeight, width));
    };
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !body.current?.contains(e.target as Node)) setOpen(false);
    };
    place();
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("mousedown", close); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, width]);
  return (
    <div ref={ref} className="relative">
      <button
        className={`flex h-8 items-center gap-1.5 rounded-md px-2 hover:bg-hover ${active || open ? "bg-accent text-primary" : "text-muted-foreground"}`}
        data-popover={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {icon ?? (label.startsWith(t("筛选")) ? <Filter size={15} strokeWidth={1.7} /> : label.startsWith(t("排序")) ? <ArrowDownUp size={15} strokeWidth={1.7} /> : label.startsWith(t("分组")) ? <LayoutPanelTop size={15} strokeWidth={1.7} /> : <Settings2 size={15} strokeWidth={1.7} />)} {label}
      </button>
      {open && position && createPortal(
        <div ref={body} style={{ ...position, width }} className="fixed z-[100] max-h-[calc(100vh-32px)] overflow-y-auto rounded-lg border bg-surface p-3 text-[13px] text-foreground shadow-lg" data-popover-body={label}>
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>, document.body
      )}
    </div>
  );
}

function GroupBar({ fields, cfg, onChange }: { fields: import("@/lib/api").Field[]; cfg: ViewConfig; onChange: (value: ViewConfig) => void }) {
  const { t } = useI18n();
  return <Popover label={t("分组")} active={!!cfg.group}>
    {(close) => <div data-grid-group role="group" aria-label={t("分组字段")} className="space-y-1">
      <div className="px-2 pb-1 text-[12px] text-subtle">{t("选择分组字段")}</div>
      <button type="button" onClick={() => { onChange({ ...cfg, group: undefined }); close(); }} className="flex h-8 w-full items-center justify-between rounded px-2 text-left hover:bg-hover">{t("不分组")}{!cfg.group && <Check size={15} className="text-primary" />}</button>
      {fields.map((field) => <button key={field.id} type="button" onClick={() => { onChange({ ...cfg, group: field.id }); close(); }} className="flex h-8 w-full items-center justify-between rounded px-2 text-left hover:bg-hover"><span className="truncate">{field.name}</span>{cfg.group === field.id && <Check size={15} className="shrink-0 text-primary" />}</button>)}
    </div>}
  </Popover>;
}

function opsFor(type: string): string[] {
  switch (type) {
    case "number":
      return ["is", "is_not", "gt", "gte", "lt", "lte", "empty", "not_empty"];
    case "checkbox":
      return ["checked", "unchecked"];
    case "date":
      return ["is", "gt", "lt", "empty", "not_empty"];
    default:
      return ["contains", "not_contains", "is", "is_not", "empty", "not_empty"];
  }
}

function FilterBar({ fields, members, cfg, onChange }: { fields: import("@/lib/api").Field[]; members: import("@/lib/api").User[]; cfg: ViewConfig; onChange: (c: ViewConfig) => void }) {
  const { t } = useI18n();
  const filters = cfg.filters ?? { conj: "and" as const, rules: [] };
  const setRules = (rules: FilterRule[], conj: "and" | "or" = filters.conj) =>
    onChange({ ...cfg, filters: rules.length ? { conj, rules } : undefined });
  const noValue = (op: string) => op === "empty" || op === "not_empty" || op === "checked" || op === "unchecked";
  // 人员字段：切换字段/运算符时把值规范化为成员 id（数组或单个），避免无效配置。
  const normalized = (f: import("@/lib/api").Field | undefined, rule: FilterRule): FilterRule =>
    f?.type === "person" ? { ...rule, v: personRuleValue(rule.op, rule.v) } : rule;
  return (
    <Popover label={t("筛选{count}", { count: filters.rules.length ? ` · ${filters.rules.length}` : "" })} active={!!filters.rules.length} width={516}>
      <div className="space-y-2 p-1">
        <div className="flex items-center gap-1 pb-1 text-[14px] text-foreground" data-filter-title>
          {t("设置筛选条件")}
          <span title={t("只显示满足条件的记录；条件对所有协作者生效")} className="text-subtle"><Info size={14} strokeWidth={1.7} /></span>
        </div>
        {filters.rules.length > 1 && (
          <div className="flex items-center gap-2">
            {t("满足")}
            <select
              className="h-7 rounded border bg-surface px-1"
              value={filters.conj}
              onChange={(e) => setRules(filters.rules, e.target.value as "and" | "or")}
            >
              <option value="and">{t("全部条件（且）")}</option>
              <option value="or">{t("任一条件（或）")}</option>
            </select>
          </div>
        )}
        {filters.rules.map((rule, i) => {
          const f = fields.find((x) => x.id === rule.f) ?? fields[0];
          return (
            <div key={i} className="flex items-center gap-1">
              <select
                className="h-7 w-24 rounded border bg-surface px-1"
                value={rule.f}
                onChange={(e) => {
                  const nf = fields.find((x) => x.id === Number(e.target.value))!;
                  const rules = [...filters.rules];
                  rules[i] = normalized(nf, { ...rule, f: nf.id, op: opsFor(nf.type)[0] });
                  setRules(rules);
                }}
              >
                {fields.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <select
                className="h-7 w-24 rounded border bg-surface px-1"
                value={rule.op}
                onChange={(e) => {
                  const rules = [...filters.rules];
                  rules[i] = normalized(f, { ...rule, op: e.target.value });
                  setRules(rules);
                }}
              >
                {opsFor(f?.type ?? "text").map((op) => (
                  <option key={op} value={op}>
                    {t(OP_LABEL[op])}
                  </option>
                ))}
              </select>
              {!noValue(rule.op) &&
                (f?.type === "person" ? (
                  <MemberRuleValue rule={rule} members={members} onChange={(v) => { const rules = [...filters.rules]; rules[i] = { ...rule, v }; setRules(rules); }} />
                ) : f?.type === "checkbox" ? null : (
                  <input
                    className="h-7 flex-1 rounded border px-2 outline-none focus:border-primary"
                    type={f?.type === "number" ? "number" : "text"}
                    value={String(rule.v ?? "")}
                    onChange={(e) => {
                      const rules = [...filters.rules];
                      rules[i] = { ...rule, v: f?.type === "number" ? Number(e.target.value) : e.target.value };
                      setRules(rules);
                    }}
                  />
                ))}
              <button className="px-1 text-subtle hover:text-destructive" onClick={() => setRules(filters.rules.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          );
        })}
        <div className={cn("flex items-center justify-between", filters.rules.length > 0 && "border-t pt-2")}>
          <button className="-ml-1 flex h-8 items-center gap-1 rounded-md px-1 text-[14px] text-foreground hover:bg-hover" onClick={() => { const nf = fields[0]; setRules([...filters.rules, nf?.type === "person" ? { f: nf.id, op: "contains", v: [] } : { f: nf?.id ?? 0, op: opsFor(nf?.type ?? "text")[0], v: "" }]); }}>
            <Plus size={16} strokeWidth={1.7} /> {t("添加条件")}
          </button>
          {filters.rules.length > 0 && (
            <button className="text-subtle hover:text-foreground" onClick={() => setRules([])}>
              {t("清空")}
            </button>
          )}
        </div>
      </div>
    </Popover>
  );
}

function SortBar({ fields, cfg, onChange }: { fields: import("@/lib/api").Field[]; cfg: ViewConfig; onChange: (c: ViewConfig) => void }) {
  const { t } = useI18n();
  const sorts = cfg.sorts ?? [];
  const setSorts = (s: typeof sorts) => onChange({ ...cfg, sorts: s.length ? s : undefined });
  return (
    <Popover label={t("排序{count}", { count: sorts.length ? ` · ${sorts.length}` : "" })} active={!!sorts.length}>
      <div className="space-y-2">
        {sorts.map((s, i) => (
          <div key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-subtle">{t("然后")}</span>}
            <select
              className="h-7 flex-1 rounded border bg-surface px-1"
              value={s.f}
              onChange={(e) => {
                const next = [...sorts];
                next[i] = { ...s, f: Number(e.target.value) };
                setSorts(next);
              }}
            >
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <button
              className="h-7 rounded border px-2"
              onClick={() => {
                const next = [...sorts];
                next[i] = { ...s, asc: !s.asc };
                setSorts(next);
              }}
            >
              {s.asc ? t("↑ 升序") : t("↓ 降序")}
            </button>
            <button className="px-1 text-subtle hover:text-destructive" onClick={() => setSorts(sorts.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button className="text-primary hover:underline" onClick={() => setSorts([...sorts, { f: fields[0]?.id ?? 0, asc: true }])}>
          {t("+ 添加排序")}
        </button>
      </div>
    </Popover>
  );
}

function HiddenBar({ fields, cfg, onChange }: { fields: import("@/lib/api").Field[]; cfg: ViewConfig; onChange: (c: ViewConfig) => void }) {
  const { t } = useI18n();
  const hidden = new Set(cfg.hidden ?? []);
  return (
    <Popover label={t("字段配置")} active={hidden.size > 0}>
      <div className="max-h-64 space-y-1 overflow-auto">
        {fields.map((f) => (
          <label key={f.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-hover">
            <input
              type="checkbox"
              className="accent-primary"
              checked={!hidden.has(f.id)}
              disabled={!!f.isPrimary && !hidden.has(f.id)}
              title={f.isPrimary ? t("主字段不能隐藏") : undefined}
              onChange={(e) => {
                const next = new Set(hidden);
                if (e.target.checked) next.delete(f.id);
                else next.add(f.id);
                onChange({ ...cfg, hidden: next.size ? [...next] : undefined });
              }}
            />
            {f.name}
          </label>
        ))}
      </div>
    </Popover>
  );
}

function ViewSettingsBar({ fields, cfg, onChange }: { fields: import("@/lib/api").Field[]; cfg: ViewConfig; onChange: (c: ViewConfig) => void }) {
  const { t } = useI18n();
  const frozen = Math.min(cfg.frozen ?? 1, fields.length);
  return (
    <Popover label={t("视图配置")} icon={<PanelsTopLeft size={15} strokeWidth={1.7} />} width={280}>
      <div className="space-y-3 p-1" data-view-settings>
        <div className="text-[14px] text-foreground">{t("视图配置")}</div>
        <label className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{t("冻结列")}</span>
          <select className="h-8 w-36 rounded-md border bg-surface px-2" value={frozen} onChange={(e) => onChange({ ...cfg, frozen: Number(e.target.value) === 1 ? undefined : Number(e.target.value) })} data-frozen-select>
            <option value={0}>{t("不冻结")}</option>
            {fields.slice(0, 6).map((f, i) => <option key={f.id} value={i + 1}>{t("冻结至「{name}」", { name: f.name })}</option>)}
          </select>
        </label>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{t("行高")}</span>
          <div className="flex rounded-md border p-0.5">
            {(Object.keys(ROW_HEIGHT_LABEL) as RowHeight[]).map((h) => <button key={h} type="button" onClick={() => onChange({ ...cfg, rowHeight: h === "low" ? undefined : h })} className={cn("h-7 rounded px-2 text-[12px]", (cfg.rowHeight ?? "low") === h ? "bg-accent text-primary" : "text-muted-foreground hover:bg-hover")}>{t(ROW_HEIGHT_LABEL[h])}</button>)}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{t("填色规则")}</span>
          <span className="text-subtle">{cfg.fills?.length ? t("{n} 条", { n: cfg.fills.length }) : t("无")}</span>
        </div>
      </div>
    </Popover>
  );
}

function RowHeightBar({ cfg, onChange }: { cfg: ViewConfig; onChange: (c: ViewConfig) => void }) {
  const { t } = useI18n();
  const current = cfg.rowHeight ?? "low";
  return (
    <Popover label={t("行高")} icon={<Rows3 size={15} strokeWidth={1.7} />} active={current !== "low"} width={160}>
      {(close) => <div role="menu" aria-label={t("行高")} className="space-y-0.5" data-row-height-menu>
        {(Object.keys(ROW_HEIGHT_LABEL) as RowHeight[]).map((h) => (
          <button key={h} type="button" role="menuitemradio" aria-checked={current === h} onClick={() => { onChange({ ...cfg, rowHeight: h === "low" ? undefined : h }); close(); }} className="flex h-8 w-full items-center justify-between rounded px-2 text-left hover:bg-hover" data-row-height={h}>
            {t(ROW_HEIGHT_LABEL[h])}{current === h && <Check size={15} className="text-primary" />}
          </button>
        ))}
      </div>}
    </Popover>
  );
}

function FillBar({ fields, cfg, onChange }: { fields: import("@/lib/api").Field[]; cfg: ViewConfig; onChange: (c: ViewConfig) => void }) {
  const { t } = useI18n();
  const rules = cfg.fills ?? [];
  const set = (next: FillRule[]) => onChange({ ...cfg, fills: next.length ? next : undefined });
  const noValue = (op: string) => op === "empty" || op === "not_empty" || op === "checked" || op === "unchecked";
  return (
    <Popover label={t("填色{count}", { count: rules.length ? ` · ${rules.length}` : "" })} icon={<PaintBucket size={15} strokeWidth={1.7} />} active={rules.length > 0} width={560}>
      <div className="space-y-2 p-1" data-fill-panel>
        <div className="text-[14px] text-foreground">{t("设置填色条件")} <span className="text-[12px] text-subtle">{t("满足条件的记录整行填充颜色，按顺序取第一条")}</span></div>
        {rules.map((rule, i) => {
          const f = fields.find((x) => x.id === rule.f) ?? fields[0];
          const patch = (p: Partial<FillRule>) => set(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
          return (
            <div key={i} className="flex items-center gap-1.5" data-fill-rule={i}>
              <div className="flex shrink-0 gap-0.5">
                {PALETTE.slice(0, 6).map(([bg, fg], c) => <button key={c} type="button" title={t("填充颜色")} aria-label={t("颜色 {n}", { n: c + 1 })} onClick={() => patch({ color: c })} className={cn("size-5 rounded border", rule.color === c ? "ring-2 ring-primary ring-offset-1" : "border-transparent")} style={{ background: bg, borderColor: fg + "33" }} />)}
              </div>
              <select className="h-7 w-24 rounded border bg-surface px-1" value={rule.f} onChange={(e) => { const nf = fields.find((x) => x.id === Number(e.target.value))!; patch({ f: nf.id, op: opsFor(nf.type)[0], v: "" }); }}>
                {fields.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <select className="h-7 w-24 rounded border bg-surface px-1" value={rule.op} onChange={(e) => patch({ op: e.target.value })}>
                {opsFor(f?.type ?? "text").map((op) => <option key={op} value={op}>{t(OP_LABEL[op])}</option>)}
              </select>
              {!noValue(rule.op) && (f?.type === "select" ? (
                <select className="h-7 min-w-0 flex-1 rounded border bg-surface px-1" value={String(rule.v ?? "")} onChange={(e) => patch({ v: e.target.value })}>
                  <option value="">{t("选择选项")}</option>
                  {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input className="h-7 min-w-0 flex-1 rounded border px-2 outline-none focus:border-primary" type={f?.type === "number" ? "number" : f?.type === "date" ? "date" : "text"} value={String(rule.v ?? "")} placeholder={t("请输入")} onChange={(e) => patch({ v: f?.type === "number" ? Number(e.target.value) : e.target.value })} />
              ))}
              <button type="button" className="px-1 text-subtle hover:text-destructive" aria-label={t("删除填色条件")} onClick={() => set(rules.filter((_, j) => j !== i))}>✕</button>
            </div>
          );
        })}
        <div className={cn("flex items-center justify-between", rules.length > 0 && "border-t pt-2")}>
          <button type="button" className="-ml-1 flex h-8 items-center gap-1 rounded-md px-1 text-[14px] text-foreground hover:bg-hover" onClick={() => fields[0] && set([...rules, { f: fields[0].id, op: opsFor(fields[0].type)[0], v: "", color: rules.length % 6 }])} data-fill-add>
            <Plus size={16} strokeWidth={1.7} /> {t("添加条件")}
          </button>
          {rules.length > 0 && <button type="button" className="text-subtle hover:text-foreground" onClick={() => set([])}>{t("清空")}</button>}
        </div>
      </div>
    </Popover>
  );
}

function CardConfigBar({ fields, cfg, onChange }: { fields: import("@/lib/api").Field[]; cfg: ViewConfig; onChange: (c: ViewConfig) => void }) {
  const { t } = useI18n();
  const primary = fields.find((f) => f.isPrimary);
  const group = cfg.group ?? fields.find((f) => f.type === "select")?.id;
  const candidates = fields.filter((f) => f.id !== primary?.id && f.id !== group);
  const shown = cfg.card?.fields ?? candidates.filter((f) => !REGISTRY[f.type].readonly).slice(0, 2).map((f) => f.id);
  const attachments = fields.filter((f) => f.type === "attachment");
  const setCard = (card: NonNullable<ViewConfig["card"]>) => onChange({ ...cfg, card });
  return (
    <Popover label={t("卡片配置")} icon={<Settings2 size={15} strokeWidth={1.7} />} active={!!cfg.card} width={300}>
      <div className="space-y-3 p-1" data-card-config>
        <div className="text-[14px] text-foreground">{t("卡片配置")}</div>
        <label className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{t("封面")}</span>
          <select className="h-8 w-40 rounded-md border bg-surface px-2" value={cfg.card?.cover ?? ""} onChange={(e) => setCard({ fields: cfg.card?.fields, cover: Number(e.target.value) || null })} data-card-cover-select>
            <option value="">{t("无封面")}</option>
            {attachments.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <div>
          <div className="mb-1 flex items-center justify-between text-muted-foreground"><span>{t("卡片显示字段")}</span><span className="text-[12px] text-subtle">{t("标题始终显示「{name}」", { name: primary?.name ?? t("主字段") })}</span></div>
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {candidates.map((f) => (
              <label key={f.id} className="flex h-8 cursor-pointer items-center gap-2 rounded px-1.5 hover:bg-hover">
                <input type="checkbox" className="accent-primary" checked={shown.includes(f.id)} onChange={(e) => setCard({ cover: cfg.card?.cover, fields: e.target.checked ? [...shown, f.id] : shown.filter((id) => id !== f.id) })} data-card-field={f.id} />
                <span className="text-muted-foreground"><TypeGlyph t={f.type} size={14} /></span>{f.name}
              </label>
            ))}
            {candidates.length === 0 && <p className="px-1.5 text-[12px] text-subtle">{t("没有其它字段")}</p>}
          </div>
        </div>
      </div>
    </Popover>
  );
}

function ToolbarSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(!!value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  if (!open) return <button type="button" className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover" title={t("搜索")} aria-label={t("搜索表格")} onClick={() => setOpen(true)} data-toolbar-search><Search size={16} strokeWidth={1.7} /></button>;
  return (
    <label className="flex h-8 w-56 shrink-0 items-center gap-1.5 rounded-md border px-2 text-subtle focus-within:border-primary">
      <Search size={14} />
      <input ref={input} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { onChange(""); setOpen(false); } }} placeholder={t("搜索表格内容")} className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none" data-toolbar-search-input />
      <button type="button" aria-label={t("关闭搜索")} onClick={() => { onChange(""); setOpen(false); }} className="text-subtle hover:text-foreground">✕</button>
    </label>
  );
}

function BaseTitle({ id, title, canEdit, onRenamed }: { id: number; title: string; canEdit: boolean; onRenamed: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(title);
  const [error, setError] = useState(false);
  const [failedName, setFailedName] = useState("");
  const [saving, setSaving] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => { if (!editing) setV(title); }, [title, editing]);
  useEffect(() => { if (!canEdit) { cancelled.current = true; setEditing(false); } }, [canEdit]);
  const commit = async () => {
    if (!canEdit || cancelled.current) { setEditing(false); return; }
    setEditing(false);
    const t = v.trim();
    if (!t || t === title) return;
    setError(false);
    setSaving(true);
    try { await docsApi.rename(id, t); setFailedName(""); } catch { setFailedName(t); setError(true); }
    finally { setSaving(false); }
    qc.invalidateQueries({ queryKey: ["base", id] });
    qc.invalidateQueries({ queryKey: ["docs"] });
    onRenamed();
  };
  if (editing)
    return (
      <input
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            setV(title);
            setEditing(false);
          }
        }}
        className="h-8 w-64 rounded-md border px-2 text-[15px] font-normal outline-none focus:border-primary"
        data-base-title-input
      />
    );
  return (
    <span className="min-w-0 truncate"><span className={cn("-mx-1 rounded px-1", canEdit && !saving && "cursor-text hover:bg-hover")} title={canEdit && !saving ? t("点击重命名") : title} onClick={() => { if (canEdit && !saving) { cancelled.current = false; setV(error ? failedName : title); setEditing(true); } }} data-base-title>{title}</span>{saving && <span className="ml-1 text-xs text-subtle">{t("保存中…")}</span>}{error && <span role="alert" className="ml-1 text-xs text-destructive">{t("无法确认名称是否已保存，点击可查看输入")}</span>}</span>
  );
}

/** 把服务端的 expansions（关联/查找引用）折进 records 的展示 cells。 */
export function foldExpansions(
  fields: import("@/lib/api").Field[],
  records: import("@/lib/api").BaseRecord[],
  expansions: Record<string, unknown>,
): import("@/lib/api").BaseRecord[] {
  const linkIds = new Set(fields.filter((f) => f.type === "link").map((f) => String(f.id)));
  const lookupIds = new Set(fields.filter((f) => f.type === "lookup").map((f) => String(f.id)));
  const titles = expansions as Record<string, Record<string, unknown>>;
  const has = [...linkIds].some((k) => titles[k]) || [...lookupIds].some((k) => titles[k]);
  if (!has) return records;
  return records.map((r) => {
    const key = String(r.id);
    const cells = { ...r.cells };
    for (const fid of linkIds) {
      const links = titles[fid]?.[key] as number[] | undefined;
      const tmap = (titles[fid + ":titles"] ?? {}) as Record<string, string>;
      if (links) cells[fid] = links.map((id) => tmap[String(id)] ?? `#${id}`) as unknown as import("@/lib/api").Cell;
    }
    for (const fid of lookupIds) {
      const vals = titles[fid]?.[key] as unknown[] | undefined;
      if (vals) cells[fid] = vals as unknown as import("@/lib/api").Cell;
    }
    return { ...r, cells };
  });
}
