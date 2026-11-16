import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlignCenter, AlignCenterHorizontal, AlignEndHorizontal, AlignLeft, AlignRight, AlignStartHorizontal, Columns3, Combine, Copy, Eraser, LayoutGrid, PaintBucket, Plus, Rows3, SquareSplitHorizontal, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseTableData } from "./model";
import { applyTableOp, canMove, coverMap, expandRange, mergeCells, normRange, parseMerges, planSelectionDelete, remapWidths, splitCell, type CellRange, type Merge, type TableOp, type Widths } from "./table-ops";
import { formatTableTSV } from "./table-clipboard";
import { parseTableRichHTML, tableRichHTML, type RichTableClipboard } from "./table-rich-clipboard";
import { parseExternalTableHTML } from "./table-external-clipboard";
import { tableTabIntent } from "./table-keyboard";
import { tableSelectionScrollSpeed, tableVerticalScrollParent } from "./table-selection-scroll";
import { useTableStickyHeader } from "./table-sticky-header";
import { visibleTableWidths } from "./table-widths";
import { tableCellAlign, tableCellFill, type TableAlign, type TableAlignAxis } from "./table-cells";

type GripSel = { kind: "row" | "col"; index: number };
export type TableResizeSession = { commit: (widths: number[]) => void | Promise<void>; cancel: () => void };

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

