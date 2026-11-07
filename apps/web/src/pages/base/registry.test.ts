import { describe, expect, it } from "vitest";
import { displayValue, recordTitle, recordTitleField, REGISTRY } from "./registry";
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
});
