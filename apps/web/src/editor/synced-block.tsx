import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Link2, Lock, RefreshCw, Repeat2, Trash2 } from "lucide-react";
import { ApiError, syncedBlocksApi, type SyncedBlock } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export function SyncedBlockView({
  syncId,
  docId,
  readOnly,
  onBindSyncId,
  onDelete,
}: {
  syncId?: string;
  docId?: number;
  readOnly?: boolean;
  onBindSyncId?: (nextSyncId: string) => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<SyncedBlock | null>(null);
  const [canEditRemote, setCanEditRemote] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "saved" | "forbidden" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [copied, setCopied] = useState(false);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const revRef = useRef(0);

  const load = useCallback(async (id: string, silent = false) => {
    if (!silent) setStatus("loading");
    try {
      const res = await syncedBlocksApi.get(id);
      setData(res.syncedBlock);
      setCanEditRemote(res.canEdit);
      revRef.current = res.syncedBlock.revision;
      if (!dirtyRef.current) setDraft(res.syncedBlock.content);
      setStatus("idle");
      setErrorMsg("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setStatus("forbidden");
        setErrorMsg(t("无权查看此同步块源文档内容"));
      } else {
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : t("加载同步块失败"));
      }
    }
  }, [t]);

  useEffect(() => {
    if (!syncId) return;
    void load(syncId);
    const timer = window.setInterval(() => {
      if (!dirtyRef.current) void load(syncId, true);
    }, 4000);
    return () => {
      window.clearInterval(timer);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [syncId, load]);

  const flushSave = useCallback(async (nextContent: string) => {
    if (!syncId) return;
    setStatus("saving");
    try {
      const res = await syncedBlocksApi.update(syncId, nextContent, revRef.current);
      dirtyRef.current = false;
      setData(res.syncedBlock);
      revRef.current = res.syncedBlock.revision;
      setStatus("saved");
      setErrorMsg("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        dirtyRef.current = false;
        await load(syncId, true);
        setErrorMsg(t("同步块已在其他文档更新，已刷新为最新版本"));
      } else {
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : t("保存同步块失败"));
      }
    }
  }, [syncId, load, t]);

  const handleCreate = async () => {
    if (!docId || !onBindSyncId) return;
    setStatus("saving");
    try {
      const res = await syncedBlocksApi.create(docId, "");
      setData(res.syncedBlock);
      setCanEditRemote(res.canEdit);
      revRef.current = res.syncedBlock.revision;
      setDraft("");
      setStatus("idle");
      onBindSyncId(res.syncedBlock.id);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : t("创建同步块失败"));
    }
  };

  const handleLink = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = linkInput.trim();
    if (!cleaned || !onBindSyncId) return;
    onBindSyncId(cleaned);
    setLinkInput("");
  };

  const handleCopyId = () => {
    if (!syncId) return;
    void navigator.clipboard?.writeText(syncId).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  if (!syncId) {
    return (
      <div contentEditable={false} data-synced-block-empty className="my-2 rounded-lg border border-dashed border-rose-300 bg-rose-50/30 p-3.5 text-[13px] dark:border-rose-900 dark:bg-rose-950/20">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-medium text-rose-700 dark:text-rose-300">
            <Repeat2 size={15} />{t("跨文档同步块")}
          </span>
          {!readOnly && onDelete && (
            <button type="button" onClick={onDelete} aria-label={t("删除同步块")} className="rounded p-1 text-muted-foreground hover:bg-hover hover:text-destructive">
              <Trash2 size={14} />
            </button>
          )}
        </div>
        {!readOnly ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={!docId || status === "saving"}
              data-create-synced-block
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-rose-600 px-3 text-[12px] font-medium text-white hover:bg-rose-700 disabled:opacity-50"
            >
              <Repeat2 size={13} />{t("创建新同步块")}
            </button>
            <form onSubmit={handleLink} className="flex flex-1 items-center gap-1.5 min-w-[220px]">
              <input
                type="text"
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                placeholder={t("或粘贴已有同步块 ID（如 sb_...）")}
                data-link-synced-input
                className="h-8 flex-1 rounded-md border bg-surface px-2.5 text-[12px] outline-none focus:border-rose-400"
              />
              <button
                type="submit"
                disabled={!linkInput.trim()}
                data-link-synced-submit
                className="inline-flex h-8 items-center gap-1 rounded-md border bg-surface px-2.5 text-[12px] hover:bg-hover disabled:opacity-50"
              >
                <Link2 size={13} />{t("关联")}
              </button>
            </form>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">{t("未关联同步块内容")}</p>
        )}
        {errorMsg && <p className="mt-2 text-[12px] text-destructive">{errorMsg}</p>}
      </div>
    );
  }

  const editable = !readOnly && canEditRemote && status !== "forbidden";

  return (
    <div contentEditable={false} data-synced-block={syncId} className="my-2 rounded-lg border-2 border-rose-300/80 bg-rose-50/15 p-3 text-[14px] dark:border-rose-800/80 dark:bg-rose-950/15">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded bg-rose-100 px-1.5 py-0.5 font-medium text-rose-700 dark:bg-rose-950/70 dark:text-rose-300">
            <Repeat2 size={12} />{t("同步块")}
          </span>
          {data?.sourceDocId && (
            <a href={`#/doc/${data.sourceDocId}`} className="truncate hover:text-foreground hover:underline">
              {t("源文档：{title}", { title: data.sourceDocTitle || `#${data.sourceDocId}` })}
            </a>
          )}
          {data && <span className="text-[11px] text-subtle">v{data.revision}</span>}
          {status === "saving" && <span className="text-[11px] text-amber-600">{t("同步中…")}</span>}
          {status === "saved" && <span className="text-[11px] text-emerald-600">{t("已跨文档同步")}</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopyId}
            data-copy-synced-id
            title={t("复制同步块 ID，可在其他文档中关联")}
            className="inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] hover:bg-hover hover:text-foreground"
          >
            {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
            {copied ? t("已复制 ID") : t("复制同步 ID")}
          </button>
          <button
            type="button"
            onClick={() => void load(syncId)}
            data-refresh-synced
            title={t("刷新同步内容")}
            className="grid size-6 place-items-center rounded hover:bg-hover hover:text-foreground"
          >
            <RefreshCw size={12} />
          </button>
          {!readOnly && onDelete && (
            <button
              type="button"
              onClick={onDelete}
              title={t("移除此同步块引用")}
              className="grid size-6 place-items-center rounded hover:bg-hover hover:text-destructive"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {status === "forbidden" ? (
        <div className="flex items-center gap-2 rounded bg-muted/60 px-3 py-3 text-[13px] text-muted-foreground" data-synced-forbidden>
          <Lock size={14} />
          <span>{errorMsg || t("无权查看此同步块内容")}</span>
        </div>
      ) : editable ? (
        <textarea
          rows={Math.max(2, draft.split("\n").length)}
          value={draft}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            dirtyRef.current = true;
            if (saveTimer.current) window.clearTimeout(saveTimer.current);
            saveTimer.current = window.setTimeout(() => void flushSave(next), 500);
          }}
          onBlur={() => {
            if (dirtyRef.current) {
              if (saveTimer.current) window.clearTimeout(saveTimer.current);
              void flushSave(draft);
            }
          }}
          placeholder={t("输入跨文档实时同步的内容…")}
          data-synced-textarea
          className="w-full resize-none rounded bg-surface/80 p-2 text-[14px] leading-relaxed text-foreground outline-none focus:ring-1 focus:ring-rose-300"
        />
      ) : (
        <div className="whitespace-pre-wrap break-words rounded bg-surface/60 p-2 text-[14px] leading-relaxed text-foreground" data-synced-readonly>
          {draft || <span className="text-muted-foreground">{t("(同步块暂无内容)")}</span>}
        </div>
      )}

      {errorMsg && status !== "forbidden" && <p className="mt-1.5 text-[12px] text-destructive">{errorMsg}</p>}
    </div>
  );
}
