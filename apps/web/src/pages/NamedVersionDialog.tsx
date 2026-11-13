import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { ApiError, docsApi } from "@/lib/api";
import { formatEditTime } from "./docHeaderMeta";
import { nextNamedVersionNumber, randomVersionRequestId, versionRequestIdentity, type VersionRequestIdentity } from "./versionRequestIdentity";

export function versionSaveError(error: unknown): string {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return error.message || "无法保存版本，请检查权限和同步状态。";
  if (error instanceof Error && error.name === "VersionNotReady") return error.message;
  return "无法确认保存结果，请检查历史记录；使用相同名称重试不会覆盖已有版本。";
}

/** The named version is created only by the guarded, account-bound endpoint. */
export function NamedVersionDialog({ docId, userId, title, onSave, onClose }: { docId: number; userId: number; title: string; onSave: (label: string, requestId: string) => Promise<void>; onClose: () => void }) {
  const versions = useQuery({ queryKey: ["versions", userId, docId], queryFn: () => docsApi.versionEntries(docId, userId) });
  const [label, setLabel] = useState(`${title} 第 1 版`);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const request = useRef<VersionRequestIdentity | null>(null);
  const pendingRef = useRef(false); pendingRef.current = pending;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => { if (!touched && versions.isSuccess && !versions.isFetching) setLabel(`${title} 第 ${nextNamedVersionNumber(versions.data)} 版`); }, [title, touched, versions.data, versions.isSuccess, versions.isFetching]);
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus(); input.current?.select();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingRef.current) { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab" || !root.current) return;
      const items = [...root.current.querySelectorAll<HTMLElement>("input:not([disabled]),button:not([disabled])")];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (i < 0 || event.shiftKey && i === 0 || !event.shiftKey && i === items.length - 1) { event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { alive.current = false; document.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); };
  }, []);
  const save = async () => {
    const name = label.trim();
    if (busy.current || !name) return;
    try { request.current = versionRequestIdentity(request.current, name, randomVersionRequestId); }
    catch { setError("无法创建安全的保存请求，请检查浏览器环境。"); return; }
    busy.current = true; setPending(true); setError("");
    try { await onSave(name, request.current.id); if (alive.current) onClose(); }
    catch (err) { if (alive.current) setError(versionSaveError(err)); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  };
  return <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <section ref={root} role="dialog" aria-modal="true" aria-labelledby="named-version-title" className="w-full max-w-[420px] rounded-lg bg-surface px-6 pb-6 pt-5 text-foreground shadow-xl">
      <header className="flex items-center gap-4"><h2 id="named-version-title" className="flex-1 text-[16px] font-medium">保存 {formatEditTime(new Date().toISOString())} 的文档版本</h2><button type="button" aria-label="关闭保存版本" disabled={pending} onClick={onClose} className="grid size-8 place-items-center rounded text-[#646A73] hover:bg-hover disabled:opacity-50"><X size={18}/></button></header>
      <label className="mt-5 block text-[14px]" htmlFor="named-version-name">版本名称</label>
      <div className="mt-2 flex h-8 items-center rounded-md border border-[#BBBFC4] px-2 focus-within:border-[#3370FF] focus-within:ring-1 focus-within:ring-[#3370FF]"><input ref={input} id="named-version-name" value={label} disabled={pending} maxLength={1000} onChange={(event) => { setTouched(true); setLabel(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void save(); } }} className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"/><span className="rounded bg-[#F2F3F5] px-1 text-[12px] text-[#646A73] dark:bg-hover">{label.length}/1000</span></div>
      {error && <p role="alert" className="mt-3 text-[13px] leading-5 text-destructive">{error}</p>}
      <div className="mt-12 flex justify-end gap-3"><button type="button" disabled={pending} onClick={onClose} className="h-8 min-w-20 rounded-md border bg-surface px-4 text-[14px] hover:bg-hover disabled:opacity-50">取消</button><button type="button" disabled={pending || !label.trim()} onClick={() => void save()} className="h-8 min-w-20 rounded-md bg-[#1456F0] px-4 text-[14px] text-white hover:bg-[#0F4DD6] disabled:opacity-50">{pending ? "保存中…" : "确定"}</button></div>
    </section>
  </div>;
}
