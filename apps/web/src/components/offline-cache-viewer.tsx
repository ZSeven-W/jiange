import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Clock,
  Database,
  ExternalLink,
  Eye,
  FileSpreadsheet,
  FileText,
  HardDrive,
  Layers,
  List,
  Presentation,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  MAX_OFFLINE_SNAPSHOT_BYTES,
  type OfflineMutation,
  type OfflineSnapshot,
  type OfflineSnapshotKind,
} from "@/lib/offline-db";
import { useOfflineState, type OfflineStateHookValue } from "@/lib/offline-sync";
import { go } from "@/lib/route";
import { cn } from "@/lib/utils";

export const OFFLINE_CACHE_DRAWER_EVENT = "jiange:open-offline-cache-drawer";

export type OfflineCacheTab = "snapshots" | "queue";

/**
 * Broadcasts a global event to open the slide-over offline cache drawer on the chosen tab.
 */
export function openOfflineCacheDrawer(tab: OfflineCacheTab = "snapshots"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OfflineCacheTab>(OFFLINE_CACHE_DRAWER_EVENT, { detail: tab }));
}

export function formatOfflineBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatOfflineTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function offlineSnapshotHref(snapshot: Pick<OfflineSnapshot, "key" | "kind" | "resourceId">): string | null {
  const id = snapshot.resourceId;
  if (snapshot.kind === "doc" && id && Number.isSafeInteger(id) && id > 0) return `#/doc/${id}`;
  if (snapshot.kind === "sheet" && id && Number.isSafeInteger(id) && id > 0) return `#/sheet/${id}`;
  if (snapshot.kind === "base" && id && Number.isSafeInteger(id) && id > 0) return `#/base/${id}`;
  if (snapshot.kind === "slides" && id && Number.isSafeInteger(id) && id > 0) return `#/slides/${id}`;
  if (snapshot.kind === "list") {
    if (snapshot.key === "list:docs") return "#/";
    if (snapshot.key === "list:recent") return "#/recent";
    if (snapshot.key === "list:favorites") return "#/favorites";
  }
  return null;
}

