import { describe, expect, it } from "vitest";
import {
  displayValue,
  evalFormulas,
  formatAutonumber,
  formatCurrency,
  interpolateButtonTemplate,
  isSafeHttpUrl,
  locationMapUrl,
  parseLocation,
  recordTitle,
  recordTitleField,
  REGISTRY,
} from "./registry";
import type { BaseRecord, Field } from "@/lib/api";

const field = (type: Field["type"], options?: string[]): Field => ({ id: 1, name: "f", type, options, position: 1 });
const rec = (cells: BaseRecord["cells"]): BaseRecord => ({ id: 2, baseId: 1, position: 1, cells, creatorId: 7, createdAt: "2026-01-02T03:04:05Z", updatedAt: "2026-01-03T03:04:05Z" });

describe("field type registry", () => {
  it("uses the durable primary field even when it is not the first text field", () => {
    const text: Field = { id: 1, name: "说明", type: "text", position: 1 };
    const primary: Field = { id: 2, name: "编号", type: "number", position: 2, isPrimary: true };
    expect(recordTitleField([text, primary])).toEqual(primary);
    expect(recordTitleField([text])).toEqual(text);
    expect(recordTitleField([{ ...text, isPrimary: false }])).toBeUndefined();
    expect(recordTitleField([])).toBeUndefined();
  });
  it("formats primary scalar, person and formula titles without losing zero or false", () => {
    const number: Field = { id: 1, name: "数值", type: "number", position: 1, isPrimary: true };
    expect(recordTitle(rec({ 1: 0 }), [number], [])).toBe("0");
    expect(recordTitle(rec({ 1: false }), [{ ...number, type: "checkbox" }], [])).toBe("false");
    const person: Field = { ...number, type: "person" };
    expect(recordTitle(rec({ 1: 7 }), [person], [{ id: 7, name: "小简", email: "", createdAt: "" }])).toBe("小简");
    const formula: Field = { id: 3, name: "合计", type: "formula", formula: "[数值]+1", position: 2, isPrimary: true };
    expect(recordTitle(rec({ 1: 2 }), [{ ...number, isPrimary: false }, formula], [])).toBe("3");
    expect(recordTitle(rec({ 1: 2 }), [formula], [])).toBe("");
    expect(recordTitle(rec({ 1: 2 }), [{ ...number, isPrimary: false }, { ...formula, formula: "[" }], [])).toBe("#错误");
  });
  it("multi_select parses CSV of known options and formats back", () => {
    const f = field("multi_select", ["红", "绿", "蓝"]);
    expect(REGISTRY.multi_select.parse("红, 绿", f)).toEqual(["红", "绿"]);
    expect(REGISTRY.multi_select.parse("紫", f)).toBeUndefined();
    expect(REGISTRY.multi_select.parse("", f)).toBeNull();
    expect(REGISTRY.multi_select.format(["红", "蓝"], f)).toBe("红,蓝");
    expect(REGISTRY.multi_select.compare(["红"], ["蓝"], f)).toBeLessThan(0);
  });
  it("person and attachment have no textual round-trip", () => {
    expect(REGISTRY.person.parse("Kay", field("person"))).toBeUndefined();
    expect(REGISTRY.attachment.parse("x", field("attachment"))).toBeUndefined();
    expect(REGISTRY.attachment.format([{ id: 1, name: "a", mime: "", size: 1 }], field("attachment"))).toBe("1");
  });
  it("computed types read from record metadata and are readonly", () => {
    const r = rec({});
    expect(REGISTRY.created_by.readonly && REGISTRY.created_at.readonly && REGISTRY.modified_at.readonly).toBe(true);
    expect(displayValue(r, field("created_by"), [])).toBe(7);
    expect(displayValue(r, field("created_at"), [])).toBe("2026-01-02T03:04:05Z");
    expect(displayValue(r, field("modified_at"), [])).toBe("2026-01-03T03:04:05Z");
    expect(displayValue(r, field("text"), [])).toBeUndefined();
  });
  it("checkbox compares false before true", () => {
    expect(REGISTRY.checkbox.compare(false, true, field("checkbox"))).toBeLessThan(0);
  });

  it("supports currency, progress, autonumber, button, and location field types in registry and formulas", () => {
    const curF: Field = { id: 10, name: "金额", type: "currency", options: ["USD", "2"], position: 1 };
    const progF: Field = { id: 11, name: "进度", type: "progress", options: ["bar"], position: 2 };
    const autoF: Field = { id: 12, name: "编号", type: "autonumber", options: ["TASK-", "4"], position: 3 };
    const btnF: Field = { id: 13, name: "操作", type: "button", options: ["查看详情", "open_url", "https://example.com/{编号}"], position: 4 };
    const locF: Field = { id: 14, name: "地点", type: "location", position: 5 };
    const formulaF: Field = { id: 15, name: "实收", type: "formula", formula: "ROUND([金额] * [进度] / 100, 2)", position: 6 };

    // Currency
    expect(formatCurrency(1234.5, curF)).toBe("$1,234.50");
    expect(formatCurrency(-99, { options: ["CNY", "0"] })).toBe("-¥99");
    expect(REGISTRY.currency.parse("$1,234.50", curF)).toBe(1234.5);
    expect(REGISTRY.currency.parse("bad", curF)).toBeUndefined();
    expect(REGISTRY.currency.parse("", curF)).toBeNull();

    // Progress
    expect(REGISTRY.progress.parse("75%", progF)).toBe(75);
    expect(REGISTRY.progress.parse("120", progF)).toBeUndefined();
    expect(REGISTRY.progress.parse("-1", progF)).toBeUndefined();
    expect(REGISTRY.progress.format(75, progF)).toBe("75%");

    // Autonumber (including graceful fallback to record.id when pre-existing record lacks cell)
    expect(REGISTRY.autonumber.readonly).toBe(true);
    expect(formatAutonumber(7, autoF)).toBe("TASK-0007");
    expect(displayValue(rec({}), autoF, [])).toBe(2);
    expect(displayValue(rec({ 12: 15 }), autoF, [])).toBe(15);

    // Button interpolation & URL safety
    expect(REGISTRY.button.readonly).toBe(true);
    const row = rec({ 10: 200, 11: 50, 12: 7, 14: "北京市海淀区 | 39.98,116.31" });
    expect(interpolateButtonTemplate("https://example.com/item/{编号}?id={id}", row, [curF, progF, autoF, btnF, locF], [])).toBe(
      "https://example.com/item/TASK-0007?id=2",
    );
    expect(isSafeHttpUrl("https://example.com")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("")).toBe(false);

    // Location parsing & map URL
    const parsedLoc = parseLocation("北京市海淀区 | 39.98,116.31");
    expect(parsedLoc).toEqual({ address: "北京市海淀区", coords: "39.98,116.31", lat: 39.98, lng: 116.31 });
    expect(locationMapUrl(parsedLoc)).toContain("mlat=39.98");
    expect(locationMapUrl(parseLocation("上海市"))).toContain("search?query=");

    // Formula evaluates currency + progress as numbers
    const evaluated = evalFormulas([curF, progF, autoF, formulaF], row, []);
    expect(evaluated.get(15)).toBe(100);
  });
});
