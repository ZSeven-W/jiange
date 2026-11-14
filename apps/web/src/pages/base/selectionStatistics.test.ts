import { describe, expect, it } from "vitest";
import type { BaseRecord, Field } from "@/lib/api";
import { captureGridSelection } from "./gridSelection";
import { formatSelectionNumber, selectedRecordStatistics, selectionStatistics } from "./selectionStatistics";

const fields: Field[] = [
  { id: 1, name: "文本", type: "text", position: 1 },
  { id: 2, name: "数值", type: "number", position: 2 },
  { id: 3, name: "人员", type: "person", position: 3 },
];
const records: BaseRecord[] = [
  { id: 1, baseId: 1, position: 1, cells: { 1: "10", 2: 0.1, 3: 12 } },
  { id: 2, baseId: 1, position: 2, cells: { 1: "", 2: 0.2 } },
  { id: 3, baseId: 1, position: 3, cells: {} },
];
const value = (record: BaseRecord, field: Field) => record.cells[field.id];

describe("selection statistics", () => {
  it("counts nonempty cells and sums only numerical values, not text or person IDs", () => {
    const selected = captureGridSelection({ ar: 2, af: 2, rr: 0, rf: 0 }, records, fields)!;
    const stats = selectionStatistics(selected, records, fields, value)!;
    expect(stats.count).toBe(4);
    expect(formatSelectionNumber(stats.sum)).toBe("0.3");
    expect(formatSelectionNumber(stats.average)).toBe("0.15");
    expect(formatSelectionNumber(1234567890123456)).toBe("1234567890123456");
  });
  it("returns zero for an empty range and rejects stale row order", () => {
    const selected = captureGridSelection({ ar: 2, af: 0, rr: 2, rf: 2 }, records, fields)!;
    expect(selectionStatistics(selected, records, fields, value)).toEqual({ count: 0, sum: 0, average: 0 });
    expect(selectionStatistics(selected, [records[1], records[0], records[2]], fields, value)).toBeNull();
  });
  it("never renders a non-finite aggregate", () => {
    const selected = captureGridSelection({ ar: 0, af: 1, rr: 1, rf: 1 }, records, fields)!;
    const stats = selectionStatistics(selected, records, fields, () => Number.MAX_VALUE)!;
    expect(formatSelectionNumber(stats.sum)).toBe("—");
    expect(formatSelectionNumber(stats.average)).toBe("—");
  });
  it("summarizes only currently visible checked rows and fields", () => {
    const checked = new Set([1, 2, 99]);
    const result = selectedRecordStatistics(checked, records.slice(1), fields.slice(0, 2), value)!;
    expect(result).toEqual({ count: 1, sum: 0.2, average: 0.2 });
    expect(selectedRecordStatistics(new Set([99]), records, fields, value)).toBeNull();
  });
});
