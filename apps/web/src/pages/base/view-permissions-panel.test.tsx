import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BaseRecord, Field } from "@/lib/api";
import {
  applyViewPermissions,
  countActiveViewPermissions,
  fieldPermissionOf,
  mergeViewPermissions,
  viewPermissionsFromConfig,
  viewPermissionsToConfig,
  ViewPermissionsPanel,
  type ViewPermissionsConfig,
} from "./view-permissions-panel";

const fields: Field[] = [
  { id: 1, name: "标题", type: "text", position: 1, isPrimary: true },
  { id: 2, name: "金额", type: "number", position: 2 },
  { id: 3, name: "内部备注", type: "text", position: 3 },
];

const records: BaseRecord[] = [
  { id: 10, baseId: 1, position: 1, creatorId: 7, cells: { 1: "A", 2: 100, 3: "secret-a" } },
  { id: 11, baseId: 1, position: 2, creatorId: 9, cells: { 1: "B", 2: 200, 3: "secret-b" } },
  { id: 12, baseId: 1, position: 3, creatorId: 7, cells: { 1: "C", 2: 300, 3: "secret-c" } },
];

describe("view permissions panel & projection", () => {
  it("round-trips between ViewPermissionsConfig and cloud-persisted ViewConfig.permissions", () => {
    const cfg: ViewPermissionsConfig = {
      fields: { 1: "edit", 2: "readonly", 3: "hidden" },
      onlyOwnRows: true,
    };
    const serialized = viewPermissionsToConfig(cfg);
    expect(serialized).toEqual({
      onlyOwnRecords: true,
      fieldModes: { "2": "readonly", "3": "hidden" },
    });

    // "edit" is default and omitted from cloud payload; round-trip restores exact non-default entries.
    expect(viewPermissionsFromConfig(serialized)).toEqual({
      fields: { 2: "readonly", 3: "hidden" },
      onlyOwnRows: true,
    });
    expect(viewPermissionsFromConfig(undefined)).toEqual({ fields: {}, onlyOwnRows: false });
    expect(viewPermissionsToConfig({ fields: {}, onlyOwnRows: false })).toBeUndefined();
  });

  it("merges shared view permissions strictly (hidden > readonly > edit)", () => {
    const merged = mergeViewPermissions([
      { fields: { 2: "readonly", 3: "readonly" }, onlyOwnRows: false },
      { fields: { 3: "hidden" }, onlyOwnRows: true },
    ]);
    expect(merged).toEqual({
      fields: { 2: "readonly", 3: "hidden" },
      onlyOwnRows: true,
    });
  });

  it("applies hidden fields, readonly fields, and own-row filtering cleanly", () => {
    const perms: ViewPermissionsConfig = {
      fields: { 2: "readonly", 3: "hidden" },
      onlyOwnRows: true,
    };
    expect(fieldPermissionOf(perms, 1)).toBe("edit");
    expect(fieldPermissionOf(perms, 2)).toBe("readonly");
    expect(fieldPermissionOf(perms, 3)).toBe("hidden");
    expect(countActiveViewPermissions(perms, fields)).toBe(3);

    const projected = applyViewPermissions(fields, records, perms, 7);
    expect(projected.visibleFields.map((f) => f.id)).toEqual([1, 2]);
    expect([...projected.hiddenFieldIds]).toEqual([3]);
    expect([...projected.readonlyFieldIds]).toEqual([2]);
    expect(projected.records.map((r) => r.id)).toEqual([10, 12]);

    const allRows = applyViewPermissions(fields, records, { ...perms, onlyOwnRows: false }, 7);
    expect(allRows.records.map((r) => r.id)).toEqual([10, 11, 12]);
  });

  it("ignores stale deleted field ids when counting active permissions", () => {
    const perms: ViewPermissionsConfig = {
      fields: { 2: "readonly", 999: "hidden" },
      onlyOwnRows: false,
    };
    expect(countActiveViewPermissions(perms, fields)).toBe(1);
  });

  it("renders Feishu segmented pills with no native select and protects primary field from hiding", () => {
    const perms: ViewPermissionsConfig = {
      fields: { 2: "readonly", 3: "hidden" },
      onlyOwnRows: true,
    };
    const html = renderToStaticMarkup(
      <ViewPermissionsPanel fields={fields} value={perms} onChange={() => {}} defaultOpen />,
    );
    expect(html).toContain("data-view-perms-btn");
    expect(html).toContain("权限配置");
    expect(html).toContain("data-view-perms-count");
    expect(html).toContain("data-view-perms-panel");
    expect(html).toContain("字段与行权限");
    expect(html).toContain("仅查看自己创建的记录");
    expect(html).toContain("可编辑");
    expect(html).toContain("仅只读");
    expect(html).toContain("隐藏");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('data-view-perm-field="1"');
    expect(html).toContain('data-view-perm-field="2"');
    expect(html).toContain('data-view-perm-field="3"');
    expect(html).toContain('title="主字段不能隐藏"');
    expect(html).not.toContain("<select");
  });
});
