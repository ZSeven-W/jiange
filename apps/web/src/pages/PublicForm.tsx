import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/brand";

export interface FormFieldDef {
  id: number;
  name: string;
  type: string;
  description?: string;
  options?: string[];
  required?: boolean;
}
interface FormDefinition { title: string; desc: string; fields: FormFieldDef[] }
export type FormValue = string | string[] | boolean;
const SUPPORTED = new Set(["text", "number", "checkbox", "select", "multi_select", "date", "url", "phone", "email", "rating"]);
export const supportsPublicFormField = (type: string) => SUPPORTED.has(type);
/** These server responses are returned before a record can be written. */
export function publicFormResponseIsDefinite(status: number, code: unknown): boolean {
  return (status < 500 && status !== 408 && status !== 429)
    || (status === 429 && code === "form_rate_limited")
    || (status === 503 && code === "form_busy");
}
export function formCells(fields: FormFieldDef[], values: Record<number, FormValue>): Record<string, unknown> {
  const cells: Record<string, unknown> = {};
  for (const f of fields) {
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

/** A published bearer link; numeric legacy links never reach this component. */
export function PublicForm({ token }: { token: string }) {
  const [def, setDef] = useState<FormDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [values, setValues] = useState<Record<number, FormValue>>({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [submissionKey, setSubmissionKey] = useState<string | null>(null);
  const [storageError, setStorageError] = useState("");
  const alive = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; abort.abort(); }, 15_000);
    alive.current = true;
    setLoading(true); setDef(null); setErr(""); setValues({}); setDone(false); setUncertain(false); setSubmissionKey(null); setStorageError("");
    void publicFormPendingKey(token).then((key) => { if (active) { setSubmissionKey(key); setUncertain(pending(key)); } }).catch(() => { if (active) setStorageError("浏览器无法安全保存提交状态，暂不能提交。"); });
    void fetch(tokenPath(token), { credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: abort.signal })
      .then(async (r) => { if (!r.ok) throw new Error(r.status === 404 ? "收集表不存在或已关闭。" : "暂时无法加载收集表，请稍后重试。"); return await r.json() as FormDefinition; })
      .then((value) => { if (active) setDef(value); })
      .catch((e) => { if (active && (!abort.signal.aborted || timedOut)) setErr(timedOut ? "加载超时，请稍后重新打开收集表。" : e instanceof Error ? e.message : "暂时无法加载收集表。"); })
      .finally(() => { window.clearTimeout(timeout); if (active) setLoading(false); });
    return () => { active = false; alive.current = false; window.clearTimeout(timeout); abort.abort(); };
  }, [token]);

  const submit = async () => {
    if (submitting.current || uncertain || !def || !submissionKey) return;
    let cells: Record<string, unknown>;
    try { cells = formCells(def.fields, values); }
    catch (error) { setErr(error instanceof Error ? error.message : "填写内容无效。"); return; }
    if (!Object.keys(cells).length) { setErr("请填写至少一项内容。"); return; }
    // A lost response may follow a committed record. Preserve an unknown
    // marker for this tab across reloads; never retry automatically.
    if (!setPending(submissionKey, true)) { setErr("浏览器无法保存提交状态，请检查存储设置后重试。"); return; }
    submitting.current = true; setBusy(true); setErr("");
    const request = new AbortController();
    const timeout = window.setTimeout(() => request.abort(), 15_000);
    try {
      const res = await fetch(tokenPath(token), { method: "POST", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: request.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cells }) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (publicFormResponseIsDefinite(res.status, data.error)) {
          const cleared = setPending(submissionKey, false);
          if (alive.current) { if (!cleared) setUncertain(true); if (res.status === 404) setDef(null); setErr(res.status === 404 ? "收集表已关闭或链接已失效。" : data.message || "提交失败，请检查填写内容。"); }
        } else if (alive.current) { setUncertain(true); setErr("无法确认是否提交成功，请联系收集者核对，避免重复提交。"); }
        return;
      }
      setPending(submissionKey, false);
      if (alive.current) setDone(true);
    } catch {
      if (alive.current) { setUncertain(true); setErr("无法确认是否提交成功，请联系收集者核对，避免重复提交。"); }
    } finally {
      window.clearTimeout(timeout);
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return <div className="grid min-h-full place-items-center bg-sidebar/50 p-4 sm:p-6" data-public-form>
    <div className="w-full max-w-md rounded-2xl border bg-surface p-5 shadow-sm sm:p-8">
      {loading && <p role="status" className="py-10 text-center text-[13px] text-subtle">正在加载收集表…</p>}
      {err && !def && <p role="alert" className="text-center text-[14px] text-destructive">{err}</p>}
      {done ? <div className="py-10 text-center" data-form-done><div className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-[#D9F5D6] text-[22px] text-[#237B19]">✓</div><p className="text-[16px] font-medium">提交成功</p><p className="mt-1 text-[13px] text-muted-foreground">感谢你的反馈！</p></div> : def && <>
        <h1 className="text-[20px] font-semibold">{def.title || "表单"}</h1>
        {def.desc && <p className="mb-5 mt-1 text-[13px] text-muted-foreground">{def.desc}</p>}
        <div className="mt-5 space-y-4">{def.fields.map((f) => <label key={f.id} className="block">
          <span className="mb-1 block text-[13px] font-medium">{f.name}{f.required && <span className="ml-1 text-destructive" aria-label="必填">*</span>}</span>
          {f.description && <span className="mb-1 block text-[12px] text-muted-foreground">{f.description}</span>}
          {!supportsPublicFormField(f.type) ? <span className="block text-[13px] text-subtle">此字段暂不支持在公开收集表中填写</span> : f.type === "checkbox" ? <input type="checkbox" checked={values[f.id] === true} onChange={(e) => { const checked = e.currentTarget.checked; setValues((v) => ({ ...v, [f.id]: checked })); }} /> : f.type === "multi_select" ? <select multiple className="min-h-20 w-full rounded-md border bg-surface px-2 py-1 text-[14px]" value={Array.isArray(values[f.id]) ? values[f.id] as string[] : []} onChange={(e) => { const selected = [...e.currentTarget.selectedOptions].map((o) => o.value); setValues((v) => ({ ...v, [f.id]: selected })); }}>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select> : f.type === "select" ? <select className="h-9 w-full rounded-md border bg-surface px-2 text-[14px] outline-none focus:border-primary" value={typeof values[f.id] === "string" ? values[f.id] as string : ""} onChange={(e) => { const next = e.currentTarget.value; setValues((v) => ({ ...v, [f.id]: next })); }}><option value="">请选择</option>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select> : <input className={cn("h-9 w-full rounded-md border bg-surface px-2.5 text-[16px] outline-none focus:border-primary sm:text-[14px]")} type={f.type === "number" || f.type === "rating" ? "number" : f.type === "date" ? "date" : f.type === "email" ? "email" : f.type === "url" ? "url" : "text"} min={f.type === "rating" ? 1 : undefined} max={f.type === "rating" ? 5 : undefined} value={typeof values[f.id] === "string" ? values[f.id] as string : ""} onChange={(e) => { const next = e.currentTarget.value; setValues((v) => ({ ...v, [f.id]: next })); }} />}
        </label>)}</div>
        {err && <p role="alert" className="mt-3 text-[13px] text-destructive">{err}</p>}
        {storageError && <p role="alert" className="mt-3 text-[13px] text-destructive">{storageError}</p>}
        {uncertain && !err && <p role="alert" className="mt-3 text-[13px] text-destructive">上次提交结果尚未确认，请联系收集者核对，避免重复提交。</p>}
        <button type="button" className="mt-6 h-10 w-full rounded-md bg-primary text-[14px] font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={busy || uncertain || !submissionKey} onClick={() => void submit()} data-form-submit>{busy ? "提交中…" : "提交"}</button>
        <p className="mt-3 flex items-center justify-center gap-1 text-[12px] text-subtle"><span>由</span><Logo className="gap-1" markClassName="size-4" wordmarkClassName="h-[11px]"/><span>表单收集</span></p>
      </>}
    </div>
  </div>;
}
