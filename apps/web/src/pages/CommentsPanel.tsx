import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, commentsApi, type Comment, type User } from "@/lib/api";
import { scrollToCommentThread } from "@/editor/commentAnchor";
import { commentListKey, commentMembersKey, type SavedCommentDraft } from "./commentAccess";
import { isDocAccessDenied } from "./docMetaState";

export interface CommentAnchor {
  block: string;
  startChar: string;
  endChar: string;
  quote: string;
}

export type CommentRecovery = SavedCommentDraft;

export function sameCommentAnchor(a: CommentAnchor | null, b: CommentAnchor | null): boolean {
  return a === b || (!!a && !!b && a.block === b.block && a.startChar === b.startChar && a.endChar === b.endChar);
}

/** Authorization failures invalidate the whole visible comments session. */
export function notifyCommentAccessError(error: unknown, onAccessDenied: () => void): boolean {
  // A user can retain read access to the document and its comments while a
  // newer policy removes their permission to add or change comments.
  if (error instanceof ApiError && error.code === "comment_permission_denied") return false;
  if (!isDocAccessDenied(error)) return false;
  onAccessDenied();
  return true;
}

export function classifyCommentMutationError(error: unknown): "policy" | "access" | "rejected" | "uncertain" {
  if (error instanceof ApiError && error.code === "comment_permission_denied") return "policy";
  if (isDocAccessDenied(error)) return "access";
  // An explicit client error is a rejection; network failures and server
  // errors can occur after commit, so never claim the mutation failed.
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) return "rejected";
  return "uncertain";
}

/** A refresh can fail while offline; its request is not proof of a refresh. */
export function reconcileUncertainComment(refresh: () => Promise<unknown>, keepDraft: boolean): string {
  try { void refresh().catch(() => {}); } catch { /* Keep the original draft even if refresh cannot start. */ }
  return keepDraft
    ? "发送结果未确认，正在尝试刷新评论；草稿已保留，请联网核对后再决定是否重试。"
    : "操作结果未确认，正在尝试刷新评论；请联网核对后再决定是否重试。";
}

/** A new selection can arrive after the drawer and composer are already mounted. */
export function focusCommentDraft(input: HTMLTextAreaElement | null, fallback: HTMLElement | null, draft: CommentAnchor | null, posting: boolean): void {
  if (!draft) return;
  // A new selection can arrive while the previous comment is still posting.
  // Never leave focus in the editor when the textarea is temporarily disabled.
  const target = posting || !input || input.disabled ? fallback : input;
  if (!target) return;
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
  target.focus({ preventScroll: true });
}

