import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BaseRecord, Field } from "@/lib/api";
import {
  aggregateRollupValues,
  buildLookupOptions,
  getLookupRollup,
  lookupFieldConfig,
} from "./rollup";
import { displayValue, evalFormulas, REGISTRY } from "./registry";
import { CellView } from "./cells";
import { MemberRuleValue } from "./member-rule-value";

describe("lookup & rollup aggregation (rollup.ts)", () => {
  it("aggregates values across all rollup modes cleanly", () => {
    expect(aggregateRollupValues([10, 20, 30], "raw")).toEqual([10, 20, 30]);
    expect(aggregateRollupValues([10, 20, 30], "sum")).toBe(60);
    expect(aggregateRollupValues([10, 20, 30], "avg")).toBe(20);
    expect(aggregateRollupValues([10, 20, 30], "count")).toBe(3);
    expect(aggregateRollupValues([10, 20, 30], "min")).toBe(10);
    expect(aggregateRollupValues([10, 20, 30], "max")).toBe(30);
  });

  it("handles numeric strings, floating-point precision, and mixed empty/non-numeric entries", () => {
    expect(aggregateRollupValues([0.1, 0.2], "sum")).toBe(0.3);
    expect(aggregateRollupValues(["12.5", "7.5", "abc", "", null, undefined], "sum")).toBe(20);
    expect(aggregateRollupValues(["12.5", "7.5", "abc", "", null, undefined], "avg")).toBe(10);
    expect(aggregateRollupValues(["12.5", "7.5", "abc", "", null, undefined], "min")).toBe(7.5);
    expect(aggregateRollupValues(["12.5", "7.5", "abc", "", null, undefined], "max")).toBe(12.5);
    expect(aggregateRollupValues(["a", "", "  ", null, undefined, [], ["x"], 0], "count")).toBe(3);
    expect(aggregateRollupValues([], "count")).toBe(0);
    expect(aggregateRollupValues([], "sum")).toBeNull();
    expect(aggregateRollupValues(["非数字"], "avg")).toBeNull();
  });

  it("parses lookup field link/target/rollupAgg config from cloud-persisted field.options", () => {
    expect(lookupFieldConfig({ options: ["12", "34"] })).toEqual({ linkFieldId: 12, lookupFieldId: 34, rollupAgg: "raw" });
    expect(lookupFieldConfig({ options: ["12", "34", "sum"] })).toEqual({ linkFieldId: 12, lookupFieldId: 34, rollupAgg: "sum" });
    expect(lookupFieldConfig({ options: ["12", "34", "invalid"] })).toEqual({ linkFieldId: 12, lookupFieldId: 34, rollupAgg: "raw" });
    expect(lookupFieldConfig({ options: ["bad", "-1"] })).toEqual({ linkFieldId: 0, lookupFieldId: 0, rollupAgg: "raw" });
    expect(lookupFieldConfig(undefined)).toEqual({ linkFieldId: 0, lookupFieldId: 0, rollupAgg: "raw" });
  });

  it("builds and reads cloud-persisted options[2] rollup metadata without localStorage", () => {
    expect(buildLookupOptions(10, 20, "raw")).toEqual(["10", "20"]);
    expect(buildLookupOptions(10, 20, "sum")).toEqual(["10", "20", "sum"]);
    expect(buildLookupOptions(10, 20, "avg")).toEqual(["10", "20", "avg"]);

    const fieldRaw: Field = { id: 100, name: "原值", type: "lookup", options: buildLookupOptions(10, 20, "raw"), position: 0 };
    const fieldSum: Field = { id: 101, name: "总金额", type: "lookup", options: buildLookupOptions(10, 20, "sum"), position: 1 };
    const fieldAvg: Field = { id: 102, name: "平均金额", type: "lookup", options: buildLookupOptions(10, 20, "avg"), position: 2 };

    expect(getLookupRollup(fieldRaw)).toBe("raw");
    expect(getLookupRollup(fieldSum)).toBe("sum");
    expect(getLookupRollup(fieldAvg)).toBe("avg");
    expect(getLookupRollup({ options: ["10", "20", "bogus"] })).toBe("raw");
    expect(getLookupRollup(undefined)).toBe("raw");
  });

  it("applies cloud-persisted rollup aggregation inside registry.displayValue, CellView, compare, and formulas", () => {
    const lookupRaw: Field = { id: 50, name: "订单合计", type: "lookup", options: ["10", "20"], position: 1 };
    const lookupSum: Field = { id: 50, name: "订单合计", type: "lookup", options: ["10", "20", "sum"], position: 1 };
    const taxFormula: Field = { id: 51, name: "含税", type: "formula", formula: "[订单合计] * 1.1", position: 2 };
    const rec: BaseRecord = { id: 1, baseId: 9, position: 1, cells: { 50: [100, 200, 300] as unknown as string[] } };

    // Raw mode preserves original lookup array.
    expect(displayValue(rec, lookupRaw, [])).toEqual([100, 200, 300]);

    // Sum rollup transforms displayValue into a CellView-compatible single-element string array.
    const summed = displayValue(rec, lookupSum, []);
    expect(summed).toEqual(["600"]);
    expect(REGISTRY.lookup.format(summed, lookupSum)).toBe("600");

    // CellView renders the rolled-up value instead of blank.
    const html = renderToStaticMarkup(createElement(CellView, { field: lookupSum, record: rec, members: [], canEdit: false }));
    expect(html).toContain("600");

    // Formulas can consume rolled-up numeric lookup values.
    const evaluated = evalFormulas([lookupSum, taxFormula], rec, []);
    expect(evaluated.get(51)).toBeCloseTo(660, 5);

    // Numeric compare orders 100 after 20.
    expect(REGISTRY.lookup.compare(["100"], ["20"], lookupSum)).toBeGreaterThan(0);
  });

  it("renders MemberRuleValue single-select using FeishuSelect without native select", () => {
    const html = renderToStaticMarkup(
      createElement(MemberRuleValue, {
        rule: { f: 1, op: "is", v: 7 },
        members: [{ id: 7, name: "张三", email: "", createdAt: "" }],
        onChange: () => {},
      }),
    );
    expect(html).not.toContain("<select");
    expect(html).toContain('role="combobox"');
    expect(html).toContain("data-person-filter");
    expect(html).toContain("张三");
  });
});
