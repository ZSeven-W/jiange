import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SlidesPage } from "@/lib/api";
import {
  slidesExtrasApi,
  type SlidesComment,
  type SlidesVersionMeta,
} from "@/lib/slides-extras-api";
import { t, useI18n } from "@/lib/i18n";
import { colorFor } from "@/lib/presence";
import { Avatar } from "@/components/brand";
import { ask } from "@/components/ui/ask";
import {
  CheckCircle2,
  History,
  Layers,
  MessageSquare,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  X,
} from "lucide-react";

export type SlidesExtrasTab = "comments" | "versions";
export type SlidesCommentFilter = "current" | "all" | "unresolved";

export interface SlidesExtrasPanelProps {
  deckId: number;
  userId: number;
  currentPageId: number | null;
  selectedShapeId: string | null;
  pageIndexById: ReadonlyMap<number, number>;
  canEdit: boolean;
  canManage: boolean;
  initialTab?: SlidesExtrasTab;
  onJumpPage?: (pageId: number) => void;
  onRestored?: (pages: SlidesPage[]) => void;
  onClose: () => void;
}

export function formatSlidesExtrasTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return "";
  }
}

/**
 * Resolves a 1-based display slide number from `pageIndexById`, tolerating
 * both 0-based (`0, 1, 2`) and 1-based (`1, 2, 3`) index maps cleanly.
 */
export function slidePageNumber(
  pageId: number | null,
  pageIndexById: ReadonlyMap<number, number>,
): number | null {
  if (pageId == null) return null;
  const raw = pageIndexById.get(pageId);
  if (raw === undefined) return null;
  let zeroBased = false;
  for (const v of pageIndexById.values()) {
    if (v === 0) {
      zeroBased = true;
      break;
    }
  }
  return zeroBased ? raw + 1 : raw;
}

export function filterSlidesComments(
  comments: readonly SlidesComment[],
  filter: SlidesCommentFilter,
  currentPageId: number | null,
): SlidesComment[] {
  if (filter === "current") {
    if (currentPageId == null) return [];
    return comments.filter((c) => c.pageId === currentPageId);
  }
  if (filter === "unresolved") {
    return comments.filter((c) => !c.resolved);
  }
  return [...comments];
}

