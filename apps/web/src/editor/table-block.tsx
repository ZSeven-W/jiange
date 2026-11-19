import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlignCenter, AlignCenterHorizontal, AlignEndHorizontal, AlignLeft, AlignRight, AlignStartHorizontal, Bold, Code, Columns3, Combine, Copy, Eraser, Italic, LayoutGrid, PaintBucket, Palette, Plus, Rows3, SquareSplitHorizontal, Strikethrough, Trash2, Underline, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseTableData } from "./model";
import { applyTableOp, canMove, coverMap, expandRange, mergeCells, normRange, parseMerges, planSelectionDelete, planTableAxisDelete, planTableReorder, remapWidths, splitCell, type CellRange, type Merge, type TableOp, type Widths } from "./table-ops";
import { formatTableTSV } from "./table-clipboard";
import { parseTableRichHTML, tableRichHTML, type RichTableClipboard } from "./table-rich-clipboard";
import { parseExternalTableHTML } from "./table-external-clipboard";
import { tableTabIntent } from "./table-keyboard";
import { tableSelectionScrollSpeed, tableVerticalScrollParent } from "./table-selection-scroll";
import { useTableStickyHeader } from "./table-sticky-header";
import { equalizedTableWidths, visibleTableWidths } from "./table-widths";
import { snapTableWidth, type TableWidthSnapCandidate } from "./table-width-snap";
import { tableCellAlign, tableCellFill, tableCellHasMark, tableCellHasRichMarks, tableCellRich, type TableAlign, type TableAlignAxis, type TableCellMarkKey } from "./table-cells";
import { renderTableRichSpans } from "./table-rich-render";
import { tableFormatCells, type TableFormatTarget } from "./table-fill";

type GripSel = { kind: "row" | "col"; index: number };
type AxisSelection = { kind: "row" | "col"; indices: number[] };
type ReorderGuide = { left: number; top: number; width: number; height: number; valid: boolean };
export type TableResizeSession = { commit: (widths: number[]) => void | Promise<void>; cancel: () => void };
export type TableReorderOp = Extract<TableOp, { kind: "reorderRows" | "reorderCols" }>;
export type TableReorderSession = { commit: (op: TableReorderOp) => string | null; cancel: () => void };

/** 行/列菜单项（飞书：上方/下方插入行、左侧/右侧插入列、删除、清空）。 */
export function gripMenu(sel: GripSel, rows: number, cols: number, cells: string[][] = [], merges: Merge[] = []): { label: string; op: TableOp; danger?: boolean; disabled?: boolean }[] {
  return sel.kind === "row" ? [
    { label: "在上方插入行", op: { kind: "insertRow", at: sel.index } },
    { label: "在下方插入行", op: { kind: "insertRow", at: sel.index + 1 } },
    { label: "上移一行", op: { kind: "moveRow", index: sel.index, to: sel.index - 1 }, disabled: !canMove(cells.length ? cells : Array.from({ length: rows }, () => []), merges, { kind: "moveRow", index: sel.index, to: sel.index - 1 }) },
    { label: "下移一行", op: { kind: "moveRow", index: sel.index, to: sel.index + 1 }, disabled: !canMove(cells.length ? cells : Array.from({ length: rows }, () => []), merges, { kind: "moveRow", index: sel.index, to: sel.index + 1 }) },
    { label: "清空本行", op: { kind: "clearRow", index: sel.index } },
    { label: "删除本行", op: { kind: "deleteRow", index: sel.index }, danger: true, disabled: rows <= 1 },
  ] : [
    { label: "在左侧插入列", op: { kind: "insertCol", at: sel.index } },
    { label: "在右侧插入列", op: { kind: "insertCol", at: sel.index + 1 } },
    { label: "左移一列", op: { kind: "moveCol", index: sel.index, to: sel.index - 1 }, disabled: !canMove(cells.length ? cells : [Array.from({ length: cols }, () => "")], merges, { kind: "moveCol", index: sel.index, to: sel.index - 1 }) },
    { label: "右移一列", op: { kind: "moveCol", index: sel.index, to: sel.index + 1 }, disabled: !canMove(cells.length ? cells : [Array.from({ length: cols }, () => "")], merges, { kind: "moveCol", index: sel.index, to: sel.index + 1 }) },
    { label: "清空本列", op: { kind: "clearCol", index: sel.index } },
    { label: "删除本列", op: { kind: "deleteCol", index: sel.index }, danger: true, disabled: cols <= 1 },
  ];
}

const inRange = (g: CellRange | null, r: number, c: number) => !!g && r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
type FindRange = { start: number; end: number; active: boolean };

/** Offsets are code points, matching the document search model. */
export function tableFindText(value: string, ranges: readonly FindRange[]): ReactNode[] {
  const chars = [...value], nodes: ReactNode[] = [];
  let previous = 0;
  for (const [i, range] of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end).entries()) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < previous || range.end <= range.start || range.end > chars.length) continue;
    if (range.start > previous) nodes.push(chars.slice(previous, range.start).join(""));
    nodes.push(<mark key={i} data-table-find-fragment={range.active ? "active" : "match"} className={cn("rounded-[2px] text-inherit", range.active ? "bg-[#ffb74d]" : "bg-[#ffe69b]")}>{chars.slice(range.start, range.end).join("")}</mark>);
    previous = range.end;
  }
  if (previous < chars.length) nodes.push(chars.slice(previous).join(""));
  return nodes;
}

function syncFindOverlay(input: HTMLTextAreaElement) {
  const overlay = input.previousElementSibling;
  if (!(overlay instanceof HTMLElement) || !overlay.hasAttribute("data-table-find-overlay")) return;
  overlay.scrollTop = input.scrollTop; overlay.scrollLeft = input.scrollLeft;
}

