import type { BaseRecord, Field, User } from "@/lib/api";
import { t, useI18n } from "@/lib/i18n";
import { displayValue, memberName, optionColor, personIDs } from "./registry";
import { TypeGlyph } from "./cells";

export interface DashboardStats {
  total: number;
  numbers: { field: Field; sum: number; avg: number | null; filled: number }[];
  selects: { field: Field; buckets: { key: string; count: number; memberId?: number }[] }[];
  checkboxes: { field: Field; checked: number }[];
}

/** Aggregate the authorized records into the 仪表盘 cards. */
export function dashboardStats(records: BaseRecord[], fields: Field[], members: User[]): DashboardStats {
  const numbers = fields.filter((f) => f.type === "number").map((field) => {
    const vals = records.map((r) => displayValue(r, field, members)).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const sum = vals.reduce((a, b) => a + b, 0);
    return { field, sum, avg: vals.length ? sum / vals.length : null, filled: vals.length };
  });
  const selects = fields.filter((f) => f.type === "select" || f.type === "multi_select" || f.type === "person").map((field) => {
    if (field.type === "person") {
      const counts = new Map<number, number>();
      let none = 0;
      for (const record of records) {
        const ids = new Set(personIDs(displayValue(record, field, members)));
        if (!ids.size) none++;
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const names = new Map<string, number>();
      for (const id of counts.keys()) {
        const name = memberName(id, members);
        if (name) names.set(name, (names.get(name) ?? 0) + 1);
      }
      const buckets: { key: string; count: number; memberId?: number }[] = [...counts].map(([id, count]) => {
        const name = memberName(id, members);
        return { key: name ? (names.get(name)! > 1 ? `${name} (#${id})` : name) : t("成员 #{id}", { id }), count, memberId: id };
      });
      if (none) buckets.push({ key: "", count: none });
      return { field, buckets };
    }
    const counts = new Map<string, number>((field.options ?? []).map((o) => [o, 0]));
    let none = 0;
    for (const r of records) {
      const v = displayValue(r, field, members);
      const keys = Array.isArray(v)
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
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-[#f5f6f7] p-3 sm:p-5" data-dashboard>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-[16px] font-medium">{t("仪表盘")}</h2>
        <span className="text-[12px] text-subtle">{t("统计你有权访问的全部记录")}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-4">
        <Card title={t("记录总数")} glyph={null}><Big>{fmt(s.total)}</Big><Sub>{t("条记录")}</Sub></Card>
        {s.numbers.map(({ field, sum, avg, filled }) => (
          <Card key={field.id} title={t("{name} · 求和", { name: field.name })} glyph={field}>
            <Big>{fmt(sum)}</Big>
            <Sub>{t("平均 {avg} · 已填 {n} 条", { avg: avg === null ? "—" : fmt(avg), n: filled })}</Sub>
          </Card>
        ))}
        {s.checkboxes.map(({ field, checked }) => (
          <Card key={field.id} title={t("{name} · 已勾选", { name: field.name })} glyph={field}>
            <Big>{fmt(checked)}</Big>
            <Sub>{t("占比 {p}%", { p: s.total ? Math.round((checked / s.total) * 100) : 0 })}</Sub>
          </Card>
        ))}
      </div>
      {s.selects.length > 0 && (
        <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(min(100%,360px),1fr))] gap-4">
          {s.selects.map(({ field, buckets }) => {
            const max = Math.max(1, ...buckets.map((b) => b.count));
            return (
              <Card key={field.id} title={t("按「{name}」统计", { name: field.name })} glyph={field}>
                <div className="mt-2 space-y-2" data-dashboard-chart={field.id}>
                  {buckets.map((b) => {
                    const [bg, fg] = b.key ? optionColor(field, b.key) : ["#F2F3F5", "#646A73"];
                    return (
                      <div key={b.memberId === undefined ? `option:${b.key}` : `member:${b.memberId}`} className="flex items-center gap-2 text-[12px]">
                        <span className="w-20 shrink-0 break-all text-muted-foreground">{b.key || t("未填写")}</span>
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
      <h3 className="flex min-w-0 items-center gap-1.5 break-words text-[13px] text-muted-foreground">{glyph && <TypeGlyph t={glyph.type} size={14} />}{title}</h3>
      {children}
    </section>
  );
}
const Big = ({ children }: { children: React.ReactNode }) => <div className="mt-2 text-[28px] font-semibold leading-9 tabular-nums">{children}</div>;
const Sub = ({ children }: { children: React.ReactNode }) => <div className="mt-0.5 text-[12px] text-subtle">{children}</div>;