/** Right drawer: comment threads for one doc, with composer, @人 and resolve. */
export function CommentsPanel({
  id,
  meId,
  session,
  canEdit,
  canSubmit = true,
  canManage,
  allowCopyQuote = true,
  allowPrintQuote = true,
  draft,
  onDraftSent,
  activeThread,
  onActivate,
  onClose,
  onAccessDenied,
  onPolicyDenied,
  recovery,
  onDismissRecovery,
  onSnapshot,
  onComposerSuspended,
}: {
  id: number;
  meId: number;
  session: number;
  canEdit: boolean;
  canSubmit?: boolean;
  canManage: boolean;
  allowCopyQuote?: boolean;
  allowPrintQuote?: boolean;
  draft: CommentAnchor | null;
  onDraftSent: (draft: CommentAnchor) => void;
  activeThread: number | null;
  onActivate: (id: number | null) => void;
  onClose: () => void;
  onAccessDenied: (draft?: CommentRecovery) => void;
  onPolicyDenied?: () => void;
  recovery?: CommentRecovery[];
  onDismissRecovery: () => void;
  onSnapshot: (draft: CommentRecovery) => void;
  onComposerSuspended: () => void;
}) {
  const qc = useQueryClient();
  const key = commentListKey(id, meId, session);
  const list = useQuery({ queryKey: key, queryFn: () => commentsApi.list(id) });
  const listRef = useRef<HTMLDivElement>(null);
  const members = useQuery({ queryKey: commentMembersKey(id, meId, session), queryFn: () => commentsApi.members(id) });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [actionError, setActionError] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const actionPendingRef = useRef(false);
  const runAction = async (action: () => Promise<unknown>) => {
    if (actionPendingRef.current || !canSubmit) return;
    actionPendingRef.current = true;
    setActionPending(true);
    setActionError("");
    try {
      await action();
      void invalidate();
    } catch (error) {
      const result = classifyCommentMutationError(error);
      if (result === "access") onAccessDenied();
      else if (result === "policy") { onPolicyDenied?.(); setActionError("评论权限已变化，请查看最新权限。"); }
      else if (result === "uncertain") setActionError(reconcileUncertainComment(invalidate, false));
      else setActionError("操作未被接受，请检查后重试。");
    } finally {
      actionPendingRef.current = false;
      setActionPending(false);
    }
  };
  useEffect(() => {
    if (draft) { if (replyTo !== null) onComposerSuspended(); setReplyTo(null); }
  }, [draft]);
  useEffect(() => {
    if (activeThread !== null && list.isSuccess) scrollToCommentThread(listRef.current, activeThread);
  }, [activeThread, id, list.isSuccess]);

  // A failed revalidation must not keep exposing stale cached comments.
  const comments = list.isSuccess ? list.data : [];
  const visibleMembers = members.isSuccess ? members.data : [];
  const threads = useMemo(() => comments.filter((c) => !c.parentId), [comments]);
  const replies = useMemo(() => {
    const m = new Map<number, Comment[]>();
    for (const c of comments) if (c.parentId) m.set(c.parentId, [...(m.get(c.parentId) ?? []), c]);
    return m;
  }, [comments]);

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-96 flex-col border-l bg-surface shadow-xl" data-comments-panel>
      <header className="flex h-[52px] shrink-0 items-center border-b px-4 text-[15px] font-semibold">
        评论
        <button className="ml-auto rounded p-1 text-subtle hover:bg-hover hover:text-foreground" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>
      <div ref={listRef} className="flex-1 overflow-y-auto p-3" data-comment-list>
        {!!recovery?.length && <div className="mb-3 rounded-lg border p-2 text-[12px] text-muted-foreground" role="status">
          <p>上次未发送的评论已保留，请复制后重新选择位置。</p>
          {recovery.map((item, index) => <div key={index}>
            {item.draft?.quote && <p className="mt-1 truncate" data-document-print-restricted={!allowPrintQuote ? "true" : undefined} onCopy={(event) => { if (!allowCopyQuote) event.preventDefault(); }}>原引用：{item.draft.quote}</p>}
            {item.parentId && <p className="mt-1">原回复所属评论 #{item.parentId}</p>}
            <textarea readOnly value={item.text} aria-label="未发送的评论内容" rows={2} className="mt-1 w-full resize-none rounded border p-1 text-foreground" />
          </div>)}
          <button type="button" className="mt-1 text-primary" onClick={onDismissRecovery}>已复制，清除恢复记录</button>
        </div>}
        {canEdit && <Composer id={id} meId={meId} members={visibleMembers} draft={draft} canSubmit={canSubmit} allowCopyQuote={allowCopyQuote} allowPrintQuote={allowPrintQuote} onSnapshot={onSnapshot} onAccessDenied={onAccessDenied} onPolicyDenied={onPolicyDenied} onUncertain={invalidate} onDone={(sent) => { if (sent) onDraftSent(sent); void invalidate(); }} />}
        {actionError && <p role="alert" className="mb-3 text-[13px] text-destructive">{actionError}</p>}
        {list.isError && <p role="alert" className="mb-3 text-[13px] text-destructive">评论加载失败，请检查网络后重试。<button className="ml-2 underline" onClick={() => void list.refetch()}>重试</button></p>}
        {list.isSuccess && threads.length === 0 && <p className="px-2 py-8 text-center text-[13px] text-subtle">{canEdit ? "还没有评论，可以在上方添加" : "还没有评论"}</p>}
        {threads.map((t) => (
          <div
            key={t.id}
            className={`mb-2 cursor-pointer rounded-lg border p-3 text-[13px] ${activeThread === t.id ? "border-primary" : ""} ${t.resolved ? "opacity-55" : ""}`}
            onClick={() => onActivate(activeThread === t.id ? null : t.id)}
            data-thread={t.id}
          >
            {t.quote && <div className="mb-2 border-l-2 border-[#F5B1E5] bg-[#FBF3FA] px-2 py-1 text-[12px] text-muted-foreground" data-document-print-restricted={!allowPrintQuote ? "true" : undefined} onCopy={(event) => { if (!allowCopyQuote) event.preventDefault(); }}>{t.quote}</div>}
            <CommentBody c={t} members={visibleMembers} />
            <div className="mt-1 flex items-center gap-2 text-[11px] text-subtle">
              {t.userName} · {new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              <span className="ml-auto flex items-center gap-2">
                {t.resolved && <span className="rounded bg-[#E1EAFF] px-1.5 py-0.5 font-medium text-primary">已解决</span>}
                {canEdit && (
                  <>
                    <button
                      className="hover:text-primary"
                      disabled={!canSubmit}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (replyTo !== null) onComposerSuspended();
                        setReplyTo(replyTo === t.id ? null : t.id);
                      }}
                    >
                      回复
                    </button>
                    <button
                      className="hover:text-primary"
                      disabled={actionPending || !canSubmit}
                      onClick={(e) => {
                        e.stopPropagation();
                        void runAction(() => commentsApi.update(id, t.id, { resolved: !t.resolved }));
                      }}
                    >
                      {t.resolved ? "重新打开" : "解决"}
                    </button>
                    {(t.userId === meId || canManage) && (
                      <button disabled={actionPending || !canSubmit} className="hover:text-destructive" onClick={(e) => { e.stopPropagation(); void runAction(() => commentsApi.remove(id, t.id)); }}>
                        删除
                      </button>
                    )}
                  </>
                )}
              </span>
            </div>
            {(replies.get(t.id) ?? []).map((rp) => (
              <div key={rp.id} className="mt-2 rounded-md bg-sidebar/70 p-2">
                <CommentBody c={rp} members={visibleMembers} />
                <div className="mt-1 flex items-center gap-2 text-[11px] text-subtle">
                  {rp.userName}
                  {canEdit && (rp.userId === meId || canManage) && (
                    <button disabled={actionPending || !canSubmit} className="ml-auto hover:text-destructive" onClick={(e) => { e.stopPropagation(); void runAction(() => commentsApi.remove(id, rp.id)); }}>
                      删除
                    </button>
                  )}
                </div>
              </div>
            ))}
            {replyTo === t.id && canEdit && (
              <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                <Composer id={id} meId={meId} members={visibleMembers} draft={null} parentId={t.id} canSubmit={canSubmit} onSnapshot={onSnapshot} onAccessDenied={onAccessDenied} onPolicyDenied={onPolicyDenied} onUncertain={invalidate} onDone={() => { setReplyTo(null); void invalidate(); }} onCancel={() => { onSnapshot({ text: "", draft: null, parentId: t.id }); setReplyTo(null); }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}

/** Renders a comment body with @人 highlighted. */
function CommentBody({ c, members }: { c: Comment; members: User[] }) {
  const parts = c.body.split(/(@[^\s@，。;；!！?？]+)/g).filter(Boolean);
  return (
    <p className="whitespace-pre-wrap">
      {parts.map((p, i) => {
        if (p.startsWith("@")) {
          const name = p.slice(1);
          const m = members.find((x) => x.name === name);
          return (
            <span key={i} className={m ? "rounded bg-accent px-0.5 font-medium text-primary" : ""}>
              {p}
            </span>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </p>
  );
}

/** Composer with @人 autocomplete. Enter posts, @ opens the member list. */
function Composer({
  id,
  meId,
  members,
  draft,
  canSubmit,
  allowCopyQuote = true,
  allowPrintQuote = true,
  parentId,
  onAccessDenied,
  onPolicyDenied,
  onUncertain,
  onSnapshot,
  onDone,
  onCancel,
}: {
  id: number;
  meId: number;
  members: User[];
  draft: CommentAnchor | null;
  canSubmit: boolean;
  allowCopyQuote?: boolean;
  allowPrintQuote?: boolean;
  parentId?: number;
  onAccessDenied: (draft?: CommentRecovery) => void;
  onPolicyDenied?: () => void;
  onUncertain: () => Promise<unknown>;
  onSnapshot: (draft: CommentRecovery) => void;
  onDone: (draft: CommentAnchor | null) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const [textOrigin, setTextOrigin] = useState<CommentAnchor | null>(draft);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const postingRef = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!parentId) focusCommentDraft(ref.current, composerRef.current, draft, posting);
  }, [draft, parentId, posting]);
  const atIdx = text.lastIndexOf("@");
  const query = atIdx >= 0 ? text.slice(atIdx + 1) : null;
  const matches = query !== null ? members.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()) && m.id !== meId).slice(0, 5) : [];
  const originChanged = !parentId && !!text.trim() && !sameCommentAnchor(textOrigin, draft);
  const changeText = (value: string) => {
    const origin = !text ? draft : textOrigin;
    if (!text) setTextOrigin(origin);
    setText(value);
    onSnapshot({ text: value, draft: origin, parentId });
  };

  const post = async () => {
    const body = text.trim();
    if (!body || postingRef.current || originChanged || !canSubmit) return;
    postingRef.current = true;
    setPosting(true);
    setError("");
    const mentioned = members.filter((m) => body.includes("@" + m.name)).map((m) => m.id);
    try {
      if (parentId) await commentsApi.create(id, { parentId, body, mentions: mentioned });
      else await commentsApi.create(id, { body, mentions: mentioned, ...(draft ?? {}) });
      setText("");
      setTextOrigin(draft);
      onSnapshot({ text: "", draft: textOrigin, parentId });
      onDone(draft);
    } catch (error) {
      const result = classifyCommentMutationError(error);
      if (result === "access") onAccessDenied({ text, draft: textOrigin, parentId });
      else if (result === "policy") { onPolicyDenied?.(); setError("评论权限已变化，草稿已保留。"); }
      else if (result === "uncertain") setError(reconcileUncertainComment(onUncertain, true));
      else setError("评论未被接受，草稿已保留，请检查后重试。");
    } finally {
      postingRef.current = false;
      setPosting(false);
    }
  };
  return (
    <div ref={composerRef} tabIndex={-1} className="mb-3 rounded-lg border p-2 focus-within:border-primary" data-comment-composer>
      {draft?.quote && !parentId && <div className="mb-1.5 truncate border-l-2 border-[#F5B1E5] bg-[#FBF3FA] px-2 py-1 text-[12px] text-muted-foreground" data-document-print-restricted={!allowPrintQuote ? "true" : undefined} onCopy={(event) => { if (!allowCopyQuote) event.preventDefault(); }}>{draft.quote}</div>}
      {posting && <p role="status" className="mb-1 text-[12px] text-muted-foreground">上一条评论正在发送，请稍候。</p>}
      {!canSubmit && <p role="status" className="mb-1 text-[12px] text-muted-foreground">正在验证评论权限，草稿仍可编辑。</p>}
      {originChanged && <p role="alert" className="mb-1 text-[12px] text-muted-foreground">未发送的文字属于之前的选区。 <button type="button" className="text-primary underline" onClick={() => { setTextOrigin(draft); onSnapshot({ text, draft, parentId }); }}>用于当前选区</button></p>}
      <textarea
        ref={ref}
        autoFocus={!!parentId}
        rows={2}
        value={text}
        disabled={posting}
        placeholder={parentId ? "回复…" : "添加评论，@ 提及他人"}
        className="w-full resize-none text-[13px] outline-none"
        onChange={(e) => changeText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void post();
          }
          if (e.key === "Escape" && onCancel) onCancel();
        }}
        data-comment-input
      />
      {error && <p role="alert" className="mt-1 text-[12px] text-destructive">{error}</p>}
      {matches.length > 0 && (
        <div className="rounded-md border bg-surface py-1 shadow-sm" data-at-menu>
          {matches.map((m) => (
            <button
              key={m.id}
              className="block w-full px-2 py-1 text-left text-[13px] hover:bg-hover"
              onClick={() => changeText(text.slice(0, atIdx + 1) + m.name + " ")}
            >
              @{m.name}
            </button>
          ))}
        </div>
      )}
      <div className="mt-1 flex items-center">
        <span className="text-[11px] text-subtle">Enter 发送，Shift+Enter 换行</span>
        <div className="ml-auto flex gap-2">
          {onCancel && (
            <button className="h-6 rounded border px-2 text-[12px]" onClick={onCancel}>
              取消
            </button>
          )}
          <button className="h-6 rounded bg-primary px-2.5 text-[12px] text-white disabled:opacity-50" disabled={!text.trim() || posting || originChanged || !canSubmit} onClick={() => void post()} data-comment-send>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
