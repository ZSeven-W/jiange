import { useState } from "react";
import { t, useI18n } from "@/lib/i18n";
import type { Field, ViewConfig } from "@/lib/api";
import { supportsPublicFormField } from "@/pages/PublicForm";

/** Return a stable, explicit public field list; unsupported fields cannot be shared. */
export function validFormSelection(config: ViewConfig, fields: Field[]): boolean {
  if (!Array.isArray(config.fields) || config.fields.length === 0) return false;
  if (config.required !== undefined && !Array.isArray(config.required)) return false;
  const allowed = new Set(fields.filter((f) => supportsPublicFormField(f.type)).map((f) => f.id));
  const picked = new Set(config.fields);
  const required = config.required ?? [];
  return picked.size === config.fields.length && config.fields.every((id) => allowed.has(id))
    && new Set(required).size === required.length && required.every((id) => picked.has(id));
}
export function setFormField(config: ViewConfig, fieldId: number, selected: boolean): ViewConfig {
  const current = Array.isArray(config.fields) ? config.fields : [];
  const required = Array.isArray(config.required) ? config.required : [];
  return { ...config, fields: selected ? [...current.filter((id) => id !== fieldId), fieldId] : current.filter((id) => id !== fieldId), required: required.filter((id) => id !== fieldId) };
}
export function setFormRequired(config: ViewConfig, fieldId: number, required: boolean): ViewConfig {
  if (!Array.isArray(config.fields) || !config.fields.includes(fieldId)) return config;
  const existing = Array.isArray(config.required) ? config.required : [];
  return { ...config, required: required ? [...existing.filter((id) => id !== fieldId), fieldId] : existing.filter((id) => id !== fieldId) };
}

/** Editable selection is explicit: the manager sees exactly what will be shared. */
export function FormSetup({ config, fields, canEdit, saving, dirty, error, onChange, onSave, onReset }: { config: ViewConfig; fields: Field[]; canEdit: boolean; saving: boolean; dirty: boolean; error: string | null; onChange: (value: ViewConfig) => void; onSave: () => void; onReset: () => void }) {
  const selected = new Set(Array.isArray(config.fields) ? config.fields : []);
  const required = new Set(Array.isArray(config.required) ? config.required : []);
  const missing = (Array.isArray(config.fields) ? config.fields : []).filter((id) => !fields.some((f) => f.id === id));
  const signature = JSON.stringify({ config, fields });
  const [confirmedSignature, setConfirmedSignature] = useState<string | null>(null);
  const confirmed = confirmedSignature === signature;
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
      {missing.length > 0 && <p role="alert" className="mt-2 text-[12px] text-destructive">{t("有已删除的字段仍在配置中。")} {canEdit && <button type="button" disabled={saving} className="underline" onClick={() => { const remaining = (Array.isArray(config.fields) ? config.fields : []).filter((id) => !missing.includes(id)); onChange({ ...config, fields: remaining, required: (Array.isArray(config.required) ? config.required : []).filter((id) => remaining.includes(id)) }); }}>{t("移除失效字段")}</button>}</p>}
      {error && <p role="alert" className="mt-3 text-[13px] text-destructive">{error}</p>}
      {canEdit && dirty && <label className="mt-4 flex items-start gap-2 text-[12px] text-muted-foreground"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmedSignature(event.currentTarget.checked ? signature : null)} />{t("我已确认：保存后，已发布链接会立即使用所选字段和说明。")}</label>}
      {canEdit && <div className="mt-5 flex flex-wrap gap-2"><button type="button" disabled={saving || !dirty || !confirmed || !validFormSelection(config, fields)} onClick={onSave} className="h-9 rounded-md bg-primary px-4 text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{saving ? t("保存中…") : t("保存表单配置")}</button>{dirty && <button type="button" disabled={saving} onClick={onReset} className="h-9 rounded-md border px-4 text-[13px] hover:bg-hover disabled:opacity-50">{t("放弃未保存更改")}</button>}</div>}
      {!validFormSelection(config, fields) && <p className="mt-2 text-[12px] text-subtle">{t("请选择至少一个可公开填写的字段，并移除已失效的字段。")}</p>}
    </div>
  </section>;
}
