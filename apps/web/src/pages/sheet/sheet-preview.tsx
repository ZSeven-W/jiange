import { useEffect, useMemo, useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, Bold, Brush, ChevronDown, ChevronLeft, Download, Eraser, FileUp, Grid2X2, Italic, Menu, MessageSquare, MoreHorizontal, Pencil, Plus, Redo2, Search, Strikethrough, Underline, Undo2 } from "lucide-react";
import { writeXlsx } from "@jiange/sheet-sdk/xlsx";
import { readXlsx, XLSX_MAX_INPUT_BYTES } from "@jiange/sheet-sdk/xlsx-read";
import { calculateSheet } from "./formula";
import { applyCellChanges, clearSelection, columnName, pointKey, PREVIEW_COLS, PREVIEW_ROWS, selected, selectionOutline, selectionText, sheetAddress, type CellEdit, type SheetCells, type SheetPoint, type SheetSelection } from "./grid-model";
import { copySheetCells, resolveSheetPaste, SHEET_COPY_MIME, type SheetCopy, type SheetPaste } from "./sheet-clipboard";
import { describeImportWarnings, fromPreview, toPreview, type PreviewXlsx } from "./xlsx-preview";

const initialCells: SheetCells = { "0:0": "项目任务", "0:1": "负责人", "0:2": "状态", "1:0": "需求梳理", "1:1": "小简", "1:2": "已完成", "2:0": "界面设计", "2:1": "小林", "2:2": "进行中", "3:0": "功能开发", "3:1": "小陈", "3:2": "待开始" };
const single = (point: SheetPoint): SheetSelection => ({ anchor: point, focus: point });
type History = { past: SheetCells[]; cells: SheetCells; future: SheetCells[] };

