import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SheetDefinedName } from "@jiange/sheet-sdk/types";
import {
  ApiError,
  docsApi,
  driveApi,
  extrasApi,
  sheetsApi,
  type DocMeta,
  type Me,
  type SheetBorders,
  type SheetCell,
  type SheetCellConflict,
  type SheetCellRevision,
  type SheetCellStyle,
  type SheetCellWrite,
  type SheetChart,
  type SheetColumnFilter,
  type SheetComment,
  type SheetConditionalFormat,
  type SheetDataValidation,
  type SheetMerge,
  type SheetPivotTable,
  type SheetProtectedRange,
  type SheetSnapshot,
  type SheetStylePatch,
  type SheetWorksheet,
} from "@/lib/api";
import { go } from "@/lib/route";
import { t, useI18n } from "@/lib/i18n";
import { colorFor } from "@/lib/presence";
import { Avatar } from "@/components/brand";
import { ShareDialog } from "@/components/share-dialog";
import { DocumentWatermark } from "@/components/document-watermark";
import { SheetColorIcon } from "@/components/feishu-icons";
import { ask, askText } from "@/components/ui/ask";
import { ResourceTypeNotice } from "@/pages/resource-type-notice";
import { ResourceReferencesButton } from "@/pages/resource-references-button";
import { canCopyContent, canDownloadDocument } from "@/pages/document-copy";
import { ChevronRight, Clock, Columns3, Eraser, Filter, History, Home, Lock, MessageSquare, MoreHorizontal, Pin, Printer, Rows3, Search, Share2, Tag, X } from "lucide-react";
import { FenwickVirtualizer } from "@jiange/render-gpu";
import { columnName, pointKey, selected, selectionBounds, selectionOutline, sheetAddress, type SheetPoint, type SheetSelection } from "@jiange/sheet-sdk/grid";
import { formatTSV, parseTSV } from "@jiange/sheet-sdk/tsv";
import {
  buildMergeLookup,
  buildWorksheetGridMap,
  calculateWorkbook,
  computeSortedRowWrites,
  extractFormulaReferences,
  formatCellDisplay,
  formatSelectionAddress,
  getVisibleRowIndices,
  normalizePointForMerge,
  parseRangeInput,
  translateWorkbookFormula,
  type EvaluatedSheetMap,
} from "./workbook-engine";
import { exportWorkbookToXlsx, parseXlsxForWorkbook } from "./workbook-xlsx";
import { FORMULA_QUICK_LIST, formatSheetRefPrefix, SHEET_STARTER_TEMPLATES, type SheetStarterTemplate } from "./workbook-templates";
import { SheetTabsBar, SheetToolbar, type SheetBorderPreset } from "./sheet-toolbar";
import { SheetSidePanel, type SheetPanelMode } from "./sheet-panels";
import { computePivotTable, pivotResultToCellMatrix } from "./sheet-analytics";
import { SheetChartOverlay } from "./sheet-chart-overlay";
import { SheetGpuGridLayer } from "./sheet-gpu-layer";
import { computeSheetSelectionStats } from "./sheet-selection-stats";
import { SheetSelectionStatsBar } from "./sheet-selection-stats-bar";
import {
  computeVisualCondFormatBounds,
  evaluateSheetConditionalFormat,
  evaluateSheetValidation,
  evaluateSheetVisualCondFormat,
  findSheetDropdown,
  isSheetCellProtected,
} from "./sheet-rules";
import { applyFormulaCompletion, inspectFormulaCaret } from "./sheet-formula-autocomplete";
import { SheetFormulaBarAutocomplete, type FormulaPopoverAnchorRect } from "./sheet-formula-bar-autocomplete";
import {
  buildNextColumnFilterConfig,
  collectColumnFilterOptions,
  isColumnFilterActive,
  SheetColumnFilterPopover,
  type SheetColumnFilterAnchor,
} from "./sheet-column-filter";
import {
  applyRemoteCellDelta,
  buildConflictResolutionWrite,
  remoteCollaboratorBounds,
  toSheetStylePatch,
  type PendingMergeConflict,
  type RemoteCollaborator,
} from "./sheet-collab";
import { SheetConflictBar } from "./sheet-conflict-bar";
import { loadStoredDefinedNames, parseDefinedNameTarget, saveStoredDefinedNames } from "./sheet-history-panel";
import { SheetPrintDialog } from "./sheet-print-dialog";

const DEFAULT_COL_WIDTH = 105;
const DEFAULT_ROW_HEIGHT = 27;
const ROW_HEADER_WIDTH = 44;
const COL_HEADER_HEIGHT = 24;
const VIRTUALIZE_ROW_THRESHOLD = 80;
const VIRTUAL_ROW_OVERSCAN = 10;

export interface SheetVirtualRowWindow {
  frozen: number[];
  virtual: number[];
  topSpacer: number;
  bottomSpacer: number;
  virtualized: boolean;
}

export function buildSheetRowFenwick(scrollableRows: readonly number[], rowHeights: readonly number[]): FenwickVirtualizer {
  const fenwick = new FenwickVirtualizer(scrollableRows.length, DEFAULT_ROW_HEIGHT);
  for (let i = 0; i < scrollableRows.length; i++) {
    const h = rowHeights[scrollableRows[i]] ?? DEFAULT_ROW_HEIGHT;
    if (h !== DEFAULT_ROW_HEIGHT) fenwick.setSize(i, h);
  }
  return fenwick;
}

export function computeSheetVirtualWindow(
  visibleRows: readonly number[],
  rowHeights: readonly number[],
  frozenRows: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = VIRTUAL_ROW_OVERSCAN,
  fenwick?: FenwickVirtualizer,
): SheetVirtualRowWindow {
  const frozen: number[] = [];
  const scrollable: number[] = [];
  let frozenHeight = COL_HEADER_HEIGHT;
  for (const rowIdx of visibleRows) {
    if (rowIdx < frozenRows) {
      frozen.push(rowIdx);
      frozenHeight += rowHeights[rowIdx] ?? DEFAULT_ROW_HEIGHT;
    } else {
      scrollable.push(rowIdx);
    }
  }
  if (viewportHeight <= 0 || scrollable.length <= VIRTUALIZE_ROW_THRESHOLD) {
    return { frozen, virtual: scrollable, topSpacer: 0, bottomSpacer: 0, virtualized: false };
  }
  const tree = fenwick ?? buildSheetRowFenwick(scrollable, rowHeights);
  const effectiveViewport = Math.max(200, viewportHeight - frozenHeight);
  const range = tree.visibleRange(Math.max(0, scrollTop), effectiveViewport, overscan);
  const virtual = range.end >= range.start ? scrollable.slice(range.start, range.end + 1) : [];
  return {
    frozen,
    virtual,
    topSpacer: range.startOffset,
    bottomSpacer: Math.max(0, range.totalSize - range.endOffset),
    virtualized: true,
  };
}

type EditingState = {
  sheetId: number;
  point: SheetPoint;
  value: string;
  source: "cell" | "formula";
  baseRevision: number;
};

type UndoEntry = {
  worksheetId: number;
  forward: { rowId: number; columnId: number; raw?: string; style?: SheetCellStyle }[];
  backward: { rowId: number; columnId: number; raw?: string; style?: SheetCellStyle }[];
};

