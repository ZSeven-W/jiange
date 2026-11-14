import { describe, expect, it } from "vitest";
import type { BaseRecord } from "@/lib/api";
import { recordMenuTargets, sameRecordTargets } from "./recordMenuTargets";
import { recordMenuPosition } from "./RecordMenu";

const records: BaseRecord[] = [1, 2, 3].map((id) => ({ id, baseId: 1, position: id, cells: {} }));
describe("record menu targets", () => {
  it("targets checked rows only when opening a checked row", () => {
    expect(recordMenuTargets(2, new Set([1, 2]), records)).toEqual([1, 2]);
    expect(recordMenuTargets(3, new Set([1, 2]), records)).toEqual([3]);
    expect(recordMenuTargets(1, new Set([1, 2]), records.slice(1))).toEqual([]);
  });
  it("rejects a changed target set after the menu was opened", () => {
    expect(sameRecordTargets([1, 2], [2, 1])).toBe(true);
    expect(sameRecordTargets([1, 2], [1])).toBe(false);
    expect(sameRecordTargets([1, 1], [1, 2])).toBe(false);
    expect(sameRecordTargets([], [])).toBe(false);
  });
  it("keeps a menu inside the viewport near the lower-right edge", () => {
    expect(recordMenuPosition(385, 840, 390, 844, 124)).toEqual({ left: 202, top: 712 });
    expect(recordMenuPosition(30, 40, 390, 844, 124)).toEqual({ left: 30, top: 40 });
  });
});
