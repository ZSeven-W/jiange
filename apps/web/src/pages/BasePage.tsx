import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { baseApi, type BaseRecord, type Cell, type Field, type FieldType } from "@/lib/api";
import { cn } from "@/lib/utils";

const TYPE_ICON: Record<FieldType, string> = { text: "Aa", number: "#", select: "◉", checkbox: "☑", date: "▣" };
const TYPE_LABEL: Record<FieldType, string> = { text: "文本", number: "数字", select: "单选", checkbox: "复选框", date: "日期" };
const TAG_COLORS = [
  ["#E1EAFF", "#245BDB"],
  ["#D9F5D6", "#237B19"],
  ["#FEEAD2", "#B24D00"],
  ["#F8DEF8", "#9F2BA6"],
  ["#F2F3F5", "#646A73"],
];
const W: Record<FieldType, number> = { text: 240, number: 120, select: 130, checkbox: 80, date: 140 };

/** Bitable grid view: typed columns, inline cell editing, add rows/fields. */
export function BasePage({ id }: { id: number }) {
  const qc = useQueryClient();
  const key = ["base", id];
  const q = useQuery({ queryKey: key, queryFn: () => baseApi.get(id) });
  const [edit, setEdit] = useState<{ r: number; f: number } | null>(null);
  const [newField, setNewField] = useState(false);
  const [sort, setSort] = useState<{ f: number; desc: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  if (q.isError) return <div className="grid flex-1 place-items-center text-muted-foreground">多维表格不存在或无权访问</div>;
  if (!q.data) return <div className="flex-1" />;
  const { base, fields } = q.data;
  const records = view(q.data.records, fields, sort, filter);
  const canEdit = base.role !== "view";
  const setCell = async (rec: BaseRecord, f: Field, v: Cell | null) => {
    setEdit(null);
    const cur = rec.cells[f.id];
    if (cur === v || (cur === undefined && (v === null || v === ""))) return;
    // optimistic
    qc.setQueryData(key, { ...q.data, records: q.data.records.map((r) => (r.id === rec.id ? { ...r, cells: { ...r.cells, [f.id]: v ?? undefined } } : r)) });
    await baseApi.setCells(id, rec.id, { [f.id]: v === "" ? null : v }).catch(refresh);
    refresh();
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center border-b px-5 text-[16px] font-semibold">{base.title || "未命名多维表格"}</header>
      <div className="flex h-11 shrink-0 items-center gap-4 border-b px-5 text-[13px] text-muted-foreground">
        <span className="rounded-md bg-accent px-2.5 py-1 font-medium text-primary">▦ 表格视图</span>
        {canEdit && (
          <button className="hover:text-foreground" onClick={() => baseApi.addRecord(id).then(refresh)}>
            + 添加记录
          </button>
        )}
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="筛选：包含关键字" className="h-7 w-44 rounded-md border px-2 outline-none focus:border-primary" data-filter />
        <select
          value={sort ? `${sort.f}:${sort.desc ? "d" : "a"}` : ""}
          onChange={(e) => {
            const [f, d] = e.target.value.split(":");
            setSort(f ? { f: Number(f), desc: d === "d" } : null);
          }}
          className="h-7 rounded-md border bg-white px-2"
          data-sort
        >
          <option value="">排序：默认</option>
          {fields.flatMap((f) => [
            <option key={`${f.id}a`} value={`${f.id}:a`}>
              {f.name} ↑
            </option>,
            <option key={`${f.id}d`} value={`${f.id}:d`}>
              {f.name} ↓
            </option>,
          ])}
        </select>
        <span className="text-subtle">
          {records.length === q.data.records.length ? `${records.length} 条记录` : `${records.length} / ${q.data.records.length} 条记录`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-[14px]" data-grid>
          <thead>
            <tr className="h-9 bg-sidebar text-left text-[13px] text-muted-foreground">
              <th className="w-14 border px-2.5 font-normal" />
              {fields.map((f) => (
                <th key={f.id} className="border px-2.5 font-medium" style={{ width: W[f.type], minWidth: W[f.type] }}>
                  <span className="mr-1.5 text-subtle">{TYPE_ICON[f.type]}</span>
                  {f.name}
                </th>
              ))}
              {canEdit && (
                <th className="relative w-11 border text-center font-normal">
                  <button className="size-full text-[16px] text-subtle hover:text-foreground" onClick={() => setNewField((v) => !v)} aria-label="添加字段">
                    +
                  </button>
                  {newField && <NewField onDone={() => setNewField(false)} onCreate={(f) => baseApi.addField(id, f).then(refresh)} />}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {records.map((rec, i) => (
              <tr key={rec.id} className="group h-9 hover:bg-[#F7F9FF]">
                <td className="border px-2.5 text-[12px] text-subtle">
                  <span className="group-hover:hidden">{i + 1}</span>
                  {canEdit && (
                    <button className="hidden text-subtle hover:text-destructive group-hover:inline" title="删除记录" onClick={() => baseApi.deleteRecord(id, rec.id).then(refresh)}>
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
                      {editing ? <CellEditor field={f} value={rec.cells[f.id]} onCommit={(v) => setCell(rec, f, v)} onCancel={() => setEdit(null)} /> : <CellView field={f} value={rec.cells[f.id]} onToggle={canEdit ? (v) => setCell(rec, f, v) : undefined} />}
                    </td>
                  );
                })}
                {canEdit && <td className="border" />}
              </tr>
            ))}
            {canEdit && (
              <tr className="h-9">
                <td colSpan={fields.length + 2} className="border px-4">
                  <button className="text-[13px] text-subtle hover:text-foreground" onClick={() => baseApi.addRecord(id).then(refresh)}>
                    + 新增一行
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Tag({ field, value }: { field: Field; value: string }) {
  const [bg, fg] = TAG_COLORS[Math.max(0, (field.options ?? []).indexOf(value)) % TAG_COLORS.length];
  return (
    <span className="rounded px-2 py-0.5 text-[12px] font-medium" style={{ background: bg, color: fg }}>
      {value}
    </span>
  );
}

function CellView({ field, value, onToggle }: { field: Field; value: Cell | undefined; onToggle?: (v: boolean | null) => void }) {
  if (field.type === "checkbox")
    return (
      <input type="checkbox" className="size-4 accent-primary" checked={value === true} disabled={!onToggle} onChange={(e) => onToggle?.(e.target.checked ? true : null)} aria-label={field.name} />
    );
  if (value === undefined || value === "") return null;
  if (field.type === "select") return <Tag field={field} value={String(value)} />;
  return <span className="block truncate">{String(value)}</span>;
}

function CellEditor({ field, value, onCommit, onCancel }: { field: Field; value: Cell | undefined; onCommit: (v: Cell | null) => void; onCancel: () => void }) {
  const [v, setV] = useState(value === undefined ? "" : String(value));
  if (field.type === "select")
    return (
      <select autoFocus className="w-full bg-transparent outline-none" value={v} onChange={(e) => onCommit(e.target.value || null)} onBlur={onCancel}>
        <option value="">—</option>
        {(field.options ?? []).map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  const commit = () => {
    if (field.type === "number") {
      const n = Number(v);
      return onCommit(v.trim() === "" || Number.isNaN(n) ? null : n);
    }
    onCommit(v === "" ? null : v);
  };
  return (
    <input
      autoFocus
      type={field.type === "date" ? "date" : "text"}
      inputMode={field.type === "number" ? "decimal" : undefined}
      className={cn("w-full bg-transparent outline-none", field.type === "number" && "text-right")}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}

function NewField({ onCreate, onDone }: { onCreate: (f: Partial<Field>) => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [opts, setOpts] = useState("");
  return (
    <form
      className="absolute right-0 top-10 z-20 w-64 space-y-2 rounded-lg border bg-white p-3 text-left text-[13px] font-normal text-foreground shadow-lg"
      data-new-field
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({ name: name.trim() || "新字段", type, options: type === "select" ? opts.split(/[,，\s]+/).filter(Boolean) : undefined });
        onDone();
      }}
    >
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="字段名称" className="h-8 w-full rounded-md border px-2 outline-none focus:border-primary" />
      <select value={type} onChange={(e) => setType(e.target.value as FieldType)} className="h-8 w-full rounded-md border px-2">
        {(Object.keys(TYPE_LABEL) as FieldType[]).map((t) => (
          <option key={t} value={t}>
            {TYPE_ICON[t]} {TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      {type === "select" && <input value={opts} onChange={(e) => setOpts(e.target.value)} placeholder="选项，用逗号分隔" className="h-8 w-full rounded-md border px-2 outline-none focus:border-primary" />}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="h-7 rounded-md border px-3">
          取消
        </button>
        <button type="submit" className="h-7 rounded-md bg-primary px-3 text-white">
          确定
        </button>
      </div>
    </form>
  );
}

/** Client-side filter (any cell contains the keyword) and stable sort; empty cells sort last. */
export function view(records: BaseRecord[], fields: Field[], sort: { f: number; desc: boolean } | null, filter: string): BaseRecord[] {
  const kw = filter.trim().toLowerCase();
  let out = kw ? records.filter((r) => fields.some((f) => r.cells[f.id] !== undefined && String(r.cells[f.id]).toLowerCase().includes(kw))) : records;
  if (sort) {
    const f = fields.find((x) => x.id === sort.f);
    if (f) {
      const rank = (v: Cell | undefined) => (f.type === "select" ? (f.options ?? []).indexOf(String(v)) : v);
      out = [...out].sort((a, b) => {
        const x = a.cells[f.id], y = b.cells[f.id];
        if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
        const rx = rank(x)!, ry = rank(y)!;
        const c = typeof rx === "number" && typeof ry === "number" ? rx - ry : String(rx).localeCompare(String(ry), "zh-CN");
        return sort.desc ? -c : c;
      });
    }
  }
  return out;
}
