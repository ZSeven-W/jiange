import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ClipboardList,
  ExternalLink,
  FileSpreadsheet,
  Lock,
  Presentation,
  RefreshCw,
  Search,
  Shuffle,
  Table2,
  Trash2,
} from "lucide-react";
import {
  ApiError,
  baseApi,
  docsApi,
  sheetsApi,
  slidesApi,
  surveysApi,
  type BaseRecord,
  type Cell,
  type DocMeta,
  type Field,
  type Role,
  type SheetBatchResult,
  type SheetSnapshot,
  type SlidesPage,
  type SurveyDetailResponse,
} from "@/lib/api";
import { FeishuSelect } from "@/components/feishu-select";
import { cn } from "@/lib/utils";

export type EmbedResourceKind = "sheet" | "base" | "survey" | "slides";

export const EMBED_KINDS: { kind: EmbedResourceKind; label: string; route: string }[] = [
  { kind: "sheet", label: "电子表格", route: "sheet" },
  { kind: "base", label: "多维表格", route: "base" },
  { kind: "survey", label: "问卷", route: "survey" },
  { kind: "slides", label: "幻灯片", route: "slides" },
];

export function isEmbedResourceKind(value: string | undefined): value is EmbedResourceKind {
  return value === "sheet" || value === "base" || value === "survey" || value === "slides";
}

export function embedKindLabel(kind: string | undefined): string {
  switch (kind) {
    case "sheet":
      return "电子表格";
    case "base":
      return "多维表格";
    case "survey":
      return "问卷";
    case "slides":
      return "幻灯片";
    default:
      return "嵌入资源";
  }
}

export function embedHref(kind: string | undefined, id: string | number | undefined): string {
  const num = Number(id);
  if (!isEmbedResourceKind(kind) || !Number.isSafeInteger(num) || num <= 0) return "";
  return `#/${kind}/${num}`;
}

/** Parse a Jiange resource hash/URL such as `#/sheet/12` or `http://.../index.html#/base/8`. */
export function parseEmbedUrl(raw: string): { kind: EmbedResourceKind; id: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = /#\/(sheet|base|survey|slides)\/(\d+)(?:[/?#]|$)/.exec(trimmed)
    ?? /^\/?(sheet|base|survey|slides)\/(\d+)$/.exec(trimmed);
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { kind: match[1] as EmbedResourceKind, id };
}

