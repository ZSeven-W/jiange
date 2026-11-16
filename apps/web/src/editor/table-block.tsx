import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Columns3, Combine, LayoutGrid, Plus, Rows3, SquareSplitHorizontal, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseTableData } from "./model";
import { applyTableOp, canMove, coverMap, expandRange, mergeCells, normRange, parseMerges, planSelectionDelete, remapWidths, splitCell, type CellRange, type Merge, type TableOp, type Widths } from "./table-ops";
import { formatTableTSV } from "./table-clipboard";
import { tableTabIntent } from "./table-keyboard";
import { tableSelectionScrollSpeed, tableVerticalScrollParent } from "./table-selection-scroll";
import { useTableStickyHeader } from "./table-sticky-header";
import { visibleTableWidths } from "./table-widths";

type GripSel = { kind: "row" | "col"; index: number };

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

export function TableBlock({ data, merges: rawMerges, widths, header = true, headerColumn = false, onHeader, onHeaderColumn, onWidths, onEdit, onChange, onPasteCells, onCutCells, onClearCells, onAppendRow, onDeleteSelection, onDelete, readOnly, canCopy = true, initialGrip = null, findCells = [], findNavigation = 0 }: {
  data: string; merges?: string; widths?: Widths; header?: boolean; headerColumn?: boolean; onHeader?: (on: boolean) => void; onHeaderColumn?: (on: boolean) => void;
  onWidths?: (w: number[]) => void;
  onEdit: (r: number, c: number, v: string, kind?: string) => void;
  /** 结构/合并修改：一次写入 tableData 与 tableMerges。 */
  onChange?: (rows: string[][], merges: Merge[], widths?: Widths) => void;
  onPasteCells?: (r: number, c: number, text: string, literal?: boolean) => string | null;
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
  const [range, setRange] = useState<CellRange | null>(null);
  const [focus, setFocus] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [clipboardNotice, setClipboardNotice] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useTableStickyHeader(root, header);
  const pendingTab = useRef<{ source: HTMLTextAreaElement; row: number; cols: number } | null>(null);
  const dragSelection = useRef<{ pointerId: number; r: number; c: number; active: boolean; x: number; y: number; source: HTMLTextAreaElement; restoreFocus: boolean } | null>(null);
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
    const stop = (event: PointerEvent) => {
      const drag = dragSelection.current;
      if (drag?.pointerId !== event.pointerId) return;
      dragSelection.current = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (drag.active && drag.restoreFocus) requestAnimationFrame(() => {
        if (!dragSelection.current && drag.source.isConnected && document.activeElement === document.body) drag.source.focus({ preventScroll: true });
      });
    };
    const blur = () => { dragSelection.current = null; if (frame) cancelAnimationFrame(frame); frame = 0; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", blur);
    return () => {
      blur();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", blur);
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
    setRange(null);
    const same = grip?.kind === g.kind && grip?.index === g.index;
    const box = root.current?.getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect();
    if (box) setMenuAt(g.kind === "col" ? { x: b.left - box.left, y: b.bottom - box.top + 4 } : { x: b.right - box.left + 4, y: b.top - box.top });
    setGrip(same ? null : g);
  };
  useEffect(() => {
    if (!grip && !range && !moreOpen) return;
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) { setGrip(null); setRange(null); setMoreOpen(false); } };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [grip, range, moreOpen]);
  const columnWidths = visibleTableWidths(rows, widths);
  const colW = (ci: number) => columnWidths[ci] ?? 100;
  const startResize = (e: React.MouseEvent, ci: number) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, base = colW(ci);
    const move = (ev: MouseEvent) => onWidths?.(Array.from({ length: nCols }, (_, k) => (k === ci ? Math.max(70, Math.round(base + ev.clientX - startX)) : colW(k))));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const rawSelected: CellRange | null = grip ? (grip.kind === "row" ? { r0: grip.index, r1: grip.index, c0: 0, c1: nCols - 1 } : { r0: 0, r1: rows.length - 1, c0: grip.index, c1: grip.index }) : range;
  const selected = rawSelected ? expandRange(rawSelected, merges) : null;
  const multi = !!selected && (selected.r0 !== selected.r1 || selected.c0 !== selected.c1);
  const deletion = selected && onDeleteSelection ? planSelectionDelete(rows, merges, widths, selected) : null;
  const focusMerge = focus && splitCell(merges, focus.r, focus.c) !== null;
  const apply = (op: TableOp) => { const res = applyTableOp(rows, merges, op); onChange?.(res.rows, res.merges, remapWidths(widths, op, nCols)); setGrip(null); setRange(null); };
  const merge = () => { if (!selected) return; const res = mergeCells(rows, merges, selected); if (res) onChange?.(res.rows, res.merges); setGrip(null); setRange(null); };
  const split = () => { if (!focus) return; const m = splitCell(merges, focus.r, focus.c); if (m) onChange?.(rows, m); };
  const editable = !readOnly && !!onChange;
  return (
    <div ref={root} contentEditable={false} className={cn("group/t relative my-2 w-fit max-w-full select-none sm:mt-3", !readOnly && "sm:pb-4 sm:pr-4")} data-table-block
      onKeyDown={(event) => { if (event.key === "Escape" && moreOpen) { event.preventDefault(); event.stopPropagation(); setMoreOpen(false); } }}
      onCopy={(event) => {
        if (!canCopy) { event.preventDefault(); event.stopPropagation(); return; }
        if (!multi || !selected) return;
        event.preventDefault(); event.stopPropagation(); event.clipboardData.setData("text/plain", formatTableTSV(rows, selected, merges));
      }}
      onCut={(event) => {
        if (!canCopy) { event.preventDefault(); event.stopPropagation(); return; }
        if (!multi || !selected) return;
        event.preventDefault(); event.stopPropagation();
        if (!onCutCells) { setClipboardNotice("当前无法剪切选区，表格未修改。"); return; }
        try { event.clipboardData.setData("text/plain", formatTableTSV(rows, selected, merges)); }
        catch { setClipboardNotice("无法写入剪贴板，表格未修改。"); return; }
        const error = onCutCells(selected);
        setClipboardNotice(error ? `${error}请检查剪贴板后重试。` : "");
        if (!error) { setRange(null); setGrip(null); }
      }}>
      {!readOnly && <div className="relative z-30 sm:absolute sm:top-1 sm:left-0 sm:-translate-y-full"><span className={cn("mb-1 w-max max-w-[calc(100vw-32px)] items-center gap-0.5 whitespace-nowrap rounded-lg border bg-surface p-0.5 text-subtle shadow-[0_4px_16px_rgba(31,35,41,0.12)] sm:mb-0", multi || moreOpen ? "flex" : "hidden group-focus-within/t:flex sm:invisible sm:flex sm:group-hover/t:visible sm:group-focus-within/t:visible")} data-table-toolbar>
        {editable && (multi || focusMerge) && <span className="relative flex">
          <button type="button" title="更多表格操作" aria-label="更多表格操作" aria-haspopup="menu" aria-expanded={moreOpen} className={cn("grid size-9 place-items-center rounded hover:bg-hover hover:text-foreground sm:size-7", moreOpen && "bg-hover")} onMouseDown={(e) => e.preventDefault()} onClick={() => setMoreOpen((open) => !open)} data-table-more><LayoutGrid size={15} strokeWidth={1.7} /></button>
          {moreOpen && <span role="menu" className="absolute left-0 top-9 z-40 w-44 rounded-lg border border-[#DEE0E3] bg-surface p-1 text-[13px] text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border" data-table-more-menu>
            {multi && <button type="button" role="menuitem" className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover" onMouseDown={(e) => e.preventDefault()} onClick={() => { setMoreOpen(false); merge(); }} data-table-merge><Combine size={15} strokeWidth={1.7} />合并单元格</button>}
            {!multi && focusMerge && <button type="button" role="menuitem" className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover" onMouseDown={(e) => e.preventDefault()} onClick={() => { setMoreOpen(false); split(); }} data-table-split><SquareSplitHorizontal size={15} strokeWidth={1.7} />拆分单元格</button>}
          </span>}
        </span>}
        {editable && (multi || focusMerge) && <span className="mx-0.5 h-4 w-px bg-border" />}
        <button type="button" title="在下方插入行" aria-label="在下方插入行" className="flex h-9 items-center gap-1 rounded px-2 text-[12px] hover:bg-hover hover:text-foreground sm:h-7 sm:px-1.5" onClick={() => onEdit(-1, nCols, "")}><Rows3 size={14} strokeWidth={1.7} /><span className="max-[360px]:sr-only">插入行</span></button>
        <button type="button" title="在右侧插入列" aria-label="在右侧插入列" className="flex h-9 items-center gap-1 rounded px-2 text-[12px] hover:bg-hover hover:text-foreground sm:h-7 sm:px-1.5" onClick={() => onEdit(-2, nCols, "")}><Columns3 size={14} strokeWidth={1.7} /><span className="max-[360px]:sr-only">插入列</span></button>
        {onHeader && <button type="button" title="标题行" aria-label="标题行" aria-pressed={header} className={cn("flex h-9 items-center gap-1 rounded px-2 text-[12px] hover:bg-hover sm:h-7 sm:px-1.5", header ? "text-primary" : "hover:text-foreground")} onMouseDown={(e) => e.preventDefault()} onClick={() => onHeader(!header)} data-table-header><Rows3 size={14} className="min-[361px]:hidden" /><span className="max-[360px]:sr-only">标题行</span></button>}
        {onHeaderColumn && <button type="button" title="标题列" aria-label="标题列" aria-pressed={headerColumn} className={cn("flex h-9 items-center gap-1 rounded px-2 text-[12px] hover:bg-hover sm:h-7 sm:px-1.5", headerColumn ? "text-primary" : "hover:text-foreground")} onMouseDown={(e) => e.preventDefault()} onClick={() => onHeaderColumn(!headerColumn)} data-table-header-column><Columns3 size={14} className="min-[361px]:hidden" /><span className="max-[360px]:sr-only">标题列</span></button>}
        {!multi && <><span className="mx-0.5 h-4 w-px bg-border" />
        <button type="button" title="删除表格" aria-label="删除表格" className="grid size-9 place-items-center rounded hover:bg-hover hover:text-destructive sm:size-7" onClick={onDelete} data-table-del><Trash2 size={14} strokeWidth={1.7} /></button></>}
        {multi && selected && deletion && <><span className="mx-0.5 h-4 w-px bg-border" />
        <button type="button" title={deletion.kind === "rows" ? "删除选中行" : deletion.kind === "cols" ? "删除选中列" : "删除表格"} aria-label={deletion.kind === "rows" ? "删除选中行" : deletion.kind === "cols" ? "删除选中列" : "删除表格"} className="grid size-9 place-items-center rounded hover:bg-hover hover:text-destructive sm:size-7" onMouseDown={(e) => e.preventDefault()} onClick={() => { const error = onDeleteSelection?.(selected); setClipboardNotice(error ?? ""); if (!error) { setMoreOpen(false); setGrip(null); setRange(null); } }} data-table-delete-selection={deletion.kind}><Trash2 size={14} strokeWidth={1.7} /></button></>}
      </span></div>}
      <div className={cn("max-w-full overflow-x-auto", editable && "sm:-ml-4 sm:-mt-4 sm:pl-4 sm:pt-4")} data-table-scroll>
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
                  <td key={ci} rowSpan={span?.[0]} colSpan={span?.[1]} className={cn("relative min-w-[100px] border border-[#D9DBDF] p-0 align-top dark:border-border", (header && ri === 0 || headerColumn && ci === 0) && "bg-[#F5F6F7] font-medium dark:bg-sidebar", sel && "bg-[#E1EAFF] dark:bg-primary/20")} data-table-position={`${ri}:${ci}`} data-cell-selected={sel ? "true" : undefined} data-merged={span ? `${span[0]}x${span[1]}` : undefined} data-find-match={found ? "true" : undefined} data-find-active={activeFind ? "true" : undefined}>
                    {readOnly ? <span className="block min-h-[39px] whitespace-pre-wrap break-words px-2 py-[8.5px]">{found ? tableFindText(cell, found.ranges) : cell}</span> : (
                      <div className="relative grid">
                      <div aria-hidden="true" className="invisible col-start-1 row-start-1 max-h-[237px] min-h-[39px] overflow-hidden whitespace-pre-wrap break-words px-2 py-[8.5px]">{cell}{"\u200b"}</div>
                      {found && <div aria-hidden="true" data-table-find-overlay className={cn("pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-[8.5px]", !showMirror && "invisible")}>{tableFindText(cell, found.ranges)}{"\u200b"}</div>}
                      <textarea
                        value={cell}
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
                            dragSelection.current = { pointerId: event.pointerId, r: ri, c: ci, active: false, x: event.clientX, y: event.clientY, source: event.currentTarget, restoreFocus: false };
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
                            setRange(null); setGrip(null); setMoreOpen(false);
                            const next = cells[intent.index]; next.focus();
                            const at = intent.caret === "start" ? 0 : next.value.length;
                            next.setSelectionRange(at, at);
                          } else if (intent.kind === "append") {
                            if (!onAppendRow) { setClipboardNotice("当前无法添加新行，表格未修改。"); return; }
                            pendingTab.current = { source: e.currentTarget, row: rows.length, cols: nCols };
                            const error = onAppendRow();
                            if (error) pendingTab.current = null;
                            else { setRange(null); setGrip(null); setMoreOpen(false); }
                            setClipboardNotice(error ?? "");
                          }
                        }}
                        onPaste={(e) => {
                          const text = e.clipboardData.getData("text/plain");
                          const structured = /[\t\r\n]/.test(text);
                          if (!multi && (!onPasteCells || !structured)) return;
                          e.preventDefault(); e.stopPropagation();
                          if (!e.clipboardData.types.includes("text/plain") || !text) return;
                          if (!onPasteCells) { setClipboardNotice("当前无法粘贴到选区，表格未修改。"); return; }
                          const start = multi && selected ? { r: selected.r0, c: selected.c0 } : { r: ri, c: ci };
                          const error = onPasteCells(start.r, start.c, text, !structured);
                          setClipboardNotice(error ?? "");
                          if (!error) {
                            setRange(null); setGrip(null); setMoreOpen(false);
                            if (multi) {
                              const target = root.current?.querySelector<HTMLTextAreaElement>(`[data-table-cell="${start.r}:${start.c}"]`);
                              if (target) { target.focus(); requestAnimationFrame(() => { if (document.activeElement === target) target.setSelectionRange(target.value.length, target.value.length); }); }
                            }
                          }
                        }}
                        onMouseDown={(e) => {
                          setMoreOpen(false);
                          setGrip(null);
                          if (e.shiftKey && focus) { e.preventDefault(); setRange(normRange({ r0: focus.r, c0: focus.c, r1: ri, c1: ci })); }
                          else setRange(null);
                        }}
                        className={cn("relative col-start-1 row-start-1 block h-full max-h-[237px] min-h-[39px] w-full resize-none bg-transparent px-2 py-[8.5px] outline-none", multi && sel ? "caret-transparent" : "focus:shadow-[inset_0_0_0_2px_#3370FF]", showMirror && "text-transparent")}
                        data-table-cell={`${ri}:${ci}`}
                      />
                      </div>
                    )}
                    {editable && ri === 0 && !span?.[1] && <button type="button" aria-label={`选择第 ${ci + 1} 列`} title="选择整列" onMouseDown={(e) => e.preventDefault()} onClick={(e) => openGrip(e, { kind: "col", index: ci })} className={cn("absolute -top-[14px] left-0 right-0 h-[10px] rounded-[3px] bg-[#EFF0F1] opacity-0 hover:bg-primary/30 group-hover/t:opacity-100 dark:bg-hover", grip?.kind === "col" && grip.index === ci && "bg-primary opacity-100")} data-table-col-grip={ci} />}
                    {editable && ci === 0 && !span?.[0] && <button type="button" aria-label={`选择第 ${ri + 1} 行`} title="选择整行" onMouseDown={(e) => e.preventDefault()} onClick={(e) => openGrip(e, { kind: "row", index: ri })} className={cn("absolute -left-[14px] bottom-0 top-0 w-[10px] rounded-[3px] bg-[#EFF0F1] opacity-0 hover:bg-primary/30 group-hover/t:opacity-100 dark:bg-hover", grip?.kind === "row" && grip.index === ri && "bg-primary opacity-100")} data-table-row-grip={ri} />}
                    {!readOnly && ri === 0 && <div className="absolute -right-[3px] top-0 z-10 h-full w-[6px] cursor-col-resize hover:bg-primary/40" onMouseDown={(e) => startResize(e, ci + (span?.[1] ?? 1) - 1)} data-table-resize={ci} />}
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
      {editable && grip && (
        <div role="menu" style={{ left: menuAt?.x ?? 16, top: menuAt?.y ?? 16 }} className="absolute z-40 w-36 rounded-lg border bg-surface p-1 text-[13px] font-normal shadow-[0_6px_24px_rgba(31,35,41,0.12)]" data-table-grip-menu={grip.kind}>
          {gripMenu(grip, rows.length, nCols, rows, merges).map((it) => <Fragment key={it.label}>{(it.danger || it.op.kind === "moveRow" && it.label === "上移一行" || it.op.kind === "moveCol" && it.label === "左移一列") && <div className="my-1 border-t" />}<button type="button" role="menuitem" disabled={it.disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => apply(it.op)} className={cn("block w-full rounded px-2 py-1.5 text-left hover:bg-hover disabled:opacity-40", it.danger && "text-destructive")} data-table-op={it.op.kind}>{it.label}</button></Fragment>)}
        </div>
      )}
      {clipboardNotice && <div role="status" className="mt-2 flex items-start gap-2 text-[12px] text-[#b54a23]"><span>{clipboardNotice}</span><button type="button" aria-label="关闭粘贴提示" onClick={() => setClipboardNotice("")}><X size={14} /></button></div>}
      {!readOnly && <>
        <button type="button" title="添加一行" aria-label="添加一行" className="absolute bottom-0 left-4 right-10 hidden h-3.5 place-items-center rounded-[3px] bg-[#EFF0F1] text-subtle hover:bg-primary/15 hover:text-primary group-hover/t:grid dark:bg-hover" onClick={() => (onChange ? apply({ kind: "insertRow", at: rows.length }) : onEdit(-1, nCols, ""))} data-table-add-row><Plus size={11} strokeWidth={2.2} /></button>
        <button type="button" title="添加一列" aria-label="添加一列" className="absolute bottom-4 right-0 top-4 hidden w-3.5 place-items-center rounded-[3px] bg-[#EFF0F1] text-subtle hover:bg-primary/15 hover:text-primary group-hover/t:grid dark:bg-hover" onClick={() => (onChange ? apply({ kind: "insertCol", at: nCols }) : onEdit(-2, nCols, ""))} data-table-add-col><Plus size={11} strokeWidth={2.2} /></button>
      </>}
    </div>
  );
}
