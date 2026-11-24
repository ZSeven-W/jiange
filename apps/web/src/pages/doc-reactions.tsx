import { useEffect, useRef, useState } from "react";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, SmilePlus, ThumbsUp } from "lucide-react";
import { Avatar } from "@/components/brand";
import {
  docsApi,
  type DocReactionItem,
  type DocReactionsResponse,
} from "@/lib/api";
import { colorFor } from "@/lib/presence";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Closed Feishu document reaction emoji palette matching server store.DocReactionEmojis. */
export const DOC_REACTION_EMOJIS = [
  "👍",
  "❤️",
  "🎉",
  "👏",
  "🔥",
  "😄",
  "🚀",
  "👀",
  "💯",
  "🙏",
] as const;

const EMPTY_DOC_REACTIONS: DocReactionsResponse = { reactions: [], viewerCount: 1 };

export function docReactionsQueryKey(docId: number) {
  return ["doc-reactions", docId] as const;
}

export interface DocReaderEntry {
  id: number;
  name: string;
  viewedAt?: string;
}

/**
 * Optimistically toggles a single emoji reaction for the current user,
 * keeping palette ordering and omitting zero-count buckets.
 */
export function applyOptimisticDocReaction(
  prev: DocReactionsResponse | undefined,
  emoji: string,
): DocReactionsResponse {
  const base: DocReactionsResponse = prev ?? EMPTY_DOC_REACTIONS;
  const existing = base.reactions.find((item) => item.emoji === emoji);
  let nextReactions: DocReactionItem[];
  if (!existing) {
    nextReactions = [...base.reactions, { emoji, count: 1, reacted: true }];
  } else if (existing.reacted) {
    const nextCount = existing.count - 1;
    nextReactions =
      nextCount <= 0
        ? base.reactions.filter((item) => item.emoji !== emoji)
        : base.reactions.map((item) =>
            item.emoji === emoji ? { ...item, count: nextCount, reacted: false } : item,
          );
  } else {
    nextReactions = base.reactions.map((item) =>
      item.emoji === emoji ? { ...item, count: item.count + 1, reacted: true } : item,
    );
  }
  nextReactions.sort((a, b) => {
    const ia = DOC_REACTION_EMOJIS.indexOf(a.emoji as (typeof DOC_REACTION_EMOJIS)[number]);
    const ib = DOC_REACTION_EMOJIS.indexOf(b.emoji as (typeof DOC_REACTION_EMOJIS)[number]);
    return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
  });
  return {
    reactions: nextReactions,
    viewerCount: Math.max(1, base.viewerCount),
  };
}

export interface DocReactionMutationContext {
  key: readonly ["doc-reactions", number];
  previous: DocReactionsResponse | undefined;
}

