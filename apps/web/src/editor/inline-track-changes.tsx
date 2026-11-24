import { useMemo, useState } from "react";
import { Check, FileDiff, MessageSquarePlus, X } from "lucide-react";
import type { DocSuggestion } from "@/lib/api";
import { Avatar } from "@/components/brand";
import { useI18n } from "@/lib/i18n";
import { colorFor } from "@/lib/presence";
import { cn } from "@/lib/utils";

export type InlineDiffSegment = {
  kind: "equal" | "delete" | "insert";
  text: string;
};

function tokenizeForDiff(text: string): string[] {
  // Split Latin words/numbers as tokens, individual CJK/other code points, and whitespace runs
  // so inline Chinese + English edits highlight cleanly.
  return text.match(/[A-Za-z0-9_]+|\s+|./gu) ?? [];
}

function mergeSegments(raw: InlineDiffSegment[]): InlineDiffSegment[] {
  const out: InlineDiffSegment[] = [];
  for (const seg of raw) {
    if (!seg.text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.kind === seg.kind) {
      prev.text += seg.text;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/**
 * Compute an inline token-level diff between `original` and `proposed`.
 * Uses prefix/suffix trimming + bounded LCS (with single-region fallback on very large blocks).
 */
export function computeInlineDiff(original: string, proposed: string): InlineDiffSegment[] {
  if (original === proposed) {
    return original ? [{ kind: "equal", text: original }] : [];
  }
  if (!original) return [{ kind: "insert", text: proposed }];
  if (!proposed) return [{ kind: "delete", text: original }];

  const a = tokenizeForDiff(original);
  const b = tokenizeForDiff(proposed);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const segments: InlineDiffSegment[] = [];
  if (prefix > 0) segments.push({ kind: "equal", text: a.slice(0, prefix).join("") });

  const m = midA.length;
  const n = midB.length;
  if (m === 0) {
    if (n > 0) segments.push({ kind: "insert", text: midB.join("") });
  } else if (n === 0) {
    segments.push({ kind: "delete", text: midA.join("") });
  } else if (m * n > 40_000) {
    // Bounded fallback for very long paragraphs to keep rendering instant.
    segments.push({ kind: "delete", text: midA.join("") });
    segments.push({ kind: "insert", text: midB.join("") });
  } else {
    // Classic LCS DP table
    const dp = new Uint32Array((m + 1) * (n + 1));
    const stride = n + 1;
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midA[i] === midB[j]) {
          dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1;
        } else {
          const down = dp[(i + 1) * stride + j];
          const right = dp[i * stride + (j + 1)];
          dp[i * stride + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        segments.push({ kind: "equal", text: midA[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
        segments.push({ kind: "delete", text: midA[i] });
        i++;
      } else {
        segments.push({ kind: "insert", text: midB[j] });
        j++;
      }
    }
    while (i < m) segments.push({ kind: "delete", text: midA[i++] });
    while (j < n) segments.push({ kind: "insert", text: midB[j++] });
  }

  if (suffix > 0) segments.push({ kind: "equal", text: a.slice(a.length - suffix).join("") });
  return mergeSegments(segments);
}

export function formatSuggestionTimestamp(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface InlineTrackChangesProps {
  blockId: string;
  blockText: string;
  suggestions: readonly DocSuggestion[];
  canEdit: boolean;
  canSuggest?: boolean;
  busy?: boolean;
  onAccept?: (s: DocSuggestion) => Promise<void> | void;
  onReject?: (s: DocSuggestion) => Promise<void> | void;
  onCreate?: (input: { blockId: string; originalText: string; proposedText: string; note: string }) => Promise<void> | void;
}

export function InlineTrackChanges({
  blockId,
  blockText,
  suggestions,
  canEdit,
  canSuggest = false,
  busy = false,
  onAccept,
  onReject,
  onCreate,
}: InlineTrackChangesProps) {
  const { t } = useI18n();
  const [composerOpen, setComposerOpen] = useState(false);
  const [proposedText, setProposedText] = useState(blockText);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const openSuggestions = useMemo(
    () => suggestions.filter((s) => s.status === "open"),
    [suggestions],
  );

  const openComposer = () => {
    setProposedText(blockText);
    setNote("");
    setError("");
    setComposerOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onCreate) return;
    if (proposedText === blockText) {
      setError(t("请修改建议内容后再提交"));
      return;
    }
    setError("");
    try {
      await onCreate({
        blockId,
        originalText: blockText,
        proposedText,
        note: note.trim(),
      });
      setComposerOpen(false);
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("提交修订建议失败"));
    }
  };

  if (openSuggestions.length === 0 && !(canSuggest && onCreate)) return null;

  return (
    <div contentEditable={false} data-inline-track-changes={blockId} className="mt-1 space-y-1.5 select-none">
      {openSuggestions.map((s) => {
        const segments = computeInlineDiff(s.originalText, s.proposedText);
        const ts = formatSuggestionTimestamp(s.createdAt);
        return (
          <div
            key={s.id}
            data-inline-suggestion-id={s.id}
            className="rounded-md border border-emerald-200/90 border-l-[3px] border-l-emerald-500 bg-surface/95 px-3 py-2 text-[12px] shadow-2xs dark:border-emerald-900/70 dark:border-l-emerald-500"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <FileDiff size={13} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                <Avatar name={s.authorName || "?"} color={colorFor(s.authorId)} size={18} />
                <span className="truncate font-medium text-foreground" data-inline-suggestion-author>
                  {s.authorName || t("协作者")}
                </span>
                {ts && (
                  <span className="shrink-0 text-[11px] text-subtle" data-inline-suggestion-time>
                    {ts}
                  </span>
                )}
                <span className="shrink-0 rounded bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                  {t("修订建议")}
                </span>
              </div>

              {canEdit && (onAccept || onReject) && (
                <div className="flex shrink-0 items-center gap-1">
                  {onReject && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onReject(s)}
                      data-inline-suggestion-reject={s.id}
                      className="inline-flex h-6 items-center gap-1 rounded border border-red-200 bg-surface px-2 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
                    >
                      <X size={11} />
                      {t("拒绝")}
                    </button>
                  )}
                  {onAccept && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onAccept(s)}
                      data-inline-suggestion-accept={s.id}
                      className="inline-flex h-6 items-center gap-1 rounded bg-emerald-600 px-2.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <Check size={11} />
                      {t("接受")}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div
              data-inline-diff
              className="mt-1.5 rounded bg-muted/40 px-2.5 py-1.5 text-[13px] leading-[1.65] whitespace-pre-wrap break-words"
            >
              {segments.length === 0 ? (
                <span className="text-subtle">{t("(无文本变化)")}</span>
              ) : (
                segments.map((seg, idx) => {
                  if (seg.kind === "delete") {
                    return (
                      <del
                        key={idx}
                        data-diff-delete
                        className="mx-px rounded-[2px] bg-red-50 px-0.5 text-red-700 line-through dark:bg-red-950/50 dark:text-red-300"
                      >
                        {seg.text}
                      </del>
                    );
                  }
                  if (seg.kind === "insert") {
                    return (
                      <ins
                        key={idx}
                        data-diff-insert
                        className="mx-px rounded-[2px] bg-emerald-50 px-0.5 text-emerald-700 underline decoration-emerald-400 underline-offset-2 dark:bg-emerald-950/50 dark:text-emerald-300"
                      >
                        {seg.text}
                      </ins>
                    );
                  }
                  return <span key={idx} className="text-foreground/85">{seg.text}</span>;
                })
              )}
            </div>

            {s.note && (
              <p className="mt-1 text-[11px] text-muted-foreground" data-inline-suggestion-note>
                <span className="font-medium text-foreground">{t("批注：")}</span>
                {s.note}
              </p>
            )}
          </div>
        );
      })}

      {canSuggest && onCreate && !composerOpen && (
        <div className={cn("flex items-center", openSuggestions.length === 0 && "opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100")}>
          <button
            type="button"
            onClick={openComposer}
            data-inline-propose-btn={blockId}
            className="inline-flex h-6 items-center gap-1 rounded-full border border-emerald-200/90 bg-emerald-50/70 px-2.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100/70 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
          >
            <MessageSquarePlus size={11} />
            {t("提出修订建议")}
          </button>
        </div>
      )}

      {canSuggest && onCreate && composerOpen && (
        <form
          onSubmit={handleSubmit}
          data-inline-propose-form={blockId}
          className="space-y-2 rounded-md border border-emerald-300/90 bg-emerald-50/40 p-2.5 text-[12px] dark:border-emerald-900 dark:bg-emerald-950/20"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-emerald-800 dark:text-emerald-300">{t("提出修订建议")}</span>
            <button
              type="button"
              onClick={() => setComposerOpen(false)}
              aria-label={t("关闭")}
              className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              <X size={12} />
            </button>
          </div>
          <textarea
            rows={2}
            autoFocus
            value={proposedText}
            onChange={(e) => {
              setProposedText(e.target.value);
              if (error) setError("");
            }}
            placeholder={t("输入建议修改后的内容…")}
            data-inline-propose-input
            className="w-full resize-y rounded-md border bg-surface p-2 text-[13px] text-foreground outline-none focus:border-emerald-500"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("修订说明（可选）")}
              data-inline-propose-note
              className="h-7 min-w-[160px] flex-1 rounded-md border bg-surface px-2 text-[12px] text-foreground outline-none focus:border-emerald-500"
            />
            <button
              type="button"
              onClick={() => setComposerOpen(false)}
              className="h-7 rounded-md px-2.5 text-[12px] text-muted-foreground hover:bg-hover"
            >
              {t("取消")}
            </button>
            <button
              type="submit"
              disabled={busy}
              data-inline-propose-submit
              className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-3 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Check size={12} />
              {t("提交修订建议")}
            </button>
          </div>
          {error && <p className="text-[12px] text-destructive" role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}
