import type { BaseRecord, Field, User } from "@/lib/api";
import { displayValue, memberName, optionColor, personIDs } from "./registry";
import { TypeGlyph } from "./cells";

export interface DashboardStats {
  total: number;
  numbers: { field: Field; sum: number; avg: number | null; filled: number }[];
  selects: { field: Field; buckets: { key: string; count: number }[] }[];
  checkboxes: { field: Field; checked: number }[];
}

/** Aggregate the authorized records into the 仪表盘 cards. */
export function dashboardStats(records: BaseRecord[], fields: Field[], members: User[]): DashboardStats {
  const numbers = fields.filter((f) => f.type === "number").map((field) => {
    const vals = records.map((r) => displayValue(r, field, members)).filter((v): v is number => typeof v === "number");
    const sum = vals.reduce((a, b) => a + b, 0);
    return { field, sum, avg: vals.length ? sum / vals.length : null, filled: vals.length };
  });
  const selects = fields.filter((f) => f.type === "select" || f.type === "multi_select" || f.type === "person").map((field) => {
    const counts = new Map<string, number>((field.options ?? []).map((o) => [o, 0]));
    let none = 0;
    for (const r of records) {
      const v = displayValue(r, field, members);
      // 人员字段（含允许多选）按成员逐个计数，与多选的聚合方式一致。
      const keys = field.type === "person"
        ? personIDs(v).map((id) => memberName(id, members) || `成员 #${id}`)
        : Array.isArray(v)
          ? v.map(String)
          : typeof v === "string" && v
            ? [v]
            : [];
      if (!keys.length) none++;
      for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const buckets = [...counts].map(([key, count]) => ({ key, count }));
    if (none) buckets.push({ key: "", count: none });
    return { field, buckets };
  });
  const checkboxes = fields.filter((f) => f.type === "checkbox").map((field) => ({ field, checked: records.filter((r) => displayValue(r, field, members) === true).length }));
  return { total: records.length, numbers, selects, checkboxes };
}

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("zh-CN") : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 }));

/** 仪表盘: read-only summary cards computed from the records the viewer can see. */
export function Dashboard({ records, fields, members }: { records: BaseRecord[]; fields: Field[]; members: User[] }) {
  const s = dashboardStats(records, fields, members);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[#f5f6f7] p-5" data-dashboard>
      <div className="mb-4 flex items-center gap-2">
        <h2 className="text-[16px] font-medium">仪表盘</h2>
        <span className="text-[12px] text-subtle">根据当前可见数据实时统计</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
        <Card title="记录总数" glyph={null}><Big>{fmt(s.total)}</Big><Sub>条记录</Sub></Card>
        {s.numbers.map(({ field, sum, avg, filled }) => (
          <Card key={field.id} title={`${field.name} · 求和`} glyph={field}>
            <Big>{fmt(sum)}</Big>
            <Sub>平均 {avg === null ? "—" : fmt(avg)} · 已填 {filled} 条</Sub>
          </Card>
        ))}
        {s.checkboxes.map(({ field, checked }) => (
          <Card key={field.id} title={`${field.name} · 已勾选`} glyph={field}>
            <Big>{fmt(checked)}</Big>
            <Sub>占比 {s.total ? Math.round((checked / s.total) * 100) : 0}%</Sub>
          </Card>
        ))}
      </div>
      {s.selects.length > 0 && (
        <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-4">
          {s.selects.map(({ field, buckets }) => {
            const max = Math.max(1, ...buckets.map((b) => b.count));
            return (
              <Card key={field.id} title={`按「${field.name}」统计`} glyph={field}>
                <div className="mt-2 space-y-2" data-dashboard-chart={field.id}>
                  {buckets.map((b) => {
                    const [bg, fg] = b.key ? optionColor(field, b.key) : ["#F2F3F5", "#646A73"];
                    return (
                      <div key={b.key || "__none"} className="flex items-center gap-2 text-[12px]">
                        <span className="w-20 shrink-0 truncate text-muted-foreground">{b.key || "未填写"}</span>
                        <div className="h-5 min-w-0 flex-1 rounded bg-[#f2f3f5]">
                          <div className="h-5 rounded" style={{ width: `${(b.count / max) * 100}%`, background: fg, opacity: b.count ? 0.85 : 0 }} title={`${b.count}`} />
                        </div>
                        <span className="w-8 shrink-0 text-right tabular-nums" style={{ color: b.count ? fg : undefined }}>{b.count}</span>
                        <span className="sr-only" style={{ background: bg }} />
                      </div>
                    );
                  })}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Card({ title, glyph, children }: { title: string; glyph: Field | null; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[#dee0e3] bg-white p-4" data-dashboard-card>
      <h3 className="flex items-center gap-1.5 text-[13px] text-muted-foreground">{glyph && <TypeGlyph t={glyph.type} size={14} />}{title}</h3>
      {children}
    </section>
  );
}
const Big = ({ children }: { children: React.ReactNode }) => <div className="mt-2 text-[28px] font-semibold leading-9 tabular-nums">{children}</div>;
const Sub = ({ children }: { children: React.ReactNode }) => <div className="mt-0.5 text-[12px] text-subtle">{children}</div>;
