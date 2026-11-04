import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { baseApi, docsApi } from "@/lib/api";
import { Grid } from "./base/Grid";
import { useBaseSync } from "./base/sync";
import { view } from "./base/view";

export { view } from "./base/view";

/** Bitable page: renameable title, toolbar (filter/sort), grid view. */
export function BasePage({ id }: { id: number }) {
  const qc = useQueryClient();
  const key = ["base", id];
  const q = useQuery({ queryKey: key, queryFn: () => baseApi.get(id) });
  useBaseSync(id);
  const [sort, setSort] = useState<{ f: number; desc: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  if (q.isError) return <div className="grid flex-1 place-items-center text-muted-foreground">多维表格不存在或无权访问</div>;
  if (!q.data) return <div className="flex-1" />;
  const { base, fields, members } = q.data;
  const records = view(q.data.records, fields, members, sort, filter);
  const canEdit = base.role !== "view";
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center border-b px-5 text-[16px] font-semibold">
        <BaseTitle id={id} title={base.title || "未命名多维表格"} onRenamed={refresh} />
      </header>
      <div className="flex h-11 shrink-0 items-center gap-4 border-b px-5 text-[13px] text-muted-foreground">
        <span className="rounded-md bg-accent px-2.5 py-1 font-medium text-primary">▦ 表格视图</span>
        {canEdit && (
          <button className="hover:text-foreground" onClick={() => baseApi.addRecord(id).then(refresh)}>
            + 添加记录
          </button>
        )}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选：包含关键字"
          className="h-7 w-44 rounded-md border px-2 outline-none focus:border-primary"
          data-filter
        />
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
      <Grid baseId={id} canEdit={canEdit} fields={fields} records={records} members={members} onMutate={refresh} />
    </div>
  );
}

function BaseTitle({ id, title, onRenamed }: { id: number; title: string; onRenamed: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(title);
  const commit = async () => {
    setEditing(false);
    const t = v.trim();
    if (!t || t === title) return;
    await docsApi.rename(id, t).catch(() => {});
    qc.invalidateQueries({ queryKey: ["base", id] });
    qc.invalidateQueries({ queryKey: ["docs"] });
    onRenamed();
  };
  if (editing)
    return (
      <input
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setV(title);
            setEditing(false);
          }
        }}
        className="h-8 w-64 rounded-md border px-2 text-[15px] font-normal outline-none focus:border-primary"
        data-base-title-input
      />
    );
  return (
    <span className="cursor-text rounded px-1 -mx-1 hover:bg-hover" title="点击重命名" onClick={() => setEditing(true)} data-base-title>
      {title}
    </span>
  );
}
