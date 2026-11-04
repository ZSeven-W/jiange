import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { baseApi, docsApi, type FilterRule, type ViewConfig } from "@/lib/api";
import { Grid } from "./base/Grid";
import { Kanban } from "./base/Kanban";
import { Gallery } from "./base/Gallery";
import { CalendarView } from "./base/CalendarView";
import { Gantt } from "./base/Gantt";
import { AutomationsPanel } from "./base/Automations";
import { RecordDetail } from "./base/RecordDetail";
import { useBaseSync } from "./base/sync";
import { view } from "./base/view";

export { view } from "./base/view";

const OP_LABEL: Record<string, string> = {
  contains: "包含",
  not_contains: "不包含",
  is: "等于",
  is_not: "不等于",
  empty: "为空",
  not_empty: "不为空",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  checked: "已勾选",
  unchecked: "未勾选",
};

const EMPTY_CONFIG: ViewConfig = {};

/** Bitable page: views, filters/sorts (temporary until saved), grid. */
export function BasePage({ id }: { id: number }) {
  const qc = useQueryClient();
  const key = ["base", id];
  const q = useQuery({ queryKey: key, queryFn: () => baseApi.get(id) });
  useBaseSync(id);
  const [viewId, setViewId] = useState<number | null>(null);
  const [detailRecord, setDetailRecord] = useState<number | null>(null);
  const [autoOpen, setAutoOpen] = useState(false);
  const [cfg, setCfg] = useState<ViewConfig>(EMPTY_CONFIG);
  const [filter, setFilter] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["base", id] });

  const views = q.data?.views ?? [];
  const current = views.find((v) => v.id === viewId) ?? views[0];
  useEffect(() => {
    setViewId(current?.id ?? null);
    setCfg(current?.config ?? EMPTY_CONFIG);
  }, [current?.id, current?.config, current && JSON.stringify(current.config)]);
  // ^ load a view's saved config when switching views; JSON dep covers server updates

  const filtersActive = (cfg.filters?.rules?.length ?? 0) > 0;
  const sortsActive = (cfg.sorts?.length ?? 0) > 0;
  const serverQuery = useQuery({
    queryKey: ["base", id, "query", cfg],
    queryFn: () => baseApi.query(id, { filters: cfg.filters, sorts: cfg.sorts }),
    enabled: filtersActive || sortsActive,
  });

  if (q.isError) return <div className="grid flex-1 place-items-center text-muted-foreground">多维表格不存在或无权访问</div>;
  if (!q.data) return <div className="flex-1" />;
  const { base, fields, members } = q.data;
  // link/lookup 展开值写进展示缓存（cells），真值在 bt_links
  const recordsRaw = foldExpansions(q.data.fields, q.data.records, q.data.expansions ?? {});
  const canEdit = base.role !== "view";
  const hidden = new Set(cfg.hidden ?? []);
  const visibleFields = fields.filter((f) => !hidden.has(f.id));
  const source = foldExpansions(q.data.fields, filtersActive || sortsActive ? (serverQuery.data?.records ?? q.data.records) : q.data.records, q.data.expansions ?? {});
  const records = view(source, visibleFields, members, null, filter);
  const dirty = current ? JSON.stringify(cfg) !== JSON.stringify(current.config) : false;

  const save = async () => {
    if (!current) return;
    await baseApi.patchView(id, current.id, { config: cfg }).catch(() => {});
    refresh();
  };
  const newView = async (type: "grid" | "kanban") => {
    const v = await baseApi.addView(id, { type, name: type === "grid" ? "表格视图" : "看板视图" });
    setViewId(v.id);
    setCfg(v.config ?? EMPTY_CONFIG);
    refresh();
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center border-b px-5 text-[16px] font-semibold">
        <BaseTitle id={id} title={base.title || "未命名多维表格"} onRenamed={refresh} />
      </header>
      {/* 第一行：视图 tabs */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-4 text-[13px]">
        {views.map((v) => (
          <button
            key={v.id}
            className={`group/view flex items-center gap-1 rounded-t-md border-b-2 px-3 py-1.5 ${v.id === current?.id ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:bg-hover hover:text-foreground"}`}
            onClick={() => setViewId(v.id)}
            data-view-tab={v.type}
          >
            {v.type === "kanban" ? "▤" : v.type === "gallery" ? "🖼" : v.type === "calendar" ? "📅" : v.type === "form" ? "📝" : v.type === "gantt" ? "📊" : "▦"} {v.name}
            {views.length > 1 && canEdit && (
              <span
                className="hidden rounded p-0.5 text-[11px] text-subtle hover:text-destructive group-hover/view:inline"
                title="删除视图"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`删除视图「${v.name}」？`)) {
                    baseApi.deleteView(id, v.id).then(refresh);
                    setViewId(null);
                  }
                }}
              >
                ✕
              </span>
            )}
          </button>
        ))}
        {canEdit && (
          <button className="rounded px-1.5 text-subtle hover:bg-hover hover:text-foreground" title="新建视图" onClick={() => newView("grid")}>
            +
          </button>
        )}
        <div className="ml-auto flex items-center gap-3 text-muted-foreground">
          {canEdit && current && (
            <>
              <label className="flex cursor-pointer items-center gap-1.5 hover:text-foreground" title="锁定后，协作成员只能看到此视图过滤后的行，隐藏字段对其剔除且不可写" data-lock-toggle>
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={!!cfg.locked}
                  onChange={(e) => setCfg({ ...cfg, locked: e.target.checked || undefined })}
                />
                🔒 权限视图
              </label>
              {dirty && (
                <button className="rounded-md bg-primary px-2.5 py-1 font-medium text-white hover:opacity-90" onClick={save} data-save-view>
                  保存视图
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {/* 第二行：工具栏 */}
      <div className="flex h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b px-4 text-[13px]">
        {current?.type === "grid" && (
          <select
            className="h-7 rounded-md border bg-surface px-2 text-muted-foreground"
            value={cfg.group ?? ""}
            onChange={(e) => setCfg({ ...cfg, group: Number(e.target.value) || undefined })}
            data-grid-group
          >
            <option value="">分组：无</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                按「{f.name}」
              </option>
            ))}
          </select>
        )}
        {canEdit && current?.type === "grid" && (
          <>
            <FilterBar fields={fields} cfg={cfg} onChange={setCfg} />
            <SortBar fields={fields} cfg={cfg} onChange={setCfg} />
            <HiddenBar fields={fields} cfg={cfg} onChange={setCfg} />
          </>
        )}
        {current?.type === "kanban" && (
          <select
            className="h-7 rounded-md border bg-surface px-2 text-muted-foreground"
            value={cfg.group ?? ""}
            onChange={(e) => setCfg({ ...cfg, group: Number(e.target.value) || undefined })}
            data-group-field
          >
            <option value="">选择分组字段</option>
            {fields.filter((f) => f.type === "select").map((f) => (
              <option key={f.id} value={f.id}>
                按「{f.name}」分组
              </option>
            ))}
          </select>
        )}
        {current?.type === "calendar" && (
          <select
            className="h-7 rounded-md border bg-surface px-2 text-muted-foreground"
            value={cfg.group ?? ""}
            onChange={(e) => setCfg({ ...cfg, group: Number(e.target.value) || undefined })}
            data-calendar-field
          >
            <option value="">选择日期字段</option>
            {fields.filter((f) => f.type === "date").map((f) => (
              <option key={f.id} value={f.id}>
                按「{f.name}」排布
              </option>
            ))}
          </select>
        )}
        {base.role === "manage" && (
          <button className="text-muted-foreground hover:text-foreground" onClick={() => setAutoOpen(true)} data-open-automations>
            自动化
          </button>
        )}
        {canEdit && current?.type === "grid" && (
          <label className="cursor-pointer text-muted-foreground hover:text-foreground" data-import-csv>
            导入 CSV
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                const csv = await f.text();
                const res = await baseApi.importCSV(id, csv).catch(() => null);
                if (res) {
                  alert(`导入 ${res.imported} 行${res.errors.length ? `，失败 ${res.errors.length} 行：\n` + res.errors.slice(0, 5).map((x) => `第${x.row}行 ${x.err}`).join("\n") : ""}`);
                }
                refresh();
              }}
            />
          </label>
        )}
        <a href={`/api/bases/${id}/export`} className="text-muted-foreground hover:text-foreground" data-export-csv>
          导出 CSV
        </a>
        <span className="ml-auto text-subtle">
          {records.length === source.length ? `${records.length} 条记录` : `${records.length} / ${source.length} 条记录`}
        </span>
      </div>
      {current?.type === "gallery" && (
        <Gallery
          baseId={id}
          canEdit={canEdit}
          fields={visibleFields}
          records={source}
          members={members}
          onMutate={refresh}
          onOpen={(r) => setDetailRecord(r.id)}
        />
      )}
      {current?.type === "calendar" && (
        <CalendarView
          baseId={id}
          canEdit={canEdit}
          fields={visibleFields}
          records={source}
          members={members}
          dateFieldId={cfg.group}
          onMutate={refresh}
        />
      )}
      {current?.type === "gantt" && (
        <Gantt fields={visibleFields} records={source} members={members} startFieldId={cfg.group} onPickRange={() => {}} />
      )}
      {autoOpen && (
        <AutomationsPanel baseId={id} fields={fields} members={members} onClose={() => setAutoOpen(false)} />
      )}
      {detailRecord !== null && (() => {
        const rec = q.data.records.find((r) => r.id === detailRecord);
        return rec ? (
          <RecordDetail
            baseId={id}
            canEdit={canEdit}
            fields={fields}
            record={rec}
            members={members}
            onClose={() => setDetailRecord(null)}
            onMutate={refresh}
          />
        ) : null;
      })()}
      {current?.type === "kanban" ? (
        <Kanban
          baseId={id}
          canEdit={canEdit}
          fields={visibleFields}
          records={source}
          members={members}
          groupFieldId={cfg.group}
          onMutate={refresh}
          onPickGroup={() => {}}
        />
      ) : (
        <Grid baseId={id} canEdit={canEdit} fields={visibleFields} records={records} members={members} groupBy={cfg.group} onMutate={refresh} />
      )}
    </div>
  );
}

