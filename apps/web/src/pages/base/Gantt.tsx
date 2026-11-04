import { useMemo, useState } from "react";
import type { BaseRecord, Field, User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { displayValue } from "./registry";

const DAY = 24 * 3600 * 1000;

function parseDay(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** 甘特视图（MVP）：按「开始/结束」两个日期字段在月历时间轴上画横条。 */
export function Gantt({
  fields,
  records,
  members,
  startFieldId,
  endFieldId,
  onPickRange,
}: {
  fields: Field[];
  records: BaseRecord[];
  members: User[];
  startFieldId?: number | null;
  endFieldId?: number | null;
  onPickRange?: () => void;
}) {
  const dateFields = fields.filter((f) => f.type === "date");
  const startField = fields.find((f) => f.id === startFieldId && f.type === "date") ?? dateFields[0];
  const endField = fields.find((f) => f.id === endFieldId && f.type === "date") ?? dateFields[1] ?? startField;
  const title = fields.find((f) => f.type === "text") ?? fields[0];

  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const days = useMemo(() => new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(), [month]);

  const bars = useMemo(() => {
    const out: { rec: BaseRecord; start: number; end: number; label: string }[] = [];
    const monthStart = month.getTime();
    for (const r of records) {
      const s = parseDay(startField ? r.cells[startField.id] : undefined);
      const e = parseDay(endField ? r.cells[endField.id] : undefined) ?? s;
      if (!s && !e) continue;
      const st = s ? new Date(s + "T00:00:00").getTime() : new Date(e + "T00:00:00").getTime();
      const en = e ? new Date(e + "T00:00:00").getTime() : st;
      if (en < monthStart || st > monthStart + days * DAY) continue;
      const label = String(displayValue(r, title, members) ?? "") || "未命名";
      out.push({ rec: r, start: Math.max(st, monthStart), end: Math.min(en, monthStart + (days - 1) * DAY), label });
    }
    return out;
  }, [records, month, startField, endField, members, title, days]);

  if (!startField) {
    return (
      <div className="grid flex-1 place-items-center text-[14px] text-muted-foreground">
        <p>甘特需要日期字段——先添加一个「日期」字段作为开始时间</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-gantt>
      <div className="flex items-center gap-2 px-4 py-2 text-[14px] font-medium">
        <button className="rounded px-2 hover:bg-hover" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
          ‹
        </button>
        {month.getFullYear()} 年 {month.getMonth() + 1} 月
        <button className="rounded px-2 hover:bg-hover" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
          ›
        </button>
        <button className="rounded-md border px-2 py-0.5 text-[12px] font-normal text-muted-foreground hover:bg-hover" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
          今天
        </button>
        <span className="text-[12px] font-normal text-subtle">
          开始「{startField.name}」– 结束「{endField?.name ?? startField.name}」
        </span>
      </div>
      <div className="flex border-b bg-sidebar/60 text-center text-[11px] text-muted-foreground">
        <div className="w-48 shrink-0 py-1 text-left pl-3">记录</div>
        {Array.from({ length: days }, (_, i) => (
          <div key={i} className={cn("min-w-[26px] flex-1 py-1", (i + 5) % 7 === 0 && "text-subtle")}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {bars.length === 0 && <p className="py-12 text-center text-[13px] text-subtle">本月没有排期的记录</p>}
        {bars.map((b) => {
          const sOff = Math.round((b.start - month.getTime()) / DAY);
          const len = Math.max(1, Math.round((b.end - b.start) / DAY) + 1);
          return (
            <div key={b.rec.id} className="flex items-center border-b py-1.5" data-gantt-row={b.rec.id}>
              <div className="w-48 shrink-0 truncate pl-3 pr-2 text-[13px]" title={b.label}>
                {b.label}
              </div>
              <div className="relative flex min-w-[26px] flex-1 flex-wrap" style={{ minHeight: 20 }}>
                {Array.from({ length: days }, (_, i) => (
                  <div key={i} className={cn("min-w-[26px] flex-1 self-stretch", (i + 5) % 7 === 0 && "bg-sidebar/40")} />
                ))}
                <div
                  className="absolute top-0.5 h-5 rounded-md bg-primary/80 text-[11px] leading-5 text-white"
                  style={{ left: `${(sOff / days) * 100}%`, width: `${(len / days) * 100}%` }}
                  title={`${b.label}: ${b.start ? new Date(b.start).toLocaleDateString("zh-CN") : ""} – ${new Date(b.end).toLocaleDateString("zh-CN")}`}
                  data-gantt-bar={b.rec.id}
                >
                  <span className="truncate px-1.5">{b.label}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
