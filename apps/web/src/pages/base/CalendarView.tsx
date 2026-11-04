import { useMemo, useState } from "react";
import { baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { displayValue } from "./registry";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Calendar (日历) view: month grid keyed by the view's date field. */
export function CalendarView({
  baseId,
  canEdit,
  fields,
  records,
  members,
  dateFieldId,
  onMutate,
}: {
  baseId: number;
  canEdit: boolean;
  fields: Field[];
  records: BaseRecord[];
  members: User[];
  dateFieldId?: number | null;
  onMutate: () => void;
}) {
  const dateField = fields.find((f) => f.id === dateFieldId && f.type === "date") ?? fields.find((f) => f.type === "date");
  const title = fields.find((f) => f.type === "text") ?? fields[0];
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  // one-off: records lacking a date land on today (so nothing is invisible)
  const byDay = useMemo(() => {
    const m = new Map<string, BaseRecord[]>();
    const today = ymd(new Date());
    for (const r of records) {
      const raw = dateField ? r.cells[dateField.id] : undefined;
      const key = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today;
      m.set(key, [...(m.get(key) ?? []), r]);
    }
    return m;
  }, [records, dateField]);

  if (!dateField) {
    return (
      <div className="grid flex-1 place-items-center text-[14px] text-muted-foreground">
        <p>日历需要一个日期字段——先添加一个「日期」字段</p>
      </div>
    );
  }

  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [
    ...Array.from({ length: startOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(cursor.getFullYear(), cursor.getMonth(), i + 1)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const drop = async (day: string, rid: number) => {
    const rec = records.find((r) => r.id === rid);
    if (!rec) return;
    const cur: Cell | undefined = rec.cells[dateField.id];
    if (cur === day) return;
    await baseApi.setCells(baseId, rid, { [dateField.id]: day }).catch(() => {});
    onMutate();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-calendar>
      <div className="flex items-center gap-2 px-4 py-2 text-[14px] font-medium">
        <button className="rounded px-2 hover:bg-hover" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
          ‹
        </button>
        {cursor.getFullYear()} 年 {cursor.getMonth() + 1} 月
        <button className="rounded px-2 hover:bg-hover" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
          ›
        </button>
        <button className="rounded-md border px-2 py-0.5 text-[12px] font-normal text-muted-foreground hover:bg-hover" onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
          今天
        </button>
        <span className="text-[12px] font-normal text-subtle">按「{dateField.name}」排布，拖拽卡片换日期</span>
      </div>
      <div className="grid grid-cols-7 border-b bg-sidebar/60 px-2 text-center text-[12px] text-muted-foreground">
        {WEEK.map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 overflow-y-auto">
        {cells.map((d, i) => {
          if (!d) return <div key={i} className="border-b border-r bg-sidebar/30" />;
          const key = ymd(d);
          const list = byDay.get(key) ?? [];
          const isToday = key === ymd(new Date());
          return (
            <div
              key={i}
              className={cn("min-h-20 border-b border-r p-1", isToday && "bg-accent/40")}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const rid = Number(e.dataTransfer.getData("text/rid"));
                if (rid) void drop(key, rid);
              }}
              data-day={key}
            >
              <div className={cn("mb-1 inline-grid size-5 place-items-center rounded-full text-[12px]", isToday ? "bg-primary font-medium text-white" : "text-subtle")}>
                {d.getDate()}
              </div>
              <div className="space-y-1">
                {list.map((r) => (
                  <div
                    key={r.id}
                    draggable={canEdit}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/rid", String(r.id));
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className="cursor-grab truncate rounded bg-[#EDF2FF] px-1.5 py-0.5 text-[12px] text-primary"
                    title={String(displayValue(r, title, members) ?? "")}
                    data-event={r.id}
                  >
                    {String(displayValue(r, title, members) ?? "") || "未命名"}
                  </div>
                ))}
                {canEdit && (
                  <button
                    className="w-full truncate rounded px-1 text-left text-[11px] text-subtle hover:bg-hover"
                    title="此日期新增记录"
                    onClick={() => baseApi.addRecord(baseId, { [dateField.id]: key }).then(onMutate)}
                  >
                    +
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
