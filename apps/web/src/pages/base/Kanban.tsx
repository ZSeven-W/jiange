import { useState } from "react";
import { baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CellView, Tag } from "./cells";
import { displayValue, REGISTRY } from "./registry";

export interface KanbanColumn {
  /** option value; "" is the ungrouped bucket */
  key: string;
  records: BaseRecord[];
}

/** Group records by a select field; unknown/empty values land in 未分组. */
export function groupRecords(records: BaseRecord[], field: Field): KanbanColumn[] {
  const cols: KanbanColumn[] = [...(field.options ?? []).map((o) => ({ key: o, records: [] })), { key: "", records: [] }];
  for (const r of records) {
    const v = r.cells[field.id];
    const key = typeof v === "string" && (field.options ?? []).includes(v) ? v : "";
    const col = cols.find((c) => c.key === key);
    if (col) col.records.push(r);
  }
  for (const c of cols) c.records.sort((a, b) => a.position - b.position);
  return cols;
}

/** Kanban view: one column per option of the group field; dragging a card
 * between columns rewrites the cell, dragging within a column repositions. */
export function Kanban({
  baseId,
  canEdit,
  fields,
  records,
  members,
  groupFieldId,
  onMutate,
  onPickGroup,
}: {
  baseId: number;
  canEdit: boolean;
  fields: Field[];
  records: BaseRecord[];
  members: User[];
  groupFieldId?: number;
  onMutate: () => void;
  onPickGroup: () => void;
}) {
  const groupFields = fields.filter((f) => f.type === "select");
  const [drag, setDrag] = useState<{ rid: number } | null>(null);
  const [over, setOver] = useState<{ col: string; index: number } | null>(null);

  const field = groupFields.find((f) => f.id === groupFieldId) ?? groupFields[0];
  if (!field) {
    return (
      <div className="grid flex-1 place-items-center text-[14px] text-muted-foreground">
        <div className="space-y-2 text-center">
          <p>看板需要一个单选字段来分列</p>
          {canEdit && (
            <button className="rounded-md border px-3 py-1.5 text-[13px] hover:bg-hover" onClick={onPickGroup}>
              先添加一个单选字段
            </button>
          )}
        </div>
      </div>
    );
  }
  const title = fields.find((f) => f.type === "text") ?? fields[0];
  const extra = fields.filter((f) => f.id !== field.id && f.id !== title?.id && !REGISTRY[f.type].readonly).slice(0, 2);
  const cols = groupRecords(records, field);

  const drop = async (colKey: string, index: number, rid?: number) => {
    setDrag(null);
    setOver(null);
    if (!rid || !canEdit) return;
    const rec = records.find((r) => r.id === rid);
    if (!rec) return;
    // position between neighbors in the target column (or at the ends)
    const col = cols.find((c) => c.key === colKey);
    const others = (col?.records ?? []).filter((r) => r.id !== rid);
    const prev = index > 0 ? others[index - 1].position : (others[0]?.position ?? 0) - 1;
    const next = index < others.length ? others[index].position : (others[others.length - 1]?.position ?? 0) + 1;
    const position = (prev + next) / 2;
    const value: Cell | null = colKey === "" ? null : colKey;
    if (rec.cells[field.id] !== value) await baseApi.setCells(baseId, rid, { [field.id]: value }).catch(() => {});
    if (position !== rec.position) await baseApi.moveRecord(baseId, rid, position).catch(() => {});
    onMutate();
  };

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4" data-kanban>
      {cols.map((col) => (
        <div
          key={col.key || "__ungrouped"}
          className={cn(
            "flex h-full w-64 shrink-0 flex-col rounded-lg bg-sidebar/70",
            over?.col === col.key && over.index === col.records.length && "outline outline-2 outline-primary/50",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setOver({ col: col.key, index: col.records.length });
          }}
          onDrop={(e) => {
            e.preventDefault();
            void drop(col.key, over?.index ?? col.records.length, Number(e.dataTransfer.getData("text/rid")) || undefined);
          }}
        >
          <div className="flex items-center gap-2 px-3 pb-2 pt-3 text-[13px] font-medium text-muted-foreground">
            {col.key ? <Tag colorIndex={(field.options ?? []).indexOf(col.key)} value={col.key} /> : <span className="rounded bg-accent px-2 py-0.5 text-subtle">未分组</span>}
            <span className="text-subtle">{col.records.length}</span>
            {canEdit && col.key !== "" && (
              <button
                className="ml-auto text-subtle hover:text-foreground"
                title="添加卡片"
                onClick={() => baseApi.addRecord(baseId, { [field.id]: col.key }).then(onMutate)}
              >
                +
              </button>
            )}
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
            {col.records.map((rec, i) => (
              <div
                key={rec.id}
                draggable={canEdit}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/rid", String(rec.id));
                  e.dataTransfer.effectAllowed = "move";
                  setDrag({ rid: rec.id });
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOver(null);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const before = e.clientY < e.currentTarget.getBoundingClientRect().top + e.currentTarget.offsetHeight / 2;
                  setOver({ col: col.key, index: before ? i : i + 1 });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void drop(col.key, over?.index ?? i, Number(e.dataTransfer.getData("text/rid")) || undefined);
                }}
                className={cn(
                  "cursor-grab rounded-lg border bg-surface p-2.5 text-[13px] shadow-sm hover:shadow",
                  drag?.rid === rec.id && "opacity-40",
                  over?.col === col.key && over.index === i && "border-t-2 border-t-primary",
                )}
                data-card={rec.id}
              >
                <div className="truncate font-medium">{String(displayValue(rec, title, members) ?? "") || "未命名"}</div>
                {extra.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5 text-[12px] text-muted-foreground">
                    {extra.map((f) => (
                      <span key={f.id} className="max-w-[120px] truncate">
                        <CellView field={f} record={rec} members={members} canEdit={false} />
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {over?.col === col.key && over.index === col.records.length && <div className="h-1.5 rounded bg-primary/40" />}
          </div>
        </div>
      ))}
    </div>
  );
}
