import { useMemo, useState } from "react";
import { Eye, GitBranch, Plus, RotateCcw, Trash2 } from "lucide-react";
import { t, useI18n } from "@/lib/i18n";
import type { Field, ViewConfig } from "@/lib/api";
import { FeishuSelect } from "@/components/feishu-select";
import { PublicFormField, supportsPublicFormField, type FormFieldDef, type FormValue } from "@/pages/public-form";
import {
  isValidFormBranchRule,
  visibleFormFields,
  wouldCreateBranchCycle,
  type FormBranchOperator,
  type FormBranchRule,
} from "./form-branching";

/** Return a stable, explicit public field list; unsupported fields cannot be shared. */
export function validFormSelection(config: ViewConfig, fields: Field[]): boolean {
  if (!Array.isArray(config.fields) || config.fields.length === 0) return false;
  if (config.required !== undefined && !Array.isArray(config.required)) return false;
  const allowed = new Set(fields.filter((f) => supportsPublicFormField(f.type)).map((f) => f.id));
  const picked = new Set(config.fields);
  const required = config.required ?? [];
  if (
    picked.size !== config.fields.length ||
    !config.fields.every((id) => allowed.has(id)) ||
    new Set(required).size !== required.length ||
    !required.every((id) => picked.has(id))
  ) {
    return false;
  }
  if (config.branchRules !== undefined) {
    if (!Array.isArray(config.branchRules) || config.branchRules.length > 200) return false;
    const seen = new Set<string>();
    for (let i = 0; i < config.branchRules.length; i++) {
      const rule = config.branchRules[i];
      if (!isValidFormBranchRule(rule) || seen.has(rule.id)) return false;
      if (!picked.has(rule.sourceFieldId) || !picked.has(rule.targetFieldId)) return false;
      if (wouldCreateBranchCycle(config.branchRules.slice(0, i), rule.sourceFieldId, rule.targetFieldId)) return false;
      seen.add(rule.id);
    }
  }
  return true;
}
export function setFormField(config: ViewConfig, fieldId: number, selected: boolean): ViewConfig {
  const current = Array.isArray(config.fields) ? config.fields : [];
  const required = Array.isArray(config.required) ? config.required : [];
  const nextFields = selected ? [...current.filter((id) => id !== fieldId), fieldId] : current.filter((id) => id !== fieldId);
  const nextSet = new Set(nextFields);
  const nextConfig: ViewConfig = {
    ...config,
    fields: nextFields,
    required: required.filter((id) => id !== fieldId),
  };
  if (Array.isArray(config.branchRules)) {
    const kept = config.branchRules.filter((r) => nextSet.has(r.sourceFieldId) && nextSet.has(r.targetFieldId));
    if (kept.length > 0) nextConfig.branchRules = kept;
    else delete nextConfig.branchRules;
  }
  return nextConfig;
}
export function setFormRequired(config: ViewConfig, fieldId: number, required: boolean): ViewConfig {
  if (!Array.isArray(config.fields) || !config.fields.includes(fieldId)) return config;
  const existing = Array.isArray(config.required) ? config.required : [];
  return { ...config, required: required ? [...existing.filter((id) => id !== fieldId), fieldId] : existing.filter((id) => id !== fieldId) };
}