export function TableBlock({ data, merges: rawMerges, widths, fillProps = {}, header = true, headerColumn = false, onHeader, onHeaderColumn, onBeginResize, onEdit, onChange, onFill, onAlign, onPasteCells, onCutCells, onClearCells, onAppendRow, onDeleteSelection, onDelete, readOnly, canCopy = true, initialGrip = null, findCells = [], findNavigation = 0 }: {
  data: string; merges?: string; widths?: Widths; header?: boolean; headerColumn?: boolean; onHeader?: (on: boolean) => void; onHeaderColumn?: (on: boolean) => void;
  fillProps?: Record<string, string>; onFill?: (range: CellRange, fill: string) => string | null;
  onAlign?: (range: CellRange, axis: TableAlignAxis, align: TableAlign) => string | null;
  onBeginResize?: (index: number) => TableResizeSession | null;
  onEdit: (r: number, c: number, v: string, kind?: string) => void;
  /** 结构/合并修改：一次写入 tableData 与 tableMerges。 */
  onChange?: (rows: string[][], merges: Merge[], widths?: Widths, op?: TableOp) => void;
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
  const merges = useMemo(() => parseMerges(rawMerges, rows.length, nCols), [rawMerges, rows.length, nCols]);
  const cover = useMemo(() => coverMap(merges), [merges]);
  const findByCell = useMemo(() => new Map(findCells.map((item) => [`${item.row}:${item.col}`, item])), [findCells]);
  const [grip, setGrip] = useState<GripSel | null>(initialGrip);
  const [gripMenuHidden, setGripMenuHidden] = useState(false);
  const [range, setRange] = useState<CellRange | null>(null);
  const [touchSelecting, setTouchSelecting] = useState(false);
  const [focus, setFocus] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [clipboardNotice, setClipboardNotice] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);
  const [alignOpen, setAlignOpen] = useState(false);
  const [widthPreview, setWidthPreview] = useState<number[] | null>(null);
  const widthDrag = useRef<{ pointer: number; index: number; startX: number; initial: number[]; next: number[]; session: TableResizeSession; target: HTMLElement } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !widthDrag.current) return;
      event.preventDefault();
      const drag = widthDrag.current; widthDrag.current = null; setWidthPreview(null); drag.session.cancel();
      if (drag.target.hasPointerCapture(drag.pointer)) drag.target.releasePointerCapture(drag.pointer);
    };
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); widthDrag.current?.session.cancel(); widthDrag.current = null; };
  }, []);
  useTableStickyHeader(root, header);
  const pendingTab = useRef<{ source: HTMLTextAreaElement; row: number; cols: number } | null>(null);
  const dragSelection = useRef<{ pointerId: number; r: number; c: number; active: boolean; x: number; y: number; source: HTMLTextAreaElement; restoreFocus: boolean; kind: "mouse" | "touch"; previousRange?: CellRange | null; previousTouch?: boolean } | null>(null);
  const selectionSignature = JSON.stringify([data, rawMerges ?? "", fillProps["tbl.rows"] ?? "", fillProps["tbl.cols"] ?? "", readOnly]);
  const previousSelectionSignature = useRef(selectionSignature);
  useLayoutEffect(() => {
    if (previousSelectionSignature.current === selectionSignature) return;
    previousSelectionSignature.current = selectionSignature;
    if (!touchSelecting) return;
    const drag = dragSelection.current;
    dragSelection.current = null;
    if (drag?.kind === "touch" && root.current?.hasPointerCapture(drag.pointerId)) root.current.releasePointerCapture(drag.pointerId);
    setRange(null); setTouchSelecting(false); setFillOpen(false); setAlignOpen(false); setMoreOpen(false);
  }, [selectionSignature, touchSelecting]);
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
    setMoreOpen(false);
    setFillOpen(false);
    setAlignOpen(false);
    setGripMenuHidden(false);
    setTouchSelecting(false);
    setRange(null);
    const same = grip?.kind === g.kind && grip?.index === g.index;
    const box = root.current?.getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect();
    if (box) setMenuAt(g.kind === "col" ? { x: b.left - box.left, y: b.bottom - box.top + 4 } : { x: b.right - box.left + 4, y: b.top - box.top });
    setGrip(same ? null : g);
  };
  useEffect(() => {
    if (!grip && !range && !moreOpen && !fillOpen && !alignOpen) return;
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) { setGrip(null); setRange(null); setTouchSelecting(false); setMoreOpen(false); setFillOpen(false); setAlignOpen(false); } };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [grip, range, moreOpen, fillOpen, alignOpen]);
  const columnWidths = widthPreview ?? visibleTableWidths(rows, widths);
  const colW = (ci: number) => columnWidths[ci] ?? 100;
  const startResize = (e: React.PointerEvent<HTMLElement>, ci: number) => {
    if (widthDrag.current || e.button !== 0 || ci < 0 || ci >= nCols) return;
    const session = onBeginResize?.(ci);
    if (!session) return;
    e.preventDefault(); e.stopPropagation();
    const initial = [...columnWidths], target = e.currentTarget;
    widthDrag.current = { pointer: e.pointerId, index: ci, startX: e.clientX, initial, next: initial, session, target };
    target.setPointerCapture(e.pointerId);
  };
  const moveResize = (e: React.PointerEvent<HTMLElement>) => {
    const drag = widthDrag.current;
    if (!drag || drag.pointer !== e.pointerId) return;
    e.preventDefault();
    const value = Math.max(100, Math.min(100000, Math.round(drag.initial[drag.index] + e.clientX - drag.startX)));
    drag.next = drag.initial.map((width, index) => index === drag.index ? value : width);
    setWidthPreview(drag.next);
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
    widthDrag.current = null;
    if (cancelled || drag.initial.every((value, index) => value === drag.next[index])) { setWidthPreview(null); drag.session.cancel(); }
    else commitResize(drag.session, drag.next);
    if (drag.target.hasPointerCapture(drag.pointer)) drag.target.releasePointerCapture(drag.pointer);
  };
  const rawSelected: CellRange | null = grip ? (grip.kind === "row" ? { r0: grip.index, r1: grip.index, c0: 0, c1: nCols - 1 } : { r0: 0, r1: rows.length - 1, c0: grip.index, c1: grip.index }) : range;
  const selected = rawSelected ? expandRange(rawSelected, merges) : null;
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
  const formatTarget = selected ?? (focus ? expandRange({ r0: focus.r, r1: focus.r, c0: focus.c, c1: focus.c }, merges) : null);
  const allAligned = (axis: TableAlignAxis, value: TableAlign) => {
    if (!formatTarget) return false;
    for (let r = formatTarget.r0; r <= formatTarget.r1; r++) for (let c = formatTarget.c0; c <= formatTarget.c1; c++) if (tableCellAlign(fillProps, r, c, axis) !== value) return false;
    return true;
  };
  const multi = !!selected && (selected.r0 !== selected.r1 || selected.c0 !== selected.c1);
  const deletion = selected && onDeleteSelection ? planSelectionDelete(rows, merges, widths, selected) : null;
  const focusMerge = focus && splitCell(merges, focus.r, focus.c) !== null;
  const apply = (op: TableOp) => { const res = applyTableOp(rows, merges, op); onChange?.(res.rows, res.merges, remapWidths(widths, op, nCols), op); setGrip(null); setRange(null); setTouchSelecting(false); };
  const merge = () => { if (!selected) return; const res = mergeCells(rows, merges, selected); if (res) onChange?.(res.rows, res.merges); setGrip(null); setRange(null); setTouchSelecting(false); };
  const split = () => { if (!focus) return; const m = splitCell(merges, focus.r, focus.c); if (m) onChange?.(rows, m); };
  const editable = !readOnly && !!onChange;
  return (
    <div ref={root} contentEditable={false} className={cn("group/t relative my-2 w-fit max-w-full select-none sm:mt-3", !readOnly && "sm:pb-4 sm:pr-4")} data-table-block data-table-touch-selecting={touchSelecting ? "true" : undefined}
      onKeyDown={(event) => { if (event.key === "Escape" && (moreOpen || fillOpen || alignOpen)) { event.preventDefault(); event.stopPropagation(); setMoreOpen(false); setFillOpen(false); setAlignOpen(false); } }}
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
      {!readOnly && <div className="pointer-events-none relative z-30 sm:h-11"><span className={cn("pointer-events-auto mb-4 w-max max-w-[calc(100vw-32px)] items-center gap-0.5 whitespace-nowrap rounded-lg border bg-surface p-0.5 text-subtle shadow-[0_4px_16px_rgba(31,35,41,0.12)] sm:absolute sm:bottom-4 sm:left-0 sm:mb-0", multi || moreOpen || fillOpen || alignOpen || touchSelecting ? "flex" : "hidden group-focus-within/t:flex sm:invisible sm:flex sm:group-hover/t:visible sm:group-focus-within/t:visible")} data-table-toolbar>
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
        {onFill && <span className="relative flex">
          <button type="button" title="单元格背景色" aria-label="单元格背景色" aria-haspopup="menu" aria-expanded={fillOpen} disabled={!selected && !focus} className={cn("grid size-9 place-items-center rounded hover:bg-hover hover:text-foreground disabled:opacity-40 sm:size-7", fillOpen && "bg-hover")} onMouseDown={(e) => e.preventDefault()} onClick={() => { setMoreOpen(false); setAlignOpen(false); setGripMenuHidden(true); setFillOpen(open => !open); }} data-table-fill><PaintBucket size={15} strokeWidth={1.7} /></button>
          {fillOpen && <span role="menu" aria-label="单元格背景色" className="absolute left-0 top-9 z-40 w-[230px] rounded-lg border border-[#DEE0E3] bg-surface p-2 text-[13px] text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border" data-table-fill-menu>
            <span className="block px-1 pb-2 text-xs text-muted-foreground">背景颜色</span>
            <span className="grid grid-cols-6 gap-1">{["#FFFFFF", "#F2F3F5", "#FBE4E2", "#FFF1D1", "#E5F5E8", "#E3ECFF", "#DEE0E3", "#F7C6C2", "#FCE2A8", "#BDEBC7", "#BFD3FF", "#E8D9FC"].map(color => <button key={color} type="button" role="menuitem" aria-label={color} title={color} className="size-8 rounded border border-black/10 hover:outline hover:outline-2 hover:outline-primary" style={{ backgroundColor: color }} onMouseDown={e => e.preventDefault()} onClick={() => { const target = selected ?? (focus ? { r0: focus.r, r1: focus.r, c0: focus.c, c1: focus.c } : null); if (target) setClipboardNotice(onFill(expandRange(target, merges), color) ?? ""); setFillOpen(false); }} data-table-fill-color={color} />)}</span>
            <button type="button" role="menuitem" className="mt-2 h-8 w-full rounded px-1 text-left hover:bg-hover" onMouseDown={e => e.preventDefault()} onClick={() => { const target = selected ?? (focus ? { r0: focus.r, r1: focus.r, c0: focus.c, c1: focus.c } : null); if (target) setClipboardNotice(onFill(expandRange(target, merges), "") ?? ""); setFillOpen(false); }} data-table-fill-reset>恢复默认</button>
          </span>}
        </span>}
        {onAlign && <span className="relative flex">
          <button type="button" title="单元格文本对齐" aria-label="单元格文本对齐" aria-haspopup="menu" aria-expanded={alignOpen} disabled={!formatTarget} className={cn("grid size-9 place-items-center rounded hover:bg-hover hover:text-foreground disabled:opacity-40 sm:size-7", alignOpen && "bg-hover")} onMouseDown={e => e.preventDefault()} onClick={() => { setMoreOpen(false); setFillOpen(false); setGripMenuHidden(true); setAlignOpen(open => !open); }} data-table-align><AlignLeft size={15} strokeWidth={1.7} /></button>
          {alignOpen && <span role="menu" aria-label="单元格文本对齐" className="absolute left-0 top-9 z-40 w-[160px] rounded-lg border border-[#DEE0E3] bg-surface p-2 text-[13px] text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border" data-table-align-menu>
            {([ ["horizontal", "横向对齐", [["left", "左对齐", AlignLeft], ["center", "水平居中", AlignCenter], ["right", "右对齐", AlignRight]]], ["vertical", "纵向对齐", [["top", "顶部对齐", AlignStartHorizontal], ["middle", "垂直居中", AlignCenterHorizontal], ["bottom", "底部对齐", AlignEndHorizontal]]] ] as const).map(([axis, label, choices]) => <span key={axis} className="block"><span className="block px-1 py-1 text-xs text-muted-foreground">{label}</span><span className="flex gap-1">{choices.map(([value, title, Icon]) => <button key={value} type="button" role="menuitemradio" aria-checked={allAligned(axis, value)} aria-label={title} title={title} className={cn("grid size-10 place-items-center rounded hover:bg-hover", allAligned(axis, value) && "bg-[#E1EAFF] text-primary")} onMouseDown={e => e.preventDefault()} onClick={() => { if (formatTarget) setClipboardNotice(onAlign(formatTarget, axis, value) ?? ""); setAlignOpen(false); }} data-table-align-option={`${axis}:${value}`}><Icon size={16} strokeWidth={1.7} /></button>)}</span></span>)}
          </span>}
        </span>}
        <button type="button" title="在下方插入行" aria-label="在下方插入行" className="flex h-9 items-center gap-1 rounded px-2 text-[12px] hover:bg-hover hover:text-foreground sm:h-7 sm:px-1.5" onClick={() => onEdit(-1, nCols, "")}><Rows3 size={14} strokeWidth={1.7} /><span className="max-[480px]:sr-only">插入行</span></button>
        <button type="button" title="在右侧插入列" aria-label="在右侧插入列" className="flex h-9 items-center gap-1 rounded px-2 text-[12px] hover:bg-hover hover:text-foreground sm:h-7 sm:px-1.5" onClick={() => onEdit(-2, nCols, "")}><Columns3 size={14} strokeWidth={1.7} /><span className="max-[480px]:sr-only">插入列</span></button>
        {onHeader && <button type="button" title="标题行" aria-label="标题行" aria-pressed={header} className={cn("flex h-9 items-center gap-1 rounded px-2 text-[12px] hover:bg-hover sm:h-7 sm:px-1.5", header ? "text-primary" : "hover:text-foreground")} onMouseDown={(e) => e.preventDefault()} onClick={() => onHeader(!header)} data-table-header><Rows3 size={14} className="min-[481px]:hidden" /><span className="max-[480px]:sr-only">标题行</span></button>}
        {onHeaderColumn && <button type="button" title="标题列" aria-label="标题列" aria-pressed={headerColumn} className={cn("flex h-9 items-center gap-1 rounded px-2 text-[12px] hover:bg-hover sm:h-7 sm:px-1.5", headerColumn ? "text-primary" : "hover:text-foreground")} onMouseDown={(e) => e.preventDefault()} onClick={() => onHeaderColumn(!headerColumn)} data-table-header-column><Columns3 size={14} className="min-[481px]:hidden" /><span className="max-[480px]:sr-only">标题列</span></button>}
        {!multi && <><span className="mx-0.5 h-4 w-px bg-border" />
        <button type="button" title="删除表格" aria-label="删除表格" className="grid size-9 place-items-center rounded hover:bg-hover hover:text-destructive sm:size-7" onClick={onDelete} data-table-del><Trash2 size={14} strokeWidth={1.7} /></button></>}
        {multi && selected && deletion && <><span className="mx-0.5 h-4 w-px bg-border" />
        <button type="button" title={deletion.kind === "rows" ? "删除选中行" : deletion.kind === "cols" ? "删除选中列" : "删除表格"} aria-label={deletion.kind === "rows" ? "删除选中行" : deletion.kind === "cols" ? "删除选中列" : "删除表格"} className="grid size-9 place-items-center rounded hover:bg-hover hover:text-destructive sm:size-7" onMouseDown={(e) => e.preventDefault()} onClick={() => { const error = onDeleteSelection?.(selected); setClipboardNotice(error ?? ""); if (!error) { setMoreOpen(false); setGrip(null); setRange(null); setTouchSelecting(false); } }} data-table-delete-selection={deletion.kind}><Trash2 size={14} strokeWidth={1.7} /></button></>}
      </span></div>}
      <div className={cn("max-w-full overflow-x-auto", editable && "-ml-4 -mt-4 pl-4 pt-4")} data-table-scroll>
      <table className="table-fixed border-collapse text-[14px] leading-[22px]" style={{ width: columnWidths.reduce((total, width) => total + width, readOnly ? 0 : 24) }}>
        <colgroup>{columnWidths.map((width, ci) => <col key={ci} style={{ width }} />)}{!readOnly && <col style={{ width: 24 }} />}</colgroup>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="group/row" data-table-title-row={ri === 0 ? "true" : undefined}>
              {row.map((cell, ci) => {
                const cov = cover.get(`${ri}:${ci}`);
                if (cov === "hidden") return null;
                const span = cov?.span;
                const sel = inRange(selected, ri, ci);
                const candidate = findByCell.get(`${ri}:${ci}`);
                const found = candidate?.value === cell ? candidate : undefined;
                const activeFind = found?.ranges.some((range) => range.active) ?? false;
                const showMirror = !!found && !(editing?.r === ri && editing.c === ci);
                return (
                  <td key={ci} rowSpan={span?.[0]} colSpan={span?.[1]} className={cn("relative min-w-[100px] border border-[#D9DBDF] p-0 align-top dark:border-border", (header && ri === 0 || headerColumn && ci === 0) && "bg-[#F5F6F7] font-medium dark:bg-sidebar", sel && "bg-[#E1EAFF] dark:bg-primary/20")} style={{ backgroundColor: tableCellFill(fillProps, ri, ci) || undefined, backgroundImage: sel && tableCellFill(fillProps, ri, ci) ? "linear-gradient(#3370ff33,#3370ff33)" : undefined, textAlign: tableCellAlign(fillProps, ri, ci, "horizontal"), verticalAlign: tableCellAlign(fillProps, ri, ci, "vertical") }} data-table-position={`${ri}:${ci}`} data-cell-selected={sel ? "true" : undefined} data-merged={span ? `${span[0]}x${span[1]}` : undefined} data-find-match={found ? "true" : undefined} data-find-active={activeFind ? "true" : undefined}>
                    {readOnly ? <span className="block min-h-[39px] whitespace-pre-wrap break-words px-2 py-[8.5px]">{found ? tableFindText(cell, found.ranges) : cell}</span> : (
                      <div className="relative grid">
                      <div aria-hidden="true" className="invisible col-start-1 row-start-1 max-h-[237px] min-h-[39px] overflow-hidden whitespace-pre-wrap break-words px-2 py-[8.5px]">{cell}{"\u200b"}</div>
                      {found && <div aria-hidden="true" data-table-find-overlay className={cn("pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-[8.5px]", !showMirror && "invisible")}>{tableFindText(cell, found.ranges)}{"\u200b"}</div>}
                      <textarea
                        value={cell}
                        style={{ textAlign: tableCellAlign(fillProps, ri, ci, "horizontal") }}
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
                          setGrip(null);
                          setTouchSelecting(false);
                          if (e.shiftKey && focus) { e.preventDefault(); setRange(normRange({ r0: focus.r, c0: focus.c, r1: ri, c1: ci })); }
                          else setRange(null);
                        }}
                        className={cn("relative col-start-1 row-start-1 block h-full max-h-[237px] min-h-[39px] w-full resize-none bg-transparent px-2 py-[8.5px] outline-none", multi && sel ? "caret-transparent" : "focus:shadow-[inset_0_0_0_2px_#3370FF]", showMirror && "text-transparent")}
                        data-table-cell={`${ri}:${ci}`}
                      />
                      </div>
                    )}
                    {editable && touchRange && (touchSelecting || editing) && (() => {
                      const first = ri === touchRange.r0 && ci === touchRange.c0;
                      const last = ri + (span?.[0] ?? 1) - 1 === touchRange.r1 && ci + (span?.[1] ?? 1) - 1 === touchRange.c1;
                      const handle = (corner: "start" | "end") => <button key={corner} type="button" aria-label={corner === "start" ? "调整选区起点" : "调整选区终点"} title="拖动或使用方向键调整选区" className={cn("absolute z-20 hidden size-8 touch-none items-center justify-center [@media(pointer:coarse)]:flex", corner === "start" ? "-left-4 -top-4" : "bottom-0 right-0")} onPointerDown={e => beginTouchSelection(e, corner)} onKeyDown={e => moveTouchSelectionWithKey(e, corner)} data-table-touch-handle={corner}><span className={cn("size-3 rounded-full border-2 border-white bg-primary shadow", corner === "end" && "absolute bottom-0 right-0")} /></button>;
                      return <>{touchSelecting && first && handle("start")}{last && handle("end")}</>;
                    })()}
                    {editable && ri === 0 && !span?.[1] && <button type="button" aria-label={`选择第 ${ci + 1} 列`} title="选择整列" onMouseDown={(e) => e.preventDefault()} onClick={(e) => openGrip(e, { kind: "col", index: ci })} className={cn("absolute -top-[14px] left-0 right-0 h-[10px] rounded-[3px] bg-[#EFF0F1] opacity-0 hover:bg-primary/30 group-hover/t:opacity-100 dark:bg-hover", grip?.kind === "col" && grip.index === ci && "bg-primary opacity-100")} data-table-col-grip={ci} />}
                    {editable && ci === 0 && !span?.[0] && <button type="button" aria-label={`选择第 ${ri + 1} 行`} title="选择整行" onMouseDown={(e) => e.preventDefault()} onClick={(e) => openGrip(e, { kind: "row", index: ri })} className={cn("absolute -left-[14px] bottom-0 top-0 w-[10px] rounded-[3px] bg-[#EFF0F1] opacity-0 hover:bg-primary/30 group-hover/t:opacity-100 dark:bg-hover", grip?.kind === "row" && grip.index === ri && "bg-primary opacity-100")} data-table-row-grip={ri} />}
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
