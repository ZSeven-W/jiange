import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/brand";
import { clearPublicFormDraft, readPublicFormDraft, writePublicFormDraft, type FormDraftEntry } from "./public-form-draft";
import {
  isValidFormBranchRule,
  visibleFormFields,
  type FormBranchRule,
} from "./base/form-branching";

export interface FormFieldDef {
  id: number;
  name: string;
  type: string;
  description?: string;
  options?: string[];
  required?: boolean;
}
interface FormDefinition { title: string; desc: string; fields: FormFieldDef[]; branchRules?: FormBranchRule[] }
export type FormValue = string | string[] | boolean;
export function validPublicFormDefinition(value: unknown): value is FormDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (typeof data.title !== "string" || typeof data.desc !== "string" || !Array.isArray(data.fields) || data.fields.length > 1000) return false;
  const ids = new Set<number>();
  for (const item of data.fields) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const field = item as Record<string, unknown>;
    if (!Number.isSafeInteger(field.id) || (field.id as number) <= 0 || ids.has(field.id as number) || typeof field.name !== "string" || typeof field.type !== "string" || (field.description !== undefined && typeof field.description !== "string") || (field.required !== undefined && typeof field.required !== "boolean") || (field.options !== undefined && (!Array.isArray(field.options) || field.options.length > 1000 || !field.options.every((option) => typeof option === "string")))) return false;
    ids.add(field.id as number);
  }
  if (data.branchRules !== undefined) {
    if (!Array.isArray(data.branchRules) || data.branchRules.length > 500 || !data.branchRules.every(isValidFormBranchRule)) return false;
  }
  return true;
}
const SUPPORTED = new Set(["text", "number", "checkbox", "select", "multi_select", "date", "url", "phone", "email", "rating"]);
export const supportsPublicFormField = (type: string) => SUPPORTED.has(type);
/** These server responses are returned before a record can be written. */
export function publicFormResponseIsDefinite(status: number, code: unknown): boolean {
  return (status < 500 && status !== 408 && status !== 429)
    || (status === 429 && code === "form_rate_limited")
    || (status === 503 && code === "form_busy");
}
export function publicFormReceiptIsConfirmed(status: number, value: unknown): boolean {
  return status === 201 && !!value && typeof value === "object" && !Array.isArray(value) && (value as { ok?: unknown }).ok === true;
}
export function formCells(fields: FormFieldDef[], values: Record<number, FormValue>, rules?: readonly FormBranchRule[]): Record<string, unknown> {
  const activeFields = rules && rules.length > 0 ? visibleFormFields(fields, rules, values) : fields;
  const cells: Record<string, unknown> = {};
  for (const f of activeFields) {
    if (!supportsPublicFormField(f.type)) { if (f.required) throw new Error(`${f.name} 暂不支持填写，请联系收集者。`); continue; }
    const v = values[f.id];
    if (v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0)) {
      if (f.required) throw new Error(`请填写${f.name}。`);
      continue;
    }
    if ((f.type === "number" || f.type === "rating") && typeof v === "string") {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${f.name} 请输入有效数字。`);
      cells[f.id] = n;
    } else cells[f.id] = v;
  }
  return cells;
}
const tokenPath = (token: string) => `/api/forms/${encodeURIComponent(token)}`;
/** Never keep a raw bearer token in browser storage, even as a key. */
export async function publicFormPendingKey(token: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("浏览器不支持安全处理收集表链接。");
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return `jiange:form-pending:${[...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
function pending(key: string): boolean { try { return sessionStorage.getItem(key) === "1"; } catch { return false; } }
function setPending(key: string, value: boolean): boolean { try { if (value) sessionStorage.setItem(key, "1"); else sessionStorage.removeItem(key); return true; } catch { return false; } }

function FormDraftRecovery({ unmatched, unreadable }: { unmatched: readonly FormDraftEntry[]; unreadable: string | null }) {
  return <>{unmatched.length > 0 && <details className="mt-3 rounded-md border p-3 text-[12px] text-muted-foreground"><summary className="cursor-pointer">部分草稿对应的问题已变化，可展开复制</summary><textarea aria-label="未匹配的草稿内容" readOnly value={unmatched.map((entry) => `${entry.name}：${Array.isArray(entry.value) ? entry.value.join("、") : String(entry.value)}`).join("\n")} className="mt-2 h-24 w-full rounded border bg-surface p-2 text-foreground"/></details>}
    {unreadable !== null && <details className="mt-3 rounded-md border p-3 text-[12px] text-muted-foreground"><summary className="cursor-pointer">旧草稿无法自动恢复，新填写内容不会覆盖它</summary><textarea aria-label="无法读取的草稿" readOnly value={unreadable} className="mt-2 h-24 w-full rounded border bg-surface p-2 text-foreground"/></details>}</>;
}

/** A fieldset keeps the question and its choices associated for assistive technology. */
export function PublicFormField({ field, value, onChange, disabled = false }: { field: FormFieldDef; value: FormValue | undefined; onChange: (value: FormValue) => void; disabled?: boolean }) {
  const id = useId(), labelId = `${id}-label`, descriptionId = `${id}-description`;
  const selected = Array.isArray(value) ? value : [];
  const options = field.options ?? [];
  const selectedValue = typeof value === "string" ? value : "";
  const inputClass = "h-9 w-full rounded-md border bg-surface px-2.5 text-[16px] outline-none focus:border-primary sm:text-[14px]";
  const optionClass = "flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[14px] hover:bg-hover sm:min-h-9";
  return <fieldset disabled={disabled} className="min-w-0" aria-describedby={field.description ? descriptionId : undefined}>
    <legend id={labelId} className="mb-1 block text-[13px] font-medium">{field.name}{field.required && <span className="ml-1 text-destructive" aria-label="必填">*</span>}</legend>
    {field.description && <p id={descriptionId} className="mb-2 text-[12px] text-muted-foreground">{field.description}</p>}
    {!supportsPublicFormField(field.type) ? <span className="block text-[13px] text-subtle">此字段暂不支持在公开收集表中填写</span>
      : field.type === "checkbox" ? <input type="checkbox" aria-labelledby={labelId} checked={value === true} onChange={(event) => onChange(event.currentTarget.checked)} className="size-4 accent-[#3370ff]" />
      : field.type === "select" || field.type === "multi_select" ? <div className="space-y-1" data-form-choice={field.type}>
        {options.length ? options.map((option, index) => <label key={`${index}:${option}`} className={optionClass}>
          <input type={field.type === "select" ? "radio" : "checkbox"} name={field.type === "select" ? id : undefined} value={option}
            checked={field.type === "select" ? selectedValue === option : selected.includes(option)}
            onChange={(event) => {
              if (field.type === "select") onChange(option);
              else { const chosen = new Set(selected); if (event.currentTarget.checked) chosen.add(option); else chosen.delete(option); onChange(options.filter((item) => chosen.has(item))); }
            }} className="size-4 shrink-0 accent-[#3370ff]" />
          <span className="break-words">{option}</span>
        </label>) : <p className="py-1 text-[13px] text-subtle">暂无可选项</p>}
        {field.type === "select" && selectedValue && <button type="button" className="rounded px-2 text-[12px] text-subtle hover:text-primary" onClick={() => onChange("")}>清除选择</button>}
      </div>
      : field.type === "rating" ? <div className="flex flex-wrap items-center gap-1" data-form-rating>
        {[1, 2, 3, 4, 5].map((score) => <label key={score} className="relative grid size-9 cursor-pointer place-items-center rounded-md hover:bg-hover">
          <input type="radio" name={id} value={score} checked={selectedValue === String(score)} onChange={() => onChange(String(score))} aria-label={`${score} 星`} className="peer sr-only" />
          <Star size={23} strokeWidth={1.7} aria-hidden="true" className={cn("rounded-sm text-[#C4C8CE] peer-focus-visible:ring-2 peer-focus-visible:ring-primary", Number(selectedValue) >= score && "fill-[#FFB900] text-[#FFB900]")} />
        </label>)}
        {selectedValue && <button type="button" className="ml-1 rounded px-2 py-1 text-[12px] text-subtle hover:text-primary" onClick={() => onChange("")}>清除评分</button>}
      </div>
      : <input aria-labelledby={labelId} className={inputClass} type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "email" ? "email" : field.type === "url" ? "url" : field.type === "phone" ? "tel" : "text"} value={selectedValue} onChange={(event) => onChange(event.currentTarget.value)} />}
  </fieldset>;
}

/** A published bearer link; numeric legacy links never reach this component. */
export function PublicForm({ token, branchRules: explicitBranchRules }: { token: string; branchRules?: FormBranchRule[] }) {
  const [def, setDef] = useState<FormDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [values, setValues] = useState<Record<number, FormValue>>({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [submissionKey, setSubmissionKey] = useState<string | null>(null);
  const [storageError, setStorageError] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [unmatched, setUnmatched] = useState<FormDraftEntry[]>([]);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [defToken, setDefToken] = useState<string | null>(null);
  const [keyToken, setKeyToken] = useState<string | null>(null);
  const alive = useRef(true);
  const submitting = useRef<{ token: string; generation: number } | null>(null);
  const generation = useRef(0);
  const tokenRef = useRef(token); tokenRef.current = token;
  const valuesRef = useRef(values); valuesRef.current = values;
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; abort.abort(); }, 15_000);
    alive.current = true;
    generation.current++;
    setLoading(true); setDef(null); setDefToken(null); setKeyToken(null); setErr(""); setValues({}); valuesRef.current = {}; setDone(false); setBusy(false); setUncertain(false); setSubmissionKey(null); setStorageError(""); setDraftReady(false); setDraftError(""); setUnmatched([]); setUnreadable(null);
    void publicFormPendingKey(token).then((key) => { if (active) { setSubmissionKey(key); setKeyToken(token); setUncertain(pending(key)); } }).catch(() => { if (active) { setStorageError("浏览器无法安全保存提交状态，暂不能提交。"); setDraftReady(true); } });
    void fetch(tokenPath(token), { credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: abort.signal })
      .then(async (r) => { if (!r.ok) throw new Error(r.status === 404 ? "收集表不存在或已关闭。" : "暂时无法加载收集表，请稍后重试。"); const value: unknown = await r.json(); if (!validPublicFormDefinition(value)) throw new Error("收集表配置无效，请联系收集者。"); return value; })
      .then((value) => { if (active) { setDef(value); setDefToken(token); } })
      .catch((e) => { if (active && (!abort.signal.aborted || timedOut)) setErr(timedOut ? "加载超时，请稍后重新打开收集表。" : e instanceof Error ? e.message : "暂时无法加载收集表。"); })
      .finally(() => { window.clearTimeout(timeout); if (active) setLoading(false); });
    return () => { active = false; alive.current = false; window.clearTimeout(timeout); abort.abort(); };
  }, [token]);

  useEffect(() => {
    if (draftReady || !def || defToken !== token || !submissionKey || keyToken !== token) return;
    let restored;
    try { restored = readPublicFormDraft(sessionStorage, submissionKey, def.fields); }
    catch { restored = { values: {}, unmatched: [], unreadable: "浏览器存储不可用，无法自动恢复草稿。" }; }
    valuesRef.current = restored.values; setValues(restored.values); setUnmatched(restored.unmatched); setUnreadable(restored.unreadable); setDraftReady(true);
  }, [def, defToken, token, submissionKey, keyToken, draftReady]);
  useEffect(() => {
    if (draftReady || loading || def || !submissionKey || keyToken !== token) return;
    let restored;
    try { restored = readPublicFormDraft(sessionStorage, submissionKey, []); }
    catch { restored = { values: {}, unmatched: [], unreadable: "浏览器存储不可用，无法自动恢复草稿。" }; }
    setUnmatched(restored.unmatched); setUnreadable(restored.unreadable); setDraftReady(true);
  }, [draftReady, loading, def, submissionKey, keyToken, token]);

  const updateValue = (id: number, value: FormValue) => {
    const next = { ...valuesRef.current, [id]: value }; valuesRef.current = next; setValues(next);
    if (!def || !submissionKey || !draftReady || unreadable !== null || defToken !== token || keyToken !== token) return;
    let saved = false;
    try { saved = writePublicFormDraft(sessionStorage, submissionKey, def.fields, next, unmatched); } catch { /* storage access can be blocked */ }
    setDraftError(saved ? "" : "本标签页无法保存填写草稿，请勿刷新或关闭页面。");
  };

  const activeBranchRules = useMemo(() => {
    if (explicitBranchRules && explicitBranchRules.length > 0) return explicitBranchRules;
    if (def?.branchRules && def.branchRules.length > 0) return def.branchRules;
    return [];
  }, [explicitBranchRules, def]);

  const displayedFields = useMemo(
    () => (def ? visibleFormFields(def.fields, activeBranchRules, values) : []),
    [def, activeBranchRules, values],
  );

  const submit = async () => {
    if (submitting.current?.token === token || uncertain || !def || !submissionKey || !draftReady || defToken !== token || keyToken !== token) return;
    let cells: Record<string, unknown>;
    const submittedValues = valuesRef.current;
    try { cells = formCells(def.fields, submittedValues, activeBranchRules); }
    catch (error) { setErr(error instanceof Error ? error.message : "填写内容无效。"); return; }
    if (!Object.keys(cells).length) { setErr("请填写至少一项内容。"); return; }
    // A lost response may follow a committed record. Preserve an unknown
    // marker for this tab across reloads; never retry automatically.
    if (!setPending(submissionKey, true)) { setErr("浏览器无法保存提交状态，请检查存储设置后重试。"); return; }
    const attempt = { token, generation: generation.current };
    submitting.current = attempt; setBusy(true); setErr("");
    const requestGeneration = attempt.generation;
    const current = () => alive.current && generation.current === requestGeneration && tokenRef.current === token;
    const request = new AbortController();
    const timeout = window.setTimeout(() => request.abort(), 15_000);
    try {
      const res = await fetch(tokenPath(token), { method: "POST", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: request.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cells }) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (publicFormResponseIsDefinite(res.status, data.error)) {
          const cleared = setPending(submissionKey, false);
          if (current()) { if (!cleared) setUncertain(true); if (res.status === 404) { setUnmatched([...unmatched, ...def.fields.flatMap((field) => submittedValues[field.id] === undefined ? [] : [{ id: field.id, name: field.name, type: field.type, value: submittedValues[field.id] }])]); setDef(null); } setErr(res.status === 404 ? "收集表已关闭或链接已失效。" : data.message || "提交失败，请检查填写内容。"); }
        } else if (current()) { setUncertain(true); setErr("无法确认是否提交成功，请联系收集者核对，避免重复提交。"); }
        return;
      }
      const receipt = await res.json().catch(() => null);
      if (!publicFormReceiptIsConfirmed(res.status, receipt)) { if (current()) { setUncertain(true); setErr("无法确认是否提交成功，请联系收集者核对，避免重复提交。"); } return; }
      // A later visit to the same form may already contain new answers.
      // An obsolete request must not clear that visit's draft or marker.
      if (!current()) return;
      let cleared = unreadable !== null;
      if (!cleared) { try { cleared = unmatched.length ? writePublicFormDraft(sessionStorage, submissionKey, [], {}, unmatched) : clearPublicFormDraft(sessionStorage, submissionKey); } catch { cleared = false; } }
      if (cleared) setPending(submissionKey, false);
      if (current()) { setDone(true); if (!cleared) setDraftError("提交成功，但本地草稿未能清理；请勿重复提交。"); }
    } catch {
      if (current()) { setUncertain(true); setErr("无法确认是否提交成功，请联系收集者核对，避免重复提交。"); }
    } finally {
      window.clearTimeout(timeout);
      if (submitting.current === attempt) submitting.current = null;
      if (current()) setBusy(false);
    }
  };

  return <div className="flex min-h-full items-start justify-center bg-sidebar/50 px-4 py-6 sm:px-6 sm:py-10" data-public-form>
    <div className="w-full max-w-md rounded-2xl border bg-surface p-5 shadow-sm sm:p-8">
      {loading && <p role="status" className="py-10 text-center text-[13px] text-subtle">正在加载收集表…</p>}
      {err && !def && <p role="alert" className="text-center text-[14px] text-destructive">{err}</p>}
      {!loading && !def && <FormDraftRecovery unmatched={unmatched} unreadable={unreadable}/>}
      {done && defToken === token ? <div className="py-10 text-center" data-form-done><div className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-[#D9F5D6] text-[22px] text-[#237B19]">✓</div><p className="text-[16px] font-medium">提交成功</p><p className="mt-1 text-[13px] text-muted-foreground">感谢你的反馈！</p><FormDraftRecovery unmatched={unmatched} unreadable={unreadable}/>{draftError && <p role="alert" className="mt-3 text-[13px] text-destructive">{draftError}</p>}</div> : def && defToken === token && <>
        <h1 className="text-[20px] font-semibold">{def.title || "表单"}</h1>
        {def.desc && <p className="mb-5 mt-1 text-[13px] text-muted-foreground">{def.desc}</p>}
        <div className="mt-5 space-y-5">{displayedFields.map((f) => <PublicFormField key={f.id} field={f} value={values[f.id]} disabled={busy || !draftReady || defToken !== token || (!!submissionKey && keyToken !== token)} onChange={(value) => updateValue(f.id, value)} />)}</div>
        {draftReady && submissionKey && unreadable === null && !draftError && <p className="sr-only" role="status">填写内容自动保存在当前标签页，提交后清除已提交内容。</p>}
        <FormDraftRecovery unmatched={unmatched} unreadable={unreadable}/>
        {draftError && <p role="alert" className="mt-3 text-[13px] text-destructive">{draftError}</p>}
        {err && <p role="alert" className="mt-3 text-[13px] text-destructive">{err}</p>}
        {storageError && <p role="alert" className="mt-3 text-[13px] text-destructive">{storageError}</p>}
        {uncertain && !err && <p role="alert" className="mt-3 text-[13px] text-destructive">上次提交结果尚未确认，请联系收集者核对，避免重复提交。</p>}
        <button type="button" className="mt-6 h-10 w-full rounded-md bg-primary text-[14px] font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={busy || uncertain || !submissionKey || !draftReady || defToken !== token || keyToken !== token} onClick={() => void submit()} data-form-submit>{busy ? "提交中…" : "提交"}</button>
        <p className="mt-3 flex items-center justify-center gap-1 text-[12px] text-subtle"><span>由</span><Logo className="gap-1" markClassName="size-4" wordmarkClassName="h-[11px]"/><span>表单收集</span></p>
      </>}
    </div>
  </div>;
}
