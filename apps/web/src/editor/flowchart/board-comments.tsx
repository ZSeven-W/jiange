import { useState } from "react";
import { CheckCircle2, MessageSquare, Send, X } from "lucide-react";
import type { Comment } from "@/lib/api";
import {
  parseFlowCommentAnchor,
  resolveFlowCommentPosition,
  type FlowCommentAnchor,
} from "@jiange/whiteboard-sdk/comment-anchor";
import type { FlowGraph } from "./model";

export interface BoardCommentActions {
  create: (input: { anchor: FlowCommentAnchor; quote: string; body: string }) => Promise<Comment | undefined>;
  reply: (parentId: number, body: string) => Promise<Comment | undefined>;
  resolve: (commentId: number) => Promise<void>;
}

export interface ResolvedBoardPin {
  index: number;
  root: Comment;
  replies: Comment[];
  anchor: FlowCommentAnchor;
  x: number;
  y: number;
  orphaned: boolean;
}

export function resolveBoardCommentPins(
  comments: readonly Comment[] | undefined,
  graph: FlowGraph,
  collapsed?: ReadonlySet<string>,
): ResolvedBoardPin[] {
  if (!comments?.length) return [];
  const repliesByParent = new Map<number, Comment[]>();
  const roots: { root: Comment; anchor: FlowCommentAnchor }[] = [];
  for (const c of comments) {
    if (c.parentId) {
      const list = repliesByParent.get(c.parentId);
      if (list) list.push(c);
      else repliesByParent.set(c.parentId, [c]);
      continue;
    }
    if (c.resolved) continue;
    const anchor = parseFlowCommentAnchor(c.startChar, c.endChar);
    if (!anchor) continue;
    roots.push({ root: c, anchor });
  }
  roots.sort((a, b) => a.root.id - b.root.id);
  return roots.map(({ root, anchor }, idx) => {
    const pos = resolveFlowCommentPosition(anchor, graph, collapsed);
    return {
      index: idx + 1,
      root,
      replies: (repliesByParent.get(root.id) ?? []).slice().sort((a, b) => a.id - b.id),
      anchor,
      x: pos.x,
      y: pos.y,
      orphaned: pos.orphaned,
    };
  });
}

