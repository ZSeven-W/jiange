import { describe, expect, it } from "vitest";
import { formatBaseChange, lastBaseChange } from "./viewPresentation";

describe("base modification time", () => {
  it("uses the newest available record or file metadata and ignores invalid dates", () => {
    expect(lastBaseChange("2026-11-07T00:00:00Z", [{ updatedAt: "invalid" }, { updatedAt: "2026-11-07T01:00:00Z" }])).toBe("2026-11-07T01:00:00.000Z");
    expect(lastBaseChange("invalid", [])).toBeNull();
  });
  it("does not claim an invalid timestamp as a real modification time", () => {
    expect(formatBaseChange(null)).toBe("修改时间未知");
    expect(formatBaseChange("invalid")).toBe("修改时间未知");
    expect(formatBaseChange("2026-11-07T01:00:00Z", new Date("2026-11-07T01:00:20Z"))).toBe("刚刚");
    expect(formatBaseChange("2026-11-07T01:00:00Z", new Date("2026-11-07T01:04:00Z"))).toBe("4 分钟前");
  });
});
