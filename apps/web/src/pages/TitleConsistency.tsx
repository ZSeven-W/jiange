import { useEffect, useRef, useState } from "react";

export interface TitleConsistencySnapshot {
  directoryTitle: string;
  documentTitle: string;
  head: number;
  differs: boolean;
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
      const response = await send(`/api/docs/${id}/title-consistency`, { method: "GET", credentials: "same-origin", cache: "no-store", signal: current.signal });
      if (!isCurrent()) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        update({ status: "denied" });
        onAccessDenied();
        return;
      }
      if (!response.ok) throw new Error("title consistency unavailable");
      const value: unknown = await response.json();
      if (!isCurrent()) return;
      if (!value || typeof value !== "object") throw new Error("invalid title snapshot");
      const snapshot = value as Partial<TitleConsistencySnapshot>;
      if (typeof snapshot.directoryTitle !== "string" || typeof snapshot.documentTitle !== "string" || typeof snapshot.differs !== "boolean" || !Number.isSafeInteger(snapshot.head) || (snapshot.head as number) < 0 || snapshot.differs !== (snapshot.directoryTitle !== snapshot.documentTitle)) throw new Error("invalid title snapshot");
      update({ status: "ready", snapshot: snapshot as TitleConsistencySnapshot });
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

/** Explicit, read-only snapshot; no title is selected or changed by this panel. */
export function TitleConsistency({ id, allowCopy, allowPrint = true, onClose, onAccessDenied }: { id: number; allowCopy: boolean; allowPrint?: boolean; onClose: () => void; onAccessDenied: () => void }) {
  const [state, setState] = useState<CheckState>({ status: "loading" });
  const [copyNotice, setCopyNotice] = useState("");
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
    return () => { active.current = false; check.current = null; window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); next.dispose(); };
  }, [id]);
  const copy = async (text: string) => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (active.current) setCopyNotice("已复制。");
    } catch { if (active.current) setCopyNotice("复制失败，请手动选择文字。"); }
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
        <p className="text-xs text-subtle">这是检查时的结果，之后的修改可能改变名称。本操作不会修改文档。</p>
        {copyNotice && <p role="status" className="text-xs text-muted-foreground">{copyNotice}</p>}
      </div>}
      {state.status !== "loading" && state.status !== "denied" && <button type="button" className="mt-5 rounded-md border px-3 py-1.5 text-sm hover:bg-hover" onClick={() => { setCopyNotice(""); void check.current?.run(); }}>重新检查</button>}
    </section>
  </div>;
}
