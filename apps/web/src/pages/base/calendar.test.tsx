import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BaseRecord, Field } from "@/lib/api";
import { CalendarView, calendarDate, calendarDateTime, calendarDays, calendarKey, calendarTimedSpan, groupCalendarRecords, layoutDayTimedEvents, shiftCalendar } from "./calendar-view";
import { sessionWriteLedger } from "./write-safety";

const record = (id: number, date?: string): BaseRecord => ({ id, baseId: 1, position: id, cells: { "1": `记录${id}`, ...(date === undefined ? {} : { "2": date }) } });
const fields: Field[] = [{ id: 1, name: "名称", type: "text", position: 1 }, { id: 2, name: "日期", type: "date", position: 2 }];
const date = (value: string) => calendarDate(value)!;
const renderCalendar = (element: React.ReactElement) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>);
afterEach(() => vi.useRealTimers());

describe("calendar date handling", () => {
  it("accepts only valid date-only values, including leap years and early years", () => {
    expect(calendarKey(date("2024-02-29"))).toBe("2024-02-29");
    expect(calendarKey(date("0001-01-01"))).toBe("0001-01-01");
    for (const value of ["2023-02-29", "2024-04-31", "2024-13-01", "2024-00-01", "0000-01-01", "2024-01-01T00:00:00Z", "", null]) expect(calendarDate(value)).toBeNull();
  });

  it("keeps undated and invalid records out of every day", () => {
    const result = groupCalendarRecords([record(1, "2026-11-07"), record(2), record(3, "2026-02-30")], 2);
    expect(result.byDay.get("2026-11-07")?.map(r => r.id)).toEqual([1]);
    expect(result.unscheduled.map(r => r.id)).toEqual([2, 3]);
    expect(result.byDay.size).toBe(1);
  });

  it("builds Monday-first days across year and leap-month boundaries", () => {
    expect(calendarDays(date("2025-01-01"), "week").map(calendarKey)).toEqual(["2024-12-30", "2024-12-31", "2025-01-01", "2025-01-02", "2025-01-03", "2025-01-04", "2025-01-05"]);
    const month = calendarDays(date("2024-02-15"), "month").map(calendarKey);
    expect(month[0]).toBe("2024-01-29");
    expect(month.at(-1)).toBe("2024-03-03");
    expect(month).toContain("2024-02-29");
    expect(calendarDays(date("2024-02-29"), "day").map(calendarKey)).toEqual(["2024-02-29"]);
  });

  it("moves day/week by calendar dates and clamps month-end rather than overflowing", () => {
    expect(calendarKey(shiftCalendar(date("2024-01-31"), "month", 1))).toBe("2024-02-29");
    expect(calendarKey(shiftCalendar(date("2025-01-31"), "month", 1))).toBe("2025-02-28");
    expect(calendarKey(shiftCalendar(date("2024-03-10"), "week", 1))).toBe("2024-03-17");
    expect(calendarKey(shiftCalendar(date("2024-11-03"), "day", -1))).toBe("2024-11-02");
  });
});

describe("calendar view", () => {
  it("shows dated events in their day and undated/invalid records in a separate list", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const html = renderCalendar(<CalendarView baseId={1} canEdit fields={fields} records={[record(1, "2026-11-07"), record(2), record(3, "2026-02-30")]} members={[]} onMutate={() => {}} onOpen={() => {}} />);
    expect(html).toContain('data-day="2026-11-07"');
    expect(html).toContain('aria-label="未排期记录"');
    expect(html).toContain('data-event="1"');
    expect(html).toContain('data-event="2"');
    expect(html).toContain('data-event="3"');
    expect(html).toContain('aria-label="日历显示维度"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('2026-11-07 新增记录');
  });

  it("does not offer mutation controls to viewers or fake a missing date field", () => {
    const readonly = renderCalendar(<CalendarView baseId={1} canEdit={false} fields={fields} records={[record(1)]} members={[]} onMutate={() => {}} onOpen={() => {}} />);
    expect(readonly).not.toContain("新增记录");
    expect(readonly).not.toContain('draggable="true"');
    const empty = renderCalendar(<CalendarView baseId={1} canEdit fields={fields.slice(0, 1)} records={[record(1)]} members={[]} onMutate={() => {}} />);
    expect(empty).toContain("日历需要日期字段");
    expect(empty).not.toContain('data-day=');
  });

  it("blocks calendar record creation while another create has an unknown result", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const client = new QueryClient();
    const ledger = sessionWriteLedger(client, 1);
    const op = ledger.begin("新增记录", "", "record:create")!;
    ledger.fail(op, "结果不确定");
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><CalendarView baseId={1} canEdit fields={fields} records={[record(1)]} members={[]} onMutate={() => {}} /></QueryClientProvider>);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="2026-11-07 新增记录"/);
  });

  it("supports minute-precision hourly datetimes, timed spans, and overlapping column layout", () => {
    expect(calendarDateTime("2026-11-20")).toMatchObject({ dayKey: "2026-11-20", isAllDay: true, minutes: null });
    expect(calendarDateTime("2026-11-20 09:30")).toMatchObject({ dayKey: "2026-11-20", isAllDay: false, minutes: 570 });
    expect(calendarDateTime("2026-11-20T09:30:00Z")).toBeNull();
    expect(calendarDateTime("2026-11-20 24:00")).toBeNull();

    const grouped = groupCalendarRecords([
      record(1, "2026-11-20 14:00"),
      record(2, "2026-11-20"),
      record(3, "2026-11-20 09:30"),
    ], 2);
    expect(grouped.byDay.get("2026-11-20")?.map((r) => r.id)).toEqual([2, 3, 1]);

    const span = calendarTimedSpan("2026-11-20 09:00", "2026-11-20 10:30", false);
    expect(span).toEqual({ dayKey: "2026-11-20", startMin: 540, endMin: 630, duration: 90 });

    const layout = layoutDayTimedEvents([
      { id: 1, startMin: 540, endMin: 660 },
      { id: 2, startMin: 600, endMin: 720 },
      { id: 3, startMin: 780, endMin: 840 },
    ]);
    expect(layout.get(1)).toEqual({ col: 0, cols: 2 });
    expect(layout.get(2)).toEqual({ col: 1, cols: 2 });
    expect(layout.get(3)).toEqual({ col: 0, cols: 1 });
  });
});
