import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { notificationsApi } from "@/lib/api";

const KIND_LABEL: Record<string, string> = { mention: "提到了你", reply: "回复了你", resolve: "解决了你的评论" };

/** Top bell with unread badge; clicking opens the notification center. */
export function NotificationBell({ onOpenDoc }: { onOpenDoc: (id: number) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ["notifications"], queryFn: notificationsApi.list, refetchInterval: 30000 });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const unread = q.data?.unread ?? 0;
  return (
    <div ref={ref} className="relative">
      <button className="relative grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground" onClick={() => setOpen((v) => !v)} aria-label="通知" data-bell>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 2a4 4 0 0 0-4 4v2.5L3 11h10l-1-2.5V6a4 4 0 0 0-4-4z" />
          <path d="M6.5 13a1.5 1.5 0 0 0 3 0" />
        </svg>
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-medium text-white" data-unread>{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-50 w-80 rounded-lg border bg-white shadow-lg" data-notification-panel>
          <div className="flex items-center border-b px-3 py-2 text-[13px] font-medium">
            通知
            {unread > 0 && (
              <button
                className="ml-auto text-[12px] font-normal text-primary hover:underline"
                onClick={() => notificationsApi.markRead().then(() => qc.invalidateQueries({ queryKey: ["notifications"] }))}
              >
                全部已读
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {(q.data?.notifications ?? []).length === 0 && <p className="py-8 text-center text-[13px] text-subtle">没有通知</p>}
            {(q.data?.notifications ?? []).map((n) => (
              <button
                key={n.id}
                className={`flex w-full flex-col items-start gap-0.5 border-b px-3 py-2.5 text-left text-[13px] last:border-b-0 hover:bg-hover ${n.read ? "opacity-60" : ""}`}
                onClick={() => {
                  if (!n.read) notificationsApi.markRead([n.id]).then(() => qc.invalidateQueries({ queryKey: ["notifications"] }));
                  setOpen(false);
                  onOpenDoc(n.docId);
                }}
                data-notification={n.id}
              >
                <span>
                  <span className="font-medium">{n.actorName || "有人"}</span> {KIND_LABEL[n.kind] ?? n.kind}
                  {n.docTitle && <span className="text-muted-foreground"> · {n.docTitle}</span>}
                </span>
                {n.preview && <span className="line-clamp-2 text-[12px] text-muted-foreground">{n.preview}</span>}
                <span className="text-[11px] text-subtle">{new Date(n.createdAt).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
