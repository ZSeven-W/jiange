import { useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { askText } from "@/components/ui/ask";
import { baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CellView, TAG_COLORS, Tag } from "./cells";
import { displayValue, recordTitle, recordTitleField, REGISTRY } from "./registry";

export interface KanbanColumn {
  /** option value; "" is the ungrouped bucket */
  key: string;
  records: BaseRecord[];
}

/** Group records by a select field; unknown/empty values land in 未分类 (first column). */
export function groupRecords(records: BaseRecord[], field: Field): KanbanColumn[] {
  // Feishu lists the 未分类 bucket first, then one column per option.
  const cols: KanbanColumn[] = [{ key: "", records: [] }, ...(field.options ?? []).map((o) => ({ key: o, records: [] }))];
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
}: {
  baseId: number;
  canEdit: boolean;
  fields: Field[];
  records: BaseRecord[];
  members: User[];
  groupFieldId?: number;
  onMutate: () => void;
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
          {canEdit && <p className="text-[13px] text-subtle">请先在表格视图中添加一个单选字段</p>}
        </div>
      </div>
    );
  }
  const title = recordTitleField(fields);
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

  const addGroup = async () => {
    const name = (await askText("新建分组", "分组名称"))?.trim();
    if (!name || (field.options ?? []).includes(name)) return;
    await baseApi.patchField(baseId, field.id, { options: [...(field.options ?? []), name] }).catch(() => {});
    onMutate();
  };
  const tint = (key: string) => {
    if (!key) return "#F5F6F7";
    const [bg] = TAG_COLORS[Math.max(0, (field.options ?? []).indexOf(key)) % TAG_COLORS.length];
    return `color-mix(in srgb, ${bg} 40%, white)`;
  };

  return (
    <div className="flex min-h-0 flex-1 items-start gap-2 overflow-x-auto px-5 py-1" data-kanban>
      {cols.map((col) => (
        <div
          key={col.key || "__ungrouped"}
          style={{ background: tint(col.key) }}
          className={cn(
            "flex max-h-full w-[256px] shrink-0 flex-col rounded-lg",
            over?.col === col.key && over.index === col.records.length && "outline outline-2 outline-primary/50",
          )}
          data-kanban-col={col.key}
          onDragOver={(e) => {
            e.preventDefault();
            setOver({ col: col.key, index: col.records.length });
          }}
          onDrop={(e) => {
            e.preventDefault();
            void drop(col.key, over?.index ?? col.records.length, Number(e.dataTransfer.getData("text/rid")) || undefined);
          }}
        >
          <div className="flex h-11 shrink-0 items-center gap-2 px-3 text-[13px] text-muted-foreground">
            {col.key ? <Tag colorIndex={(field.options ?? []).indexOf(col.key)} value={col.key} /> : <span className="rounded bg-[#E4E5E7] px-2 py-0.5 text-[12px] font-medium text-[#646A73]">未分类</span>}
            <span className="text-subtle">{col.records.length}</span>
            <MoreHorizontal size={16} className="ml-auto text-subtle" aria-hidden />
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2">
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
                  "cursor-grab rounded-md border border-[#DEE0E3] bg-white px-3 py-[11px] text-[14px] hover:shadow-[0_2px_8px_rgba(31,35,41,0.08)]",
                  drag?.rid === rec.id && "opacity-40",
                  over?.col === col.key && over.index === i && "border-t-2 border-t-primary",
                )}
                data-card={rec.id}
              >
                {(() => {
                  const t = recordTitle(rec, fields, members);
                  return <div className={cn("truncate leading-[22px]", t ? "font-medium" : "text-subtle")}>{t || "未命名记录"}</div>;
                })()}
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
          {canEdit ? (
            <button
              className="mx-2 my-1.5 grid h-8 shrink-0 place-items-center rounded-md text-subtle hover:bg-black/5 hover:text-foreground"
              title="添加卡片"
              aria-label="添加卡片"
              data-kanban-add={col.key}
              onClick={() => baseApi.addRecord(baseId, col.key ? { [field.id]: col.key } : {}).then(onMutate)}
            >
              <Plus size={16} />
            </button>
          ) : (
            <div className="h-2 shrink-0" />
          )}
        </div>
      ))}
      {canEdit && (
        <button className="flex h-11 shrink-0 items-center gap-1 rounded-md px-3 text-[14px] text-muted-foreground hover:bg-hover" onClick={addGroup} data-kanban-add-group>
          <Plus size={16} /> 新建分组
        </button>
      )}
    </div>
  );
}
