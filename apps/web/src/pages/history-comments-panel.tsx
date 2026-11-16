import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Info, X } from "lucide-react";
import { commentsApi, type Comment, type User } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { commentListKey } from "./comment-access";
import { classifyCommentMutationError, CommentAuthor, CommentBody, reconcileUncertainComment } from "./comments-panel";

/** A separate history surface; the source of truth remains the live comment list. */
export function HistoryCommentsPanel({ id, userId, session, comments, members, canSubmit, allowCopy, allowPrint, onClose, onAccessDenied, onPolicyDenied }: {
  id: number; userId: number; session: number; comments: Comment[]; members: User[];
  canSubmit: boolean; allowCopy: boolean; allowPrint: boolean;
  onClose: () => void; onAccessDenied: () => void; onPolicyDenied: () => void;
}) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const panel = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose), outsideRef = useRef(onClose), live = useRef(false), busy = useRef(false);
  outsideRef.current = onClose;
  closeRef.current = () => {
    const previous = document.activeElement;
    onClose();
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== previous && active !== document.body && active !== document.documentElement) return;
      document.querySelector<HTMLButtonElement>("[data-more-menu]")?.focus({ preventScroll: true });
    });
  };
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const threads = useMemo(() => comments.filter((c) => !c.parentId && c.resolved), [comments]);
  const replies = useMemo(() => {
    const map = new Map<number, Comment[]>();
    for (const c of comments) if (c.parentId) map.set(c.parentId, [...(map.get(c.parentId) ?? []), c]);
    return map;
  }, [comments]);
  useEffect(() => {
    live.current = true;
    close.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); closeRef.current(); } };
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) outsideRef.current(); };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => { live.current = false; document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside); };
  }, []);
  const reopen = async (thread: Comment) => {
    if (!canSubmit || busy.current || uncertain) return;
    busy.current = true; setPending(thread.id); setError("");
    const invalidate = () => qc.invalidateQueries({ queryKey: commentListKey(id, userId, session) });
    try {
      await commentsApi.updateForAccount(id, thread.id, userId, { resolved: false });
      await invalidate();
    } catch (e) {
      if (!live.current) return;
      const kind = classifyCommentMutationError(e);
      if (kind === "access") onAccessDenied();
      else if (kind === "policy") { onPolicyDenied(); setError(t("评论权限已变化，请查看最新权限。")); }
      else if (kind === "uncertain") { setUncertain(true); setError(reconcileUncertainComment(invalidate, false)); }
      else setError(t("操作未被接受，请检查后重试。"));
    } finally { busy.current = false; if (live.current) setPending(null); }
  };
  return <aside ref={panel} role="dialog" aria-label={t("历史评论")} className="fixed right-3 top-12 z-50 flex h-[min(492px,calc(100dvh-60px))] w-[min(360px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-[#dee0e3] bg-surface shadow-[0_6px_24px_rgba(31,35,41,0.16)] sm:right-[74px]" data-comment-history>
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 text-[16px] font-medium">{t("历史评论")} <Info size={15} className="text-subtle" aria-label={t("已解决的评论")}/><button ref={close} type="button" onClick={() => closeRef.current()} aria-label={t("关闭历史评论")} className="ml-auto grid size-8 place-items-center rounded text-subtle hover:bg-hover"><X size={16}/></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {error && <p role="alert" className="mb-3 text-[13px] text-destructive">{error}</p>}
      {threads.length === 0 ? <div className="flex h-full flex-col items-center justify-center gap-5 text-[14px] text-subtle"><svg width="120" height="112" viewBox="0 0 120 112" fill="none" aria-hidden="true"><path d="M17 37c0-13 24-23 52-23v7c-24 0-43 7-43 16s19 16 43 16c12 0 23-2 31-6v8c-8 4-19 6-31 6-28 0-52-11-52-24Z" fill="#55CBB6"/><path d="M39 33h58v55H39z" fill="#E7E9EC"/><path d="M47 44h40M47 53h29" stroke="#A3A9B2" strokeWidth="2"/><path d="M23 72h37v21H33l-10 7V72Z" fill="white" stroke="#344A77"/><circle cx="100" cy="32" r="11" fill="#426DF5"/><path d="M68 92c18 0 32-4 40-9v8c-9 6-24 9-40 9Z" fill="#426DF5"/></svg><span>{t("在这可查看所有已解决的评论")}</span></div> : threads.map((thread) => <article key={thread.id} className="mb-3 rounded-lg border p-3 text-[14px]" data-history-thread={thread.id}>
        {thread.quote && <div className="mb-3 truncate border-l-2 border-[#FFC60A] pl-2 text-[12px] text-subtle" data-document-print-restricted={!allowPrint ? "true" : undefined} onCopy={(e) => { if (!allowCopy) e.preventDefault(); }}>{thread.quote}</div>}
        <CommentAuthor name={thread.userName} userId={thread.userId} at={thread.createdAt}/><div className="mt-1 pl-8"><CommentBody c={thread} members={members}/></div>
        {(replies.get(thread.id) ?? []).map((reply) => <div key={reply.id} className="mt-3"><CommentAuthor name={reply.userName} userId={reply.userId} at={reply.createdAt}/><div className="mt-1 pl-8"><CommentBody c={reply} members={members}/></div></div>)}
        <div className="mt-3 flex justify-end"><button type="button" disabled={!canSubmit || uncertain || pending !== null} onClick={() => void reopen(thread)} className="rounded px-2 py-1 text-[12px] text-primary hover:bg-hover disabled:opacity-50">{t(pending === thread.id ? "正在重新打开…" : "重新打开")}</button></div>
      </article>)}
    </div>
  </aside>;
}
