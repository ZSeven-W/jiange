import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ImagePlus, Upload, X } from "lucide-react";
import { ApiError, docsApi } from "@/lib/api";
import { COVER_GALLERY, changeDocumentCover, coverChoice, coverImageURL, documentCoverApi, parseDocumentCover, type CoverChoice, type DocumentCover as Cover } from "@/lib/documentCoverApi";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return "封面已被其他人修改，请重新选择。";
  if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return "无法修改封面：文档不存在或当前没有编辑权限。";
  if (error instanceof ApiError && error.status === 400) return "图片不符合封面要求，请选择 JPG、PNG 或 GIF 图片。";
  return "更新结果可能尚未确认，请重新验证。";
}

const MAX_PREVIEW_RETRIES = 3;
export function scheduleCoverPreviewRetry(attempt: number, retry: () => void): () => void {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= MAX_PREVIEW_RETRIES) return () => {};
  const timer = setTimeout(retry, 500 * 2 ** attempt);
  return () => clearTimeout(timer);
}

/** Render only a server-authorized cover URL or an application-owned asset. */
export function CoverImage({ cover, docId, publicToken, recovery = 0 }: { cover: Cover; docId?: number; publicToken?: string; recovery?: number }) {
  const url = coverImageURL(cover, docId, publicToken);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setAttempt(0); setFailed(false); }, [url]);
  useEffect(() => {
    if (!failed || attempt >= MAX_PREVIEW_RETRIES) return;
    // The authenticated/public preview endpoint revalidates the user/token and
    // revision on every request. The timer is cancelled on unmount or URL change.
    return scheduleCoverPreviewRetry(attempt, () => { setFailed(false); setAttempt((value) => value + 1); });
  }, [attempt, failed, url]);
  const lastRecovery = useRef(recovery);
  useEffect(() => {
    if (lastRecovery.current !== recovery) {
      lastRecovery.current = recovery;
      if (failed && attempt >= MAX_PREVIEW_RETRIES) { setFailed(false); setAttempt(0); }
    }
  }, [recovery, failed, attempt]);
  if (!url) return null;
  const src = attempt ? `${url}${url.includes("?") ? "&" : "?"}retry=${attempt}` : url;
  return <><img src={src} alt="文档封面" draggable={false} onLoad={() => setFailed(false)} onError={() => setFailed(true)} className={`absolute inset-0 h-full w-full select-none object-cover ${failed ? "opacity-0" : ""}`} style={{ objectPosition: `center ${cover.position * 100}%` }} />{failed && <span role="status" className="absolute inset-0 grid place-items-center text-[12px] text-muted-foreground">{attempt < MAX_PREVIEW_RETRIES ? "封面加载失败，正在重试…" : "封面暂时无法加载，验证连接后会重试。"}</span>}</>;
}

export function PublicDocumentCover({ value, token, recovery = 0, allowCopy = true, allowPrint = true }: { value: unknown; token: string; recovery?: number; allowCopy?: boolean; allowPrint?: boolean }) {
  const cover = parseDocumentCover(value);
  if (!cover || cover.kind === "none" || !coverImageURL(cover, undefined, token)) return null;
  return <div data-document-print-restricted={!allowPrint ? "true" : undefined} onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }} onContextMenu={(event) => { if (!allowCopy || !allowPrint) event.preventDefault(); }} className="relative h-36 w-full overflow-hidden bg-sidebar sm:h-52"><CoverImage cover={cover} publicToken={token} recovery={recovery} /></div>;
}