/** Toolbar popover: the label button toggles; outside clicks close; inner clicks stay. */
function Popover({ label, active, children }: { label: string; active?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        className={`rounded-md border px-2.5 py-1 hover:bg-hover ${active || open ? "border-primary text-primary" : "text-muted-foreground"}`}
        data-popover={label}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <div className="absolute left-0 top-8 z-30 w-80 rounded-lg border bg-surface p-3 text-[13px] text-foreground shadow-lg" data-popover-body={label}>
          {children}
        </div>
      )}
    </div>
  );
}

function opsFor(type: string): string[] {
  switch (type) {
    case "number":
      return ["is", "is_not", "gt", "gte", "lt", "lte", "empty", "not_empty"];
    case "checkbox":
      return ["checked", "unchecked"];
    case "date":
      return ["is", "gt", "lt", "empty", "not_empty"];
    default:
      return ["contains", "not_contains", "is", "is_not", "empty", "not_empty"];
  }
}

function FilterBar({ fields, cfg, onChange }: { fields: import("@/lib/api").Field[]; cfg: ViewConfig; onChange: (c: ViewConfig) => void }) {
  const filters = cfg.filters ?? { conj: "and" as const, rules: [] };
  const setRules = (rules: FilterRule[], conj: "and" | "or" = filters.conj) =>
    onChange({ ...cfg, filters: rules.length ? { conj, rules } : undefined });
  const noValue = (op: string) => op === "empty" || op === "not_empty" || op === "checked" || op === "unchecked";
  return (
    <Popover label={`筛选${filters.rules.length ? ` · ${filters.rules.length}` : ""}`} active={!!filters.rules.length}>
      <div className="space-y-2">
        {filters.rules.length > 1 && (
          <div className="flex items-center gap-2">
            满足
            <select
              className="h-7 rounded border bg-surface px-1"
              value={filters.conj}
              onChange={(e) => setRules(filters.rules, e.target.value as "and" | "or")}
            >
              <option value="and">全部条件（且）</option>
              <option value="or">任一条件（或）</option>
            </select>
          </div>
        )}
        {filters.rules.map((rule, i) => {
          const f = fields.find((x) => x.id === rule.f) ?? fields[0];
          return (
            <div key={i} className="flex items-center gap-1">
              <select
                className="h-7 w-24 rounded border bg-surface px-1"
                value={rule.f}
                onChange={(e) => {
                  const nf = fields.find((x) => x.id === Number(e.target.value))!;
                  const rules = [...filters.rules];
                  rules[i] = { f: nf.id, op: opsFor(nf.type)[0] };
                  setRules(rules);
                }}
              >
                {fields.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <select
                className="h-7 w-24 rounded border bg-surface px-1"
                value={rule.op}
                onChange={(e) => {
                  const rules = [...filters.rules];
                  rules[i] = { ...rule, op: e.target.value };
                  setRules(rules);
                }}
              >
                {opsFor(f?.type ?? "text").map((op) => (
                  <option key={op} value={op}>
                    {OP_LABEL[op]}
                  </option>
                ))}
              </select>
              {!noValue(rule.op) &&
                (f?.type === "checkbox" ? null : (
                  <input
                    className="h-7 flex-1 rounded border px-2 outline-none focus:border-primary"
                    type={f?.type === "number" ? "number" : "text"}
                    value={String(rule.v ?? "")}
                    onChange={(e) => {
                      const rules = [...filters.rules];
                      rules[i] = { ...rule, v: f?.type === "number" ? Number(e.target.value) : e.target.value };
                      setRules(rules);
                    }}
                  />
                ))}
              <button className="px-1 text-subtle hover:text-destructive" onClick={() => setRules(filters.rules.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          );
        })}
        <div className="flex justify-between border-t pt-2">
          <button className="text-primary hover:underline" onClick={() => setRules([...filters.rules, { f: fields[0]?.id ?? 0, op: opsFor(fields[0]?.type ?? "text")[0], v: "" }])}>
            + 添加条件
          </button>
          {filters.rules.length > 0 && (
            <button className="text-subtle hover:text-foreground" onClick={() => setRules([])}>
              清空
            </button>
          )}
        </div>
      </div>
    </Popover>
  );
}

function SortBar({ fields, cfg, onChange }: { fields: import("@/lib/api").Field[]; cfg: ViewConfig; onChange: (c: ViewConfig) => void }) {
  const sorts = cfg.sorts ?? [];
  const setSorts = (s: typeof sorts) => onChange({ ...cfg, sorts: s.length ? s : undefined });
  return (
    <Popover label={`排序${sorts.length ? ` · ${sorts.length}` : ""}`} active={!!sorts.length}>
      <div className="space-y-2">
        {sorts.map((s, i) => (
          <div key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-subtle">然后</span>}
            <select
              className="h-7 flex-1 rounded border bg-surface px-1"
              value={s.f}
              onChange={(e) => {
                const next = [...sorts];
                next[i] = { ...s, f: Number(e.target.value) };
                setSorts(next);
              }}
            >
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <button
              className="h-7 rounded border px-2"
              onClick={() => {
                const next = [...sorts];
                next[i] = { ...s, asc: !s.asc };
                setSorts(next);
              }}
            >
              {s.asc ? "↑ 升序" : "↓ 降序"}
            </button>
            <button className="px-1 text-subtle hover:text-destructive" onClick={() => setSorts(sorts.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button className="text-primary hover:underline" onClick={() => setSorts([...sorts, { f: fields[0]?.id ?? 0, asc: true }])}>
          + 添加排序
        </button>
      </div>
    </Popover>
  );
}

function HiddenBar({ fields, cfg, onChange }: { fields: import("@/lib/api").Field[]; cfg: ViewConfig; onChange: (c: ViewConfig) => void }) {
  const hidden = new Set(cfg.hidden ?? []);
  return (
    <Popover label="字段" active={hidden.size > 0}>
      <div className="max-h-64 space-y-1 overflow-auto">
        {fields.map((f) => (
          <label key={f.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-hover">
            <input
              type="checkbox"
              className="accent-primary"
              checked={!hidden.has(f.id)}
              onChange={(e) => {
                const next = new Set(hidden);
                if (e.target.checked) next.delete(f.id);
                else next.add(f.id);
                onChange({ ...cfg, hidden: next.size ? [...next] : undefined });
              }}
            />
            {f.name}
          </label>
        ))}
      </div>
    </Popover>
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
    <span className="-mx-1 cursor-text rounded px-1 hover:bg-hover" title="点击重命名" onClick={() => setEditing(true)} data-base-title>
      {title}
    </span>
  );
}

/** 把服务端的 expansions（关联/查找引用）折进 records 的展示 cells。 */
export function foldExpansions(
  fields: import("@/lib/api").Field[],
  records: import("@/lib/api").BaseRecord[],
  expansions: Record<string, unknown>,
): import("@/lib/api").BaseRecord[] {
  const linkIds = new Set(fields.filter((f) => f.type === "link").map((f) => String(f.id)));
  const lookupIds = new Set(fields.filter((f) => f.type === "lookup").map((f) => String(f.id)));
  const titles = expansions as Record<string, Record<string, unknown>>;
  const has = [...linkIds].some((k) => titles[k]) || [...lookupIds].some((k) => titles[k]);
  if (!has) return records;
  return records.map((r) => {
    const key = String(r.id);
    const cells = { ...r.cells };
    for (const fid of linkIds) {
      const links = titles[fid]?.[key] as number[] | undefined;
      const tmap = (titles[fid + ":titles"] ?? {}) as Record<string, string>;
      if (links) cells[fid] = links.map((id) => tmap[String(id)] ?? `#${id}`) as unknown as import("@/lib/api").Cell;
    }
    for (const fid of lookupIds) {
      const vals = titles[fid]?.[key] as unknown[] | undefined;
      if (vals) cells[fid] = vals as unknown as import("@/lib/api").Cell;
    }
    return { ...r, cells };
  });
}