/** Editable selection is explicit: the manager sees exactly what will be shared. */
export function FormSetup({
  config,
  fields,
  canEdit,
  saving,
  dirty,
  error,
  onChange,
  onSave,
  onReset,
  initialBranchRules,
  defaultPreviewOpen = false,
}: {
  baseId?: number;
  viewId?: number;
  config: ViewConfig;
  fields: Field[];
  canEdit: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  onChange: (value: ViewConfig) => void;
  onSave: () => void;
  onReset: () => void;
  initialBranchRules?: FormBranchRule[];
  defaultPreviewOpen?: boolean;
}) {
  useI18n();
  const selected = new Set(Array.isArray(config.fields) ? config.fields : []);
  const required = new Set(Array.isArray(config.required) ? config.required : []);
  const missing = (Array.isArray(config.fields) ? config.fields : []).filter((id) => !fields.some((f) => f.id === id));
  const signature = JSON.stringify({ config, fields });
  const [confirmedSignature, setConfirmedSignature] = useState<string | null>(null);
  const confirmed = confirmedSignature === signature;

  const branchRules = useMemo<FormBranchRule[]>(() => {
    if (Array.isArray(config.branchRules)) return config.branchRules;
    return initialBranchRules ?? [];
  }, [config.branchRules, initialBranchRules]);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(defaultPreviewOpen);
  const [previewValues, setPreviewValues] = useState<Record<number, FormValue>>({});

  const updateBranchRules = (next: FormBranchRule[]) => {
    setBranchError(null);
    const nextConfig: ViewConfig = { ...config };
    if (next.length > 0) nextConfig.branchRules = next;
    else delete nextConfig.branchRules;
    onChange(nextConfig);
  };

  const selectedFields = useMemo(
    () =>
      (Array.isArray(config.fields) ? config.fields : [])
        .map((fid) => fields.find((f) => f.id === fid))
        .filter((f): f is Field => !!f && supportsPublicFormField(f.type)),
    [config.fields, fields],
  );

  const previewFieldDefs = useMemo<FormFieldDef[]>(
    () =>
      selectedFields.map((f) => ({
        id: f.id,
        name: f.name || t("未命名字段"),
        type: f.type,
        description: f.description,
        options: f.options,
        required: required.has(f.id),
      })),
    [selectedFields, config.required],
  );

  const previewVisibleFields = useMemo(
    () => visibleFormFields(previewFieldDefs, branchRules, previewValues),
    [previewFieldDefs, branchRules, previewValues],
  );

  const operatorOptions: { value: FormBranchOperator; label: string }[] = [
    { value: "eq", label: t("等于") },
    { value: "neq", label: t("不等于") },
    { value: "not_empty", label: t("非空") },
    { value: "checked", label: t("已勾选") },
  ];

  const addBranchRule = () => {
    if (selectedFields.length < 2) return;
    const source = selectedFields[0];
    const target = selectedFields.find((f) => f.id !== source.id && !wouldCreateBranchCycle(branchRules, source.id, f.id));
    if (!target) {
      setBranchError(t("无法添加：当前字段组合会形成循环显示条件"));
      return;
    }
    const defaultOp: FormBranchOperator = source.type === "checkbox" ? "checked" : source.type === "select" ? "eq" : "not_empty";
    const defaultVal = defaultOp === "eq" ? (source.options?.[0] ?? "") : undefined;
    const nextRule: FormBranchRule = {
      id: `br-${Date.now().toString(36)}-${branchRules.length + 1}`,
      sourceFieldId: source.id,
      targetFieldId: target.id,
      operator: defaultOp,
      value: defaultVal,
    };
    updateBranchRules([...branchRules, nextRule]);
  };

  const patchBranchRule = (ruleId: string, patch: Partial<FormBranchRule>) => {
    const others = branchRules.filter((r) => r.id !== ruleId);
    const currentRule = branchRules.find((r) => r.id === ruleId);
    if (!currentRule) return;
    const candidate = { ...currentRule, ...patch };
    if (wouldCreateBranchCycle(others, candidate.sourceFieldId, candidate.targetFieldId)) {
      setBranchError(t("不能形成循环显示条件"));
      return;
    }
    updateBranchRules(branchRules.map((r) => (r.id === ruleId ? candidate : r)));
  };

  return <section className="min-h-0 flex-1 overflow-y-auto bg-[#f7f8fa] p-4 sm:p-8" aria-label={t("收集表配置")}>
    <div className="mx-auto max-w-2xl rounded-xl border bg-surface p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-center gap-2"><h2 className="text-[18px] font-semibold">{t("设置收集表")}</h2>{dirty && <span className="text-xs text-subtle">{t("有未保存的更改")}</span>}</div>
      <p className="mt-2 text-[13px] leading-6 text-muted-foreground">{t("选择公开填写的字段并检查内容。保存后，已发布的链接会使用新配置。")}</p>
      <label className="mt-5 block text-[13px] font-medium">{t("表单标题")}<input disabled={!canEdit || saving} maxLength={200} value={config.title ?? ""} onChange={(event) => onChange({ ...config, title: event.currentTarget.value })} placeholder={t("请输入表单标题")} className="mt-1 block h-9 w-full rounded-md border bg-surface px-2.5 text-[16px] outline-none focus:border-primary sm:text-[13px] disabled:opacity-60" /></label>
      <label className="mt-4 block text-[13px] font-medium">{t("表单说明")}<textarea disabled={!canEdit || saving} maxLength={2000} value={config.desc ?? ""} onChange={(event) => onChange({ ...config, desc: event.currentTarget.value })} placeholder={t("添加填写说明（可选）")} className="mt-1 block min-h-20 w-full rounded-md border bg-surface p-2.5 text-[16px] outline-none focus:border-primary sm:text-[13px] disabled:opacity-60" /></label>
      <div className="mt-6 flex items-center justify-between"><h3 className="text-[14px] font-semibold">{t("公开字段")}</h3><span className="text-[12px] text-subtle">{t("已选择 {n} 项", { n: selected.size })}</span></div>
      {!Array.isArray(config.fields) && <p role="status" className="mt-2 text-[12px] text-muted-foreground">{t("尚未显式选择字段。请选择并保存后再发布；旧表单的默认字段可能不同。")}</p>}
      <div className="mt-2 divide-y rounded-md border">{fields.map((field) => {
        const supported = supportsPublicFormField(field.type), checked = selected.has(field.id);
        return <div key={field.id} className="flex items-center gap-3 px-3 py-2.5 text-[13px]">
          <label className="flex min-w-0 flex-1 items-center gap-2"><input type="checkbox" checked={checked} disabled={!canEdit || saving || (!supported && !checked)} onChange={(event) => onChange(setFormField(config, field.id, event.currentTarget.checked))} /><span className="min-w-0 truncate">{field.name || t("未命名字段")}</span></label>
          {!supported && <span className="shrink-0 text-[12px] text-subtle">{t("公开表单暂不支持")}</span>}
          {supported && <label className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground"><input type="checkbox" checked={required.has(field.id)} disabled={!canEdit || saving || !checked} onChange={(event) => onChange(setFormRequired(config, field.id, event.currentTarget.checked))} />{t("必填")}</label>}
        </div>;
      })}</div>
      {missing.length > 0 && <p role="alert" className="mt-2 text-[12px] text-destructive">{t("有已删除的字段仍在配置中。")} {canEdit && <button type="button" disabled={saving} className="underline" onClick={() => { const remaining = (Array.isArray(config.fields) ? config.fields : []).filter((id) => !missing.includes(id)); const nextCfg: ViewConfig = { ...config, fields: remaining, required: (Array.isArray(config.required) ? config.required : []).filter((id) => remaining.includes(id)) }; if (Array.isArray(config.branchRules)) { const kept = config.branchRules.filter((r) => remaining.includes(r.sourceFieldId) && remaining.includes(r.targetFieldId)); if (kept.length > 0) nextCfg.branchRules = kept; else delete nextCfg.branchRules; } onChange(nextCfg); }}>{t("移除失效字段")}</button>}</p>}

      <div className="mt-6 rounded-lg border border-[#e5e6eb] bg-[#f7f8fa]/50 p-3.5 dark:bg-sidebar/30" data-form-branching>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <GitBranch size={15} className="text-primary" aria-hidden />
            <h3 className="text-[14px] font-semibold">{t("显示逻辑")}</h3>
            {branchRules.length > 0 && (
              <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-primary">
                {t("{n} 条规则", { n: branchRules.length })}
              </span>
            )}
          </div>
          {selectedFields.length > 0 && (
            <button
              type="button"
              onClick={() => setPreviewOpen((v) => !v)}
              data-form-branching-preview
              className="inline-flex h-7 items-center gap-1 rounded-md border bg-surface px-2.5 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              <Eye size={13} aria-hidden />
              <span>{previewOpen ? t("收起预览") : t("预览条件效果")}</span>
            </button>
          )}
        </div>
        <p className="mt-1 text-[12px] text-muted-foreground">{t("按条件动态显示或隐藏表单字段，隐藏字段不会被设为必填。")}</p>

        {selectedFields.length < 2 ? (
          <p className="mt-2.5 text-[12px] text-subtle">{t("请至少选择 2 个公开字段后再配置显示逻辑。")}</p>
        ) : (
          <div className="mt-3 space-y-2">
            {branchRules.map((rule) => {
              const sourceField = selectedFields.find((f) => f.id === rule.sourceFieldId);
              const needsValue = rule.operator === "eq" || rule.operator === "neq";
              const sourceOptions = sourceField && (sourceField.type === "select" || sourceField.type === "multi_select") ? (sourceField.options ?? []) : [];
              return (
                <div
                  key={rule.id}
                  data-branch-rule={rule.id}
                  className="flex flex-wrap items-center gap-1.5 rounded-md border border-[#e5e6eb] bg-surface p-2 text-[12px]"
                >
                  <span className="text-muted-foreground">{t("当")}</span>
                  <FeishuSelect
                    ariaLabel={t("条件源字段")}
                    disabled={!canEdit || saving}
                    value={String(rule.sourceFieldId)}
                    options={selectedFields
                      .filter((f) => f.id !== rule.targetFieldId)
                      .map((f) => ({ value: String(f.id), label: f.name || t("未命名字段") }))}
                    onChange={(val) => patchBranchRule(rule.id, { sourceFieldId: Number(val), value: "" })}
                    className="h-7 min-w-[96px] border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                    chevronSize={11}
                    menuMinWidth={116}
                    dataAttr={{ "data-branch-source": rule.id }}
                  />
                  <FeishuSelect
                    ariaLabel={t("显示条件")}
                    disabled={!canEdit || saving}
                    value={rule.operator}
                    options={operatorOptions}
                    onChange={(val) => {
                      const op = val as FormBranchOperator;
                      patchBranchRule(rule.id, {
                        operator: op,
                        value: op === "eq" || op === "neq" ? (rule.value ?? "") : undefined,
                      });
                    }}
                    className="h-7 min-w-[80px] border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                    chevronSize={11}
                    menuMinWidth={92}
                    dataAttr={{ "data-branch-op": rule.id }}
                  />
                  {needsValue && (
                    sourceOptions.length > 0 ? (
                      <FeishuSelect
                        ariaLabel={t("条件值")}
                        disabled={!canEdit || saving}
                        value={rule.value ?? ""}
                        options={[
                          { value: "", label: t("选择选项") },
                          ...sourceOptions.map((opt) => ({ value: opt, label: opt })),
                        ]}
                        onChange={(val) => patchBranchRule(rule.id, { value: val })}
                        className="h-7 min-w-[96px] border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                        chevronSize={11}
                        menuMinWidth={110}
                        dataAttr={{ "data-branch-value": rule.id }}
                      />
                    ) : (
                      <input
                        disabled={!canEdit || saving}
                        value={rule.value ?? ""}
                        onChange={(e) => patchBranchRule(rule.id, { value: e.target.value })}
                        placeholder={t("输入条件值")}
                        className="h-7 w-24 rounded-md border border-[#dee0e3] bg-surface px-2 text-[12px] outline-none focus:border-primary disabled:opacity-60"
                        data-branch-value={rule.id}
                      />
                    )
                  )}
                  <span className="text-muted-foreground">{t("时，显示")}</span>
                  <FeishuSelect
                    ariaLabel={t("显示目标字段")}
                    disabled={!canEdit || saving}
                    value={String(rule.targetFieldId)}
                    options={selectedFields
                      .filter((f) => f.id !== rule.sourceFieldId)
                      .map((f) => ({ value: String(f.id), label: f.name || t("未命名字段") }))}
                    onChange={(val) => patchBranchRule(rule.id, { targetFieldId: Number(val) })}
                    className="h-7 min-w-[96px] border border-[#dee0e3] bg-surface px-1.5 text-[12px]"
                    chevronSize={11}
                    menuMinWidth={116}
                    dataAttr={{ "data-branch-target": rule.id }}
                  />
                  {canEdit && (
                    <button
                      type="button"
                      disabled={saving}
                      aria-label={t("删除显示规则")}
                      onClick={() => updateBranchRules(branchRules.filter((r) => r.id !== rule.id))}
                      className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-destructive disabled:opacity-40"
                      data-branch-remove={rule.id}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              );
            })}
            {branchError && <p role="alert" className="text-[12px] text-destructive">{branchError}</p>}
            {canEdit && (
              <button
                type="button"
                disabled={saving}
                onClick={addBranchRule}
                data-add-branch-rule
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-primary hover:bg-accent disabled:opacity-50"
              >
                <Plus size={13} />
                <span>{t("添加显示规则")}</span>
              </button>
            )}
          </div>
        )}

        {previewOpen && selectedFields.length > 0 && (
          <div className="mt-3 rounded-lg border border-primary/25 bg-surface p-3.5" data-form-branching-preview-box>
            <div className="mb-3 flex items-center justify-between gap-2 border-b pb-2">
              <span className="text-[12px] font-medium text-foreground">{t("实时预览")}</span>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {t("当前显示 {shown} / {total} 个字段", { shown: previewVisibleFields.length, total: previewFieldDefs.length })}
                </span>
                <button
                  type="button"
                  onClick={() => setPreviewValues({})}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-hover hover:text-foreground"
                >
                  <RotateCcw size={11} />
                  <span>{t("重置")}</span>
                </button>
              </div>
            </div>
            <div className="space-y-4">
              {previewVisibleFields.map((fieldDef) => (
                <PublicFormField
                  key={fieldDef.id}
                  field={fieldDef}
                  value={previewValues[fieldDef.id]}
                  onChange={(val) => setPreviewValues((prev) => ({ ...prev, [fieldDef.id]: val }))}
                />
              ))}
              {previewVisibleFields.length === 0 && (
                <p className="py-2 text-center text-[12px] text-subtle">{t("当前条件下没有可见字段")}</p>
              )}
            </div>
          </div>
        )}
      </div>

      {error && <p role="alert" className="mt-3 text-[13px] text-destructive">{error}</p>}
      {canEdit && dirty && <label className="mt-4 flex items-start gap-2 text-[12px] text-muted-foreground"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmedSignature(event.currentTarget.checked ? signature : null)} />{t("我已确认：保存后，已发布链接会立即使用所选字段和说明。")}</label>}
      {canEdit && <div className="mt-5 flex flex-wrap gap-2"><button type="button" disabled={saving || !dirty || !confirmed || !validFormSelection(config, fields)} onClick={onSave} className="h-9 rounded-md bg-primary px-4 text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{saving ? t("保存中…") : t("保存表单配置")}</button>{dirty && <button type="button" disabled={saving} onClick={onReset} className="h-9 rounded-md border px-4 text-[13px] hover:bg-hover disabled:opacity-50">{t("放弃未保存更改")}</button>}</div>}
      {!validFormSelection(config, fields) && <p className="mt-2 text-[12px] text-subtle">{t("请选择至少一个可公开填写的字段，并移除已失效的字段。")}</p>}
    </div>
  </section>;
}
