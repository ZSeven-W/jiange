import { useEffect, useRef, useState } from "react";
import { api, type Me } from "@/lib/api";
import { subscribeAuthChanges } from "@/lib/sessionCache";
import type { CommentAttemptStore } from "./commentAttempts";

type OwnText = { mutationId: string; body: string; parentId?: number };

/** Revalidate the signed-in account before reading its local submission
 * journal. Document quotes and anchor coordinates never leave this helper. */
export async function recoverOwnCommentText(store: CommentAttemptStore, userId: number, getMe: () => Promise<Me> = api.me): Promise<{ text: OwnText[]; damaged: number }> {
  if (!store.belongsTo(userId)) throw new Error("账号已变化");
  const me = await getMe();
  if (!me?.user || me.user.id !== userId) throw new Error("账号已变化");
  const values = store.list();
  return { text: values.attempts.map((attempt) => ({ mutationId: attempt.mutationId, body: attempt.payload.body, ...(attempt.payload.parentId ? { parentId: attempt.payload.parentId } : {}) })), damaged: values.damaged };
}

/** This deliberately does not delete or rewrite the original attempts. */
export function CommentAttemptRecovery({ store, userId }: { store: CommentAttemptStore | null; userId: number }) {
  const [values, setValues] = useState<OwnText[] | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const epoch = useRef(0);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    const hide = () => { epoch.current++; setValues(null); setMessage(""); setLoading(false); };
    const unsubscribe = subscribeAuthChanges(hide);
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { alive.current = false; epoch.current++; unsubscribe(); document.removeEventListener("visibilitychange", visibility); };
  }, [store, userId]);
  const show = async () => {
    if (!store || loading) return;
    const request = ++epoch.current;
    setValues(null); setMessage(""); setLoading(true);
    try {
      const result = await recoverOwnCommentText(store, userId);
      if (!alive.current || request !== epoch.current || document.visibilityState === "hidden") return;
      setValues(result.text);
      if (result.damaged) setMessage(`${result.damaged} 条本机记录损坏，原始数据已保留，无法安全读取。`);
      else if (!result.text.length) setMessage("没有可读取的未确认评论记录。");
    } catch {
      if (alive.current && request === epoch.current) setMessage("无法验证当前账号或读取本机记录，请联网并切回原账号后重试。");
    } finally { if (alive.current && request === epoch.current) setLoading(false); }
  };
  return <div className="mt-3 text-left text-[13px]">
    <button type="button" className="text-primary underline disabled:opacity-50" disabled={!store || loading} onClick={() => void show()}>{loading ? "正在验证账号…" : "查看本机未确认评论"}</button>
    {message && <p role="status" className="mt-1">{message}</p>}
    {values && values.length > 0 && <div className="mt-2 rounded-md border p-2">
      <p>仅显示你输入的文字；原始提交记录仍保留，发送结果可能尚未确认。</p>
      {values.map((value) => <div key={value.mutationId} className="mt-2">
        {value.parentId && <p>回复所属评论 #{value.parentId}</p>}
        <textarea readOnly value={value.body} aria-label="本机未确认评论文字" rows={2} className="mt-1 w-full rounded border p-1 text-foreground" />
      </div>)}
    </div>}
  </div>;
}
