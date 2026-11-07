import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tx, type OpId, type SyncStatus } from "@jiange/collab";
import { docsApi, type DocMeta, type Me } from "@/lib/api";
import { colorFor, type Presence } from "@/lib/presence";
import { useSyncDoc, type RemotePeer } from "@/lib/useSyncDoc";
import { CollabText } from "@/components/CollabText";
import { Editor, type ExternalUndoRecorder } from "@/editor/Editor";
import { replaceMatches } from "@/editor/findReplace";
import { FindScrollIntent } from "@/editor/findNavigation";
import { preflightFindReplace } from "@/editor/findReplaceSafety";
import { scrollToCommentAnchor } from "@/editor/commentAnchor";
import { scheduleFindSnapshot, type FindSnapshot } from "@/editor/findSearchScheduler";
import { FindReplacePanel, type FindReplaceMode } from "@/editor/FindReplacePanel";
import { Avatar } from "@/components/brand";
import { AddIcon, BuildingIcon, DownBoldIcon, EditIcon, MoreIcon, SearchIcon } from "@/components/FeishuIcons";
import { StarterTemplates, type StarterTemplate } from "./StarterTemplates";
import { TitleConsistency } from "./TitleConsistency";
import { hasUnsupportedImportBlocks, insertStarterTemplate, isEmptyStarterDocument } from "./starterTemplateOps";
import { peekStarter, takeStarter } from "./pendingStarter";
import { BaseIcon, docTitle, DocIcon, hrefOf } from "@/components/Sidebar";
import { go } from "@/lib/route";
import { cn } from "@/lib/utils";
import { NotificationBell } from "./NotificationBell";
import { Button } from "@/components/ui/button";
import { ShareDialog } from "@/components/ShareDialog";
import { DocumentIconEditor } from "@/components/DocumentIconEditor";
import { DocumentCover } from "@/components/DocumentCover";
import { DocumentGlyph, displayDocumentIcon } from "@/components/DocumentGlyph";
import { publishDocumentIcon } from "@/components/documentIconCache";
import { ask } from "@/components/ui/ask";
import { VersionPanel } from "./VersionPanel";
import { CommentsPanel, type CommentAnchor, type CommentRecovery } from "./CommentsPanel";
import { canWriteComments, commentListKey, commentMembersKey, CommentDraftJournal, CommentRecoveryGate, matchesCommentTarget, mayExportCommentDraftData, mayRetainCommentQuote, mergeRecoveredCommentDrafts, mustRedactCommentAttemptQuote, newCommentSession, redactCommentDraftQuote, revalidateCurrentCommentPolicy, type CommentTarget } from "./commentAccess";
import { browserCommentDraftEnvironment, commentDraftStorageReady, CommentDraftStorage } from "./commentDraftStorage";
import { browserCommentAttemptEnvironment, CommentAttemptStore } from "./commentAttempts";
import { CommentAttemptDocumentDenied, requireCommentAttempts } from "./commentAttemptApi";
import { CommentAttemptRecovery } from "./CommentAttemptRecovery";
import { OutlinePanel, outlineOf, type OutlineItem } from "./OutlinePanel";
import { AttachmentPreview } from "./AttachmentPreview";
import { commentsApi, extrasApi } from "@/lib/api";
import { parseMarkdown, viewToMarkdown } from "@/lib/markdown";
import { appendMarkdownOps } from "@/lib/mdImport";
import { readAccountDraftBackups } from "@/lib/pendingOpsStorage";
import { createVisitRecorder } from "@/lib/recentVisit";
import { docMetaKey, docMetaState, isDocAccessDenied, shouldRetryDocMeta } from "./docMetaState";
import { canCopyContent, canCopyDocument, canDownloadDocument, copyErrorMessage, mayUseDownloadRecheck, pendingDocumentBackup } from "./documentCopy";
import { markdownExportLosses } from "./markdownExport";
import { Check, Eye, MessageSquare, Star } from "lucide-react";

// Every document starts with these two blocks (server: syncsrv.InitialOps).
const TITLE: OpId = { client: 0, clock: 1 };

