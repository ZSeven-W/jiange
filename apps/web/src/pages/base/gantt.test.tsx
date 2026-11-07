import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BaseRecord, Field } from "@/lib/api";
import { Gantt, ganttDate, ganttDay, ganttDropIndex, ganttMoveCells, ganttRange, rescheduleGantt } from "./Gantt";

const day = (text: string) => ganttDay(text)!;
const fields: Field[] = [
  { id: 1, name: "任务", type: "text", position: 0 },
  { id: 2, name: "开始", type: "date", position: 1 },
  { id: 3, name: "结束", type: "date", position: 2 },
];
const record = (id: number, start: string, end?: string): BaseRecord => ({ id, baseId: 1, position: id, cells: { "1": `任务${id}`, "2": start, ...(end ? { "3": end } : {}) } });

describe("gantt civil dates and drag geometry", () => {
  it("validates real date-only values and handles early years", () => {
    expect(ganttDate(day("0001-01-01"))).toBe("0001-01-01");
    expect(ganttDate(day("2024-02-29"))).toBe("2024-02-29");
    for (const invalid of ["2023-02-29", "2024-04-31", "0000-01-01", "2024-01-01T00:00:00Z", "", null]) expect(ganttDay(invalid)).toBeNull();
    expect(ganttDate(day("9999-12-31") + 1)).toBeNull();
  });

  it("keeps the original duration when dragging a bar clipped by the month", () => {
    const range = ganttRange("2026-10-20", "2026-11-10", false)!;
    // Grab Nov 3, 14 days into the original range, and drop it on Nov 20.
    expect(rescheduleGantt(range, day("2026-11-20"), 14)).toEqual({ start: "2026-11-06", end: "2026-11-27" });
    expect(rescheduleGantt(range, day("2026-11-20"), 99)).toBeNull();
  });

  it("moves across DST dates as civil days without turning midnight into the previous day", () => {
    const spring = ganttRange("2024-03-08", "2024-03-12", false)!;
    expect(rescheduleGantt(spring, day("2024-03-11"), 0)).toEqual({ start: "2024-03-11", end: "2024-03-15" });
    const autumn = ganttRange("2024-11-01", "2024-11-05", false)!;
    expect(rescheduleGantt(autumn, day("2024-11-04"), 0)).toEqual({ start: "2024-11-04", end: "2024-11-08" });
  });

  it("preserves empty end dates and refuses invalid or reversed ranges", () => {
    expect(rescheduleGantt(ganttRange("2026-11-07", undefined, false)!, day("2026-11-09"), 0)).toEqual({ start: "2026-11-09", end: null });
    expect(ganttRange("2026-11-07", "2026-11-06", false)).toBeNull();
    expect(ganttRange("2026-11-07", "2026-11-31", false)).toBeNull();
    expect(ganttRange("2026-11-07", "", false)).toBeNull();
    expect(ganttRange("", "2026-11-07", false)).toBeNull();
  });

  it("sends matching expected and written fields without filling an empty end", () => {
    expect(ganttMoveCells(2, 3, "2026-11-07", undefined, { start: "2026-11-09", end: null })).toEqual({
      expected: { 2: "2026-11-07", 3: null }, cells: { 2: "2026-11-09", 3: null },
    });
    expect(ganttMoveCells(2, 2, "2026-11-07", "2026-11-07", { start: "2026-11-09", end: null })).toEqual({
      expected: { 2: "2026-11-07" }, cells: { 2: "2026-11-09" },
    });
  });

  it("hits the actual timeline bounds rather than an absolute overlay", () => {
    expect(ganttDropIndex(230, 200, 930, 31)).toBe(1);
    expect(ganttDropIndex(1129, 200, 930, 31)).toBe(30);
    expect(ganttDropIndex(1130, 200, 930, 31)).toBeNull();
    expect(ganttDropIndex(199, 200, 930, 31)).toBeNull();
    expect(ganttDropIndex(200, 200, 0, 31)).toBeNull();
  });
});

describe("gantt view", () => {
  it("renders the full original dates while clipping only the visual bar", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    try {
      const html = renderToStaticMarkup(<Gantt baseId={1} canEdit fields={fields} records={[record(1, "2026-10-20", "2026-11-10"), record(2, "2026-11-09", "2026-11-08")]} members={[]} onMutate={() => {}} onOpen={() => {}} />);
      expect(html).toContain('data-gantt-bar="1"');
      expect(html).toContain("2026-10-20 – 2026-11-10");
      expect(html).not.toContain('data-gantt-bar="2"');
      expect(html).toContain('data-gantt-timeline="1"');
      expect(html).toContain('draggable="true"');
      expect(html).not.toContain("pointer-events-none absolute inset-0");
    } finally { vi.useRealTimers(); }
  });

  it("does not offer dragging to readers", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    try {
      const html = renderToStaticMarkup(<Gantt baseId={1} canEdit={false} fields={fields} records={[record(1, "2026-11-07")]} members={[]} onMutate={() => {}} />);
      expect(html).not.toContain('draggable="true"');
      expect(html).toContain('data-gantt-bar="1"');
    } finally { vi.useRealTimers(); }
  });
});
