import { useEffect, useRef, useState } from "react";

export interface TitleConsistencySnapshot {
  directoryTitle: string;
  documentTitle: string;
  head: number;
  historyEpoch?: number;
  differs: boolean;
}

export function parseTitleConsistency(value: unknown): TitleConsistencySnapshot {
  if (!value || typeof value !== "object") throw new Error("invalid title snapshot");
  const snapshot = value as Partial<TitleConsistencySnapshot>;
  if (typeof snapshot.directoryTitle !== "string" || typeof snapshot.documentTitle !== "string" || typeof snapshot.differs !== "boolean" || !Number.isSafeInteger(snapshot.head) || (snapshot.head as number) < 0 || (snapshot.historyEpoch !== undefined && (!Number.isSafeInteger(snapshot.historyEpoch) || snapshot.historyEpoch < 1)) || snapshot.differs !== (snapshot.directoryTitle !== snapshot.documentTitle)) throw new Error("invalid title snapshot");
  return snapshot as TitleConsistencySnapshot;
}

type CheckState =
  | { status: "loading" }
  | { status: "ready"; snapshot: TitleConsistencySnapshot }
  | { status: "denied" }
  | { status: "error" };

/** A result belongs only to the request which produced it, never a later document or account. */
export function createTitleConsistencyCheck(
  id: number,
  update: (state: CheckState) => void,
  onAccessDenied: () => void,
  send: typeof fetch = fetch,
) {
  let controller: AbortController | null = null;
  let generation = 0;
  let disposed = false;
  const run = async () => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const token = ++generation;
    const isCurrent = () => !disposed && !current.signal.aborted && token === generation;
    update({ status: "loading" });
    try {
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        response = await send(`/api/docs/${id}/title-consistency`, { method: "GET", credentials: "same-origin", cache: "no-store", signal: current.signal });
        if (!isCurrent()) return;
        const busy = response.status === 503 && (await response.clone().json().catch(() => null))?.error === "title_check_busy";
        if (!busy || attempt >= 2) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        if (!isCurrent()) return;
      }
      if (!isCurrent()) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        update({ status: "denied" });
        onAccessDenied();
        return;
      }
      if (!response.ok) throw new Error("title consistency unavailable");
      const value: unknown = await response.json();
      if (!isCurrent()) return;
      update({ status: "ready", snapshot: parseTitleConsistency(value) });
    } catch {
      if (isCurrent()) update({ status: "error" });
    }
  };
  return {
    run,
    pause: () => { generation++; controller?.abort(); if (!disposed) update({ status: "loading" }); },
    dispose: () => { disposed = true; generation++; controller?.abort(); },
  };
}