export function DocPage({ id, me }: { id: number; me: Me }) {
  const qc = useQueryClient();
  const meta = useQuery({
    queryKey: docMetaKey(id, me.user.id),
    queryFn: () => docsApi.get(id),
    retry: shouldRetryDocMeta,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
    // A server restart does not necessarily trigger the browser's online event.
    // Retry temporary failures while this page is visible; do not retry a
    // definitive access denial without a fresh user action.
    refetchInterval: (query) => query.state.error ? (isDocAccessDenied(query.state.error) ? false : 5000) : 15000,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const sync = useSyncDoc(id, me.user.id);
  const [visiblePolicyVerified, setVisiblePolicyVerified] = useState(() => typeof document !== "undefined" && document.visibilityState !== "hidden");
  const policyUpdatedAt = useRef(meta.dataUpdatedAt);
  const requiredPolicyUpdateAfter = useRef(0);
  policyUpdatedAt.current = meta.dataUpdatedAt;
  useEffect(() => {
    let active = true;
    let generation = 0;
    const visibility = () => {
      const turn = ++generation;
      setVisiblePolicyVerified(false);
      requiredPolicyUpdateAfter.current = policyUpdatedAt.current;
      if (document.visibilityState === "hidden") return;
      void meta.refetch().then((result) => {
        if (active && turn === generation && document.visibilityState !== "hidden") setVisiblePolicyVerified(result.isSuccess && !result.isError);
      }).catch(() => {});
    };
    document.addEventListener("visibilitychange", visibility);
    return () => { active = false; generation++; document.removeEventListener("visibilitychange", visibility); };
  }, [id, me.user.id, meta.refetch]);
  const metadataState = docMetaState(meta.data, meta.isError, meta.error);
  const metadataVerified = metadataState === "ready";
  // Identity guard for late icon updates. A metadata poll in flight is not
  // an authorization failure: icon writes perform their own fresh role check.
  const iconIdentity = useRef({ id, user: me.user.id, mounted: true, denied: false });
  iconIdentity.current.denied = metadataState === "denied";
  useLayoutEffect(() => {
    iconIdentity.current = { id, user: me.user.id, mounted: true, denied: metadataState === "denied" };
    return () => { iconIdentity.current.mounted = false; };
  }, [id, me.user.id]);
  useEffect(() => {
    // If the first foreground check failed, a later successful polling retry
    // can restore access without needing another visibility transition.
    if (!visiblePolicyVerified && metadataVerified && !meta.isFetching && document.visibilityState !== "hidden" && meta.dataUpdatedAt > requiredPolicyUpdateAfter.current) setVisiblePolicyVerified(true);
  }, [visiblePolicyVerified, metadataVerified, meta.isFetching, meta.dataUpdatedAt]);
  // A cached policy is not proof while revalidation is in flight. Editing and
  // local drafts stay available; only content-exporting interactions pause.
  const permissionsVerified = metadataVerified && !meta.isFetching && visiblePolicyVerified;
  const contentCopyAllowed = permissionsVerified && canCopyContent(meta.data);
  const downloadAllowed = permissionsVerified && canDownloadDocument(meta.data);
  const exportContext = useRef({ id, user: me.user.id, client: sync.client, verified: permissionsVerified, meta: meta.data, mounted: true });
  const exportingMarkdown = useRef(false);
  const [exportNotice, setExportNotice] = useState<{ id: number; user: number; text: string } | null>(null);
  useLayoutEffect(() => {
    exportContext.current = { id, user: me.user.id, client: sync.client, verified: permissionsVerified, meta: meta.data, mounted: true };
    return () => { exportContext.current.mounted = false; };
  }, [id, me.user.id, sync.client, permissionsVerified, meta.data]);
  const visitRecorder = useMemo(() => createVisitRecorder(
    () => docsApi.recordVisit(id),
    () => { void qc.invalidateQueries({ queryKey: ["recent"] }); },
    () => { void qc.invalidateQueries({ queryKey: docMetaKey(id, me.user.id) }); },
  ), [id, me.user.id, qc]);
  useEffect(() => {
    if (!metadataVerified) return;
    visitRecorder.start();
    return () => visitRecorder.stop();
  }, [metadataVerified, visitRecorder]);
  const wasCaughtUp = useRef(false);
  useEffect(() => {
    // Also recover if the service returns while the browser remains online.
    if (sync.caughtUp && !wasCaughtUp.current && meta.isError && !isDocAccessDenied(meta.error)) void meta.refetch();
    wasCaughtUp.current = sync.caughtUp;
  }, [sync.caughtUp, meta.isError, meta.error, meta.refetch]);
  const presence = useMemo<Presence>(() => ({ name: me.user.name, color: colorFor(me.user.id - 1) }), [me.user]);
  const body = useRef<HTMLDivElement>(null);
  const shareAnchor = useRef<HTMLButtonElement>(null);
  const recordExternalUndo = useRef<ExternalUndoRecorder | null>(null);
  const onUndoRegistrar = useCallback((record: ExternalUndoRecorder | null) => { recordExternalUndo.current = record; }, []);
  const canEditRef = useRef(false);
  const submittedStarter = useRef(false);
  const [pendingSubmitted, setPendingSubmitted] = useState(false);
  const [, setPendingRevision] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [titleCheckTarget, setTitleCheckTarget] = useState<{ doc: number; user: number } | null>(null);
  useEffect(() => { setTitleCheckTarget(null); }, [id, me.user.id, metadataVerified]);
  useEffect(() => { if (!metadataVerified) setSharing(false); }, [metadataVerified]);
  const [history, setHistory] = useState(false);
  const [commentsTarget, setCommentsTarget] = useState<CommentTarget | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [preview, setPreview] = useState<{ src: string; alt: string; mime?: string } | null>(null);
  const [draft, setDraft] = useState<CommentAnchor | null>(null);
  const [activeThread, setActiveThread] = useState<number | null>(null);
  const pendingCommentScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (activeThread !== null && pendingCommentScroll.current === activeThread) {
      pendingCommentScroll.current = null;
      scrollToCommentAnchor(body.current, activeThread);
    }
  }, [activeThread]);
  const [templatesHidden, setTemplatesHidden] = useState(false);
  const [templateError, setTemplateError] = useState("");
  const [readingMode, setReadingMode] = useState(false);
  const [retryingSync, setRetryingSync] = useState(false);
  const [retrySyncError, setRetrySyncError] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findMode, setFindMode] = useState<FindReplaceMode>("find");
  const [findQuery, setFindQuery] = useState("");
  const [findReplacement, setFindReplacement] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [findMessage, setFindMessage] = useState("");
  const [findNavigation, setFindNavigation] = useState(0);
  const [findResult, setFindResult] = useState<FindSnapshot | null>(null);
  const findScrollIntent = useRef(new FindScrollIntent());
  const findPanel = useRef<HTMLDivElement>(null);
  const newDoc = useMutation({ mutationFn: () => docsApi.create(""), onSuccess: (d) => { qc.invalidateQueries({ queryKey: ["docs"] }); go(hrefOf(d)); } });
  // A fresh namespace prevents an earlier authorization period (or another
  // account) from displaying cached comments after access is revalidated.
  const [commentRevision, setCommentRevision] = useState(0);
  const [commentDenial, setCommentDenial] = useState<CommentTarget | null>(null);
  const commentDraftJournal = useRef(new CommentDraftJournal());
  const commentStorage = useRef<{ doc: number; user: number; value: CommentDraftStorage } | null>(null);
  const commentStorageGeneration = useRef(0);
  const [commentStoragePrepared, setCommentStoragePrepared] = useState<(CommentTarget & { generation: number }) | null>(null);
  const [commentStorageNotice, setCommentStorageNotice] = useState<{ doc: number; user: number; text: string } | null>(null);
  const [commentStorageDamaged, setCommentStorageDamaged] = useState<{ doc: number; user: number; count: number } | null>(null);
  const [commentRecovery, setCommentRecovery] = useState<{ doc: number; user: number; values: CommentRecovery[] } | null>(null);
  useEffect(() => { setCommentRecovery(null); setCommentStorageNotice(null); setCommentStorageDamaged(null); }, [id, me.user.id]);
  const commentRecoveryGate = useRef(new CommentRecoveryGate());
  const commentSession = useMemo(() => newCommentSession(), [id, me.user.id, metadataVerified, commentRevision]);
  const commentIdentity = useRef<CommentTarget>({ doc: id, user: me.user.id, session: commentSession });
  commentIdentity.current = { doc: id, user: me.user.id, session: commentSession };
  const commentsOpen = matchesCommentTarget(commentsTarget, id, me.user.id, commentSession);
  const commentSuspended = matchesCommentTarget(commentDenial, id, me.user.id, commentSession);
  const comments = useQuery({ queryKey: commentListKey(id, me.user.id, commentSession), queryFn: () => commentsApi.list(id), enabled: metadataVerified && !commentSuspended, refetchInterval: 5000, refetchIntervalInBackground: false });
  const members = useQuery({ queryKey: commentMembersKey(id, me.user.id, commentSession), queryFn: () => commentsApi.members(id), enabled: metadataVerified && !commentSuspended });
  const commentAccessDenied = (comments.isError && isDocAccessDenied(comments.error)) || (members.isError && isDocAccessDenied(members.error)) || commentSuspended;
  const commentsAvailable = metadataVerified && !commentAccessDenied && comments.isSuccess && members.isSuccess;
  const commentDraftExportAllowed = mayExportCommentDraftData(meta.data, permissionsVerified, commentsAvailable);
  const commentDraftExportAllowedRef = useRef(false);
  commentDraftExportAllowedRef.current = commentDraftExportAllowed;
  const commentQuoteAllowed = commentsAvailable && contentCopyAllowed;
  const commentQuoteAllowedRef = useRef(false);
  // A transient refetch pauses displaying/copying quotes but must not erase a
  // user's existing draft anchor while they are typing. A failed or denied
  // verification still redacts it before any later persistence.
  commentQuoteAllowedRef.current = mayRetainCommentQuote(meta.data, metadataVerified, commentsAvailable);
  const commentAttempts = useMemo(() => {
    try { return typeof window === "undefined" ? null : new CommentAttemptStore(browserCommentAttemptEnvironment(), id, me.user.id); }
    catch { return null; }
  }, [id, me.user.id]);
  // Once access has been checked, protected document quotes may not remain in
  // our durable submission journal. The attempt ID is kept and may only be
  // queried, not replayed with a modified payload.
  const redactAttemptQuotes = mustRedactCommentAttemptQuote(meta.data, metadataVerified, metadataState === "denied", commentAccessDenied);
  useEffect(() => {
    if (!commentAttempts || !redactAttemptQuotes) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const redact = async () => {
      // Metadata requests can be made with a newly switched account's cookie
      // in another tab. Never destroy the old account's immutable request based
      // on that unbound result; verify the original account with the server.
      let denied = false;
      try { denied = !(await requireCommentAttempts(id, me.user.id)).canCopyQuote; }
      catch (error) { denied = error instanceof CommentAttemptDocumentDenied; }
      if (!active || !denied) return;
      void commentAttempts.redactQuotes().then((complete) => {
      if (!active) return;
      if (!complete) {
        setCommentStorageNotice({ doc: id, user: me.user.id, text: "部分受保护的引用记录属于其他标签或无法安全更新，原记录已保留。" });
        timer = setTimeout(redact, 2000);
      } else setCommentStorageNotice((previous) => previous?.doc === id && previous.user === me.user.id && previous.text === "部分受保护的引用记录属于其他标签或无法安全更新，原记录已保留。" ? null : previous);
      }).catch(() => { if (active) timer = setTimeout(redact, 2000); });
    };
    void redact();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [commentAttempts, redactAttemptQuotes, id, me.user.id]);
  const commentStorageReady = commentDraftStorageReady(commentStoragePrepared, { doc: id, user: me.user.id, session: commentSession }, commentStorageGeneration.current, commentsAvailable);
  const persistCommentDrafts = useCallback(() => {
    const active = commentStorage.current;
    if (!active || active.doc !== id || active.user !== me.user.id) return;
    try {
      active.value.write(commentDraftJournal.current.list(id, me.user.id), commentDraftJournal.current.recovered(id, me.user.id));
      setCommentStorageNotice((previous) => previous?.doc === id && previous.user === me.user.id && previous.text === "评论草稿无法保存到本机，关闭页面前请复制草稿。" ? null : previous);
    } catch {
      setCommentStorageNotice({ doc: id, user: me.user.id, text: "评论草稿无法保存到本机，关闭页面前请复制草稿。" });
    }
  }, [id, me.user.id]);
  const freezeCommentDrafts = useCallback(() => {
    const own = commentDraftJournal.current.freeze(id, me.user.id);
    const active = commentStorage.current;
    const values = active?.doc === id && active.user === me.user.id ? mergeRecoveredCommentDrafts(own, active.value.read()) : own;
    if (values.length) setCommentRecovery({ doc: id, user: me.user.id, values });
    persistCommentDrafts();
  }, [id, me.user.id, persistCommentDrafts]);
  const revalidateCommentAccess = useCallback((recovery?: CommentRecovery) => {
    const target = { doc: id, user: me.user.id, session: commentSession };
    if (!matchesCommentTarget(commentIdentity.current, target.doc, target.user, target.session)) return;
    if (recovery?.text.trim()) commentDraftJournal.current.save(id, me.user.id, redactCommentDraftQuote(recovery, commentQuoteAllowedRef.current));
    freezeCommentDrafts();
    setCommentDenial(target);
    setCommentsTarget(null);
    setDraft(null);
    setActiveThread(null);
    pendingCommentScroll.current = null;
    if (!commentRecoveryGate.current.begin()) return;
    void meta.refetch().then((result) => {
      if (!result.isError && matchesCommentTarget(commentIdentity.current, target.doc, target.user, target.session)) {
        // Reopen only through fresh list/member requests in a new namespace;
        // an editor downgraded to viewer can then read authorized comments.
        setCommentRevision((value) => value + 1);
      }
    });
  }, [id, me.user.id, commentSession, meta.refetch, freezeCommentDrafts]);
  useEffect(() => {
    if (comments.isSuccess && members.isSuccess) commentRecoveryGate.current.reset();
  }, [commentSession, comments.isSuccess, members.isSuccess]);
  useEffect(() => {
    if ((comments.isError && isDocAccessDenied(comments.error)) || (members.isError && isDocAccessDenied(members.error))) revalidateCommentAccess();
  }, [comments.isError, comments.error, members.isError, members.error, revalidateCommentAccess]);
  useEffect(() => {
    setCommentsTarget(null);
    setDraft(null);
    setActiveThread(null);
    pendingCommentScroll.current = null;
  }, [id, me.user.id, metadataVerified, commentAccessDenied]);
  useEffect(() => {
    if (!commentsAvailable) freezeCommentDrafts();
    else {
      const values = commentDraftJournal.current.recovered(id, me.user.id);
      if (values.length) setCommentRecovery({ doc: id, user: me.user.id, values });
    }
  }, [commentsAvailable, freezeCommentDrafts]);
  // Read local drafts only after this account's document and comment access
  // have both been verified. Each page owns a unique, exclusively leased key.
  useEffect(() => {
    if (!commentsAvailable) return;
    let cancelled = false;
    let opened: CommentDraftStorage | null = null;
    const generation = ++commentStorageGeneration.current;
    const doc = id, user = me.user.id, session = commentSession;
    setCommentStorageNotice({ doc, user, text: "正在准备评论草稿的本机保存。" });
    void CommentDraftStorage.open(browserCommentDraftEnvironment, doc, user).then((value) => {
      if (cancelled || !matchesCommentTarget(commentIdentity.current, doc, user, session)) { value.close(); return; }
      opened = value;
      commentStorage.current = { doc, user, value };
      try {
        value.write(commentDraftJournal.current.list(doc, user), commentDraftJournal.current.recovered(doc, user));
        const values = mergeRecoveredCommentDrafts(commentDraftJournal.current.recovered(doc, user), value.read());
        setCommentRecovery(values.length ? { doc, user, values } : null);
        setCommentStorageDamaged(value.damaged().length ? { doc, user, count: value.damaged().length } : null);
        setCommentStorageNotice(value.canClearOtherTabs() ? null : { doc, user, text: "此浏览器无法安全清除其他标签页的草稿，已保留这些记录。" });
        setCommentStoragePrepared({ doc, user, session, generation });
      } catch {
        setCommentStorageNotice({ doc, user, text: "评论草稿无法保存到本机，关闭页面前请复制草稿。" });
        setCommentStoragePrepared({ doc, user, session, generation });
      }
    }).catch(() => {
      if (!cancelled && matchesCommentTarget(commentIdentity.current, doc, user, session)) {
        setCommentStorageNotice({ doc, user, text: "评论草稿无法保存到本机，关闭页面前请复制草稿。" });
        setCommentStoragePrepared({ doc, user, session, generation });
      }
    });
    return () => {
      cancelled = true;
      if (commentStorageGeneration.current === generation) commentStorageGeneration.current++;
      const active = commentStorage.current;
      if (active?.value === opened) { active.value.close(); commentStorage.current = null; }
    };
  }, [commentsAvailable, id, me.user.id, commentSession]);
  const ancestors = useQuery({ queryKey: ["ancestors", id], queryFn: () => extrasApi.ancestors(id) });
  const outline: OutlineItem[] = useMemo(() => {
    const d = sync.client.doc;
    if (!d) return [];
    const view = d.view();
    return outlineOf(view.blocks.map((b) => ({ id: b.id, type: b.type, spans: b.spans })));
  }, [sync.client.doc, sync.version, outlineOpen]);

  const wordCount = useMemo(() => {
    const d = sync.client.doc;
    if (!d) return 0;
    let n = 0;
    for (const b of d.view().blocks) {
      if (b.type === "title") continue;
      for (const span of b.spans) n += [...span.text].length;
    }
    return n;
  }, [sync.client.doc, sync.version]);
  const exportMd = async () => {
    if (exportingMarkdown.current || !permissionsVerified || !canCopyDocument(meta.data)) return;
    const d = sync.client.doc;
    if (!d) return;
    if (!sync.client.caughtUp || sync.client.blocked) {
      setExportNotice({ id, user: me.user.id, text: "文档尚未完成同步，请同步完成后再导出。" });
      return;
    }
    const view = d.view();
    const snapshot = JSON.stringify(view);
    const losses = markdownExportLosses(view);
    exportingMarkdown.current = true;
    setExportNotice(null);
    try {
      if (losses.length && !await ask("Markdown 导出可能丢失内容", `${losses.join("；")}。仍要下载吗？`, false)) return;
      const before = exportContext.current;
      if (!before.mounted || before.id !== id || before.user !== me.user.id || before.client !== sync.client || before.client.doc !== d || !before.verified || !canCopyDocument(before.meta)) return;
      // Confirm access with the server after the dialog. The cached policy may
      // have been tightened while the user was reading the confirmation.
      const latest = await docsApi.get(id);
      const current = exportContext.current;
      if (!current.mounted || current.id !== id || current.user !== me.user.id || current.client !== sync.client || current.client.doc !== d || !current.verified || !canCopyDocument(current.meta)) return;
      // Do not replace a newer cache value with the result of an older request.
      if (!mayUseDownloadRecheck(id, before.meta, current.meta, latest)) {
        if (current.meta === before.meta && latest.id === id) {
          qc.setQueryData(docMetaKey(id, me.user.id), latest);
          setExportNotice({ id, user: me.user.id, text: "下载权限已变化，无法导出。" });
        }
        return;
      }
      qc.setQueryData(docMetaKey(id, me.user.id), latest);
      if (!current.client.caughtUp || current.client.blocked) {
        setExportNotice({ id, user: me.user.id, text: "文档同步状态已变化，请同步完成后重新导出。" });
        return;
      }
      if (JSON.stringify(d.view()) !== snapshot) {
        setExportNotice({ id, user: me.user.id, text: "文档内容已变化，请重新导出并确认。" });
        return;
      }
      const md = viewToMarkdown(view);
      const a = document.createElement("a");
      const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
      try {
        a.href = url;
        a.download = `${(title || current.meta?.title || "未命名").trim() || "未命名"}.md`;
        a.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch {
      if (exportContext.current.mounted && exportContext.current.id === id && exportContext.current.user === me.user.id) setExportNotice({ id, user: me.user.id, text: "导出失败，请重试。" });
    } finally {
      exportingMarkdown.current = false;
    }
  };
  const importMd = async (file: File) => {
    const d = sync.client.doc;
    if (!d) return;
    let md: string;
    try { md = await file.text(); } catch { setTemplateError("读取文件失败，请重试。"); return; }
    if (!canEditRef.current) { setTemplateError("当前为只读状态，无法导入。"); return; }
    if (!sync.client.caughtUp || sync.client.status !== "synced") { setTemplateError("请等待文档同步完成后再导入。"); return; }
    if (!parseMarkdown(md).length) { setTemplateError("文件没有可导入的内容。"); return; }
    if (hasUnsupportedImportBlocks(md)) { setTemplateError("暂不支持导入图片，请先移除图片内容。"); return; }
    if (d !== sync.client.doc || !canEditRef.current || !sync.client.caughtUp || sync.client.status !== "synced" || !recordExternalUndo.current) { setTemplateError("文档同步状态已改变，请重新导入。"); return; }
    const tx = appendMarkdownOps(d, md);
    if (tx.ops.length) { recordExternalUndo.current(tx, { preserveCreatedBlocks: true }); sync.client.push(tx.ops); }
    setTemplateError("");
  };
  const allDocs = useQuery({ queryKey: ["docs"], queryFn: docsApi.list });
  const mentionDocs = useMemo(() => (allDocs.data ?? []).filter((d) => d.id !== id).map((d) => ({ id: d.id, title: d.title })), [allDocs.data, id]);
  // Commenting and editing are separate capabilities: a viewer may comment
  // without ever gaining permission to modify the document.
  const canEditRole = metadataVerified && (meta.data?.role === "edit" || meta.data?.role === "manage");
  const canComment = metadataVerified && canWriteComments(meta.data);
  // Keep the composer mounted while policy is being revalidated so the local
  // draft and selection survive, but do not submit using stale permissions.
  const canSubmitComment = permissionsVerified && canComment;
  useEffect(() => { if (!canComment) freezeCommentDrafts(); }, [canComment, freezeCommentDrafts]);
  const canEditContent = canEditRole && !readingMode && !sync.blocked;
  canEditRef.current = canEditContent;
  const findDoc = sync.client.doc;
  const currentFindResult = findOpen && findDoc && findQuery && findResult?.doc === findDoc && findResult.query === findQuery && findResult.version === sync.version ? findResult : null;
  const findUpdating = !!(findOpen && findDoc && findQuery && !currentFindResult);
  const matches = currentFindResult?.matches ?? [];
  useEffect(() => {
    if (!findOpen || !findDoc || !findQuery || currentFindResult) return;
    // Coalesce bursts of local and remote edits. Stale results are not shown or
    // available for replacement while this snapshot is being recomputed.
    return scheduleFindSnapshot(findDoc, findQuery, sync.version, setFindResult);
  }, [findOpen, findDoc, findQuery, sync.version, currentFindResult]);
  const activeFindIndex = matches.length ? Math.max(0, Math.min(findIndex, matches.length - 1)) : -1;
  const activeMatch = activeFindIndex >= 0 ? matches[activeFindIndex] : null;
  // Large result sets remain fully navigable without creating tens of thousands
  // of markup nodes inside the contenteditable document.
  const displayedMatches = matches.length > 500 ? (activeMatch ? [activeMatch] : []) : matches;
  const findCanReplace = !findUpdating && canEditContent && sync.caughtUp && sync.status === "synced" && sync.client.unacked === 0;
  const requestFindScroll = useCallback(() => setFindNavigation(findScrollIntent.current.request()), []);
  const openFind = useCallback((mode: FindReplaceMode) => {
    setFindMode(mode);
    setFindOpen(true);
    setFindMessage("");
    requestFindScroll();
    // Focus an already-open panel for repeated keyboard shortcuts; the panel
    // itself handles initial desktop focus and avoids summoning a phone keyboard.
    if (findOpen) requestAnimationFrame(() => findPanel.current?.querySelector<HTMLInputElement>("input")?.focus());
  }, [findOpen, requestFindScroll]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f" && !event.isComposing) {
        event.preventDefault();
        openFind("find");
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [openFind]);
  useEffect(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindReplacement("");
    setFindIndex(0);
    setFindMessage("");
  }, [id]);
  useEffect(() => {
    if (!findOpen) return;
    const ticket = findScrollIntent.current.pending(!findUpdating);
    if (ticket === null) return;
    if (activeFindIndex < 0) { findScrollIntent.current.complete(ticket); return; }
    const frame = requestAnimationFrame(() => {
      if (findScrollIntent.current.complete(ticket)) body.current?.querySelector<HTMLElement>('[data-find-active="true"]')?.scrollIntoView({ block: "center", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [findOpen, activeFindIndex, findNavigation, findUpdating]);
  const blankBody = !!sync.client.doc && isEmptyStarterDocument(sync.client.doc);
  const pendingStarter = peekStarter(me.user.id, id);
  const pendingImport = !!pendingStarter;
  const showTemplates = !!meta.data && sync.ready && sync.caughtUp && sync.client.droppedOnResync === 0 && sync.status === "synced" && canEditContent && blankBody && !templatesHidden && !pendingImport;
  const applyPendingStarter = () => {
    const content = peekStarter(me.user.id, id);
    const doc = sync.client.doc;
    if (!content || !doc || submittedStarter.current) return;
    if (!canEditRef.current || !sync.client.caughtUp || sync.client.status !== "synced" || sync.client.droppedOnResync > 0 || !recordExternalUndo.current) { setTemplateError("文档当前无法安全导入，请检查编辑权限和同步状态。"); return; }
    submittedStarter.current = true;
    const tx = insertStarterTemplate(doc, content.markdown);
    if (!tx) { submittedStarter.current = false; setTemplateError("文档已有内容或含不支持的内容，未导入。原文已保留。"); return; }
    recordExternalUndo.current(tx, { preserveCreatedBlocks: true });
    setPendingSubmitted(true);
    setTemplateError("");
    sync.client.push(tx.ops);
  };
  const applyStarter = (template: StarterTemplate) => {
    const doc = sync.client.doc;
    if (!doc || !canEditContent || !sync.caughtUp || sync.client.droppedOnResync > 0 || sync.status !== "synced" || !recordExternalUndo.current) return;
    const tx = insertStarterTemplate(doc, template.body);
    if (!tx) { setTemplateError("文档已有内容，未插入模板。"); return; }
    setTemplateError("");
    recordExternalUndo.current(tx, { preserveCreatedBlocks: true });
    sync.client.push(tx.ops);
  };

  useEffect(() => {
    qc.invalidateQueries({ queryKey: ["docs"] });
  }, [qc, id]);
  useEffect(() => {
    sync.client.setAwareness({ ...presence, cursor: null });
  }, [sync.client, presence]);

  // mirror the collaborative title into directory metadata (debounced)
  const renameTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(renameTimer.current), [id, me.user.id]);
  const onTitle = (t: string) => {
    clearTimeout(renameTimer.current);
    renameTimer.current = setTimeout(async () => {
      if (!canEditRef.current) return;
      try {
        const d = await docsApi.rename(id, t);
        qc.setQueryData(docMetaKey(id, me.user.id), d);
        qc.setQueryData<DocMeta[]>(["docs"], (old) => old?.map((x) => (x.id === id ? d : x)));
      } catch { void qc.invalidateQueries({ queryKey: docMetaKey(id, me.user.id) }); }
    }, 400);
  };
  const live = sync.client.doc?.hasBlock(TITLE) ? sync.client.doc : null;
  const title = live ? live.text(TITLE) : (meta.data?.title ?? "");
  useEffect(() => {
    document.title = `${title.trim() || "未命名文档"} - Jiange`;
  }, [title]);

  const downloadPending = () => {
    // Preserve the user's unacknowledged operations without embedding the
    // server replica, whose download permission might have changed offline.
    const backup = pendingDocumentBackup(me.user.id, id, sync.client.clientId, sync.client.pendingOps());
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
    a.download = `jiange-unsynced-${id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const downloadStoredDrafts = () => {
    try {
      const records = readAccountDraftBackups(localStorage, me.user.id, id);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, userId: me.user.id, docId: id, records })], { type: "application/json" }));
      a.download = `jiange-local-drafts-${id}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch { setRetrySyncError("无法读取本账号的本地草稿，请检查浏览器存储权限。"); }
  };
  const retryPending = async () => {
    if (sync.client.blocked === "missing_dependency" || sync.client.blocked === "invalid_history") {
      setRetrySyncError("所需历史尚未恢复，请先下载本地备份并联系管理员。");
      return;
    }
    setRetryingSync(true);
    setRetrySyncError("");
    try {
      const result = await meta.refetch();
      if (result.isError || (result.data?.role !== "edit" && result.data?.role !== "manage")) {
        setRetrySyncError(result.isError && !isDocAccessDenied(result.error) ? "暂时无法连接服务器，未同步内容仍保留在本地。" : "当前没有编辑权限，请联系文档所有者。未同步内容仍保留在本地。");
      } else if (!sync.client.caughtUp || sync.client.status === "offline" || sync.client.status === "connecting") {
        setRetrySyncError("请等待连接和文档同步完成后重试。");
      } else sync.client.retryPending();
    } finally { setRetryingSync(false); }
  };
  if (metadataState === "loading") return <div className="grid flex-1 place-items-center text-muted-foreground">正在加载文档…</div>;
  if (metadataState === "denied" || metadataState === "retry") {
    const hasPending = sync.client.unacked > 0;
    return <div className="grid flex-1 place-items-center px-6" role="alert">
      <div className="max-w-md text-center text-[14px] text-muted-foreground">
        <p>{metadataState === "denied" ? "文档不存在或无权访问。" : "暂时无法连接服务器，请稍后重试。"}</p>
        <CommentAttemptRecovery store={commentAttempts} userId={me.user.id} />
        {hasPending && <p className="mt-3">未同步的修改仍保留在本地，尚未保存到云端。 <button type="button" onClick={downloadPending} className="text-primary underline">下载本地备份</button></p>}
        {sync.storageError && <p className="mt-3">浏览器存储不可用或本地草稿损坏，关闭页面后可能无法恢复。</p>}
        {sync.otherPending && <p className="mt-3">本账号还有其他本地草稿。 <button type="button" onClick={downloadStoredDrafts} className="text-primary underline">下载本账号草稿备份</button></p>}
        {sync.legacyPending && <p className="mt-3">存在无法确认账号归属的旧版离线记录，请联系管理员安全恢复。</p>}
        {retrySyncError && <p className="mt-3">{retrySyncError}</p>}
        <button type="button" className="mt-4 rounded-md border px-3 py-1.5 text-foreground hover:bg-hover" disabled={meta.isFetching} onClick={() => void meta.refetch()}>{meta.isFetching ? "正在重试…" : "重试"}</button>
      </div>
    </div>;
  }
  const replaceFound = (all: boolean) => {
    const doc = sync.client.doc;
    if (!doc || findUpdating || !currentFindResult || currentFindResult.doc !== doc || !canEditRef.current || sync.client.blocked || !sync.client.caughtUp || sync.client.status !== "synced" || sync.client.unacked !== 0 || !recordExternalUndo.current) {
      setFindMessage("请等待文档同步完成并确认有编辑权限后重试。");
      return;
    }
    const selected = all ? matches : activeMatch ? [activeMatch] : [];
    if (!selected.length) return;
    const preflight = preflightFindReplace(doc, selected, findReplacement);
    if (!preflight.ok) {
      setFindMessage(preflight.reason === "preflight" ? "无法安全检查替换内容，请重试；文档未修改。" : "替换内容或匹配范围过大，请缩小查找范围或缩短替换内容后重试；文档未修改。");
      return;
    }
    const tx = new Tx(doc);
    const result = replaceMatches(tx, selected, findReplacement);
    if (tx.ops.length) {
      recordExternalUndo.current(tx, { preserveFocus: true });
      sync.client.push(tx.ops);
    }
    setFindIndex(all ? 0 : Math.max(activeFindIndex, 0));
    setFindMessage(result.skipped ? `已替换 ${result.replaced} 处，${result.skipped} 处内容已变化，请重新查找。` : `已替换 ${result.replaced} 处。`);
  };

  return (
    <div className="flex min-w-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar
          ancestors={ancestors.data ?? []}
          shareAnchor={shareAnchor}
          onShare={() => setSharing((v) => !v)}
          onComments={() => {
            if (commentAccessDenied) { commentRecoveryGate.current.reset(); revalidateCommentAccess(); return; }
            if (commentsOpen) freezeCommentDrafts();
            setCommentsTarget(commentsOpen ? null : { doc: id, user: me.user.id, session: commentSession });
          }}
          onFind={() => openFind("replace")}
          readingMode={readingMode}
          onToggleReading={() => setReadingMode((value) => !value)}
          onCreate={() => newDoc.mutate()}
          creating={newDoc.isPending}
          onHistory={() => setHistory((v) => !v)}
          onTitleCheck={() => setTitleCheckTarget({ doc: id, user: me.user.id })}
          onExport={downloadAllowed ? exportMd : undefined}
          onImport={canEditContent ? importMd : undefined}
          onOutline={() => setOutlineOpen((v) => !v)}
          readOnly={!canEditRole}
          allowContentCopy={contentCopyAllowed}
          allowDocumentPrint={downloadAllowed}
          metadataVerified={metadataVerified}
          meta={meta.data}
          title={title}
          workspace={meta.data?.workspaceName || me.workspaces[0]?.name || "我的空间"}
          status={metadataVerified ? sync.status : "offline"}
          peers={sync.peers}
          me={presence}
          wordCount={wordCount}
        />
        {newDoc.isError && <p role="alert" className="border-b px-5 py-2 text-[13px] text-destructive">新建文档失败，请稍后重试。</p>}
        {exportNotice?.id === id && exportNotice.user === me.user.id && <p role="alert" className="border-b px-5 py-2 text-[13px] text-destructive">{exportNotice.text}</p>}
        {metadataVerified && commentAccessDenied && <div role="alert" className="border-b px-5 py-2 text-[13px] text-muted-foreground">评论暂不可用。 <button type="button" disabled={meta.isFetching} className="text-primary underline disabled:opacity-50" onClick={() => { commentRecoveryGate.current.reset(); revalidateCommentAccess(); }}>重新验证</button><CommentAttemptRecovery store={commentAttempts} userId={me.user.id} /></div>}
        {metadataVerified && commentStorageNotice?.doc === id && commentStorageNotice.user === me.user.id && <p role="status" className="border-b px-5 py-2 text-[13px] text-muted-foreground">{commentStorageNotice.text}</p>}
        {commentsAvailable && commentStorageDamaged?.doc === id && commentStorageDamaged.user === me.user.id && <p role="alert" className="border-b px-5 py-2 text-[13px] text-muted-foreground">{commentStorageDamaged.count} 条本机草稿数据损坏，原始数据已保留。 {commentDraftExportAllowed && <button type="button" className="text-primary underline" onClick={() => {
          if (!commentDraftExportAllowedRef.current || !matchesCommentTarget(commentIdentity.current, id, me.user.id, commentSession)) return;
          const active = commentStorage.current;
          if (!active || active.doc !== id || active.user !== me.user.id) return;
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([JSON.stringify(active.value.damaged())], { type: "application/json" }));
          a.download = `jiange-comment-damaged-${id}.json`;
          a.click(); URL.revokeObjectURL(a.href);
        }}>导出原始数据</button>}</p>}
        {metadataVerified && !commentAccessDenied && (comments.isError || members.isError) && <p role="alert" className="border-b px-5 py-2 text-[13px] text-muted-foreground">评论加载失败。 <button type="button" className="text-primary underline" onClick={() => { void comments.refetch(); void members.refetch(); }}>重试</button></p>}
        {metadataState === "offline" && <div role="status" className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-[13px] text-amber-900">暂时无法连接服务器，正在显示本账号已加载的内容；权限待重新验证，编辑和分享暂不可用。 <button type="button" onClick={() => void meta.refetch()} disabled={meta.isFetching} className="underline disabled:opacity-50">{meta.isFetching ? "正在重试…" : "重试"}</button></div>}
        {(sync.blocked || (meta.isError && sync.client.unacked > 0)) && <div role="alert" className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-[13px] text-amber-900">
          <span>{sync.blocked === "missing_dependency" ? "本地修改依赖的历史尚不可用，暂无法自动合并；内容仍保留在本地。缺失历史恢复后会自动重试。" : sync.blocked === "invalid_history" ? "服务端文档历史不完整，无法确认同步状态；请联系管理员。" : `${sync.blocked === "read_only" ? "当前无编辑权限，" : meta.isError ? "暂时无法验证权限，" : "同步遇到冲突，"}未同步的修改保留在本地，尚未保存到云端。`}</span>{" "}
          {sync.client.unacked > 0 && <><button type="button" onClick={downloadPending} className="underline">下载本地备份</button>{" "}</>}
          {sync.blocked && sync.blocked !== "missing_dependency" && sync.blocked !== "invalid_history" && <button type="button" disabled={retryingSync} onClick={() => void retryPending()} className="underline disabled:opacity-50">{retryingSync ? "检查中…" : "检查权限并重试"}</button>}
          {retrySyncError && <span className="ml-2">{retrySyncError}</span>}
        </div>}
        {sync.storageError && <p role="alert" className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-[13px] text-amber-900">本地草稿无法安全读取或保存，未同步内容可能无法在关闭页面后恢复。{sync.client.unacked > 0 && <> <button type="button" onClick={downloadPending} className="underline">下载本地备份</button></>}</p>}
        {sync.legacyPending && <p role="status" className="border-b px-5 py-2 text-[13px] text-muted-foreground">发现旧版未按账号区分的离线记录，无法安全确认归属，因此未自动加载。原记录仍保留在浏览器中，请联系管理员安全恢复。</p>}
        {sync.otherPending && <p role="status" className="border-b px-5 py-2 text-[13px] text-muted-foreground">本账号还有其他标签页或旧会话的本地草稿，未自动合并。 <button type="button" onClick={downloadStoredDrafts} className="underline">下载本账号草稿备份</button>{retrySyncError && <span className="ml-2">{retrySyncError}</span>}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DocumentCover key={`${me.user.id}:${id}`} id={id} userId={me.user.id} visible={metadataVerified} enabled={canEditContent} hasIcon={!!displayDocumentIcon(meta.data?.icon)} allowCopy={contentCopyAllowed} allowPrint={downloadAllowed} onRevalidate={() => { void meta.refetch(); }}>{({ addButton, hasCover }) => <article className={cn("mx-auto w-full max-w-[960px] px-7 sm:px-16", hasCover ? "pt-8" : "pt-12 sm:pt-14", showTemplates ? "flex min-h-full flex-col pb-12" : "pb-40")}>
            <div className="group/doc-cover relative" data-document-print-restricted={!downloadAllowed ? "true" : undefined} onCopy={(event) => { if (!contentCopyAllowed) event.preventDefault(); }} onCut={(event) => { if (!contentCopyAllowed) event.preventDefault(); }}>{addButton}<DocumentIconEditor id={id} userId={me.user.id} icon={meta.data?.icon} enabled={canEditContent} onRevalidate={() => { void meta.refetch(); }} onUpdated={async (icon) => {
              const key = docMetaKey(id, me.user.id);
              await publishDocumentIcon(qc, key, icon, () => {
                const current = iconIdentity.current;
                return current.mounted && current.id === id && current.user === me.user.id && !current.denied;
              });
            }}><CollabText
              sync={sync}
              block={TITLE}
              me={presence}
              singleLine
              readOnly={!canEditContent}
              placeholder="请输入标题"
              onLocalEdit={onTitle}
              onEnter={() => body.current?.querySelector<HTMLElement>("[data-editor]")?.focus()}
              className="text-[32px] font-semibold leading-[1.3] tracking-tight [&_textarea]:font-semibold [&_textarea]:leading-[1.3]"
            /></DocumentIconEditor></div>
            <div className="mt-4 flex items-center gap-2 text-[13px] text-subtle">
              {meta.data && (
                <>
                  <Avatar name={meta.data.creatorName} color={colorFor(meta.data.creatorId - 1)} size={18} />
                  <span>{meta.data.creatorName}</span>
                  <span>·</span>
                  <span>最近修改于 {formatTime(meta.data.updatedAt)}</span>
                </>
              )}
            </div>
            <div ref={body} className="mt-8 pl-1" data-document-print-restricted={!downloadAllowed ? "true" : undefined}>
              <Editor
                sync={sync}
                onUndoRegistrar={onUndoRegistrar}
                findMatches={displayedMatches}
                activeFindMatch={activeMatch}
                me={presence}
                readOnly={!canEditContent}
                onCopyBlock={!contentCopyAllowed}
                disableFileDownloads={!downloadAllowed}
                docs={mentionDocs}
                upload={canEditContent ? (f) => docsApi.upload(id, f) : undefined}
                comments={commentsAvailable && comments.isSuccess ? comments.data : []}
                activeThread={activeThread}
                onActivateThread={(cid) => {
                  setActiveThread(cid);
                  if (cid !== null) setCommentsTarget({ doc: id, user: me.user.id, session: commentSession });
                }}
                onComment={canSubmitComment && commentsAvailable && commentStorageReady ? (anchor) => {
                  setDraft(anchor);
                  setCommentsTarget({ doc: id, user: me.user.id, session: commentSession });
                } : undefined}
                onPreviewImage={(src, alt, mime) => setPreview({ src, alt, mime })}
                people={(commentsAvailable && members.isSuccess ? members.data : []).map((m) => ({ id: m.id, name: m.name }))}
                onMentionPerson={(uid, name) => {
                  // 文档内 @人 → 通知中心（mention）
                  fetch("/api/docs/" + id + "/comments", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "same-origin",
                    body: JSON.stringify({ body: `@${name} 在正文中被提及`, block: "", startChar: "", endChar: "", quote: "", mentions: [uid] }),
                  }).catch(() => {});
                }}
              />
            </div>
            {pendingStarter && <div className="mt-4 rounded-md border bg-sidebar/50 p-3 text-[13px]" role="status">
              <p className="text-muted-foreground">{pendingSubmitted ? "导入操作已发送，请核对内容；原文仍暂存在当前标签页。" : "待导入内容已准备好。请确认文档为空后导入。"}{!pendingStarter.persistent && " 浏览器暂存不可用，请勿刷新或关闭页面。"}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {!pendingSubmitted && <button type="button" disabled={!canEditContent || !blankBody || !sync.caughtUp || sync.status !== "synced"} onClick={applyPendingStarter} className="rounded-md bg-primary px-3 py-1 text-white disabled:opacity-50">导入内容</button>}
                <button type="button" className="text-primary hover:underline" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([pendingStarter.markdown], { type: "text/markdown" })); a.download = "待导入内容.md"; a.click(); URL.revokeObjectURL(a.href); }}>下载原文</button>
                <button type="button" className="text-muted-foreground hover:underline" onClick={() => { takeStarter(me.user.id, id); submittedStarter.current = false; setPendingSubmitted(false); setPendingRevision((n) => n + 1); setTemplateError(""); }}>清除暂存</button>
              </div>
            </div>}
            {templateError && <p role="alert" className="mt-3 text-[13px] text-destructive">{templateError}</p>}
            {showTemplates && <StarterTemplates onChoose={applyStarter} onHide={() => setTemplatesHidden(true)} />}
          </article>}</DocumentCover>
        </div>
        {findOpen && <div ref={findPanel}>
          <FindReplacePanel
            mode={findMode}
            query={findQuery}
            replacement={findReplacement}
            matchCount={matches.length}
            activeIndex={activeFindIndex}
            canReplace={findCanReplace}
            scopeNotice={`仅搜索正文和分栏文本；标题、表格和公式不在范围内。${matches.length > 500 ? "结果较多，仅高亮当前项。" : ""}${!sync.caughtUp ? "文档尚未同步完成，结果可能不完整。" : ""}`}
            statusMessage={findUpdating ? "搜索结果正在更新，暂时无法替换。" : findMessage}
            onModeChange={setFindMode}
            onQueryChange={(value) => { setFindQuery(value); setFindIndex(0); setFindMessage(""); requestFindScroll(); }}
            onReplacementChange={setFindReplacement}
            onNavigate={(direction) => { if (matches.length) { setFindIndex((current) => (Math.max(0, Math.min(current, matches.length - 1)) + direction + matches.length) % matches.length); requestFindScroll(); } }}
            onReplace={() => replaceFound(false)}
            onReplaceAll={() => replaceFound(true)}
            onClose={() => setFindOpen(false)}
          />
        </div>}
      </div>
      {outlineOpen && (
        <OutlinePanel
          items={outline}
          activeId={null}
          allowCopy={contentCopyAllowed}
          allowPrint={downloadAllowed}
          onClose={() => setOutlineOpen(false)}
          onJump={(bid) => {
            document.querySelector(`[data-block="${bid}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
          }}
        />
      )}
      {preview && <AttachmentPreview src={preview.src} name={preview.alt} mime={preview.mime} allowCopy={contentCopyAllowed} allowPrint={downloadAllowed} onClose={() => setPreview(null)} />}
      {sharing && metadataVerified && meta.data && <ShareDialog meta={meta.data} anchorRef={shareAnchor} onClose={() => setSharing(false)} />}
      {metadataVerified && meta.data && titleCheckTarget?.doc === id && titleCheckTarget.user === me.user.id && <TitleConsistency key={`${me.user.id}:${id}`} id={id} allowCopy={contentCopyAllowed} allowPrint={downloadAllowed} onClose={() => setTitleCheckTarget(null)} onAccessDenied={() => { void meta.refetch(); }} />}
      {history && (
        <VersionPanel
          id={id}
          canEdit={canEditContent}
          allowCopy={contentCopyAllowed}
          disableFileDownloads={!downloadAllowed}
          currentView={sync.client.doc?.view()}
          onClose={() => setHistory(false)}
        />
      )}
      {meta.data?.copyProtected && (
        <div
          className="pointer-events-none fixed inset-0 z-50 select-none overflow-hidden"
          data-watermark
          aria-hidden
        >
          {Array.from({ length: 24 }, (_, i) => (
            <span
              key={i}
              className="absolute whitespace-nowrap text-[13px] text-[#1f2329]/[0.06] dark:text-white/[0.05]"
              style={{ left: `${(i % 6) * 20 + 4}%`, top: `${Math.floor(i / 6) * 25 + 8}%`, transform: "rotate(-24deg)" }}
            >
              {me.user.name} {me.user.email}
            </span>
          ))}
        </div>
      )}
      {commentsAvailable && commentsOpen && (
        <CommentsPanel
          key={`${id}:${me.user.id}:${commentSession}`}
          id={id}
          meId={me.user.id}
          session={commentSession}
          onAccessDenied={revalidateCommentAccess}
          onPolicyDenied={() => {
            revalidateCurrentCommentPolicy(commentIdentity.current, { doc: id, user: me.user.id, session: commentSession }, () => {
              freezeCommentDrafts();
              void meta.refetch();
            });
          }}
          recovery={commentRecovery?.doc === id && commentRecovery.user === me.user.id ? commentRecovery.values.map((value) => redactCommentDraftQuote(value, commentQuoteAllowed)) : []}
          onDismissRecovery={() => {
            const doc = id, user = me.user.id, session = commentSession;
            if (!matchesCommentTarget(commentIdentity.current, doc, user, session)) return;
            const active = commentStorage.current;
            if (!active || active.doc !== doc || active.user !== user) {
              setCommentStorageNotice({ doc, user, text: "无法清除本机草稿，请稍后重试。" });
              return;
            }
            try { active.value.write(commentDraftJournal.current.list(doc, user), []); }
            catch { setCommentStorageNotice({ doc, user, text: "无法清除本机草稿，请稍后重试。" }); return; }
            commentDraftJournal.current.dismiss(doc, user);
            void active.value.dismiss().then((complete) => {
              if (!matchesCommentTarget(commentIdentity.current, doc, user, session)) return;
              const values = mergeRecoveredCommentDrafts(commentDraftJournal.current.recovered(doc, user), active.value.read());
              setCommentRecovery(values.length ? { doc, user, values } : null);
              setCommentStorageDamaged(active.value.damaged().length ? { doc, user, count: active.value.damaged().length } : null);
              setCommentStorageNotice(complete ? null : { doc, user, text: "部分草稿属于其他正在编辑的标签页或无法安全清除，已保留。" });
            }).catch(() => {
              if (matchesCommentTarget(commentIdentity.current, doc, user, session)) setCommentStorageNotice({ doc, user, text: "无法清除本机草稿，请稍后重试。" });
            });
          }}
          onSnapshot={(value) => {
            if (!matchesCommentTarget(commentIdentity.current, id, me.user.id, commentSession)) return;
            commentDraftJournal.current.save(id, me.user.id, redactCommentDraftQuote(value, commentQuoteAllowedRef.current));
            persistCommentDrafts();
          }}
          onComposerSuspended={freezeCommentDrafts}
          canEdit={canComment && commentStorageReady}
          canSubmit={canSubmitComment}
          canCheckAttempt={permissionsVerified && commentsAvailable}
          canManage={meta.data?.role === "manage"}
          attemptStore={commentAttempts}
          allowCopyQuote={contentCopyAllowed}
          allowPrintQuote={downloadAllowed}
          draft={draft}
          onDraftSent={(sent) => setDraft((current) => current === sent ? null : current)}
          activeThread={activeThread}
          onActivate={(thread) => {
            pendingCommentScroll.current = thread;
            setActiveThread(thread);
          }}
          onClose={() => {
            freezeCommentDrafts();
            setCommentsTarget(null);
            setDraft(null);
            setActiveThread(null);
          }}
        />
      )}
    </div>
  );
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return d.toDateString() === now.toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

const STATUS: Record<SyncStatus, { label: string; color: string }> = {
  synced: { label: "已同步", color: "#00B42A" },
  syncing: { label: "同步中…", color: "#3370FF" },
  connecting: { label: "连接中…", color: "#FF8800" },
  offline: { label: "离线，恢复后自动同步", color: "#8F959E" },
};

function TopBar({
  ancestors,
  meta,
  title,
  workspace,
  status,
  peers,
  me,
  wordCount,
  shareAnchor,
  onShare,
  onComments,
  onFind,
  readingMode,
  onToggleReading,
  onCreate,
  creating,
  onHistory,
  onTitleCheck,
  onExport,
  onImport,
  onOutline,
  readOnly,
  allowContentCopy,
  allowDocumentPrint,
  metadataVerified,
}: {
  ancestors: import("@/lib/api").DocMeta[];
  shareAnchor: React.RefObject<HTMLButtonElement | null>;
  onShare: () => void;
  onComments: () => void;
  onFind: () => void;
  readingMode: boolean;
  onToggleReading: () => void;
  onCreate: () => void;
  creating: boolean;
  onOutline: () => void;
  onHistory: () => void;
  onTitleCheck: () => void;
  onExport?: () => void;
  onImport?: (f: File) => void;
  readOnly: boolean;
  allowContentCopy: boolean;
  allowDocumentPrint: boolean;
  metadataVerified: boolean;
  meta?: DocMeta;
  title: string;
  workspace: string;
  status: SyncStatus;
  peers: RemotePeer[];
  me: Presence;
  wordCount: number;
}) {
  const s = STATUS[status];
  return (
    <header className="flex h-16 shrink-0 items-center gap-1 border-b pl-14 pr-2 sm:gap-3 md:px-5">
      <div className="min-w-0 flex-1">
      <nav className="flex min-w-0 items-center gap-1.5 text-[13px]" data-document-print-restricted={!allowDocumentPrint ? "true" : undefined} onCopy={(event) => { if (!allowContentCopy) event.preventDefault(); }} onCut={(event) => { if (!allowContentCopy) event.preventDefault(); }}>
        <a href="#/" className="hidden truncate text-muted-foreground hover:text-foreground sm:block">
          {workspace}
        </a>
        <span className="hidden shrink-0 text-primary sm:block">
          {meta?.kind === "base" ? <BaseIcon /> : <DocumentGlyph icon={meta?.icon} fallback={<DocIcon />} />}
        </span>
        {ancestors.map((a) => (
          <span key={a.id} className="flex min-w-0 items-center gap-1.5">
            <span className="text-subtle">/</span>
            <a href={a.kind === "base" ? `#/base/${a.id}` : `#/doc/${a.id}`} className="truncate text-muted-foreground hover:text-foreground">
              {docTitle(a)}
            </a>
          </span>
        ))}
        <span className="text-subtle">/</span>
        <span className="truncate font-medium text-foreground">{meta ? docTitle({ title }) : "…"}</span>
      </nav>
      <span className="hidden items-center gap-1 text-[11px] text-subtle sm:flex" data-status={status}><span className="size-1.5 rounded-full" style={{ background: s.color }} />{status === "synced" ? "已经保存到云端" : s.label}</span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
        {readOnly && <span className="hidden rounded bg-hover px-2 py-0.5 text-xs text-muted-foreground sm:inline">只读</span>}
        <Button ref={shareAnchor} size="sm" disabled={!meta || !metadataVerified} className="h-9 gap-1.5 bg-[#1456f0] px-2.5 text-[14px] font-normal hover:bg-[#0f4dd6] sm:h-8 sm:w-20" onClick={onShare}>
          <BuildingIcon className="size-4" />分享
        </Button>
        {!readOnly && <ModeMenu reading={readingMode} onToggle={onToggleReading} />}
        <NotificationBell onOpenDoc={(id) => (location.hash = `#/doc/${id}`)} />
        <DocMenu meta={metadataVerified ? meta : undefined} onHistory={metadataVerified ? onHistory : undefined} onTitleCheck={metadataVerified ? onTitleCheck : undefined} onExport={onExport} onImport={onImport} onOutline={onOutline} onComments={onComments} onFind={onFind} wordCount={wordCount} />
        <span className="mx-1 hidden h-6 w-px bg-border sm:block" />
        <button onClick={() => document.querySelector<HTMLInputElement>("[data-search]")?.focus()} title="搜索文档" aria-label="搜索文档" className="hidden size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover lg:grid"><SearchIcon className="size-[17px]" /></button>
        <button onClick={onCreate} disabled={creating} title="新建文档" aria-label="新建文档" className="hidden size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover disabled:opacity-50 lg:grid"><AddIcon className="size-[18px]" /></button>
        <button onClick={onComments} title="评论" aria-label="评论" className="hidden h-8 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-hover sm:flex"><MessageSquare size={17} /><span className="hidden text-[13px] xl:inline">评论</span></button>
        {metadataVerified && meta && <StarButton docId={meta.id} />}
        <div className="ml-1 hidden items-center -space-x-1.5 sm:flex" aria-label="协作者">
          <Avatar name={me.name} color={me.color} size={26} ring title={`${me.name}（你）`} />
          {peers.slice(0, 5).map((p) => <Avatar key={p.clientId} name={p.state.name} color={p.state.color} size={26} ring />)}
          {peers.length > 5 && <span className="grid size-[26px] place-items-center rounded-full bg-hover text-[11px] ring-2 ring-white">+{peers.length - 5}</span>}
        </div>
      </div>
    </header>
  );
}

function ModeMenu({ reading, onToggle }: { reading: boolean; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div ref={ref} className="relative">
    <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="menu" aria-label={reading ? "阅读模式" : "编辑模式"} className="flex h-9 items-center gap-1 rounded-md border px-2 text-[13px] text-foreground hover:bg-hover sm:h-8 sm:px-2.5"><EditIcon className="size-[14px]" /><span className="hidden min-[380px]:inline">{reading ? "阅读" : "编辑"}</span><DownBoldIcon className={cn("size-3 transition-transform", open && "rotate-180")} /></button>
    {open && <div role="menu" className="absolute right-0 top-9 z-30 w-[180px] rounded-md border bg-surface p-1 shadow-lg">
      {([{ value: false, label: "编辑", description: "可编辑文档", icon: <EditIcon className="size-[15px]" /> }, { value: true, label: "阅读", description: "仅查看或评论文档", icon: <Eye size={15} /> }] as const).map((item) => <button key={item.label} type="button" role="menuitemradio" aria-checked={reading === item.value} onClick={() => { if (reading !== item.value) onToggle(); setOpen(false); }} className="flex w-full items-start gap-2 rounded px-2 py-2 text-left hover:bg-hover"><span className={cn("mt-0.5", reading === item.value ? "text-primary" : "text-muted-foreground")}>{item.icon}</span><span className="min-w-0 flex-1"><span className={cn("block text-[13px]", reading === item.value && "text-primary")}>{item.label}</span><span className="block text-[12px] text-subtle">{item.description}</span></span>{reading === item.value && <Check size={14} className="mt-0.5 text-primary" />}</button>)}
    </div>}
  </div>;
}

/** 收藏星标：同步 favorites 查询缓存。 */
function StarButton({ docId }: { docId: number }) {
  const qc = useQueryClient();
  const favs = useQuery({ queryKey: ["favorites"], queryFn: () => extrasApi.favorites() });
  const starred = favs.data?.some((d) => d.id === docId) ?? false;
  return (
    <button
      className={cn("hidden size-8 place-items-center rounded-md hover:bg-hover sm:grid", starred ? "text-amber-400" : "text-muted-foreground hover:text-foreground")}
      title={starred ? "取消收藏" : "收藏"}
      onClick={() => {
        (starred ? extrasApi.unstar(docId) : extrasApi.star(docId)).then(() => qc.invalidateQueries({ queryKey: ["favorites"] }));
      }}
      data-star-doc
    >
      <Star size={16} strokeWidth={1.7} fill={starred ? "currentColor" : "none"} />
    </button>
  );
}

function StarMenuItem({ docId, onDone }: { docId: number; onDone: () => void }) {
  const qc = useQueryClient();
  const favs = useQuery({ queryKey: ["favorites"], queryFn: extrasApi.favorites });
  const starred = favs.data?.some((d) => d.id === docId) ?? false;
  return <button className="block w-full rounded px-3 py-1.5 text-left text-[13px] hover:bg-hover sm:hidden" onClick={() => { (starred ? extrasApi.unstar(docId) : extrasApi.star(docId)).then(() => qc.invalidateQueries({ queryKey: ["favorites"] })); onDone(); }}>{starred ? "取消收藏" : "收藏"}</button>;
}

function DocMenu({
  meta,
  onHistory,
  onTitleCheck,
  onExport,
  onImport,
  onOutline,
  onComments,
  onFind,
  wordCount,
}: {
  meta?: DocMeta;
  onHistory?: () => void;
  onTitleCheck?: () => void;
  onExport?: () => void;
  onImport?: (f: File) => void;
  onOutline: () => void;
  onComments: () => void;
  onFind: () => void;
  wordCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [copyPending, setCopyPending] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const copying = useRef(false);
  const live = useRef(true);
  const currentMeta = useRef(meta);
  currentMeta.current = meta;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { setCopyError(""); setCopyNotice(""); }, [meta?.id]);
  const qc = useQueryClient();
  const close = () => setOpen(false);
  const trash = async () => {
    if (!meta) return;
    await docsApi.trash(meta.id);
    qc.invalidateQueries({ queryKey: ["docs"] });
    location.hash = "#/";
  };
  const toRoot = async () => {
    if (!meta) return;
    await docsApi.move(meta.id, null);
    qc.invalidateQueries({ queryKey: ["docs"] });
    setOpen(false);
  };
  const item = "block w-full rounded px-3 py-1.5 text-left text-[13px] hover:bg-hover";
  const duplicate = async () => {
    if (!canCopyDocument(meta) || copying.current) return;
    const sourceId = meta!.id;
    copying.current = true;
    setCopyPending(true);
    setCopyError("");
    setCopyNotice("");
    setOpen(false);
    try {
      const nd = await docsApi.duplicate(sourceId);
      void qc.invalidateQueries({ queryKey: ["docs"] });
      // Do not navigate if the user left the document or lost verified access
      // while the request was running.
      if (live.current && currentMeta.current?.id === sourceId && canCopyDocument(currentMeta.current)) go(hrefOf(nd));
      else if (live.current) setCopyNotice("副本已创建，请在主页查看。");
    } catch (error) {
      if (live.current) setCopyError(copyErrorMessage(error));
    } finally {
      copying.current = false;
      if (live.current) setCopyPending(false);
    }
  };
  return (
    <div className="relative">
      <button className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground sm:size-8" title="更多" onClick={() => setOpen((o) => !o)} data-more-menu>
        <MoreIcon className="size-4" />
      </button>
      {copyPending && <span role="status" className="absolute right-0 top-9 z-40 whitespace-nowrap rounded-md border bg-surface px-3 py-2 text-[13px] text-muted-foreground shadow-lg">正在创建副本…</span>}
      {copyNotice && <div role="status" className="absolute right-0 top-9 z-40 flex w-64 items-start gap-2 rounded-md border bg-surface px-3 py-2 text-[13px] shadow-lg"><span className="min-w-0 flex-1">{copyNotice}</span><button type="button" aria-label="关闭提示" onClick={() => setCopyNotice("")} className="text-muted-foreground hover:text-foreground">×</button></div>}
      {copyError && <div role="alert" className="absolute right-0 top-9 z-40 flex w-64 items-start gap-2 rounded-md border bg-surface px-3 py-2 text-[13px] text-destructive shadow-lg"><span className="min-w-0 flex-1">{copyError}</span><button type="button" aria-label="关闭错误提示" onClick={() => setCopyError("")} className="text-muted-foreground hover:text-foreground">×</button></div>}
      {open && (
        <div className="absolute right-0 top-9 z-30 w-44 rounded-lg border bg-surface p-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          <div className="px-3 py-1.5 text-[12px] text-subtle" data-word-count>字数统计：{wordCount}</div>
          <button className={item} onClick={() => { close(); onFind(); }}>查找和替换</button>
          {onTitleCheck && <button className={item} onClick={() => { close(); onTitleCheck(); }}>检查文档名称</button>}
          <button className={cn(item, "sm:hidden")} onClick={() => { close(); onComments(); }}>评论</button>
          {meta && <StarMenuItem docId={meta.id} onDone={close} />}
          {onHistory && (
            <button className={item} onClick={() => { close(); onHistory(); }}>
              历史版本
            </button>
          )}
          {onExport && (
            <button className={item} onClick={() => { close(); onExport(); }}>
              导出 Markdown
            </button>
          )}
          {canCopyDocument(meta) && (
            <button className={cn(item, "disabled:opacity-50")} disabled={copyPending} onClick={() => void duplicate()} data-duplicate>
              创建副本
            </button>
          )}
          <button className={item} onClick={() => { close(); onOutline(); }} data-outline>
            目录
          </button>
          {onImport && (
            <label className={cn(item, "block cursor-pointer")} data-import-md>
              导入 Markdown
              <input
                type="file"
                accept=".md,.markdown,text/markdown"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onImport(f);
                  e.target.value = "";
                  close();
                }}
              />
            </label>
          )}
          <div className="my-1 border-t" />
          {meta?.role === "manage" && meta.parentId && <div className="my-1 border-t" />}
          {meta?.role === "manage" && meta.parentId && (
            <button className={item} onClick={toRoot}>
              移到顶层
            </button>
          )}
          {meta?.role === "manage" && <button className="block w-full rounded px-3 py-1.5 text-left text-[13px] text-destructive hover:bg-hover" onClick={trash}>
            删除（移到回收站）
          </button>}
        </div>
      )}
    </div>
  );
}
