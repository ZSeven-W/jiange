import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/api";
import { aiFilterPrompt, parseAiFilter } from "./aiFilter";

const fields = [
  { id: 1, name: "标题", type: "text", position: 1 },
  { id: 2, name: "金额", type: "number", position: 2 },
  { id: 3, name: "状态", type: "select", options: ["进行中", "已完成"], position: 3 },
  { id: 4, name: "负责人", type: "person", position: 4 },
  { id: 5, name: "截止", type: "date", position: 5 },
] as Field[];

describe("AI filter input", () => {
  it("accepts schema-valid rules and normalizes values", () => {
    const out = parseAiFilter('好的：{"conj":"or","rules":[{"f":2,"op":"gt","v":"100"},{"f":3,"op":"is","v":"进行中"},{"f":4,"op":"contains","v":7},{"f":5,"op":"lt","v":"2026-12-01"},{"f":1,"op":"empty"}]}', fields);
    expect(out).toEqual({ conj: "or", dropped: 0, rules: [{ f: 2, op: "gt", v: 100 }, { f: 3, op: "is", v: "进行中" }, { f: 4, op: "contains", v: [7] }, { f: 5, op: "lt", v: "2026-12-01" }, { f: 1, op: "empty" }] });
  });
  it("drops unknown fields, operators and option values", () => {
    const out = parseAiFilter('{"rules":[{"f":99,"op":"is","v":"x"},{"f":2,"op":"contains","v":1},{"f":3,"op":"is","v":"不存在"},{"f":5,"op":"is","v":"明天"}]}', fields);
    expect(out).toEqual({ conj: "and", rules: [], dropped: 4 });
    expect(parseAiFilter("无法理解", fields)).toBeNull();
  });
  it("describes fields, options and today's date to the model", () => {
    const m = aiFilterPrompt("金额大于100的", fields, [{ id: 7, name: "沈墨", email: "", createdAt: "" }], "2026-11-11");
    expect(m[0].content).toContain("2026-11-11");
    expect(m[0].content).toContain("进行中");
    expect(m[0].content).toContain("沈墨");
  });
});
