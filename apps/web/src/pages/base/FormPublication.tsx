import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, type Field, type ViewConfig } from "@/lib/api";
import { closeForm, formLink, publishForm, readFormPublication } from "./publicFormApi";

function operationKey(baseId: number, viewId: number) { return `jiange:form-publication-pending:${baseId}:${viewId}`; }
function hasUncertainOperation(baseId: number, viewId: number): boolean { try { return sessionStorage.getItem(operationKey(baseId, viewId)) === "1"; } catch { return false; } }
function markOperation(baseId: number, viewId: number, pending: boolean): boolean { try { if (pending) sessionStorage.setItem(operationKey(baseId, viewId), "1"); else sessionStorage.removeItem(operationKey(baseId, viewId)); return true; } catch { return false; } }

/** The raw bearer token is shown only immediately after publication. */
export function FormPublication({ baseId, viewId, canManage, canPublish, config, fields, onAccessChange }: { baseId: number; viewId: number; canManage: boolean; canPublish: boolean; config: ViewConfig; fields: Field[]; onAccessChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"loading" | "published" | "closed" | "error">("loading");
  const [revision, setRevision] = useState<number | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"rotate" | "close" | null>(null);
  const [notice, setNotice] = useState("");
  const [acknowledgedSignature, setAcknowledgedSignature] = useState<string | null>(null);
  const previewSignature = JSON.stringify({ config, fields });
  const acknowledged = acknowledgedSignature === previewSignature;
  const [unresolved, setUnresolved] = useState(() => hasUncertainOperation(baseId, viewId));
  const alive = useRef(true);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const accessChanged = useRef(onAccessChange);
  accessChanged.current = onAccessChange;
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; abort.abort(); }, 15_000);
    setState("loading"); setRevision(null); setToken(null); setConfirm(null); setNotice(""); setAcknowledgedSignature(null); setUnresolved(hasUncertainOperation(baseId, viewId));
    try {
      const status = await readFormPublication(baseId, viewId, abort.signal);
      if (alive.current && generation.current === current) {
        // Reading status alone cannot prove that an older request has stopped.
        // Keep its marker until an explicit CAS close/republish succeeds.
        setRevision(status.revision); setUnresolved(hasUncertainOperation(baseId, viewId));
        setState(status.published ? "published" : "closed");
      }
    } catch (error) {
      if (!alive.current || generation.current !== current || (abort.signal.aborted && !timedOut)) return;
      setState("error");
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) { setNotice("无法查看发布状态，请重新验证权限。"); accessChanged.current(); }
      else setNotice("无法获取发布状态，请稍后重试。");
    } finally { window.clearTimeout(timeout); }
  }, [baseId, viewId]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!open || !canManage) { generation.current++; controller.current?.abort(); setToken(null); setConfirm(null); return; }
    void refresh();
  }, [open, canManage, refresh]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") { generation.current++; controller.current?.abort(); setToken(null); setOpen(false); } };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  useEffect(() => {
    if (!open) return;
    const root = dialog.current;
    root?.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending.current) { event.preventDefault(); setOpen(false); return; }
      if (event.key !== "Tab" || !root) return;
      const nodes = [...root.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]')];
      if (!nodes.length) { event.preventDefault(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1], current = document.activeElement;
      if (event.shiftKey && (current === first || !root.contains(current))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (current === last || !root.contains(current))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); trigger.current?.focus(); };
  }, [open]);
  const action = async (kind: "publish" | "close") => {
    if (pending.current || revision === null || !canManage || (kind === "publish" && (!canPublish || !acknowledged))) return;
    const current = ++generation.current;
    controller.current?.abort();
    if (!markOperation(baseId, viewId, true)) { setState("error"); setNotice("浏览器无法保存操作状态，请检查存储设置后重试。"); return; }
    pending.current = true; setBusy(true); setToken(null); setConfirm(null); setNotice("");
    const request = new AbortController();
    const timeout = window.setTimeout(() => request.abort(), 15_000);
    try {
      const result = kind === "publish" ? await publishForm(baseId, viewId, revision, config, fields, request.signal) : await closeForm(baseId, viewId, revision, request.signal);
      const cleared = markOperation(baseId, viewId, false);
      if (!alive.current || generation.current !== current) return;
      setUnresolved(!cleared);
      setRevision(result.revision);
      const newToken = "token" in result ? result.token : null;
      setToken(newToken); setState(newToken ? "published" : "closed");
      setNotice(newToken ? "链接仅在本次发布后显示，请及时复制。" : "收集表已关闭，旧链接不可再提交。");
    } catch (error) {
      const knownFailure = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (knownFailure && !unresolved) markOperation(baseId, viewId, false);
      if (!alive.current || generation.current !== current) return;
      setState("error");
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) { setNotice("权限已变化，请重新验证。"); accessChanged.current(); }
      else if (error instanceof ApiError && error.status === 409) setNotice("发布状态已发生变化，请检查最新状态后再操作。");
      else if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) setNotice(error.message || "操作失败，请检查后重试。");
      else { setUnresolved(true); setNotice("无法确认操作是否完成，请先检查最新状态，再由你决定是否重新发布或关闭。"); }
    } finally {
      window.clearTimeout(timeout);
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  if (!canManage) return null;
  const link = token && typeof location !== "undefined" ? formLink(token, location.origin, location.pathname) : null;
  return <>
    <button ref={trigger} type="button" disabled={busy} onClick={() => setOpen(true)} className="rounded-md border px-2.5 py-1 text-primary hover:bg-hover disabled:opacity-50">发布收集表</button>
    {open && typeof document !== "undefined" && createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" onClick={() => { if (!busy) setOpen(false); }}>
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="form-publication-title" className="w-full max-w-md rounded-xl border bg-surface p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between"><h2 id="form-publication-title" className="text-[16px] font-semibold">分享收集表</h2><button type="button" aria-label="关闭" disabled={busy} onClick={() => setOpen(false)} className="rounded px-2 py-1 hover:bg-hover">×</button></div>
        <p className="mt-3 text-[13px] text-muted-foreground">发布后，获得链接的人可提交表单。请仅分享给可信任的填写者。</p>
        <div className="mt-4 rounded-md border p-3 text-[13px]">
          <p className="font-medium">将公开的字段</p>
          {canPublish ? <><div className="mt-2 max-h-44 space-y-2 overflow-y-auto text-muted-foreground"><div><span className="font-medium text-foreground">标题：</span>{config.title || "表单"}</div>{config.desc && <div><span className="font-medium text-foreground">说明：</span>{config.desc}</div>}<ul className="list-disc space-y-1 pl-5">{(Array.isArray(config.fields) ? config.fields : []).map((id) => { const field = fields.find((item) => item.id === id); return <li key={id}><span>{field?.name ?? "已删除字段"}{Array.isArray(config.required) && config.required.includes(id) ? "（必填）" : ""}</span>{field?.description && <p className="break-words text-[12px]">说明：{field.description}</p>}{field?.options?.length ? <p className="break-words text-[12px]">选项：{field.options.join("、")}</p> : null}</li>; })}</ul></div><label className="mt-3 flex items-start gap-2 text-[12px] text-muted-foreground"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledgedSignature(event.currentTarget.checked ? previewSignature : null)} />我已确认以上内容可供获得链接的人查看和填写</label></> : <p className="mt-2 text-[12px] text-destructive">请先选择并保存可公开填写的字段，再发布；仍可关闭已有收集。</p>}
        </div>
        <p className="mt-4 text-[13px]">状态：{state === "loading" ? "正在检查…" : state === "published" ? "已发布" : state === "closed" ? "未发布" : "未确认"}</p>
        {state === "published" && !link && <p className="mt-2 text-[12px] text-subtle">出于安全考虑，旧链接不会再次显示；重新发布会使旧链接失效。</p>}
        {link && <div className="mt-3 flex gap-2"><label className="min-w-0 flex-1"><span className="sr-only">收集表链接</span><input readOnly value={link} className="h-9 w-full rounded-md border bg-surface px-2 text-[12px]" onFocus={(e) => e.currentTarget.select()} /></label><button type="button" className="shrink-0 rounded-md border px-3 text-[13px] hover:bg-hover" onClick={() => { if (!navigator.clipboard) { setNotice("请手动选择并复制链接。"); return; } void navigator.clipboard.writeText(link).then(() => setNotice("链接已复制。")).catch(() => setNotice("复制失败，请手动选择并复制链接。")); }}>复制</button></div>}
        {notice && <p role="status" className="mt-3 text-[12px] text-muted-foreground">{notice}</p>}
        {unresolved && <p role="alert" className="mt-3 text-[12px] text-destructive">上次操作结果尚未确认，旧请求仍可能完成。请先检查状态，再明确选择关闭或重新发布；若状态同时变化，请重新检查。</p>}
        {confirm && <div className="mt-4 rounded-md bg-[#fff8e8] p-3 text-[13px] text-[#8f6200]">{confirm === "rotate" ? "重新发布后，所有旧链接会立即失效。" : "关闭后，现有链接将不能再提交。"}<div className="mt-2 flex gap-2"><button type="button" disabled={busy || (confirm === "rotate" && (!canPublish || !acknowledged))} className="rounded bg-primary px-3 py-1 text-white disabled:opacity-50" onClick={() => void action(confirm === "rotate" ? "publish" : "close")}>确认{confirm === "rotate" ? "重新发布" : "关闭"}</button><button type="button" onClick={() => setConfirm(null)} className="rounded border px-3 py-1">取消</button></div></div>}
        <div className="mt-5 flex flex-wrap gap-2">
          {state === "error" && <button type="button" disabled={busy} onClick={() => void refresh()} className="rounded-md border px-3 py-1.5 text-[13px]">检查状态</button>}
          {state === "closed" && !unresolved && <button type="button" disabled={busy || !canPublish || !acknowledged} onClick={() => void action("publish")} className="rounded-md bg-primary px-3 py-1.5 text-[13px] text-white disabled:opacity-50">发布并生成链接</button>}
          {(state === "published" || (state === "closed" && unresolved)) && <><button type="button" disabled={busy || !canPublish} onClick={() => setConfirm("rotate")} className="rounded-md border px-3 py-1.5 text-[13px] disabled:opacity-50">重新发布</button><button type="button" disabled={busy} onClick={() => setConfirm("close")} className="rounded-md border px-3 py-1.5 text-[13px] disabled:opacity-50">关闭收集</button></>}
        </div>
      </section>
    </div>, document.body)}
  </>;
}
