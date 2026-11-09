import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Columns3, Combine, Plus, Rows3, SquareSplitHorizontal, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseTableData } from "./model";
import { applyTableOp, canMove, coverMap, expandRange, mergeCells, normRange, parseMerges, remapWidths, splitCell, type CellRange, type Merge, type TableOp, type Widths } from "./tableOps";

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

export function TableBlock({ data, merges: rawMerges, widths, header = true, onHeader, onWidths, onEdit, onChange, onDelete, readOnly, initialGrip = null }: {
  data: string; merges?: string; widths?: Widths; header?: boolean; onHeader?: (on: boolean) => void;
  onWidths?: (w: number[]) => void;
  onEdit: (r: number, c: number, v: string, kind?: string) => void;
  /** 结构/合并修改：一次写入 tableData 与 tableMerges。 */
  onChange?: (rows: string[][], merges: Merge[], widths?: Widths) => void;
  onDelete: () => void; readOnly: boolean;
  initialGrip?: GripSel | null;
}) {
  const rows = parseTableData(data);
  const nCols = rows[0]?.length ?? 0;
  const merges = useMemo(() => parseMerges(rawMerges, rows.length, nCols), [rawMerges, rows.length, nCols]);
  const cover = useMemo(() => coverMap(merges), [merges]);
  const [grip, setGrip] = useState<GripSel | null>(initialGrip);
  const [range, setRange] = useState<CellRange | null>(null);
  const [focus, setFocus] = useState<{ r: number; c: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const openGrip = (e: React.MouseEvent<HTMLElement>, g: GripSel) => {
    setRange(null);
    const same = grip?.kind === g.kind && grip?.index === g.index;
    const box = root.current?.getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect();
    if (box) setMenuAt(g.kind === "col" ? { x: b.left - box.left, y: b.bottom - box.top + 4 } : { x: b.right - box.left + 4, y: b.top - box.top });
    setGrip(same ? null : g);
  };
  useEffect(() => {
    if (!grip && !range) return;
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) { setGrip(null); setRange(null); } };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [grip, range]);
  const size = (r: string[]) => Math.max(...r.map((c) => [...c].length));
  const colW = (ci: number) => widths?.[ci] ?? Math.max(90, Math.min(260, 18 + size(rows[0]) * 9));
  const startResize = (e: React.MouseEvent, ci: number) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, base = colW(ci);
    const move = (ev: MouseEvent) => onWidths?.(Array.from({ length: nCols }, (_, k) => (k === ci ? Math.max(70, Math.round(base + ev.clientX - startX)) : colW(k))));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const selected: CellRange | null = grip ? (grip.kind === "row" ? { r0: grip.index, r1: grip.index, c0: 0, c1: nCols - 1 } : { r0: 0, r1: rows.length - 1, c0: grip.index, c1: grip.index }) : range ? expandRange(range, merges) : null;
  const multi = !!selected && (selected.r0 !== selected.r1 || selected.c0 !== selected.c1);
  const focusMerge = focus && splitCell(merges, focus.r, focus.c) !== null;
  const apply = (op: TableOp) => { const res = applyTableOp(rows, merges, op); onChange?.(res.rows, res.merges, remapWidths(widths, op, nCols)); setGrip(null); setRange(null); };
  const merge = () => { if (!selected) return; const res = mergeCells(rows, merges, selected); if (res) onChange?.(res.rows, res.merges); setGrip(null); setRange(null); };
  const split = () => { if (!focus) return; const m = splitCell(merges, focus.r, focus.c); if (m) onChange?.(rows, m); };
  const editable = !readOnly && !!onChange;
  return (
    <div ref={root} contentEditable={false} className={cn("group/t relative my-2 w-fit max-w-full select-none", !readOnly && "pb-4 pr-4")} data-table-block>
      {!readOnly && <span className="absolute -top-[34px] right-4 z-20 hidden items-center gap-0.5 rounded-lg border bg-surface p-0.5 text-subtle shadow-[0_4px_16px_rgba(31,35,41,0.12)] group-hover/t:flex" data-table-toolbar>
        {editable && multi && <button type="button" className="flex h-7 items-center gap-1 rounded px-1.5 text-[12px] text-primary hover:bg-hover" onMouseDown={(e) => e.preventDefault()} onClick={merge} data-table-merge><Combine size={14} strokeWidth={1.7} />合并单元格</button>}
        {editable && !multi && focusMerge && <button type="button" className="flex h-7 items-center gap-1 rounded px-1.5 text-[12px] hover:bg-hover hover:text-foreground" onMouseDown={(e) => e.preventDefault()} onClick={split} data-table-split><SquareSplitHorizontal size={14} strokeWidth={1.7} />拆分单元格</button>}
        {editable && (multi || focusMerge) && <span className="mx-0.5 h-4 w-px bg-border" />}
        <button type="button" title="在下方插入行" aria-label="在下方插入行" className="flex h-7 items-center gap-1 rounded px-1.5 text-[12px] hover:bg-hover hover:text-foreground" onClick={() => onEdit(-1, nCols, "")}><Rows3 size={14} strokeWidth={1.7} />插入行</button>
        <button type="button" title="在右侧插入列" aria-label="在右侧插入列" className="flex h-7 items-center gap-1 rounded px-1.5 text-[12px] hover:bg-hover hover:text-foreground" onClick={() => onEdit(-2, nCols, "")}><Columns3 size={14} strokeWidth={1.7} />插入列</button>
        {onHeader && <button type="button" title="标题行" aria-pressed={header} className={cn("flex h-7 items-center gap-1 rounded px-1.5 text-[12px] hover:bg-hover", header ? "text-primary" : "hover:text-foreground")} onMouseDown={(e) => e.preventDefault()} onClick={() => onHeader(!header)} data-table-header>标题行</button>}
        <span className="mx-0.5 h-4 w-px bg-border" />
        <button type="button" title="删除表格" aria-label="删除表格" className="grid size-7 place-items-center rounded hover:bg-hover hover:text-destructive" onClick={onDelete} data-table-del><Trash2 size={14} strokeWidth={1.7} /></button>
      </span>}
      <div className={cn("max-w-full overflow-x-auto", editable && "-ml-4 -mt-4 pl-4 pt-4")}>
      <table className="border-collapse text-[14px] leading-[1.6]">
        <colgroup>{rows[0].map((_, ci) => <col key={ci} style={{ width: colW(ci) }} />)}</colgroup>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="group/row">
              {row.map((cell, ci) => {
                const cov = cover.get(`${ri}:${ci}`);
                if (cov === "hidden") return null;
                const span = cov?.span;
                const sel = inRange(selected, ri, ci);
                return (
                  <td key={ci} rowSpan={span?.[0]} colSpan={span?.[1]} className={cn("relative min-w-[90px] border border-[#DEE0E3] p-0 align-top dark:border-border", header && ri === 0 && "bg-[#F5F6F7] font-medium dark:bg-sidebar", sel && "bg-[#E1EAFF] dark:bg-primary/20")} data-cell-selected={sel ? "true" : undefined} data-merged={span ? `${span[0]}x${span[1]}` : undefined}>
                    {readOnly ? <span className="block min-h-[38px] whitespace-pre-wrap px-2.5 py-[7px]">{cell}</span> : (
                      <input
                        value={cell}
                        onChange={(e) => onEdit(ri, ci, e.target.value, (e.nativeEvent as InputEvent).inputType)}
                        onFocus={() => setFocus({ r: ri, c: ci })}
                        onMouseDown={(e) => {
                          setGrip(null);
                          if (e.shiftKey && focus) { e.preventDefault(); setRange(normRange({ r0: focus.r, c0: focus.c, r1: ri, c1: ci })); }
                          else setRange(null);
                        }}
                        className="w-full bg-transparent px-2.5 py-[7px] outline-none focus:shadow-[inset_0_0_0_2px_#3370FF]"
                        data-table-cell={`${ri}:${ci}`}
                      />
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
      {!readOnly && <>
        <button type="button" title="添加一行" aria-label="添加一行" className="absolute bottom-0 left-4 right-10 hidden h-3.5 place-items-center rounded-[3px] bg-[#EFF0F1] text-subtle hover:bg-primary/15 hover:text-primary group-hover/t:grid dark:bg-hover" onClick={() => (onChange ? apply({ kind: "insertRow", at: rows.length }) : onEdit(-1, nCols, ""))} data-table-add-row><Plus size={11} strokeWidth={2.2} /></button>
        <button type="button" title="添加一列" aria-label="添加一列" className="absolute bottom-4 right-0 top-4 hidden w-3.5 place-items-center rounded-[3px] bg-[#EFF0F1] text-subtle hover:bg-primary/15 hover:text-primary group-hover/t:grid dark:bg-hover" onClick={() => (onChange ? apply({ kind: "insertCol", at: nCols }) : onEdit(-2, nCols, ""))} data-table-add-col><Plus size={11} strokeWidth={2.2} /></button>
      </>}
    </div>
  );
}
