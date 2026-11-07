import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CellEditor, CellView } from "./cells";
import { displayValue, evalFormulas, REGISTRY, setFormulaCache } from "./registry";
import { TypeGlyph } from "./cells";
import { ask } from "@/components/ui/ask";

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

  setFormulaCache(record, evalFormulas(fields, record, members));
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
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] flex-col border-l bg-surface shadow-xl" data-record-detail>
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
                <span className="text-subtle"><TypeGlyph t={f.type} /></span>
                {f.name}
                {def.readonly && <span className="rounded bg-hover px-1 text-[11px] text-subtle">自动</span>}
              </div>
              {f.description && <div className="mb-1 text-[11px] leading-4 text-subtle">{f.description}</div>}
              <div
                className={cn("min-h-8 rounded px-1.5 py-1 text-[14px]", !def.readonly && canEdit && "cursor-text hover:bg-hover", editingThis && "outline outline-2 -outline-offset-2 outline-primary")}
                onClick={() => !def.readonly && canEdit && f.type !== "checkbox" && f.type !== "link" && setEditing(f.id)}
                data-detail-field={f.id}
              >
                {f.type === "link" && canEdit ? (
                  <LinkEditor baseId={baseId} field={f} record={row} onSaved={setRow} />
                ) : editingThis ? (
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
      <ReverseLinks baseId={baseId} recordId={record.id} />
      <footer className="flex items-center gap-3 border-t px-4 py-2.5 text-[12px] text-subtle">
        <span>创建于 {row.createdAt ? new Date(row.createdAt).toLocaleString("zh-CN", { hour12: false }) : "—"}</span>
        <span>修改于 {row.updatedAt ? new Date(row.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "—"}</span>
        {canEdit && (
          <button
            className="ml-auto text-destructive hover:underline"
            onClick={async () => {
              if (await ask("删除这条记录？")) {
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

/** Link 字段编辑器：勾选目标 base 的记录，保存为 id 数组（真值在 bt_links）。 */
function LinkEditor({
  baseId,
  field,
  record,
  onSaved,
}: {
  baseId: number;
  field: Field;
  record: BaseRecord;
  onSaved: (r: BaseRecord) => void;
}) {
  const members: User[] = [];
  const targetBase = Number(field.options?.[0] ?? 0);
  const target = useQuery({
    queryKey: ["base", targetBase],
    queryFn: () => baseApi.get(targetBase),
    enabled: targetBase > 0,
  });
  const selected = Array.isArray(record.cells[field.id]) ? (record.cells[field.id] as unknown[]).map(Number) : [];
  const tTitle = target.data?.fields.find((f) => f.type === "text") ?? target.data?.fields[0];
  const toggle = async (id: number) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    const res = await baseApi.setCells(baseId, record.id, { [String(field.id)]: next }).catch(() => null);
    if (res) onSaved(res);
  };
  if (!targetBase) return <span className="text-[12px] text-subtle">未配置目标表</span>;
  return (
    <div className="max-h-40 space-y-0.5 overflow-y-auto" data-link-editor>
      {(target.data?.records ?? []).map((r) => (
        <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-hover">
          <input
            type="checkbox"
            className="accent-primary"
            checked={selected.includes(r.id)}
            onChange={() => void toggle(r.id)}
          />
          {String(displayValue(r, tTitle ?? field, members) ?? "") || `#${r.id}`}
        </label>
      ))}
      {(target.data?.records ?? []).length === 0 && <span className="text-[12px] text-subtle">目标表暂无记录</span>}
    </div>
  );
}


/** 双向关联：列出反向引用本记录的源记录（只读 chips）。 */
function ReverseLinks({ baseId, recordId }: { baseId: number; recordId: number }) {
  const rev = useQuery({ queryKey: ["reverse", baseId], queryFn: () => baseApi.reverse(baseId) });
  const rows = (rev.data ?? [])
    .map((r) => ({
      sourceBase: r.sourceBase,
      refs: r.from[String(recordId)] ?? [],
      titles: r.titles,
    }))
    .filter((x) => x.refs.length > 0);
  if (rows.length === 0) return null;
  return (
    <div className="border-t px-4 py-3" data-reverse-links>
      <div className="mb-1.5 text-[12px] text-muted-foreground">被以下记录关联</div>
      {rows.map((r) => (
        <div key={r.sourceBase} className="mb-1.5 flex flex-wrap gap-1">
          {r.refs.map((rid) => (
            <span key={rid} className="rounded bg-[#E1EAFF] px-1.5 py-0.5 text-[12px] font-medium text-primary dark:bg-[#1d3461]">
              {r.titles[String(rid)] ?? `#${rid}`}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