/** Development-only surface. Its state is intentionally transient and is not a workbook. */
export function SheetPreview() {
  const [history, setHistory] = useState<History>({ past: [], cells: initialCells, future: [] });
  const [selection, setSelection] = useState<SheetSelection>(() => single({ row: 0, col: 0 }));
  const [editing, setEditing] = useState<{ point: SheetPoint; value: string; source: "cell" | "formula" } | null>(null);
  const [message, setMessage] = useState("");
  const [sheetName, setSheetName] = useState("Sheet1");
  const [originals, setOriginals] = useState<PreviewXlsx["originals"]>({});
  const [pendingImport, setPendingImport] = useState<{ preview: PreviewXlsx; warnings: string[]; filename: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const grid = useRef<HTMLDivElement>(null), editInput = useRef<HTMLInputElement>(null), formulaInput = useRef<HTMLInputElement>(null), selecting = useRef(false), cancelled = useRef(false);
  const copied = useRef<SheetCopy | null>(null);
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const { cells } = history;
  const calculated = useMemo(() => calculateSheet(cells), [cells]);
  useEffect(() => { const stop = () => { selecting.current = false; }; window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop); return () => { window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); }; }, []);
  useEffect(() => {
    const node = grid.current;
    if (!node) return;
    let frame = 0;
    const keepSelectionVisible = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => node.querySelector<HTMLElement>(`[data-sheet-cell="${pointKey(selectionRef.current.focus)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" })); };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keepSelectionVisible);
    observer?.observe(node);
    window.addEventListener("resize", keepSelectionVisible);
    return () => { observer?.disconnect(); window.removeEventListener("resize", keepSelectionVisible); cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => { if (editing?.source === "cell") { editInput.current?.focus(); editInput.current?.setSelectionRange(editing.value.length, editing.value.length); } }, [editing?.point.row, editing?.point.col, editing?.source]);
  const apply = (result: CellEdit | SheetPaste) => {
    if (!result.ok) { setMessage(result.reason === "bounds" ? "粘贴范围超出表格，内容未更改。" : result.reason === "invalid" ? "内容包含不支持的字符，未更改。" : result.reason === "unsupported_formula" ? "公式包含暂不支持的语法，无法安全调整引用，内容未更改。" : result.reason === "unverified_copy" ? "无法确认公式的复制来源，内容未更改。请重新复制后再试。" : "内容或批量范围超过预览限制，内容未更改。"); return false; }
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
  const importXlsx = async (file: File) => {
    if (file.size > XLSX_MAX_INPUT_BYTES) { setMessage("文件超过 20 MiB，未导入。"); return; }
    setImporting(true); setMessage("");
    try {
      const result = await readXlsx(new Uint8Array(await file.arrayBuffer()));
      const preview = toPreview(result.workbook);
      if (mounted.current) setPendingImport({ preview, warnings: result.warnings, filename: file.name });
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? `无法导入：${error.message}` : "无法导入该文件。");
    } finally { if (mounted.current) setImporting(false); }
  };
  const exportXlsx = () => {
    try {
      const bytes = writeXlsx({ sheets: [fromPreview(sheetName, cells, originals)] });
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const link = document.createElement("a"); link.href = url; link.download = `${sheetName}.xlsx`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("已导出 XLSX；公式结果由表格应用重新计算。");
    } catch { setMessage("导出失败：内容或公式超出 XLSX 支持范围。"); }
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
    <div className="flex h-[42px] shrink-0 items-end gap-1 border-b border-[#e5e6eb] bg-[#f7f8fa] px-3"><div className="grid h-9 place-items-center px-1 text-[#646a73]"><Grid2X2 size={16}/></div><button className="h-9 max-w-48 truncate rounded-t-md border border-b-white border-[#e5e6eb] bg-white px-4 text-[13px] text-[#3370ff]">{sheetName}</button><button type="button" disabled title="新建工作表（开发中）" className={`${toolbar} mb-1`}><Plus size={17}/></button></div>
    <div className="flex h-14 shrink-0 items-center gap-1 overflow-x-auto border-b border-[#e5e6eb] bg-[#f7f8fa] px-3" data-sheet-toolbar>
      {labeledTool(Menu, "菜单")}<input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="选择 XLSX 文件" className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void importXlsx(file); }}/>{labeledTool(FileUp, importing ? "导入中" : "导入", () => fileInput.current?.click(), !importing)}{labeledTool(Download, "导出", exportXlsx, !editing)}<span className="mx-1 h-8 w-px bg-[#dee0e3]"/>{labeledTool(Undo2, "撤销", undo, !!history.past.length)}{labeledTool(Redo2, "重做", redo, !!history.future.length)}{labeledTool(Brush, "格式刷")}{labeledTool(Eraser, "清除格式")}<span className="mx-1 h-8 w-px bg-[#dee0e3]"/>{labeledTool(Plus, "插入")}<span className="mx-1 h-8 w-px bg-[#dee0e3]"/><div className="flex min-w-40 flex-col gap-0.5"><div className="flex h-6 items-center gap-2 text-[12px] text-[#646a73]"><span className="w-24">默认字体</span><ChevronDown size={12}/><span>10</span><ChevronDown size={12}/></div><div className="flex items-center gap-1">{icon(Bold, "粗体")}{icon(Strikethrough, "删除线")}{icon(Italic, "斜体")}{icon(Underline, "下划线")}</div></div><span className="mx-1 h-8 w-px bg-[#dee0e3]"/><div className="flex shrink-0 flex-col"><div className="flex">{icon(AlignLeft, "左对齐")}{icon(AlignCenter, "居中")}{icon(AlignRight, "右对齐")}</div><div className="px-1 text-[11px] text-[#a3a8af]">合并单元格</div></div><span className="mx-1 h-8 w-px bg-[#dee0e3]"/><button type="button" disabled className="shrink-0 px-2 text-[12px] text-[#8f959e]">常规 <ChevronDown size={12} className="ml-4 inline"/></button><span className="mx-1 h-8 w-px bg-[#dee0e3]"/>{labeledTool(MoreHorizontal, "更多")}{labeledTool(Search, "查找和替换")}{labeledTool(MessageSquare, "评论")}
    </div>
    <div className="flex h-6 shrink-0 items-center border-b border-[#e5e6eb] text-[12px]"><span className="w-16 shrink-0 border-r px-3 text-[#646a73]" data-sheet-address>{sheetAddress(selection.focus)}</span><span className="px-2 italic text-[#8f959e]">fx</span><input ref={formulaInput} aria-label="编辑栏" value={editing?.value ?? cells[pointKey(selection.focus)] ?? ""} onFocus={() => { if (!editing) beginEdit(selection.focus, undefined, "formula"); }} onChange={(event) => { if (editing) setEditing({ ...editing, value: event.target.value }); }} onKeyDown={inputKey} onBlur={finishEdit} className="h-full min-w-0 flex-1 bg-transparent text-[#4b5058] outline-none" data-sheet-formula/><button type="button" aria-label="编辑当前单元格" onClick={() => { if (editing) (editing.source === "cell" ? editInput.current : formulaInput.current)?.focus(); else beginEdit(selection.focus); }} className="grid h-7 w-9 place-items-center text-[#646a73] sm:hidden"><Pencil size={14}/></button></div>
    <div ref={grid} role="grid" aria-label="表格开发预览" aria-rowcount={PREVIEW_ROWS} aria-colcount={PREVIEW_COLS} tabIndex={0} onKeyDown={gridKey} onCopy={(event) => { if (editing) return; event.preventDefault(); const text = selectionText(cells, selection); event.clipboardData.setData("text/plain", text); const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`; copied.current = copySheetCells(cells, selection, token); try { if (copied.current) event.clipboardData.setData(SHEET_COPY_MIME, copied.current.token); } catch { /* The snapshot still lets us reject an ambiguous formula paste. */ } }} onCut={(event) => { if (editing) return; event.preventDefault(); copied.current = null; const result = clearSelection(cells, selection); if (!result.ok) { apply(result); return; } event.clipboardData.setData("text/plain", selectionText(cells, selection)); apply(result); }} onPaste={(event) => { if (editing) return; event.preventDefault(); const text = event.clipboardData.getData("text/plain"); let token = ""; try { token = event.clipboardData.getData(SHEET_COPY_MIME); } catch { /* Missing metadata is handled as ambiguous for a known copy. */ } apply(resolveSheetPaste(cells, selection.focus, text, token, copied.current)); }} className="min-h-0 min-w-0 flex-1 select-none overflow-auto outline-none" data-sheet-grid>
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
    {pendingImport && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="presentation"><section role="dialog" aria-modal="true" aria-labelledby="sheet-import-title" onKeyDown={(event) => { if (event.key === "Escape") setPendingImport(null); }} className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-5 shadow-xl"><h2 id="sheet-import-title" className="text-base font-semibold">导入 XLSX 到开发预览</h2><p className="mt-3 break-all text-sm text-[#646a73]">{pendingImport.filename}</p><p className="mt-3 text-sm">导入将替换当前预览并清除撤销记录。预览不会保存，刷新页面后内容将丢失。</p>{(pendingImport.warnings.length > 0 || pendingImport.preview.losses.length > 0) && <div className="mt-3 rounded bg-[#fff7e6] p-3 text-sm text-[#8a5a00]"><p>部分内容无法保留：</p>{[...describeImportWarnings(pendingImport.warnings), ...pendingImport.preview.losses].map((loss) => <p key={loss} className="mt-1">{loss}</p>)}</div>}<div className="mt-5 flex justify-end gap-2"><button type="button" autoFocus className="rounded border px-3 py-1.5 text-sm" onClick={() => setPendingImport(null)}>取消</button><button type="button" className="rounded bg-[#3370ff] px-3 py-1.5 text-sm text-white" onClick={() => { const preview = pendingImport.preview; setHistory({ past: [], cells: preview.cells, future: [] }); setOriginals(preview.originals); setSheetName(preview.name); setSelection(single({ row: 0, col: 0 })); setEditing(null); copied.current = null; setPendingImport(null); setMessage("已导入开发预览；数据仅保存在当前页面。"); }}>确认导入</button></div></section></div>}
  </div>;
}
