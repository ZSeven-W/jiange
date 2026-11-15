import { useEffect, useMemo, useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, Bold, Brush, ChevronDown, ChevronLeft, Eraser, Grid2X2, Italic, Menu, MessageSquare, MoreHorizontal, Pencil, Plus, Redo2, Search, Strikethrough, Underline, Undo2 } from "lucide-react";
import { calculateSheet } from "./formula";
import { applyCellChanges, clearSelection, columnName, pasteCells, pointKey, PREVIEW_COLS, PREVIEW_ROWS, selected, selectionOutline, selectionText, sheetAddress, type CellEdit, type SheetCells, type SheetPoint, type SheetSelection } from "./gridModel";

const initialCells: SheetCells = { "0:0": "项目任务", "0:1": "负责人", "0:2": "状态", "1:0": "需求梳理", "1:1": "小简", "1:2": "已完成", "2:0": "界面设计", "2:1": "小林", "2:2": "进行中", "3:0": "功能开发", "3:1": "小陈", "3:2": "待开始" };
const single = (point: SheetPoint): SheetSelection => ({ anchor: point, focus: point });
type History = { past: SheetCells[]; cells: SheetCells; future: SheetCells[] };

/** Development-only surface. Its state is intentionally transient and is not a workbook. */
export function SheetPreview() {
  const [history, setHistory] = useState<History>({ past: [], cells: initialCells, future: [] });
  const [selection, setSelection] = useState<SheetSelection>(() => single({ row: 0, col: 0 }));
  const [editing, setEditing] = useState<{ point: SheetPoint; value: string; source: "cell" | "formula" } | null>(null);
  const [message, setMessage] = useState("");
  const grid = useRef<HTMLDivElement>(null), editInput = useRef<HTMLInputElement>(null), formulaInput = useRef<HTMLInputElement>(null), selecting = useRef(false), cancelled = useRef(false);
  const { cells } = history;
  const calculated = useMemo(() => calculateSheet(cells), [cells]);
  useEffect(() => { const stop = () => { selecting.current = false; }; window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop); return () => { window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); }; }, []);
  useEffect(() => { if (editing?.source === "cell") { editInput.current?.focus(); editInput.current?.setSelectionRange(editing.value.length, editing.value.length); } }, [editing?.point.row, editing?.point.col, editing?.source]);
  const apply = (result: CellEdit) => {
    if (!result.ok) { setMessage(result.reason === "bounds" ? "粘贴范围超出表格，内容未更改。" : result.reason === "invalid" ? "内容包含不支持的字符，未更改。" : "内容或批量范围超过预览限制，内容未更改。"); return false; }
    if (JSON.stringify(result.cells) !== JSON.stringify(cells)) setHistory({ past: [...history.past.slice(-99), cells], cells: result.cells, future: [] });
    setMessage(""); return true;
  };
  const undo = () => { const previous = history.past.at(-1); if (previous) { setHistory({ past: history.past.slice(0, -1), cells: previous, future: [cells, ...history.future].slice(0, 100) }); setMessage(""); } };
  const redo = () => { const next = history.future[0]; if (next) { setHistory({ past: [...history.past, cells].slice(-100), cells: next, future: history.future.slice(1) }); setMessage(""); } };
  const beginEdit = (point: SheetPoint, value = cells[pointKey(point)] ?? "", source: "cell" | "formula" = "cell") => { cancelled.current = false; setMessage(""); setSelection(single(point)); setEditing({ point, value, source }); };
  const finishEdit = () => { if (!editing) return; if (!cancelled.current && !apply(applyCellChanges(cells, [{ point: editing.point, value: editing.value }]))) { requestAnimationFrame(() => (editing.source === "cell" ? editInput.current : formulaInput.current)?.focus()); return; } cancelled.current = false; setEditing(null); };
  const move = (dr: number, dc: number, extend: boolean) => {
    setMessage("");
    const point = { row: Math.max(0, Math.min(PREVIEW_ROWS - 1, selection.focus.row + dr)), col: Math.max(0, Math.min(PREVIEW_COLS - 1, selection.focus.col + dc)) };
    setSelection(extend ? { ...selection, focus: point } : single(point));
    requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`[data-sheet-cell="${pointKey(point)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  };
  const inputKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || !editing) return;
    if (event.key === "Escape") { event.preventDefault(); cancelled.current = true; setMessage(""); setEditing(null); requestAnimationFrame(() => grid.current?.focus()); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); const result = applyCellChanges(cells, [{ point: editing!.point, value: editing!.value }]); if (!apply(result)) return; setEditing(null); move(event.key === "Enter" ? (event.shiftKey ? -1 : 1) : 0, event.key === "Tab" ? (event.shiftKey ? -1 : 1) : 0, false); requestAnimationFrame(() => grid.current?.focus()); }
  };
  const gridKey = (event: React.KeyboardEvent) => {
    if (editing || event.nativeEvent.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
    if (mod && event.key.toLowerCase() === "a") { event.preventDefault(); setSelection({ anchor: { row: 0, col: 0 }, focus: { row: PREVIEW_ROWS - 1, col: PREVIEW_COLS - 1 } }); return; }
    const directions: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, event.shiftKey ? -1 : 1] };
    if (directions[event.key]) { event.preventDefault(); const [dr, dc] = directions[event.key]; move(dr, dc, event.key !== "Tab" && event.shiftKey); return; }
    if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1, 0, false); return; }
    if (event.key === "F2") { event.preventDefault(); beginEdit(selection.focus); return; }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); apply(clearSelection(cells, selection)); return; }
    if (!mod && !event.altKey && event.key.length === 1) { event.preventDefault(); beginEdit(selection.focus, event.key); }
  };
  const toolbar = "grid h-7 min-w-7 place-items-center rounded text-[#4b5058] hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-60";
  const labeledTool = (Icon: typeof Bold, label: string, action?: () => void, enabled = false) => <button type="button" title={enabled ? label : `${label}（开发中）`} aria-label={label} disabled={!enabled} onClick={action} className="flex h-12 min-w-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded px-1 text-[11px] text-[#4b5058] enabled:hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-60"><Icon size={16}/><span>{label}</span></button>;
  const icon = (Icon: typeof Bold, label: string) => <button type="button" title={`${label}（开发中）`} aria-label={label} disabled className={toolbar}><Icon size={15}/></button>;
  return <div className="flex h-dvh min-h-0 flex-col bg-white text-[#1f2329]" data-sheet-preview>
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-[#e5e6eb] px-3 sm:px-5"><button type="button" aria-label="返回" disabled className={toolbar}><ChevronLeft size={18}/></button><div className="min-w-0 flex-1"><div className="truncate text-[13px] text-[#646a73]">Jiange <span className="mx-1 text-[#b8bdc4]">›</span> <span className="text-[#1f2329]">未命名表格</span></div><div className="mt-1 text-[11px] text-[#8f959e]">开发预览 · 数据仅保存在当前页面</div></div><button type="button" disabled className="rounded-md bg-[#1456ee] px-3 py-1.5 text-[13px] text-white opacity-50">分享</button><MoreHorizontal size={17} className="text-[#646a73]"/></header>
    <div className="flex h-[42px] shrink-0 items-end gap-1 border-b border-[#e5e6eb] bg-[#f7f8fa] px-3"><div className="grid h-9 place-items-center px-1 text-[#646a73]"><Grid2X2 size={16}/></div><button className="h-9 rounded-t-md border border-b-white border-[#e5e6eb] bg-white px-4 text-[13px] text-[#3370ff]">Sheet1</button><button type="button" disabled title="新建工作表（开发中）" className={`${toolbar} mb-1`}><Plus size={17}/></button></div>
    <div className="flex h-14 shrink-0 items-center gap-1 overflow-x-auto border-b border-[#e5e6eb] bg-[#f7f8fa] px-3" data-sheet-toolbar>
      {labeledTool(Menu, "菜单")}<span className="mx-1 h-8 w-px bg-[#dee0e3]"/>{labeledTool(Undo2, "撤销", undo, !!history.past.length)}{labeledTool(Redo2, "重做", redo, !!history.future.length)}{labeledTool(Brush, "格式刷")}{labeledTool(Eraser, "清除格式")}<span className="mx-1 h-8 w-px bg-[#dee0e3]"/>{labeledTool(Plus, "插入")}<span className="mx-1 h-8 w-px bg-[#dee0e3]"/><div className="flex min-w-40 flex-col gap-0.5"><div className="flex h-6 items-center gap-2 text-[12px] text-[#646a73]"><span className="w-24">默认字体</span><ChevronDown size={12}/><span>10</span><ChevronDown size={12}/></div><div className="flex items-center gap-1">{icon(Bold, "粗体")}{icon(Strikethrough, "删除线")}{icon(Italic, "斜体")}{icon(Underline, "下划线")}</div></div><span className="mx-1 h-8 w-px bg-[#dee0e3]"/><div className="flex shrink-0 flex-col"><div className="flex">{icon(AlignLeft, "左对齐")}{icon(AlignCenter, "居中")}{icon(AlignRight, "右对齐")}</div><div className="px-1 text-[11px] text-[#a3a8af]">合并单元格</div></div><span className="mx-1 h-8 w-px bg-[#dee0e3]"/><button type="button" disabled className="shrink-0 px-2 text-[12px] text-[#8f959e]">常规 <ChevronDown size={12} className="ml-4 inline"/></button><span className="mx-1 h-8 w-px bg-[#dee0e3]"/>{labeledTool(MoreHorizontal, "更多")}{labeledTool(Search, "查找和替换")}{labeledTool(MessageSquare, "评论")}
    </div>
    <div className="flex h-6 shrink-0 items-center border-b border-[#e5e6eb] text-[12px]"><span className="w-16 shrink-0 border-r px-3 text-[#646a73]" data-sheet-address>{sheetAddress(selection.focus)}</span><span className="px-2 italic text-[#8f959e]">fx</span><input ref={formulaInput} aria-label="编辑栏" value={editing?.value ?? cells[pointKey(selection.focus)] ?? ""} onFocus={() => { if (!editing) beginEdit(selection.focus, undefined, "formula"); }} onChange={(event) => { if (editing) setEditing({ ...editing, value: event.target.value }); }} onKeyDown={inputKey} onBlur={finishEdit} className="h-full min-w-0 flex-1 bg-transparent text-[#4b5058] outline-none" data-sheet-formula/><button type="button" aria-label="编辑当前单元格" onClick={() => { if (editing) (editing.source === "cell" ? editInput.current : formulaInput.current)?.focus(); else beginEdit(selection.focus); }} className="grid h-7 w-9 place-items-center text-[#646a73] sm:hidden"><Pencil size={14}/></button></div>
    <div ref={grid} role="grid" aria-label="表格开发预览" aria-rowcount={PREVIEW_ROWS} aria-colcount={PREVIEW_COLS} tabIndex={0} onKeyDown={gridKey} onCopy={(event) => { if (editing) return; event.preventDefault(); event.clipboardData.setData("text/plain", selectionText(cells, selection)); }} onCut={(event) => { if (editing) return; event.preventDefault(); const result = clearSelection(cells, selection); if (!result.ok) { apply(result); return; } event.clipboardData.setData("text/plain", selectionText(cells, selection)); apply(result); }} onPaste={(event) => { if (editing) return; event.preventDefault(); apply(pasteCells(cells, selection.focus, event.clipboardData.getData("text/plain"))); }} className="min-h-0 min-w-0 flex-1 select-none overflow-auto outline-none" data-sheet-grid>
      <div className="w-max min-w-full">
        <div role="row" className="sticky top-0 z-20 flex h-6 bg-[#f5f6f7]"><div className="sticky left-0 z-30 w-11 shrink-0 border-b border-r border-[#dfe2e6] bg-[#f5f6f7]"/>{Array.from({ length: PREVIEW_COLS }, (_, col) => <div key={col} role="columnheader" className={`grid w-[105px] shrink-0 place-items-center border-b border-r border-[#dfe2e6] text-[11px] ${selection.focus.col === col ? "bg-[#e9efff] text-[#2b5ddb]" : "text-[#646a73]"}`}>{columnName(col)}</div>)}</div>
        {Array.from({ length: PREVIEW_ROWS }, (_, row) => <div key={row} role="row" className="flex h-[27px]"><div role="rowheader" className={`sticky left-0 z-10 grid w-11 shrink-0 place-items-center border-b border-r border-[#e5e6eb] text-[11px] ${selection.focus.row === row ? "bg-[#e9efff] text-[#2b5ddb]" : "bg-[#f5f6f7] text-[#8f959e]"}`}>{row + 1}</div>{Array.from({ length: PREVIEW_COLS }, (_, col) => {
          const point = { row, col }, key = pointKey(point), isFocus = selection.focus.row === row && selection.focus.col === col, isEditing = editing?.source === "cell" && editing.point.row === row && editing.point.col === col;
          return <div key={col} role="gridcell" aria-label={sheetAddress(point)} aria-selected={selected(selection, point)} data-sheet-cell={key} style={{ boxShadow: selectionOutline(selection, point) }} onPointerDown={(event) => { if (event.button !== 0 || isEditing) return; if (event.pointerType !== "touch") event.preventDefault(); if (editing) { if (!apply(applyCellChanges(cells, [{ point: editing.point, value: editing.value }]))) return; cancelled.current = true; setEditing(null); } setMessage(""); selecting.current = true; setSelection(event.shiftKey ? { ...selection, focus: point } : single(point)); grid.current?.focus({ preventScroll: true }); }} onPointerEnter={(event) => { if (selecting.current && event.buttons) setSelection((current) => ({ ...current, focus: point })); }} onDoubleClick={() => beginEdit(point)} className={`relative h-[27px] w-[105px] shrink-0 border-b border-r border-[#e8e9eb] px-1.5 text-[12px] leading-[26px] ${selected(selection, point) ? "bg-[#edf3ff]" : "bg-white"} ${isFocus ? "z-[1] outline outline-2 -outline-offset-2 outline-[#3370ff]" : ""}`}>
            {isEditing ? <input ref={editInput} aria-label={`编辑 ${sheetAddress(point)}`} value={editing.value} onChange={(event) => setEditing({ ...editing, value: event.target.value })} onKeyDown={inputKey} onBlur={finishEdit} className="absolute inset-0 h-full w-full select-text border-2 border-[#3370ff] bg-white px-1 text-[12px] outline-none"/> : <span className={`block truncate ${typeof calculated[key] === "number" || /^-?\d+(?:\.\d+)?$/.test(cells[key] ?? "") ? "text-right" : ""}`}>{editing?.source === "formula" && editing.point.row === row && editing.point.col === col ? editing.value : calculated[key] ?? ""}</span>}
          </div>;
        })}</div>)}
      </div>
    </div>
    <footer className="flex h-9 shrink-0 items-center justify-between gap-2 border-t border-[#e5e6eb] bg-white px-4 text-[11px] text-[#8f959e]"><span role={message ? "alert" : undefined} className={`min-w-0 truncate ${message ? "text-[#a66600]" : ""}`}>{message || "普通表格开发预览"}</span><span>100%</span></footer>
  </div>;
}