export function TableBlock({ data, merges: rawMerges, widths, fillProps = {}, header = true, headerColumn = false, onHeader, onHeaderColumn, onBeginResize, onBeginReorder, onEdit, onChange, onFill, onAlign, onRichMark, onPasteCells, onCutCells, onClearCells, onAppendRow, onDeleteSelection, onDelete, readOnly, canCopy = true, initialGrip = null, findCells = [], findNavigation = 0 }: {
  data: string; merges?: string; widths?: Widths; header?: boolean; headerColumn?: boolean; onHeader?: (on: boolean) => void; onHeaderColumn?: (on: boolean) => void;
  fillProps?: Record<string, string>; onFill?: (target: TableFormatTarget, fill: string) => string | null;
  onAlign?: (target: TableFormatTarget, axis: TableAlignAxis, align: TableAlign) => string | null;
  onRichMark?: (target: TableFormatTarget, mark: TableCellMarkKey, value?: string, textRange?: { start: number; end: number }) => string | null;
  onBeginResize?: (index: number, indices?: readonly number[]) => TableResizeSession | null;
  onBeginReorder?: () => TableReorderSession | null;
  onEdit: (r: number, c: number, v: string, kind?: string) => void;
  /** 结构/合并修改：一次写入 tableData 与 tableMerges。 */
  onChange?: (rows: string[][], merges: Merge[], widths?: Widths, op?: TableOp) => string | null | void;
  onPasteCells?: (r: number, c: number, text: string, literal?: boolean, rich?: RichTableClipboard) => string | null;
  onCutCells?: (range: CellRange) => string | null;
  onClearCells?: (range: CellRange) => string | null;
  onAppendRow?: () => string | null;
  onDeleteSelection?: (range: CellRange) => string | null;
  onDelete: () => void; readOnly: boolean;
  canCopy?: boolean;
  initialGrip?: GripSel | null;
  findCells?: readonly { row: number; col: number; value: string; ranges: FindRange[] }[];
  findNavigation?: number;
}) {
  const rows = parseTableData(data);
  const nCols = rows[0]?.length ?? 0;
  const editable = !readOnly && !!onChange;
  const merges = useMemo(() => parseMerges(rawMerges, rows.length, nCols), [rawMerges, rows.length, nCols]);
  const cover = useMemo(() => coverMap(merges), [merges]);
  const findByCell = useMemo(() => new Map(findCells.map((item) => [`${item.row}:${item.col}`, item])), [findCells]);
  const [grip, setGrip] = useState<GripSel | null>(initialGrip);
  const [axisSelection, setAxisSelection] = useState<AxisSelection | null>(null);
  const [reorderGuide, setReorderGuide] = useState<ReorderGuide | null>(null);
  const [gripMenuHidden, setGripMenuHidden] = useState(false);
  const [range, setRange] = useState<CellRange | null>(null);
  const [touchSelecting, setTouchSelecting] = useState(false);
  const [focus, setFocus] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [clipboardNotice, setClipboardNotice] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);
  const [alignOpen, setAlignOpen] = useState(false);
  const [textColorOpen, setTextColorOpen] = useState(false);
  const [widthPreview, setWidthPreview] = useState<number[] | null>(null);
  const [widthGuide, setWidthGuide] = useState<TableWidthSnapCandidate | null>(null);
  const [rowBounds, setRowBounds] = useState<{ top: number; height: number }[]>([]);
  const widthDrag = useRef<{ pointer: number; index: number; startX: number; x: number; edgeX: number; startScroll: number; initial: number[]; next: number[]; session: TableResizeSession; target: HTMLElement } | null>(null);
  const updateResizeRef = useRef<((x: number, alt: boolean) => void) | null>(null);
  const reorderDrag = useRef<{ pointer: number; kind: "row" | "col"; indices: number[]; startX: number; startY: number; x: number; y: number; active: boolean; before: number | null; valid: boolean; session: TableReorderSession | null; target: HTMLElement; frame: number } | null>(null);
  const suppressGripClick = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Alt" && widthDrag.current) { updateResizeRef.current?.(widthDrag.current.x, event.altKey); return; }
      if (event.key !== "Escape") return;
      if (widthDrag.current) {
        event.preventDefault();
        const drag = widthDrag.current; widthDrag.current = null; setWidthPreview(null); setWidthGuide(null); drag.session.cancel();
        if (drag.target.hasPointerCapture(drag.pointer)) drag.target.releasePointerCapture(drag.pointer);
      } else if (reorderDrag.current) {
        event.preventDefault();
        const drag=reorderDrag.current;reorderDrag.current=null;if(drag.frame)cancelAnimationFrame(drag.frame);drag.session?.cancel();
        if(drag.target.hasPointerCapture(drag.pointer))drag.target.releasePointerCapture(drag.pointer);
        setReorderGuide(null);setAxisSelection(null);
      }
    };
    const keyup = (event: KeyboardEvent) => { if (event.key === "Alt" && widthDrag.current) updateResizeRef.current?.(widthDrag.current.x, event.altKey); };
    const blur = () => {
      const drag = widthDrag.current;
      if (!drag) return;
      widthDrag.current = null; setWidthPreview(null); setWidthGuide(null); drag.session.cancel();
      if (drag.target.hasPointerCapture(drag.pointer)) drag.target.releasePointerCapture(drag.pointer);
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("keyup", keyup); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", escape); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", blur); widthDrag.current?.session.cancel(); widthDrag.current = null; };
  }, []);
  useTableStickyHeader(root, header);
  // The row grips sit outside the horizontal scrollport. Measure actual rows,
  // including rows covered by a rowspan and a translated sticky title row.
  useLayoutEffect(() => {
    const container = root.current, table = container?.querySelector("table");
    if (!editable || !container || !table) return;
    const elements = Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody > tr"));
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = container.getBoundingClientRect().top;
      const stickyBottom = elements[0]?.dataset.tableHeaderStuck === "true" ? elements[0].getBoundingClientRect().bottom : -Infinity;
      const bounds = elements.map((row, index) => {
        const rect = row.getBoundingClientRect(), visibleTop = index ? Math.min(rect.bottom, Math.max(rect.top, stickyBottom)) : rect.top;
        return { top: visibleTop - top, height: Math.max(0, rect.bottom - visibleTop) };
      });
      setRowBounds(previous => previous.length === bounds.length && previous.every((value, index) => Math.abs(value.top - bounds[index].top) < 0.1 && Math.abs(value.height - bounds[index].height) < 0.1) ? previous : bounds);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(container); observer?.observe(table);
    elements.forEach(row => observer?.observe(row));
    window.addEventListener("resize", schedule); window.addEventListener("scroll", schedule, true);
    measure();
    return () => { if (frame) cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); };
  }, [editable, header, rawMerges, rows.length]);
  const pendingTab = useRef<{ source: HTMLTextAreaElement; row: number; cols: number } | null>(null);
  const dragSelection = useRef<{ pointerId: number; r: number; c: number; active: boolean; x: number; y: number; source: HTMLTextAreaElement; restoreFocus: boolean; kind: "mouse" | "touch"; previousRange?: CellRange | null; previousTouch?: boolean } | null>(null);
  const selectionSignature = JSON.stringify([data, rawMerges ?? "", fillProps["tbl.rows"] ?? "", fillProps["tbl.cols"] ?? "", readOnly]);
  const previousSelectionSignature = useRef(selectionSignature);
  useLayoutEffect(() => {
    if (previousSelectionSignature.current === selectionSignature) return;
    previousSelectionSignature.current = selectionSignature;
    if (!touchSelecting && !reorderDrag.current && !axisSelection) return;
    const drag = dragSelection.current;
    dragSelection.current = null;
    if (drag?.kind === "touch" && root.current?.hasPointerCapture(drag.pointerId)) root.current.releasePointerCapture(drag.pointerId);
    const reorder = reorderDrag.current;
    if (reorder) {
      reorderDrag.current = null; if (reorder.frame) cancelAnimationFrame(reorder.frame); reorder.session?.cancel();
      if (reorder.target.hasPointerCapture(reorder.pointer)) reorder.target.releasePointerCapture(reorder.pointer);
      if (reorder.active) setClipboardNotice("拖动时表格已变化，未移动行列；请重试。");
    }
    setAxisSelection(null); setReorderGuide(null);
    setRange(null); setTouchSelecting(false); setFillOpen(false); setAlignOpen(false); setMoreOpen(false);
  }, [selectionSignature, touchSelecting, axisSelection]);
  const lastFindNavigation = useRef<number | null>(null);
  useLayoutEffect(() => {
    const pending = pendingTab.current;
    if (!pending) return;
    pendingTab.current = null;
    if (readOnly || rows.length !== pending.row + 1 || nCols !== pending.cols || document.activeElement !== pending.source) return;
    const next = root.current?.querySelector<HTMLTextAreaElement>(`[data-table-cell="${pending.row}:0"]`);
    if (next) { next.focus(); next.setSelectionRange(0, 0); }
  }, [data, readOnly]);
  useEffect(() => {
    let frame = 0;
    const updateSelection = (drag: NonNullable<typeof dragSelection.current>, x: number, y: number) => {
      const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-table-position]");
      if (!cell || !root.current?.contains(cell)) return;
      const [r, c] = (cell.dataset.tablePosition ?? "").split(":").map(Number);
      if (!Number.isInteger(r) || !Number.isInteger(c)) return;
      if (!drag.active && r === drag.r && c === drag.c) return;
      if (!drag.active && document.activeElement === drag.source) { drag.restoreFocus = true; drag.source.blur(); }
      drag.active = true;
      const next = normRange({ r0: drag.r, c0: drag.c, r1: r, c1: c });
      setRange((current) => current && current.r0 === next.r0 && current.c0 === next.c0 && current.r1 === next.r1 && current.c1 === next.c1 ? current : next);
      window.getSelection()?.removeAllRanges();
    };
    const tick = () => {
      frame = 0;
      const drag = dragSelection.current, container = root.current;
      if (!drag?.active || !container) return;
      const horizontal = container.querySelector<HTMLElement>("[data-table-scroll]"), table = horizontal?.querySelector("table");
      const vertical = tableVerticalScrollParent(container);
      if (!horizontal || !table || !vertical) return;
      const h = horizontal.getBoundingClientRect(), v = vertical === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : vertical.getBoundingClientRect();
      const left = Math.max(0, h.left), right = Math.min(window.innerWidth, h.right);
      const top = Math.max(0, v.top), bottom = Math.min(window.innerHeight, v.bottom);
      const dx = horizontal.scrollWidth > horizontal.clientWidth ? tableSelectionScrollSpeed(drag.x, left, right) : 0;
      const dy = vertical.scrollHeight > vertical.clientHeight ? tableSelectionScrollSpeed(drag.y, top, bottom) : 0;
      const beforeX = horizontal.scrollLeft, beforeY = vertical.scrollTop;
      if (dx) horizontal.scrollLeft += dx;
      if (dy) vertical.scrollTop += dy;
      if (beforeX === horizontal.scrollLeft && beforeY === vertical.scrollTop) return;
      const bounds = table.getBoundingClientRect();
      const x0 = Math.max(left, bounds.left), x1 = Math.min(right, bounds.right);
      const y0 = Math.max(top, bounds.top), y1 = Math.min(bottom, bounds.bottom);
      if (x1 > x0 + 2 && y1 > y0 + 2) updateSelection(drag, Math.max(x0 + 1, Math.min(x1 - 1, drag.x)), Math.max(y0 + 1, Math.min(y1 - 1, drag.y)));
      frame = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      const drag = dragSelection.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.x = event.clientX; drag.y = event.clientY;
      updateSelection(drag, drag.x, drag.y);
      if (drag.active && !frame) frame = requestAnimationFrame(tick);
    };
    const stop = (event: PointerEvent, cancelled = false) => {
      const drag = dragSelection.current;
      if (drag?.pointerId !== event.pointerId) return;
      dragSelection.current = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (cancelled && drag.kind === "touch") { setRange(drag.previousRange ?? null); setTouchSelecting(!!drag.previousTouch); }
      if (drag.active && drag.restoreFocus) requestAnimationFrame(() => {
        if (!dragSelection.current && drag.source.isConnected && document.activeElement === document.body) drag.source.focus({ preventScroll: true });
      });
    };
    const pointerUp = (event: PointerEvent) => stop(event);
    const pointerCancel = (event: PointerEvent) => stop(event, true);
    const capturedRoot = root.current;
    const lostCapture = (event: PointerEvent) => { if (event.target === capturedRoot) stop(event, true); };
    const clear = (restore: boolean) => {
      const drag = dragSelection.current;
      dragSelection.current = null;
      if (drag?.kind === "touch" && capturedRoot?.hasPointerCapture(drag.pointerId)) capturedRoot.releasePointerCapture(drag.pointerId);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (restore && drag?.kind === "touch") { setRange(drag.previousRange ?? null); setTouchSelecting(!!drag.previousTouch); }
    };
    const blur = () => clear(true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("blur", blur);
    capturedRoot?.addEventListener("lostpointercapture", lostCapture);
    return () => {
      clear(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("blur", blur);
      capturedRoot?.removeEventListener("lostpointercapture", lostCapture);
    };
  }, []);
  useEffect(() => {
    const cancel = () => {
      const drag=reorderDrag.current;if(!drag)return;
      reorderDrag.current=null;if(drag.frame)cancelAnimationFrame(drag.frame);drag.session?.cancel();
      if(drag.target.hasPointerCapture(drag.pointer))drag.target.releasePointerCapture(drag.pointer);
      setReorderGuide(null);
    };
    window.addEventListener("blur",cancel);
    return () => { window.removeEventListener("blur",cancel); const drag=reorderDrag.current;reorderDrag.current=null;if(drag?.frame)cancelAnimationFrame(drag.frame);drag?.session?.cancel(); };
  }, []);
  useLayoutEffect(() => {
    if (!findCells.length) return;
    root.current?.querySelectorAll<HTMLTextAreaElement>('[data-find-match="true"] [data-table-cell]').forEach(syncFindOverlay);
    const cell = root.current?.querySelector<HTMLElement>('[data-find-active="true"]');
    const overlay = cell?.querySelector<HTMLElement>("[data-table-find-overlay]");
    const input = cell?.querySelector<HTMLTextAreaElement>("[data-table-cell]");
    const active = overlay?.querySelector<HTMLElement>('[data-table-find-fragment="active"]');
    if (!overlay || !input || !active || lastFindNavigation.current === findNavigation) return;
    lastFindNavigation.current = findNavigation;
    if (document.activeElement === input) return;
    const bounds = overlay.getBoundingClientRect(), match = active.getBoundingClientRect();
    const dy = match.bottom > bounds.bottom ? match.bottom - bounds.bottom + 2 : match.top < bounds.top ? match.top - bounds.top - 2 : 0;
    if (dy) { input.scrollTop += dy; syncFindOverlay(input); }
  }, [findCells, editing, findNavigation]);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const openGrip = (e: React.MouseEvent<HTMLElement>, g: GripSel) => {
    if (suppressGripClick.current) { e.preventDefault(); e.stopPropagation(); suppressGripClick.current=false; return; }
    setMoreOpen(false);
    setFillOpen(false);
    setAlignOpen(false);
    setGripMenuHidden(false);
    setTouchSelecting(false);
    setRange(null);
    if(e.metaKey || e.ctrlKey) {
      const base=axisSelection?.kind===g.kind?axisSelection.indices:grip?.kind===g.kind?[grip.index]:[];
      const next=base.includes(g.index)?base.filter(index=>index!==g.index):[...base,g.index].sort((a,b)=>a-b);
      setGrip(null);setFocus(null);setAxisSelection(next.length?{kind:g.kind,indices:next}:null);e.currentTarget.focus({preventScroll:true});return;
    }
    setAxisSelection(null);
    const same = grip?.kind === g.kind && grip?.index === g.index;
    const box = root.current?.getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect();
    if (box) setMenuAt(g.kind === "col" ? { x: b.left - box.left, y: b.bottom - box.top + 4 } : { x: b.right - box.left + 4, y: b.top - box.top });
    setGrip(same ? null : g);
  };
  useEffect(() => {
    if (!grip && !axisSelection && !range && !moreOpen && !fillOpen && !alignOpen) return;
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) { setGrip(null); setAxisSelection(null); setRange(null); setTouchSelecting(false); setMoreOpen(false); setFillOpen(false); setAlignOpen(false); setTextColorOpen(false); } };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [grip, axisSelection, range, moreOpen, fillOpen, alignOpen]);
  const columnWidths = widthPreview ?? visibleTableWidths(rows, widths);
  const colW = (ci: number) => columnWidths[ci] ?? 100;
  const startResize = (e: React.PointerEvent<HTMLElement>, ci: number) => {
    if (widthDrag.current || e.button !== 0 || ci < 0 || ci >= nCols) return;
    const session = onBeginResize?.(ci);
    if (!session) return;
    const scroller = root.current?.querySelector<HTMLElement>("[data-table-scroll]"), column = scroller?.querySelectorAll<HTMLElement>("[data-table-column]")[ci];
    if (!scroller || !column) { session.cancel(); return; }
    e.preventDefault(); e.stopPropagation();
    const initial = [...columnWidths], target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch { session.cancel(); return; }
    widthDrag.current = { pointer: e.pointerId, index: ci, startX: e.clientX, x: e.clientX, edgeX: column.getBoundingClientRect().right, startScroll: scroller.scrollLeft, initial, next: initial, session, target };
  };
  const updateResize = (x: number, alt: boolean) => {
    const drag = widthDrag.current, container = root.current, scroller = container?.querySelector<HTMLElement>("[data-table-scroll]"), table = scroller?.querySelector("table");
    if (!drag || !container || !scroller || !table) return;
    drag.x = x;
    const cols = [...table.querySelectorAll<HTMLElement>("[data-table-column]")], origin = container.getBoundingClientRect(), tableRect = table.getBoundingClientRect(), scrollRect = scroller.getBoundingClientRect();
    const currentWidth = parseFloat(cols[drag.index]?.style.width ?? ""), offset = scroller.scrollLeft - drag.startScroll;
    const edge = drag.edgeX - offset, raw = drag.initial[drag.index] + x - drag.startX + offset;
    const candidates: TableWidthSnapCandidate[] = [];
    for (const neighbor of [drag.index - 1, drag.index + 1]) {
      const col = cols[neighbor];
      if (!col || !Number.isFinite(currentWidth)) continue;
      const candidateWidth = drag.initial[neighbor], reference = col.getBoundingClientRect().right + (neighbor > drag.index ? candidateWidth - currentWidth : 0);
      if (reference >= scrollRect.left && reference <= scrollRect.right) candidates.push({ kind: "equal", width: candidateWidth, x: reference, top: tableRect.top, bottom: tableRect.bottom });
    }
    // Different horizontal scroll offsets do not represent document alignment.
    const editor = container.closest<HTMLElement>("[data-editor]");
    if (editor && Math.abs(scroller.scrollLeft) < 0.5) {
      const editorRect = editor.getBoundingClientRect(), visibleLeft = Math.max(0, editorRect.left), visibleRight = Math.min(window.innerWidth, editorRect.right);
      const nearby = [...editor.querySelectorAll<HTMLElement>("[data-table-block]")], at = nearby.indexOf(container);
      for (const other of [nearby[at - 1], nearby[at + 1]]) {
        if (!other || other === container) continue;
        const otherScroll = other.querySelector<HTMLElement>("[data-table-scroll]"), otherTable = otherScroll?.querySelector("table");
        if (!otherScroll || !otherTable || Math.abs(otherScroll.scrollLeft) >= 0.5) continue;
        const rect = otherTable.getBoundingClientRect();
        if (!rect.width || !rect.height || Math.max(rect.top - tableRect.bottom, tableRect.top - rect.bottom, 0) > Math.max(window.innerHeight, 900)) continue;
        for (const col of otherTable.querySelectorAll<HTMLElement>("[data-table-column]")) {
          const reference = col.getBoundingClientRect().right;
          if (reference >= visibleLeft && reference <= visibleRight) candidates.push({ kind: "table", width: drag.initial[drag.index] + reference - edge, x: reference, top: Math.min(tableRect.top, rect.top), bottom: Math.max(tableRect.bottom, rect.bottom) });
        }
      }
      if (drag.index === drag.initial.length - 1) {
        const reference = editorRect.right;
        if (reference <= window.innerWidth && reference >= visibleLeft) candidates.push({ kind: "page", width: drag.initial[drag.index] + reference - edge, x: reference, top: tableRect.top - 24, bottom: tableRect.bottom + 24 });
      }
    }
    const result = snapTableWidth(raw, candidates, alt);
    drag.next = drag.initial.map((width, index) => index === drag.index ? result.width : width);
    setWidthPreview(drag.next);
    setWidthGuide(result.guide ? { ...result.guide, x: result.guide.x - origin.left, top: result.guide.top - origin.top, bottom: result.guide.bottom - origin.top } : null);
  };
  updateResizeRef.current = updateResize;
  const moveResize = (e: React.PointerEvent<HTMLElement>) => {
    const drag = widthDrag.current;
    if (!drag || drag.pointer !== e.pointerId) return;
    e.preventDefault();
    updateResize(e.clientX, e.altKey);
  };
  const commitResize = (session: TableResizeSession, next: number[]) => {
    try {
      const result = session.commit(next);
      if (result && typeof result.then === "function") {
        setWidthPreview(next);
        void result.then(() => setWidthPreview((current) => current === next ? null : current), () => setWidthPreview((current) => current === next ? null : current));
      } else setWidthPreview(null);
    } catch { setWidthPreview(null); }
  };
  const endResize = (e: React.PointerEvent<HTMLElement>, cancelled = false) => {
    const drag = widthDrag.current;
    if (!drag || drag.pointer !== e.pointerId) return;
    widthDrag.current = null; setWidthGuide(null);
    if (cancelled || drag.initial.every((value, index) => value === drag.next[index])) { setWidthPreview(null); drag.session.cancel(); }
    else commitResize(drag.session, drag.next);
    if (drag.target.hasPointerCapture(drag.pointer)) drag.target.releasePointerCapture(drag.pointer);
  };
  const updateReorder = (drag: NonNullable<typeof reorderDrag.current>) => {
    const container=root.current, scroller=container?.querySelector<HTMLElement>("[data-table-scroll]"), table=scroller?.querySelector("table");
    if(!container||!scroller||!table)return;
    const sr=scroller.getBoundingClientRect(),tr=table.getBoundingClientRect(),rr=container.getBoundingClientRect();
    const vertical=tableVerticalScrollParent(container),vr=vertical&&vertical!==document.scrollingElement?vertical.getBoundingClientRect():{top:0,bottom:window.innerHeight};
    const left=Math.max(0,sr.left,tr.left),right=Math.min(window.innerWidth,sr.right,tr.right),top=Math.max(0,vr.top,tr.top),bottom=Math.min(window.innerHeight,vr.bottom,tr.bottom);
    if(right<=left+2||bottom<=top+2)return;
    const x=Math.max(left+1,Math.min(right-1,drag.x)),y=Math.max(top+1,Math.min(bottom-1,drag.y));
    const cell=document.elementFromPoint(x,y)?.closest<HTMLElement>("[data-table-position]");
    if(!cell||!container.contains(cell))return;
    const [r,c]=(cell.dataset.tablePosition??"").split(":").map(Number);if(!Number.isInteger(r)||!Number.isInteger(c))return;
    const rect=cell.getBoundingClientRect(),span=cover.get(`${r}:${c}`),extent=span&&span!=="hidden"?span.span:[1,1];
    const after=drag.kind==="row"?y>=rect.top+rect.height/2:x>=rect.left+rect.width/2;
    const before=drag.kind==="row"?r+(after?extent[0]:0):c+(after?extent[1]:0);
    const op:TableReorderOp={kind:drag.kind==="row"?"reorderRows":"reorderCols",indices:drag.indices,before};
    const plan=planTableReorder(rows,merges,op),valid=!!plan;
    drag.before=before;drag.valid=valid;
    const guide=drag.kind==="row"?{left:left-rr.left,top:(after?rect.bottom:rect.top)-rr.top-1,width:right-left,height:2,valid}:{left:(after?rect.right:rect.left)-rr.left-1,top:top-rr.top,width:2,height:bottom-top,valid};
    setReorderGuide(guide);
  };
  const scrollReorder = (drag: NonNullable<typeof reorderDrag.current>) => {
    drag.frame=0;
    const container=root.current,scroller=container?.querySelector<HTMLElement>("[data-table-scroll]"),vertical=container&&tableVerticalScrollParent(container);
    if(!container||!scroller||!vertical||reorderDrag.current!==drag||!drag.active)return;
    const h=scroller.getBoundingClientRect(),v=vertical===document.scrollingElement?{top:0,bottom:window.innerHeight}:vertical.getBoundingClientRect();
    const dx=scroller.scrollWidth>scroller.clientWidth?tableSelectionScrollSpeed(drag.x,Math.max(0,h.left),Math.min(window.innerWidth,h.right)):0;
    const dy=vertical.scrollHeight>vertical.clientHeight?tableSelectionScrollSpeed(drag.y,Math.max(0,v.top),Math.min(window.innerHeight,v.bottom)):0;
    const oldX=scroller.scrollLeft,oldY=vertical.scrollTop;if(dx)scroller.scrollLeft+=dx;if(dy)vertical.scrollTop+=dy;
    if(oldX!==scroller.scrollLeft||oldY!==vertical.scrollTop){updateReorder(drag);drag.frame=requestAnimationFrame(()=>scrollReorder(drag));}
  };
  const selectedAxes = (g: GripSel): number[] => {
    if(axisSelection?.kind===g.kind && axisSelection.indices.includes(g.index))return [...axisSelection.indices];
    const full=range?expandRange(range,merges):null;
    if(full && g.kind==='row' && full.c0===0 && full.c1===nCols-1 && g.index>=full.r0 && g.index<=full.r1)return Array.from({length:full.r1-full.r0+1},(_,i)=>full.r0+i);
    if(full && g.kind==='col' && full.r0===0 && full.r1===rows.length-1 && g.index>=full.c0 && g.index<=full.c1)return Array.from({length:full.c1-full.c0+1},(_,i)=>full.c0+i);
    return [g.index];
  };
  const beginReorder = (event: React.PointerEvent<HTMLButtonElement>, g: GripSel) => {
    if(!onBeginReorder||readOnly||event.button!==0||reorderDrag.current||dragSelection.current||widthDrag.current)return;
    const indices=selectedAxes(g);
    try {event.currentTarget.setPointerCapture(event.pointerId);} catch {return;}
    reorderDrag.current={pointer:event.pointerId,kind:g.kind,indices:[...indices],startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,active:false,before:null,valid:false,session:null,target:event.currentTarget,frame:0};
  };
  const moveReorder = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag=reorderDrag.current;if(!drag||drag.pointer!==event.pointerId)return;
    drag.x=event.clientX;drag.y=event.clientY;
    if(!drag.active){
      if(Math.hypot(drag.x-drag.startX,drag.y-drag.startY)<6)return;
      const session=onBeginReorder?.();if(!session){reorderDrag.current=null;if(drag.target.hasPointerCapture(drag.pointer))drag.target.releasePointerCapture(drag.pointer);suppressGripClick.current=true;setTimeout(()=>{suppressGripClick.current=false;},0);return;}
      drag.active=true;drag.session=session;
      if(document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement))document.activeElement.blur();
      setGrip(null);setRange(null);setTouchSelecting(false);setFocus(null);setMoreOpen(false);setFillOpen(false);setAlignOpen(false);setAxisSelection({kind:drag.kind,indices:drag.indices});
    }
    event.preventDefault();event.stopPropagation();updateReorder(drag);if(!drag.frame)drag.frame=requestAnimationFrame(()=>scrollReorder(drag));
  };
  const endReorder = (event: React.PointerEvent<HTMLButtonElement>,cancelled=false) => {
    const drag=reorderDrag.current;if(!drag||drag.pointer!==event.pointerId)return;
    reorderDrag.current=null;if(drag.frame)cancelAnimationFrame(drag.frame);
    if(drag.active){
      event.preventDefault();event.stopPropagation();suppressGripClick.current=true;setTimeout(()=>{suppressGripClick.current=false;},0);
      let focusIndex = Number(drag.kind === "row" ? drag.target.dataset.tableRowGrip : drag.target.dataset.tableColGrip);
      if(!cancelled&&drag.before!==null&&drag.valid&&drag.session){
        const op:TableReorderOp={kind:drag.kind==="row"?"reorderRows":"reorderCols",indices:drag.indices,before:drag.before};
        const plan=planTableReorder(rows,merges,op), error=drag.session.commit(op);
        if(!error && plan) focusIndex=plan.order.indexOf(focusIndex);
        setClipboardNotice(error??"");
      }
      else {drag.session?.cancel();if(!cancelled)setClipboardNotice("无法拆开合并单元格，请调整选区或目标位置。");}
      setAxisSelection(null);setReorderGuide(null);
      if(!cancelled)requestAnimationFrame(()=>{
        const target=root.current?.querySelector<HTMLButtonElement>(`[data-table-${drag.kind === "row" ? "row" : "col"}-grip="${focusIndex}"]`);
        if(target && document.activeElement===document.body)target.focus({preventScroll:true});
      });
    }
    if(drag.target.hasPointerCapture(drag.pointer))drag.target.releasePointerCapture(drag.pointer);
  };
  const keyReorder = (event: React.KeyboardEvent<HTMLButtonElement>,g:GripSel) => {
    const negative=g.kind==="row"?"ArrowUp":"ArrowLeft",positive=g.kind==="row"?"ArrowDown":"ArrowRight";
    if(!event.altKey||event.metaKey||event.ctrlKey||event.shiftKey||![negative,positive].includes(event.key)||!onBeginReorder)return;
    event.preventDefault();event.stopPropagation();
    const indices=selectedAxes(g);
    const count=g.kind==="row"?rows.length:nCols,before=event.key===negative?Math.max(0,Math.min(...indices)-1):Math.min(count,Math.max(...indices)+2);
    const op:TableReorderOp={kind:g.kind==="row"?"reorderRows":"reorderCols",indices:[...indices],before};
    const plan=planTableReorder(rows,merges,op);
    if(!plan){setClipboardNotice("无法拆开合并单元格，请调整选区或目标位置。");return;}
    if(plan.order.every((old,index)=>old===index))return;
    const session=onBeginReorder();if(!session)return;
    const original=event.currentTarget, error=session.commit(op);
    setClipboardNotice(error??"");setGrip(null);setAxisSelection(null);setRange(null);
    if (!error) requestAnimationFrame(() => {
      if (document.activeElement !== document.body && document.activeElement !== original) return;
      root.current?.querySelector<HTMLButtonElement>(`[data-table-${g.kind === "row" ? "row" : "col"}-grip="${plan.order.indexOf(g.index)}"]`)?.focus({ preventScroll: true });
    });
  };
  const rawSelected: CellRange | null = grip ? (grip.kind === "row" ? { r0: grip.index, r1: grip.index, c0: 0, c1: nCols - 1 } : { r0: 0, r1: rows.length - 1, c0: grip.index, c1: grip.index }) : range;
  const selected = rawSelected ? expandRange(rawSelected, merges) : null;
  const selectedColumns = axisSelection?.kind === "col" ? axisSelection.indices : grip?.kind === "col" ? [grip.index] : selected && selected.r0 === 0 && selected.r1 === rows.length - 1 ? Array.from({ length: selected.c1 - selected.c0 + 1 }, (_, index) => selected.c0 + index) : [];
  const touchRange = touchSelecting && selected ? selected : focus ? expandRange({ r0: focus.r, r1: focus.r, c0: focus.c, c1: focus.c }, merges) : null;
  const beginTouchSelection = (event: React.PointerEvent<HTMLButtonElement>, corner: "start" | "end") => {
    if (readOnly || dragSelection.current || !touchRange || !root.current) return;
    const anchor = corner === "start" ? { r: touchRange.r1, c: touchRange.c1 } : { r: touchRange.r0, c: touchRange.c0 };
    const source = root.current.querySelector<HTMLTextAreaElement>(`[data-table-cell="${focus?.r ?? touchRange.r0}:${focus?.c ?? touchRange.c0}"]`) ?? root.current.querySelector<HTMLTextAreaElement>("[data-table-cell]");
    if (!source) return;
    event.preventDefault(); event.stopPropagation();
    try { root.current.setPointerCapture(event.pointerId); } catch { return; }
    dragSelection.current = { pointerId: event.pointerId, r: anchor.r, c: anchor.c, active: true, x: event.clientX, y: event.clientY, source, restoreFocus: false, kind: "touch", previousRange: range, previousTouch: touchSelecting };
    if (document.activeElement instanceof HTMLElement && root.current.contains(document.activeElement)) document.activeElement.blur();
    window.getSelection()?.removeAllRanges();
    setGrip(null); setMoreOpen(false); setFillOpen(false); setAlignOpen(false);
    if (!touchSelecting) setRange({ ...touchRange });
    setTouchSelecting(true);
  };
  const moveTouchSelectionWithKey = (event: React.KeyboardEvent<HTMLButtonElement>, corner: "start" | "end") => {
    if (!touchRange || readOnly || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const moving = corner === "start" ? { r: touchRange.r0, c: touchRange.c0 } : { r: touchRange.r1, c: touchRange.c1 };
    const anchor = corner === "start" ? { r: touchRange.r1, c: touchRange.c1 } : { r: touchRange.r0, c: touchRange.c0 };
    if (event.key === "ArrowUp") moving.r--;
    if (event.key === "ArrowDown") moving.r++;
    if (event.key === "ArrowLeft") moving.c--;
    if (event.key === "ArrowRight") moving.c++;
    moving.r = Math.max(0, Math.min(rows.length - 1, moving.r)); moving.c = Math.max(0, Math.min(nCols - 1, moving.c));
    moving.r = corner === "start" ? Math.min(moving.r, anchor.r) : Math.max(moving.r, anchor.r);
    moving.c = corner === "start" ? Math.min(moving.c, anchor.c) : Math.max(moving.c, anchor.c);
    setGrip(null); setMoreOpen(false); setFillOpen(false); setAlignOpen(false);
    setRange(normRange({ r0: anchor.r, c0: anchor.c, r1: moving.r, c1: moving.c })); setTouchSelecting(true);
    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-table-touch-handle="${corner}"]`)?.focus({ preventScroll: true }));
  };
  const formatRange = selected ?? (focus ? { r0: focus.r, r1: focus.r, c0: focus.c, c1: focus.c } : null);
  const formatTarget: TableFormatTarget | null = axisSelection ? { kind: "axes", axis: axisSelection.kind, indices: axisSelection.indices } : formatRange ? { kind: "range", range: formatRange } : null;
  const formatCells = formatTarget ? tableFormatCells(rows.length, nCols, merges, formatTarget) : null;
  const allAligned = (axis: TableAlignAxis, value: TableAlign) => {
    return !!formatCells?.length && formatCells.every(({ row, col }) => tableCellAlign(fillProps, row, col, axis) === value);
  };
  const allMarked = (mark: TableCellMarkKey) => {
    return !!formatCells?.length && formatCells.every(({ row, col }) => tableCellHasMark(fillProps, row, col, mark, rows[row]?.[col] ?? ""));
  };
  const activeTextRange = (): { start: number; end: number } | undefined => {
    if (!focus || multi || axisSelection) return undefined;
    const el = document.activeElement;
    if (!(el instanceof HTMLTextAreaElement) || el.dataset.tableCell !== `${focus.r}:${focus.c}`) return undefined;
    return el.selectionStart < el.selectionEnd ? { start: el.selectionStart, end: el.selectionEnd } : undefined;
  };
  const multi = !!selected && (selected.r0 !== selected.r1 || selected.c0 !== selected.c1);
  const deletion = selected && onDeleteSelection ? planSelectionDelete(rows, merges, widths, selected) : null;
  const focusMerge = focus && splitCell(merges, focus.r, focus.c) !== null;
  const apply = (op: TableOp) => {
    const deletion = op.kind === "deleteRow" || op.kind === "deleteCol" ? planTableAxisDelete(rows, merges, op) : null;
    if (deletion && !deletion.ok) { setClipboardNotice(deletion.message); setGrip(null); return; }
    const result = deletion?.ok ? deletion : applyTableOp(rows, merges, op);
    const error = onChange?.(result.rows, result.merges, remapWidths(widths, op, nCols), op);
    if (error) { setClipboardNotice(error); setGrip(null); return; }
    setGrip(null); setRange(null); setTouchSelecting(false);
  };
  const merge = () => { if (!selected) return; const res = mergeCells(rows, merges, selected); if (res) onChange?.(res.rows, res.merges); setGrip(null); setRange(null); setTouchSelecting(false); };
  const split = () => { if (!focus) return; const m = splitCell(merges, focus.r, focus.c); if (m) onChange?.(rows, m); };
  const renderGrip = (kind: "row" | "col", index: number, weight: number) => {
    const active = grip?.kind === kind && grip.index === index || axisSelection?.kind === kind && axisSelection.indices.includes(index);
    const label = kind === "row" ? `选择第 ${index + 1} 行` : `选择第 ${index + 1} 列`;
    return <button key={index} type="button" aria-label={label} aria-keyshortcuts={kind === "row" ? "Alt+ArrowUp Alt+ArrowDown" : "Alt+ArrowLeft Alt+ArrowRight"} aria-pressed={active} title={`选择或拖动${kind === "row" ? "行" : "列"}，按住 Ctrl 或 Command 多选`} style={{ flex: `${weight} 1 0%` }} onMouseDown={e => e.preventDefault()} onClick={e => openGrip(e, { kind, index })} onKeyDown={e => keyReorder(e, { kind, index })} onPointerDown={e => beginReorder(e, { kind, index })} onPointerMove={moveReorder} onPointerUp={e => endReorder(e)} onPointerCancel={e => endReorder(e, true)} onLostPointerCapture={e => endReorder(e, true)} className={cn("pointer-events-auto min-h-0 min-w-0 touch-none rounded-[3px] bg-[#EFF0F1] opacity-0 hover:bg-primary/30 group-hover/t:opacity-100 dark:bg-hover [@media(pointer:coarse)]:opacity-100", active && "bg-primary opacity-100")} data-table-row-grip={kind === "row" ? index : undefined} data-table-col-grip={kind === "col" ? index : undefined} />;
  };
  return (
    <div ref={root} contentEditable={false} className={cn("group/t relative my-2 w-fit max-w-full select-none sm:mt-3", editable && "-ml-4 pl-4", !readOnly && "sm:pb-4 sm:pr-4")} data-table-block data-table-touch-selecting={touchSelecting ? "true" : undefined} data-table-axis-selection={axisSelection ? `${axisSelection.kind}:${axisSelection.indices.join(',')}` : undefined}
      onKeyDown={(event) => { if (event.key === "Escape" && (moreOpen || fillOpen || alignOpen || textColorOpen)) { event.preventDefault(); event.stopPropagation(); setMoreOpen(false); setFillOpen(false); setAlignOpen(false); setTextColorOpen(false); } }}
      onCopy={(event) => {
        if (!canCopy) { event.preventDefault(); event.stopPropagation(); return; }
        if (!multi || !selected) return;
        event.preventDefault(); event.stopPropagation();
        try { event.clipboardData.setData("text/plain", formatTableTSV(rows, selected, merges)); }
        catch { setClipboardNotice("无法写入剪贴板，请检查浏览器权限。"); return; }
        const html = tableRichHTML(rows, fillProps, selected, merges);
        if (html) { try { event.clipboardData.setData("text/html", html); } catch { setClipboardNotice("已复制纯文本"); } }
        else setClipboardNotice("已复制纯文本");
      }}
      onCut={(event) => {
        if (!canCopy) { event.preventDefault(); event.stopPropagation(); return; }
        if (!multi || !selected) return;
        event.preventDefault(); event.stopPropagation();
        if (!onCutCells) { setClipboardNotice("当前无法剪切选区，表格未修改。"); return; }
        try {
          event.clipboardData.setData("text/plain", formatTableTSV(rows, selected, merges));
          const html = tableRichHTML(rows, fillProps, selected, merges);
          if (html) event.clipboardData.setData("text/html", html);
        }
        catch { setClipboardNotice("无法写入剪贴板，表格未修改。"); return; }
        const error = onCutCells(selected);
        setClipboardNotice(error ? `${error}请检查剪贴板后重试。` : "");
        if (!error) { setRange(null); setGrip(null); setTouchSelecting(false); }
      }}>
      {!readOnly && <div className="pointer-events-none relative z-30 sm:h-11"><span className={cn("pointer-events-auto mb-4 w-max max-w-[calc(100vw-32px)] items-center gap-0.5 whitespace-nowrap rounded-lg border bg-surface p-0.5 text-subtle shadow-[0_4px_16px_rgba(31,35,41,0.12)] sm:absolute sm:bottom-4 sm:left-0 sm:mb-0", multi || axisSelection || moreOpen || fillOpen || alignOpen || textColorOpen || touchSelecting ? "flex" : "hidden group-focus-within/t:flex sm:invisible sm:flex sm:group-hover/t:visible sm:group-focus-within/t:visible")} data-table-toolbar>
        {editable && (multi || focusMerge) && <span className="relative flex">
          <button type="button" title="更多表格操作" aria-label="更多表格操作" aria-haspopup="menu" aria-expanded={moreOpen} className={cn("grid size-9 place-items-center rounded hover:bg-hover hover:text-foreground sm:size-7", moreOpen && "bg-hover")} onMouseDown={(e) => e.preventDefault()} onClick={() => { setFillOpen(false); setAlignOpen(false); setGripMenuHidden(true); setMoreOpen((open) => !open); }} data-table-more><LayoutGrid size={15} strokeWidth={1.7} /></button>
          {moreOpen && <span role="menu" className="absolute left-0 top-9 z-40 w-44 rounded-lg border border-[#DEE0E3] bg-surface p-1 text-[13px] text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border" data-table-more-menu>
            {multi && <button type="button" role="menuitem" className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover" onMouseDown={(e) => e.preventDefault()} onClick={() => { setMoreOpen(false); merge(); }} data-table-merge><Combine size={15} strokeWidth={1.7} />合并单元格</button>}
            {!multi && focusMerge && <button type="button" role="menuitem" className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover" onMouseDown={(e) => e.preventDefault()} onClick={() => { setMoreOpen(false); split(); }} data-table-split><SquareSplitHorizontal size={15} strokeWidth={1.7} />拆分单元格</button>}
            {touchSelecting && multi && selected && canCopy && <button type="button" role="menuitem" className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover" onMouseDown={e => e.preventDefault()} onClick={() => {
              const text = formatTableTSV(rows, selected, merges), html = tableRichHTML(rows, fillProps, selected, merges); setMoreOpen(false);
              const plain = () => {
                try {
                  if (!navigator.clipboard?.writeText) { setClipboardNotice("无法使用剪贴板，请检查浏览器权限。"); return; }
                  void navigator.clipboard.writeText(text).then(() => setClipboardNotice(html ? "已复制纯文本" : "已复制选区"), () => setClipboardNotice("无法写入剪贴板，请检查浏览器权限。"));
                } catch { setClipboardNotice("无法写入剪贴板，请检查浏览器权限。"); }
              };
              try {
                if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
                  const item = new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) });
                  void navigator.clipboard.write([item]).then(() => setClipboardNotice("已复制选区"), plain);
                } else plain();
              } catch { setClipboardNotice("无法写入剪贴板，请检查浏览器权限。"); }
            }} data-table-copy-selection><Copy size={15} strokeWidth={1.7} />复制选区</button>}
            {touchSelecting && multi && selected && onClearCells && <button type="button" role="menuitem" className="flex h-9 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover" onMouseDown={e => e.preventDefault()} onClick={() => { setMoreOpen(false); setClipboardNotice(onClearCells(selected) ?? ""); }} data-table-clear-selection><Eraser size={15} strokeWidth={1.7} />清空选区</button>}
          </span>}
        </span>}
        {editable && (multi || focusMerge) && <span className="mx-0.5 h-4 w-px bg-border" />}
        {onRichMark && <>
          {([
            ["bold", "加粗 (⌘B)", Bold],
            ["italic", "斜体 (⌘I)", Italic],
            ["underline", "下划线 (⌘U)", Underline],
            ["strike", "删除线 (⌘⇧S)", Strikethrough],
            ["code", "行内代码 (⌘E)", Code],
          ] as const).map(([mark, title, Icon]) => (
            <button
              key={mark}
              type="button"
              title={title}
              aria-label={title}
              aria-pressed={allMarked(mark)}
              disabled={!formatTarget}
              className={cn("grid size-9 place-items-center rounded hover:bg-hover hover:text-foreground disabled:opacity-40 sm:size-7", allMarked(mark) && "bg-[#E1EAFF] text-primary")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { if (formatTarget) setClipboardNotice(onRichMark(formatTarget, mark, undefined, activeTextRange()) ?? ""); }}
              data-table-rich-mark={mark}
            >
              <Icon size={14} strokeWidth={1.8} />
            </button>
          ))}
          <span className="relative flex">
            <button type="button" title="文字颜色" aria-label="文字颜色" aria-haspopup="menu" aria-expanded={textColorOpen} disabled={!formatTarget} className={cn("grid size-9 place-items-center rounded hover:bg-hover hover:text-foreground disabled:opacity-40 sm:size-7", textColorOpen && "bg-hover")} onMouseDown={(e) => e.preventDefault()} onClick={() => { setMoreOpen(false); setFillOpen(false); setAlignOpen(false); setGripMenuHidden(true); setTextColorOpen((open) => !open); }} data-table-rich-mark="color"><Palette size={14} strokeWidth={1.8} /></button>
            {textColorOpen && <span role="menu" aria-label="文字颜色" className="absolute left-0 top-9 z-40 w-[200px] rounded-lg border border-[#DEE0E3] bg-surface p-2 text-[13px] text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border" data-table-text-color-menu>
              <span className="block px-1 pb-2 text-xs text-muted-foreground">文字颜色</span>
              <span className="grid grid-cols-6 gap-1">{["#1F2329", "#D83931", "#DE7802", "#2EA121", "#245BDB", "#7F3BF5", "#646A73", "#F54A45", "#FF8800", "#34C724", "#3370FF", "#A259FF"].map(color => <button key={color} type="button" role="menuitem" aria-label={color} title={color} className="size-7 rounded border border-black/10 hover:outline hover:outline-2 hover:outline-primary" style={{ backgroundColor: color }} onMouseDown={e => e.preventDefault()} onClick={() => { if (formatTarget) setClipboardNotice(onRichMark(formatTarget, "color", color, activeTextRange()) ?? ""); setTextColorOpen(false); }} data-table-text-color={color} />)}</span>
              <button type="button" role="menuitem" className="mt-2 h-8 w-full rounded px-1 text-left hover:bg-hover" onMouseDown={e => e.preventDefault()} onClick={() => { if (formatTarget) setClipboardNotice(onRichMark(formatTarget, "color", "", activeTextRange()) ?? ""); setTextColorOpen(false); }} data-table-text-color-reset>默认颜色</button>
            </span>}
          </span>
          <span className="mx-0.5 h-4 w-px bg-border" />
        </>}
        {onFill && <span className="relative flex">
          <button type="button" title="单元格背景色" aria-label="单元格背景色" aria-haspopup="menu" aria-expanded={fillOpen} disabled={!formatTarget} className={cn("grid size-9 place-items-center rounded hover:bg-hover hover:text-foreground disabled:opacity-40 sm:size-7", fillOpen && "bg-hover")} onMouseDown={(e) => e.preventDefault()} onClick={() => { setMoreOpen(false); setAlignOpen(false); setGripMenuHidden(true); setFillOpen(open => !open); }} data-table-fill><PaintBucket size={15} strokeWidth={1.7} /></button>
          {fillOpen && <span role="menu" aria-label="单元格背景色" className="absolute left-0 top-9 z-40 w-[230px] rounded-lg border border-[#DEE0E3] bg-surface p-2 text-[13px] text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border" data-table-fill-menu>
            <span className="block px-1 pb-2 text-xs text-muted-foreground">背景颜色</span>
            <span className="grid grid-cols-6 gap-1">{["#FFFFFF", "#F2F3F5", "#FBE4E2", "#FFF1D1", "#E5F5E8", "#E3ECFF", "#DEE0E3", "#F7C6C2", "#FCE2A8", "#BDEBC7", "#BFD3FF", "#E8D9FC"].map(color => <button key={color} type="button" role="menuitem" aria-label={color} title={color} className="size-8 rounded border border-black/10 hover:outline hover:outline-2 hover:outline-primary" style={{ backgroundColor: color }} onMouseDown={e => e.preventDefault()} onClick={() => { if (formatTarget) setClipboardNotice(onFill(formatTarget, color) ?? ""); setFillOpen(false); }} data-table-fill-color={color} />)}</span>
            <button type="button" role="menuitem" className="mt-2 h-8 w-full rounded px-1 text-left hover:bg-hover" onMouseDown={e => e.preventDefault()} onClick={() => { if (formatTarget) setClipboardNotice(onFill(formatTarget, "") ?? ""); setFillOpen(false); }} data-table-fill-reset>恢复默认</button>
          </span>}
        </span>}
        {onAlign && <span className="relative flex">
          <button type="button" title="单元格文本对齐" aria-label="单元格文本对齐" aria-haspopup="menu" aria-expanded={alignOpen} disabled={!formatTarget} className={cn("grid size-9 place-items-center rounded hover:bg-hover hover:text-foreground disabled:opacity-40 sm:size-7", alignOpen && "bg-hover")} onMouseDown={e => e.preventDefault()} onClick={() => { setMoreOpen(false); setFillOpen(false); setGripMenuHidden(true); setAlignOpen(open => !open); }} data-table-align><AlignLeft size={15} strokeWidth={1.7} /></button>
          {alignOpen && <span role="menu" aria-label="单元格文本对齐" className="absolute left-0 top-9 z-40 w-[160px] rounded-lg border border-[#DEE0E3] bg-surface p-2 text-[13px] text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border" data-table-align-menu>
            {([ ["horizontal", "横向对齐", [["left", "左对齐", AlignLeft], ["center", "水平居中", AlignCenter], ["right", "右对齐", AlignRight]]], ["vertical", "纵向对齐", [["top", "顶部对齐", AlignStartHorizontal], ["middle", "垂直居中", AlignCenterHorizontal], ["bottom", "底部对齐", AlignEndHorizontal]]] ] as const).map(([axis, label, choices]) => <span key={axis} className="block"><span className="block px-1 py-1 text-xs text-muted-foreground">{label}</span><span className="flex gap-1">{choices.map(([value, title, Icon]) => <button key={value} type="button" role="menuitemradio" aria-checked={allAligned(axis, value)} aria-label={title} title={title} className={cn("grid size-10 place-items-center rounded hover:bg-hover", allAligned(axis, value) && "bg-[#E1EAFF] text-primary")} onMouseDown={e => e.preventDefault()} onClick={() => { if (formatTarget) setClipboardNotice(onAlign(formatTarget, axis, value) ?? ""); setAlignOpen(false); }} data-table-align-option={`${axis}:${value}`}><Icon size={16} strokeWidth={1.7} /></button>)}</span></span>)}
          </span>}
        </span>}
        {onBeginResize && selectedColumns.length >= 2 && <button type="button" title="均分所选列宽" aria-label="均分所选列宽" className="grid size-9 place-items-center rounded hover:bg-hover hover:text-foreground sm:size-7" onMouseDown={e => e.preventDefault()} onClick={() => {
          const next = equalizedTableWidths(columnWidths, selectedColumns);
          if (!next || next.every((width, index) => width === columnWidths[index])) return;
          const session = onBeginResize(selectedColumns[0], selectedColumns);
          if (session) commitResize(session, next);
        }} data-table-equal-selected-widths><Columns3 size={15} strokeWidth={1.7} /></button>}
        <button type="button" title="在下方插入行" aria-label="在下方插入行" className={cn("flex h-9 items-center gap-1 rounded px-2 text-[12px] hover:bg-hover hover:text-foreground sm:h-7 sm:px-1.5", selectedColumns.length >= 2 && "max-[480px]:hidden")} onClick={() => onChange ? apply({ kind: "insertRow", at: rows.length }) : onEdit(-1, nCols, "")}><Rows3 size={14} strokeWidth={1.7} /><span className="max-[480px]:sr-only">插入行</span></button>
        <button type="button" title="在右侧插入列" aria-label="在右侧插入列" className={cn("flex h-9 items-center gap-1 rounded px-2 text-[12px] hover:bg-hover hover:text-foreground sm:h-7 sm:px-1.5", selectedColumns.length >= 2 && "max-[480px]:hidden")} onClick={() => onChange ? apply({ kind: "insertCol", at: nCols }) : onEdit(-2, nCols, "")}><Columns3 size={14} strokeWidth={1.7} /><span className="max-[480px]:sr-only">插入列</span></button>
        {onHeader && <button type="button" title="标题行" aria-label="标题行" aria-pressed={header} className={cn("flex h-9 items-center gap-1 rounded px-2 text-[12px] hover:bg-hover sm:h-7 sm:px-1.5", header ? "text-primary" : "hover:text-foreground")} onMouseDown={(e) => e.preventDefault()} onClick={() => onHeader(!header)} data-table-header><Rows3 size={14} className="min-[481px]:hidden" /><span className="max-[480px]:sr-only">标题行</span></button>}
        {onHeaderColumn && <button type="button" title="标题列" aria-label="标题列" aria-pressed={headerColumn} className={cn("flex h-9 items-center gap-1 rounded px-2 text-[12px] hover:bg-hover sm:h-7 sm:px-1.5", headerColumn ? "text-primary" : "hover:text-foreground")} onMouseDown={(e) => e.preventDefault()} onClick={() => onHeaderColumn(!headerColumn)} data-table-header-column><Columns3 size={14} className="min-[481px]:hidden" /><span className="max-[480px]:sr-only">标题列</span></button>}
        {!multi && !axisSelection && <><span className="mx-0.5 h-4 w-px bg-border" />
        <button type="button" title="删除表格" aria-label="删除表格" className="grid size-9 place-items-center rounded hover:bg-hover hover:text-destructive sm:size-7" onClick={onDelete} data-table-del><Trash2 size={14} strokeWidth={1.7} /></button></>}
        {multi && selected && deletion && <><span className="mx-0.5 h-4 w-px bg-border" />
        <button type="button" title={deletion.kind === "rows" ? "删除选中行" : deletion.kind === "cols" ? "删除选中列" : "删除表格"} aria-label={deletion.kind === "rows" ? "删除选中行" : deletion.kind === "cols" ? "删除选中列" : "删除表格"} className="grid size-9 place-items-center rounded hover:bg-hover hover:text-destructive sm:size-7" onMouseDown={(e) => e.preventDefault()} onClick={() => { const error = onDeleteSelection?.(selected); setClipboardNotice(error ?? ""); if (!error) { setMoreOpen(false); setGrip(null); setRange(null); setTouchSelecting(false); } }} data-table-delete-selection={deletion.kind}><Trash2 size={14} strokeWidth={1.7} /></button></>}
      </span></div>}
      <div className={cn("max-w-full overflow-x-auto", editable && "-mt-4 pt-4")} data-table-scroll>
      <table className="table-fixed border-collapse text-[14px] leading-[22px]" style={{ width: columnWidths.reduce((total, width) => total + width, readOnly ? 0 : 24) }}>
        <colgroup>{columnWidths.map((width, ci) => <col key={ci} style={{ width }} data-table-column={ci} />)}{!readOnly && <col style={{ width: 24 }} />}</colgroup>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="group/row" data-table-title-row={ri === 0 ? "true" : undefined}>
              {row.map((cell, ci) => {
                const cov = cover.get(`${ri}:${ci}`);
                if (cov === "hidden") return null;
                const span = cov?.span;
                const sel = inRange(selected, ri, ci) || !!axisSelection?.indices.some(index => axisSelection.kind === "row" ? index >= ri && index < ri + (span?.[0] ?? 1) : index >= ci && index < ci + (span?.[1] ?? 1));
                const candidate = findByCell.get(`${ri}:${ci}`);
                const found = candidate?.value === cell ? candidate : undefined;
                const activeFind = found?.ranges.some((range) => range.active) ?? false;
                const showMirror = !!found && !(editing?.r === ri && editing.c === ci);
                const richSpans = tableCellRich(fillProps, ri, ci, cell);
                const hasRich = tableCellHasRichMarks(richSpans);
                const showRichOverlay = hasRich && !showMirror && !(editing?.r === ri && editing.c === ci);
                const uniformMarks = hasRich && richSpans.length === 1 ? richSpans[0].marks : undefined;
                return (
                  <td key={ci} rowSpan={span?.[0]} colSpan={span?.[1]} className={cn("relative min-w-[100px] border border-[#D9DBDF] p-0 align-top dark:border-border", (header && ri === 0 || headerColumn && ci === 0) && "bg-[#F5F6F7] font-medium dark:bg-sidebar", sel && "bg-[#E1EAFF] dark:bg-primary/20")} style={{ backgroundColor: tableCellFill(fillProps, ri, ci) || undefined, backgroundImage: sel && tableCellFill(fillProps, ri, ci) ? "linear-gradient(#3370ff33,#3370ff33)" : undefined, textAlign: tableCellAlign(fillProps, ri, ci, "horizontal"), verticalAlign: tableCellAlign(fillProps, ri, ci, "vertical") }} data-table-position={`${ri}:${ci}`} data-cell-selected={sel ? "true" : undefined} data-merged={span ? `${span[0]}x${span[1]}` : undefined} data-find-match={found ? "true" : undefined} data-find-active={activeFind ? "true" : undefined}>
                    {readOnly ? <span className="block min-h-[39px] whitespace-pre-wrap break-words px-2 py-[8.5px]">{found ? tableFindText(cell, found.ranges) : hasRich ? renderTableRichSpans(richSpans) : cell}</span> : (
                      <div className="relative grid">
                      <div aria-hidden="true" className="invisible col-start-1 row-start-1 max-h-[237px] min-h-[39px] overflow-hidden whitespace-pre-wrap break-words px-2 py-[8.5px]">{cell}{"\u200b"}</div>
                      {found && <div aria-hidden="true" data-table-find-overlay className={cn("pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-[8.5px]", !showMirror && "invisible")}>{tableFindText(cell, found.ranges)}{"\u200b"}</div>}
                      {hasRich && <div aria-hidden="true" data-table-rich-overlay className={cn("pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-[8.5px]", !showRichOverlay && "invisible")}>{renderTableRichSpans(richSpans)}{"\u200b"}</div>}
                      <textarea
                        value={cell}
                        style={{
                          textAlign: tableCellAlign(fillProps, ri, ci, "horizontal"),
                          fontWeight: uniformMarks?.bold ? 600 : undefined,
                          fontStyle: uniformMarks?.italic ? "italic" : undefined,
                          textDecoration: [uniformMarks?.underline && "underline", uniformMarks?.strike && "line-through"].filter(Boolean).join(" ") || undefined,
                          color: uniformMarks?.color || undefined,
                        }}
                        rows={Math.min(10, Math.max(1, cell.split("\n").length))}
                        onChange={(e) => {
                          if (multi) { e.currentTarget.value = cell; return; }
                          onEdit(ri, ci, e.target.value, (e.nativeEvent as InputEvent).inputType);
                        }}
                        onBeforeInput={(e) => { if (multi) e.preventDefault(); }}
                        onFocus={() => { setFocus({ r: ri, c: ci }); setEditing({ r: ri, c: ci }); }}
                        onBlur={(event) => { syncFindOverlay(event.currentTarget); setEditing(null); }}
                        onScroll={(event) => syncFindOverlay(event.currentTarget)}
                        onPointerDown={(event) => {
                          if (event.pointerType === "mouse" && event.button === 0 && !event.shiftKey) {
                            dragSelection.current = { pointerId: event.pointerId, r: ri, c: ci, active: false, x: event.clientX, y: event.clientY, source: event.currentTarget, restoreFocus: false, kind: "mouse" };
                          }
                        }}
                        onKeyDown={(e) => {
                          if (onRichMark && (e.metaKey || e.ctrlKey) && !e.altKey && !e.nativeEvent.isComposing) {
                            const key = e.key.toLowerCase();
                            const mark: TableCellMarkKey | null = !e.shiftKey && key === "b" ? "bold"
                              : !e.shiftKey && key === "i" ? "italic"
                              : !e.shiftKey && key === "u" ? "underline"
                              : !e.shiftKey && key === "e" ? "code"
                              : e.shiftKey && key === "s" ? "strike"
                              : null;
                            if (mark) {
                              e.preventDefault(); e.stopPropagation();
                              const target: TableFormatTarget = formatTarget ?? { kind: "range", range: { r0: ri, r1: ri, c0: ci, c1: ci } };
                              const rangeSel = !multi && e.currentTarget.selectionStart < e.currentTarget.selectionEnd
                                ? { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd }
                                : undefined;
                              setClipboardNotice(onRichMark(target, mark, undefined, rangeSel) ?? "");
                              return;
                            }
                          }
                          if (multi && selected && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === "Backspace" || e.key === "Delete")) {
                            e.preventDefault(); e.stopPropagation();
                            setClipboardNotice(onClearCells?.(selected) ?? (onClearCells ? "" : "当前无法清空选区，表格未修改。"));
                            return;
                          }
                          if (multi && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); return; }
                          if (e.key !== "Tab" || e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
                          const cells = [...(root.current?.querySelectorAll<HTMLTextAreaElement>("[data-table-cell]") ?? [])];
                          const intent = tableTabIntent(cells.indexOf(e.currentTarget), cells.length, e.shiftKey);
                          e.preventDefault(); e.stopPropagation();
                          if (intent.kind === "focus") {
                            setRange(null); setGrip(null); setTouchSelecting(false); setMoreOpen(false);
                            const next = cells[intent.index]; next.focus();
                            const at = intent.caret === "start" ? 0 : next.value.length;
                            next.setSelectionRange(at, at);
                          } else if (intent.kind === "append") {
                            if (!onAppendRow) { setClipboardNotice("当前无法添加新行，表格未修改。"); return; }
                            pendingTab.current = { source: e.currentTarget, row: rows.length, cols: nCols };
                            const error = onAppendRow();
                            if (error) pendingTab.current = null;
                            else { setRange(null); setGrip(null); setTouchSelecting(false); setMoreOpen(false); }
                            setClipboardNotice(error ?? "");
                          }
                        }}
                        onPaste={(e) => {
                          const text = e.clipboardData.getData("text/plain");
                          const structured = /[\t\r\n]/.test(text);
                          const html = e.clipboardData.getData("text/html");
                          const own = parseTableRichHTML(html, text);
                          const external = !own && (structured || multi) ? parseExternalTableHTML(html, text) : null;
                          const rich = own ?? external?.clipboard ?? null;
                          if (!multi && (!onPasteCells || !structured && !rich)) return;
                          e.preventDefault(); e.stopPropagation();
                          if (!e.clipboardData.types.includes("text/plain") || (!text && !rich)) return;
                          if (!onPasteCells) { setClipboardNotice("当前无法粘贴到选区，表格未修改。"); return; }
                          const start = multi && selected ? { r: selected.r0, c: selected.c0 } : { r: ri, c: ci };
                          const error = onPasteCells(start.r, start.c, text, !structured, rich ?? undefined);
                          setClipboardNotice(error ?? (external?.lostFormatting ? "已粘贴表格，部分格式可能未保留。" : !rich && /<table\b/i.test(html) ? "表格格式未能识别，已按纯文本粘贴。" : ""));
                          if (!error) {
                            setRange(null); setGrip(null); setTouchSelecting(false); setMoreOpen(false);
                            if (multi) {
                              const target = root.current?.querySelector<HTMLTextAreaElement>(`[data-table-cell="${start.r}:${start.c}"]`);
                              if (target) { target.focus(); requestAnimationFrame(() => { if (document.activeElement === target) target.setSelectionRange(target.value.length, target.value.length); }); }
                            }
                          }
                        }}
                        onMouseDown={(e) => {
                          setMoreOpen(false);
                          setFillOpen(false);
                          setAlignOpen(false);
                          setTextColorOpen(false);
                          setGrip(null);
                          setAxisSelection(null);
                          setTouchSelecting(false);
                          if (e.shiftKey && focus) { e.preventDefault(); setRange(normRange({ r0: focus.r, c0: focus.c, r1: ri, c1: ci })); }
                          else setRange(null);
                        }}
                        className={cn("relative col-start-1 row-start-1 block h-full max-h-[237px] min-h-[39px] w-full resize-none bg-transparent px-2 py-[8.5px] outline-none", multi && sel ? "caret-transparent" : "focus:shadow-[inset_0_0_0_2px_#3370FF]", (showMirror || showRichOverlay) && "text-transparent")}
                        data-table-cell={`${ri}:${ci}`}
                      />
                      </div>
                    )}
                    {editable && touchRange && (touchSelecting || editing) && (() => {
                      const first = ri === touchRange.r0 && ci === touchRange.c0;
                      const last = ri + (span?.[0] ?? 1) - 1 === touchRange.r1 && ci + (span?.[1] ?? 1) - 1 === touchRange.c1;
                      const handle = (corner: "start" | "end") => <button key={corner} type="button" aria-label={corner === "start" ? "调整选区起点" : "调整选区终点"} title="拖动或使用方向键调整选区" className={cn("absolute z-20 hidden size-8 touch-none items-center justify-center [@media(pointer:coarse)]:flex", corner === "start" ? "left-0 -top-4" : "bottom-0 right-0")} onPointerDown={e => beginTouchSelection(e, corner)} onKeyDown={e => moveTouchSelectionWithKey(e, corner)} data-table-touch-handle={corner}><span className={cn("size-3 rounded-full border-2 border-white bg-primary shadow", corner === "end" && "absolute bottom-0 right-0")} /></button>;
                      return <>{touchSelecting && first && handle("start")}{last && handle("end")}</>;
                    })()}
                    {editable && ri === 0 && <span className="pointer-events-none absolute -top-[14px] left-0 right-0 flex h-[10px] [@media(pointer:coarse)]:-top-4 [@media(pointer:coarse)]:h-4">{Array.from({ length: span?.[1] ?? 1 }, (_, offset) => renderGrip("col", ci + offset, colW(ci + offset)))}</span>}
                    {!readOnly && onBeginResize && ri === 0 && Array.from({ length: span?.[1] ?? 1 }, (_, offset) => {
                      const index = ci + offset, trailing = columnWidths.slice(index + 1, ci + (span?.[1] ?? 1)).reduce((sum, width) => sum + width, 0);
                      return <div key={index} role="separator" tabIndex={0} aria-orientation="vertical" aria-label={`调整第 ${index + 1} 列宽`} aria-valuemin={100} aria-valuemax={100000} aria-valuenow={Math.round(colW(index))} style={{ right: trailing, transform: "translateX(50%)" }} className={cn("absolute top-0 z-10 h-full w-[6px] touch-none cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 hover:after:bg-primary/60 focus-visible:after:bg-primary/60 [@media(pointer:coarse)]:w-4", span && offset < span[1] - 1 && "[@media(pointer:coarse)]:h-4", widthDrag.current?.index === index && "after:bg-primary")} onPointerDown={(e) => startResize(e, index)} onPointerMove={moveResize} onPointerUp={(e) => endResize(e)} onPointerCancel={(e) => endResize(e, true)} onLostPointerCapture={(e) => endResize(e, true)} onKeyDown={(e) => {
                      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                      const session = onBeginResize(index);
                      if (!session) return;
                      e.preventDefault(); e.stopPropagation();
                      const next = [...columnWidths]; next[index] = Math.max(100, Math.min(100000, next[index] + (e.key === "ArrowLeft" ? -10 : 10)));
                      if (next[index] === columnWidths[index]) session.cancel(); else commitResize(session, next);
                    }} data-table-resize={index} />;
                    })}
                  </td>
                );
              })}
              {!readOnly && <td className="w-6 border-0 p-0 align-middle">
                <button type="button" className="invisible grid size-5 place-items-center rounded text-subtle hover:bg-hover hover:text-destructive group-hover/row:visible" title="删除此行" aria-label="删除此行" onClick={() => (onChange ? apply({ kind: "deleteRow", index: ri }) : onEdit(-3, ri, ""))} data-table-del-row={ri}><X size={12} /></button>
              </td>}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {editable && rows.map((_, index) => <span key={index} className="pointer-events-none absolute left-0 z-20 flex w-[10px] [@media(pointer:coarse)]:w-4" style={{ top: rowBounds[index]?.top ?? 0, height: rowBounds[index]?.height ?? 0 }}>{renderGrip("row", index, 1)}</span>)}
      {widthGuide && <div aria-hidden="true" data-table-width-guide={widthGuide.kind} className={cn("pointer-events-none absolute z-40 w-0", widthGuide.kind === "equal" ? "border-l-[3px] border-primary" : widthGuide.kind === "table" ? "border-l-2 border-dashed border-primary" : "w-[2px] bg-gradient-to-b from-transparent via-[#3370FF] to-transparent")} style={{ left: widthGuide.x, top: widthGuide.top, height: widthGuide.bottom - widthGuide.top }} />}
      {reorderGuide && <div aria-hidden="true" className={cn("pointer-events-none absolute z-40 rounded-full",reorderGuide.valid?"bg-primary":"bg-destructive")} style={{left:reorderGuide.left,top:reorderGuide.top,width:reorderGuide.width,height:reorderGuide.height}} data-table-reorder-guide data-valid={reorderGuide.valid ? "true" : "false"} />}
      {editable && grip && !gripMenuHidden && (
        <div role="menu" style={{ left: menuAt?.x ?? 16, top: menuAt?.y ?? 16 }} className="absolute z-40 w-36 rounded-lg border bg-surface p-1 text-[13px] font-normal shadow-[0_6px_24px_rgba(31,35,41,0.12)]" data-table-grip-menu={grip.kind}>
          {gripMenu(grip, rows.length, nCols, rows, merges).map((it) => <Fragment key={it.label}>{(it.danger || it.op.kind === "moveRow" && it.label === "上移一行" || it.op.kind === "moveCol" && it.label === "左移一列") && <div className="my-1 border-t" />}<button type="button" role="menuitem" disabled={it.disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(it.op)} className={cn("block w-full rounded px-2 py-1.5 text-left hover:bg-hover disabled:opacity-40", it.danger && "text-destructive")} data-table-op={it.op.kind}>{it.label}</button></Fragment>)}
        </div>
      )}
      {clipboardNotice && <div role="status" className={cn("mt-2 flex items-start gap-2 text-[12px]", clipboardNotice === "已复制选区" || clipboardNotice === "已复制纯文本" ? "text-primary" : "text-[#b54a23]")}><span>{clipboardNotice}</span><button type="button" aria-label="关闭提示" onClick={() => setClipboardNotice("")}><X size={14} /></button></div>}
      {!readOnly && <>
        <button type="button" title="添加一行" aria-label="添加一行" className="absolute bottom-0 left-4 right-10 hidden h-3.5 place-items-center rounded-[3px] bg-[#EFF0F1] text-subtle hover:bg-primary/15 hover:text-primary group-hover/t:grid dark:bg-hover" onClick={() => (onChange ? apply({ kind: "insertRow", at: rows.length }) : onEdit(-1, nCols, ""))} data-table-add-row><Plus size={11} strokeWidth={2.2} /></button>
        <button type="button" title="添加一列" aria-label="添加一列" className="absolute bottom-4 right-0 top-4 hidden w-3.5 place-items-center rounded-[3px] bg-[#EFF0F1] text-subtle hover:bg-primary/15 hover:text-primary group-hover/t:grid dark:bg-hover" onClick={() => (onChange ? apply({ kind: "insertCol", at: nCols }) : onEdit(-2, nCols, ""))} data-table-add-col><Plus size={11} strokeWidth={2.2} /></button>
      </>}
    </div>
  );
}