export function columnIndexToLetters(index: number): string {
  let n = index;
  let out = "";
  while (n >= 0) {
    out = String.fromCharCode((n % 26) + 65) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

interface PreviewSpan {
  text: string;
  marks?: Record<string, unknown>;
}

interface PreviewDocBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  spans: PreviewSpan[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractDocBlocks(data: unknown): PreviewDocBlock[] {
  if (!isRecord(data)) return [];
  const rawBlocks = Array.isArray(data.blocks)
    ? data.blocks
    : isRecord(data.view) && Array.isArray(data.view.blocks)
      ? data.view.blocks
      : null;

  if (rawBlocks) {
    const parsed: PreviewDocBlock[] = [];
    for (let i = 0; i < rawBlocks.length; i++) {
      const b = rawBlocks[i];
      if (!isRecord(b)) continue;
      const id = typeof b.id === "string" && b.id ? b.id : `blk-${i}`;
      const type = typeof b.type === "string" && b.type ? b.type : "paragraph";
      const props = isRecord(b.props) ? b.props : undefined;
      let spans: PreviewSpan[] = [];
      if (Array.isArray(b.spans)) {
        spans = b.spans
          .filter(isRecord)
          .map((s) => ({
            text: typeof s.text === "string" ? s.text : "",
            marks: isRecord(s.marks) ? s.marks : undefined,
          }));
      } else if (typeof b.text === "string") {
        spans = [{ text: b.text }];
      }
      parsed.push({ id, type, props, spans });
    }
    return parsed;
  }

  const rawText =
    typeof data.content === "string"
      ? data.content
      : typeof data.markdown === "string"
        ? data.markdown
        : typeof data.text === "string"
          ? data.text
          : null;
  if (rawText !== null && rawText.trim().length > 0) {
    return rawText.split(/\r?\n/).map((line, i) => ({
      id: `line-${i}`,
      type: line.startsWith("# ")
        ? "heading1"
        : line.startsWith("## ")
          ? "heading2"
          : line.startsWith("### ")
            ? "heading3"
            : "paragraph",
      spans: [{ text: line.replace(/^#{1,3}\s+/, "") }],
    }));
  }

  return [];
}

interface PreviewSheetCell {
  raw: string;
  bold?: boolean;
  italic?: boolean;
  bg?: string;
  color?: string;
  align?: string;
}

interface PreviewWorksheet {
  id: string;
  title: string;
  rowCount: number;
  colCount: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
  grid: Map<string, PreviewSheetCell>;
}

const MAX_PREVIEW_ROWS = 100;
const MAX_PREVIEW_COLS = 26;

function extractWorksheets(data: unknown): PreviewWorksheet[] {
  if (!isRecord(data)) return [];
  const rawSheets = Array.isArray(data.sheets)
    ? data.sheets
    : Array.isArray(data.worksheets)
      ? data.worksheets
      : null;

  if (rawSheets && rawSheets.length > 0) {
    const out: PreviewWorksheet[] = [];
    for (let sIdx = 0; sIdx < rawSheets.length; sIdx++) {
      const ws = rawSheets[sIdx];
      if (!isRecord(ws)) continue;
      const title =
        typeof ws.title === "string" && ws.title.trim() ? ws.title.trim() : `Sheet ${sIdx + 1}`;
      const id = String(ws.id ?? sIdx);
      const grid = new Map<string, PreviewSheetCell>();

      const rawRows = Array.isArray(ws.rows) ? ws.rows.filter(isRecord) : [];
      const rawCols = Array.isArray(ws.columns) ? ws.columns.filter(isRecord) : [];
      const rawCells = Array.isArray(ws.cells) ? ws.cells.filter(isRecord) : [];

      const rowIndexById = new Map<number, number>();
      const sortedRows = [...rawRows].sort(
        (a, b) => Number(a.pos ?? 0) - Number(b.pos ?? 0),
      );
      sortedRows.forEach((r, idx) => {
        if (typeof r.id === "number") rowIndexById.set(r.id, idx);
      });

      const colIndexById = new Map<number, number>();
      const sortedCols = [...rawCols].sort(
        (a, b) => Number(a.pos ?? 0) - Number(b.pos ?? 0),
      );
      sortedCols.forEach((c, idx) => {
        if (typeof c.id === "number") colIndexById.set(c.id, idx);
      });

      let maxRow = Math.max(0, sortedRows.length - 1);
      let maxCol = Math.max(0, sortedCols.length - 1);

      for (const cell of rawCells) {
        let rIdx = -1;
        let cIdx = -1;
        if (typeof cell.rowId === "number" && rowIndexById.has(cell.rowId)) {
          rIdx = rowIndexById.get(cell.rowId)!;
        } else if (typeof cell.row === "number") {
          rIdx = cell.row;
        }
        if (typeof cell.columnId === "number" && colIndexById.has(cell.columnId)) {
          cIdx = colIndexById.get(cell.columnId)!;
        } else if (typeof cell.col === "number") {
          cIdx = cell.col;
        }
        if (rIdx < 0 || cIdx < 0) continue;
        maxRow = Math.max(maxRow, rIdx);
        maxCol = Math.max(maxCol, cIdx);
        if (rIdx >= MAX_PREVIEW_ROWS || cIdx >= MAX_PREVIEW_COLS) continue;

        const style = isRecord(cell.style) ? cell.style : undefined;
        const raw =
          typeof cell.raw === "string"
            ? cell.raw
            : cell.value !== undefined && cell.value !== null
              ? String(cell.value)
              : "";
        grid.set(`${rIdx}:${cIdx}`, {
          raw,
          bold: Boolean(style?.bold),
          italic: Boolean(style?.italic),
          bg: typeof style?.bg === "string" ? style.bg : undefined,
          color: typeof style?.color === "string" ? style.color : undefined,
          align: typeof style?.align === "string" ? style.align : undefined,
        });
      }

      const totalRows = rawCells.length > 0 || sortedRows.length > 0 ? maxRow + 1 : 0;
      const totalCols = rawCells.length > 0 || sortedCols.length > 0 ? maxCol + 1 : 0;
      out.push({
        id,
        title,
        rowCount: Math.min(totalRows, MAX_PREVIEW_ROWS),
        colCount: Math.min(totalCols, MAX_PREVIEW_COLS),
        truncatedRows: totalRows > MAX_PREVIEW_ROWS,
        truncatedCols: totalCols > MAX_PREVIEW_COLS,
        grid,
      });
    }
    return out;
  }

  // Simple 2D matrix fallback: `{ rows: string[][] }`
  if (Array.isArray(data.rows) && data.rows.every((r) => Array.isArray(r))) {
    const matrix = data.rows as unknown[][];
    const grid = new Map<string, PreviewSheetCell>();
    let maxCols = 0;
    const rowCount = Math.min(matrix.length, MAX_PREVIEW_ROWS);
    for (let r = 0; r < rowCount; r++) {
      const row = matrix[r];
      maxCols = Math.max(maxCols, row.length);
      for (let c = 0; c < Math.min(row.length, MAX_PREVIEW_COLS); c++) {
        const val = row[c];
        if (val !== null && val !== undefined && String(val) !== "") {
          grid.set(`${r}:${c}`, { raw: String(val) });
        }
      }
    }
    return [
      {
        id: "0",
        title: "Sheet1",
        rowCount,
        colCount: Math.min(maxCols, MAX_PREVIEW_COLS),
        truncatedRows: matrix.length > MAX_PREVIEW_ROWS,
        truncatedCols: maxCols > MAX_PREVIEW_COLS,
        grid,
      },
    ];
  }

  return [];
}

function formatBaseCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "✓" : "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (isRecord(item) && typeof item.name === "string") return item.name;
        return String(item);
      })
      .join(", ");
  }
  return JSON.stringify(value);
}

function KindBadge({ kind }: { kind: OfflineSnapshotKind }) {
  const { t } = useI18n();
  const config: Record<
    OfflineSnapshotKind,
    { label: string; className: string; Icon: typeof FileText }
  > = {
    doc: {
      label: t("文档"),
      className: "bg-[#e8f0ff] text-[#1456f0] dark:bg-[#1d3461] dark:text-[#9cbdff]",
      Icon: FileText,
    },
    sheet: {
      label: t("电子表格"),
      className: "bg-[#e6f7ee] text-[#008a3b] dark:bg-[#133322] dark:text-[#6ee7a0]",
      Icon: FileSpreadsheet,
    },
    base: {
      label: t("多维表格"),
      className: "bg-[#f3e8ff] text-[#6d28d9] dark:bg-[#2e1d4d] dark:text-[#c4b5fd]",
      Icon: Layers,
    },
    slides: {
      label: t("幻灯片"),
      className: "bg-[#fff3e6] text-[#c25400] dark:bg-[#3d2511] dark:text-[#fdba74]",
      Icon: Presentation,
    },
    list: {
      label: t("列表"),
      className: "bg-[#f0f1f5] text-[#4e5969] dark:bg-[#2a2e38] dark:text-[#c9cdd4]",
      Icon: List,
    },
  };
  const { label, className, Icon } = config[kind];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
        className,
      )}
    >
      <Icon size={11} strokeWidth={2} aria-hidden="true" />
      {label}
    </span>
  );
}