function makeMutationId(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameRect(a: { top: number; left: number; bottom: number; right: number }, b: { top: number; left: number; bottom: number; right: number }): boolean {
  return a.top === b.top && a.left === b.left && a.bottom === b.bottom && a.right === b.right;
}

function splitFormulaSegments(
  formula: string,
  refs: readonly { text: string; color: string }[],
): Array<{ text: string; color: string | null }> {
  if (!formula.startsWith("=") || refs.length === 0) return [{ text: formula, color: null }];
  const lower = formula.toLowerCase();
  const out: Array<{ text: string; color: string | null }> = [];
  let cursor = 0;
  for (const ref of refs) {
    if (!ref.text) continue;
    const idx = lower.indexOf(ref.text.toLowerCase(), cursor);
    if (idx < 0) continue;
    if (idx > cursor) out.push({ text: formula.slice(cursor, idx), color: null });
    out.push({ text: formula.slice(idx, idx + ref.text.length), color: ref.color });
    cursor = idx + ref.text.length;
  }
  if (cursor < formula.length) out.push({ text: formula.slice(cursor), color: null });
  return out.length > 0 ? out : [{ text: formula, color: null }];
}

export function SheetPage({ sheetId, me, onGlobalSearch }: { sheetId: number; me: Me; onGlobalSearch?: () => void }) {
  const { locale } = useI18n();
  const qc = useQueryClient();
  const userId = me.user.id;
  const metaQueryKey = useMemo(() => ["doc", sheetId, userId], [sheetId, userId]);
  const workbookQueryKey = useMemo(() => ["sheet", sheetId, userId], [sheetId, userId]);
  const commentsQueryKey = useMemo(() => ["sheet-comments", sheetId, userId], [sheetId, userId]);

  const meta = useQuery({
    queryKey: metaQueryKey,
    queryFn: () => docsApi.getForAccount(sheetId, userId),
    retry: false,
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
  });

  const isSheetKind = meta.data?.kind === "sheet";
  const ancestors = useQuery({
    queryKey: ["sheet-ancestors", sheetId, userId],
    queryFn: () => extrasApi.ancestors(sheetId),
    enabled: !!isSheetKind && !meta.isError,
    retry: false,
  });
  const pins = useQuery({
    queryKey: ["home-pins", userId],
    queryFn: () => extrasApi.pinsForAccount(userId),
    enabled: !!isSheetKind && !meta.isError,
    retry: false,
  });
  const workbook = useQuery({
    queryKey: workbookQueryKey,
    queryFn: () => sheetsApi.get(sheetId, userId),
    enabled: !!isSheetKind && !meta.isError,
    retry: false,
  });
  const commentsQuery = useQuery({
    queryKey: commentsQueryKey,
    queryFn: () => sheetsApi.listComments(sheetId, userId),
    enabled: !!isSheetKind && !meta.isError,
    retry: false,
  });

  useEffect(() => {
    if (isSheetKind) {
      void docsApi.recordVisit(sheetId).catch(() => {});
    }
  }, [sheetId, isSheetKind]);

  useEffect(() => {
    if (meta.data?.kind === "sheet") {
      document.title = `${meta.data.title.trim() || t("未命名表格")} - Jiange`;
    }
  }, [meta.data?.kind, meta.data?.title, locale]);

  const [activeSheetId, setActiveSheetId] = useState<number>(0);
  const [selection, setSelection] = useState<SheetSelection>({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [nameBoxText, setNameBoxText] = useState("A1");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingCount, setSavingCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [gpuActive, setGpuActive] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [fxMenuOpen, setFxMenuOpen] = useState(false);
  const [filterPopover, setFilterPopover] = useState<{ col: number; anchorRect: SheetColumnFilterAnchor } | null>(null);
  const [localFilterRules, setLocalFilterRules] = useState<Record<string, SheetColumnFilter> | null>(null);
  const [formulaCaret, setFormulaCaret] = useState(0);
  const [formulaAutoIdx, setFormulaAutoIdx] = useState(0);
  const [formulaDismissed, setFormulaDismissed] = useState(false);
  const [formulaAnchorRect, setFormulaAnchorRect] = useState<FormulaPopoverAnchorRect | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [formatBrush, setFormatBrush] = useState<SheetCellStyle | null>(null);
  const [templateHidden, setTemplateHidden] = useState(false);
  const [templateQuery, setTemplateQuery] = useState("");
  const [zoom, setZoom] = useState(100);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([]);
  const [collaborators, setCollaborators] = useState<RemoteCollaborator[]>([]);
  const [cellConflicts, setCellConflicts] = useState<SheetCellConflict[]>([]);
  const [mergeConflict, setMergeConflict] = useState<PendingMergeConflict | null>(null);
  const [selectedChartId, setSelectedChartId] = useState<string | null>(null);
  useEffect(() => {
    setCellConflicts([]);
    setMergeConflict(null);
    setSelectedChartId(null);
    setFilterPopover(null);
    setLocalFilterRules(null);
    setFormulaDismissed(false);
  }, [sheetId, activeSheetId]);
  const [pendingImport, setPendingImport] = useState<{ filename: string; sheets: ReturnType<typeof parseXlsxForWorkbook> extends Promise<infer R> ? R : never } | null>(null);
  const [importing, setImporting] = useState(false);
  const [fillTarget, setFillTarget] = useState<SheetPoint | null>(null);
  const [activePanel, setActivePanel] = useState<SheetPanelMode | null>(null);
  const [definedNames, setDefinedNames] = useState<SheetDefinedName[]>(() => loadStoredDefinedNames(sheetId));
  const [printOpen, setPrintOpen] = useState(false);
  const [cellContextMenu, setCellContextMenu] = useState<{ x: number; y: number; row: number; col: number } | null>(null);
  const [dropdownCell, setDropdownCell] = useState<{ sheetId: number; row: number; col: number } | null>(null);
  const [gridScrollTop, setGridScrollTop] = useState(0);
  const [gridViewportHeight, setGridViewportHeight] = useState(0);

  useEffect(() => {
    setDefinedNames(loadStoredDefinedNames(sheetId));
  }, [sheetId]);

  const shareBtnRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const cellContextMenuRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const cellInputRef = useRef<HTMLInputElement>(null);
  const formulaInputRef = useRef<HTMLInputElement>(null);
  const formulaBarWrapRef = useRef<HTMLDivElement>(null);
  const colHeaderRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectingRef = useRef(false);
  const fillingRef = useRef(false);
  const internalClipboard = useRef<{ token: string; sheetId: number; bounds: { top: number; left: number; bottom: number; right: number }; cells: { dr: number; dc: number; raw: string; style?: SheetCellStyle }[] } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const sheets = workbook.data?.sheets ?? [];
  const activeSheet = useMemo(
    () => sheets.find((s) => s.id === activeSheetId) ?? sheets[0] ?? null,
    [sheets, activeSheetId],
  );

  useEffect(() => {
    if (sheets.length > 0 && !sheets.some((s) => s.id === activeSheetId)) {
      setActiveSheetId(sheets[0].id);
      setSelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
    }
  }, [sheets, activeSheetId]);

  const role = meta.data?.role ?? workbook.data?.role ?? "view";
  const canEdit = !!isSheetKind && !meta.isError && !workbook.isError && (role === "edit" || role === "manage");
  const canComment =
    !!isSheetKind &&
    !meta.isError &&
    !workbook.isError &&
    (meta.data?.commentMinRole === "edit" ? role === "edit" || role === "manage" : role === "view" || role === "edit" || role === "manage");
  // Copy protection follows the workbook's copy/download policy (分享 → 权限设置).
  const canCopy = canCopyContent(meta.data);
  const canDownload = canDownloadDocument(meta.data);

  const sharesQuery = useQuery({
    queryKey: ["sheet-shares", sheetId, userId],
    queryFn: () => docsApi.sharesForAccount(sheetId, userId),
    enabled: !!isSheetKind && !meta.isError && role === "manage" && activePanel === "protect",
    retry: false,
  });

  useEffect(() => {
    setNameBoxText(formatSelectionAddress(selection));
  }, [selection]);

  const activeSheetRef = useRef<SheetWorksheet | null>(null);
  const selectionRef = useRef<SheetSelection>(selection);
  const editingFlagRef = useRef(false);
  activeSheetRef.current = activeSheet ?? null;
  selectionRef.current = selection;
  editingFlagRef.current = !!editing;

  // WebSocket live revision sync (with incremental cell deltas) and region presence.
  useEffect(() => {
    if (!isSheetKind || !workbook.isSuccess || typeof WebSocket === "undefined") return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/api/sheets/${sheetId}/ws`);
    wsRef.current = socket;
    socket.onopen = () => {
      const wsSheet = activeSheetRef.current;
      const sel = selectionRef.current;
      if (wsSheet) {
        socket.send(
          JSON.stringify({
            type: "cursor",
            worksheetId: wsSheet.id,
            row: sel.focus.row,
            col: sel.focus.col,
            anchorRow: sel.anchor.row,
            anchorCol: sel.anchor.col,
            editing: editingFlagRef.current,
          }),
        );
      }
    };
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg?.type === "revision" && Number.isSafeInteger(msg.workbookRevision)) {
          const current = qc.getQueryData<SheetSnapshot>(workbookQueryKey);
          if (msg.worksheetId && Array.isArray(msg.cellDelta) && msg.cellDelta.length > 0) {
            const patched = applyRemoteCellDelta(current, msg.worksheetId, msg.workbookRevision, msg.cellDelta as SheetCellRevision[]);
            if (patched) {
              qc.setQueryData<SheetSnapshot>(workbookQueryKey, patched);
            } else {
              void qc.invalidateQueries({ queryKey: workbookQueryKey });
            }
          } else if (!current || msg.workbookRevision > current.workbookRevision) {
            void qc.invalidateQueries({ queryKey: workbookQueryKey });
          }
          void qc.invalidateQueries({ queryKey: commentsQueryKey });
        } else if (msg?.type === "presence" && Array.isArray(msg.collaborators)) {
          setCollaborators(msg.collaborators.filter((c: RemoteCollaborator) => c.userId !== userId));
        }
      } catch {
        /* ignore malformed ws payload */
      }
    };
    return () => {
      wsRef.current = null;
      socket.close();
    };
  }, [isSheetKind, workbook.isSuccess, sheetId, userId, qc, workbookQueryKey, commentsQueryKey]);

  const isEditingAny = !!editing;
  useEffect(() => {
    activeSheetRef.current = activeSheet ?? null;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSheet) return;
    ws.send(
      JSON.stringify({
        type: "cursor",
        worksheetId: activeSheet.id,
        row: selection.focus.row,
        col: selection.focus.col,
        anchorRow: selection.anchor.row,
        anchorCol: selection.anchor.col,
        editing: isEditingAny,
      }),
    );
  }, [activeSheet, selection.focus.row, selection.focus.col, selection.anchor.row, selection.anchor.col, isEditingAny]);

  useEffect(() => {
    const stop = () => {
      selectingRef.current = false;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!moreMenuRef.current?.contains(e.target as Node)) setMoreMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreMenuOpen]);

  useEffect(() => {
    if (!cellContextMenu) return;
    const close = () => setCellContextMenu(null);
    const onDown = (e: PointerEvent) => {
      if (!cellContextMenuRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [cellContextMenu]);

  const evaluatedWorkbook = useMemo(() => calculateWorkbook(sheets, { definedNames }), [sheets, definedNames]);
  const activeEvalMap = useMemo(() => (activeSheet ? evaluatedWorkbook.get(activeSheet.id) ?? {} : {}), [activeSheet, evaluatedWorkbook]);

  const gridMap = useMemo(
    () => (activeSheet ? buildWorksheetGridMap(activeSheet) : { rowPosById: new Map<number, number>(), colPosById: new Map<number, number>(), cellByKey: new Map<string, SheetCell>() }),
    [activeSheet],
  );
  const allComments = commentsQuery.data?.comments ?? [];
  const unresolvedCommentsByCellKey = useMemo(() => {
    const map = new Map<string, SheetComment[]>();
    if (!activeSheet) return map;
    for (const cm of allComments) {
      if (cm.worksheetId !== activeSheet.id || cm.resolved) continue;
      const r = gridMap.rowPosById.get(cm.rowId);
      const c = gridMap.colPosById.get(cm.columnId);
      if (r === undefined || c === undefined) continue;
      const k = `${r}:${c}`;
      const list = map.get(k);
      if (list) list.push(cm);
      else map.set(k, [cm]);
    }
    return map;
  }, [activeSheet, allComments, gridMap.rowPosById, gridMap.colPosById]);
  const unresolvedCommentCount = useMemo(
    () => (activeSheet ? allComments.filter((c) => c.worksheetId === activeSheet.id && !c.resolved).length : 0),
    [activeSheet, allComments],
  );
  const mergeLookup = useMemo(() => buildMergeLookup(activeSheet?.merges ?? []), [activeSheet?.merges]);
  const effectiveFilter = useMemo(
    () => (activeSheet ? (localFilterRules ? { ...activeSheet.filter, enabled: true, rules: localFilterRules } : activeSheet.filter) : undefined),
    [activeSheet, localFilterRules],
  );
  const visibleRows = useMemo(
    () => (activeSheet ? getVisibleRowIndices({ ...activeSheet, filter: effectiveFilter ?? {} }, activeEvalMap) : []),
    [activeSheet, effectiveFilter, activeEvalMap],
  );

  const colWidths = useMemo(() => (activeSheet?.columns ?? []).map((c) => c.size || DEFAULT_COL_WIDTH), [activeSheet?.columns]);
  const rowHeights = useMemo(() => (activeSheet?.rows ?? []).map((r) => r.size || DEFAULT_ROW_HEIGHT), [activeSheet?.rows]);
  const colLeftOffsets = useMemo(() => {
    const arr: number[] = [];
    let acc = ROW_HEADER_WIDTH;
    for (const w of colWidths) {
      arr.push(acc);
      acc += w;
    }
    return arr;
  }, [colWidths]);
  const rowTopOffsets = useMemo(() => {
    const arr: number[] = [];
    let acc = COL_HEADER_HEIGHT;
    for (const h of rowHeights) {
      arr.push(acc);
      acc += h;
    }
    return arr;
  }, [rowHeights]);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const syncSize = () => setGridViewportHeight(el.clientHeight);
    syncSize();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(syncSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeSheet?.id]);

  const scrollableVisibleRows = useMemo(
    () => (activeSheet ? visibleRows.filter((rowIdx) => rowIdx >= activeSheet.frozenRows) : []),
    [visibleRows, activeSheet?.frozenRows],
  );
  const rowFenwick = useMemo(
    () => buildSheetRowFenwick(scrollableVisibleRows, rowHeights),
    [scrollableVisibleRows, rowHeights],
  );
  const virtualRowWindow = useMemo(
    () =>
      computeSheetVirtualWindow(
        visibleRows,
        rowHeights,
        activeSheet?.frozenRows ?? 0,
        gridScrollTop / Math.max(0.25, zoom / 100),
        gridViewportHeight / Math.max(0.25, zoom / 100),
        VIRTUAL_ROW_OVERSCAN,
        rowFenwick,
      ),
    [visibleRows, rowHeights, activeSheet?.frozenRows, gridScrollTop, gridViewportHeight, zoom, rowFenwick],
  );

  const focusedCell = activeSheet ? gridMap.cellByKey.get(pointKey(selection.focus)) : undefined;
  const focusedStyle: SheetCellStyle = focusedCell?.style ?? {};
  const displayedFormulaValue = editing ? editing.value : focusedCell?.raw ?? "";

  const visualCondBounds = useMemo(
    () => computeVisualCondFormatBounds(activeSheet?.conditionalFormats, gridMap.cellByKey, activeEvalMap),
    [activeSheet?.conditionalFormats, gridMap.cellByKey, activeEvalMap],
  );

  const formulaInspection = useMemo(
    () => (editing && !formulaDismissed ? inspectFormulaCaret(editing.value, formulaCaret) : ({ mode: "none" } as const)),
    [editing, formulaCaret, formulaDismissed],
  );

  const formulaCompletePrefix = formulaInspection.mode === "complete" ? formulaInspection.prefix : "";
  useEffect(() => {
    setFormulaAutoIdx(0);
  }, [formulaCompletePrefix]);

  useEffect(() => {
    if (!editing || !editing.value.startsWith("=")) {
      setFormulaAnchorRect(null);
      return;
    }
    const updateAnchor = () => {
      const targetEl = editing.source === "cell" ? cellInputRef.current : formulaBarWrapRef.current;
      if (!targetEl) return;
      const r = targetEl.getBoundingClientRect();
      setFormulaAnchorRect({ left: r.left, bottom: r.bottom, width: r.width });
    };
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    return () => window.removeEventListener("resize", updateAnchor);
  }, [editing?.source, editing?.sheetId, editing?.point.row, editing?.point.col, editing?.value.startsWith("=")]);

  const activeFilterOptions = useMemo(
    () => (activeSheet && filterPopover ? collectColumnFilterOptions(activeSheet, activeEvalMap, filterPopover.col) : []),
    [activeSheet, activeEvalMap, filterPopover],
  );

  const formulaHighlights = useMemo(() => {
    if (!activeSheet) return [];
    const formulaText = editing ? editing.value : (focusedCell?.raw ?? "");
    if (!formulaText.startsWith("=")) return [];
    const targetSheetId = editing ? editing.sheetId : activeSheet.id;
    return extractFormulaReferences(formulaText, targetSheetId, sheets).filter((h) => h.sheetId === activeSheet.id);
  }, [activeSheet, editing, focusedCell?.raw, sheets]);

  const hasAnyContent = useMemo(
    () => !!activeSheet && activeSheet.cells.some((c) => c.raw !== ""),
    [activeSheet],
  );

  const selectionSummary = useMemo(() => {
    if (!activeSheet) return null;
    const b = selectionBounds(selection);
    return computeSheetSelectionStats(b, activeEvalMap, (row, col) => gridMap.cellByKey.get(pointKey({ row, col }))?.raw);
  }, [activeSheet, selection, activeEvalMap, gridMap]);

  const applyLocalWriteResult = useCallback(
    (wid: number, nextWbRev: number, updated: { rowId: number; columnId: number; raw?: string; style?: SheetCellStyle; revision: number }[]) => {
      qc.setQueryData<SheetSnapshot>(workbookQueryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          workbookRevision: Math.max(old.workbookRevision, nextWbRev),
          sheets: old.sheets.map((ws) => {
            if (ws.id !== wid) return ws;
            const byKey = new Map<string, SheetCell>();
            for (const c of ws.cells) byKey.set(`${c.rowId}:${c.columnId}`, c);
            for (const item of updated) {
              const key = `${item.rowId}:${item.columnId}`;
              const prev = byKey.get(key);
              byKey.set(key, {
                rowId: item.rowId,
                columnId: item.columnId,
                raw: item.raw ?? prev?.raw ?? "",
                style: item.style ?? prev?.style ?? {},
                revision: item.revision,
              });
            }
            return { ...ws, revision: ws.revision + 1, cells: [...byKey.values()] };
          }),
        };
      });
    },
    [qc, workbookQueryKey],
  );

  const commitCellEdits = useCallback(
    async (
      edits: { row: number; col: number; raw?: string; style?: SheetCellStyle; stylePatch?: SheetStylePatch; expectedRevision?: number }[],
      options: { targetSheet?: SheetWorksheet; recordUndo?: boolean } = {},
    ): Promise<boolean> => {
      const targetWS = options.targetSheet ?? activeSheet;
      if (!canEdit || !targetWS || edits.length === 0) return false;
      const { cellByKey } = buildWorksheetGridMap(targetWS);
      const writes: SheetCellWrite[] = [];
      const forwardUndo: UndoEntry["forward"] = [];
      const backwardUndo: UndoEntry["backward"] = [];
      const localMap: { rowId: number; columnId: number; raw?: string; style?: SheetCellStyle }[] = [];

      const seen = new Set<string>();
      let warningMsg = "";
      for (const edit of edits) {
        if (edit.row < 0 || edit.row >= targetWS.rows.length || edit.col < 0 || edit.col >= targetWS.columns.length) continue;
        const k = `${edit.row}:${edit.col}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const rowId = targetWS.rows[edit.row].id;
        const columnId = targetWS.columns[edit.col].id;
        const cur = cellByKey.get(k);
        const nextRaw = edit.raw !== undefined ? edit.raw : undefined;
        const nextStyle = edit.style !== undefined ? edit.style : undefined;
        const nextStylePatch = edit.stylePatch;
        if (
          (nextRaw === undefined || nextRaw === (cur?.raw ?? "")) &&
          !nextStylePatch &&
          (nextStyle === undefined || JSON.stringify(nextStyle) === JSON.stringify(cur?.style ?? {}))
        ) {
          continue;
        }
        const prot = isSheetCellProtected(targetWS.protectedRanges, edit.row, edit.col, userId, role);
        if (prot.blocked) {
          setErrorMessage(t("该单元格位于保护区域内，暂无编辑权限"));
          return false;
        }
        if (nextRaw !== undefined) {
          const valCheck = evaluateSheetValidation(nextRaw, targetWS.validations, edit.row, edit.col);
          if (!valCheck.valid) {
            if (valCheck.strict) {
              setErrorMessage(valCheck.message);
              return false;
            }
            if (!warningMsg) warningMsg = valCheck.message;
          }
        }
        writes.push({
          rowId,
          columnId,
          expectedRevision: edit.expectedRevision ?? (cur?.revision ?? 0),
          ...(nextRaw !== undefined ? { raw: nextRaw } : {}),
          ...(nextStylePatch ? { stylePatch: nextStylePatch } : nextStyle !== undefined ? { style: nextStyle } : {}),
        });
        forwardUndo.push({ rowId, columnId, ...(nextRaw !== undefined ? { raw: nextRaw } : {}), ...(nextStyle !== undefined ? { style: nextStyle } : {}) });
        backwardUndo.push({ rowId, columnId, ...(nextRaw !== undefined ? { raw: cur?.raw ?? "" } : {}), ...(nextStyle !== undefined ? { style: cur?.style ?? {} } : {}) });
        localMap.push({ rowId, columnId, raw: nextRaw, style: nextStyle });
      }
      if (writes.length === 0) return true;

      setSavingCount((n) => n + 1);
      setErrorMessage("");
      try {
        const res = await sheetsApi.writeCells(sheetId, userId, {
          mutationId: makeMutationId(),
          worksheetId: targetWS.id,
          mergeMode: "auto",
          cells: writes,
        });
        if (!mountedRef.current) return true;

        const appliedUpdates: { rowId: number; columnId: number; raw?: string; style?: SheetCellStyle; revision: number }[] = [];
        const localByCell = new Map(localMap.map((m) => [`${m.rowId}:${m.columnId}`, m]));
        for (const c of res.cells) {
          const fallback = localByCell.get(`${c.rowId}:${c.columnId}`);
          appliedUpdates.push({
            rowId: c.rowId,
            columnId: c.columnId,
            raw: c.raw !== undefined ? c.raw : fallback?.raw,
            style: c.style !== undefined ? c.style : fallback?.style,
            revision: c.revision,
          });
        }
        const conflicts = res.conflicts ?? [];
        for (const cf of conflicts) {
          if (cf.currentRevision > 0) {
            appliedUpdates.push({
              rowId: cf.rowId,
              columnId: cf.columnId,
              raw: cf.currentRaw,
              style: cf.currentStyle ?? {},
              revision: cf.currentRevision,
            });
          }
        }
        if (appliedUpdates.length > 0) {
          applyLocalWriteResult(targetWS.id, res.workbookRevision, appliedUpdates);
          void qc.invalidateQueries({ queryKey: ["sheet-cell-history", sheetId, userId, targetWS.id] });
        }

        const committedKeys = new Set(res.cells.map((c) => `${c.rowId}:${c.columnId}`));
        if (options.recordUndo !== false && committedKeys.size > 0) {
          const committedForward = forwardUndo.filter((f) => committedKeys.has(`${f.rowId}:${f.columnId}`));
          const committedBackward = backwardUndo.filter((b) => committedKeys.has(`${b.rowId}:${b.columnId}`));
          if (committedForward.length > 0) {
            setUndoStack((prev) => [...prev.slice(-49), { worksheetId: targetWS.id, forward: committedForward, backward: committedBackward }]);
            setRedoStack([]);
          }
        }

        if (conflicts.length > 0) {
          setCellConflicts((prev) => {
            const byKey = new Map(prev.map((c) => [`${c.rowId}:${c.columnId}`, c]));
            for (const cf of conflicts) byKey.set(`${cf.rowId}:${cf.columnId}`, cf);
            return [...byKey.values()];
          });
          if (conflicts.some((c) => c.reason === "merge_slave_conflict")) {
            void qc.invalidateQueries({ queryKey: workbookQueryKey });
          }
          setStatusMessage(t("检测到 {count} 处单元格协同冲突，请在上方选择保留或采用版本", { count: conflicts.length }));
          return res.cells.length > 0;
        }

        if (res.mergedCount && res.mergedCount > 0) {
          setStatusMessage(t("已与协作者修改自动合并 {count} 个单元格", { count: res.mergedCount }));
        } else {
          setStatusMessage(warningMsg ? `${t("校验警告")}：${warningMsg}` : "");
        }
        return true;
      } catch (err) {
        if (!mountedRef.current) return false;
        if (err instanceof ApiError && err.status === 409) {
          setErrorMessage(t("表格内容已被其他协作者修改，已刷新最新数据，请重试。"));
          void qc.invalidateQueries({ queryKey: workbookQueryKey });
        } else if (err instanceof ApiError && err.status === 422) {
          setErrorMessage(err.message || t("单元格内容不符合数据验证规则"));
        } else if (err instanceof ApiError && err.status === 403) {
          setErrorMessage(err.message || t("该单元格位于保护区域内，暂无编辑权限"));
        } else {
          setErrorMessage(err instanceof Error ? err.message : t("保存失败，请检查网络后重试。"));
        }
        return false;
      } finally {
        if (mountedRef.current) setSavingCount((n) => Math.max(0, n - 1));
      }
    },
    [activeSheet, canEdit, role, sheetId, userId, applyLocalWriteResult, qc, workbookQueryKey],
  );

  const handleResolveCellConflicts = useCallback(
    async (targets: SheetCellConflict[], choice: "mine" | "theirs" | "anchor") => {
      if (!activeSheet || targets.length === 0) return;
      const targetKeys = new Set(targets.map((c) => `${c.rowId}:${c.columnId}`));
      if (choice === "theirs") {
        setCellConflicts((prev) => prev.filter((c) => !targetKeys.has(`${c.rowId}:${c.columnId}`)));
        setStatusMessage(t("已采用协作者最新版本"));
        return;
      }
      const writes: SheetCellWrite[] = [];
      for (const cf of targets) {
        const w = buildConflictResolutionWrite(cf, choice === "anchor" ? "anchor" : "mine");
        if (w) writes.push(w);
      }
      if (writes.length === 0) {
        setCellConflicts((prev) => prev.filter((c) => !targetKeys.has(`${c.rowId}:${c.columnId}`)));
        return;
      }
      setSavingCount((n) => n + 1);
      setErrorMessage("");
      try {
        const res = await sheetsApi.writeCells(sheetId, userId, {
          mutationId: makeMutationId(),
          worksheetId: activeSheet.id,
          mergeMode: "auto",
          cells: writes,
        });
        if (!mountedRef.current) return;
        const updates = res.cells.map((c) => ({
          rowId: c.rowId,
          columnId: c.columnId,
          raw: c.raw,
          style: c.style,
          revision: c.revision,
        }));
        const nextConflicts = res.conflicts ?? [];
        for (const cf of nextConflicts) {
          if (cf.currentRevision > 0) {
            updates.push({
              rowId: cf.rowId,
              columnId: cf.columnId,
              raw: cf.currentRaw,
              style: cf.currentStyle ?? {},
              revision: cf.currentRevision,
            });
          }
        }
        if (updates.length > 0) {
          applyLocalWriteResult(activeSheet.id, res.workbookRevision, updates);
        }
        setCellConflicts((prev) => {
          const remaining = prev.filter((c) => !targetKeys.has(`${c.rowId}:${c.columnId}`));
          if (nextConflicts.length === 0) return remaining;
          const byKey = new Map(remaining.map((c) => [`${c.rowId}:${c.columnId}`, c]));
          for (const cf of nextConflicts) byKey.set(`${cf.rowId}:${cf.columnId}`, cf);
          return [...byKey.values()];
        });
        setStatusMessage(
          nextConflicts.length > 0
            ? t("仍有 {count} 处冲突需确认", { count: nextConflicts.length })
            : choice === "anchor"
              ? t("已写入合并区域主格")
              : t("冲突已消解并保留我的修改"),
        );
      } catch (err) {
        if (mountedRef.current) {
          setErrorMessage(err instanceof Error ? err.message : t("冲突消解失败，请刷新后重试"));
        }
      } finally {
        if (mountedRef.current) setSavingCount((n) => Math.max(0, n - 1));
      }
    },
    [activeSheet, sheetId, userId, applyLocalWriteResult],
  );

  const runUndoRedo = async (direction: "undo" | "redo") => {
    const stack = direction === "undo" ? undoStack : redoStack;
    const entry = stack.at(-1);
    if (!entry || !canEdit) return;
    const targetWS = sheets.find((s) => s.id === entry.worksheetId);
    if (!targetWS) return;
    const { rowPosById, colPosById } = buildWorksheetGridMap(targetWS);
    const items = direction === "undo" ? entry.backward : entry.forward;
    const edits: { row: number; col: number; raw?: string; style?: SheetCellStyle }[] = [];
    for (const item of items) {
      const r = rowPosById.get(item.rowId);
      const c = colPosById.get(item.columnId);
      if (r === undefined || c === undefined) continue;
      edits.push({ row: r, col: c, raw: item.raw, style: item.style });
    }
    const ok = await commitCellEdits(edits, { targetSheet: targetWS, recordUndo: false });
    if (!ok) return;
    if (direction === "undo") {
      setUndoStack((prev) => prev.slice(0, -1));
      setRedoStack((prev) => [...prev.slice(-49), entry]);
    } else {
      setRedoStack((prev) => prev.slice(0, -1));
      setUndoStack((prev) => [...prev.slice(-49), entry]);
    }
  };

  useEffect(() => {
    if (editing?.source === "cell") {
      cellInputRef.current?.focus();
    }
  }, [editing?.source, editing?.point.row, editing?.point.col]);

  const beginEdit = (point: SheetPoint, initialValue?: string, source: "cell" | "formula" = "cell") => {
    if (!canEdit || !activeSheet) return;
    const snapped = normalizePointForMerge(point, mergeLookup);
    const prot = isSheetCellProtected(activeSheet.protectedRanges, snapped.row, snapped.col, userId, role);
    if (prot.blocked) {
      setErrorMessage(t("该单元格位于保护区域内，暂无编辑权限"));
      return;
    }
    setDropdownCell(null);
    const curCell = gridMap.cellByKey.get(pointKey(snapped));
    const initValue = initialValue !== undefined ? initialValue : (curCell?.raw ?? "");
    setSelection({ anchor: snapped, focus: snapped });
    setFormulaCaret(initValue.length);
    setFormulaAutoIdx(0);
    setFormulaDismissed(false);
    setEditing({
      sheetId: activeSheet.id,
      point: snapped,
      value: initValue,
      source,
      baseRevision: curCell?.revision ?? 0,
    });
  };

  const commitActiveEdit = async () => {
    if (!editing) return true;
    const targetWS = sheets.find((s) => s.id === editing.sheetId);
    const val = editing.value;
    const pt = editing.point;
    const baseRev = editing.baseRevision;
    setEditing(null);
    if (!targetWS) return true;
    return commitCellEdits([{ row: pt.row, col: pt.col, raw: val, expectedRevision: baseRev }], { targetSheet: targetWS });
  };

  const moveSelection = (dr: number, dc: number, extend: boolean) => {
    if (!activeSheet) return;
    const row = Math.max(0, Math.min(activeSheet.rows.length - 1, selection.focus.row + dr));
    const col = Math.max(0, Math.min(activeSheet.columns.length - 1, selection.focus.col + dc));
    const next = normalizePointForMerge({ row, col }, mergeLookup);
    setSelection(extend ? { ...selection, focus: next } : { anchor: next, focus: next });
  };

  const handleStylePatch = async (patch: Partial<SheetCellStyle>) => {
    if (!canEdit || !activeSheet) return;
    const b = selectionBounds(selection);
    const wirePatch = toSheetStylePatch(patch);
    const edits: { row: number; col: number; style: SheetCellStyle; stylePatch: SheetStylePatch }[] = [];
    for (let r = b.top; r <= b.bottom; r++) {
      for (let c = b.left; c <= b.right; c++) {
        const curStyle = gridMap.cellByKey.get(`${r}:${c}`)?.style ?? {};
        const nextStyle: SheetCellStyle = { ...curStyle, ...patch };
        if (nextStyle.bg === "") delete nextStyle.bg;
        if (nextStyle.fontFamily === "") delete nextStyle.fontFamily;
        if (nextStyle.align === "") delete nextStyle.align;
        if (nextStyle.valign === "") delete nextStyle.valign;
        if ("borders" in patch && !patch.borders) delete nextStyle.borders;
        edits.push({ row: r, col: c, style: nextStyle, stylePatch: wirePatch });
      }
    }
    await commitCellEdits(edits);
  };

  const handleApplyBorderPreset = async (preset: SheetBorderPreset, color = "#8f959e") => {
    if (!canEdit || !activeSheet) return;
    const b = selectionBounds(selection);
    const edits: { row: number; col: number; style: SheetCellStyle; stylePatch: SheetStylePatch }[] = [];
    for (let r = b.top; r <= b.bottom; r++) {
      for (let c = b.left; c <= b.right; c++) {
        const curStyle = gridMap.cellByKey.get(`${r}:${c}`)?.style ?? {};
        let nextBorders: SheetBorders | undefined;
        if (preset === "all") {
          nextBorders = { top: true, right: true, bottom: true, left: true, color };
        } else if (preset === "outer") {
          const top = r === b.top;
          const bottom = r === b.bottom;
          const left = c === b.left;
          const right = c === b.right;
          if (top || right || bottom || left) {
            nextBorders = {
              ...(top ? { top: true } : {}),
              ...(right ? { right: true } : {}),
              ...(bottom ? { bottom: true } : {}),
              ...(left ? { left: true } : {}),
              color,
            };
          }
        } else if (preset === "bottom") {
          if (r === b.bottom) nextBorders = { bottom: true, color };
        } else if (preset === "topBottom") {
          const top = r === b.top;
          const bottom = r === b.bottom;
          if (top || bottom) {
            nextBorders = {
              ...(top ? { top: true } : {}),
              ...(bottom ? { bottom: true } : {}),
              color,
            };
          }
        } else {
          nextBorders = undefined;
        }
        if (JSON.stringify(curStyle.borders ?? null) === JSON.stringify(nextBorders ?? null)) continue;
        const nextStyle: SheetCellStyle = { ...curStyle };
        if (nextBorders) nextStyle.borders = nextBorders;
        else delete nextStyle.borders;
        const stylePatch: SheetStylePatch = nextBorders ? { borders: nextBorders } : { clearBorders: true };
        edits.push({ row: r, col: c, style: nextStyle, stylePatch });
      }
    }
    if (edits.length > 0) await commitCellEdits(edits);
  };

  const handleToggleBorder = async () => {
    if (!canEdit || !activeSheet) return;
    const hasBorders = !!focusedStyle.borders;
    await handleApplyBorderPreset(hasBorders ? "none" : "all");
  };

  const handleClearFormat = async () => {
    if (!canEdit || !activeSheet) return;
    const b = selectionBounds(selection);
    const edits: { row: number; col: number; style: SheetCellStyle }[] = [];
    for (let r = b.top; r <= b.bottom; r++) {
      for (let c = b.left; c <= b.right; c++) {
        edits.push({ row: r, col: c, style: {} });
      }
    }
    await commitCellEdits(edits);
  };

  const handleWorksheetPatch = async (wid: number, patch: Parameters<typeof sheetsApi.updateWorksheet>[3]) => {
    if (!canEdit) return false;
    setSavingCount((n) => n + 1);
    setErrorMessage("");
    try {
      const res = await sheetsApi.updateWorksheet(sheetId, wid, userId, patch);
      qc.setQueryData<SheetSnapshot>(workbookQueryKey, (old) => {
        if (!old) return old;
        const nextSheets = old.sheets.map((s) => (s.id === wid ? res.worksheet : s)).sort((a, b) => a.pos - b.pos || a.id - b.id);
        return { ...old, workbookRevision: Math.max(old.workbookRevision, res.workbookRevision), sheets: nextSheets };
      });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "merge_overlap_conflict" && patch.mergeOp) {
        const latestWs = err.details?.worksheet as SheetWorksheet | undefined;
        const latestWbRev = typeof err.details?.workbookRevision === "number" ? err.details.workbookRevision : undefined;
        if (latestWs) {
          qc.setQueryData<SheetSnapshot>(workbookQueryKey, (old) => {
            if (!old) return old;
            return {
              ...old,
              workbookRevision: latestWbRev ? Math.max(old.workbookRevision, latestWbRev) : old.workbookRevision,
              sheets: old.sheets.map((s) => (s.id === wid ? latestWs : s)),
            };
          });
        } else {
          void qc.invalidateQueries({ queryKey: workbookQueryKey });
        }
        const conflictingMerges = Array.isArray(err.details?.conflictingMerges)
          ? (err.details.conflictingMerges as SheetMerge[])
          : [];
        setMergeConflict({
          worksheetId: wid,
          attemptedRect: patch.mergeOp.rect,
          conflictingMerges,
          message: err.message,
        });
        return false;
      }
      setErrorMessage(err instanceof Error ? err.message : t("更新工作表失败"));
      void qc.invalidateQueries({ queryKey: workbookQueryKey });
      return false;
    } finally {
      setSavingCount((n) => Math.max(0, n - 1));
    }
  };

  const handleUpdateValidations = async (next: SheetDataValidation[]) => {
    if (!activeSheet) return;
    await handleWorksheetPatch(activeSheet.id, { validations: next });
  };

  const handleUpdateCondFormats = async (next: SheetConditionalFormat[]) => {
    if (!activeSheet) return;
    await handleWorksheetPatch(activeSheet.id, { conditionalFormats: next });
  };

  const handleUpdateProtectedRanges = async (next: SheetProtectedRange[]) => {
    if (!activeSheet) return;
    await handleWorksheetPatch(activeSheet.id, { protectedRanges: next });
  };

  const handleUpdateCharts = async (next: SheetChart[]) => {
    if (!activeSheet) return;
    await handleWorksheetPatch(activeSheet.id, { charts: next });
  };

  const handleUpdatePivotTables = async (next: SheetPivotTable[]) => {
    if (!activeSheet) return;
    await handleWorksheetPatch(activeSheet.id, { pivotTables: next });
  };

  const handleMaterializePivot = async (
    pivot: SheetPivotTable,
    sourceSheet: SheetWorksheet,
    sourceEvalMap: EvaluatedSheetMap,
  ) => {
    if (!canEdit) return;
    const computed = computePivotTable(sourceSheet, sourceEvalMap, pivot);
    const matrix = pivotResultToCellMatrix(pivot, computed);
    if (matrix.length === 0) return;

    const rawBase = `透视-${(pivot.title || "").trim() || t("汇总")}`.replace(/[\[\]:*?/\\']/g, "").trim() || t("透视表");
    const base = rawBase.slice(0, 26);
    const existingNames = new Set(sheets.map((s) => s.title.toLowerCase()));
    let candidateTitle = base;
    for (let suffix = 2; existingNames.has(candidateTitle.toLowerCase()) && suffix < 100; suffix++) {
      candidateTitle = `${base.slice(0, 26 - String(suffix).length - 1)} ${suffix}`;
    }

    setSavingCount((n) => n + 1);
    setErrorMessage("");
    try {
      const created = await sheetsApi.createWorksheet(sheetId, userId, candidateTitle);
      let targetWs = created.worksheet;
      let latestWbRev = created.workbookRevision;

      const maxRow = matrix.reduce((m, e) => Math.max(m, e.row), 0);
      const maxCol = matrix.reduce((m, e) => Math.max(m, e.col), 0);
      if (maxRow >= targetWs.rows.length) {
        const extra = maxRow - targetWs.rows.length + 5;
        const expanded = await sheetsApi.mutateAxis(sheetId, targetWs.id, userId, {
          op: "insert_row",
          index: targetWs.rows.length,
          count: extra,
        });
        targetWs = expanded.worksheet;
        latestWbRev = Math.max(latestWbRev, expanded.workbookRevision);
      }
      if (maxCol >= targetWs.columns.length) {
        const extra = maxCol - targetWs.columns.length + 2;
        const expanded = await sheetsApi.mutateAxis(sheetId, targetWs.id, userId, {
          op: "insert_col",
          index: targetWs.columns.length,
          count: extra,
        });
        targetWs = expanded.worksheet;
        latestWbRev = Math.max(latestWbRev, expanded.workbookRevision);
      }

      const cells: SheetCellWrite[] = [];
      for (const item of matrix) {
        const rowAxis = targetWs.rows[item.row];
        const colAxis = targetWs.columns[item.col];
        if (!rowAxis || !colAxis) continue;
        cells.push({
          rowId: rowAxis.id,
          columnId: colAxis.id,
          expectedRevision: 0,
          raw: item.raw,
          style: item.style,
        });
      }

      if (cells.length > 0) {
        const writeRes = await sheetsApi.writeCells(sheetId, userId, {
          mutationId: makeMutationId(),
          worksheetId: targetWs.id,
          mergeMode: "auto",
          cells,
        });
        latestWbRev = Math.max(latestWbRev, writeRes.workbookRevision);
        const writtenCells: SheetCell[] = writeRes.cells.map((c) => ({
          rowId: c.rowId,
          columnId: c.columnId,
          raw: c.raw ?? "",
          style: c.style ?? {},
          revision: c.revision,
        }));
        targetWs = { ...targetWs, cells: writtenCells };
      }

      // Auto-fit materialized columns so long cross-tab headers (e.g. "总计 · 利润(求和)") stay unclipped.
      const colWidthsNeeded = new Map<number, number>();
      for (const item of matrix) {
        let approx = 28;
        for (const ch of item.raw) {
          approx += ch.charCodeAt(0) > 127 ? 13 : 7.5;
        }
        const desired = Math.min(240, Math.max(DEFAULT_COL_WIDTH, Math.ceil(approx)));
        if (desired > (colWidthsNeeded.get(item.col) ?? DEFAULT_COL_WIDTH)) {
          colWidthsNeeded.set(item.col, desired);
        }
      }
      for (const [colIdx, size] of colWidthsNeeded) {
        if (size <= DEFAULT_COL_WIDTH) continue;
        const resized = await sheetsApi.mutateAxis(sheetId, targetWs.id, userId, {
          op: "resize_col",
          index: colIdx,
          size,
        });
        targetWs = { ...resized.worksheet, cells: targetWs.cells };
        latestWbRev = Math.max(latestWbRev, resized.workbookRevision);
      }

      qc.setQueryData<SheetSnapshot>(workbookQueryKey, (old) => {
        if (!old) return old;
        const withoutDup = old.sheets.filter((s) => s.id !== targetWs.id);
        return {
          ...old,
          workbookRevision: Math.max(old.workbookRevision, latestWbRev),
          sheets: [...withoutDup, targetWs].sort((a, b) => a.pos - b.pos || a.id - b.id),
        };
      });
      setActiveSheetId(targetWs.id);
      setSelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
      setStatusMessage(t("已将透视表生成到新工作表「{title}」", { title: targetWs.title }));
      void qc.invalidateQueries({ queryKey: workbookQueryKey });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("生成透视工作表失败"));
    } finally {
      setSavingCount((n) => Math.max(0, n - 1));
    }
  };

  const handleCreateComment = async (body: string): Promise<boolean> => {
    if (!activeSheet || !canComment) return false;
    const rowId = activeSheet.rows[selection.focus.row]?.id;
    const columnId = activeSheet.columns[selection.focus.col]?.id;
    if (!rowId || !columnId) return false;
    setErrorMessage("");
    try {
      const res = await sheetsApi.createComment(sheetId, userId, {
        worksheetId: activeSheet.id,
        rowId,
        columnId,
        body,
      });
      qc.setQueryData<{ comments: SheetComment[] }>(commentsQueryKey, (old) => ({
        comments: [...(old?.comments ?? []), res.comment],
      }));
      return true;
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("发送评论失败"));
      return false;
    }
  };

  const handleToggleResolveComment = async (cm: SheetComment) => {
    setErrorMessage("");
    try {
      const res = await sheetsApi.updateComment(sheetId, userId, cm.id, { resolved: !cm.resolved });
      qc.setQueryData<{ comments: SheetComment[] }>(commentsQueryKey, (old) => ({
        comments: (old?.comments ?? []).map((item) => (item.id === cm.id ? res.comment : item)),
      }));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("更新评论状态失败"));
    }
  };

  const handleDeleteComment = async (commentId: number) => {
    setErrorMessage("");
    try {
      await sheetsApi.deleteComment(sheetId, userId, commentId);
      qc.setQueryData<{ comments: SheetComment[] }>(commentsQueryKey, (old) => ({
        comments: (old?.comments ?? []).filter((item) => item.id !== commentId),
      }));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("删除评论失败"));
    }
  };

  const handleTogglePanel = (mode: SheetPanelMode) => {
    setActivePanel((cur) => (cur === mode ? null : mode));
  };

  const handleUpdateDefinedNames = (next: SheetDefinedName[]) => {
    setDefinedNames(next);
    saveStoredDefinedNames(sheetId, next);
    setStatusMessage(t("已更新定义名称"));
  };

  const handleJumpToNamedRange = (dn: SheetDefinedName) => {
    if (!activeSheet) return;
    const target = parseDefinedNameTarget(dn, sheets, activeSheet);
    if (!target) {
      setStatusMessage(t("该名称不是有效的单元格区域引用"));
      return;
    }
    if (target.sheetId !== activeSheet.id) {
      setActiveSheetId(target.sheetId);
    }
    setSelection({
      anchor: { row: target.rect.top, col: target.rect.left },
      focus: { row: target.rect.bottom, col: target.rect.right },
    });
    gridRef.current?.focus();
  };

  const handleVersionRestored = (snapshot: SheetSnapshot) => {
    qc.setQueryData<SheetSnapshot>(workbookQueryKey, snapshot);
    if (snapshot.sheets.length > 0 && !snapshot.sheets.some((s) => s.id === activeSheetId)) {
      setActiveSheetId(snapshot.sheets[0].id);
    }
    setSelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
    setEditing(null);
    setUndoStack([]);
    setRedoStack([]);
    setCellConflicts([]);
    setMergeConflict(null);
    void qc.invalidateQueries({ queryKey: commentsQueryKey });
    void qc.invalidateQueries({ queryKey: ["sheet-cell-history", sheetId, userId] });
    setStatusMessage(t("已恢复历史版本，并已自动备份恢复前内容"));
  };

  const handleClearSelectedCells = async () => {
    if (!canEdit || !activeSheet) return;
    const b = selectionBounds(selection);
    const edits: { row: number; col: number; raw: string }[] = [];
    for (let r = b.top; r <= b.bottom; r++) {
      for (let c = b.left; c <= b.right; c++) {
        if ((gridMap.cellByKey.get(`${r}:${c}`)?.raw ?? "") !== "") {
          edits.push({ row: r, col: c, raw: "" });
        }
      }
    }
    if (edits.length > 0) {
      await commitCellEdits(edits);
    }
  };

  const matchingMerge = useMemo(() => {
    if (!activeSheet) return null;
    const b = selectionBounds(selection);
    return (
      activeSheet.merges.find(
        (m) => sameRect(m, b) || (b.top >= m.top && b.bottom <= m.bottom && b.left >= m.left && b.right <= m.right),
      ) ?? null
    );
  }, [activeSheet, selection]);
  const isSelectionMerged = !!matchingMerge;

  const handleToggleMerge = async () => {
    if (!canEdit || !activeSheet) return;
    if (matchingMerge) {
      await handleWorksheetPatch(activeSheet.id, {
        mergeOp: { op: "unmerge", rect: matchingMerge, expectedMerges: activeSheet.merges },
      });
      return;
    }
    const b = selectionBounds(selection);
    if (b.top === b.bottom && b.left === b.right) {
      setStatusMessage(t("请先框选两个及以上单元格再合并"));
      return;
    }
    const ok = await handleWorksheetPatch(activeSheet.id, {
      mergeOp: { op: "merge", rect: b, expectedMerges: activeSheet.merges },
    });
    if (ok) {
      setMergeConflict(null);
      setSelection({ anchor: { row: b.top, col: b.left }, focus: { row: b.top, col: b.left } });
    }
  };

  const handleResolveMergeConflict = async (force: boolean) => {
    if (!mergeConflict) return;
    if (!force) {
      setMergeConflict(null);
      setStatusMessage(t("已保留协作者的合并区域"));
      return;
    }
    const target = mergeConflict;
    const ok = await handleWorksheetPatch(target.worksheetId, {
      mergeOp: { op: "merge", rect: target.attemptedRect, force: true },
    });
    if (ok) {
      setMergeConflict(null);
      setSelection({
        anchor: { row: target.attemptedRect.top, col: target.attemptedRect.left },
        focus: { row: target.attemptedRect.top, col: target.attemptedRect.left },
      });
      setStatusMessage(t("已覆盖合并所选区域"));
    }
  };

  const handleAxisOp = async (op: Parameters<typeof sheetsApi.mutateAxis>[3]) => {
    if (!canEdit || !activeSheet) return;
    setSavingCount((n) => n + 1);
    setErrorMessage("");
    try {
      const res = await sheetsApi.mutateAxis(sheetId, activeSheet.id, userId, op);
      qc.setQueryData<SheetSnapshot>(workbookQueryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          workbookRevision: Math.max(old.workbookRevision, res.workbookRevision),
          sheets: old.sheets.map((s) => (s.id === activeSheet.id ? res.worksheet : s)),
        };
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("行列调整失败"));
      void qc.invalidateQueries({ queryKey: workbookQueryKey });
    } finally {
      setSavingCount((n) => Math.max(0, n - 1));
    }
  };

  const handleSort = async (ascending: boolean, colOverride?: number) => {
    if (!canEdit || !activeSheet) return;
    if (activeSheet.merges.length > 0) {
      setStatusMessage(t("当前工作表包含合并单元格，请取消合并后再排序"));
      return;
    }
    const targetCol = colOverride ?? selection.focus.col;
    const writes = computeSortedRowWrites(activeSheet, activeEvalMap, targetCol, ascending, activeSheet.filter?.headerRow ?? 0);
    if (writes.length === 0) {
      setStatusMessage(t("当前列数据无需调整顺序"));
      return;
    }
    const { rowPosById, colPosById } = buildWorksheetGridMap(activeSheet);
    const edits: { row: number; col: number; raw?: string; style?: SheetCellStyle }[] = [];
    for (const w of writes) {
      const r = rowPosById.get(w.rowId);
      const c = colPosById.get(w.columnId);
      if (r !== undefined && c !== undefined) edits.push({ row: r, col: c, raw: w.raw, style: w.style });
    }
    await commitCellEdits(edits);
  };

  const handleCreateSheet = async () => {
    if (!canEdit) return;
    setSavingCount((n) => n + 1);
    try {
      const res = await sheetsApi.createWorksheet(sheetId, userId, "");
      qc.setQueryData<SheetSnapshot>(workbookQueryKey, (old) => {
        if (!old) return old;
        return { ...old, workbookRevision: res.workbookRevision, sheets: [...old.sheets, res.worksheet] };
      });
      setActiveSheetId(res.worksheet.id);
      setSelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("新建工作表失败"));
    } finally {
      setSavingCount((n) => Math.max(0, n - 1));
    }
  };

  const handleRenameSheet = async (wid: number) => {
    const ws = sheets.find((s) => s.id === wid);
    if (!ws || !canEdit) return;
    const next = await askText(t("重命名工作表"), t("工作表名称"), ws.title);
    if (!next || !next.trim() || next.trim() === ws.title) return;
    await handleWorksheetPatch(wid, { title: next.trim() });
  };

  const handleDeleteSheet = async (wid: number) => {
    const ws = sheets.find((s) => s.id === wid);
    if (!ws || !canEdit || sheets.length <= 1) return;
    if (!(await ask(t("删除工作表「{name}」？", { name: ws.title }), t("工作表中的数据将被清除，无法恢复。"), true))) return;
    setSavingCount((n) => n + 1);
    try {
      const res = await sheetsApi.deleteWorksheet(sheetId, wid, userId);
      qc.setQueryData<SheetSnapshot>(workbookQueryKey, (old) => {
        if (!old) return old;
        const remaining = old.sheets.filter((s) => s.id !== wid).map((s, pos) => ({ ...s, pos }));
        return { ...old, workbookRevision: res.workbookRevision, sheets: remaining };
      });
      if (activeSheetId === wid) {
        const remaining = sheets.filter((s) => s.id !== wid);
        if (remaining[0]) setActiveSheetId(remaining[0].id);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("删除工作表失败"));
    } finally {
      setSavingCount((n) => Math.max(0, n - 1));
    }
  };

  const handleRenameWorkbookTitle = async () => {
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (!trimmed || !meta.data || !workbook.data || trimmed === meta.data.title) return;
    try {
      await sheetsApi.renameTitle(sheetId, userId, trimmed, meta.data.title, meta.data.driveRevision ?? workbook.data.driveRevision);
      void qc.invalidateQueries({ queryKey: metaQueryKey });
      void qc.invalidateQueries({ queryKey: workbookQueryKey });
      void qc.invalidateQueries({ queryKey: ["docs"] });
      void qc.invalidateQueries({ queryKey: ["drive"] });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("重命名失败，请刷新后重试。"));
    }
  };

  const handleExportXlsx = () => {
    if (!sheets.length) return;
    if (!canDownload) {
      setErrorMessage(t("该表格已禁止下载和创建副本"));
      return;
    }
    try {
      const bytes = exportWorkbookToXlsx(sheets);
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(meta.data?.title.trim() || t("未命名表格"))}.xlsx`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatusMessage(t("已导出多工作表 XLSX 文件"));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("导出 XLSX 失败"));
    }
  };

  const handleSelectXlsxImport = async (file: File) => {
    setImporting(true);
    setErrorMessage("");
    try {
      const preview = await parseXlsxForWorkbook(file);
      if (mountedRef.current) setPendingImport({ filename: file.name, sheets: preview });
    } catch (err) {
      if (mountedRef.current) setErrorMessage(err instanceof Error ? err.message : t("无法解析该 XLSX 文件"));
    } finally {
      if (mountedRef.current) setImporting(false);
    }
  };

  const handleConfirmXlsxImport = async () => {
    if (!pendingImport || !workbook.data) return;
    setSavingCount((n) => n + 1);
    setErrorMessage("");
    try {
      const next = await sheetsApi.importXlsx(sheetId, userId, workbook.data.workbookRevision, makeMutationId(), pendingImport.sheets.sheets);
      qc.setQueryData(workbookQueryKey, next);
      setActiveSheetId(next.sheets[0]?.id ?? 0);
      setSelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
      setUndoStack([]);
      setRedoStack([]);
      setPendingImport(null);
      setStatusMessage(t("已导入并保存到云端"));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("导入失败，请刷新后重试。"));
    } finally {
      setSavingCount((n) => Math.max(0, n - 1));
    }
  };

  const handleApplyTemplate = async (tpl: SheetStarterTemplate) => {
    if (!activeSheet || !canEdit) return;
    await commitCellEdits(tpl.cells.map((c) => ({ row: c.row, col: c.col, raw: c.raw, style: c.style })));
    setTemplateHidden(true);
  };

  const handleDuplicate = async () => {
    if (!canDownload) {
      setErrorMessage(t("该表格已禁止下载和创建副本"));
      return;
    }
    try {
      const copy = await sheetsApi.duplicate(sheetId, userId);
      void qc.invalidateQueries({ queryKey: ["docs"] });
      go(`#/sheet/${copy.id}`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("创建副本失败"));
    }
  };

  const handleTrash = async () => {
    if (!meta.data || meta.data.role !== "manage") return;
    if (!(await ask(t("删除「{title}」？", { title: meta.data.title || t("未命名表格") }), t("可在回收站还原。")))) return;
    try {
      await driveApi.trashForAccount(sheetId, userId, meta.data.driveRevision ?? 0);
      void qc.invalidateQueries({ queryKey: ["docs"] });
      void qc.invalidateQueries({ queryKey: ["trash"] });
      go("#/");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : t("删除失败，请刷新后重试。"));
    }
  };

  const pinned = !!pins.data?.some((p) => p.id === sheetId);
  const togglePin = async () => {
    try {
      await extrasApi.pinForAccount(sheetId, userId, !pinned);
      void qc.invalidateQueries({ queryKey: ["home-pins", userId] });
      void qc.invalidateQueries({ queryKey: ["pins"] });
    } catch {
      setErrorMessage(t("置顶操作未确认"));
    }
  };

  const commitFillHandle = async (endPoint: SheetPoint) => {
    if (!activeSheet || !canEdit) return;
    const b = selectionBounds(selection);
    const edits: { row: number; col: number; raw: string; style?: SheetCellStyle }[] = [];
    const srcHeight = b.bottom - b.top + 1;
    const srcWidth = b.right - b.left + 1;

    if (endPoint.row > b.bottom) {
      for (let r = b.bottom + 1; r <= endPoint.row; r++) {
        const srcRow = b.top + ((r - b.top) % srcHeight);
        for (let c = b.left; c <= b.right; c++) {
          const srcCell = gridMap.cellByKey.get(`${srcRow}:${c}`);
          const srcRaw = srcCell?.raw ?? "";
          const nextRaw = srcRaw.startsWith("=")
            ? translateWorkbookFormula(srcRaw, r - srcRow, 0, activeSheet.rows.length, activeSheet.columns.length)
            : srcRaw;
          edits.push({ row: r, col: c, raw: nextRaw, style: srcCell?.style });
        }
      }
      setSelection({ anchor: { row: b.top, col: b.left }, focus: { row: endPoint.row, col: b.right } });
    } else if (endPoint.col > b.right) {
      for (let c = b.right + 1; c <= endPoint.col; c++) {
        const srcCol = b.left + ((c - b.left) % srcWidth);
        for (let r = b.top; r <= b.bottom; r++) {
          const srcCell = gridMap.cellByKey.get(`${r}:${srcCol}`);
          const srcRaw = srcCell?.raw ?? "";
          const nextRaw = srcRaw.startsWith("=")
            ? translateWorkbookFormula(srcRaw, 0, c - srcCol, activeSheet.rows.length, activeSheet.columns.length)
            : srcRaw;
          edits.push({ row: r, col: c, raw: nextRaw, style: srcCell?.style });
        }
      }
      setSelection({ anchor: { row: b.top, col: b.left }, focus: { row: b.bottom, col: endPoint.col } });
    }
    if (edits.length > 0) await commitCellEdits(edits);
  };

  const handleCopy = (e: React.ClipboardEvent) => {
    if (!canCopy) {
      e.preventDefault();
      setStatusMessage(t("该表格已禁止复制内容"));
      return;
    }
    if (editing || !activeSheet) return;
    e.preventDefault();
    const b = selectionBounds(selection);
    const matrix: string[][] = [];
    const copiedCells: { dr: number; dc: number; raw: string; style?: SheetCellStyle }[] = [];
    for (let r = b.top; r <= b.bottom; r++) {
      const rowArr: string[] = [];
      for (let c = b.left; c <= b.right; c++) {
        const cell = gridMap.cellByKey.get(`${r}:${c}`);
        rowArr.push(cell?.raw ?? "");
        copiedCells.push({ dr: r - b.top, dc: c - b.left, raw: cell?.raw ?? "", style: cell?.style });
      }
      matrix.push(rowArr);
    }
    e.clipboardData.setData("text/plain", formatTSV(matrix));
    const token = makeMutationId();
    internalClipboard.current = { token, sheetId: activeSheet.id, bounds: b, cells: copiedCells };
    try {
      e.clipboardData.setData("application/x-jiange-sheet", token);
    } catch {
      /* ignore custom mime fallback */
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    if (editing || !activeSheet || !canEdit) return;
    e.preventDefault();
    let customToken = "";
    try {
      customToken = e.clipboardData.getData("application/x-jiange-sheet");
    } catch {
      /* ignore */
    }
    const anchor = selection.focus;
    if (customToken && internalClipboard.current?.token === customToken) {
      const snap = internalClipboard.current;
      const edits = snap.cells.map((item) => {
        const targetRow = anchor.row + item.dr;
        const targetCol = anchor.col + item.dc;
        const dr = targetRow - (snap.bounds.top + item.dr);
        const dc = targetCol - (snap.bounds.left + item.dc);
        const nextRaw = item.raw.startsWith("=")
          ? translateWorkbookFormula(item.raw, dr, dc, activeSheet.rows.length, activeSheet.columns.length)
          : item.raw;
        return { row: targetRow, col: targetCol, raw: nextRaw, style: item.style };
      });
      await commitCellEdits(edits);
      return;
    }
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const matrix = parseTSV(text);
    const edits: { row: number; col: number; raw: string }[] = [];
    for (let dr = 0; dr < matrix.length; dr++) {
      for (let dc = 0; dc < matrix[dr].length; dc++) {
        edits.push({ row: anchor.row + dr, col: anchor.col + dc, raw: matrix[dr][dc] });
      }
    }
    await commitCellEdits(edits);
  };

  const handleGridKeyDown = async (e: React.KeyboardEvent) => {
    if (editing || !activeSheet || e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      await runUndoRedo(e.shiftKey ? "redo" : "undo");
      return;
    }
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setFindOpen(true);
      return;
    }
    if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      await handleStylePatch({ bold: !focusedStyle.bold });
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelection({ anchor: { row: 0, col: 0 }, focus: { row: activeSheet.rows.length - 1, col: activeSheet.columns.length - 1 } });
      return;
    }
    const dirs: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      Tab: [0, e.shiftKey ? -1 : 1],
    };
    if (dirs[e.key]) {
      e.preventDefault();
      moveSelection(dirs[e.key][0], dirs[e.key][1], e.key !== "Tab" && e.shiftKey);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      moveSelection(e.shiftKey ? -1 : 1, 0, false);
      return;
    }
    if (e.key === "F2") {
      e.preventDefault();
      beginEdit(selection.focus);
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && canEdit) {
      e.preventDefault();
      const b = selectionBounds(selection);
      const edits: { row: number; col: number; raw: string }[] = [];
      for (let r = b.top; r <= b.bottom; r++) {
        for (let c = b.left; c <= b.right; c++) edits.push({ row: r, col: c, raw: "" });
      }
      await commitCellEdits(edits);
      return;
    }
    if (canEdit && !mod && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      beginEdit(selection.focus, e.key, "cell");
    }
  };

  if (meta.isPending) {
    return <div className="grid flex-1 place-items-center text-[13px] text-[#8f959e]">{t("正在加载电子表格…")}</div>;
  }
  if (meta.isError || !meta.data) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <div>
          <p className="text-[14px] text-[#1f2329]">{t("无法打开该表格，可能已删除或暂无访问权限。")}</p>
          <a href="#/" className="mt-4 inline-block rounded-md border px-4 py-1.5 text-[13px] hover:bg-[#f2f3f5]">{t("返回主页")}</a>
        </div>
      </div>
    );
  }
  if (meta.data.kind !== "sheet") {
    return <ResourceTypeNotice id={sheetId} kind={meta.data.kind} verified={!meta.isFetching} />;
  }
  if (workbook.isPending || !activeSheet) {
    return <div className="grid flex-1 place-items-center text-[13px] text-[#8f959e]">{t("正在加载工作表数据…")}</div>;
  }
  if (workbook.isError || !workbook.data) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <div>
          <p className="text-[14px] text-destructive">{t("加载工作簿失败，请刷新后重试。")}</p>
          <button type="button" onClick={() => void workbook.refetch()} className="mt-3 rounded-md border px-4 py-1.5 text-[13px]">{t("重试")}</button>
        </div>
      </div>
    );
  }

  const folderCrumbs = (ancestors.data ?? []).filter((item) => item.id !== sheetId);
  const rootLabel = meta.data.workspaceName || me.workspaces.find((w) => w.id === meta.data.workspaceId)?.name || t("我的文档库");
  const titleText = meta.data.title.trim() || t("未命名表格");

  const startResizeCol = (colIndex: number, startX: number) => {
    const startWidth = colWidths[colIndex];
    let latest = startWidth;
    const onMove = (ev: PointerEvent) => {
      latest = Math.max(40, Math.min(800, Math.round(startWidth + (ev.clientX - startX))));
      const cur = qc.getQueryData<SheetSnapshot>(workbookQueryKey);
      if (!cur) return;
      qc.setQueryData<SheetSnapshot>(workbookQueryKey, {
        ...cur,
        sheets: cur.sheets.map((s) =>
          s.id === activeSheet.id ? { ...s, columns: s.columns.map((c, idx) => (idx === colIndex ? { ...c, size: latest } : c)) } : s,
        ),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (latest !== startWidth) {
        void handleAxisOp({ op: "resize_col", index: colIndex, size: latest });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startResizeRow = (rowIndex: number, startY: number) => {
    const startHeight = rowHeights[rowIndex];
    let latest = startHeight;
    const onMove = (ev: PointerEvent) => {
      latest = Math.max(20, Math.min(400, Math.round(startHeight + (ev.clientY - startY))));
      const cur = qc.getQueryData<SheetSnapshot>(workbookQueryKey);
      if (!cur) return;
      qc.setQueryData<SheetSnapshot>(workbookQueryKey, {
        ...cur,
        sheets: cur.sheets.map((s) =>
          s.id === activeSheet.id ? { ...s, rows: s.rows.map((r, idx) => (idx === rowIndex ? { ...r, size: latest } : r)) } : s,
        ),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (latest !== startHeight) {
        void handleAxisOp({ op: "resize_row", index: rowIndex, size: latest });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const insertFormulaRefAtClick = (targetPoint: SheetPoint): boolean => {
    if (!editing || !editing.value.startsWith("=")) return false;
    const tail = editing.value.slice(-1);
    if (!editing.value || !"=,(+-*/^&<>:".includes(tail) && editing.value !== "=") return false;
    const targetSheetTitle = activeSheet.title;
    const prefix = editing.sheetId === activeSheet.id ? "" : formatSheetRefPrefix(targetSheetTitle);
    const refText = `${prefix}${sheetAddress(targetPoint)}`;
    const nextVal = editing.value + refText;
    setEditing({ ...editing, value: nextVal });
    setFormulaCaret(nextVal.length);
    setFormulaDismissed(false);
    requestAnimationFrame(() => {
      const input = editing.source === "cell" ? cellInputRef.current : formulaInputRef.current;
      if (input) {
        input.focus();
        input.setSelectionRange(nextVal.length, nextVal.length);
      }
    });
    return true;
  };

  const syncFormulaCaretFromInput = (el: HTMLInputElement | null, source: "cell" | "formula", fallbackPos?: number) => {
    const pos = el?.selectionStart ?? fallbackPos ?? 0;
    setFormulaCaret(pos);
    const anchorEl = source === "cell" ? el : formulaBarWrapRef.current;
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      setFormulaAnchorRect({ left: r.left, bottom: r.bottom, width: r.width });
    }
  };

  const handleAcceptFormulaCompletion = (fnName: string) => {
    if (!editing || formulaInspection.mode !== "complete") return;
    const { nextValue, nextCaret } = applyFormulaCompletion(editing.value, formulaInspection, fnName);
    setEditing({ ...editing, value: nextValue });
    setFormulaCaret(nextCaret);
    setFormulaAutoIdx(0);
    setFormulaDismissed(false);
    requestAnimationFrame(() => {
      const input = editing.source === "cell" ? cellInputRef.current : formulaInputRef.current;
      if (input) {
        input.focus();
        input.setSelectionRange(nextCaret, nextCaret);
      }
    });
  };

  const handleFormulaPopupKeyDown = (e: React.KeyboardEvent): boolean => {
    if (formulaInspection.mode !== "complete") return false;
    const count = formulaInspection.matches.length;
    if (count === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFormulaAutoIdx((i) => (i + 1) % count);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setFormulaAutoIdx((i) => (i - 1 + count) % count);
      return true;
    }
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      const safeIdx = Math.max(0, Math.min(formulaAutoIdx, count - 1));
      handleAcceptFormulaCompletion(formulaInspection.matches[safeIdx].name);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setFormulaDismissed(true);
      return true;
    }
    return false;
  };

  const openColumnFilter = (colIdx: number, rect?: DOMRect) => {
    const measured = rect ?? colHeaderRefs.current.get(colIdx)?.getBoundingClientRect();
    const anchorRect: SheetColumnFilterAnchor = measured
      ? { left: measured.left, top: measured.top, bottom: measured.bottom, right: measured.right, width: measured.width }
      : { left: 100, top: 140, bottom: 164, right: 205, width: 105 };
    setFilterPopover((cur) => (cur?.col === colIdx ? null : { col: colIdx, anchorRect }));
  };

  const handleApplyColumnFilter = (colIdx: number, selectedValues: string[] | null) => {
    if (!activeSheet) return;
    const options = collectColumnFilterOptions(activeSheet, activeEvalMap, colIdx);
    const nextFilter = buildNextColumnFilterConfig(effectiveFilter, colIdx, selectedValues, options.length);
    if (canEdit) {
      setLocalFilterRules(null);
      void handleWorksheetPatch(activeSheet.id, { filter: nextFilter });
    } else {
      setLocalFilterRules(nextFilter.rules ?? {});
    }
  };

  const handleFindReplaceAll = async () => {
    if (!findQuery || !canEdit || !activeSheet) return;
    const edits: { row: number; col: number; raw: string }[] = [];
    for (let r = 0; r < activeSheet.rows.length; r++) {
      for (let c = 0; c < activeSheet.columns.length; c++) {
        const cur = gridMap.cellByKey.get(`${r}:${c}`);
        if (!cur || !cur.raw || !cur.raw.includes(findQuery)) continue;
        edits.push({ row: r, col: c, raw: cur.raw.split(findQuery).join(replaceText) });
      }
    }
    if (!edits.length) {
      setStatusMessage(t("未找到匹配的单元格内容"));
      return;
    }
    const ok = await commitCellEdits(edits);
    if (ok) setStatusMessage(t("已完成全部替换"));
  };

  return (
    <div className={`relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-white text-[#1f2329] ${fullscreen ? "fixed inset-0 z-50" : "h-dvh"}`} data-sheet-page={sheetId}>
      {/* Header matching Feishu spreadsheet chrome */}
      <header className="flex h-14 min-w-0 shrink-0 items-center gap-1.5 border-b border-[#e5e6eb] pl-14 pr-2 sm:gap-2 sm:pr-5 md:pl-4">
        <button type="button" aria-label={t("返回主页")} title={t("返回主页")} onClick={() => go("#/")} className="hidden size-8 shrink-0 place-items-center rounded-md text-[#646a73] hover:bg-[#f2f3f5] sm:grid">
          <Home size={16} />
        </button>
        <SheetColorIcon className="size-5 shrink-0 sm:size-6" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1 text-[13px] text-[#646a73]">
            <span className="hidden truncate sm:inline">{rootLabel}</span>
            {folderCrumbs.map((c) => (
              <span key={c.id} className="hidden items-center gap-1 sm:inline-flex">
                <ChevronRight size={13} className="shrink-0 text-[#bbbfc4]" />
                <button type="button" onClick={() => go(`#/drive/${c.id}`)} className="max-w-28 truncate hover:text-[#3370ff]">{c.title}</button>
              </span>
            ))}
            <ChevronRight size={13} className="hidden shrink-0 text-[#bbbfc4] sm:inline" />
            {editingTitle && canEdit ? (
              <input
                autoFocus
                aria-label={t("工作簿名称")}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void handleRenameWorkbookTitle()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleRenameWorkbookTitle();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                className="h-6 min-w-0 max-w-full flex-1 rounded border border-[#3370ff] px-1.5 text-[14px] font-medium text-[#1f2329] outline-none sm:min-w-28 sm:max-w-64 sm:flex-none"
              />
            ) : (
              <button
                type="button"
                data-sheet-title
                onClick={() => {
                  if (!canEdit) return;
                  setTitleDraft(titleText);
                  setEditingTitle(true);
                }}
                className="min-w-0 truncate rounded px-1 text-left text-[14px] font-medium text-[#1f2329] hover:bg-[#f2f3f5]"
              >
                {titleText}
              </button>
            )}
            <button type="button" aria-label={pinned ? t("取消置顶") : t("置顶")} onClick={() => void togglePin()} className={`grid size-6 shrink-0 place-items-center rounded hover:bg-[#f2f3f5] ${pinned ? "text-[#3370ff]" : "text-[#8f959e]"}`}>
              <Pin size={13} />
            </button>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-[#8f959e]">
            <span data-sheet-save-status className="truncate">{savingCount > 0 ? t("正在保存…") : canEdit ? t("已经保存到云端") : t("只读权限")}</span>
            {formatBrush && <span className="truncate rounded bg-[#edf3ff] px-1.5 text-[#3370ff]">{t("格式刷激活：点击单元格应用样式")}</span>}
          </div>
        </div>

        {collaborators.length > 0 && (
          <div className="hidden items-center -space-x-1.5 sm:flex" aria-label={t("在线协作者")}>
            {collaborators.slice(0, 4).map((c) => <Avatar key={c.userId} name={c.name} color={colorFor(c.userId - 1)} size={24} ring title={c.name} />)}
          </div>
        )}

        <ResourceReferencesButton id={sheetId} userId={userId} title={titleText || t("未命名电子表格")} kind="sheet" />

        <button
          type="button"
          aria-label={t("历史版本")}
          title={t("历史版本")}
          data-sheet-history-btn
          onClick={() => handleTogglePanel("versions")}
          className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-[13px] transition-colors ${
            activePanel === "versions"
              ? "bg-[#e8efff] font-medium text-[#3370ff]"
              : "text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
          }`}
        >
          <History size={15} />
          <span className="hidden md:inline">{t("历史版本")}</span>
        </button>

        <button
          ref={shareBtnRef}
          type="button"
          aria-label={t("分享")}
          title={t("分享")}
          onClick={() => setShareOpen(true)}
          data-sheet-share
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-[#1456f0] px-2.5 text-[13px] font-medium text-white hover:bg-[#0e46cc] sm:px-3"
        >
          <Share2 size={14} />
          <span className="hidden sm:inline">{t("分享")}</span>
        </button>

        {onGlobalSearch && (
          <button type="button" aria-label={t("全局搜索")} onClick={onGlobalSearch} className="hidden size-8 place-items-center rounded-md text-[#646a73] hover:bg-[#f2f3f5] sm:grid">
            <Search size={16} />
          </button>
        )}

        <div ref={moreMenuRef} className="relative shrink-0">
          <button type="button" aria-label={t("更多操作")} aria-expanded={moreMenuOpen} onClick={() => setMoreMenuOpen((v) => !v)} className="grid size-8 place-items-center rounded-md text-[#646a73] hover:bg-[#f2f3f5]">
            <MoreHorizontal size={17} />
          </button>
          {moreMenuOpen && (
            <div role="menu" className="absolute right-0 top-10 z-50 w-44 rounded-md border border-[#dee0e3] bg-white py-1 text-[13px] shadow-lg">
              {canEdit && <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); fileInputRef.current?.click(); }} className="flex h-9 w-full items-center px-3 text-left hover:bg-[#f2f3f5]">{t("导入 XLSX")}</button>}
              {canDownload && <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); handleExportXlsx(); }} className="flex h-9 w-full items-center px-3 text-left hover:bg-[#f2f3f5]">{t("导出 XLSX")}</button>}
              {canDownload && <button type="button" role="menuitem" data-sheet-print-trigger onClick={() => { setMoreMenuOpen(false); setPrintOpen(true); }} className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-[#f2f3f5]"><Printer size={14} />{t("打印 / 导出 PDF")}</button>}
              {canDownload && <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); void handleDuplicate(); }} className="flex h-9 w-full items-center px-3 text-left hover:bg-[#f2f3f5]">{t("创建副本")}</button>}
              <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); handleTogglePanel("versions"); }} className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-[#f2f3f5]"><History size={14} />{t("历史版本")}</button>
              {meta.data.role === "manage" && <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); void handleTrash(); }} className="flex h-9 w-full items-center px-3 text-left text-[#d83931] hover:bg-[#fff2f0]">{t("移至回收站")}</button>}
            </div>
          )}
        </div>

        <span className="hidden shrink-0 sm:inline-flex">
          <Avatar name={me.user.name} color={colorFor(me.user.id - 1)} size={28} title={me.user.name} />
        </span>
      </header>

      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        aria-label={t("选择 XLSX 文件")}
        className="sr-only"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (f) void handleSelectXlsxImport(f);
        }}
      />

      {/* Worksheet Tabs ABOVE Toolbar per Feishu layout */}
      <SheetTabsBar
        sheets={sheets}
        activeSheetId={activeSheet.id}
        canEdit={canEdit}
        fullscreen={fullscreen}
        toolbarCollapsed={toolbarCollapsed}
        onSelectSheet={(id) => {
          setActiveSheetId(id);
          setSelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
        }}
        onCreateSheet={() => void handleCreateSheet()}
        onRenameSheet={(id) => void handleRenameSheet(id)}
        onMoveSheet={(id, pos) => void handleWorksheetPatch(id, { pos })}
        onDeleteSheet={(id) => void handleDeleteSheet(id)}
        onToggleFullscreen={() => setFullscreen((v) => !v)}
        onToggleToolbarCollapsed={() => setToolbarCollapsed(false)}
      />

      {/* Formatting & Data Toolbar */}
      {!toolbarCollapsed && (
      <SheetToolbar
        canEdit={canEdit}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        formatBrushActive={!!formatBrush}
        activeStyle={focusedStyle}
        isMerged={isSelectionMerged}
        filterEnabled={!!activeSheet.filter?.enabled}
        frozenRows={activeSheet.frozenRows}
        frozenCols={activeSheet.frozenCols}
        importing={importing}
        onTriggerImport={() => fileInputRef.current?.click()}
        onExport={canDownload ? handleExportXlsx : undefined}
        onOpenPrint={canDownload ? () => setPrintOpen(true) : undefined}
        onDuplicate={canDownload ? () => void handleDuplicate() : undefined}
        onUndo={() => void runUndoRedo("undo")}
        onRedo={() => void runUndoRedo("redo")}
        onToggleFormatBrush={() => setFormatBrush((cur) => (cur ? null : { ...focusedStyle }))}
        onClearFormat={() => void handleClearFormat()}
        onStylePatch={(p) => void handleStylePatch(p)}
        onToggleBorder={() => void handleToggleBorder()}
        onApplyBorderPreset={(preset, color) => void handleApplyBorderPreset(preset, color)}
        onToggleMerge={() => void handleToggleMerge()}
        onInsertRowAbove={() => void handleAxisOp({ op: "insert_row", index: selection.focus.row, count: 1 })}
        onInsertRowBelow={() => void handleAxisOp({ op: "insert_row", index: selection.focus.row + 1, count: 1 })}
        onInsertColLeft={() => void handleAxisOp({ op: "insert_col", index: selection.focus.col, count: 1 })}
        onInsertColRight={() => void handleAxisOp({ op: "insert_col", index: selection.focus.col + 1, count: 1 })}
        onDeleteRow={() => void handleAxisOp({ op: "delete_row", index: selection.focus.row, count: 1 })}
        onDeleteCol={() => void handleAxisOp({ op: "delete_col", index: selection.focus.col, count: 1 })}
        onFreezeRows={(rows, cols = activeSheet.frozenCols) => void handleWorksheetPatch(activeSheet.id, { frozenRows: rows, frozenCols: cols })}
        onToggleFilter={() => {
          if (activeSheet.filter?.enabled) {
            setFilterPopover(null);
            void handleWorksheetPatch(activeSheet.id, { filter: { enabled: false, headerRow: 0 } });
          } else {
            void handleWorksheetPatch(activeSheet.id, { filter: { enabled: true, headerRow: 0, rules: {} } });
            openColumnFilter(selection.focus.col);
          }
        }}
        onSortCol={(asc) => void handleSort(asc)}
        onOpenFind={() => setFindOpen(true)}
        activePanel={activePanel}
        unresolvedCommentCount={unresolvedCommentCount}
        onTogglePanel={handleTogglePanel}
        onCollapseToolbar={() => setToolbarCollapsed(true)}
      />
      )}

      {/* Name Box + fx + Formula Bar */}
      <div className="relative flex h-[34px] min-w-0 shrink-0 items-center border-b border-[#e5e6eb] bg-white text-[12px] sm:h-[30px]">
        <input
          aria-label={t("单元格名称框")}
          data-sheet-address
          value={nameBoxText}
          onChange={(e) => setNameBoxText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const trimmedName = nameBoxText.trim().toLowerCase();
              const matchedDefined =
                definedNames.find(
                  (d) => d.name.toLowerCase() === trimmedName && d.sheetName?.toLowerCase() === activeSheet.title.toLowerCase(),
                ) ?? definedNames.find((d) => d.name.toLowerCase() === trimmedName && !d.sheetName);
              if (matchedDefined) {
                handleJumpToNamedRange(matchedDefined);
                return;
              }
              const parsed = parseRangeInput(nameBoxText);
              if (parsed) {
                const clamp = (p: SheetPoint) =>
                  normalizePointForMerge(
                    { row: Math.max(0, Math.min(activeSheet.rows.length - 1, p.row)), col: Math.max(0, Math.min(activeSheet.columns.length - 1, p.col)) },
                    mergeLookup,
                  );
                setSelection({ anchor: clamp(parsed.anchor), focus: clamp(parsed.focus) });
                gridRef.current?.focus();
              } else {
                setNameBoxText(formatSelectionAddress(selection));
              }
            }
          }}
          className="h-full w-12 shrink-0 border-r border-[#eef0f3] px-1.5 text-center text-[#4b5058] outline-none focus:bg-[#f5f7ff] sm:w-16 sm:px-2"
        />
        <div className="relative flex shrink-0 items-center">
          <button
            type="button"
            title={t("插入函数")}
            aria-label={t("插入函数")}
            disabled={!canEdit}
            onClick={() => setFxMenuOpen((v) => !v)}
            className="grid h-7 w-7 place-items-center text-[11px] italic text-[#8f959e] hover:bg-[#f2f3f5] hover:text-[#4b5058] disabled:opacity-50"
          >
            fx
          </button>
          {fxMenuOpen && (
            <div role="menu" className="absolute left-0 top-7 z-50 max-h-64 w-64 max-w-[calc(100vw-16px)] overflow-y-auto rounded-md border border-[#dee0e3] bg-white py-1 shadow-lg">
              {FORMULA_QUICK_LIST.map((fn) => (
                <button
                  key={fn.name}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setFxMenuOpen(false);
                    beginEdit(selection.focus, fn.snippet, "formula");
                    const openIdx = fn.snippet.indexOf("(");
                    const caretPos = openIdx >= 0 ? openIdx + 1 : fn.snippet.length;
                    setFormulaCaret(caretPos);
                    requestAnimationFrame(() => {
                      const input = formulaInputRef.current;
                      if (input) {
                        input.focus();
                        input.setSelectionRange(caretPos, caretPos);
                      }
                    });
                  }}
                  className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-[#f2f3f5]"
                >
                  <span className="font-mono text-[12px] font-medium text-[#3370ff]">{fn.snippet}</span>
                  <span className="text-[11px] text-[#8f959e]">{fn.summary}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div ref={formulaBarWrapRef} className="relative flex h-full min-w-0 flex-1 items-center">
          {displayedFormulaValue.startsWith("=") && formulaHighlights.length > 0 && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre pr-3 text-[#1f2329]"
            >
              {splitFormulaSegments(displayedFormulaValue, formulaHighlights).map((seg, idx) => (
                <span key={idx} style={seg.color ? { color: seg.color } : undefined}>{seg.text}</span>
              ))}
            </div>
          )}
          <input
            ref={formulaInputRef}
            aria-label={t("公式编辑栏")}
            data-sheet-formula
            readOnly={!canEdit}
            onCopy={(e) => { if (!canCopy) { e.preventDefault(); setStatusMessage(t("该表格已禁止复制内容")); } }}
            onCut={(e) => { if (!canCopy) { e.preventDefault(); setStatusMessage(t("该表格已禁止复制内容")); } }}
            value={displayedFormulaValue}
            onFocus={(e) => {
              if (canEdit && !editing) {
                beginEdit(selection.focus, focusedCell?.raw ?? "", "formula");
              }
              syncFormulaCaretFromInput(e.currentTarget, "formula", e.currentTarget.value.length);
            }}
            onChange={(e) => {
              const nextVal = e.target.value;
              setFormulaDismissed(false);
              if (!editing) {
                beginEdit(selection.focus, nextVal, "formula");
              } else {
                setEditing({ ...editing, value: nextVal });
              }
              syncFormulaCaretFromInput(e.currentTarget, "formula", nextVal.length);
            }}
            onClick={(e) => syncFormulaCaretFromInput(e.currentTarget, "formula")}
            onSelect={(e) => syncFormulaCaretFromInput(e.currentTarget, "formula")}
            onKeyUp={(e) => syncFormulaCaretFromInput(e.currentTarget, "formula")}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || !editing) return;
              if (handleFormulaPopupKeyDown(e)) return;
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(null);
                gridRef.current?.focus();
              } else if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                void commitActiveEdit().then((ok) => {
                  if (ok) {
                    moveSelection(e.key === "Enter" ? (e.shiftKey ? -1 : 1) : 0, e.key === "Tab" ? (e.shiftKey ? -1 : 1) : 0, false);
                    gridRef.current?.focus();
                  }
                });
              }
            }}
            onBlur={() => {
              if (editing?.source === "formula") {
                void commitActiveEdit();
              }
            }}
            className={`h-full w-full min-w-0 bg-transparent pr-3 outline-none ${
              displayedFormulaValue.startsWith("=") && formulaHighlights.length > 0
                ? "text-transparent caret-[#1f2329]"
                : "text-[#1f2329]"
            }`}
          />
        </div>
      </div>

      {editing && formulaInspection.mode !== "none" && (
        <SheetFormulaBarAutocomplete
          inspection={formulaInspection}
          anchorRect={formulaAnchorRect}
          selectedIndex={formulaAutoIdx}
          onHoverIndex={setFormulaAutoIdx}
          onSelectFunction={handleAcceptFormulaCompletion}
        />
      )}

      <SheetConflictBar
        cellConflicts={cellConflicts}
        mergeConflict={mergeConflict}
        busy={savingCount > 0}
        onResolveCell={(cf, choice) => void handleResolveCellConflicts([cf], choice)}
        onResolveAllCells={(choice) => void handleResolveCellConflicts(cellConflicts, choice)}
        onResolveMerge={(force) => void handleResolveMergeConflict(force)}
      />

      {/* Main Grid Viewport + Optional Right Drawer */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <SheetGpuGridLayer
        scrollContainerRef={gridRef}
        activeSheet={activeSheet}
        visibleRows={visibleRows}
        colWidths={colWidths}
        rowHeights={rowHeights}
        rowHeaderWidth={ROW_HEADER_WIDTH}
        colHeaderHeight={COL_HEADER_HEIGHT}
        zoom={zoom}
        selection={selection}
        gridCellByKey={gridMap.cellByKey}
        activeEvalMap={activeEvalMap}
        formulaHighlights={formulaHighlights}
        collaborators={collaborators}
        userId={userId}
        role={role}
        onBackendReady={(kind) => {
          if (kind === "webgpu" || kind === "webgl2") setGpuActive(true);
        }}
      />
      <div
        ref={gridRef}
        role="grid"
        aria-label={titleText}
        aria-rowcount={activeSheet.rows.length}
        aria-colcount={activeSheet.columns.length}
        tabIndex={0}
        data-sheet-grid
        data-sheet-virtualized={virtualRowWindow.virtualized ? "true" : undefined}
        onScroll={(e) => {
          const nextTop = e.currentTarget.scrollTop;
          if (Math.abs(nextTop - gridScrollTop) >= 1) setGridScrollTop(nextTop);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && dropdownCell) {
            setDropdownCell(null);
            return;
          }
          void handleGridKeyDown(e);
        }}
        onCopy={handleCopy}
        onPaste={(e) => void handlePaste(e)}
        onPointerUp={() => {
          selectingRef.current = false;
          if (fillingRef.current) {
            fillingRef.current = false;
            if (fillTarget) {
              void commitFillHandle(fillTarget);
              setFillTarget(null);
            }
          }
        }}
        className="relative z-[1] min-h-0 min-w-0 flex-1 select-none overflow-auto bg-transparent outline-none"
      >
        <div className="relative w-max min-w-full origin-top-left" style={zoom === 100 ? undefined : { zoom: `${zoom}%` }}>
          {/* Column Headers Row */}
          <div role="row" className="sticky top-0 z-30 flex bg-[#f5f6f7]" style={{ height: COL_HEADER_HEIGHT }}>
            <div
              className="sticky left-0 z-40 shrink-0 border-b border-r border-[#dfe2e6] bg-[#f5f6f7]"
              style={{ width: ROW_HEADER_WIDTH, height: COL_HEADER_HEIGHT }}
              onClick={() => setSelection({ anchor: { row: 0, col: 0 }, focus: { row: activeSheet.rows.length - 1, col: activeSheet.columns.length - 1 } })}
            />
            {activeSheet.columns.map((col, cIdx) => {
              const w = colWidths[cIdx];
              const isFrozenCol = cIdx < activeSheet.frozenCols;
              const activeCol = selection.focus.col === cIdx;
              const colFilterRule = effectiveFilter?.rules?.[String(cIdx)];
              const colFiltered = isColumnFilterActive(colFilterRule);
              const filterOpenHere = filterPopover?.col === cIdx;
              return (
                <div
                  key={col.id}
                  ref={(el) => {
                    if (el) colHeaderRefs.current.set(cIdx, el);
                    else colHeaderRefs.current.delete(cIdx);
                  }}
                  role="columnheader"
                  style={{
                    width: w,
                    height: COL_HEADER_HEIGHT,
                    ...(isFrozenCol ? { position: "sticky", left: colLeftOffsets[cIdx], zIndex: 35 } : {}),
                  }}
                  className={`group/col relative flex shrink-0 items-center justify-center border-b border-r border-[#dfe2e6] text-[11px] ${
                    activeCol
                      ? "bg-[#eaedf1] font-medium text-[#1f2329] shadow-[inset_0_-2px_0_#3370ff]"
                      : "bg-[#f5f6f7] text-[#646a73]"
                  } ${cIdx === activeSheet.frozenCols - 1 ? "border-r-2 border-r-[#9eb7f5]" : ""}`}
                >
                  <span>{columnName(cIdx)}</span>
                  {(activeSheet.filter?.enabled || canEdit) && (
                    <button
                      type="button"
                      data-sheet-col-filter-btn={cIdx}
                      aria-label={t("筛选列 {col}", { col: columnName(cIdx) })}
                      aria-expanded={filterOpenHere}
                      onClick={(e) => {
                        e.stopPropagation();
                        const headerRect = colHeaderRefs.current.get(cIdx)?.getBoundingClientRect() ?? e.currentTarget.getBoundingClientRect();
                        openColumnFilter(cIdx, headerRect);
                      }}
                      className={`absolute right-1.5 grid size-4 place-items-center rounded transition-opacity hover:bg-[#dfe5f5] ${
                        colFiltered || filterOpenHere
                          ? "bg-[#e1eaff] text-[#3370ff] opacity-100"
                          : activeSheet.filter?.enabled
                            ? "text-[#8f959e] opacity-100 hover:text-[#3370ff]"
                            : "text-[#8f959e] opacity-0 group-hover/col:opacity-100 hover:text-[#3370ff]"
                      }`}
                    >
                      <Filter size={10} />
                    </button>
                  )}
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      startResizeCol(cIdx, e.clientX);
                    }}
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[#3370ff]/50"
                  />
                </div>
              );
            })}
          </div>

          {/* Feishu Column Header Value-Checklist Filter Popover */}
          {filterPopover !== null && (() => {
            const hdrRow = Math.max(0, activeSheet.filter?.headerRow ?? 0);
            const headerCell = gridMap.cellByKey.get(`${hdrRow}:${filterPopover.col}`);
            const headerText = formatCellDisplay(headerCell?.raw ?? "", activeEvalMap[`${hdrRow}:${filterPopover.col}`], headerCell?.style).trim();
            const colLabel = headerText ? `${columnName(filterPopover.col)} · ${headerText}` : `${t("列")} ${columnName(filterPopover.col)}`;
            return (
              <SheetColumnFilterPopover
                col={filterPopover.col}
                colLabel={colLabel}
                options={activeFilterOptions}
                activeRule={effectiveFilter?.rules?.[String(filterPopover.col)]}
                anchorRect={filterPopover.anchorRect}
                canSort={canEdit}
                onSort={(asc) => void handleSort(asc, filterPopover.col)}
                onApply={(vals) => handleApplyColumnFilter(filterPopover.col, vals)}
                onClose={() => setFilterPopover(null)}
              />
            );
          })()}

          {/* Visible Rows (Fenwick-virtualized for large sheets; sticky frozen rows stay mounted) */}
          {(() => {
            const renderRow = (rowIdx: number) => {
              const rowAxis = activeSheet.rows[rowIdx];
              const rh = rowHeights[rowIdx];
              const isFrozenRow = rowIdx < activeSheet.frozenRows;
              const b = selectionBounds(selection);
              return (
                <div
                  key={rowAxis.id}
                  role="row"
                  style={{
                    height: rh,
                    ...(isFrozenRow ? { position: "sticky", top: rowTopOffsets[rowIdx], zIndex: 25 } : {}),
                  }}
                  className={`flex ${gpuActive && !isFrozenRow ? "bg-transparent" : "bg-white"} ${rowIdx === activeSheet.frozenRows - 1 ? "relative shadow-[0_2px_0_#9eb7f5]" : ""}`}
              >
                {/* Row Header */}
                <div
                  role="rowheader"
                  style={{ width: ROW_HEADER_WIDTH, height: rh }}
                  className={`sticky left-0 z-20 flex shrink-0 items-center justify-center border-b border-r border-[#dfe2e6] text-[11px] ${
                    selection.focus.row === rowIdx
                      ? "bg-[#eaedf1] font-medium text-[#1f2329] shadow-[inset_-2px_0_0_#3370ff]"
                      : "bg-[#f5f6f7] text-[#8f959e]"
                  }`}
                >
                  <span>{rowIdx + 1}</span>
                  <span
                    role="separator"
                    aria-orientation="horizontal"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      startResizeRow(rowIdx, e.clientY);
                    }}
                    className="absolute bottom-0 left-0 h-1 w-full cursor-row-resize hover:bg-[#3370ff]/50"
                  />
                </div>

                {/* Cells */}
                {activeSheet.columns.map((colAxis, colIdx) => {
                  const cw = colWidths[colIdx];
                  const isFrozenCol = colIdx < activeSheet.frozenCols;
                  const point: SheetPoint = { row: rowIdx, col: colIdx };
                  const key = pointKey(point);
                  const mergeInfo = mergeLookup.get(key);

                  if (mergeInfo?.kind === "covered") {
                    return (
                      <div
                        key={colAxis.id}
                        aria-hidden="true"
                        style={{
                          width: cw,
                          height: rh,
                          ...(isFrozenCol ? { position: "sticky", left: colLeftOffsets[colIdx], zIndex: 12 } : {}),
                        }}
                        onPointerDown={() => {
                          const master = { row: mergeInfo.masterRow, col: mergeInfo.masterCol };
                          if (insertFormulaRefAtClick(master)) return;
                          setSelection({ anchor: master, focus: master });
                          gridRef.current?.focus();
                        }}
                        className="shrink-0"
                      />
                    );
                  }

                  const mergedW = mergeInfo?.kind === "master"
                    ? colWidths.slice(colIdx, colIdx + mergeInfo.colSpan).reduce((acc, x) => acc + x, 0)
                    : cw;
                  const mergedH = mergeInfo?.kind === "master"
                    ? rowHeights.slice(rowIdx, rowIdx + mergeInfo.rowSpan).reduce((acc, x) => acc + x, 0)
                    : rh;

                  const cell = gridMap.cellByKey.get(key);
                  const style = cell?.style ?? {};
                  const ev = activeEvalMap[key];
                  const condStyle = evaluateSheetConditionalFormat(cell?.raw ?? "", ev, activeSheet.conditionalFormats, rowIdx, colIdx);
                  const visualCond = evaluateSheetVisualCondFormat(cell?.raw ?? "", ev, activeSheet.conditionalFormats, rowIdx, colIdx, visualCondBounds);
                  const dropdownRule = canEdit ? findSheetDropdown(activeSheet.validations, rowIdx, colIdx) : null;
                  const valState = evaluateSheetValidation(cell?.raw ?? "", activeSheet.validations, rowIdx, colIdx);
                  const protState = isSheetCellProtected(activeSheet.protectedRanges, rowIdx, colIdx, userId, role);
                  const cellUnresolvedComments = unresolvedCommentsByCellKey.get(key);
                  const isDropdownOpen =
                    dropdownCell?.sheetId === activeSheet.id && dropdownCell.row === rowIdx && dropdownCell.col === colIdx;
                  const isSel = selected(selection, point);
                  const isFocus = selection.focus.row === rowIdx && selection.focus.col === colIdx;
                  const isEditingCell = editing?.sheetId === activeSheet.id && editing.source === "cell" && editing.point.row === rowIdx && editing.point.col === colIdx;
                  const refHighlight = formulaHighlights.find((h) => rowIdx >= h.top && rowIdx <= h.bottom && colIdx >= h.left && colIdx <= h.right);
                  const remoteMatches = collaborators
                    .filter((c) => c.worksheetId === activeSheet.id)
                    .map((c) => ({ collab: c, bounds: remoteCollaboratorBounds(c) }))
                    .filter(({ bounds: rb }) => rowIdx >= rb.top && rowIdx <= rb.bottom && colIdx >= rb.left && colIdx <= rb.right);
                  const primaryRemote = remoteMatches[0] ?? null;
                  const remoteBadgeOwner = remoteMatches.find(({ bounds: rb }) => rowIdx === rb.top && colIdx === rb.left) ?? null;

                  const remoteEdges: string[] = [];
                  for (const { collab: rc, bounds: rb } of remoteMatches) {
                    const rcColor = colorFor(rc.userId - 1);
                    if (rowIdx === rb.top) remoteEdges.push(`inset 0 2px ${rcColor}`);
                    if (rowIdx === rb.bottom) remoteEdges.push(`inset 0 -2px ${rcColor}`);
                    if (colIdx === rb.left) remoteEdges.push(`inset 2px 0 ${rcColor}`);
                    if (colIdx === rb.right) remoteEdges.push(`inset -2px 0 ${rcColor}`);
                  }
                  const selShadow = selectionOutline(selection, point);
                  const combinedShadow = [selShadow, ...remoteEdges].filter(Boolean).join(", ") || undefined;

                  const displayValue = formatCellDisplay(cell?.raw ?? "", ev, style);
                  const alignClass = style.align === "center"
                    ? "text-center"
                    : style.align === "right" || (!style.align && ev?.kind === "number")
                      ? "text-right"
                      : "text-left";
                  const showFillHandle = canEdit && !editing && rowIdx === b.bottom && colIdx === b.right;

                  const effectiveBg = condStyle?.bg || style.bg;
                  const effectiveColor = condStyle?.color || style.color || "#1f2329";
                  const effectiveBold = !!(condStyle?.bold || style.bold);

                  const cellBg = refHighlight
                    ? `${refHighlight.color}12`
                    : isSel && !isFocus
                      ? "#edf3ff"
                      : primaryRemote && !effectiveBg
                        ? `${colorFor(primaryRemote.collab.userId - 1)}14`
                        : effectiveBg || (protState.blocked ? "#fafbfc" : "#ffffff");

                  const gpuCell = gpuActive && !isEditingCell && !isFrozenRow && !isFrozenCol && mergeInfo?.kind !== "master";
                  return (
                    <div
                      key={colAxis.id}
                      role="gridcell"
                      aria-label={sheetAddress(point)}
                      aria-selected={isSel}
                      data-sheet-cell={key}
                      data-sheet-cond-bg={condStyle?.bg || visualCond?.colorScaleBg || undefined}
                      data-sheet-protected={protState.protected ? (protState.blocked ? "blocked" : "allowed") : undefined}
                      style={{
                        width: cw,
                        height: rh,
                        ...(isFrozenCol ? { position: "sticky", left: colLeftOffsets[colIdx], zIndex: 15 } : {}),
                      }}
                      className={`relative shrink-0 ${colIdx === activeSheet.frozenCols - 1 ? "border-r-2 border-r-[#9eb7f5]" : ""}`}
                    >
                      <div
                        style={{
                          width: mergedW,
                          height: mergedH,
                          backgroundColor: gpuCell ? "transparent" : cellBg,
                          color: effectiveColor,
                          fontFamily: style.fontFamily || undefined,
                          fontSize: style.fontSize ? `${style.fontSize}px` : "12px",
                          fontWeight: effectiveBold ? 600 : undefined,
                          fontStyle: style.italic ? "italic" : undefined,
                          textDecoration: [style.underline ? "underline" : "", style.strike ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
                          boxShadow: gpuCell ? undefined : combinedShadow,
                          borderTop: !gpuCell && style.borders?.top ? `1px solid ${style.borders.color || "#9aa0a6"}` : undefined,
                          borderRight: !gpuCell && style.borders?.right ? `1px solid ${style.borders.color || "#9aa0a6"}` : undefined,
                          borderBottom: !gpuCell && style.borders?.bottom ? `1px solid ${style.borders.color || "#9aa0a6"}` : undefined,
                          borderLeft: !gpuCell && style.borders?.left ? `1px solid ${style.borders.color || "#9aa0a6"}` : undefined,
                          zIndex: isDropdownOpen ? 30 : mergeInfo?.kind === "master" ? 3 : isFocus ? 2 : refHighlight || primaryRemote ? 1 : undefined,
                        }}
                        onPointerDown={(e) => {
                          if (e.button !== 0 || isEditingCell) return;
                          setDropdownCell(null);
                          setSelectedChartId(null);
                          if (insertFormulaRefAtClick(point)) {
                            e.preventDefault();
                            return;
                          }
                          if (e.pointerType !== "touch") e.preventDefault();
                          if (editing) {
                            void commitActiveEdit();
                          }
                          if (formatBrush && canEdit) {
                            const brush = formatBrush;
                            setFormatBrush(null);
                            void commitCellEdits([{ row: rowIdx, col: colIdx, style: brush }]);
                            setSelection({ anchor: point, focus: point });
                            gridRef.current?.focus();
                            return;
                          }
                          setStatusMessage("");
                          selectingRef.current = true;
                          setSelection(e.shiftKey ? { ...selection, focus: point } : { anchor: point, focus: point });
                          gridRef.current?.focus({ preventScroll: true });
                        }}
                        onPointerEnter={(e) => {
                          if (fillingRef.current) {
                            setFillTarget(point);
                          } else if (selectingRef.current && e.buttons) {
                            setSelection((cur) => ({ ...cur, focus: point }));
                          }
                        }}
                        onDoubleClick={() => {
                          if (canEdit) beginEdit(point, undefined, "cell");
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!selected(selection, point)) {
                            setSelection({ anchor: point, focus: point });
                          }
                          const menuW = 208;
                          const menuH = 264;
                          const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
                          const vh = typeof window !== "undefined" ? window.innerHeight : 800;
                          setCellContextMenu({
                            x: Math.max(8, Math.min(e.clientX, vw - menuW - 8)),
                            y: Math.max(8, Math.min(e.clientY, vh - menuH - 8)),
                            row: rowIdx,
                            col: colIdx,
                          });
                        }}
                        className={`absolute left-0 top-0 flex items-center border-b border-r px-1.5 ${
                          gpuCell ? "border-transparent" : "border-[#e8e9eb]"
                        } ${
                          !gpuCell && isFocus ? "outline outline-2 -outline-offset-2 outline-[#3370ff]" : ""
                        }`}
                      >
                        {!gpuCell && refHighlight && (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-0"
                            style={{
                              borderTop: rowIdx === refHighlight.top ? `1.5px dashed ${refHighlight.color}` : undefined,
                              borderBottom: rowIdx === refHighlight.bottom ? `1.5px dashed ${refHighlight.color}` : undefined,
                              borderLeft: colIdx === refHighlight.left ? `1.5px dashed ${refHighlight.color}` : undefined,
                              borderRight: colIdx === refHighlight.right ? `1.5px dashed ${refHighlight.color}` : undefined,
                            }}
                          />
                        )}
                        {visualCond?.colorScaleBg && !isEditingCell && !(isSel && !isFocus) && !refHighlight && (
                          <span
                            aria-hidden="true"
                            data-sheet-cond-colorscale={visualCond.colorScaleBg}
                            className={`pointer-events-none absolute z-0 ${isFocus ? "inset-[2px]" : "inset-[1px]"}`}
                            style={{ backgroundColor: visualCond.colorScaleBg }}
                          />
                        )}
                        {visualCond?.dataBar && visualCond.dataBar.percent > 0 && !isEditingCell && (
                          <span
                            aria-hidden="true"
                            data-sheet-cond-databar={String(visualCond.dataBar.percent)}
                            className="pointer-events-none absolute bottom-[3px] left-[2px] top-[3px] z-0 rounded-[2px]"
                            style={{
                              width: `calc(${visualCond.dataBar.percent}% - 4px)`,
                              backgroundColor: visualCond.dataBar.fillColor,
                              borderLeft: `2px solid ${visualCond.dataBar.barColor}`,
                            }}
                          />
                        )}
                        {isEditingCell ? (
                          <input
                            ref={cellInputRef}
                            aria-label={t("编辑 {addr}", { addr: sheetAddress(point) })}
                            value={editing.value}
                            onCopy={(evCopy) => { if (!canCopy) { evCopy.preventDefault(); setStatusMessage(t("该表格已禁止复制内容")); } }}
                            onCut={(evCut) => { if (!canCopy) { evCut.preventDefault(); setStatusMessage(t("该表格已禁止复制内容")); } }}
                            onChange={(evChange) => {
                              setFormulaDismissed(false);
                              setEditing({ ...editing, value: evChange.target.value });
                              syncFormulaCaretFromInput(evChange.currentTarget, "cell", evChange.target.value.length);
                            }}
                            onClick={(evClick) => syncFormulaCaretFromInput(evClick.currentTarget, "cell")}
                            onSelect={(evSel) => syncFormulaCaretFromInput(evSel.currentTarget, "cell")}
                            onKeyUp={(evUp) => syncFormulaCaretFromInput(evUp.currentTarget, "cell")}
                            onKeyDown={(evKey) => {
                              evKey.stopPropagation();
                              if (evKey.nativeEvent.isComposing) return;
                              if (handleFormulaPopupKeyDown(evKey)) return;
                              if (evKey.key === "Escape") {
                                evKey.preventDefault();
                                setEditing(null);
                                gridRef.current?.focus();
                              } else if (evKey.key === "Enter" || evKey.key === "Tab") {
                                evKey.preventDefault();
                                void commitActiveEdit().then((ok) => {
                                  if (ok) {
                                    moveSelection(evKey.key === "Enter" ? (evKey.shiftKey ? -1 : 1) : 0, evKey.key === "Tab" ? (evKey.shiftKey ? -1 : 1) : 0, false);
                                    gridRef.current?.focus();
                                  }
                                });
                              }
                            }}
                            onBlur={() => {
                              if (editing?.source === "cell") void commitActiveEdit();
                            }}
                            className="absolute inset-0 z-[2] h-full w-full select-text border-2 border-[#3370ff] bg-white px-1 text-[12px] text-[#1f2329] outline-none"
                          />
                        ) : (
                          <span
                            className={`relative z-[1] block w-full ${dropdownRule && !protState.blocked ? "pr-4" : ""} ${style.wrap ? "whitespace-normal break-words leading-tight" : "truncate"} ${alignClass} ${ev?.kind === "error" ? "text-[#d83931]" : ""}`}
                          >
                            {displayValue}
                          </span>
                        )}
                        {!valState.valid && !isEditingCell && (
                          <span
                            data-sheet-cell-invalid={key}
                            title={valState.message}
                            className="pointer-events-none absolute left-0 top-0 z-10 size-0 border-r-[7px] border-t-[7px] border-r-transparent border-t-[#d83931]"
                          />
                        )}
                        {protState.protected && isFocus && !isEditingCell && (
                          <span
                            data-sheet-cell-lock={key}
                            title={protState.rule?.description || t("受保护区域")}
                            className="pointer-events-none absolute left-0.5 top-0.5 z-10 text-[#d46b08]/80"
                          >
                            <Lock size={9} />
                          </span>
                        )}
                        {cellUnresolvedComments && cellUnresolvedComments.length > 0 && !isEditingCell && (
                          <button
                            type="button"
                            title={t("{count} 条单元格评论", { count: cellUnresolvedComments.length })}
                            aria-label={t("查看 {addr} 评论", { addr: sheetAddress(point) })}
                            data-sheet-cell-comment-badge={key}
                            onPointerDown={(evBtn) => evBtn.stopPropagation()}
                            onClick={(evBtn) => {
                              evBtn.stopPropagation();
                              setSelection({ anchor: point, focus: point });
                              setActivePanel("comments");
                            }}
                            className="absolute right-0 top-0 z-10 size-0 border-l-[8px] border-t-[8px] border-l-transparent border-t-[#ff8800]"
                          />
                        )}
                        {dropdownRule && !protState.blocked && !isEditingCell && (
                          <>
                            <button
                              type="button"
                              aria-label={t("选择下拉选项")}
                              data-sheet-cell-dropdown-btn={key}
                              onPointerDown={(evBtn) => evBtn.stopPropagation()}
                              onClick={(evBtn) => {
                                evBtn.stopPropagation();
                                setSelection({ anchor: point, focus: point });
                                setDropdownCell((cur) =>
                                  cur && cur.sheetId === activeSheet.id && cur.row === rowIdx && cur.col === colIdx
                                    ? null
                                    : { sheetId: activeSheet.id, row: rowIdx, col: colIdx },
                                );
                              }}
                              className={`absolute right-1 top-1/2 z-10 grid size-4 -translate-y-1/2 place-items-center rounded text-[10px] text-[#646a73] hover:bg-[#e1eaff] hover:text-[#3370ff] ${isFocus || isDropdownOpen ? "opacity-100" : "opacity-60"}`}
                            >
                              ▾
                            </button>
                            {isDropdownOpen && (
                              <div
                                role="listbox"
                                data-sheet-dropdown-menu={key}
                                onPointerDown={(evMenu) => evMenu.stopPropagation()}
                                className="absolute left-0 top-full z-50 mt-0.5 max-h-48 min-w-[120px] overflow-y-auto rounded-md border border-[#dee0e3] bg-white py-1 shadow-lg"
                              >
                                {(dropdownRule.options ?? []).map((opt) => (
                                  <button
                                    key={opt}
                                    type="button"
                                    role="option"
                                    aria-selected={(cell?.raw ?? "") === opt}
                                    data-sheet-dropdown-option={opt}
                                    onClick={() => {
                                      setDropdownCell(null);
                                      void commitCellEdits([{ row: rowIdx, col: colIdx, raw: opt }]);
                                    }}
                                    className={`flex h-7 w-full items-center px-2.5 text-left text-[12px] hover:bg-[#f2f3f5] ${(cell?.raw ?? "") === opt ? "bg-[#eef3ff] font-medium text-[#3370ff]" : "text-[#1f2329]"}`}
                                  >
                                    <span className="truncate">{opt}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                        {remoteBadgeOwner && (
                          <span
                            data-remote-collab-badge={remoteBadgeOwner.collab.userId}
                            data-remote-collab-editing={remoteBadgeOwner.collab.editing ? "true" : undefined}
                            className="pointer-events-none absolute -top-4 left-0 z-30 whitespace-nowrap rounded px-1 text-[10px] text-white"
                            style={{ backgroundColor: colorFor(remoteBadgeOwner.collab.userId - 1) }}
                          >
                            {remoteBadgeOwner.collab.editing
                              ? `${remoteBadgeOwner.collab.name} · ${t("编辑中")}`
                              : remoteBadgeOwner.collab.name}
                          </span>
                        )}
                        {showFillHandle && (
                          <span
                            data-sheet-fill-handle
                            title={t("向下或向右拖拽填充")}
                            onPointerDown={(evHandle) => {
                              evHandle.stopPropagation();
                              evHandle.preventDefault();
                              fillingRef.current = true;
                              setFillTarget(point);
                            }}
                            className="absolute -bottom-[3px] -right-[3px] z-20 size-2 cursor-crosshair border border-white bg-[#3370ff]"
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
                </div>
              );
            };
            return (
              <>
                {virtualRowWindow.frozen.map(renderRow)}
                {virtualRowWindow.topSpacer > 0 && (
                  <div aria-hidden="true" data-sheet-virtual-spacer="top" style={{ height: virtualRowWindow.topSpacer }} />
                )}
                {virtualRowWindow.virtual.map(renderRow)}
                {virtualRowWindow.bottomSpacer > 0 && (
                  <div aria-hidden="true" data-sheet-virtual-spacer="bottom" style={{ height: virtualRowWindow.bottomSpacer }} />
                )}
              </>
            );
          })()}
          <SheetChartOverlay
            sheet={activeSheet}
            evalMap={activeEvalMap}
            canEdit={canEdit}
            selectedChartId={selectedChartId}
            onSelectChart={(chart) => setSelectedChartId(chart.id)}
            onEditChart={(chart) => {
              setSelectedChartId(chart.id);
              setActivePanel("charts");
            }}
            onUpdateChart={(updated) => {
              const cur = activeSheet.charts ?? [];
              void handleUpdateCharts(cur.map((c) => (c.id === updated.id ? updated : c)));
            }}
            onDeleteChart={(chartId) => {
              const cur = activeSheet.charts ?? [];
              if (selectedChartId === chartId) setSelectedChartId(null);
              void handleUpdateCharts(cur.filter((c) => c.id !== chartId));
            }}
          />
        </div>
      </div>
      </div>

      {activePanel && (
        <>
          <div className="fixed inset-0 z-30 bg-black/25 md:hidden" aria-hidden="true" onClick={() => setActivePanel(null)} />
          <div
            data-sheet-panel-overlay
            className={`fixed inset-y-0 right-0 z-40 flex w-[min(100vw,360px)] shadow-xl md:static md:z-auto md:w-auto md:shrink-0 md:shadow-none [&>aside]:static [&>aside]:w-full [&>aside]:shadow-none ${
              activePanel === "pivot" ? "md:[&>aside]:w-[400px]" : "md:[&>aside]:w-80"
            }`}
          >
            <SheetSidePanel
              sheetId={sheetId}
              mode={activePanel}
              onChangeMode={setActivePanel}
              onClose={() => setActivePanel(null)}
              sheets={sheets}
              activeSheet={activeSheet}
              evaluatedWorkbook={evaluatedWorkbook}
              selectionBoundsRect={selectionBounds(selection)}
              focusedPoint={selection.focus}
              userId={userId}
              role={role}
              canEdit={canEdit}
              canComment={canComment}
              comments={allComments}
              rowPosById={gridMap.rowPosById}
              colPosById={gridMap.colPosById}
              shareMembers={sharesQuery.data?.members ?? []}
              editingChartId={selectedChartId}
              onSelectEditingChart={setSelectedChartId}
              onSelectRange={(rect) => {
                setSelection({ anchor: { row: rect.top, col: rect.left }, focus: { row: rect.bottom, col: rect.right } });
              }}
              onUpdateValidations={handleUpdateValidations}
              onUpdateCondFormats={handleUpdateCondFormats}
              onUpdateProtectedRanges={handleUpdateProtectedRanges}
              onUpdateCharts={handleUpdateCharts}
              onUpdatePivotTables={handleUpdatePivotTables}
              onMaterializePivot={handleMaterializePivot}
              onCreateComment={handleCreateComment}
              onToggleResolveComment={handleToggleResolveComment}
              onDeleteComment={handleDeleteComment}
              definedNames={definedNames}
              onUpdateDefinedNames={handleUpdateDefinedNames}
              onJumpToNamedRange={handleJumpToNamedRange}
              onVersionRestored={handleVersionRestored}
              onVersionSaved={(v) => setStatusMessage(t("已保存版本「{label}」", { label: v.label }))}
            />
          </div>
        </>
      )}
      </div>

      {/* Empty-sheet Floating Feishu Template Gallery */}
      {canEdit && !hasAnyContent && !templateHidden && (() => {
        const q = templateQuery.trim().toLowerCase();
        const filteredTemplates = q
          ? SHEET_STARTER_TEMPLATES.filter((tpl) => t(tpl.name).toLowerCase().includes(q) || t(tpl.tag).toLowerCase().includes(q))
          : SHEET_STARTER_TEMPLATES;
        return (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-12 z-20 flex justify-center px-3 sm:px-4"
            data-sheet-templates
          >
            <div className="pointer-events-auto max-h-[55dvh] w-full max-w-[660px] overflow-y-auto rounded-xl bg-white/95 p-3 shadow-sm backdrop-blur-[2px] sm:max-h-none sm:overflow-visible sm:bg-white/90 sm:shadow-none">
              <div className="mb-3 flex items-center justify-between gap-2 sm:gap-3">
                <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[#dee0e3] bg-white px-2.5 text-[12px] text-[#8f959e] focus-within:border-[#3370ff] sm:w-64 sm:flex-none">
                  <Search size={13} className="shrink-0" />
                  <input
                    value={templateQuery}
                    onChange={(e) => setTemplateQuery(e.target.value)}
                    placeholder={t("输入关键词搜索模板")}
                    aria-label={t("输入关键词搜索模板")}
                    className="w-full bg-transparent text-[#1f2329] outline-none placeholder:text-[#8f959e]"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setTemplateHidden(true)}
                  className="shrink-0 rounded px-2 py-1 text-[12px] text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
                >
                  {t("隐藏")}
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {filteredTemplates.map((tpl, idx) => {
                  const accent = idx === 0 ? "#4e83fd" : idx === 1 ? "#f7b500" : "#34c759";
                  const headers = tpl.cells.filter((c) => c.row === 0).slice(0, 3);
                  const previewRows = [1, 2, 3];
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => void handleApplyTemplate(tpl)}
                      className="group flex flex-col rounded-xl border border-[#e5e6eb] bg-white p-3 text-left shadow-[0_4px_16px_rgba(31,35,41,0.06)] transition-all hover:-translate-y-0.5 hover:border-[#3370ff] hover:shadow-[0_6px_20px_rgba(51,112,255,0.12)]"
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium text-[#1f2329] group-hover:text-[#3370ff]">{t(tpl.name)}</span>
                        <span className="shrink-0 rounded bg-[#f2f3f5] px-1.5 py-0.5 text-[10px] text-[#646a73]">{t(tpl.tag)}</span>
                      </div>
                      <div className="overflow-hidden rounded-md border border-[#eceef2] bg-[#fafbfc]">
                        <div className="grid grid-cols-3 gap-px px-1.5 py-1 text-[8px] font-medium text-white" style={{ backgroundColor: accent }}>
                          {headers.map((h, hi) => (
                            <span key={hi} className="truncate">{h.raw}</span>
                          ))}
                        </div>
                        {previewRows.map((r) => (
                          <div key={r} className="grid grid-cols-3 gap-1 border-t border-[#eff0f1] bg-white px-1.5 py-1">
                            {[0, 1, 2].map((c) => (
                              <span
                                key={c}
                                className="h-1.5 rounded-full"
                                style={{
                                  width: c === 0 ? "85%" : c === 1 ? "62%" : "70%",
                                  backgroundColor: r === 1 && c === 0 ? "#d0d7e2" : "#e5e6eb",
                                }}
                              />
                            ))}
                          </div>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Bottom Status & Aggregation Bar */}
      <footer className="flex h-8 shrink-0 items-center justify-between gap-2 border-t border-[#e5e6eb] bg-white px-3 text-[11px] text-[#646a73]">
        <span role={errorMessage ? "alert" : undefined} className={`min-w-0 truncate ${errorMessage ? "text-[#d83931]" : statusMessage ? "text-[#3370ff]" : ""}`}>
          {errorMessage || statusMessage || `${activeSheet.title} · ${activeSheet.rows.length}×${activeSheet.columns.length}`}
        </span>
        <div className="flex shrink-0 items-center gap-3">
          {selectionSummary && <SheetSelectionStatsBar stats={selectionSummary} />}
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setZoom((z) => Math.max(75, z - 25))} className="px-1 hover:text-[#1f2329]">-</button>
            <span>{zoom}%</span>
            <button type="button" onClick={() => setZoom((z) => Math.min(150, z + 25))} className="px-1 hover:text-[#1f2329]">+</button>
          </div>
        </div>
      </footer>

      {/* Find & Replace Dialog */}
      {findOpen && (
        <div className="fixed right-2 top-28 z-50 w-[min(18rem,calc(100vw-16px))] rounded-lg border border-[#dee0e3] bg-white p-3.5 shadow-xl sm:right-6 sm:top-36 sm:w-72" role="dialog" aria-label={t("查找和替换")}>
          <div className="flex items-center justify-between text-[13px] font-medium">
            <span>{t("查找和替换")}</span>
            <button type="button" onClick={() => setFindOpen(false)}><X size={15} /></button>
          </div>
          <div className="mt-2.5 grid gap-2">
            <input
              autoFocus
              placeholder={t("查找内容")}
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              className="h-8 rounded border px-2 text-[12px] outline-none focus:border-[#3370ff]"
            />
            {canEdit && (
              <input
                placeholder={t("替换为")}
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                className="h-8 rounded border px-2 text-[12px] outline-none focus:border-[#3370ff]"
              />
            )}
          </div>
          <div className="mt-3 flex justify-end gap-2 text-[12px]">
            <button
              type="button"
              onClick={() => {
                if (!findQuery) return;
                for (let r = 0; r < activeSheet.rows.length; r++) {
                  for (let c = 0; c < activeSheet.columns.length; c++) {
                    if ((gridMap.cellByKey.get(`${r}:${c}`)?.raw ?? "").includes(findQuery)) {
                      setSelection({ anchor: { row: r, col: c }, focus: { row: r, col: c } });
                      return;
                    }
                  }
                }
                setStatusMessage(t("未找到匹配的单元格内容"));
              }}
              className="rounded border px-2.5 py-1 hover:bg-[#f2f3f5]"
            >
              {t("查找下一个")}
            </button>
            {canEdit && (
              <button type="button" onClick={() => void handleFindReplaceAll()} className="rounded bg-[#3370ff] px-2.5 py-1 text-white">
                {t("全部替换")}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Multi-sheet XLSX Import Preview Dialog */}
      {pendingImport && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="sheet-import-confirm-title" className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h2 id="sheet-import-confirm-title" className="text-[16px] font-semibold">{t("确认导入 XLSX 到当前工作簿")}</h2>
            <p className="mt-2 break-all text-[13px] text-[#646a73]">{pendingImport.filename}</p>
            <p className="mt-2 text-[13px] text-[#1f2329]">
              {t("共解析 {sheets} 个工作表、{cells} 个非空单元格，导入将替换当前工作簿全部工作表并自动保存。", {
                sheets: pendingImport.sheets.sheets.length,
                cells: pendingImport.sheets.cellCount,
              })}
            </p>
            {pendingImport.sheets.warnings.length > 0 && (
              <div className="mt-3 rounded bg-[#fff7e6] p-2.5 text-[12px] text-[#8a5a00]">
                {pendingImport.sheets.warnings.map((w) => <p key={w}>{w}</p>)}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setPendingImport(null)} className="rounded border px-3 py-1.5 text-[13px]">{t("取消")}</button>
              <button type="button" onClick={() => void handleConfirmXlsxImport()} className="rounded bg-[#3370ff] px-3 py-1.5 text-[13px] text-white">{t("确认导入")}</button>
            </div>
          </section>
        </div>
      )}

      {cellContextMenu && typeof document !== "undefined" && createPortal(
        <div
          ref={cellContextMenuRef}
          role="menu"
          data-sheet-cell-context-menu
          style={{ left: cellContextMenu.x, top: cellContextMenu.y }}
          className="fixed z-[130] w-52 rounded-lg border border-[#dee0e3] bg-white py-1 text-[13px] text-[#1f2329] shadow-[0_8px_28px_rgba(31,35,41,0.16)]"
        >
          <button
            type="button"
            role="menuitem"
            data-ctx-cell-history
            onClick={() => {
              const target = { row: cellContextMenu.row, col: cellContextMenu.col };
              setCellContextMenu(null);
              setSelection({ anchor: target, focus: target });
              setActivePanel("cell-history");
            }}
            className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-[#f2f3f5]"
          >
            <Clock size={14} className="text-[#3370ff]" />
            <span>{t("查看单元格修改记录")}</span>
          </button>
          {canComment && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const target = { row: cellContextMenu.row, col: cellContextMenu.col };
                setCellContextMenu(null);
                setSelection({ anchor: target, focus: target });
                setActivePanel("comments");
              }}
              className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-[#f2f3f5]"
            >
              <MessageSquare size={14} className="text-[#646a73]" />
              <span>{t("添加单元格评论")}</span>
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setCellContextMenu(null);
                setActivePanel("names");
              }}
              className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-[#f2f3f5]"
            >
              <Tag size={14} className="text-[#646a73]" />
              <span>{t("定义名称")}</span>
            </button>
          )}
          {canEdit && (
            <>
              <div className="my-1 border-t border-[#eceef2]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const row = cellContextMenu.row;
                  setCellContextMenu(null);
                  void handleAxisOp({ op: "insert_row", index: row, count: 1 });
                }}
                className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-[#f2f3f5]"
              >
                <Rows3 size={14} className="text-[#646a73]" />
                <span>{t("上方插入行")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const row = cellContextMenu.row;
                  setCellContextMenu(null);
                  void handleAxisOp({ op: "insert_row", index: row + 1, count: 1 });
                }}
                className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-[#f2f3f5]"
              >
                <Rows3 size={14} className="text-[#646a73]" />
                <span>{t("下方插入行")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const col = cellContextMenu.col;
                  setCellContextMenu(null);
                  void handleAxisOp({ op: "insert_col", index: col, count: 1 });
                }}
                className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-[#f2f3f5]"
              >
                <Columns3 size={14} className="text-[#646a73]" />
                <span>{t("左侧插入列")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const col = cellContextMenu.col;
                  setCellContextMenu(null);
                  void handleAxisOp({ op: "insert_col", index: col + 1, count: 1 });
                }}
                className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-[#f2f3f5]"
              >
                <Columns3 size={14} className="text-[#646a73]" />
                <span>{t("右侧插入列")}</span>
              </button>
              <div className="my-1 border-t border-[#eceef2]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setCellContextMenu(null);
                  void handleClearSelectedCells();
                }}
                className="flex h-8 w-full items-center gap-2 px-3 text-left text-[#d83931] hover:bg-[#fff2f0]"
              >
                <Eraser size={14} />
                <span>{t("清除内容")}</span>
              </button>
            </>
          )}
        </div>,
        document.body,
      )}

      {printOpen && activeSheet && (
        <SheetPrintDialog
          workbookTitle={titleText}
          sheet={activeSheet}
          evalMap={activeEvalMap}
          selectionRect={selectionBounds(selection)}
          onClose={() => setPrintOpen(false)}
        />
      )}

      {shareOpen && meta.data && (
        <ShareDialog meta={meta.data as DocMeta} userId={userId} anchorRef={shareBtnRef} onClose={() => setShareOpen(false)} />
      )}
      <DocumentWatermark
        workspaceId={meta.data?.workspaceId}
        userName={me.user.name}
        userEmail={me.user.email}
        copyProtected={!!meta.data?.copyProtected}
      />
    </div>
  );
}
