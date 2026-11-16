import { describe, expect, it } from "vitest";
import { tableHeaderOffset } from "./table-sticky-header";

describe("document table title row positioning", () => {
  it("pins only after the row leaves the viewport and stops at the table end", () => {
    expect(tableHeaderOffset(120, 40, 600, 64)).toBe(0);
    expect(tableHeaderOffset(20, 40, 600, 64)).toBe(44);
    expect(tableHeaderOffset(-500, 40, 90, 64)).toBe(550);
    expect(tableHeaderOffset(-500, 40, 20, 64)).toBe(480);
  });
  it("rejects invalid geometry", () => {
    expect(tableHeaderOffset(NaN, 40, 100, 0)).toBe(0);
    expect(tableHeaderOffset(0, 0, 100, 0)).toBe(0);
    expect(tableHeaderOffset(0, 200, 100, 50)).toBe(0);
  });
});