type CoverControls = { addButton: ReactNode; hasCover: boolean };
export function DocumentCover({ id, userId, visible, enabled, hasIcon, allowCopy, allowPrint, onRevalidate, children }: {
  id: number; userId: number; visible: boolean; enabled: boolean; hasIcon: boolean; allowCopy: boolean; allowPrint: boolean; onRevalidate: () => void; children: (controls: CoverControls) => ReactNode;
}) {
  const [cover, setCover] = useState<Cover>();
  const coverRef = useRef<Cover | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [position, setPosition] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uploadNotice, setUploadNotice] = useState("");
  const [recovery, setRecovery] = useState(0);
  const identity = useRef({ id, userId, visible, enabled, mounted: true });
  const operation = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const banner = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const drag = useRef<{ y: number; position: number; height: number } | undefined>(undefined);
  const revalidate = useRef(onRevalidate);
  revalidate.current = onRevalidate;
  useLayoutEffect(() => {
    identity.current = { id, userId, visible, enabled, mounted: true };
    return () => { identity.current.mounted = false; operation.current++; };
  }, [id, userId, visible, enabled]);
  const sameContext = useCallback(() => identity.current.mounted && identity.current.visible && identity.current.id === id && identity.current.userId === userId, [id, userId]);
  const valid = (run: number) => sameContext() && identity.current.enabled && operation.current === run;
  const accept = useCallback((next: Cover) => {
    // A delayed poll must not overwrite a newer server revision.
    if (coverRef.current && next.revision < coverRef.current.revision) return;
    coverRef.current = next;
    setCover(next);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const value = parseDocumentCover(await documentCoverApi.get(id));
      if (sameContext() && value) { accept(value); setRecovery((n) => n + 1); }
    } catch (e) {
      if (sameContext() && e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        coverRef.current = undefined; setCover(undefined); revalidate.current();
      }
    }
  }, [accept, id, sameContext]);
  useEffect(() => {
    if (!visible) { coverRef.current = undefined; setCover(undefined); setOpen(false); setAdjusting(false); return; }
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 15000);
    const visibility = () => { if (document.visibilityState !== "hidden") void refresh(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [visible, refresh]);
  useEffect(() => {
    if (!enabled) { operation.current++; setOpen(false); setAdjusting(false); setBusy(false); }
  }, [enabled]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => closeButton.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); operation.current++; setOpen(false); setAdjusting(false); setBusy(false); requestAnimationFrame(() => trigger.current?.focus()); }
    };
    const pointer = (event: MouseEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node) && !(adjusting && banner.current?.contains(event.target as Node))) { operation.current++; setOpen(false); setAdjusting(false); setBusy(false); } };
    document.addEventListener("keydown", key); document.addEventListener("mousedown", pointer);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("mousedown", pointer); };
  }, [open, adjusting]);

  const save = async (choice: CoverChoice, previous: Cover, run: number) => {
    let sent = false;
    try {
      const result = await changeDocumentCover(id, previous, choice, () => valid(run), undefined, undefined, (next, revision) => { sent = true; return documentCoverApi.set(id, next, revision); });
      if (valid(run) && result) { accept(result); setPosition(result.position); }
      if (valid(run) && !result) onRevalidate();
    } finally {
      // A write can commit after closing the panel; only revalidate the same document/account.
      if (sent && !valid(run) && sameContext()) { void refresh(); onRevalidate(); }
    }
  };
  const begin = async () => {
    if (!enabled || busy) return;
    const run = ++operation.current;
    setOpen(true); setBusy(true); setError("");
    try {
      const meta = await docsApi.get(id);
      if (!valid(run)) return;
      if (meta.id !== id || (meta.role !== "edit" && meta.role !== "manage")) throw new ApiError(403, "forbidden", "当前没有编辑权限");
      const latest = parseDocumentCover(await documentCoverApi.get(id));
      if (!valid(run)) return;
      if (!latest) throw new Error("响应无效");
      accept(latest); setPosition(latest.position);
      // Feishu applies an initial gallery cover when the entry is clicked.
      if (latest.kind === "none") await save({ kind: "builtin", asset: COVER_GALLERY[0].id, position: 0.5 }, latest, run);
    } catch (e) { if (valid(run)) { setError(errorMessage(e)); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) onRevalidate(); } }
    finally { if (valid(run)) setBusy(false); }
  };
  const choose = async (next: CoverChoice) => {
    if (!enabled || busy || !coverRef.current) return;
    const run = ++operation.current, previous = coverRef.current;
    setBusy(true); setError(""); setUploadNotice("");
    try { await save(next, previous, run); if (valid(run)) setAdjusting(false); }
    catch (e) { if (valid(run)) { setError(errorMessage(e)); void refresh(); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) onRevalidate(); } }
    finally { if (valid(run)) setBusy(false); }
  };
  const upload = async (file: File | undefined) => {
    if (!file || !enabled || busy || !coverRef.current) return;
    if (!/^(image\/jpeg|image\/png|image\/gif)$/.test(file.type) || file.size > 20 * 1024 * 1024) { setError("请选择不超过 20 MB 的 JPG、PNG 或 GIF 图片。"); return; }
    const run = ++operation.current, previous = coverRef.current;
    setBusy(true); setError(""); setUploadNotice(""); let uploaded = false;
    try {
      const meta = await docsApi.get(id);
      if (!valid(run)) return;
      if (meta.id !== id || (meta.role !== "edit" && meta.role !== "manage")) throw new ApiError(403, "forbidden", "当前没有编辑权限");
      const latest = parseDocumentCover(await documentCoverApi.get(id));
      if (!valid(run)) return;
      if (!latest || latest.revision !== previous.revision) throw new ApiError(409, "cover_conflict", "封面已变化");
      const result = await docsApi.upload(id, file); uploaded = true;
      if (!valid(run)) { if (sameContext()) setUploadNotice("图片已上传，但未确认是否设置为封面；请重新验证。"); return; }
      if (!Number.isSafeInteger(result.id) || result.id <= 0) throw new Error("上传响应无效");
      await save({ kind: "file", fileId: result.id, position: 0.5 }, previous, run);
      if (valid(run)) setAdjusting(false);
    } catch (e) { if (valid(run)) { setError(errorMessage(e)); if (uploaded) setUploadNotice("图片已上传，但未确认是否设置为封面；请重新验证。"); void refresh(); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) onRevalidate(); } }
    finally { if (valid(run)) setBusy(false); }
  };
  const shown = visible ? cover : undefined;
  const image = shown && shown.kind !== "none" ? coverImageURL(shown, id) : undefined;
  const hasCover = !!shown && shown.kind !== "none";
  const applyDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setPosition(Math.max(0, Math.min(1, drag.current.position - (event.clientY - drag.current.y) / drag.current.height)));
  };
  const addButton = enabled && shown?.kind === "none" ? <button ref={trigger} type="button" aria-label="添加封面" onClick={() => void begin()} disabled={busy} className={`absolute -top-9 ${hasIcon ? "left-0" : "left-[92px]"} inline-flex h-7 items-center gap-1 rounded px-1.5 text-[13px] text-subtle opacity-0 hover:bg-hover group-hover/doc-cover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 disabled:opacity-50`}><ImagePlus size={14}/>添加封面</button> : null;
  return <>
    {shown && shown.kind !== "none" && <div ref={banner} data-document-print-restricted={!allowPrint ? "true" : undefined} onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }} onContextMenu={(event) => { if (!allowCopy || !allowPrint) event.preventDefault(); }} className="group/cover relative h-36 w-full overflow-hidden bg-sidebar sm:h-52" onPointerDown={(event) => { if (!adjusting) return; drag.current = { y: event.clientY, position, height: Math.max(1, event.currentTarget.clientHeight) }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={applyDrag} onPointerUp={() => { drag.current = undefined; }}>
      {image ? <CoverImage cover={adjusting ? { ...shown, position } : shown} docId={id} recovery={recovery}/> : <span role="status" className="absolute inset-0 grid place-items-center text-[12px] text-muted-foreground">当前封面暂不可显示，可选择其他封面。</span>}
      {adjusting && <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/10 text-[13px] text-white">拖动调整图片位置</div>}
      {enabled && !adjusting && <button ref={trigger} type="button" onClick={() => void begin()} className="absolute bottom-3 right-4 rounded-md bg-white/90 px-3 py-1.5 text-[13px] text-foreground opacity-0 shadow-sm hover:bg-white focus-visible:opacity-100 group-hover/cover:opacity-100 [@media(hover:none)]:opacity-100">编辑封面</button>}
    </div>}
    {children({ addButton, hasCover })}
    {!open && uploadNotice && <p role="status" className="mx-auto max-w-[960px] px-7 pb-4 text-[12px] text-muted-foreground sm:px-16">{uploadNotice}</p>}
    {open && enabled && <div ref={panel} role="dialog" aria-label="编辑文档封面" className="fixed left-1/2 top-1/2 z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border bg-surface text-foreground shadow-xl">
      <div className="flex h-12 items-center justify-between border-b px-4"><span className="text-[15px] font-medium">编辑封面</span><button ref={closeButton} type="button" aria-label="关闭封面设置" onClick={() => { operation.current++; setOpen(false); setAdjusting(false); setBusy(false); requestAnimationFrame(() => trigger.current?.focus()); }} className="rounded p-1 text-subtle hover:bg-hover"><X size={16}/></button></div>
      <div className="max-h-[min(65vh,480px)] overflow-y-auto p-4">
        <div className="mb-3 flex items-center justify-between gap-3"><span className="text-[13px] font-medium">图库</span><label className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2.5 py-1.5 text-[13px] hover:bg-hover"><Upload size={14}/>本地上传<input ref={fileInput} aria-label="本地上传封面" type="file" accept="image/jpeg,image/png,image/gif" disabled={busy} className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void upload(file); }}/></label></div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{COVER_GALLERY.map((item) => <button type="button" key={item.id} aria-label={`选择${item.label}封面`} disabled={busy || !cover} onClick={() => void choose({ kind: "builtin", asset: item.id, position: 0.5 })} className="overflow-hidden rounded-md border text-left hover:border-primary disabled:opacity-50"><img src={item.src} alt="" className="h-16 w-full object-cover"/><span className="block px-2 py-1 text-[12px]">{item.label}</span></button>)}</div>
        {shown && shown.kind !== "none" && <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3"><button type="button" disabled={busy || !image} onClick={() => { setPosition(shown.position); setAdjusting(true); }} className="rounded-md border px-2.5 py-1.5 text-[13px] hover:bg-hover disabled:opacity-50">调整位置</button><button type="button" disabled={busy} onClick={() => void choose({ kind: "none", position: 0.5 })} className="rounded-md border px-2.5 py-1.5 text-[13px] text-muted-foreground hover:bg-hover disabled:opacity-50">移除封面</button></div>}
        {adjusting && shown && shown.kind !== "none" && <div className="mt-3"><label className="block text-[12px] text-muted-foreground" htmlFor="cover-position">图片位置</label><input id="cover-position" type="range" min="0" max="100" value={Math.round(position * 100)} onChange={(event) => setPosition(Number(event.target.value) / 100)} className="mt-2 w-full"/><div className="mt-2 flex gap-2"><button type="button" disabled={busy} onClick={() => void choose({ ...coverChoice(shown), position })} className="rounded-md bg-primary px-3 py-1.5 text-[13px] text-white disabled:opacity-50">确认</button><button type="button" disabled={busy} onClick={() => { setPosition(shown.position); setAdjusting(false); }} className="rounded-md border px-3 py-1.5 text-[13px]">取消</button></div></div>}
        {busy && <p role="status" className="mt-3 text-[12px] text-subtle">正在验证封面设置…</p>}
        {error && <p role="alert" className="mt-3 text-[12px] text-destructive">{error} <button type="button" onClick={() => void begin()} className="underline">重新验证</button></p>}
        {uploadNotice && <p role="status" className="mt-2 text-[12px] text-muted-foreground">{uploadNotice}</p>}
      </div>
    </div>}
  </>;
}
