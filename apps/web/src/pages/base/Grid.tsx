import { useRef, useState } from "react";
import { baseApi, type BaseRecord, type Cell, type Field } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CellEditor, CellView, TYPE_ICON, W } from "./cells";
import { FieldForm, FieldMenu } from "./fields";

/** Column widths per field, persisted locally so they survive refresh. */
function loadWidths(baseId: number): Record<number, number> {
  try {
    return JSON.parse(localStorage.getItem(`jiange:fieldWidths:${baseId}`) ?? "{}");
  } catch {
    return {};
  }
}

export function Grid({
  baseId,
  canEdit,
  fields,
  records,
  onMutate,
}: {
  baseId: number;
  canEdit: boolean;
  fields: Field[];
  records: BaseRecord[];
  onMutate: () => void;
}) {
  const [edit, setEdit] = useState<{ r: number; f: number } | null>(null);
  const [newField, setNewField] = useState(false);
  const [editField, setEditField] = useState<Field | null>(null);
  const [widths, setWidths] = useState<Record<number, number>>(() => loadWidths(baseId));
  const [drag, setDrag] = useState<{ fid: number; at: number | null }>({ fid: 0, at: null });
  const gridRef = useRef<HTMLDivElement>(null);

  const width = (f: Field) => widths[f.id] ?? W[f.type];
  const saveWidth = (fid: number, w: number) => {
    setWidths((prev) => {
      const next = { ...prev, [fid]: w };
      localStorage.setItem(`jiange:fieldWidths:${baseId}`, JSON.stringify(next));
      return next;
    });
  };

  const setCell = async (rec: BaseRecord, f: Field, v: Cell | null) => {
    setEdit(null);
    const cur = rec.cells[f.id];
    if (cur === v || (cur === undefined && (v === null || v === ""))) return;
    await baseApi.setCells(baseId, rec.id, { [f.id]: v === "" ? null : v }).catch(() => {});
    onMutate();
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
    const move = (ev: MouseEvent) => saveWidth(f.id, Math.min(600, Math.max(80, Math.round(startW + ev.clientX - startX))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const dropOn = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    const fid = Number(e.dataTransfer.getData("text/field")) || drag.fid;
    if (fid) void reorder(fid, index);
    setDrag({ fid: 0, at: null });
  };

  return (
    <div ref={gridRef} className="min-h-0 flex-1 overflow-auto" data-grid-scroll>
      <table className="border-collapse table-fixed text-[14px]" data-grid>
        <thead>
          <tr className="h-9 bg-sidebar text-left text-[13px] text-muted-foreground">
            <th className="sticky left-0 z-10 w-14 border px-2.5 font-normal" />
            {fields.map((f, i) => (
              <th
                key={f.id}
                className={cn("group/th relative border px-2.5 font-medium", drag.at === i && drag.fid && drag.fid !== f.id && "border-l-2 border-l-primary")}
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
                  <FieldForm
                    initial={f}
                    onCancel={() => setEditField(null)}
                    onSubmit={(patch) => baseApi.patchField(baseId, f.id, patch).then(onMutate)}
                  />
                ) : (
                  <div className="flex items-center gap-1">
                    <span className="mr-0.5 cursor-grab text-subtle" title="拖拽排序" data-drag-handle>
                      ⠿
                    </span>
                    <span className="mr-1.5 text-subtle">{TYPE_ICON[f.type]}</span>
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
            ))}
            {canEdit && (
              <th
                className="relative w-11 border text-center font-normal"
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
          {records.map((rec, i) => (
            <tr key={rec.id} className="group h-9 hover:bg-[#F7F9FF]">
              <td className="sticky left-0 z-10 w-14 border bg-inherit px-2.5 text-[12px] text-subtle">
                <span className="group-hover:hidden">{i + 1}</span>
                {canEdit && (
                  <button
                    className="hidden text-subtle hover:text-destructive group-hover:inline"
                    title="删除记录"
                    onClick={() => baseApi.deleteRecord(baseId, rec.id).then(onMutate)}
                  >
                    ✕
                  </button>
                )}
              </td>
              {fields.map((f) => {
                const editing = edit?.r === rec.id && edit.f === f.id;
                return (
                  <td
                    key={f.id}
                    className={cn("border px-2.5", editing && "outline outline-2 -outline-offset-2 outline-primary", f.type === "number" && "text-right tabular-nums")}
                    onClick={() => canEdit && f.type !== "checkbox" && setEdit({ r: rec.id, f: f.id })}
                    data-cell={`${rec.id}:${f.id}`}
                  >
                    {editing ? (
                      <CellEditor field={f} value={rec.cells[f.id]} onCommit={(v) => setCell(rec, f, v)} onCancel={() => setEdit(null)} />
                    ) : (
                      <CellView field={f} value={rec.cells[f.id]} onToggle={canEdit ? (v) => setCell(rec, f, v) : undefined} />
                    )}
                  </td>
                );
              })}
              {canEdit && <td className="border" />}
            </tr>
          ))}
          {canEdit && (
            <tr className="h-9">
              <td colSpan={fields.length + 2} className="sticky left-0 border px-4">
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
