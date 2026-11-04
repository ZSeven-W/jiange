import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commentsApi, type Comment, type User } from "@/lib/api";

export interface CommentAnchor {
  block: string;
  startChar: string;
  endChar: string;
  quote: string;
}

/** Right drawer: comment threads for one doc, with composer, @人 and resolve. */
export function CommentsPanel({
  id,
  meId,
  canEdit,
  draft,
  activeThread,
  onActivate,
  onClose,
}: {
  id: number;
  meId: number;
  canEdit: boolean;
  draft: CommentAnchor | null;
  activeThread: number | null;
  onActivate: (id: number | null) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const key = ["comments", id];
  const list = useQuery({ queryKey: key, queryFn: () => commentsApi.list(id) });
  const members = useQuery({ queryKey: ["docmembers", id], queryFn: () => commentsApi.members(id) });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const [replyTo, setReplyTo] = useState<number | null>(null);
  useEffect(() => {
    if (draft) setReplyTo(null);
  }, [draft]);

  const comments = list.data ?? [];
  const threads = useMemo(() => comments.filter((c) => !c.parentId), [comments]);
  const replies = useMemo(() => {
    const m = new Map<number, Comment[]>();
    for (const c of comments) if (c.parentId) m.set(c.parentId, [...(m.get(c.parentId) ?? []), c]);
    return m;
  }, [comments]);

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-96 flex-col border-l bg-white shadow-xl" data-comments-panel>
      <header className="flex h-[52px] shrink-0 items-center border-b px-4 text-[15px] font-semibold">
        评论
        <button className="ml-auto rounded p-1 text-subtle hover:bg-hover hover:text-foreground" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3" data-comment-list>
        {canEdit && <Composer id={id} meId={meId} members={members.data ?? []} draft={draft} onDone={invalidate} />}
        {threads.length === 0 && <p className="px-2 py-8 text-center text-[13px] text-subtle">选中文本即可添加评论</p>}
        {threads.map((t) => (
          <div
            key={t.id}
            className={`mb-2 cursor-pointer rounded-lg border p-3 text-[13px] ${activeThread === t.id ? "border-primary" : ""} ${t.resolved ? "opacity-55" : ""}`}
            onClick={() => onActivate(activeThread === t.id ? null : t.id)}
            data-thread={t.id}
          >
            {t.quote && <div className="mb-2 border-l-2 border-[#F5B1E5] bg-[#FBF3FA] px-2 py-1 text-[12px] text-muted-foreground">{t.quote}</div>}
            <CommentBody c={t} members={members.data ?? []} />
            <div className="mt-1 flex items-center gap-2 text-[11px] text-subtle">
              {t.userName} · {new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              <span className="ml-auto flex items-center gap-2">
                {t.resolved && <span className="rounded bg-[#E1EAFF] px-1.5 py-0.5 font-medium text-primary">已解决</span>}
                {canEdit && (
                  <>
                    <button
                      className="hover:text-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        setReplyTo(replyTo === t.id ? null : t.id);
                      }}
                    >
                      回复
                    </button>
                    <button
                      className="hover:text-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        commentsApi.update(id, t.id, { resolved: !t.resolved }).then(invalidate);
                      }}
                    >
                      {t.resolved ? "重新打开" : "解决"}
                    </button>
                    {(t.userId === meId) && (
                      <button className="hover:text-destructive" onClick={(e) => { e.stopPropagation(); commentsApi.remove(id, t.id).then(invalidate); }}>
                        删除
                      </button>
                    )}
                  </>
                )}
              </span>
            </div>
            {(replies.get(t.id) ?? []).map((rp) => (
              <div key={rp.id} className="mt-2 rounded-md bg-sidebar/70 p-2">
                <CommentBody c={rp} members={members.data ?? []} />
                <div className="mt-1 flex items-center gap-2 text-[11px] text-subtle">
                  {rp.userName}
                  {(rp.userId === meId) && (
                    <button className="ml-auto hover:text-destructive" onClick={(e) => { e.stopPropagation(); commentsApi.remove(id, rp.id).then(invalidate); }}>
                      删除
                    </button>
                  )}
                </div>
              </div>
            ))}
            {replyTo === t.id && canEdit && (
              <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                <Composer id={id} meId={meId} members={members.data ?? []} draft={null} parentId={t.id} onDone={() => { setReplyTo(null); invalidate(); }} onCancel={() => setReplyTo(null)} />
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
  parentId,
  onDone,
  onCancel,
}: {
  id: number;
  meId: number;
  members: User[];
  draft: CommentAnchor | null;
  parentId?: number;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const atIdx = text.lastIndexOf("@");
  const query = atIdx >= 0 ? text.slice(atIdx + 1) : null;
  const matches = query !== null ? members.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()) && m.id !== meId).slice(0, 5) : [];

  const post = async () => {
    const body = text.trim();
    if (!body || posting) return;
    setPosting(true);
    const mentioned = members.filter((m) => body.includes("@" + m.name)).map((m) => m.id);
    try {
      if (parentId) await commentsApi.create(id, { parentId, body, mentions: mentioned });
      else await commentsApi.create(id, { body, mentions: mentioned, ...(draft ?? {}) });
      setText("");
      onDone();
    } finally {
      setPosting(false);
    }
  };
  return (
    <div className="mb-3 rounded-lg border p-2 focus-within:border-primary" data-comment-composer>
      {draft?.quote && !parentId && <div className="mb-1.5 truncate border-l-2 border-[#F5B1E5] bg-[#FBF3FA] px-2 py-1 text-[12px] text-muted-foreground">{draft.quote}</div>}
      <textarea
        ref={ref}
        autoFocus
        rows={2}
        value={text}
        placeholder={parentId ? "回复…" : "添加评论，@ 提及他人"}
        className="w-full resize-none text-[13px] outline-none"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void post();
          }
          if (e.key === "Escape" && onCancel) onCancel();
        }}
        data-comment-input
      />
      {matches.length > 0 && (
        <div className="rounded-md border bg-white py-1 shadow-sm" data-at-menu>
          {matches.map((m) => (
            <button
              key={m.id}
              className="block w-full px-2 py-1 text-left text-[13px] hover:bg-hover"
              onClick={() => setText(text.slice(0, atIdx + 1) + m.name + " ")}
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
          <button className="h-6 rounded bg-primary px-2.5 text-[12px] text-white disabled:opacity-50" disabled={!text.trim() || posting} onClick={() => void post()} data-comment-send>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
