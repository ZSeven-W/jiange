import { useEffect, useRef, useState } from "react";
import { Eye, SmilePlus, ThumbsUp } from "lucide-react";
import { Avatar } from "@/components/brand";
import { colorFor } from "@/lib/presence";
import { cn } from "@/lib/utils";

const FEISHU_EMOJIS = ["👍", "🎉", "❤️", "🔥", "👀", "🚀", "👏", "💯", "💡", "✅"] as const;

export interface DocReactionEntry {
  emoji: string;
  users: { id: number; name: string }[];
}

export interface DocReaderEntry {
  id: number;
  name: string;
  viewedAt?: string;
}

const storageKey = (docId: number) => `jiange:doc-reactions:v1:${docId}`;

export function loadDocReactions(docId: number): DocReactionEntry[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(storageKey(docId)) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is DocReactionEntry => !!x && typeof x.emoji === "string" && Array.isArray(x.users))
      .map((x) => ({
        emoji: x.emoji,
        users: x.users.filter((u): u is { id: number; name: string } => !!u && typeof u.id === "number" && typeof u.name === "string"),
      }))
      .filter((x) => x.users.length > 0);
  } catch {
    return [];
  }
}

export function saveDocReactions(docId: number, entries: DocReactionEntry[]) {
  try {
    if (!entries.length) localStorage.removeItem(storageKey(docId));
    else localStorage.setItem(storageKey(docId), JSON.stringify(entries));
  } catch { /* ignore storage errors */ }
}

export function toggleDocReaction(
  entries: readonly DocReactionEntry[],
  emoji: string,
  user: { id: number; name: string },
): DocReactionEntry[] {
  const existing = entries.find((e) => e.emoji === emoji);
  if (!existing) return [...entries, { emoji, users: [user] }];
  const has = existing.users.some((u) => u.id === user.id);
  const nextUsers = has ? existing.users.filter((u) => u.id !== user.id) : [...existing.users, user];
  if (nextUsers.length === 0) return entries.filter((e) => e.emoji !== emoji);
  return entries.map((e) => (e.emoji === emoji ? { ...e, users: nextUsers } : e));
}

/**
 * Feishu-style document footer bar: 👍 Like pill + emoji reactions + reader insights.
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
  const [entries, setEntries] = useState<DocReactionEntry[]>(() => loadDocReactions(docId));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [readersOpen, setReadersOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEntries(loadDocReactions(docId));
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
    setEntries((prev) => {
      const next = toggleDocReaction(prev, emoji, me);
      saveDocReactions(docId, next);
      return next;
    });
  };

  const thumbs = entries.find((e) => e.emoji === "👍");
  const liked = !!thumbs?.users.some((u) => u.id === me.id);
  const otherReactions = entries.filter((e) => e.emoji !== "👍");

  const uniqueReaders: DocReaderEntry[] = [];
  const seen = new Set<number>();
  for (const r of [ { id: me.id, name: me.name, viewedAt: "刚刚" }, ...readers ]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    uniqueReaders.push(r);
  }

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
          title={thumbs?.users.length ? thumbs.users.map((u) => u.name).join("、") : "点赞"}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors",
            liked
              ? "border-[#BACEFD] bg-[#EBF2FF] font-medium text-[#3370FF]"
              : "border-[#E5E6EB] bg-surface text-[#646A73] hover:border-[#D0D3D6] hover:bg-[#F5F6F7] dark:border-border dark:hover:bg-hover",
          )}
        >
          <ThumbsUp size={13} strokeWidth={1.8} />
          <span>{thumbs?.users.length ? thumbs.users.length : "赞"}</span>
        </button>

        {otherReactions.map((entry) => {
          const active = entry.users.some((u) => u.id === me.id);
          return (
            <button
              key={entry.emoji}
              type="button"
              onClick={() => onToggle(entry.emoji)}
              aria-pressed={active}
              data-doc-reaction={entry.emoji}
              title={entry.users.map((u) => u.name).join("、")}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] transition-colors",
                active
                  ? "border-[#BACEFD] bg-[#EBF2FF] font-medium text-[#3370FF]"
                  : "border-[#E5E6EB] bg-surface text-[#646A73] hover:border-[#D0D3D6] hover:bg-[#F5F6F7] dark:border-border dark:hover:bg-hover",
              )}
            >
              <span className="text-[13px] leading-none">{entry.emoji}</span>
              <span className="tabular-nums">{entry.users.length}</span>
            </button>
          );
        })}

        <div className="relative">
          <button
            type="button"
            onClick={() => { setReadersOpen(false); setPickerOpen((v) => !v); }}
            aria-label="添加表情回应"
            title="添加表情回应"
            aria-expanded={pickerOpen}
            data-doc-reaction-add
            className="grid size-7 place-items-center rounded-full border border-[#E5E6EB] bg-surface text-[#8F959E] transition-colors hover:border-[#D0D3D6] hover:bg-[#F5F6F7] hover:text-[#1F2329] dark:border-border dark:hover:bg-hover"
          >
            <SmilePlus size={14} strokeWidth={1.7} />
          </button>
          {pickerOpen && (
            <div
              role="menu"
              aria-label="选择表情回应"
              data-doc-reaction-picker
              className="absolute bottom-9 left-0 z-30 flex items-center gap-0.5 rounded-full border border-[#DEE0E3] bg-surface px-2 py-1 shadow-[0_6px_20px_rgba(31,35,41,0.14)] dark:border-border"
            >
              {FEISHU_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  onClick={() => { onToggle(emoji); setPickerOpen(false); }}
                  className="grid size-7 place-items-center rounded-full text-[16px] transition-transform hover:scale-115 hover:bg-[#F2F3F5] dark:hover:bg-hover"
                >
                  {emoji}
                </button>
              ))}
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
          <span className="tabular-nums">{uniqueReaders.length} 人看过</span>
        </button>
        {readersOpen && (
          <div
            role="dialog"
            aria-label="文档阅读记录"
            data-doc-readers-pop
            className="absolute bottom-9 right-0 z-30 w-56 rounded-lg border border-[#DEE0E3] bg-surface p-2.5 shadow-[0_6px_24px_rgba(31,35,41,0.14)] dark:border-border"
          >
            <div className="mb-2 flex items-center justify-between px-1 text-[12px] font-medium text-[#1F2329] dark:text-foreground">
              <span>浏览记录</span>
              <span className="text-[11px] font-normal text-[#8F959E]">{uniqueReaders.length} 人</span>
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