function MethodBadge({ method }: { method: OfflineMutation["method"] }) {
  const colors: Record<OfflineMutation["method"], string> = {
    POST: "bg-[#e8f0ff] text-[#1456f0] dark:bg-[#1d3461] dark:text-[#9cbdff]",
    PATCH: "bg-[#fff3e6] text-[#b45309] dark:bg-[#3d2511] dark:text-[#fdba74]",
    PUT: "bg-[#f3e8ff] text-[#6d28d9] dark:bg-[#2e1d4d] dark:text-[#c4b5fd]",
    DELETE: "bg-[#ffece8] text-[#d93025] dark:bg-[#3e1a18] dark:text-[#fca5a5]",
  };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[10.5px] font-semibold",
        colors[method],
      )}
    >
      {method}
    </span>
  );
}

function renderInlineSpans(spans: PreviewSpan[]) {
  if (spans.length === 0) return <span className="text-subtle"> </span>;
  return spans.map((span, idx) => {
    const marks = span.marks ?? {};
    const bold = Boolean(marks.bold || marks.b);
    const italic = Boolean(marks.italic || marks.i);
    const strike = Boolean(marks.strike || marks.s);
    const code = Boolean(marks.code);
    if (code) {
      return (
        <code
          key={idx}
          className="rounded bg-black/5 px-1 py-0.5 font-mono text-[12.5px] dark:bg-white/10"
        >
          {span.text}
        </code>
      );
    }
    return (
      <span
        key={idx}
        className={cn(
          bold && "font-semibold",
          italic && "italic",
          strike && "line-through",
        )}
      >
        {span.text}
      </span>
    );
  });
}

export interface OfflineCacheViewerProps {
  snapshot: OfflineSnapshot;
  online?: boolean;
  allSnapshots?: OfflineSnapshot[];
  onClose: () => void;
  onSelectSnapshot?: (snapshot: OfflineSnapshot) => void;
  onNavigateOnline?: (href: string) => void;
}

/**
 * Clean read-only offline snapshot viewer supporting cached documents (metadata & blocks),
 * spreadsheets (multi-worksheet grid & cells), bases (fields & records), slides, and doc lists.
 */
