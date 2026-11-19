import { useEffect, useMemo, useState } from "react";
import { Check, CheckCheck, FileEdit, RotateCcw, X, XCircle } from "lucide-react";
import type { DocSuggestion } from "@/lib/api";
import { Avatar } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { colorFor } from "@/lib/presence";
import { cn } from "@/lib/utils";

export interface SuggestionBlockOption {
  id: string;
  type: string;
  text: string;
}

const BLOCK_TYPE_LABELS: Record<string, string> = {
  paragraph: "正文",
  h1: "标题 1",
  h2: "标题 2",
  h3: "标题 3",
  h4: "标题 4",
  h5: "标题 5",
  h6: "标题 6",
  bullet: "无序列表",
  ordered: "有序列表",
  todo: "待办",
  quote: "引用",
  callout: "高亮块",
};

const STATUS_META: Record<DocSuggestion["status"], { label: string; cls: string }> = {
  open: { label: "待审阅", cls: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800" },
  accepted: { label: "已接受", cls: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800" },
  rejected: { label: "已拒绝", cls: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800" },
  withdrawn: { label: "已撤回", cls: "bg-muted text-muted-foreground border-border" },
};

export function SuggestionPanel({
  suggestions,
  blocks,
  currentUserId,
  canEdit,
  canManage,
  canSuggest,
  suggestMode,
  busy,
  onCreate,
  onAccept,
  onReject,
  onWithdraw,
  onAcceptAll,
  onRejectAll,
  onClose,
}: {
  suggestions: DocSuggestion[];
  blocks: SuggestionBlockOption[];
  currentUserId: number;
  canEdit: boolean;
  canManage: boolean;
  canSuggest: boolean;
  suggestMode: boolean;
  busy?: boolean;
  onCreate: (input: { blockId: string; originalText: string; proposedText: string; note: string }) => Promise<void> | void;
  onAccept: (s: DocSuggestion) => Promise<void> | void;
  onReject: (s: DocSuggestion) => Promise<void> | void;
  onWithdraw: (s: DocSuggestion) => Promise<void> | void;
  onAcceptAll: () => Promise<void> | void;
  onRejectAll: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [composerOpen, setComposerOpen] = useState(suggestMode);
  const [selectedBlockId, setSelectedBlockId] = useState<string>(blocks[0]?.id ?? "");
  const [proposedText, setProposedText] = useState<string>(blocks[0]?.text ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (suggestMode) setComposerOpen(true);
  }, [suggestMode]);

  useEffect(() => {
    if (!blocks.length) return;
    if (!blocks.some((b) => b.id === selectedBlockId)) {
      setSelectedBlockId(blocks[0].id);
      setProposedText(blocks[0].text);
    }
  }, [blocks, selectedBlockId]);

  const activeBlock = useMemo(() => blocks.find((b) => b.id === selectedBlockId) ?? blocks[0] ?? null, [blocks, selectedBlockId]);
  const openSuggestions = useMemo(() => suggestions.filter((s) => s.status === "open"), [suggestions]);
  const visible = useMemo(
    () => (filter === "open" ? openSuggestions : suggestions),
    [filter, openSuggestions, suggestions],
  );

  const handleSelectBlock = (nextId: string) => {
    setSelectedBlockId(nextId);
    const found = blocks.find((b) => b.id === nextId);
    setProposedText(found?.text ?? "");
    setError("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeBlock) {
      setError("当前文档没有可修订的正文段落");
      return;
    }
    if (proposedText === activeBlock.text) {
      setError("请修改建议内容后再提交");
      return;
    }
    setError("");
    try {
      await onCreate({
        blockId: activeBlock.id,
        originalText: activeBlock.text,
        proposedText,
        note: note.trim(),
      });
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交修订建议失败");
    }
  };

  return (
    <aside
      data-suggestion-panel
      aria-label="修订建议"
      className="flex h-full w-[340px] shrink-0 flex-col border-l bg-surface text-[13px]"
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <FileEdit size={16} className="text-emerald-600" />
          <span className="font-medium text-foreground">修订建议</span>
          {openSuggestions.length > 0 && (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
              {openSuggestions.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭修订建议面板"
          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-1 rounded-md bg-muted/60 p-0.5">
          <button
            type="button"
            onClick={() => setFilter("open")}
            data-suggestion-filter="open"
            className={cn(
              "rounded px-2.5 py-1 text-[12px] transition-colors",
              filter === "open" ? "bg-surface font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            待审阅 ({openSuggestions.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter("all")}
            data-suggestion-filter="all"
            className={cn(
              "rounded px-2.5 py-1 text-[12px] transition-colors",
              filter === "all" ? "bg-surface font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            全部 ({suggestions.length})
          </button>
        </div>

        {canSuggest && (
          <button
            type="button"
            onClick={() => setComposerOpen((v) => !v)}
            data-toggle-suggestion-composer
            className="rounded px-2 py-1 text-[12px] font-medium text-primary hover:bg-primary/10"
          >
            {composerOpen ? "收起新建" : "+ 发起建议"}
          </button>
        )}
      </div>

      {canEdit && openSuggestions.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2">
          <span className="text-[12px] text-muted-foreground">批量审阅</span>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void onAcceptAll()}
              data-accept-all-suggestions
              className="h-7 gap-1 border-emerald-200 px-2 text-[12px] text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300"
            >
              <CheckCheck size={13} />全部接受
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void onRejectAll()}
              data-reject-all-suggestions
              className="h-7 gap-1 border-rose-200 px-2 text-[12px] text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300"
            >
              <XCircle size={13} />全部拒绝
            </Button>
          </div>
        </div>
      )}

      {canSuggest && composerOpen && (
        <form onSubmit={handleSubmit} className="space-y-2.5 border-b bg-emerald-50/40 p-3.5 dark:bg-emerald-950/15" data-suggestion-composer>
          <div className="space-y-1">
            <label className="block text-[12px] font-medium text-foreground">目标段落</label>
            <select
              value={activeBlock?.id ?? ""}
              onChange={(e) => handleSelectBlock(e.target.value)}
              data-suggestion-block-select
              className="h-8 w-full rounded-md border bg-surface px-2 text-[12px] text-foreground outline-none focus:border-primary"
            >
              {blocks.map((b, i) => {
                const label = BLOCK_TYPE_LABELS[b.type] ?? b.type;
                const snippet = b.text.trim() ? b.text.trim().slice(0, 26) : "(空白段落)";
                return (
                  <option key={b.id} value={b.id}>
                    #{i + 1} [{label}] {snippet}
                  </option>
                );
              })}
            </select>
          </div>

          {activeBlock && (
            <div className="rounded border border-rose-200/80 bg-rose-50/60 px-2.5 py-1.5 text-[12px] text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
              <span className="mr-1 font-medium">原文：</span>
              <span className="line-through">{activeBlock.text || "(空白)"}</span>
            </div>
          )}

          <div className="space-y-1">
            <label className="block text-[12px] font-medium text-foreground">建议修改为</label>
            <textarea
              rows={3}
              value={proposedText}
              onChange={(e) => setProposedText(e.target.value)}
              placeholder="输入建议后的正文内容…"
              data-suggestion-proposed
              className="w-full resize-none rounded-md border bg-surface p-2 text-[13px] text-foreground outline-none focus:border-primary"
            />
          </div>

          <div className="space-y-1">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="修订批注 / 理由（可选）"
              data-suggestion-note
              className="h-8 w-full rounded-md border bg-surface px-2.5 text-[12px] text-foreground outline-none focus:border-primary"
            />
          </div>

          {error && <p className="text-[12px] text-destructive" role="alert">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={busy || !activeBlock}
              data-submit-suggestion
              className="h-7 bg-emerald-600 px-3 text-[12px] text-white hover:bg-emerald-700"
            >
              提交修订建议
            </Button>
          </div>
        </form>
      )}

      <div className="flex-1 space-y-2.5 overflow-y-auto p-3.5">
        {visible.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-muted-foreground">
            {filter === "open" ? "暂无待审阅的修订建议" : "暂无修订记录"}
          </div>
        ) : (
          visible.map((s) => {
            const meta = STATUS_META[s.status];
            const canWithdraw = s.status === "open" && (s.authorId === currentUserId || canManage);
            return (
              <div
                key={s.id}
                data-suggestion-card={s.id}
                data-suggestion-status={s.status}
                className="space-y-2 rounded-lg border bg-background p-3 shadow-2xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Avatar name={s.authorName || "?"} color={colorFor(s.authorId)} size={20} />
                    <span className="truncate font-medium text-foreground">{s.authorName || "协作者"}</span>
                  </div>
                  <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[11px]", meta.cls)}>
                    {meta.label}
                  </span>
                </div>

                <div className="space-y-1 rounded bg-muted/40 p-2 text-[12px] leading-relaxed">
                  {s.originalText && (
                    <div className="text-rose-700 line-through dark:text-rose-300">
                      {s.originalText}
                    </div>
                  )}
                  <div className="font-medium text-emerald-700 underline decoration-emerald-400 underline-offset-2 dark:text-emerald-300">
                    {s.proposedText || "(删除该段内容)"}
                  </div>
                </div>

                {s.note && (
                  <p className="text-[12px] text-muted-foreground">
                    <span className="font-medium text-foreground">批注：</span>
                    {s.note}
                  </p>
                )}

                {s.status !== "open" && s.resolvedByName && (
                  <p className="text-[11px] text-subtle">
                    由 {s.resolvedByName} {meta.label}
                  </p>
                )}

                {s.status === "open" && (canEdit || canWithdraw) && (
                  <div className="flex items-center justify-end gap-1.5 pt-1">
                    {canWithdraw && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onWithdraw(s)}
                        data-suggestion-withdraw={s.id}
                        className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-50"
                      >
                        <RotateCcw size={12} />撤回
                      </button>
                    )}
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onReject(s)}
                          data-suggestion-reject={s.id}
                          className="inline-flex h-7 items-center gap-1 rounded border border-rose-200 px-2 text-[12px] text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300"
                        >
                          <X size={12} />拒绝
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onAccept(s)}
                          data-suggestion-accept={s.id}
                          className="inline-flex h-7 items-center gap-1 rounded bg-emerald-600 px-2.5 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          <Check size={12} />接受
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