export function docReactionToggleOptions(queryClient: QueryClient, docId: number) {
  const mutationKey = docReactionsQueryKey(docId);
  return {
    mutationKey,
    mutationFn: (emoji: string) => docsApi.toggleReaction(docId, emoji),
    onMutate: async (emoji: string): Promise<DocReactionMutationContext> => {
      const key = docReactionsQueryKey(docId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DocReactionsResponse>(key);
      queryClient.setQueryData<DocReactionsResponse>(
        key,
        applyOptimisticDocReaction(previous, emoji),
      );
      return { key, previous };
    },
    onError: (
      _err: unknown,
      _emoji: string,
      context: DocReactionMutationContext | undefined,
    ) => {
      if (!context) return;
      if (context.previous !== undefined) {
        queryClient.setQueryData<DocReactionsResponse>(context.key, context.previous);
      } else {
        queryClient.setQueryData<DocReactionsResponse>(context.key, EMPTY_DOC_REACTIONS);
      }
      void queryClient.invalidateQueries({ queryKey: context.key, exact: true });
    },
    onSuccess: (
      snapshot: DocReactionsResponse,
      _emoji: string,
      context: DocReactionMutationContext | undefined,
    ) => {
      const key = context?.key ?? docReactionsQueryKey(docId);
      if (queryClient.isMutating({ mutationKey: key }) <= 1) {
        queryClient.setQueryData<DocReactionsResponse>(key, snapshot);
      }
    },
  };
}

/**
 * Feishu-style document footer bar: 👍 Like pill + cloud-persisted emoji reactions + reader insights.
 */
export function DocReactionsBar({
  docId,
  me,
  readers,
}: {
  docId: number;
  me: { id: number; name: string };
  readers: readonly DocReaderEntry[];
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [readersOpen, setReadersOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const reactionsQuery = useQuery({
    queryKey: docReactionsQueryKey(docId),
    queryFn: () => docsApi.reactions(docId),
    enabled: docId > 0,
  });

  const toggleMutation = useMutation(docReactionToggleOptions(queryClient, docId));

  useEffect(() => {
    setPickerOpen(false);
    setReadersOpen(false);
  }, [docId]);

  useEffect(() => {
    if (!pickerOpen && !readersOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) {
        setPickerOpen(false);
        setReadersOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPickerOpen(false);
        setReadersOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen, readersOpen]);

  const onToggle = (emoji: string) => {
    if (docId <= 0) return;
    toggleMutation.mutate(emoji);
  };

  const reactions = reactionsQuery.data?.reactions ?? EMPTY_DOC_REACTIONS.reactions;
  const thumbs = reactions.find((e) => e.emoji === "👍");
  const liked = !!thumbs?.reacted;
  const thumbsCount = thumbs?.count ?? 0;
  const otherReactions = reactions.filter((e) => e.emoji !== "👍");

  const uniqueReaders: DocReaderEntry[] = [];
  const seen = new Set<number>();
  for (const r of [{ id: me.id, name: me.name, viewedAt: t("刚刚") }, ...readers]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    uniqueReaders.push(r);
  }
  const viewerCount = Math.max(reactionsQuery.data?.viewerCount ?? 1, uniqueReaders.length);

  return (
    <div
      ref={barRef}
      contentEditable={false}
      data-doc-reactions
      className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-[#EFF0F1] pt-4 select-none dark:border-border"
    >
      <div className="relative flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onToggle("👍")}
          aria-pressed={liked}
          data-doc-like-btn
          title={t("点赞")}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors",
            liked
              ? "border-[#BACEFD] bg-[#EBF2FF] font-medium text-[#3370FF]"
              : "border-[#E5E6EB] bg-surface text-[#646A73] hover:border-[#D0D3D6] hover:bg-[#F5F6F7] dark:border-border dark:hover:bg-hover",
          )}
        >
          <ThumbsUp size={13} strokeWidth={1.8} />
          <span className={thumbsCount > 0 ? "tabular-nums" : undefined}>
            {thumbsCount > 0 ? thumbsCount : t("赞")}
          </span>
        </button>

        {otherReactions.map((entry) => (
          <button
            key={entry.emoji}
            type="button"
            onClick={() => onToggle(entry.emoji)}
            aria-pressed={entry.reacted}
            data-doc-reaction={entry.emoji}
            title={`${entry.emoji} ${entry.count}`}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] transition-colors",
              entry.reacted
                ? "border-[#BACEFD] bg-[#EBF2FF] font-medium text-[#3370FF]"
                : "border-[#E5E6EB] bg-surface text-[#646A73] hover:border-[#D0D3D6] hover:bg-[#F5F6F7] dark:border-border dark:hover:bg-hover",
            )}
          >
            <span className="text-[13px] leading-none">{entry.emoji}</span>
            <span className="tabular-nums">{entry.count}</span>
          </button>
        ))}

        <div className="relative">
          <button
            type="button"
            onClick={() => { setReadersOpen(false); setPickerOpen((v) => !v); }}
            aria-label={t("添加表情回应")}
            title={t("添加表情回应")}
            aria-expanded={pickerOpen}
            data-doc-reaction-add
            className="grid size-7 place-items-center rounded-full border border-[#E5E6EB] bg-surface text-[#8F959E] transition-colors hover:border-[#D0D3D6] hover:bg-[#F5F6F7] hover:text-[#1F2329] dark:border-border dark:hover:bg-hover"
          >
            <SmilePlus size={14} strokeWidth={1.7} />
          </button>
          {pickerOpen && (
            <div
              role="menu"
              aria-label={t("选择表情回应")}
              data-doc-reaction-picker
              className="absolute bottom-9 left-0 z-30 flex items-center gap-0.5 rounded-full border border-[#DEE0E3] bg-surface px-2 py-1 shadow-[0_6px_20px_rgba(31,35,41,0.14)] dark:border-border"
            >
              {DOC_REACTION_EMOJIS.map((emoji) => {
                const active = reactions.some((item) => item.emoji === emoji && item.reacted);
                return (
                  <button
                    key={emoji}
                    type="button"
                    role="menuitem"
                    aria-pressed={active}
                    onClick={() => { onToggle(emoji); setPickerOpen(false); }}
                    className={cn(
                      "grid size-7 place-items-center rounded-full text-[16px] transition-transform hover:scale-115 hover:bg-[#F2F3F5] dark:hover:bg-hover",
                      active && "bg-[#EBF2FF]",
                    )}
                  >
                    {emoji}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => { setPickerOpen(false); setReadersOpen((v) => !v); }}
          aria-expanded={readersOpen}
          data-doc-readers-btn
          className="inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-[12px] text-[#8F959E] transition-colors hover:bg-[#F5F6F7] hover:text-[#646A73] dark:hover:bg-hover"
        >
          <span className="flex -space-x-1">
            {uniqueReaders.slice(0, 3).map((r) => (
              <Avatar key={r.id} name={r.name} color={colorFor(r.id - 1)} size={16} ring />
            ))}
          </span>
          <Eye size={12} strokeWidth={1.7} />
          <span className="tabular-nums">{t("{n} 人看过", { n: viewerCount })}</span>
        </button>
        {readersOpen && (
          <div
            role="dialog"
            aria-label={t("文档阅读记录")}
            data-doc-readers-pop
            className="absolute bottom-9 right-0 z-30 w-56 rounded-lg border border-[#DEE0E3] bg-surface p-2.5 shadow-[0_6px_24px_rgba(31,35,41,0.14)] dark:border-border"
          >
            <div className="mb-2 flex items-center justify-between px-1 text-[12px] font-medium text-[#1F2329] dark:text-foreground">
              <span>{t("浏览记录")}</span>
              <span className="text-[11px] font-normal text-[#8F959E]">{t("{n} 人", { n: viewerCount })}</span>
            </div>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {uniqueReaders.map((r) => (
                <div key={r.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[12px]">
                  <Avatar name={r.name} color={colorFor(r.id - 1)} size={20} />
                  <span className="min-w-0 flex-1 truncate text-foreground">{r.name}</span>
                  {r.viewedAt && <span className="shrink-0 text-[11px] text-[#8F959E]">{r.viewedAt}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