export function SlidesExtrasPanel({
  deckId,
  userId,
  currentPageId,
  selectedShapeId,
  pageIndexById,
  canEdit,
  canManage,
  initialTab = "comments",
  onJumpPage,
  onRestored,
  onClose,
}: SlidesExtrasPanelProps) {
  useI18n();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<SlidesExtrasTab>(initialTab);
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // --- Comments state & query ---
  const commentsQueryKey = ["slides-comments", deckId, userId] as const;
  const [commentFilter, setCommentFilter] = useState<SlidesCommentFilter>("all");
  const [draftBody, setDraftBody] = useState("");
  const [attachSelectedShape, setAttachSelectedShape] = useState(true);
  const [submittingComment, setSubmittingComment] = useState(false);
  const [commentError, setCommentError] = useState("");
  const [busyCommentId, setBusyCommentId] = useState<number | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<number | null>(null);
  const [editingBody, setEditingBody] = useState("");

  useEffect(() => {
    setAttachSelectedShape(true);
  }, [selectedShapeId, currentPageId]);

  const commentsQuery = useQuery({
    queryKey: commentsQueryKey,
    queryFn: ({ signal }) => slidesExtrasApi.listComments(deckId, userId, signal),
    retry: false,
  });

  const allComments = commentsQuery.data?.comments ?? [];
  const unresolvedCount = useMemo(
    () => allComments.filter((c) => !c.resolved).length,
    [allComments],
  );
  const currentPageCount = useMemo(
    () =>
      currentPageId == null
        ? 0
        : allComments.filter((c) => c.pageId === currentPageId).length,
    [allComments, currentPageId],
  );
  const visibleComments = useMemo(
    () => filterSlidesComments(allComments, commentFilter, currentPageId),
    [allComments, commentFilter, currentPageId],
  );

  // --- Versions state & query ---
  const versionsQueryKey = ["slides-versions", deckId, userId] as const;
  const [versionLabel, setVersionLabel] = useState("");
  const [savingVersion, setSavingVersion] = useState(false);
  const [restoringVersionId, setRestoringVersionId] = useState<number | null>(null);
  const [versionError, setVersionError] = useState("");

  const versionsQuery = useQuery({
    queryKey: versionsQueryKey,
    queryFn: ({ signal }) => slidesExtrasApi.listVersions(deckId, userId, signal),
    enabled: activeTab === "versions",
    retry: false,
  });

  const versions = versionsQuery.data?.versions ?? [];

  const currentPageNum = slidePageNumber(currentPageId, pageIndexById);
  const activeShapeTarget =
    attachSelectedShape && selectedShapeId && selectedShapeId.trim()
      ? selectedShapeId.trim()
      : "";

  const handleCreateComment = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (submittingComment || currentPageId == null) return;
    const trimmed = draftBody.trim();
    if (!trimmed) {
      setCommentError(t("评论内容不能为空"));
      return;
    }
    setCommentError("");
    setSubmittingComment(true);
    try {
      const res = await slidesExtrasApi.createComment(deckId, userId, {
        pageId: currentPageId,
        shapeId: activeShapeTarget,
        body: trimmed,
      });
      setDraftBody("");
      qc.setQueryData<{ comments: SlidesComment[] }>(commentsQueryKey, (old) => ({
        comments: [...(old?.comments ?? []).filter((c) => c.id !== res.comment.id), res.comment],
      }));
      void qc.invalidateQueries({ queryKey: commentsQueryKey });
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : t("发送评论失败"));
    } finally {
      setSubmittingComment(false);
    }
  };

  const handleToggleResolve = async (cm: SlidesComment) => {
    if (busyCommentId !== null) return;
    setCommentError("");
    setBusyCommentId(cm.id);
    try {
      const res = await slidesExtrasApi.updateComment(deckId, userId, cm.id, {
        resolved: !cm.resolved,
      });
      qc.setQueryData<{ comments: SlidesComment[] }>(commentsQueryKey, (old) => ({
        comments: (old?.comments ?? []).map((item) =>
          item.id === res.comment.id ? res.comment : item,
        ),
      }));
      void qc.invalidateQueries({ queryKey: commentsQueryKey });
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : t("更新评论失败"));
    } finally {
      setBusyCommentId(null);
    }
  };

  const handleSaveEdit = async (cm: SlidesComment) => {
    if (busyCommentId !== null) return;
    const trimmed = editingBody.trim();
    if (!trimmed) {
      setCommentError(t("评论内容不能为空"));
      return;
    }
    setCommentError("");
    setBusyCommentId(cm.id);
    try {
      const res = await slidesExtrasApi.updateComment(deckId, userId, cm.id, {
        body: trimmed,
      });
      setEditingCommentId(null);
      setEditingBody("");
      qc.setQueryData<{ comments: SlidesComment[] }>(commentsQueryKey, (old) => ({
        comments: (old?.comments ?? []).map((item) =>
          item.id === res.comment.id ? res.comment : item,
        ),
      }));
      void qc.invalidateQueries({ queryKey: commentsQueryKey });
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : t("更新评论失败"));
    } finally {
      setBusyCommentId(null);
    }
  };

  const handleDeleteComment = async (cm: SlidesComment) => {
    if (busyCommentId !== null) return;
    const ok = await ask(t("删除评论"), t("确认删除这条批注吗？"), true);
    if (!ok) return;
    setCommentError("");
    setBusyCommentId(cm.id);
    try {
      await slidesExtrasApi.deleteComment(deckId, userId, cm.id);
      if (editingCommentId === cm.id) {
        setEditingCommentId(null);
        setEditingBody("");
      }
      qc.setQueryData<{ comments: SlidesComment[] }>(commentsQueryKey, (old) => ({
        comments: (old?.comments ?? []).filter((item) => item.id !== cm.id),
      }));
      void qc.invalidateQueries({ queryKey: commentsQueryKey });
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : t("删除评论失败"));
    } finally {
      setBusyCommentId(null);
    }
  };

  const handleSaveVersion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || savingVersion) return;
    setVersionError("");
    setSavingVersion(true);
    try {
      const res = await slidesExtrasApi.createVersion(deckId, userId, versionLabel.trim());
      setVersionLabel("");
      qc.setQueryData<{ versions: SlidesVersionMeta[] }>(versionsQueryKey, (old) => ({
        versions: [res.version, ...(old?.versions ?? []).filter((v) => v.id !== res.version.id)],
      }));
      void qc.invalidateQueries({ queryKey: versionsQueryKey });
    } catch (err) {
      setVersionError(err instanceof Error ? err.message : t("保存历史版本失败"));
    } finally {
      setSavingVersion(false);
    }
  };

  const handleRestoreVersion = async (version: SlidesVersionMeta) => {
    if (!canEdit || restoringVersionId !== null) return;
    const confirmed = await ask(
      t("恢复此版本"),
      t("将幻灯片恢复到「{label}」？恢复前会自动保存当前内容的备份版本。", {
        label: version.label || t("未命名版本"),
      }),
      true,
    );
    if (!confirmed) return;
    setVersionError("");
    setRestoringVersionId(version.id);
    try {
      const res = await slidesExtrasApi.restoreVersion(deckId, userId, version.id);
      onRestored?.(res.pages);
      void qc.invalidateQueries({ queryKey: versionsQueryKey });
    } catch (err) {
      setVersionError(err instanceof Error ? err.message : t("恢复历史版本失败"));
    } finally {
      setRestoringVersionId(null);
    }
  };

  return (
    <aside
      data-slides-extras-panel
      aria-label={t("幻灯片批注与版本")}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (editingCommentId !== null) {
          setEditingCommentId(null);
          setEditingBody("");
        } else {
          onClose();
        }
      }}
      className="z-20 flex max-h-[48%] w-full shrink-0 flex-col border-t border-[#dee0e3] bg-white md:max-h-none md:w-[332px] md:border-l md:border-t-0"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[#e5e6eb] px-3.5">
        <div
          role="tablist"
          aria-label={t("幻灯片批注与版本")}
          className="grid flex-1 grid-cols-2 rounded-lg bg-[#f2f3f5] p-0.5 text-[12px]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "comments"}
            data-slides-tab="comments"
            onClick={() => setActiveTab("comments")}
            className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md font-medium transition-colors ${
              activeTab === "comments"
                ? "bg-white text-[#1f2329] shadow-[0_1px_2px_rgba(31,35,41,0.08)]"
                : "text-[#646a73] hover:text-[#1f2329]"
            }`}
          >
            <MessageSquare size={13} />
            <span>{t("评论批注")}</span>
            {unresolvedCount > 0 && (
              <span className="rounded-full bg-[#eef3ff] px-1.5 py-0.2 text-[10px] font-semibold text-[#3370ff]">
                {unresolvedCount}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "versions"}
            data-slides-tab="versions"
            onClick={() => setActiveTab("versions")}
            className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md font-medium transition-colors ${
              activeTab === "versions"
                ? "bg-white text-[#1f2329] shadow-[0_1px_2px_rgba(31,35,41,0.08)]"
                : "text-[#646a73] hover:text-[#1f2329]"
            }`}
          >
            <History size={13} />
            <span>{t("历史版本")}</span>
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("关闭侧栏")}
          title={t("关闭")}
          className="grid size-7 shrink-0 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
        >
          <X size={15} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-3.5 text-[12px] text-[#1f2329]">
        {activeTab === "comments" ? (
          <div className="space-y-3.5" data-slides-comments-pane>
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("评论批注")}>
                {(
                  [
                    { id: "current", label: t("当前页"), count: currentPageCount },
                    { id: "all", label: t("全部页面"), count: allComments.length },
                    { id: "unresolved", label: t("未解决"), count: unresolvedCount },
                  ] as const
                ).map((pill) => {
                  const active = commentFilter === pill.id;
                  return (
                    <button
                      key={pill.id}
                      type="button"
                      aria-pressed={active}
                      data-slides-comment-filter={pill.id}
                      onClick={() => setCommentFilter(pill.id)}
                      className={`inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-colors ${
                        active
                          ? "bg-[#eef3ff] text-[#3370ff]"
                          : "bg-[#f2f3f5] text-[#646a73] hover:bg-[#e8eaed] hover:text-[#1f2329]"
                      }`}
                    >
                      <span>{pill.label}</span>
                      <span className="text-[10px] opacity-80">{pill.count}</span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                title={t("刷新评论列表")}
                aria-label={t("刷新评论列表")}
                onClick={() => void commentsQuery.refetch()}
                className="grid size-6 shrink-0 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
              >
                <RefreshCw size={12} className={commentsQuery.isFetching ? "animate-spin" : ""} />
              </button>
            </div>

            <form
              onSubmit={(e) => void handleCreateComment(e)}
              data-slides-comment-composer
              className="space-y-2 rounded-lg border border-[#e5e6eb] bg-[#fafbfc] p-3"
            >
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#646a73]">
                {currentPageNum !== null ? (
                  <span
                    data-slides-composer-page
                    className="inline-flex items-center rounded bg-[#eef3ff] px-1.5 py-0.5 font-medium text-[#3370ff]"
                  >
                    {t("第 {n} 页", { n: currentPageNum })}
                  </span>
                ) : (
                  <span className="text-[#8f959e]">{t("请先选择幻灯片页面后再发表评论")}</span>
                )}
                {activeShapeTarget && (
                  <span
                    data-slides-composer-shape={activeShapeTarget}
                    className="inline-flex max-w-full items-center gap-1 rounded bg-[#f2f3f5] px-1.5 py-0.5 text-[10.5px] text-[#4e5969]"
                  >
                    <Layers size={10} className="shrink-0 text-[#3370ff]" />
                    <span className="truncate">
                      {t("当前选中元素：{id}", { id: activeShapeTarget })}
                    </span>
                    <button
                      type="button"
                      aria-label={t("取消关联元素")}
                      onClick={() => setAttachSelectedShape(false)}
                      className="rounded hover:text-[#1f2329]"
                    >
                      <X size={10} />
                    </button>
                  </span>
                )}
              </div>
              <textarea
                data-slides-comment-input
                value={draftBody}
                maxLength={2000}
                rows={3}
                disabled={currentPageId === null || submittingComment}
                onChange={(e) => {
                  setDraftBody(e.target.value);
                  if (commentError) setCommentError("");
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void handleCreateComment();
                  }
                }}
                placeholder={t("添加批注内容…")}
                className="w-full resize-none rounded border border-[#dee0e3] bg-white px-2.5 py-2 text-[12px] leading-relaxed text-[#1f2329] outline-none placeholder:text-[#8f959e] focus:border-[#3370ff] disabled:bg-[#f2f3f5]"
              />
              <div className="flex items-center justify-end">
                <button
                  type="submit"
                  data-slides-comment-submit
                  disabled={currentPageId === null || submittingComment || !draftBody.trim()}
                  className="inline-flex h-7 items-center gap-1 rounded bg-[#3370ff] px-3 text-[12px] font-medium text-white hover:bg-[#245bdb] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Send size={11} />
                  <span>{submittingComment ? t("正在发送…") : t("发送评论")}</span>
                </button>
              </div>
            </form>

            {commentError && (
              <p className="rounded bg-[#fff1f0] px-2.5 py-1.5 text-[11px] text-[#cf1322]">
                {commentError}
              </p>
            )}

            <div className="space-y-2.5">
              {commentsQuery.isLoading ? (
                <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">
                  {t("正在加载评论…")}
                </p>
              ) : commentsQuery.isError ? (
                <p className="rounded border border-[#ffccc7] bg-[#fff1f0] px-3 py-4 text-center text-[#cf1322]">
                  {commentsQuery.error instanceof Error
                    ? commentsQuery.error.message
                    : t("加载评论失败")}
                </p>
              ) : visibleComments.length === 0 ? (
                <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">
                  {t("暂无批注")}
                </p>
              ) : (
                visibleComments.map((cm) => {
                  const authorLabel =
                    cm.authorName || (cm.authorId > 0 ? `#${cm.authorId}` : t("协作者"));
                  const pageNum = slidePageNumber(cm.pageId, pageIndexById);
                  const isAuthor = cm.authorId === userId;
                  const canToggleResolve = canEdit || isAuthor;
                  const canEditOrDelete = canManage || isAuthor;
                  const isEditing = editingCommentId === cm.id;
                  const isBusy = busyCommentId === cm.id;

                  return (
                    <article
                      key={cm.id}
                      data-slides-comment-item={cm.id}
                      data-slides-comment-resolved={cm.resolved ? "true" : "false"}
                      className={`rounded-lg border p-3 transition-colors ${
                        cm.resolved
                          ? "border-[#e5e6eb] bg-[#fafbfc] opacity-85"
                          : "border-[#e5e6eb] bg-white hover:border-[#c9d4ea]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Avatar
                            name={authorLabel}
                            color={colorFor(Math.max(0, cm.authorId - 1))}
                            size={20}
                          />
                          <span className="truncate font-medium text-[#1f2329]">
                            {authorLabel}
                          </span>
                          {cm.resolved && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-[#e8ffea] px-1.5 py-0.5 text-[10px] font-medium text-[#00b42a]">
                              <CheckCircle2 size={10} />
                              {t("已解决")}
                            </span>
                          )}
                        </div>
                        <span className="shrink-0 text-[10px] text-[#8f959e]">
                          {formatSlidesExtrasTime(cm.createdAt)}
                        </span>
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {pageNum !== null ? (
                          <button
                            type="button"
                            data-slides-comment-jump={cm.pageId}
                            title={t("点击跳转到该页")}
                            onClick={() => onJumpPage?.(cm.pageId)}
                            className="inline-flex items-center rounded bg-[#eef3ff] px-1.5 py-0.5 text-[10.5px] font-medium text-[#3370ff] hover:bg-[#dce7ff]"
                          >
                            {t("第 {n} 页", { n: pageNum })}
                          </button>
                        ) : (
                          <span className="inline-flex items-center rounded bg-[#f2f3f5] px-1.5 py-0.5 text-[10.5px] text-[#8f959e]">
                            {t("已移除页面")}
                          </span>
                        )}
                        {cm.shapeId && (
                          <span
                            data-slides-comment-shape={cm.shapeId}
                            className="inline-flex items-center gap-1 rounded bg-[#f2f3f5] px-1.5 py-0.5 font-mono text-[10px] text-[#646a73]"
                          >
                            <Layers size={9} />
                            <span>
                              {t("关联元素")}: {cm.shapeId}
                            </span>
                          </span>
                        )}
                      </div>

                      {isEditing ? (
                        <div className="mt-2 space-y-1.5">
                          <textarea
                            data-slides-comment-edit-input={cm.id}
                            value={editingBody}
                            maxLength={2000}
                            rows={3}
                            onChange={(e) => setEditingBody(e.target.value)}
                            className="w-full resize-none rounded border border-[#3370ff] bg-white px-2 py-1.5 text-[12px] outline-none"
                          />
                          <div className="flex justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingCommentId(null);
                                setEditingBody("");
                              }}
                              className="h-6 rounded border border-[#dee0e3] px-2 text-[11px] text-[#646a73] hover:bg-[#f2f3f5]"
                            >
                              {t("取消")}
                            </button>
                            <button
                              type="button"
                              disabled={isBusy || !editingBody.trim()}
                              onClick={() => void handleSaveEdit(cm)}
                              className="h-6 rounded bg-[#3370ff] px-2.5 text-[11px] font-medium text-white hover:bg-[#245bdb] disabled:opacity-45"
                            >
                              {t("保存")}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[#1f2329]">
                          {cm.body}
                        </p>
                      )}

                      {!isEditing && (canToggleResolve || canEditOrDelete) && (
                        <div className="mt-2.5 flex items-center justify-end gap-1.5 border-t border-[#f2f3f5] pt-2">
                          {canToggleResolve && (
                            <button
                              type="button"
                              disabled={isBusy}
                              data-slides-comment-resolve={cm.id}
                              onClick={() => void handleToggleResolve(cm)}
                              className="inline-flex h-6 items-center gap-1 rounded border border-[#dee0e3] bg-white px-2 text-[11px] text-[#1f2329] hover:border-[#3370ff] hover:text-[#3370ff] disabled:opacity-45"
                            >
                              <CheckCircle2 size={11} />
                              <span>{cm.resolved ? t("重新打开") : t("标记已解决")}</span>
                            </button>
                          )}
                          {canEditOrDelete && (
                            <>
                              <button
                                type="button"
                                disabled={isBusy}
                                data-slides-comment-edit={cm.id}
                                aria-label={t("编辑")}
                                title={t("编辑")}
                                onClick={() => {
                                  setEditingCommentId(cm.id);
                                  setEditingBody(cm.body);
                                }}
                                className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329] disabled:opacity-45"
                              >
                                <Pencil size={11} />
                                <span>{t("编辑")}</span>
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                data-slides-comment-delete={cm.id}
                                aria-label={t("删除")}
                                title={t("删除")}
                                onClick={() => void handleDeleteComment(cm)}
                                className="inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] text-[#646a73] hover:bg-[#fff1f0] hover:text-[#d83931] disabled:opacity-45"
                              >
                                <Trash2 size={11} />
                                <span>{t("删除")}</span>
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4" data-slides-versions-pane>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <History size={14} className="text-[#3370ff]" />
                <span className="font-medium text-[#1f2329]">{t("历史版本")}</span>
              </div>
              <button
                type="button"
                title={t("刷新版本列表")}
                aria-label={t("刷新版本列表")}
                onClick={() => void versionsQuery.refetch()}
                className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
              >
                <RefreshCw size={12} className={versionsQuery.isFetching ? "animate-spin" : ""} />
              </button>
            </div>

            {canEdit ? (
              <form
                onSubmit={(e) => void handleSaveVersion(e)}
                className="space-y-2 rounded-lg border border-[#e5e6eb] bg-[#fafbfc] p-3"
              >
                <label className="grid gap-1">
                  <span className="text-[11px] text-[#646a73]">{t("版本名称（可选）")}</span>
                  <input
                    data-slides-version-input
                    value={versionLabel}
                    maxLength={120}
                    onChange={(e) => setVersionLabel(e.target.value)}
                    placeholder={t("例如：评审定稿 v1")}
                    className="h-8 rounded border border-[#dee0e3] bg-white px-2 text-[12px] outline-none focus:border-[#3370ff]"
                  />
                </label>
                <button
                  type="submit"
                  disabled={savingVersion}
                  data-slides-version-save
                  className="h-8 w-full rounded bg-[#3370ff] font-medium text-white hover:bg-[#245bdb] disabled:opacity-50"
                >
                  {savingVersion ? t("正在保存…") : t("保存版本")}
                </button>
              </form>
            ) : (
              <p className="rounded bg-[#f7f8fa] p-2.5 text-[11px] text-[#8f959e]">
                {t("只读权限下可浏览历史版本，仅编辑者可保存或恢复版本。")}
              </p>
            )}

            {versionError && (
              <p className="rounded bg-[#fff1f0] px-2.5 py-1.5 text-[11px] text-[#cf1322]">
                {versionError}
              </p>
            )}

            <div className="space-y-2">
              <div className="text-[11px] font-medium text-[#646a73]">
                {t("版本快照")} ({versions.length})
              </div>
              {versionsQuery.isLoading ? (
                <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">
                  {t("正在加载历史版本…")}
                </p>
              ) : versionsQuery.isError ? (
                <p className="rounded border border-[#ffccc7] bg-[#fff1f0] px-3 py-4 text-center text-[#cf1322]">
                  {versionsQuery.error instanceof Error
                    ? versionsQuery.error.message
                    : t("加载历史版本失败")}
                </p>
              ) : versions.length === 0 ? (
                <p className="rounded border border-dashed border-[#dee0e3] py-6 text-center text-[#8f959e]">
                  {t("暂无历史版本，点击上方「保存版本」记录当前幻灯片快照")}
                </p>
              ) : (
                versions.map((v) => (
                  <div
                    key={v.id}
                    data-slides-version-item={v.id}
                    className="rounded-md border border-[#e5e6eb] bg-white p-2.5 transition-colors hover:border-[#c9d4ea]"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate font-medium text-[#1f2329]">
                            {v.label || t("未命名版本")}
                          </span>
                          <span
                            data-slides-version-badge={v.autoSaved ? "auto" : "manual"}
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                              v.autoSaved
                                ? "bg-[#fff7e6] text-[#d46b08]"
                                : "bg-[#eef3ff] text-[#3370ff]"
                            }`}
                          >
                            {v.autoSaved ? t("自动备份") : t("手动命名")}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#8f959e]">
                          <span>{v.actorName || `#${v.createdBy}`}</span>
                          <span>·</span>
                          <span>{formatSlidesExtrasTime(v.createdAt)}</span>
                        </div>
                        <div className="mt-1 text-[11px] text-[#646a73]">
                          {t("共 {count} 页", { count: v.pageCount })}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        disabled={!canEdit || restoringVersionId !== null}
                        data-slides-version-restore={v.id}
                        onClick={() => void handleRestoreVersion(v)}
                        className="inline-flex h-7 items-center gap-1 rounded border border-[#dee0e3] bg-white px-2.5 text-[11px] font-medium text-[#1f2329] hover:border-[#3370ff] hover:text-[#3370ff] disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <RotateCcw size={11} />
                        <span>
                          {restoringVersionId === v.id ? t("正在恢复…") : t("恢复此版本")}
                        </span>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
