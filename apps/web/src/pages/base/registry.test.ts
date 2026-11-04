import { describe, expect, it } from "vitest";
import { displayValue, REGISTRY } from "./registry";
import type { BaseRecord, Field } from "@/lib/api";

const field = (type: Field["type"], options?: string[]): Field => ({ id: 1, name: "f", type, options, position: 1 });
const rec = (cells: BaseRecord["cells"]): BaseRecord => ({ id: 2, baseId: 1, position: 1, cells, creatorId: 7, createdAt: "2026-01-02T03:04:05Z", updatedAt: "2026-01-03T03:04:05Z" });

describe("field type registry", () => {
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