/** The directory name changes only on an explicit, guarded user action. */
export function TitleConsistency({ id, userId, canEdit = false, allowCopy, allowPrint = true, onClose, onAccessDenied, onUpdated }: { id: number; userId?: number; canEdit?: boolean; allowCopy: boolean; allowPrint?: boolean; onClose: () => void; onAccessDenied: () => void; onUpdated?: (title: string) => void }) {
  const [state, setState] = useState<CheckState>({ status: "loading" });
  const [copyNotice, setCopyNotice] = useState("");
  const [repairing, setRepairing] = useState(false);
  const repair = useRef<AbortController | null>(null);
  const active = useRef(false);
  const denied = useRef(onAccessDenied);
  denied.current = onAccessDenied;
  const check = useRef<ReturnType<typeof createTitleConsistencyCheck> | null>(null);
  useEffect(() => {
    active.current = true;
    const next = createTitleConsistencyCheck(id, setState, () => denied.current());
    check.current = next;
    void next.run();
    // A stored result is not evidence of continuing access. Hide it whenever
    // the tab is backgrounded and revalidate while it remains open.
    const visibility = () => { if (document.visibilityState === "hidden") next.pause(); else void next.run(); };
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void next.run(); }, 30_000);
    document.addEventListener("visibilitychange", visibility);
    return () => { active.current = false; repair.current?.abort(); repair.current = null; check.current = null; window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); next.dispose(); };
  }, [id]);
  const copy = async (text: string) => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (active.current) setCopyNotice("已复制。");
    } catch { if (active.current) setCopyNotice("复制失败，请手动选择文字。"); }
  };
  const reconcile = async (snapshot: TitleConsistencySnapshot) => {
    if (!userId || !snapshot.historyEpoch || repair.current || !canEdit) return;
    const controller = new AbortController(); repair.current = controller; setRepairing(true); setCopyNotice("");
    try {
      const response = await fetch(`/api/docs/${id}/title-consistency`, { method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal, headers: { "Content-Type": "application/json", "X-Jiange-User-Id": String(userId) }, body: JSON.stringify({ historyEpoch: snapshot.historyEpoch, head: snapshot.head, directoryTitle: snapshot.directoryTitle, documentTitle: snapshot.documentTitle }) });
      if (!active.current || controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) { denied.current(); setCopyNotice("权限已变化，请重新检查。"); }
      else if (response.status === 409) setCopyNotice("文档或目录名称已变化，请重新检查。");
      else if (!response.ok) setCopyNotice("未能同步名称，请重新检查后重试。");
      else { setCopyNotice("已使用文档标题更新目录名称。"); onUpdated?.(snapshot.documentTitle); }
    } catch { if (active.current && !controller.signal.aborted) setCopyNotice("同步结果未确认，请重新检查后再操作。"); }
    finally { if (repair.current === controller) repair.current = null; if (active.current) { setRepairing(false); if (document.visibilityState !== "hidden") void check.current?.run(); } }
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="title-check-heading" className="w-full max-w-[480px] rounded-xl border bg-surface p-5 shadow-xl">
      <div className="flex items-center justify-between gap-3"><h2 id="title-check-heading" className="text-[16px] font-semibold">检查文档名称</h2><button type="button" aria-label="关闭" className="rounded px-2 py-1 text-muted-foreground hover:bg-hover" onClick={onClose}>×</button></div>
      {state.status === "loading" && <p role="status" className="mt-5 text-sm text-muted-foreground">正在检查…</p>}
      {state.status === "denied" && <p role="alert" className="mt-5 text-sm text-destructive">文档不存在或当前没有查看权限。</p>}
      {state.status === "error" && <p role="alert" className="mt-5 text-sm text-destructive">暂时无法检查文档名称，请稍后重试。</p>}
      {state.status === "ready" && <div className="mt-4 space-y-4 text-sm" data-document-print-restricted={!allowPrint ? "true" : undefined} onCopy={(event) => { if (!allowCopy) event.preventDefault(); }} onCut={(event) => { if (!allowCopy) event.preventDefault(); }}>
        <p className={state.snapshot.differs ? "text-amber-700" : "text-muted-foreground"}>{state.snapshot.differs ? "目录名称和文档标题不同，请核对。" : "目录名称和文档标题一致。"}</p>
        {([["目录名称", state.snapshot.directoryTitle], ["文档标题", state.snapshot.documentTitle]] as const).map(([label, text]) => <div key={label}>
          <div className="mb-1 flex items-center justify-between gap-3"><span className="text-muted-foreground">{label}</span>{allowCopy && <button type="button" onClick={() => void copy(text)} className="text-primary hover:underline">复制</button>}</div>
          <div className="min-h-10 whitespace-pre-wrap break-all rounded-md border bg-hover/30 px-3 py-2">{text || <span className="text-subtle">（空）</span>}</div>
        </div>)}
        <p className="text-xs text-subtle">这是检查时的结果，之后的修改可能改变名称。</p>
        {canEdit && userId && state.snapshot.differs && state.snapshot.historyEpoch && <>
          {(state.snapshot.documentTitle !== state.snapshot.documentTitle.trim() || [...state.snapshot.documentTitle].length > 200) && <p role="status" className="text-xs text-amber-700">请先移除文档标题首尾空白，并确保标题不超过 200 个字符。</p>}
          <button type="button" disabled={repairing || state.snapshot.documentTitle !== state.snapshot.documentTitle.trim() || [...state.snapshot.documentTitle].length > 200} onClick={() => void reconcile(state.snapshot)} className="rounded-md bg-primary px-3 py-1.5 text-white hover:opacity-90 disabled:opacity-50">{repairing ? "正在同步…" : "使用文档标题更新目录名称"}</button>
        </>}
        {copyNotice && <p role="status" className="text-xs text-muted-foreground">{copyNotice}</p>}
      </div>}
      {state.status !== "loading" && state.status !== "denied" && <button type="button" className="mt-5 rounded-md border px-3 py-1.5 text-sm hover:bg-hover" onClick={() => { setCopyNotice(""); void check.current?.run(); }}>重新检查</button>}
    </section>
  </div>;
}
