import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Field } from "@/lib/api";
import {
  formBranchingStorageKey,
  loadBranchRulesForFields,
  loadFormBranchRules,
  matchesFormBranchRule,
  saveFormBranchRules,
  visibleFormFields,
  wouldCreateBranchCycle,
  type FormBranchRule,
} from "./form-branching";
import { FormSetup } from "./form-setup";
import { formCells, validPublicFormDefinition } from "@/pages/public-form";

const sampleFields: Field[] = [
  { id: 1, name: "客户类型", type: "select", options: ["个人", "企业"], position: 1 },
  { id: 2, name: "企业名称", type: "text", position: 2 },
  { id: 3, name: "税号", type: "text", position: 3 },
  { id: 4, name: "需要发票", type: "checkbox", position: 4 },
  { id: 5, name: "发票抬头", type: "text", position: 5 },
];

describe("form conditional branching logic", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("evaluates eq, neq, not_empty, and checked operators accurately", () => {
    expect(matchesFormBranchRule({ id: "1", sourceFieldId: 1, targetFieldId: 2, operator: "eq", value: "企业" }, "企业")).toBe(true);
    expect(matchesFormBranchRule({ id: "1", sourceFieldId: 1, targetFieldId: 2, operator: "eq", value: "企业" }, "个人")).toBe(false);
    expect(matchesFormBranchRule({ id: "1", sourceFieldId: 1, targetFieldId: 2, operator: "eq", value: "企业" }, ["个人", "企业"])).toBe(true);

    expect(matchesFormBranchRule({ id: "2", sourceFieldId: 1, targetFieldId: 2, operator: "neq", value: "个人" }, "企业")).toBe(true);
    expect(matchesFormBranchRule({ id: "2", sourceFieldId: 1, targetFieldId: 2, operator: "neq", value: "个人" }, "个人")).toBe(false);

    expect(matchesFormBranchRule({ id: "3", sourceFieldId: 2, targetFieldId: 3, operator: "not_empty" }, "Acme")).toBe(true);
    expect(matchesFormBranchRule({ id: "3", sourceFieldId: 2, targetFieldId: 3, operator: "not_empty" }, "   ")).toBe(false);
    expect(matchesFormBranchRule({ id: "3", sourceFieldId: 2, targetFieldId: 3, operator: "not_empty" }, [])).toBe(false);

    expect(matchesFormBranchRule({ id: "4", sourceFieldId: 4, targetFieldId: 5, operator: "checked" }, true)).toBe(true);
    expect(matchesFormBranchRule({ id: "4", sourceFieldId: 4, targetFieldId: 5, operator: "checked" }, false)).toBe(false);
  });

  it("supports chained visibility rules and hides downstream fields even with stale values", () => {
    const rules: FormBranchRule[] = [
      { id: "r1", sourceFieldId: 1, targetFieldId: 2, operator: "eq", value: "企业" },
      { id: "r2", sourceFieldId: 2, targetFieldId: 3, operator: "not_empty" },
      { id: "r3", sourceFieldId: 4, targetFieldId: 5, operator: "checked" },
    ];

    // Initially only unconditional fields 1 and 4 are visible.
    expect(visibleFormFields(sampleFields, rules, {}).map((f) => f.id)).toEqual([1, 4]);

    // Selecting "企业" reveals field 2, but field 3 stays hidden until field 2 is filled.
    expect(visibleFormFields(sampleFields, rules, { 1: "企业" }).map((f) => f.id)).toEqual([1, 2, 4]);

    // Filling field 2 reveals chained field 3; checking field 4 reveals field 5.
    expect(visibleFormFields(sampleFields, rules, { 1: "企业", 2: "简格科技", 4: true }).map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);

    // Switching field 1 back to "个人" hides BOTH field 2 and chained field 3 even though value[2] is stale!
    expect(visibleFormFields(sampleFields, rules, { 1: "个人", 2: "简格科技", 3: "91310000" }).map((f) => f.id)).toEqual([1, 4]);
  });

  it("prevents infinite loops on cyclic rules and ignores orphaned source rules", () => {
    const cyclic: FormBranchRule[] = [
      { id: "c1", sourceFieldId: 1, targetFieldId: 2, operator: "not_empty" },
      { id: "c2", sourceFieldId: 2, targetFieldId: 1, operator: "not_empty" },
    ];
    expect(wouldCreateBranchCycle([cyclic[0]], 2, 1)).toBe(true);
    expect(wouldCreateBranchCycle([cyclic[0]], 2, 3)).toBe(false);
    expect(visibleFormFields(sampleFields.slice(0, 3), cyclic, { 1: "a", 2: "b" }).map((f) => f.id)).toEqual([3]);

    // Orphaned source field (id 999 not in form) does not trap target field 2.
    const orphan: FormBranchRule[] = [
      { id: "o1", sourceFieldId: 999, targetFieldId: 2, operator: "eq", value: "x" },
    ];
    expect(visibleFormFields(sampleFields.slice(0, 2), orphan, {}).map((f) => f.id)).toEqual([1, 2]);
  });

  it("persists per (baseId, viewId) rules in localStorage and resolves matching public form rules", () => {
    const rules: FormBranchRule[] = [
      { id: "r1", sourceFieldId: 1, targetFieldId: 2, operator: "eq", value: "企业" },
    ];
    saveFormBranchRules(7, 15, rules);
    expect(localStorage.getItem(formBranchingStorageKey(7, 15))).toBeTruthy();
    expect(loadFormBranchRules(7, 15)).toEqual(rules);
    expect(loadBranchRulesForFields([1, 2, 3])).toEqual(rules);
    expect(loadBranchRulesForFields([10, 11])).toEqual([]);

    saveFormBranchRules(7, 15, []);
    expect(localStorage.getItem(formBranchingStorageKey(7, 15))).toBeNull();
  });

  it("skips hidden required fields and omits stale hidden values in PublicForm formCells", () => {
    const formFields = [
      { id: 1, name: "客户类型", type: "select", options: ["个人", "企业"], required: true },
      { id: 2, name: "企业名称", type: "text", required: true },
    ];
    const rules: FormBranchRule[] = [
      { id: "r1", sourceFieldId: 1, targetFieldId: 2, operator: "eq", value: "企业" },
    ];

    // Hidden required field 2 does NOT block submission when field 1 = "个人".
    expect(formCells(formFields, { 1: "个人" }, rules)).toEqual({ "1": "个人" });
    // Even if field 2 holds a stale value while hidden, it is not submitted.
    expect(formCells(formFields, { 1: "个人", 2: "旧公司" }, rules)).toEqual({ "1": "个人" });
    // When field 1 = "企业", field 2 becomes visible and required again.
    expect(() => formCells(formFields, { 1: "企业" }, rules)).toThrow("企业名称");
    expect(formCells(formFields, { 1: "企业", 2: "简格" }, rules)).toEqual({ "1": "企业", "2": "简格" });

    // validPublicFormDefinition accepts optional valid branchRules and rejects invalid ones.
    expect(validPublicFormDefinition({ title: "收集表", desc: "", fields: formFields, branchRules: rules })).toBe(true);
    expect(validPublicFormDefinition({ title: "收集表", desc: "", fields: formFields, branchRules: [{ bad: true }] })).toBe(false);
  });

  it("renders FormSetup branching section with FeishuSelect and live preview without native select", () => {
    const rules: FormBranchRule[] = [
      { id: "r1", sourceFieldId: 1, targetFieldId: 2, operator: "eq", value: "企业" },
    ];
    const html = renderToStaticMarkup(
      createElement(FormSetup, {
        baseId: 1,
        viewId: 2,
        config: { fields: [1, 2], required: [2] },
        fields: sampleFields.slice(0, 2),
        canEdit: true,
        saving: false,
        dirty: false,
        error: null,
        onChange: () => {},
        onSave: () => {},
        onReset: () => {},
        initialBranchRules: rules,
        defaultPreviewOpen: true,
      }),
    );
    expect(html).toContain("data-form-branching");
    expect(html).toContain("显示逻辑");
    expect(html).toContain('data-branch-rule="r1"');
    expect(html).toContain("data-form-branching-preview-box");
    expect(html).toContain("当前显示 1 / 2 个字段");
    expect(html).not.toContain("<select");
  });
});