export function OfflineCacheViewer({
  snapshot,
  online = false,
  allSnapshots = [],
  onClose,
  onSelectSnapshot,
  onNavigateOnline,
}: OfflineCacheViewerProps) {
  const { t } = useI18n();
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);

  useEffect(() => {
    setActiveSheetIndex(0);
  }, [snapshot.key]);

  const href = offlineSnapshotHref(snapshot);
  const docBlocks = useMemo(
    () => (snapshot.kind === "doc" ? extractDocBlocks(snapshot.data) : []),
    [snapshot.kind, snapshot.data],
  );
  const worksheets = useMemo(
    () => (snapshot.kind === "sheet" ? extractWorksheets(snapshot.data) : []),
    [snapshot.kind, snapshot.data],
  );
  const activeWorksheet = worksheets[activeSheetIndex] ?? worksheets[0] ?? null;

  const docMeta = isRecord(snapshot.data) ? snapshot.data : null;

  return (
    <section
      data-offline-viewer=""
      data-offline-viewer-kind={snapshot.kind}
      aria-label={snapshot.title}
      className="flex max-h-[88dvh] w-full max-w-[860px] flex-col overflow-hidden rounded-xl border border-[#dee0e3] bg-surface shadow-2xl dark:border-border"
    >
      {/* Prominent read-only offline notice banner */}
      <div
        data-offline-readonly-badge=""
        className="flex flex-wrap items-center justify-between gap-2 border-b border-[#ffd591] bg-[#fff7e6] px-4 py-2 text-[12.5px] font-medium text-[#8c4a00] dark:border-[#6e4b1f] dark:bg-[#2b2215] dark:text-[#ffd591]"
      >
        <div className="flex items-center gap-2">
          <WifiOff size={14} strokeWidth={2} className="shrink-0 text-[#ff8800] dark:text-[#ffb74d]" aria-hidden="true" />
          <span>{t("离线只读预览 · 网络恢复后自动获取最新版本")}</span>
        </div>
        <span className="text-[11.5px] opacity-80">
          {formatOfflineTimestamp(snapshot.updatedAt)} · {formatOfflineBytes(snapshot.sizeBytes)}
        </span>
      </div>

      {/* Viewer header */}
      <header className="flex items-center justify-between gap-3 border-b border-[#dee0e3] px-5 py-3.5 dark:border-border">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onClose}
            data-offline-viewer-close=""
            aria-label={t("返回缓存列表")}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <KindBadge kind={snapshot.kind} />
          <h2 className="truncate text-[16px] font-semibold text-foreground">{snapshot.title}</h2>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {online && href && (
            <button
              type="button"
              data-offline-viewer-online-btn=""
              onClick={() => {
                if (onNavigateOnline) onNavigateOnline(href);
                else go(href);
                onClose();
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#3370ff] px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-[#245bdb]"
            >
              <ExternalLink size={13} aria-hidden="true" />
              <span>{t("前往在线版本")}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t("关闭")}
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Viewer content */}
      <div className="flex-1 overflow-auto bg-canvas p-5">
        {snapshot.kind === "doc" && (
          <div className="mx-auto max-w-[720px] rounded-xl border border-[#dee0e3] bg-surface p-6 shadow-xs dark:border-border">
            <h1 className="text-[22px] font-bold tracking-tight text-foreground">{snapshot.title}</h1>
            {docMeta && (
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#dee0e3]/70 pb-3 text-[12px] text-subtle dark:border-border">
                {typeof docMeta.creatorName === "string" && docMeta.creatorName && (
                  <span>
                    {t("创建者")}：{docMeta.creatorName}
                  </span>
                )}
                {typeof docMeta.workspaceName === "string" && docMeta.workspaceName && (
                  <span>
                    {t("工作空间")}：{docMeta.workspaceName}
                  </span>
                )}
                {typeof docMeta.updatedAt === "string" && docMeta.updatedAt && (
                  <span>
                    {t("更新时间")}：{docMeta.updatedAt.slice(0, 16).replace("T", " ")}
                  </span>
                )}
              </div>
            )}

            {docBlocks.length > 0 ? (
              <div data-offline-doc-blocks="" className="mt-4 space-y-2.5 text-[14.5px] leading-7 text-foreground">
                {docBlocks.map((block) => {
                  const type = block.type.toLowerCase();
                  if (type === "heading1" || type === "h1") {
                    return (
                      <h2 key={block.id} className="pt-2 text-[20px] font-bold text-foreground">
                        {renderInlineSpans(block.spans)}
                      </h2>
                    );
                  }
                  if (type === "heading2" || type === "h2") {
                    return (
                      <h3 key={block.id} className="pt-1.5 text-[17px] font-semibold text-foreground">
                        {renderInlineSpans(block.spans)}
                      </h3>
                    );
                  }
                  if (type === "heading3" || type === "h3") {
                    return (
                      <h4 key={block.id} className="pt-1 text-[15px] font-semibold text-foreground">
                        {renderInlineSpans(block.spans)}
                      </h4>
                    );
                  }
                  if (type === "bullet" || type === "bullet_list" || type === "list") {
                    return (
                      <div key={block.id} className="flex items-start gap-2 pl-2">
                        <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-muted-foreground" />
                        <p className="min-w-0 flex-1">{renderInlineSpans(block.spans)}</p>
                      </div>
                    );
                  }
                  if (type === "ordered" || type === "ordered_list") {
                    return (
                      <div key={block.id} className="flex items-start gap-2 pl-2">
                        <span className="shrink-0 font-mono text-[13px] text-subtle">•</span>
                        <p className="min-w-0 flex-1">{renderInlineSpans(block.spans)}</p>
                      </div>
                    );
                  }
                  if (type === "todo" || type === "check") {
                    const checked =
                      block.props?.checked === true || block.props?.checked === "true";
                    return (
                      <div key={block.id} className="flex items-start gap-2 pl-1">
                        <span
                          aria-hidden="true"
                          className={cn(
                            "mt-1.5 grid size-4 shrink-0 place-items-center rounded border text-[10px]",
                            checked
                              ? "border-[#3370ff] bg-[#3370ff] text-white"
                              : "border-[#bbbfc4] bg-surface text-transparent",
                          )}
                        >
                          ✓
                        </span>
                        <p className={cn("min-w-0 flex-1", checked && "text-subtle line-through")}>
                          {renderInlineSpans(block.spans)}
                        </p>
                      </div>
                    );
                  }
                  if (type === "quote" || type === "callout") {
                    return (
                      <blockquote
                        key={block.id}
                        className="rounded-r-md border-l-3 border-[#3370ff]/60 bg-[#f5f7fa] px-3.5 py-2 text-[14px] text-muted-foreground dark:bg-white/5"
                      >
                        {renderInlineSpans(block.spans)}
                      </blockquote>
                    );
                  }
                  if (type === "code") {
                    return (
                      <pre
                        key={block.id}
                        className="overflow-x-auto rounded-lg bg-[#1f2329] px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-[#f2f3f5]"
                      >
                        <code>{block.spans.map((s) => s.text).join("")}</code>
                      </pre>
                    );
                  }
                  if (type === "divider") {
                    return <hr key={block.id} className="my-3 border-[#dee0e3] dark:border-border" />;
                  }
                  return <p key={block.id}>{renderInlineSpans(block.spans)}</p>;
                })}
              </div>
            ) : (
              <div
                data-offline-doc-meta-only=""
                className="mt-4 rounded-lg border border-dashed border-[#dee0e3] bg-canvas p-4 text-[13px] text-subtle dark:border-border"
              >
                {t("仅缓存了文档基本信息，联网打开文档后将自动缓存正文内容")}
              </div>
            )}
          </div>
        )}

        {snapshot.kind === "sheet" && (
          <div className="flex flex-col gap-3">
            {worksheets.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5" role="tablist">
                {worksheets.map((ws, idx) => (
                  <button
                    key={ws.id}
                    type="button"
                    role="tab"
                    aria-selected={idx === activeSheetIndex}
                    data-offline-sheet-tab={idx}
                    onClick={() => setActiveSheetIndex(idx)}
                    className={cn(
                      "rounded-md border px-3 py-1 text-[12.5px] font-medium transition-colors",
                      idx === activeSheetIndex
                        ? "border-[#3370ff] bg-[#e8f0ff] text-[#1456f0] dark:bg-[#1d3461] dark:text-[#9cbdff]"
                        : "border-[#dee0e3] bg-surface text-muted-foreground hover:bg-hover dark:border-border",
                    )}
                  >
                    {ws.title}
                  </button>
                ))}
              </div>
            )}

            {activeWorksheet && activeWorksheet.rowCount > 0 && activeWorksheet.colCount > 0 ? (
              <div className="overflow-auto rounded-lg border border-[#dee0e3] bg-surface shadow-xs dark:border-border">
                <table data-offline-sheet-table="" className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr className="bg-[#f5f6f7] text-subtle dark:bg-white/5">
                      <th className="w-10 border-b border-r border-[#dee0e3] px-2 py-1.5 text-center font-mono text-[11px] dark:border-border">
                        #
                      </th>
                      {Array.from({ length: activeWorksheet.colCount }, (_, c) => (
                        <th
                          key={c}
                          className="min-w-[96px] border-b border-r border-[#dee0e3] px-2.5 py-1.5 text-center font-medium last:border-r-0 dark:border-border"
                        >
                          {columnIndexToLetters(c)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: activeWorksheet.rowCount }, (_, r) => (
                      <tr key={r} className="hover:bg-hover/40">
                        <td className="border-b border-r border-[#dee0e3] bg-[#f5f6f7]/60 px-2 py-1 text-center font-mono text-[11px] text-subtle dark:border-border dark:bg-white/5">
                          {r + 1}
                        </td>
                        {Array.from({ length: activeWorksheet.colCount }, (_, c) => {
                          const cell = activeWorksheet.grid.get(`${r}:${c}`);
                          return (
                            <td
                              key={c}
                              className={cn(
                                "border-b border-r border-[#dee0e3] px-2.5 py-1 text-foreground last:border-r-0 dark:border-border",
                                cell?.bold && "font-semibold",
                                cell?.italic && "italic",
                                cell?.align === "center" && "text-center",
                                cell?.align === "right" && "text-right",
                              )}
                              style={{
                                ...(cell?.bg ? { backgroundColor: cell.bg } : {}),
                                ...(cell?.color ? { color: cell.color } : {}),
                              }}
                            >
                              {cell?.raw ?? ""}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(activeWorksheet.truncatedRows || activeWorksheet.truncatedCols) && (
                  <div className="border-t border-[#dee0e3] bg-[#f8f9fb] px-3 py-1.5 text-[11.5px] text-subtle dark:border-border dark:bg-white/5">
                    {t("离线预览最多显示前 100 行 × 26 列，恢复联网后可查看完整电子表格")}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-[#dee0e3] bg-surface p-6 text-center text-[13px] text-subtle dark:border-border">
                {t("当前工作表暂无已缓存的单元格数据")}
              </div>
            )}
          </div>
        )}

        {snapshot.kind === "base" && (() => {
          const baseObj = isRecord(snapshot.data) ? snapshot.data : null;
          const fields = baseObj && Array.isArray(baseObj.fields) ? baseObj.fields.filter(isRecord) : [];
          const records = baseObj && Array.isArray(baseObj.records) ? baseObj.records.filter(isRecord) : [];
          return fields.length > 0 ? (
            <div className="overflow-auto rounded-lg border border-[#dee0e3] bg-surface shadow-xs dark:border-border">
              <table data-offline-base-table="" className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr className="bg-[#f5f6f7] text-left text-subtle dark:bg-white/5">
                    {fields.map((field) => (
                      <th
                        key={String(field.id ?? field.name)}
                        className="min-w-[120px] border-b border-r border-[#dee0e3] px-3 py-2 font-medium last:border-r-0 dark:border-border"
                      >
                        {String(field.name ?? "")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {records.slice(0, 100).map((rec, idx) => {
                    const cells = isRecord(rec.cells) ? rec.cells : {};
                    return (
                      <tr key={String(rec.id ?? idx)} className="hover:bg-hover/40">
                        {fields.map((field) => (
                          <td
                            key={String(field.id ?? field.name)}
                            className="border-b border-r border-[#dee0e3] px-3 py-1.5 text-foreground last:border-r-0 dark:border-border"
                          >
                            {formatBaseCellValue(cells[String(field.id)])}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-[#dee0e3] bg-surface p-6 text-center text-[13px] text-subtle dark:border-border">
              {t("暂无已缓存的多维表格记录")}
            </div>
          );
        })()}

        {snapshot.kind === "slides" && (() => {
          const rawPages = Array.isArray(snapshot.data)
            ? snapshot.data
            : isRecord(snapshot.data) && Array.isArray(snapshot.data.pages)
              ? snapshot.data.pages
              : [];
          const pages = rawPages.filter(isRecord);
          return pages.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {pages.map((page, idx) => (
                <article
                  key={String(page.id ?? idx)}
                  data-offline-slide-card={idx}
                  className="rounded-lg border border-[#dee0e3] bg-surface p-4 shadow-xs dark:border-border"
                >
                  <div className="mb-1.5 flex items-center justify-between text-[11px] text-subtle">
                    <span>#{idx + 1}</span>
                    {page.hidden === true && <span>{t("已隐藏")}</span>}
                  </div>
                  <h3 className="text-[14.5px] font-semibold text-foreground">
                    {typeof page.title === "string" && page.title.trim() ? page.title : `${t("幻灯片")} ${idx + 1}`}
                  </h3>
                  {typeof page.body === "string" && page.body.trim() && (
                    <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground">
                      {page.body}
                    </p>
                  )}
                  {typeof page.notes === "string" && page.notes.trim() && (
                    <p className="mt-2 border-t border-[#dee0e3]/70 pt-1.5 text-[11.5px] text-subtle dark:border-border">
                      {t("演讲者备注")}：{page.notes}
                    </p>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-[#dee0e3] bg-surface p-6 text-center text-[13px] text-subtle dark:border-border">
              {t("暂无已缓存的幻灯片页面")}
            </div>
          );
        })()}

        {snapshot.kind === "list" && (() => {
          const items = Array.isArray(snapshot.data)
            ? snapshot.data.filter(isRecord)
            : isRecord(snapshot.data) && Array.isArray(snapshot.data.docs)
              ? snapshot.data.docs.filter(isRecord)
              : [];
          return items.length > 0 ? (
            <div data-offline-list-preview="" className="divide-y divide-[#dee0e3] overflow-hidden rounded-lg border border-[#dee0e3] bg-surface dark:divide-border dark:border-border">
              {items.map((item, idx) => {
                const itemId = typeof item.id === "number" ? item.id : undefined;
                const itemKindRaw = typeof item.kind === "string" ? item.kind : "doc";
                const itemKind: OfflineSnapshotKind =
                  itemKindRaw === "sheet" || itemKindRaw === "base" || itemKindRaw === "slides"
                    ? itemKindRaw
                    : "doc";
                const cachedMatch =
                  itemId !== undefined
                    ? allSnapshots.find((s) => s.key === `${itemKind}:${itemId}` || s.resourceId === itemId)
                    : undefined;
                return (
                  <div
                    key={String(item.id ?? idx)}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <KindBadge kind={itemKind} />
                      <span className="truncate font-medium text-foreground">
                        {typeof item.title === "string" && item.title.trim() ? item.title : t("未命名文档")}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {typeof item.creatorName === "string" && item.creatorName && (
                        <span className="hidden text-[12px] text-subtle sm:inline">{item.creatorName}</span>
                      )}
                      {cachedMatch && onSelectSnapshot && (
                        <button
                          type="button"
                          onClick={() => onSelectSnapshot(cachedMatch)}
                          className="rounded border border-[#3370ff]/30 bg-[#e8f0ff] px-2 py-0.5 text-[11.5px] font-medium text-[#1456f0] hover:bg-[#d8e6ff] dark:bg-[#1d3461] dark:text-[#9cbdff]"
                        >
                          {t("离线打开")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-[#dee0e3] bg-surface p-6 text-center text-[13px] text-subtle dark:border-border">
              {t("列表缓存为空")}
            </div>
          );
        })()}
      </div>
    </section>
  );
}

export interface OfflineCacheDrawerProps {
  open: boolean;
  onClose: () => void;
  initialTab?: OfflineCacheTab;
  initialViewerSnapshot?: OfflineSnapshot | null;
  /** Optional offline state override (primarily for SSR tests). */
  offlineState?: OfflineStateHookValue;
  /** Optional navigation callback when opening a cached resource while online. */
  onNavigate?: (href: string) => void;
}

/**
 * Slide-over Feishu drawer managing IndexedDB cached offline snapshots ("已缓存内容")
 * and FIFO offline mutation queue ("待同步队列"), with inline `<OfflineCacheViewer />` modal.
 */
export function OfflineCacheDrawer({
  open,
  onClose,
  initialTab = "snapshots",
  initialViewerSnapshot = null,
  offlineState,
  onNavigate,
}: OfflineCacheDrawerProps) {
  const { t } = useI18n();
  const liveState = useOfflineState();
  const state = offlineState ?? liveState;

  const [tab, setTab] = useState<OfflineCacheTab>(initialTab);
  const [viewerSnapshot, setViewerSnapshot] = useState<OfflineSnapshot | null>(initialViewerSnapshot);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!open) {
      setViewerSnapshot(initialViewerSnapshot);
    }
  }, [open, initialViewerSnapshot]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (viewerSnapshot) {
        setViewerSnapshot(null);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, viewerSnapshot, onClose]);

  const totalBytes = useMemo(
    () => state.cachedSnapshots.reduce((sum, snap) => sum + Math.max(0, snap.sizeBytes), 0),
    [state.cachedSnapshots],
  );

  if (!open) return null;

  const handleOpenSnapshot = (snap: OfflineSnapshot) => {
    const href = offlineSnapshotHref(snap);
    if (state.online && href) {
      if (onNavigate) onNavigate(href);
      else go(href);
      onClose();
      return;
    }
    setViewerSnapshot(snap);
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex justify-end bg-black/30 backdrop-blur-[1px] print:hidden"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          if (viewerSnapshot) setViewerSnapshot(null);
          else onClose();
        }
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t("离线缓存与同步")}
        data-offline-cache-drawer=""
        className="flex h-full w-full max-w-[520px] flex-col border-l border-[#dee0e3] bg-surface shadow-2xl dark:border-border"
      >
        {/* Drawer Header */}
        <header className="flex items-center justify-between gap-3 border-b border-[#dee0e3] px-5 py-3.5 dark:border-border">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#e8f0ff] text-[#3370ff] dark:bg-[#1d3461] dark:text-[#9cbdff]">
              <HardDrive size={16} strokeWidth={2} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-[15px] font-semibold text-foreground">
                  {t("离线缓存与同步")}
                </h2>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    state.online
                      ? "bg-[#e6f7ee] text-[#008a3b] dark:bg-[#133322] dark:text-[#6ee7a0]"
                      : "bg-[#fff7e6] text-[#8c4a00] dark:bg-[#2b2215] dark:text-[#ffd591]",
                  )}
                >
                  {state.online ? <Wifi size={11} aria-hidden="true" /> : <WifiOff size={11} aria-hidden="true" />}
                  {state.online ? t("已联网") : t("离线模式")}
                </span>
              </div>
              <p className="mt-0.5 text-[12px] text-subtle">
                {t("已缓存 {n} 项 · 占用 {used} / {max}", {
                  n: state.cachedSnapshots.length,
                  used: formatOfflineBytes(totalBytes),
                  max: formatOfflineBytes(MAX_OFFLINE_SNAPSHOT_BYTES),
                })}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("关闭")}
            data-offline-drawer-close=""
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {/* Tab Switcher */}
        <div className="flex items-center gap-1 border-b border-[#dee0e3] bg-surface px-5 dark:border-border" role="tablist">
          <button
            type="button"
            role="tab"
            data-offline-tab="snapshots"
            aria-selected={tab === "snapshots"}
            onClick={() => setTab("snapshots")}
            className={cn(
              "inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
              tab === "snapshots"
                ? "border-[#3370ff] text-[#3370ff]"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Database size={14} aria-hidden="true" />
            <span>{t("已缓存内容")}</span>
            <span className="rounded-full bg-black/5 px-1.5 py-0.2 text-[11px] text-muted-foreground dark:bg-white/10">
              {state.cachedSnapshots.length}
            </span>
          </button>

          <button
            type="button"
            role="tab"
            data-offline-tab="queue"
            aria-selected={tab === "queue"}
            onClick={() => setTab("queue")}
            className={cn(
              "inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
              tab === "queue"
                ? "border-[#3370ff] text-[#3370ff]"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <RefreshCw size={14} className={cn(state.syncing && "animate-spin")} aria-hidden="true" />
            <span>{t("待同步队列")}</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.2 text-[11px]",
                state.pendingQueue.length > 0
                  ? "bg-[#fff3e6] font-semibold text-[#c25400] dark:bg-[#3d2511] dark:text-[#fdba74]"
                  : "bg-black/5 text-muted-foreground dark:bg-white/10",
              )}
            >
              {state.pendingQueue.length}
            </span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto bg-canvas p-4">
          {tab === "snapshots" ? (
            <div className="space-y-3">
              {state.cachedSnapshots.length > 0 && (
                <div className="flex items-center justify-between gap-2 px-0.5 text-[12px] text-subtle">
                  <span>{t("按最近缓存时间排序（最多保留 50 项）")}</span>
                  <button
                    type="button"
                    data-offline-clear-cache=""
                    onClick={() => void state.clearCache()}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-[#d93025] transition-colors hover:bg-[#ffece8] dark:text-[#fca5a5] dark:hover:bg-[#3e1a18]"
                  >
                    <Trash2 size={12} aria-hidden="true" />
                    <span>{t("清空缓存")}</span>
                  </button>
                </div>
              )}

              {state.cachedSnapshots.length === 0 ? (
                <div
                  data-offline-snapshots-empty=""
                  className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[#dee0e3] bg-surface px-6 py-12 text-center dark:border-border"
                >
                  <Database size={28} strokeWidth={1.6} className="text-subtle/70" aria-hidden="true" />
                  <p className="mt-3 text-[14px] font-medium text-foreground">{t("暂无离线缓存内容")}</p>
                  <p className="mt-1 max-w-[300px] text-[12px] leading-relaxed text-subtle">
                    {t("联网浏览文档、表格或列表后，系统将自动缓存到本地供离线只读查看")}
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {state.cachedSnapshots.map((snap) => (
                    <li
                      key={snap.key}
                      data-offline-snapshot-item={snap.key}
                      className="rounded-lg border border-[#dee0e3] bg-surface p-3.5 shadow-2xs transition-colors hover:border-[#3370ff]/40 dark:border-border"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <KindBadge kind={snap.kind} />
                            <h3 className="truncate text-[13.5px] font-medium text-foreground">
                              {snap.title}
                            </h3>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11.5px] text-subtle">
                            <span className="inline-flex items-center gap-1">
                              <Clock size={11} aria-hidden="true" />
                              {formatOfflineTimestamp(snap.updatedAt)}
                            </span>
                            <span>{formatOfflineBytes(snap.sizeBytes)}</span>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                          {state.online && offlineSnapshotHref(snap) && (
                            <button
                              type="button"
                              data-offline-preview-snapshot={snap.key}
                              title={t("离线只读预览")}
                              aria-label={t("离线只读预览")}
                              onClick={() => setViewerSnapshot(snap)}
                              className="grid size-7 place-items-center rounded-md border border-[#dee0e3] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground dark:border-border"
                            >
                              <Eye size={13} aria-hidden="true" />
                            </button>
                          )}
                          <button
                            type="button"
                            data-offline-open-snapshot={snap.key}
                            onClick={() => handleOpenSnapshot(snap)}
                            className="inline-flex items-center gap-1 rounded-md border border-[#3370ff]/30 bg-[#e8f0ff] px-2.5 py-1 text-[12px] font-medium text-[#1456f0] transition-colors hover:bg-[#d6e4ff] dark:border-[#3370ff]/40 dark:bg-[#1d3461] dark:text-[#9cbdff] dark:hover:bg-[#26437a]"
                          >
                            <span>{t("离线打开")}</span>
                          </button>
                          <button
                            type="button"
                            data-offline-delete-snapshot={snap.key}
                            aria-label={t("删除")}
                            title={t("删除")}
                            onClick={() => void state.removeSnapshot(snap.key)}
                            className="grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-[#ffece8] hover:text-[#d93025] dark:hover:bg-[#3e1a18] dark:hover:text-[#fca5a5]"
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Queue toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#dee0e3] bg-surface px-3.5 py-2.5 dark:border-border">
                <div className="text-[12px] text-subtle">
                  {state.syncing ? (
                    <span className="font-medium text-[#3370ff]">{t("正在按顺序同步离线修改…")}</span>
                  ) : state.lastSyncSummary && state.lastSyncSummary.synced > 0 ? (
                    <span>
                      {t("上次同步完成：成功 {synced} 条，剩余 {remaining} 条", {
                        synced: state.lastSyncSummary.synced,
                        remaining: state.lastSyncSummary.remaining,
                      })}
                    </span>
                  ) : state.online ? (
                    <span>{t("网络正常，可随时手动触发队列同步")}</span>
                  ) : (
                    <span>{t("当前处于离线状态，恢复联网后将自动同步")}</span>
                  )}
                </div>
                <button
                  type="button"
                  data-offline-drawer-sync-btn=""
                  disabled={!state.online || state.syncing || state.pendingQueue.length === 0}
                  onClick={() => void state.syncNow()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#3370ff] px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#245bdb] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <RefreshCw size={12} className={cn(state.syncing && "animate-spin")} aria-hidden="true" />
                  <span>{t("立即同步")}</span>
                </button>
              </div>

              {state.pendingQueue.length === 0 ? (
                <div
                  data-offline-queue-empty=""
                  className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[#dee0e3] bg-surface px-6 py-12 text-center dark:border-border"
                >
                  <RefreshCw size={26} strokeWidth={1.6} className="text-subtle/70" aria-hidden="true" />
                  <p className="mt-3 text-[14px] font-medium text-foreground">{t("暂无待同步修改")}</p>
                  <p className="mt-1 max-w-[300px] text-[12px] leading-relaxed text-subtle">
                    {t("离线期间的修改将按顺序暂存于此，网络恢复后自动重放同步")}
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {state.pendingQueue.map((item) => (
                    <li
                      key={item.id}
                      data-offline-queue-item={item.id}
                      className="rounded-lg border border-[#dee0e3] bg-surface p-3.5 shadow-2xs dark:border-border"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <MethodBadge method={item.method} />
                            <h3 className="truncate text-[13.5px] font-medium text-foreground">
                              {item.title}
                            </h3>
                          </div>
                          <p className="mt-1 truncate font-mono text-[11.5px] text-subtle">
                            {item.path}
                          </p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11.5px] text-subtle">
                            <span className="inline-flex items-center gap-1">
                              <Clock size={11} aria-hidden="true" />
                              {formatOfflineTimestamp(item.createdAt)}
                            </span>
                            {item.retries > 0 && (
                              <span
                                data-offline-retry-count={item.retries}
                                className="rounded bg-[#fff3e6] px-1.5 py-0.5 text-[11px] font-medium text-[#b45309] dark:bg-[#3d2511] dark:text-[#fdba74]"
                              >
                                {t("已重试 {count} 次", { count: item.retries })}
                              </span>
                            )}
                          </div>
                          {item.lastError && (
                            <div
                              data-offline-queue-error=""
                              className="mt-2 flex items-start gap-1.5 rounded-md border border-[#ffccc7] bg-[#fff2f0] px-2.5 py-1.5 text-[11.5px] text-[#cf1322] dark:border-[#5c1e1e] dark:bg-[#2a1215] dark:text-[#ffa39e]"
                            >
                              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                              <span className="break-all">{item.lastError}</span>
                            </div>
                          )}
                        </div>

                        <button
                          type="button"
                          data-offline-discard-mutation={item.id}
                          onClick={() => void state.removeQueuedItem(item.id)}
                          className="shrink-0 rounded-md border border-[#dee0e3] px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:border-[#ffccc7] hover:bg-[#fff2f0] hover:text-[#cf1322] dark:border-border dark:hover:bg-[#2a1215] dark:hover:text-[#ffa39e]"
                        >
                          {t("丢弃")}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* Inline Offline Snapshot Read-Only Viewer Modal */}
      {viewerSnapshot && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-3 sm:p-6"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setViewerSnapshot(null);
          }}
        >
          <OfflineCacheViewer
            snapshot={viewerSnapshot}
            online={state.online}
            allSnapshots={state.cachedSnapshots}
            onClose={() => setViewerSnapshot(null)}
            onSelectSnapshot={(next) => setViewerSnapshot(next)}
            onNavigateOnline={(href) => {
              if (onNavigate) onNavigate(href);
              else go(href);
              setViewerSnapshot(null);
              onClose();
            }}
          />
        </div>
      )}
    </div>
  );
}
