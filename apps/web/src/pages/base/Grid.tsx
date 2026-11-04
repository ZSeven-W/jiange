import { useEffect, useRef, useState } from "react";
import { baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CellEditor, CellView } from "./cells";
import { FieldForm, FieldMenu } from "./fields";
import { RecordDetail } from "./RecordDetail";
import { REGISTRY } from "./registry";
import { planPaste, rangeText } from "./tsv";

/** Column widths per field, persisted locally so they survive refresh. */
function loadWidths(baseId: number): Record<number, number> {
  try {
    return JSON.parse(localStorage.getItem(`jiange:fieldWidths:${baseId}`) ?? "{}");
  } catch {
    return {};
  }
}

/** Selection: anchor cell + cursor cell (indices into the rendered grid). */
interface Sel {
  ar: number;
  af: number;
  rr: number;
  rf: number;
}
interface Edit {
  ri: number;
  fi: number;
  seed?: string;
}

export function Grid({
  baseId,
  canEdit,
  fields,
  records,
  members,
  onMutate,
}: {
  baseId: number;
  canEdit: boolean;
  fields: Field[];
  records: BaseRecord[];
  members: User[];
  onMutate: () => void;
}) {
  const [edit, setEdit] = useState<Edit | null>(null);
  const [newField, setNewField] = useState(false);
  const [editField, setEditField] = useState<Field | null>(null);
  const [widths, setWidths] = useState<Record<number, number>>(() => loadWidths(baseId));
  const [drag, setDrag] = useState<{ fid: number; at: number | null }>({ fid: 0, at: null });
  const [sel, setSel] = useState<Sel | null>(null);
  const [detail, setDetail] = useState<BaseRecord | null>(null);
  const [vp, setVp] = useState({ top: 0, left: 0, h: 900, w: 1200 });
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp((v) => ({ ...v, h: el.clientHeight, w: el.clientWidth })));
    ro.observe(el);
    // drive virtualization from a rAF loop: scroll events alone are unreliable
    // (some webviews never fire them for programmatic scrolls)
    let raf = 0;
    const tick = () => {
      setVp((v) => (v.top === el.scrollTop && v.left === el.scrollLeft && v.h === el.clientHeight && v.w === el.clientWidth ? v : { top: el.scrollTop, left: el.scrollLeft, h: el.clientHeight, w: el.clientWidth }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  const width = (f: Field) => widths[f.id] ?? REGISTRY[f.type].width;
  const saveWidth = (fid: number, w: number) => {
    setWidths((prev) => {
      const next = { ...prev, [fid]: w };
      localStorage.setItem(`jiange:fieldWidths:${baseId}`, JSON.stringify(next));
      return next;
    });
  };

  const rows = records.length;
  const cols = fields.length;
  const inRange = (r: number, f: number) =>
    !!sel && r >= Math.min(sel.ar, sel.rr) && r <= Math.max(sel.ar, sel.rr) && f >= Math.min(sel.af, sel.rf) && f <= Math.max(sel.af, sel.rf);
  const isCursor = (r: number, f: number) => !!sel && sel.rr === r && sel.rf === f;

  const scrollCellIntoView = (r: number, f: number) => {
    const el = gridRef.current;
    if (!el) return;
    // with virtualization the cell may not be mounted: first bring the target
    // into the scroll window, then let scrollIntoView fine-tune
    const targetTop = r * 36;
    if (targetTop < el.scrollTop) el.scrollTop = targetTop;
    else if (targetTop + 36 > el.scrollTop + el.clientHeight) el.scrollTop = targetTop + 36 - el.clientHeight;
    const rec = records[r];
    const fld = fields[f];
    if (!rec || !fld) return;
    el.querySelector(`[data-cell="${rec.id}:${fld.id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const move = (dr: number, df: number, extend = false) => {
    setSel((s) => {
      const base = s ?? { ar: 0, af: 0, rr: 0, rf: 0 };
      const rr = Math.min(rows - 1, Math.max(0, base.rr + dr));
      const rf = Math.min(cols - 1, Math.max(0, base.rf + df));
      return extend ? { ...base, rr, rf } : { ar: rr, af: rf, rr, rf };
    });
    setEdit(null);
    scrollCellIntoView(Math.min(rows - 1, Math.max(0, (sel?.rr ?? 0) + dr)), Math.min(cols - 1, Math.max(0, (sel?.rf ?? 0) + df)));
  };

  const setCell = async (rec: BaseRecord, f: Field, v: Cell | null, dir?: "down" | "right") => {
    setEdit(null);
    if (dir === "down") move(1, 0);
    if (dir === "right") move(0, 1);
    const cur = rec.cells[f.id];
    if (cur === v || (cur === undefined && (v === null || v === ""))) return;
    await baseApi.setCells(baseId, rec.id, { [f.id]: v === "" ? null : v }).catch(() => {});
    onMutate();
  };

  const startEdit = (ri: number, fi: number, seed?: string) => {
    if (!canEdit) return;
    const f = fields[fi];
    if (!f || REGISTRY[f.type].readonly || f.type === "checkbox") return;
    setSel({ ar: ri, af: fi, rr: ri, rf: fi });
    setEdit({ ri, fi, seed });
  };

  const clearRange = async () => {
    if (!canEdit || !sel) return;
    const r0 = Math.min(sel.ar, sel.rr);
    const r1 = Math.max(sel.ar, sel.rr);
    const f0 = Math.min(sel.af, sel.rf);
    const f1 = Math.max(sel.af, sel.rf);
    await Promise.all(
      records.slice(r0, r1 + 1).map((rec) => {
        const cells: Record<string, Cell | null> = {};
        for (let f = f0; f <= f1; f++) cells[fields[f].id] = null;
        return baseApi.setCells(baseId, rec.id, cells).catch(() => {});
      }),
    );
    onMutate();
  };

  const copy = async () => {
    if (!sel) return;
    const text = rangeText(records, fields, members, sel.ar, sel.rr, sel.af, sel.rf);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* headless or denied: selection still works, paste via the event below */
    }
  };

  const paste = async (text: string) => {
    if (!canEdit || !sel) return;
    const plan = planPaste(records, fields, Math.min(sel.ar, sel.rr), Math.min(sel.af, sel.rf), text);
    for (const row of plan.addRows) {
      const cells: Record<string, Cell> = {};
      for (const [k, v] of Object.entries(row.cells)) if (v !== null) cells[k] = v;
      await baseApi.addRecord(baseId, cells).catch(() => {});
    }
    await Promise.all(plan.patches.map((p) => baseApi.setCells(baseId, p.rid, p.cells).catch(() => {})));
    onMutate();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (edit) return; // the cell editor handles its own keys
    if (!sel && !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Tab", "Enter"].includes(e.key)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void copy();
      return;
    }
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        return move(-1, 0, e.shiftKey);
      case "ArrowDown":
        e.preventDefault();
        return move(1, 0, e.shiftKey);
      case "ArrowLeft":
        e.preventDefault();
        return move(0, -1, e.shiftKey);
      case "ArrowRight":
        e.preventDefault();
        return move(0, 1, e.shiftKey);
      case "Home":
        e.preventDefault();
        return setSel((s) => (s ? { ...s, rf: 0, af: e.shiftKey ? s.af : 0 } : s));
      case "End":
        e.preventDefault();
        return setSel((s) => (s ? { ...s, rf: cols - 1, af: e.shiftKey ? s.af : cols - 1 } : s));
      case "Tab":
        e.preventDefault();
        return e.shiftKey ? tab(-1) : tab(1);
      case "Enter":
        e.preventDefault();
        if (!sel) return setSel({ ar: 0, af: 0, rr: 0, rf: 0 });
        return fields[sel.rf]?.type === "checkbox" ? toggleAt(sel.rr, sel.rf) : startEdit(sel.rr, sel.rf);
      case "F2":
        e.preventDefault();
        if (sel) startEdit(sel.rr, sel.rf);
        return;
      case " ":
        e.preventDefault();
        if (sel && fields[sel.rf]?.type === "checkbox") toggleAt(sel.rr, sel.rf);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        return void clearRange();
      case "Escape":
        return setSel((s) => (s ? { ar: s.rr, af: s.rf, rr: s.rr, rf: s.rf } : s));
    }
    if (!mod && !e.altKey && canEdit && e.key.length === 1 && sel) {
      e.preventDefault();
      startEdit(sel.rr, sel.rf, e.key);
    }
  };

  const tab = (dir: 1 | -1) => {
    move(0, dir);
    setSel((s) => {
      if (!s) return s;
      const rr = s.rr;
      const rf = s.rf;
      if (rf === cols - 1 && dir === 1 && rr < rows - 1) return { ar: rr + 1, af: 0, rr: rr + 1, rf: 0 };
      if (rf === 0 && dir === -1 && rr > 0) return { ar: rr - 1, af: cols - 1, rr: rr - 1, rf: cols - 1 };
      return s;
    });
  };

  const toggleAt = (ri: number, fi: number) => {
    const rec = records[ri];
    const f = fields[fi];
    if (!rec || !f || !canEdit) return;
    void setCell(rec, f, rec.cells[f.id] === true ? null : true);
  };

  // Reorder: drop at `index` (position in the fields array without the dragged one).
  const reorder = async (fid: number, index: number) => {
    const rest = fields.filter((f) => f.id !== fid);
    if (rest.length === 0) return;
    const prev = index > 0 ? rest[index - 1].position : rest[0].position - 1;
    const next = index < rest.length ? rest[index].position : rest[rest.length - 1].position + 1;
    await baseApi.patchField(baseId, fid, { position: (prev + next) / 2 }).catch(() => {});
    onMutate();
  };

  const startResize = (e: React.MouseEvent, f: Field) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width(f);
    const move2 = (ev: MouseEvent) => saveWidth(f.id, Math.min(600, Math.max(80, Math.round(startW + ev.clientX - startX))));
    const up = () => {
      window.removeEventListener("mousemove", move2);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move2);
    window.addEventListener("mouseup", up);
  };

  const dropOn = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    const fid = Number(e.dataTransfer.getData("text/field")) || drag.fid;
    if (fid) void reorder(fid, index);
    setDrag({ fid: 0, at: null });
  };

  // --- virtualization: render only the visible window (plus overscan) ---
  const ROW_H = 36; // h-9
  const OVERSCAN = 6;
  const r0 = Math.max(0, Math.floor(vp.top / ROW_H) - OVERSCAN);
  const r1 = Math.min(rows, Math.ceil((vp.top + vp.h) / ROW_H) + OVERSCAN);
  const colOffsets = fields.reduce<number[]>((acc, f, i) => [...acc, (acc[i - 1] ?? 0) + width(f)], []);
  const totalW = colOffsets[cols - 1] ?? 0;
  let c0 = 0;
  while (c0 < cols && colOffsets[c0] < vp.left - 200) c0++;
  c0 = Math.max(0, c0 - 2);
  let c1 = c0;
  while (c1 < cols && colOffsets[c1] < vp.left + vp.w + 200) c1++;
  c1 = Math.min(cols, c1 + 2);
  const leadW = c0 > 0 ? colOffsets[c0 - 1] : 0;
  const tailW = c1 < cols ? totalW - (colOffsets[c1 - 1] ?? 0) : 0;
  const winFields = fields.slice(c0, c1);

  return (
    <div
      ref={gridRef}
      className="min-h-0 flex-1 overflow-auto outline-none"
      data-grid-scroll
      tabIndex={0}
      onKeyDown={onKey}
      onPaste={(e) => {
        if (edit) return;
        const text = e.clipboardData.getData("text/plain");
        if (text) {
          e.preventDefault();
          void paste(text);
        }
      }}
    >
      {detail && (
        <RecordDetail
          baseId={baseId}
          canEdit={canEdit}
          fields={fields}
          record={records.find((r) => r.id === detail.id) ?? detail}
          members={members}
          onClose={() => setDetail(null)}
          onMutate={onMutate}
        />
      )}
      <table
        className="border-collapse table-fixed text-[14px]"
        data-grid
        style={{ width: 56 + totalW + (canEdit ? 44 : 0) }}
      >
        <thead>
          <tr className="h-9 bg-sidebar text-left text-[13px] text-muted-foreground">
            <th className="sticky left-0 top-0 z-20 w-14 border px-2.5 font-normal" />
            {leadW > 0 && <th style={{ width: leadW }} className="border p-0" aria-hidden />}
            {winFields.map((f, wi) => {
              const i = c0 + wi;
              return (
              <th
                key={f.id}
                className={cn("group/th sticky top-0 z-10 border bg-sidebar px-2.5 font-medium", drag.at === i && drag.fid && drag.fid !== f.id && "border-l-2 border-l-primary")}
                style={{ width: width(f), minWidth: width(f) }}
                draggable
                data-th={f.id}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/field", String(f.id));
                  e.dataTransfer.effectAllowed = "move";
                  setDrag({ fid: f.id, at: null });
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  const before = e.clientX < e.currentTarget.getBoundingClientRect().left + e.currentTarget.offsetWidth / 2;
                  const at = before ? i : i + 1;
                  if (drag.at !== at) setDrag((d) => ({ ...d, at }));
                }}
                onDrop={(e) => dropOn(e, drag.at ?? i)}
                onDragEnd={() => setDrag({ fid: 0, at: null })}
              >
                {editField?.id === f.id ? (
                  <FieldForm initial={f} onCancel={() => setEditField(null)} onSubmit={(patch) => baseApi.patchField(baseId, f.id, patch).then(onMutate)} />
                ) : (
                  <div className="flex items-center gap-1">
                    <span className="mr-0.5 cursor-grab text-subtle" title="拖拽排序" data-drag-handle>
                      ⠿
                    </span>
                    <span className="mr-1.5 text-subtle">{REGISTRY[f.type].icon}</span>
                    <span className="truncate">{f.name}</span>
                    {canEdit && (
                      <span className="ml-auto">
                        <FieldMenu field={f} onEdit={() => setEditField(f)} onDelete={() => baseApi.deleteField(baseId, f.id).then(onMutate)} />
                      </span>
                    )}
                  </div>
                )}
                {canEdit && <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40" onMouseDown={(e) => startResize(e, f)} data-resize={f.id} />}
              </th>
              );
            })}
            {tailW > 0 && <th style={{ width: tailW }} className="border p-0" aria-hidden />}
            {canEdit && (
              <th
                className="sticky top-0 z-10 relative w-11 border bg-sidebar text-center font-normal"
                onDragOver={(e) => {
                  e.preventDefault();
                  if (drag.at !== fields.length) setDrag((d) => ({ ...d, at: fields.length }));
                }}
                onDrop={(e) => dropOn(e, fields.length)}
              >
                <button className="size-full text-[16px] text-subtle hover:text-foreground" onClick={() => setNewField((v) => !v)} aria-label="添加字段">
                  +
                </button>
                {newField && <FieldForm onCancel={() => setNewField(false)} onSubmit={(f) => baseApi.addField(baseId, f).then(onMutate)} />}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {r0 > 0 && (
            <tr aria-hidden style={{ height: r0 * ROW_H }}>
              <td colSpan={winFields.length + 3} className="border-0 p-0" />
            </tr>
          )}
          {records.slice(r0, r1).map((rec, ri) => {
            const i = r0 + ri;
            return (
            <tr key={rec.id} className="group h-9">
              <td className="sticky left-0 z-10 w-14 border bg-sidebar/60 px-2.5 text-[12px] text-subtle">
                <span className="group-hover:hidden">{i + 1}</span>
                <span className="hidden items-center justify-center gap-0.5 group-hover:flex">
                  <button className="text-subtle hover:text-primary" title="展开记录" onClick={() => setDetail(rec)} data-expand={rec.id}>
                    ⤢
                  </button>
                  {canEdit && (
                    <button className="text-subtle hover:text-destructive" title="删除记录" onClick={() => baseApi.deleteRecord(baseId, rec.id).then(onMutate)}>
                      ✕
                    </button>
                  )}
                </span>
              </td>
              {leadW > 0 && <td style={{ width: leadW }} className="border p-0" aria-hidden />}
              {winFields.map((f, wj) => {
                const j = c0 + wj;
                const editing = edit?.ri === i && edit.fi === j;
                const ro = REGISTRY[f.type].readonly;
                return (
                  <td
                    key={f.id}
                    className={cn(
                      "border px-2.5",
                      f.type === "number" && "text-right tabular-nums",
                      editing && "relative z-20 outline outline-2 -outline-offset-2 outline-primary",
                      !editing && inRange(i, j) && (isCursor(i, j) ? "bg-[#DCE7FF]" : "bg-[#EDF2FF]"),
                    )}
                    onClick={(e) => {
                      setEdit(null);
                      setSel(e.shiftKey && sel ? { ...sel, rr: i, rf: j } : { ar: i, af: j, rr: i, rf: j });
                      gridRef.current?.focus();
                    }}
                    onDoubleClick={() => startEdit(i, j)}
                    data-cell={`${rec.id}:${f.id}`}
                  >
                    {editing ? (
                      <CellEditor
                        field={f}
                        record={rec}
                        members={members}
                        seed={edit?.seed}
                        onCommit={(v, dir) => setCell(rec, f, v, dir)}
                        onCancel={() => setEdit(null)}
                      />
                    ) : (
                      <CellView
                        field={f}
                        record={rec}
                        members={members}
                        canEdit={canEdit && !ro}
                        onToggle={canEdit && !ro ? () => toggleAt(i, j) : undefined}
                        onEdit={() => startEdit(i, j)}
                      />
                    )}
                  </td>
                );
              })}
              {tailW > 0 && <td style={{ width: tailW }} className="border p-0" aria-hidden />}
              {canEdit && <td className="border" />}
            </tr>
            );
          })}
          {r1 < rows && (
            <tr aria-hidden style={{ height: (rows - r1) * ROW_H }}>
              <td colSpan={winFields.length + 3} className="border-0 p-0" />
            </tr>
          )}
          {canEdit && (
            <tr className="h-9">
              <td colSpan={winFields.length + 3} className="sticky left-0 border px-4">
                <button className="text-[13px] text-subtle hover:text-foreground" onClick={() => baseApi.addRecord(baseId).then(onMutate)}>
                  + 新增一行
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