export function BoardCommentPinsSvg({
  pins,
  activeId,
  zoom = 1,
  onSelect,
}: {
  pins: readonly ResolvedBoardPin[];
  activeId?: number | null;
  zoom?: number;
  onSelect?: (pin: ResolvedBoardPin, event: React.PointerEvent<SVGGElement>) => void;
}) {
  if (!pins.length) return null;
  const inv = 1 / Math.max(0.35, Math.min(2.5, zoom));
  return (
    <g data-flow-comment-pins>
      {pins.map((pin) => {
        const active = activeId === pin.root.id;
        return (
          <g
            key={pin.root.id}
            data-flow-comment-pin={pin.root.id}
            transform={`translate(${pin.x} ${pin.y}) scale(${inv})`}
            style={{ cursor: onSelect ? "pointer" : "default" }}
            onPointerDown={
              onSelect
                ? (event) => {
                    event.stopPropagation();
                    onSelect(pin, event);
                  }
                : undefined
            }
          >
            <circle
              cx={0}
              cy={-14}
              r={13}
              fill={active ? "#3370FF" : "#FF8800"}
              stroke="#FFFFFF"
              strokeWidth={2}
            />
            <polygon
              points="-5,-3 5,-3 0,4"
              fill={active ? "#3370FF" : "#FF8800"}
            />
            <text
              x={0}
              y={-10}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fill="#FFFFFF"
              pointerEvents="none"
            >
              {pin.index}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function clampPopoverPos(left: number, top: number, width: number, height: number) {
  const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const w = Math.min(width, vw - 16);
  const clampedLeft = Math.max(8, Math.min(vw - w - 8, left));
  const clampedTop = Math.max(56, Math.min(vh - height - 16, top));
  return { left: clampedLeft, top: clampedTop, width: w };
}

export function BoardCommentComposer({
  anchor,
  quote,
  screenX,
  screenY,
  onSubmit,
  onCancel,
}: {
  anchor: FlowCommentAnchor;
  quote: string;
  screenX: number;
  screenY: number;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pos = clampPopoverPos(screenX + 16, screenY - 12, 300, 190);

  const handleSend = async () => {
    const trimmed = body.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送评论失败，请重试");
      setSaving(false);
    }
  };

  const label =
    anchor.kind === "node"
      ? `图形评论：${quote}`
      : anchor.kind === "mind"
        ? `导图评论：${quote}`
        : `画布位置 (${anchor.x}, ${anchor.y})`;

  return (
    <div
      role="dialog"
      aria-label="添加画板评论"
      data-flow-comment-composer
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-[96] rounded-xl border border-[#DEE0E3] bg-surface p-3 shadow-[0_8px_28px_rgba(31,35,41,0.16)]"
      style={{ left: pos.left, top: pos.top, width: pos.width }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-[12px] font-medium text-[#FF8800]">
          <MessageSquare size={13} className="shrink-0" />
          <span className="truncate">{label}</span>
        </span>
        <button
          type="button"
          aria-label="关闭评论输入"
          onClick={onCancel}
          className="grid size-6 shrink-0 place-items-center rounded text-subtle hover:bg-hover"
        >
          <X size={14} />
        </button>
      </div>
      <textarea
        autoFocus
        rows={3}
        maxLength={2000}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void handleSend();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="输入评论内容（⌘/Ctrl + Enter 发送）"
        data-flow-comment-input
        className="w-full select-text resize-none rounded-md border border-[#DEE0E3] bg-background p-2 text-[13px] text-foreground outline-none focus:border-primary"
      />
      {error && <p className="mt-1 text-[12px] text-destructive">{error}</p>}
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-7 rounded-md border px-2.5 text-[12px] text-subtle hover:bg-hover"
        >
          取消
        </button>
        <button
          type="button"
          disabled={!body.trim() || saving}
          onClick={() => void handleSend()}
          data-flow-comment-submit
          className="flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-[12px] font-medium text-white hover:bg-primary/90 disabled:opacity-40"
        >
          <Send size={12} />
          {saving ? "发送中…" : "发送"}
        </button>
      </div>
    </div>
  );
}

export function BoardCommentThreadPopover({
  pin,
  screenX,
  screenY,
  canSubmit,
  onReply,
  onResolve,
  onClose,
}: {
  pin: ResolvedBoardPin;
  screenX: number;
  screenY: number;
  canSubmit: boolean;
  onReply?: (parentId: number, body: string) => Promise<void>;
  onResolve?: (commentId: number) => Promise<void>;
  onClose: () => void;
}) {
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pos = clampPopoverPos(screenX + 18, screenY - 24, 320, 280);

  const handleReply = async () => {
    const trimmed = replyText.trim();
    if (!trimmed || !onReply || busy) return;
    setBusy(true);
    setError("");
    try {
      await onReply(pin.root.id, trimmed);
      setReplyText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "回复失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const handleResolve = async () => {
    if (!onResolve || busy) return;
    setBusy(true);
    setError("");
    try {
      await onResolve(pin.root.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "解决评论失败，请重试");
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="画板评论详情"
      data-flow-comment-popover={pin.root.id}
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-[96] flex max-h-[min(420px,calc(100dvh-96px))] flex-col rounded-xl border border-[#DEE0E3] bg-surface shadow-[0_8px_28px_rgba(31,35,41,0.18)]"
      style={{ left: pos.left, top: pos.top, width: pos.width }}
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[#FF8800] text-[11px] font-semibold text-white">
            {pin.index}
          </span>
          <span className="truncate text-[12px] font-medium text-foreground">
            {pin.root.quote || `画布 (${pin.x}, ${pin.y})`}
          </span>
          {pin.orphaned && (
            <span className="shrink-0 rounded bg-[#FFF7E6] px-1 text-[10px] text-[#B25900]">
              原对象已删
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canSubmit && onResolve && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleResolve()}
              title="标记已解决"
              data-flow-comment-resolve
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-[#2EA121] hover:bg-[#EDF9EC] disabled:opacity-40"
            >
              <CheckCircle2 size={13} />
              解决
            </button>
          )}
          <button
            type="button"
            aria-label="关闭评论"
            onClick={onClose}
            className="grid size-6 place-items-center rounded text-subtle hover:bg-hover"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5 text-[13px]">
        <div>
          <div className="flex items-center justify-between text-[11px] text-subtle">
            <span className="font-medium text-foreground">{pin.root.userName || "协作者"}</span>
            <span>{pin.root.createdAt ? new Date(pin.root.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-[#1F2329] dark:text-foreground">
            {pin.root.body}
          </p>
        </div>
        {pin.replies.map((r) => (
          <div key={r.id} className="border-t border-[#EFF0F1] pt-2 dark:border-border">
            <div className="flex items-center justify-between text-[11px] text-subtle">
              <span className="font-medium text-foreground">{r.userName || "协作者"}</span>
              <span>{r.createdAt ? new Date(r.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
            </div>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-[#1F2329] dark:text-foreground">
              {r.body}
            </p>
          </div>
        ))}
      </div>

      {error && <p className="px-3 pb-1 text-[12px] text-destructive">{error}</p>}

      {canSubmit && onReply && (
        <div className="flex items-center gap-1.5 border-t p-2">
          <input
            type="text"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleReply();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="回复此评论…"
            data-flow-comment-reply-input
            className="h-8 min-w-0 flex-1 select-text rounded-md border border-[#DEE0E3] bg-background px-2 text-[12px] outline-none focus:border-primary"
          />
          <button
            type="button"
            disabled={!replyText.trim() || busy}
            onClick={() => void handleReply()}
            data-flow-comment-reply-submit
            className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-white hover:bg-primary/90 disabled:opacity-40"
            title="发送回复"
          >
            <Send size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