function formatBaseCell(val: unknown): string {
  if (val === null || val === undefined || val === "") return "";
  if (typeof val === "boolean") return val ? "✓" : "";
  if (typeof val === "string" || typeof val === "number") return String(val);
  if (Array.isArray(val)) {
    return val
      .map((item) => {
        if (typeof item === "string" || typeof item === "number") return String(item);
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          return String(obj.name ?? obj.label ?? obj.text ?? obj.title ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("、");
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    return String(obj.name ?? obj.label ?? obj.text ?? obj.title ?? JSON.stringify(val));
  }
  return String(val);
}

const INLINE_EDITABLE_BASE_FIELD_TYPES = new Set<Field["type"]>([
  "text",
  "number",
  "select",
  "url",
  "phone",
  "email",
  "date",
]);

/** Whether a Base field supports inline quick editing inside an embedded Doc card. */
export function isBaseFieldInlineEditable(field: Pick<Field, "type">): boolean {
  return INLINE_EDITABLE_BASE_FIELD_TYPES.has(field.type);
}

export type BaseCellCoercionResult =
  | { ok: true; value: Cell | null }
  | { ok: false; error: string };

/** Convert a raw string typed inside an embedded Base cell to the API payload value. */
export function coerceBaseCellInput(
  field: Pick<Field, "type" | "options">,
  raw: string,
): BaseCellCoercionResult {
  if (field.type === "number") {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, value: null };
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return { ok: false, error: "请输入有效数字" };
    return { ok: true, value: num };
  }
  if (field.type === "select") {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, value: null };
    if (field.options?.length && !field.options.includes(trimmed)) {
      return { ok: false, error: "请选择有效选项" };
    }
    return { ok: true, value: trimmed };
  }
  if (!raw) return { ok: true, value: null };
  return { ok: true, value: raw };
}

function makeEmbedMutationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `emb-${crypto.randomUUID()}`;
  }
  return `emb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Commit an inline cell edit from an embedded Sheet card directly via `sheetsApi.writeCells`. */
export async function commitEmbedSheetCellEdit(params: {
  sheetId: number;
  userId: number;
  worksheetId: number;
  rowId: number;
  columnId: number;
  expectedRevision: number;
  raw: string;
  mutationId?: string;
}): Promise<SheetBatchResult> {
  const result = await sheetsApi.writeCells(params.sheetId, params.userId, {
    mutationId: params.mutationId ?? makeEmbedMutationId(),
    worksheetId: params.worksheetId,
    mergeMode: "auto",
    cells: [
      {
        rowId: params.rowId,
        columnId: params.columnId,
        expectedRevision: params.expectedRevision,
        raw: params.raw,
      },
    ],
  });
  if (result.conflicts?.length) {
    throw new Error("单元格已被他人修改，已刷新最新内容");
  }
  return result;
}

/** Commit an inline cell edit from an embedded Base card directly via `baseApi.setCells`. */
export async function commitEmbedBaseCellEdit(params: {
  baseId: number;
  recordId: number;
  field: Pick<Field, "id" | "type" | "options">;
  raw: string;
}): Promise<BaseRecord> {
  const parsed = coerceBaseCellInput(params.field, params.raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return baseApi.setCells(params.baseId, params.recordId, {
    [String(params.field.id)]: parsed.value,
  });
}

/** Create a new record directly from an embedded Base card via `baseApi.addRecord`. */
export async function createEmbedBaseRecord(params: {
  baseId: number;
  tableId?: number | null;
  cells?: Record<string, Cell>;
}): Promise<BaseRecord> {
  return baseApi.addRecord(params.baseId, params.cells ?? {}, params.tableId);
}

function questionTypeLabel(type: string): string {
  switch (type) {
    case "single": return "单选";
    case "multi": return "多选";
    case "text": return "简答";
    case "rating": return "评分";
    case "matrix": return "矩阵";
    case "ranking": return "排序";
    case "signature": return "签名";
    default: return type;
  }
}

function kindMeta(kind: EmbedResourceKind) {
  switch (kind) {
    case "sheet":
      return {
        label: "电子表格",
        Icon: FileSpreadsheet,
        badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300",
        border: "border-emerald-200/90 dark:border-emerald-900/70",
        headerBg: "bg-emerald-50/40 dark:bg-emerald-950/20",
      };
    case "base":
      return {
        label: "多维表格",
        Icon: Table2,
        badge: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/70 dark:text-indigo-300",
        border: "border-indigo-200/90 dark:border-indigo-900/70",
        headerBg: "bg-indigo-50/40 dark:bg-indigo-950/20",
      };
    case "survey":
      return {
        label: "问卷",
        Icon: ClipboardList,
        badge: "bg-violet-100 text-violet-700 dark:bg-violet-950/70 dark:text-violet-300",
        border: "border-violet-200/90 dark:border-violet-900/70",
        headerBg: "bg-violet-50/40 dark:bg-violet-950/20",
      };
    case "slides":
      return {
        label: "幻灯片",
        Icon: Presentation,
        badge: "bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300",
        border: "border-amber-200/90 dark:border-amber-900/70",
        headerBg: "bg-amber-50/40 dark:bg-amber-950/20",
      };
  }
}

type LoadedPreview =
  | { kind: "sheet"; snapshot: SheetSnapshot }
  | {
      kind: "base";
      baseId: number;
      activeTableId?: number;
      title: string;
      tableName: string;
      fields: Field[];
      records: BaseRecord[];
      tableCount: number;
      role?: Role;
      writeRestricted?: boolean;
    }
  | { kind: "survey"; detail: SurveyDetailResponse }
  | { kind: "slides"; title: string; pages: SlidesPage[] };

export function EmbedResourceBlock({
  resourceKind,
  resourceId,
  title,
  userId,
  readOnly,
  onBind,
  onDelete,
}: {
  resourceKind?: string;
  resourceId?: string;
  title?: string;
  userId?: number;
  readOnly?: boolean;
  onBind?: (next: { resourceKind: EmbedResourceKind; resourceId: string; title: string }) => void;
  onDelete?: () => void;
}) {
  const initialKind: EmbedResourceKind = isEmbedResourceKind(resourceKind) ? resourceKind : "sheet";
  const numericId = Number(resourceId);
  const hasResource = isEmbedResourceKind(resourceKind) && Number.isSafeInteger(numericId) && numericId > 0;

  const [picking, setPicking] = useState(!hasResource);
  const [tab, setTab] = useState<EmbedResourceKind>(initialKind);
  const [search, setSearch] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState("");
  const [candidates, setCandidates] = useState<DocMeta[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const [preview, setPreview] = useState<LoadedPreview | null>(null);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "forbidden" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!hasResource) {
      setPicking(true);
      setTab(initialKind);
    } else {
      setPicking(false);
    }
  }, [hasResource, initialKind]);

  useEffect(() => {
    if (!picking || readOnly) return;
    let alive = true;
    setLoadingList(true);
    docsApi.list()
      .then((docs) => {
        if (!alive) return;
        setCandidates(docs.filter((d) => isEmbedResourceKind(d.kind)));
      })
      .catch(() => {
        if (!alive) return;
        setCandidates([]);
      })
      .finally(() => {
        if (alive) setLoadingList(false);
      });
    return () => { alive = false; };
  }, [picking, readOnly]);

  const loadPreview = useCallback(async (opts?: { silent?: boolean }) => {
    if (!hasResource || !isEmbedResourceKind(resourceKind)) return;
    if (!opts?.silent) setStatus("loading");
    setErrorMsg("");
    try {
      if (resourceKind === "sheet") {
        if (!userId) throw new Error("请先登录以查看电子表格预览");
        const snapshot = await sheetsApi.get(numericId, userId);
        setPreview({ kind: "sheet", snapshot });
        if (!opts?.silent) setActiveSheetIdx(0);
      } else if (resourceKind === "base") {
        const snap = await baseApi.get(numericId);
        const activeTable = snap.tables?.find((t) => t.id === snap.activeTableId) ?? snap.tables?.[0];
        setPreview({
          kind: "base",
          baseId: numericId,
          activeTableId: activeTable?.id ?? snap.activeTableId,
          title: snap.base.title,
          tableName: activeTable?.name || "主数据表",
          fields: snap.fields ?? [],
          records: snap.records ?? [],
          tableCount: snap.tables?.length ?? 1,
          role: snap.base.role,
          writeRestricted: snap.writeRestricted,
        });
      } else if (resourceKind === "survey") {
        const detail = await surveysApi.get(numericId);
        setPreview({ kind: "survey", detail });
      } else if (resourceKind === "slides") {
        if (!userId) throw new Error("请先登录以查看幻灯片预览");
        const [meta, pages] = await Promise.all([
          docsApi.get(numericId).catch(() => null),
          slidesApi.pages(numericId, userId),
        ]);
        setPreview({ kind: "slides", title: meta?.title || title || `幻灯片 #${numericId}`, pages });
      }
      setStatus("idle");
    } catch (err) {
      if (!opts?.silent) setPreview(null);
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setStatus("forbidden");
        setErrorMsg(`无权查看该${embedKindLabel(resourceKind)}或资源已删除`);
      } else {
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : "加载嵌入资源失败");
      }
    }
  }, [hasResource, numericId, resourceKind, title, userId]);

  useEffect(() => {
    if (hasResource && !picking) void loadPreview();
  }, [hasResource, picking, loadPreview]);

  const filteredCandidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return candidates
      .filter((d) => d.kind === tab)
      .filter((d) => !q || (d.title || "").toLowerCase().includes(q) || String(d.id).includes(q));
  }, [candidates, tab, search]);

  const handleSelectCandidate = (doc: DocMeta) => {
    if (!onBind || !isEmbedResourceKind(doc.kind)) return;
    onBind({ resourceKind: doc.kind, resourceId: String(doc.id), title: doc.title || embedKindLabel(doc.kind) });
    setPicking(false);
    setSearch("");
    setUrlInput("");
    setUrlError("");
  };

  const handlePasteUrl = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseEmbedUrl(urlInput);
    if (!parsed) {
      setUrlError("请输入有效的链接（例如 #/sheet/1、#/base/2、#/survey/3 或 #/slides/4）");
      return;
    }
    const existing = candidates.find((c) => c.id === parsed.id && c.kind === parsed.kind);
    onBind?.({
      resourceKind: parsed.kind,
      resourceId: String(parsed.id),
      title: existing?.title || `${embedKindLabel(parsed.kind)} #${parsed.id}`,
    });
    setPicking(false);
    setUrlInput("");
    setUrlError("");
  };

  if (picking || !hasResource) {
    const meta = kindMeta(tab);
    return (
      <div
        contentEditable={false}
        data-embed-picker={tab}
        className="my-2 max-w-full rounded-lg border border-dashed border-primary/40 bg-sidebar/30 p-3.5 text-[13px]"
      >
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <meta.Icon size={15} className="text-primary" />
            <span>选择要嵌入的文档资源</span>
          </div>
          <div className="flex items-center gap-1">
            {hasResource && (
              <button
                type="button"
                onClick={() => setPicking(false)}
                className="rounded px-2 py-1 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
              >
                取消
              </button>
            )}
            {!readOnly && onDelete && (
              <button
                type="button"
                onClick={onDelete}
                aria-label="删除嵌入资源块"
                className="rounded p-1 text-muted-foreground hover:bg-hover hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>

        {!readOnly ? (
          <>
            <div className="mb-2.5 flex flex-wrap items-center gap-1">
              {EMBED_KINDS.map((item) => {
                const info = kindMeta(item.kind);
                return (
                  <button
                    key={item.kind}
                    type="button"
                    data-embed-tab={item.kind}
                    onClick={() => setTab(item.kind)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium transition-colors",
                      tab === item.kind
                        ? "bg-primary text-white"
                        : "bg-surface text-muted-foreground hover:bg-hover hover:text-foreground",
                    )}
                  >
                    <info.Icon size={13} />
                    {item.label}
                  </button>
                );
              })}
            </div>

            <div className="relative mb-2">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`搜索可访问的${embedKindLabel(tab)}…`}
                data-embed-search
                className="h-8 w-full rounded-md border bg-surface pl-8 pr-2.5 text-[12px] outline-none focus:border-primary"
              />
            </div>

            <div className="mb-2.5 max-h-44 overflow-y-auto rounded-md border bg-surface">
              {loadingList ? (
                <div className="px-3 py-4 text-center text-[12px] text-muted-foreground">正在加载资源列表…</div>
              ) : filteredCandidates.length === 0 ? (
                <div className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                  暂无匹配的{embedKindLabel(tab)}，可直接粘贴资源链接嵌入
                </div>
              ) : (
                <ul className="divide-y divide-border/60">
                  {filteredCandidates.map((doc) => (
                    <li key={doc.id}>
                      <button
                        type="button"
                        data-embed-option={doc.id}
                        onClick={() => handleSelectCandidate(doc)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-hover"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <meta.Icon size={14} className="shrink-0 text-primary" />
                          <span className="truncate font-medium text-foreground">{doc.title || `未命名${embedKindLabel(tab)}`}</span>
                        </span>
                        <span className="shrink-0 text-[11px] text-subtle">#{doc.id}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <form onSubmit={handlePasteUrl} className="flex flex-wrap items-center gap-1.5">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => { setUrlInput(e.target.value); if (urlError) setUrlError(""); }}
                placeholder="或粘贴链接（如 #/sheet/1、#/base/2、#/survey/3）"
                data-embed-url-input
                className="h-8 min-w-[200px] flex-1 rounded-md border bg-surface px-2.5 text-[12px] outline-none focus:border-primary"
              />
              <button
                type="submit"
                disabled={!urlInput.trim()}
                data-embed-url-submit
                className="inline-flex h-8 items-center rounded-md border bg-surface px-3 text-[12px] font-medium hover:bg-hover disabled:opacity-50"
              >
                嵌入
              </button>
            </form>
            {urlError && <p className="mt-1.5 text-[12px] text-destructive">{urlError}</p>}
          </>
        ) : (
          <p className="text-[12px] text-muted-foreground">未关联嵌入资源</p>
        )}
      </div>
    );
  }

  const kind = resourceKind as EmbedResourceKind;
  const meta = kindMeta(kind);
  const href = embedHref(kind, numericId);
  const resolvedTitle =
    preview?.kind === "sheet" ? preview.snapshot.title
      : preview?.kind === "base" ? preview.title
        : preview?.kind === "survey" ? preview.detail.title
          : preview?.kind === "slides" ? preview.title
            : title || `${meta.label} #${numericId}`;

  return (
    <div
      contentEditable={false}
      data-embed-block={kind}
      data-embed-id={numericId}
      className={cn("my-2.5 max-w-full overflow-hidden rounded-lg border bg-surface text-[13px] shadow-[0_1px_2px_rgba(31,35,41,0.04)]", meta.border)}
    >
      <div className={cn("flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-2", meta.headerBg)}>
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", meta.badge)}>
            <meta.Icon size={12} />
            {meta.label}
          </span>
          <a
            href={href}
            className="truncate font-medium text-foreground hover:text-primary hover:underline"
            data-embed-title
          >
            {resolvedTitle}
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void loadPreview()}
            title="刷新实时预览"
            data-embed-refresh
            className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            <RefreshCw size={12} className={status === "loading" ? "animate-spin" : undefined} />
          </button>
          {href && (
            <a
              href={href}
              title={`打开${meta.label}`}
              data-embed-open
              className="inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium text-primary hover:bg-primary/10"
            >
              <ExternalLink size={11} />
              打开
            </a>
          )}
          {!readOnly && onBind && (
            <button
              type="button"
              onClick={() => { setTab(kind); setPicking(true); }}
              title="更换嵌入资源"
              data-embed-change
              className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              <Shuffle size={12} />
            </button>
          )}
          {!readOnly && onDelete && (
            <button
              type="button"
              onClick={onDelete}
              title="移除嵌入卡片"
              className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-destructive"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="p-3">
        {status === "forbidden" ? (
          <div className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-3 text-[12px] text-muted-foreground" data-embed-forbidden>
            <Lock size={14} className="shrink-0" />
            <span>{errorMsg}</span>
          </div>
        ) : status === "error" ? (
          <div className="text-[12px] text-destructive" data-embed-error>{errorMsg}</div>
        ) : status === "loading" && !preview ? (
          <div className="py-4 text-center text-[12px] text-muted-foreground">正在加载实时预览…</div>
        ) : preview?.kind === "sheet" ? (
          <SheetEmbedPreview
            snapshot={preview.snapshot}
            activeIndex={activeSheetIdx}
            onSelectSheet={setActiveSheetIdx}
            readOnly={readOnly}
            userId={userId}
            onRefresh={() => loadPreview({ silent: true })}
          />
        ) : preview?.kind === "base" ? (
          <BaseEmbedPreview
            baseId={preview.baseId}
            activeTableId={preview.activeTableId}
            tableName={preview.tableName}
            tableCount={preview.tableCount}
            fields={preview.fields}
            records={preview.records}
            readOnly={readOnly || preview.role === "view" || !!preview.writeRestricted}
            onRefresh={() => loadPreview({ silent: true })}
          />
        ) : preview?.kind === "survey" ? (
          <SurveyEmbedPreview detail={preview.detail} />
        ) : preview?.kind === "slides" ? (
          <SlidesEmbedPreview pages={preview.pages} />
        ) : (
          <div className="text-[12px] text-muted-foreground">点击右上角打开查看完整内容</div>
        )}
      </div>
    </div>
  );
}

export function SheetEmbedPreview({
  snapshot,
  activeIndex,
  onSelectSheet,
  readOnly,
  userId,
  onRefresh,
}: {
  snapshot: SheetSnapshot;
  activeIndex: number;
  onSelectSheet: (idx: number) => void;
  readOnly?: boolean;
  userId?: number;
  onRefresh?: () => Promise<void> | void;
}) {
  const sheets = snapshot.sheets ?? [];
  const ws = sheets[Math.min(activeIndex, Math.max(0, sheets.length - 1))];
  const canEdit = !readOnly && !!userId && snapshot.role !== "view";

  const [editing, setEditing] = useState<{
    r: number;
    c: number;
    rowId: number;
    columnId: number;
    originalRaw: string;
    revision: number;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [syncState, setSyncState] = useState<"idle" | "saving" | "synced" | "error">("idle");
  const [syncError, setSyncError] = useState("");
  const [localValues, setLocalValues] = useState<Record<string, string>>({});
  const skipBlurRef = useRef(false);
  const committingRef = useRef(false);

  useEffect(() => {
    setEditing(null);
    setLocalValues({});
  }, [ws?.id, snapshot.workbookRevision]);

  useEffect(() => {
    if (syncState !== "synced") return;
    const timer = window.setTimeout(() => setSyncState("idle"), 2400);
    return () => window.clearTimeout(timer);
  }, [syncState]);

  if (!ws) return <p className="text-[12px] text-muted-foreground">暂无工作表</p>;

  const rowOrder = [...ws.rows].sort((a, b) => a.pos - b.pos);
  const colOrder = [...ws.columns].sort((a, b) => a.pos - b.pos);
  const cellMap = new Map<string, { raw: string; revision: number }>();
  let maxRowIdx = -1;
  let maxColIdx = -1;
  const rowIndexById = new Map(rowOrder.map((r, i) => [r.id, i]));
  const colIndexById = new Map(colOrder.map((c, i) => [c.id, i]));

  for (const cell of ws.cells) {
    const ri = rowIndexById.get(cell.rowId);
    const ci = colIndexById.get(cell.columnId);
    if (ri === undefined || ci === undefined) continue;
    cellMap.set(`${ri}:${ci}`, { raw: cell.raw, revision: cell.revision });
    if (cell.raw) {
      if (ri > maxRowIdx) maxRowIdx = ri;
      if (ci > maxColIdx) maxColIdx = ci;
    }
  }

  const baseRows = Math.min(Math.max(maxRowIdx + 1, 0), 6);
  const baseCols = Math.min(Math.max(maxColIdx + 1, 0), 6);
  const displayRows = baseRows > 0 ? baseRows : canEdit ? Math.min(3, rowOrder.length) : 0;
  const displayCols = baseCols > 0 ? baseCols : canEdit ? Math.min(3, colOrder.length) : 0;

  const startCellEdit = (r: number, c: number) => {
    if (!canEdit || syncState === "saving") return;
    const row = rowOrder[r];
    const col = colOrder[c];
    if (!row || !col) return;
    const key = `${r}:${c}`;
    const existing = cellMap.get(key);
    const currentRaw = Object.hasOwn(localValues, key) ? localValues[key] : (existing?.raw ?? "");
    skipBlurRef.current = false;
    setSyncError("");
    setEditing({
      r,
      c,
      rowId: row.id,
      columnId: col.id,
      originalRaw: currentRaw,
      revision: existing?.revision ?? 0,
    });
    setDraft(currentRaw);
  };

  const cancelCellEdit = () => {
    skipBlurRef.current = true;
    setEditing(null);
    setDraft("");
  };

  const commitCellEdit = async () => {
    if (!editing || !userId || committingRef.current) return;
    const target = editing;
    const nextRaw = draft;
    setEditing(null);
    if (nextRaw === target.originalRaw) return;

    committingRef.current = true;
    const coordKey = `${target.r}:${target.c}`;
    setLocalValues((prev) => ({ ...prev, [coordKey]: nextRaw }));
    setSyncState("saving");
    setSyncError("");
    try {
      await commitEmbedSheetCellEdit({
        sheetId: snapshot.nodeId,
        userId,
        worksheetId: ws.id,
        rowId: target.rowId,
        columnId: target.columnId,
        expectedRevision: target.revision,
        raw: nextRaw,
      });
      setSyncState("synced");
      await onRefresh?.();
    } catch (err) {
      setLocalValues((prev) => {
        const next = { ...prev };
        delete next[coordKey];
        return next;
      });
      setSyncState("error");
      setSyncError(err instanceof Error ? err.message : "同步单元格失败");
      await onRefresh?.();
    } finally {
      committingRef.current = false;
    }
  };

  return (
    <div data-embed-sheet-preview data-embed-editable={canEdit ? "true" : undefined}>
      {sheets.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {sheets.map((s, idx) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelectSheet(idx)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                idx === activeIndex ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300" : "bg-muted/60 text-muted-foreground hover:bg-hover",
              )}
            >
              {s.title}
            </button>
          ))}
        </div>
      )}
      {displayRows === 0 || displayCols === 0 ? (
        <div className="rounded border border-dashed py-3 text-center text-[12px] text-muted-foreground">
          工作表「{ws.title}」暂无单元格数据
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border/80">
          <table className="w-full border-collapse text-left text-[12px]">
            <tbody>
              {Array.from({ length: displayRows }, (_, r) => (
                <tr key={r} className={r === 0 ? "bg-muted/50 font-medium" : "border-t border-border/60"}>
                  {Array.from({ length: displayCols }, (_, c) => {
                    const key = `${r}:${c}`;
                    const isEditing = editing?.r === r && editing?.c === c;
                    const displayValue = Object.hasOwn(localValues, key)
                      ? localValues[key]
                      : (cellMap.get(key)?.raw ?? "");
                    return (
                      <td
                        key={c}
                        data-embed-sheet-cell={`${r}:${c}`}
                        onClick={canEdit && !isEditing ? () => startCellEdit(r, c) : undefined}
                        title={canEdit ? "点击编辑单元格" : undefined}
                        className={cn(
                          "max-w-[160px] border-r border-border/60 last:border-r-0",
                          isEditing ? "p-0.5" : "truncate px-2.5 py-1.5",
                          canEdit && !isEditing && "cursor-text hover:bg-emerald-50/70 dark:hover:bg-emerald-950/30",
                        )}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            data-embed-sheet-input
                            aria-label={`编辑第 ${r + 1} 行第 ${c + 1} 列单元格`}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => {
                              if (skipBlurRef.current) {
                                skipBlurRef.current = false;
                                return;
                              }
                              void commitCellEdit();
                            }}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.nativeEvent.isComposing) return;
                              if (e.key === "Enter") {
                                e.preventDefault();
                                skipBlurRef.current = true;
                                void commitCellEdit();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelCellEdit();
                              }
                            }}
                            className="h-6 w-full min-w-[64px] rounded border border-[#3370ff] bg-surface px-1.5 text-[12px] text-foreground outline-none"
                          />
                        ) : (
                          displayValue || (canEdit ? <span className="text-transparent select-none">·</span> : "")
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {syncError && (
        <p role="alert" className="mt-1.5 text-[11px] text-destructive" data-embed-sync-error>
          {syncError}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-subtle">
        <span>
          {sheets.length} 个工作表 · {ws.cells.filter((c) => c.raw).length} 个非空单元格
          {canEdit && " · 点击单元格即可编辑"}
        </span>
        <span className="flex items-center gap-2">
          {syncState === "saving" && <span className="text-primary">同步中…</span>}
          {syncState === "synced" && (
            <span
              data-embed-sync-badge
              className="inline-flex items-center gap-0.5 rounded bg-[#d9f7e6] px-1.5 py-0.5 font-medium text-[#0b6b3a]"
            >
              <Check size={11} />
              已同步
            </span>
          )}
          {maxRowIdx + 1 > 6 && <span>仅预览前 6 行</span>}
        </span>
      </div>
    </div>
  );
}

export function BaseEmbedPreview({
  baseId,
  activeTableId,
  tableName,
  tableCount,
  fields,
  records,
  readOnly,
  onRefresh,
}: {
  baseId: number;
  activeTableId?: number;
  tableName: string;
  tableCount: number;
  fields: Field[];
  records: BaseRecord[];
  readOnly?: boolean;
  onRefresh?: () => Promise<void> | void;
}) {
  const canEdit = !readOnly && baseId > 0;
  const visibleFields = fields.slice(0, 5);
  const [editing, setEditing] = useState<{
    recordId: number;
    field: Field;
    originalRaw: string;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [justCreatedId, setJustCreatedId] = useState<number | null>(null);
  const [addingRecord, setAddingRecord] = useState(false);
  const [syncState, setSyncState] = useState<"idle" | "saving" | "synced" | "error">("idle");
  const [syncError, setSyncError] = useState("");
  const [localCells, setLocalCells] = useState<Record<string, string>>({});
  const skipBlurRef = useRef(false);
  const committingRef = useRef(false);

  useEffect(() => {
    setLocalCells({});
  }, [records]);

  useEffect(() => {
    if (syncState !== "synced") return;
    const timer = window.setTimeout(() => setSyncState("idle"), 2400);
    return () => window.clearTimeout(timer);
  }, [syncState]);

  const nonEmptyRecords = records.filter((rec) =>
    visibleFields.some((f) => formatBaseCell(rec.cells?.[String(f.id)]) !== ""),
  );
  const baseVisible =
    records.length <= 6
      ? records
      : (nonEmptyRecords.length > 0 ? nonEmptyRecords : records).slice(0, 5);
  const createdRec = justCreatedId !== null ? records.find((r) => r.id === justCreatedId) : undefined;
  const visibleRecords =
    createdRec && !baseVisible.some((r) => r.id === createdRec.id)
      ? [...baseVisible, createdRec]
      : baseVisible;

  const startCellEdit = (rec: BaseRecord, field: Field) => {
    if (!canEdit || !isBaseFieldInlineEditable(field) || syncState === "saving") return;
    const cellKey = `${rec.id}:${field.id}`;
    const rawVal = Object.hasOwn(localCells, cellKey)
      ? localCells[cellKey]
      : formatBaseCell(rec.cells?.[String(field.id)]);
    skipBlurRef.current = false;
    setSyncError("");
    setEditing({ recordId: rec.id, field, originalRaw: rawVal });
    setDraft(rawVal);
  };

  const cancelCellEdit = () => {
    skipBlurRef.current = true;
    setEditing(null);
    setDraft("");
  };

  const commitCellEdit = async (overrideRaw?: string) => {
    if (!editing || committingRef.current) return;
    const target = editing;
    const nextRaw = overrideRaw ?? draft;
    setEditing(null);
    if (nextRaw === target.originalRaw) return;

    const checked = coerceBaseCellInput(target.field, nextRaw);
    if (!checked.ok) {
      setSyncState("error");
      setSyncError(checked.error);
      return;
    }

    committingRef.current = true;
    const cellKey = `${target.recordId}:${target.field.id}`;
    setLocalCells((prev) => ({ ...prev, [cellKey]: nextRaw }));
    setSyncState("saving");
    setSyncError("");
    try {
      await commitEmbedBaseCellEdit({
        baseId,
        recordId: target.recordId,
        field: target.field,
        raw: nextRaw,
      });
      setSyncState("synced");
      await onRefresh?.();
    } catch (err) {
      setLocalCells((prev) => {
        const next = { ...prev };
        delete next[cellKey];
        return next;
      });
      setSyncState("error");
      setSyncError(err instanceof Error ? err.message : "更新记录失败");
    } finally {
      committingRef.current = false;
    }
  };

  const handleAddRecord = async () => {
    if (!canEdit || addingRecord) return;
    setAddingRecord(true);
    setSyncState("saving");
    setSyncError("");
    try {
      const created = await createEmbedBaseRecord({
        baseId,
        tableId: activeTableId,
      });
      setJustCreatedId(created.id);
      setSyncState("synced");
      await onRefresh?.();
      const firstEditable = visibleFields.find((f) => isBaseFieldInlineEditable(f));
      if (firstEditable) {
        setEditing({ recordId: created.id, field: firstEditable, originalRaw: "" });
        setDraft("");
      }
    } catch (err) {
      setSyncState("error");
      setSyncError(err instanceof Error ? err.message : "新增记录失败");
    } finally {
      setAddingRecord(false);
    }
  };

  return (
    <div data-embed-base-preview data-embed-editable={canEdit ? "true" : undefined}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
            {tableName}
          </span>
          <span>{tableCount} 张表 · {fields.length} 个字段 · {records.length} 条记录</span>
        </div>
        <span className="flex items-center gap-1.5">
          {syncState === "saving" && <span className="text-primary">同步中…</span>}
          {syncState === "synced" && (
            <span
              data-embed-sync-badge
              className="inline-flex items-center gap-0.5 rounded bg-[#d9f7e6] px-1.5 py-0.5 font-medium text-[#0b6b3a]"
            >
              <Check size={11} />
              已同步
            </span>
          )}
        </span>
      </div>
      {visibleFields.length === 0 ? (
        <div className="rounded border border-dashed py-3 text-center text-[12px] text-muted-foreground">暂无字段定义</div>
      ) : (
        <div className="overflow-x-auto rounded border border-border/80">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="bg-muted/50 text-muted-foreground">
                {visibleFields.map((f) => (
                  <th key={f.id} className="max-w-[140px] truncate border-r border-border/60 px-2.5 py-1.5 font-medium last:border-r-0">
                    {f.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRecords.length === 0 ? (
                <tr>
                  <td colSpan={visibleFields.length} className="px-3 py-3 text-center text-muted-foreground">暂无记录</td>
                </tr>
              ) : (
                visibleRecords.map((rec) => (
                  <tr key={rec.id} data-embed-base-row={rec.id} className="border-t border-border/60">
                    {visibleFields.map((f) => {
                      const editable = canEdit && isBaseFieldInlineEditable(f);
                      const isEditing = editing?.recordId === rec.id && editing?.field.id === f.id;
                      const cellKey = `${rec.id}:${f.id}`;
                      const cellText = Object.hasOwn(localCells, cellKey)
                        ? localCells[cellKey]
                        : formatBaseCell(rec.cells?.[String(f.id)]);
                      return (
                        <td
                          key={f.id}
                          data-embed-base-cell={`${rec.id}:${f.id}`}
                          onClick={editable && !isEditing ? () => startCellEdit(rec, f) : undefined}
                          title={editable ? `点击编辑「${f.name}」` : undefined}
                          className={cn(
                            "max-w-[160px] border-r border-border/60 last:border-r-0",
                            isEditing ? "p-0.5" : "truncate px-2.5 py-1.5",
                            editable && !isEditing && "cursor-text hover:bg-indigo-50/70 dark:hover:bg-indigo-950/30",
                          )}
                        >
                          {isEditing ? (
                            f.type === "select" && f.options?.length ? (
                              <FeishuSelect
                                ariaLabel={`选择 ${f.name}`}
                                value={draft}
                                options={[
                                  { value: "", label: "（清空）" },
                                  ...f.options.map((opt) => ({ value: opt, label: opt })),
                                ]}
                                onChange={(val) => {
                                  setDraft(val);
                                  void commitCellEdit(val);
                                }}
                                className="h-6 w-full min-w-[84px] border border-[#3370ff] px-1.5 text-[12px]"
                                chevronSize={11}
                                menuMinWidth={100}
                              />
                            ) : (
                              <input
                                autoFocus
                                data-embed-base-input
                                aria-label={`编辑 ${f.name}`}
                                type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                onBlur={() => {
                                  if (skipBlurRef.current) {
                                    skipBlurRef.current = false;
                                    return;
                                  }
                                  void commitCellEdit();
                                }}
                                onKeyDown={(e) => {
                                  e.stopPropagation();
                                  if (e.nativeEvent.isComposing) return;
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    skipBlurRef.current = true;
                                    void commitCellEdit();
                                  } else if (e.key === "Escape") {
                                    e.preventDefault();
                                    cancelCellEdit();
                                  }
                                }}
                                className="h-6 w-full min-w-[72px] rounded border border-[#3370ff] bg-surface px-1.5 text-[12px] text-foreground outline-none"
                              />
                            )
                          ) : (
                            cellText || (editable ? <span className="text-transparent select-none">·</span> : "")
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
      {syncError && (
        <p role="alert" className="mt-1.5 text-[11px] text-destructive" data-embed-sync-error>
          {syncError}
        </p>
      )}
      {canEdit && visibleFields.length > 0 && (
        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            disabled={addingRecord}
            onClick={() => void handleAddRecord()}
            data-embed-base-add-record
            className="inline-flex h-7 items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50/60 px-2.5 text-[12px] font-medium text-indigo-700 transition-colors hover:bg-indigo-100/80 disabled:opacity-50 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-300"
          >
            {addingRecord ? "新增中…" : "+ 新增记录"}
          </button>
          <span className="text-[11px] text-subtle">点击文本/数字/选项单元格可直接编辑</span>
        </div>
      )}
    </div>
  );
}

function SurveyEmbedPreview({ detail }: { detail: SurveyDetailResponse }) {
  const { survey, responseCount } = detail;
  const statusInfo =
    survey.status === "published"
      ? { label: "收集中", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300" }
      : survey.status === "closed"
        ? { label: "已停止", cls: "bg-muted text-muted-foreground" }
        : { label: "草稿", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300" };
  const questions = survey.questions ?? [];

  return (
    <div data-embed-survey-preview>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className={cn("rounded px-1.5 py-0.5 font-medium", statusInfo.cls)}>{statusInfo.label}</span>
          <span>{questions.length} 道题目 · 已收集 {responseCount} 份答卷</span>
        </div>
        {survey.status === "published" && survey.publicToken && (
          <a
            href={`#/q/${survey.publicToken}`}
            data-embed-survey-fill
            className="inline-flex h-6 items-center gap-1 rounded bg-violet-600 px-2.5 text-[11px] font-medium text-white hover:bg-violet-700"
          >
            前往填写
          </a>
        )}
      </div>
      {survey.description && (
        <p className="mb-2 line-clamp-2 text-[12px] text-muted-foreground">{survey.description}</p>
      )}
      {questions.length === 0 ? (
        <div className="rounded border border-dashed py-3 text-center text-[12px] text-muted-foreground">问卷暂未添加题目</div>
      ) : (
        <ul className="space-y-1">
          {questions.slice(0, 4).map((q, idx) => (
            <li key={q.id} className="flex items-center gap-2 rounded bg-muted/35 px-2.5 py-1.5 text-[12px]">
              <span className="shrink-0 font-mono text-[11px] text-subtle">{idx + 1}.</span>
              <span className="min-w-0 flex-1 truncate text-foreground">{q.title || "未命名题目"}</span>
              <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {questionTypeLabel(q.type)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SlidesEmbedPreview({ pages }: { pages: SlidesPage[] }) {
  const visible = pages.filter((p) => !p.hidden);
  return (
    <div data-embed-slides-preview>
      <div className="mb-2 text-[11px] text-muted-foreground">共 {pages.length} 页（可见 {visible.length} 页）</div>
      {visible.length === 0 ? (
        <div className="rounded border border-dashed py-3 text-center text-[12px] text-muted-foreground">暂无可见幻灯片</div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {visible.slice(0, 4).map((page, idx) => (
            <div
              key={page.id}
              className="flex aspect-video flex-col justify-between overflow-hidden rounded border p-2 text-[11px] shadow-xs"
              style={{ background: page.background || "#ffffff" }}
            >
              <span className="text-[10px] opacity-60">#{idx + 1}</span>
              <span className="line-clamp-2 font-medium">{page.title || "无标题幻灯片"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
