import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Field } from "@/lib/api";
import { FormSetup, setFormField, setFormRequired, validFormSelection } from "./FormSetup";

const fields: Field[] = [{ id: 1, name: "姓名", type: "text", position: 1 }, { id: 2, name: "邮箱", type: "email", position: 2 }, { id: 3, name: "附件", type: "attachment", position: 3 }];
describe("form field configuration", () => {
  it("requires an explicit, unique, supported field selection and valid required subset", () => {
    expect(validFormSelection({}, fields)).toBe(false);
    expect(validFormSelection({ fields: [] }, fields)).toBe(false);
    expect(validFormSelection({ fields: [1, 2], required: [2] }, fields)).toBe(true);
    expect(validFormSelection({ fields: [1, 1] }, fields)).toBe(false);
    expect(validFormSelection({ fields: [3] }, fields)).toBe(false);
    expect(validFormSelection({ fields: [1], required: [2] }, fields)).toBe(false);
    expect(validFormSelection({ fields: [99] }, fields)).toBe(false);
  });
  it("clears required when a field is removed, and never marks an unselected field required", () => {
    const selected = setFormField({}, 1, true);
    expect(setFormRequired(selected, 2, true)).toEqual(selected);
    const required = setFormRequired(selected, 1, true);
    expect(required.required).toEqual([1]);
    expect(setFormField(required, 1, false)).toMatchObject({ fields: [], required: [] });
  });
  it("shows available/unsupported fields and prevents publishing an implicit default", () => {
    const html = renderToStaticMarkup(<FormSetup config={{}} fields={fields} canEdit saving={false} dirty={false} error={null} onChange={() => {}} onSave={() => {}} onReset={() => {}} />);
    expect(html).toContain("尚未显式选择字段");
    expect(html).toContain("姓名");
    expect(html).toContain("邮箱");
    expect(html).toContain("公开表单暂不支持");
    expect(html).toContain("保存表单配置");
  });
  it("requires explicit confirmation before saving a change that could affect a published form", () => {
    const html = renderToStaticMarkup(<FormSetup config={{ fields: [1], required: [1] }} fields={fields} canEdit saving={false} dirty error={null} onChange={() => {}} onSave={() => {}} onReset={() => {}} />);
    expect(html).toContain("已发布链接会立即使用所选字段和说明");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存表单配置<\/button>/);
    expect(html).toContain("必填");
    const readonly = renderToStaticMarkup(<FormSetup config={{ fields: [1] }} fields={fields} canEdit={false} saving={false} dirty={false} error={null} onChange={() => {}} onSave={() => {}} onReset={() => {}} />);
    expect(readonly).not.toContain("保存表单配置");
  });
});
