import { describe, expect, it } from "vitest";
import { tableSelectionScrollSpeed } from "./table-selection-scroll";

describe("table selection edge scrolling", () => {
  it("is idle away from the edge and accelerates toward it", () => {
    expect(tableSelectionScrollSpeed(100, 0, 200)).toBe(0);
    expect(tableSelectionScrollSpeed(39, 0, 200)).toBe(-1);
    expect(tableSelectionScrollSpeed(0, 0, 200)).toBe(-14);
    expect(tableSelectionScrollSpeed(200, 0, 200)).toBe(14);
    expect(tableSelectionScrollSpeed(500, 0, 200)).toBe(24);
    expect(tableSelectionScrollSpeed(-500, 0, 200)).toBe(-24);
  });

  it("handles short and invalid viewports without scrolling at their midpoint", () => {
    expect(tableSelectionScrollSpeed(20, 0, 40)).toBe(0);
    expect(tableSelectionScrollSpeed(0, 0, 0)).toBe(0);
    expect(tableSelectionScrollSpeed(Infinity, 0, 100)).toBe(0);
  });
});
