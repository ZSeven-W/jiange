import { describe, expect, it } from "vitest";
import { snapTableWidth, type TableWidthSnapCandidate } from "./table-width-snap";

const candidate = (kind: TableWidthSnapCandidate["kind"], width: number): TableWidthSnapCandidate => ({ kind, width, x: 300, top: 40, bottom: 180 });

describe("document table column snapping", () => {
  it("chooses the closest alignment target with deterministic ties", () => {
    const options = [candidate("page", 161), candidate("table", 159), candidate("equal", 160)];
    expect(snapTableWidth(160, options)).toEqual({ width: 160, guide: options[2] });
    expect(snapTableWidth(159, options)).toEqual({ width: 159, guide: options[1] });
    expect(snapTableWidth(160, [options[0], options[1]])).toEqual({ width: 159, guide: options[1] });
  });
  it("does not snap outside the threshold or while Alt is held", () => {
    const options = [candidate("equal", 150)];
    expect(snapTableWidth(142, options)).toEqual({ width: 142, guide: null });
    expect(snapTableWidth(147, options, true)).toEqual({ width: 147, guide: null });
    expect(snapTableWidth(144, options).width).toBe(150);
  });
  it("ignores malformed geometry and enforces width limits", () => {
    const invalid = [{ ...candidate("table", 150), x: NaN }, candidate("page", 99), { ...candidate("equal", 100), bottom: 0 }];
    expect(snapTableWidth(100, invalid)).toEqual({ width: 100, guide: null });
    expect(snapTableWidth(12, [])).toEqual({ width: 100, guide: null });
    expect(snapTableWidth(100500, [])).toEqual({ width: 100000, guide: null });
    expect(snapTableWidth(NaN, [])).toEqual({ width: 100, guide: null });
  });
});
