import { useState } from "react";
import { baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CellEditor, CellView } from "./cells";
import { displayValue, REGISTRY } from "./registry";

/** Record detail drawer: every field editable in place, like Feishu's
 * row-expansion panel. */
export function RecordDetail({
  baseId,
  canEdit,
  fields,
  record,
  members,
  onClose,
  onMutate,
}: {
  baseId: number;
  canEdit: boolean;
  fields: Field[];
  record: BaseRecord;
  members: User[];
  onClose: () => void;
  onMutate: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [row, setRow] = useState(record);

  const setCell = async (f: Field, v: Cell | null) => {
    setEditing(null);
    const cur = row.cells[f.id];
    if (cur === v || (cur === undefined && (v === null || v === ""))) return;
    // optimistic
    setRow({ ...row, cells: { ...row.cells, [f.id]: v ?? undefined } });
    await baseApi.setCells(baseId, row.id, { [f.id]: v === "" ? null : v }).catch(() => {});
    onMutate();
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-[420px] flex-col border-l bg-white shadow-xl" data-record-detail>
      <header className="flex h-[52px] shrink-0 items-center border-b px-4 text-[15px] font-semibold">
        <span className="truncate">
          {String(displayValue(row, fields.find((f) => f.type === "text") ?? fields[0], members) || "未命名记录")}
        </span>
        <span className="ml-2 text-[12px] font-normal text-subtle">#{row.id}</span>
        <button className="ml-auto rounded p-1 text-subtle hover:bg-hover hover:text-foreground" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-4" data-detail-fields>
        {fields.map((f) => {
          const def = REGISTRY[f.type];
          const editingThis = editing === f.id;
          return (
            <div key={f.id} className="border-b py-2.5 last:border-b-0">
              <div className="mb-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <span className="text-subtle">{def.icon}</span>
                {f.name}
                {def.readonly && <span className="rounded bg-hover px-1 text-[11px] text-subtle">自动</span>}
              </div>
              {f.description && <div className="mb-1 text-[11px] leading-4 text-subtle">{f.description}</div>}
              <div
                className={cn("min-h-8 rounded px-1.5 py-1 text-[14px]", !def.readonly && canEdit && "cursor-text hover:bg-hover", editingThis && "outline outline-2 -outline-offset-2 outline-primary")}
                onClick={() => !def.readonly && canEdit && f.type !== "checkbox" && setEditing(f.id)}
                data-detail-field={f.id}
              >
                {editingThis ? (
                  <CellEditor
                    field={f}
                    record={row}
                    members={members}
                    onCommit={(v) => setCell(f, v)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <CellView
                    field={f}
                    record={row}
                    members={members}
                    canEdit={canEdit && !def.readonly}
                    onToggle={canEdit && !def.readonly ? (v) => setCell(f, v) : undefined}
                    onEdit={() => setEditing(f.id)}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <footer className="flex items-center gap-3 border-t px-4 py-2.5 text-[12px] text-subtle">
        <span>创建于 {row.createdAt ? new Date(row.createdAt).toLocaleString("zh-CN", { hour12: false }) : "—"}</span>
        <span>修改于 {row.updatedAt ? new Date(row.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "—"}</span>
        {canEdit && (
          <button
            className="ml-auto text-destructive hover:underline"
            onClick={() => {
              if (confirm("删除这条记录？")) {
                baseApi.deleteRecord(baseId, row.id).then(() => {
                  onMutate();
                  onClose();
                });
              }
            }}
          >
            删除记录
          </button>
        )}
      </footer>
    </aside>
  );
}
