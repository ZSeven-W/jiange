import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { idKey, Tx, type Op, type OpId, type SyncStatus } from "@jiange/collab";
import { bodyBlocks } from "@/editor/model";
import { formatEditDay, formatEditTime, headerMetaText, nextSavedFlag } from "./doc-header-meta";
import { ApiError, docsApi, driveApi, templatesApi, type DocMeta, type Me } from "@/lib/api";
import { colorFor, type Presence } from "@/lib/presence";
import { useSyncDoc, type RemotePeer } from "@/lib/use-sync-doc";
import { CollabText } from "@/components/collab-text";
import { Editor, type ExternalUndoRecorder, type FindBatchReplacer, type TableFindReplacer } from "@/editor/editor";
import { replaceMatches } from "@/editor/find-replace";
import { FindScrollIntent } from "@/editor/find-navigation";
import { preflightFindReplace } from "@/editor/find-replace-safety";
import { replacementSyncNotice, type ReplacementNotice } from "@/editor/find-replace-notice";
import { scrollToCommentAnchor } from "@/editor/comment-anchor";
import { scheduleFindSnapshot, type FindSnapshot } from "@/editor/find-search-scheduler";
import { FindReplacePanel, type FindReplaceMode } from "@/editor/find-replace-panel";
import { Avatar } from "@/components/brand";
import { AddIcon, BuildingIcon, DownBoldIcon, EditIcon, MoreIcon, SearchIcon } from "@/components/feishu-icons";
import { StarterTemplates, type StarterTemplate } from "./starter-templates";
import { TitleConsistency } from "./title-consistency";
import { hasUnsupportedImportBlocks, insertStarterBlocks, insertStarterTemplate, isEmptyStarterDocument } from "./starter-template-ops";
import { peekStarter, takeStarter } from "./pending-starter";
import { clearPendingWord, loadPendingWord, type PendingWord } from "./pending-word";
import { BOARD_SEED, MINDMAP_SEED, hasBoard, peekBoardKind, takeBoard } from "./board-starter";
import { requestFlowOpen } from "@/editor/flowchart/open-requests";
import { BaseIcon, docTitle, DocIcon, hrefOf } from "@/components/sidebar";
import { go } from "@/lib/route";
import { docWidthClass, readDocWidth, writeDocWidth, type DocWidth } from "@/lib/doc-width";
import { DocWidthOptions } from "./doc-width-options";
import { DocumentInfoDialog } from "./document-info-dialog";
import { documentTextStats } from "./doc-info-stats";
import { cn } from "@/lib/utils";
import { NotificationBell } from "./notification-bell";
import { Button } from "@/components/ui/button";
import { ShareDialog } from "@/components/share-dialog";
import { DocumentIconEditor } from "@/components/document-icon-editor";
import { DocumentCover } from "@/components/document-cover";
import { DocumentGlyph, displayDocumentIcon } from "@/components/document-glyph";
import type { SearchGuardCapture } from "@/components/search-focus";
import { publishDocumentIcon } from "@/components/document-icon-cache";
import { ask, askText } from "@/components/ui/ask";
import { VersionPanel, type VersionMode } from "./version-panel";
import { withoutVersionHash } from "@/lib/version-link";
import { DocumentPresentation } from "./document-presentation";
import { NamedVersionDialog } from "./named-version-dialog";
import { namedVersionPoint } from "./named-version-safety";
import { CommentsPanel, type CommentAnchor, type CommentRecovery } from "./comments-panel";
import { HistoryCommentsPanel } from "./history-comments-panel";
import { canWriteComments, commentListKey, commentMembersKey, CommentDraftJournal, CommentRecoveryGate, matchesCommentTarget, mayExportCommentDraftData, mayRetainCommentQuote, mergeRecoveredCommentDrafts, mustRedactCommentAttemptQuote, newCommentSession, redactCommentDraftQuote, revalidateCurrentCommentPolicy, type CommentTarget } from "./comment-access";
import { browserCommentDraftEnvironment, commentDraftStorageReady, CommentDraftStorage } from "./comment-draft-storage";
import { browserCommentAttemptEnvironment, CommentAttemptStore } from "./comment-attempts";
import { CommentAttemptDocumentDenied, requireCommentAttempts } from "./comment-attempt-api";
import { CommentAttemptRecovery } from "./comment-attempt-recovery";
import { OutlinePanel, OutlineTrigger, activeOutlineId, loadOutlinePinned, outlineOf, saveOutlinePinned, type OutlineItem } from "./outline-panel";
import { AttachmentPreview } from "./attachment-preview";
import { commentsApi, extrasApi } from "@/lib/api";
import { parseMarkdown, viewToMarkdown } from "@/lib/markdown";
import { appendBlocksOps, appendMarkdownOps } from "@/lib/md-import";
import { buildDocx, docxExportLosses, docxImportErrorMessage, DOCX_MIME, isDocxFile, readDocxFile, type DocxImportResult } from "@/lib/docx";
import { fetchDocxImages } from "./docx-images";
import { uploadDocxImportImages } from "./docx-import-images";
import { aiApi, openAISettings, type AIMessage } from "@/lib/ai";
import { DocAIPanel } from "./doc-ai-panel";
import { archivePendingDraft, readAccountDraftBackups, readRecoveryDraft, recoveryDraftKeys, removeRecoveryDraft } from "@/lib/pending-ops-storage";
import { createVisitRecorder } from "@/lib/recent-visit";
import { docMetaKey, docMetaState, isDocAccessDenied, mayConnectDocument, removeDeniedDocumentReferences, shouldRetryDocMeta } from "./doc-meta-state";
import { ResourceTypeNotice } from "./resource-type-notice";
import { canCopyContent, canCopyDocument, canDownloadDocument, copyErrorMessage, mayUseDownloadRecheck, pendingDocumentBackup } from "./document-copy";
import { markdownExportLosses } from "./markdown-export";
import { DocumentMoveDialog } from "./document-move-dialog";
import { DocumentMentionsDialog } from "./document-mentions-dialog";
import { PendingDraftPreview } from "./pending-draft-preview";
import { collectDocumentMentions } from "./document-mentions";
import { useI18n } from "@/lib/i18n";
import { AtSign, Check, ChevronRight, Copy, Download, Eye, FileDown, FileText, FileType, FileUp, FolderInput, History, Info, LayoutTemplate, ListTree, MessageSquare, PanelsTopLeft, Pin, Presentation, Printer, Search, Sparkles, SpellCheck, Star, Trash2 } from "lucide-react";

// Every document starts with these two blocks (server: syncsrv.InitialOps).
const TITLE: OpId = { client: 0, clock: 1 };

export function DocPage({ id, linkedVersion, me, sidebarDocked = false, onGlobalSearch, onSearchGuardRegistrar }: { id: number; linkedVersion?: string | null; me: Me; sidebarDocked?: boolean; onGlobalSearch?: () => void; onSearchGuardRegistrar?: (capture: SearchGuardCapture | null) => void }) {
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
  const metadataState = docMetaState(meta.data, meta.isError, meta.error);
  useEffect(() => {
    if (metadataState !== "denied") return;
    void removeDeniedDocumentReferences(qc, id, () => isDocAccessDenied(qc.getQueryState(docMetaKey(id, me.user.id))?.error));
  }, [qc, id, me.user.id, metadataState]);
  const sync = useSyncDoc(id, me.user.id, mayConnectDocument(meta.data, metadataState), metadataState === "ready" && meta.data?.kind === "doc" ? meta.data.role : undefined);
  const [recoveryState, setRecoveryState] = useState<{ user: number; doc: number; keys: string[]; selected: string } | null>(null);
  const [draftPreview, setDraftPreview] = useState<{ user: number; doc: number; ops: Op[]; archived: boolean; archiveKey?: string } | null>(null);
  const recoveryKeys = recoveryState?.user === me.user.id && recoveryState.doc === id ? recoveryState.keys : [];
  useEffect(() => {
    let active = true;
    setDraftPreview(null);
    const refresh = () => {
      try {
        const keys = recoveryDraftKeys(localStorage, me.user.id, id);
        if (active) setRecoveryState((old) => ({ user: me.user.id, doc: id, keys, selected: old?.user === me.user.id && old.doc === id && keys.includes(old.selected) ? old.selected : keys[0] ?? "" }));
      } catch { if (active) setRecoveryState({ user: me.user.id, doc: id, keys: [], selected: "" }); }
    };
    const changed = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(`jiange:recovery:v1:${me.user.id}:${id}:`)) refresh(); };
    refresh(); window.addEventListener("storage", changed);
    return () => { active = false; window.removeEventListener("storage", changed); };
  }, [id, me.user.id]);
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
  const metadataVerified = metadataState === "ready" && meta.data?.kind === "doc";
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
  const importingWord = useRef(false);
  const importingPendingWord = useRef(false);
  const [pendingWordState, setPendingWordState] = useState<{ user: number; doc: number; value: PendingWord } | null>(null);
  const pendingWord = pendingWordState?.user === me.user.id && pendingWordState.doc === id ? pendingWordState.value : null;
  const [pendingWordLoading, setPendingWordLoading] = useState(true);
  const [pendingWordError, setPendingWordError] = useState("");
  const [pendingWordSubmitted, setPendingWordSubmitted] = useState(false);
  const [pendingWordBusy, setPendingWordBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setPendingWordState(null); setPendingWordLoading(true); setPendingWordError(""); setPendingWordSubmitted(false);
    void loadPendingWord(me.user.id, id).then((value) => { if (active && value) setPendingWordState({ user: me.user.id, doc: id, value }); }).catch(() => { if (active) setPendingWordError("无法读取本地 Word 暂存，请检查浏览器存储后重新打开文档。"); }).finally(() => { if (active) setPendingWordLoading(false); });
    return () => { active = false; };
  }, [id, me.user.id]);
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
  const tableFindReplace = useRef<TableFindReplacer | null>(null);
  const onTableFindRegistrar = useCallback((replace: TableFindReplacer | null) => { tableFindReplace.current = replace; }, []);
  const findBatchReplace = useRef<FindBatchReplacer | null>(null);
  const onFindBatchRegistrar = useCallback((replace: FindBatchReplacer | null) => { findBatchReplace.current = replace; }, []);
  const canEditRef = useRef(false);
  useLayoutEffect(() => {
    if (!onSearchGuardRegistrar) return;
    onSearchGuardRegistrar(() => {
      const client = sync.client, doc = client.doc, revision = sync.getChangeRevision(), historyChanges = client.droppedOnResync;
      return () => {
        const current = exportContext.current;
        return current.mounted && current.id === id && current.user === me.user.id && current.client === client && !!doc && client.doc === doc && sync.getChangeRevision() === revision && client.droppedOnResync === historyChanges && !client.blocked && canEditRef.current;
      };
    });
    return () => onSearchGuardRegistrar(null);
  }, [id, me.user.id, onSearchGuardRegistrar, sync.client, sync.getChangeRevision]);
  const submittedStarter = useRef(false);
  const [pendingSubmitted, setPendingSubmitted] = useState(false);
  const [, setPendingRevision] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [pageNotice, setPageNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [titleCheckTarget, setTitleCheckTarget] = useState<{ doc: number; user: number } | null>(null);
  const [infoTarget, setInfoTarget] = useState<{ doc: number; user: number } | null>(null);
  const closeDocumentInfo = useCallback(() => setInfoTarget(null), []);
  useEffect(() => { setInfoTarget(null); }, [id, me.user.id, metadataVerified]);
  useEffect(() => { setTitleCheckTarget(null); }, [id, me.user.id, metadataVerified]);
  useEffect(() => { if (!metadataVerified) setSharing(false); }, [metadataVerified]);
  const [history, setHistory] = useState<VersionMode | null>(null);
  const [presenting, setPresenting] = useState(false);
  const hadLinkedVersion = useRef(false);
  useEffect(() => {
    if (linkedVersion !== undefined) { setPresenting(false); setHistory("saved"); }
    else if (hadLinkedVersion.current) setHistory(null);
    hadLinkedVersion.current = linkedVersion !== undefined;
  }, [linkedVersion]);
  const [mentionsTarget, setMentionsTarget] = useState<{ doc: number; user: number } | null>(null);
  useEffect(() => { setMentionsTarget(null); }, [id, me.user.id, metadataVerified]);
  useEffect(() => { setPresenting(false); }, [id, me.user.id, metadataVerified]);
  const [versionTarget, setVersionTarget] = useState<{ doc: number; user: number } | null>(null);
  useEffect(() => { setVersionTarget(null); }, [id, me.user.id, metadataVerified]);
  const [commentsTarget, setCommentsTarget] = useState<CommentTarget | null>(null);
  const [commentHistoryTarget, setCommentHistoryTarget] = useState<CommentTarget | null>(null);
  // 飞书宽屏默认在正文左侧展示目录；窄屏只在用户手动打开时以抽屉显示。
  const [width, setWidth] = useState(() => readDocWidth(me.user.id, id));
  useEffect(() => { setWidth(readDocWidth(me.user.id, id)); }, [me.user.id, id]);
  const [outlineOpen, setOutlineOpen] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1280px)").matches);
  const [outlineWide, setOutlineWide] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1280px)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 1280px)");
    setOutlineWide(media.matches);
    const changed = (event: MediaQueryListEvent) => { setOutlineWide(event.matches); if (!event.matches) setOutlineOpen(false); };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const [outlineActive, setOutlineActive] = useState<string | null>(null);
  const [outlinePinned, setOutlinePinned] = useState(loadOutlinePinned);
  const scrollArea = useRef<HTMLDivElement>(null);
  const outlineTrigger = useRef<HTMLButtonElement>(null);
  const outlinePanelId = useId();
  const focusOutlineEntry = () => {
    const previous = document.activeElement;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== previous && active !== document.body && active !== document.documentElement) return;
      const trigger = outlineTrigger.current;
      if (trigger?.getClientRects().length) trigger.focus({ preventScroll: true });
      else document.querySelector<HTMLButtonElement>("[data-more-menu]")?.focus({ preventScroll: true });
    });
  };
  const [preview, setPreview] = useState<{ src: string; alt: string; mime?: string } | null>(null);
  const [draft, setDraft] = useState<CommentAnchor | null>(null);
  const [activeThread, setActiveThread] = useState<number | null>(null);
  const presentationBody = useRef<HTMLDivElement>(null);
  const pendingCommentScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (activeThread !== null && pendingCommentScroll.current === activeThread) {
      pendingCommentScroll.current = null;
      scrollToCommentAnchor(presenting ? presentationBody.current : body.current, activeThread);
    }
  }, [activeThread, presenting]);
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
  const [findPending, setFindPending] = useState<ReplacementNotice | null>(null);
  const [findNavigation, setFindNavigation] = useState(0);
  const [findResult, setFindResult] = useState<FindSnapshot | null>(null);
  useEffect(() => {
    if (!findPending || findPending.acknowledged || sync.client.droppedOnResync !== findPending.historyChanges || sync.status !== "synced" || !sync.caughtUp || sync.blocked || sync.client.unacked !== 0) return;
    setFindPending((current) => current === findPending ? { ...current, acknowledged: true } : current);
  }, [findPending, sync.status, sync.caughtUp, sync.blocked, sync.client, sync.client.unacked, sync.client.droppedOnResync]);
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
  const commentHistoryOpen = matchesCommentTarget(commentHistoryTarget, id, me.user.id, commentSession);
  const commentSuspended = matchesCommentTarget(commentDenial, id, me.user.id, commentSession);
  const comments = useQuery({ queryKey: commentListKey(id, me.user.id, commentSession), queryFn: () => commentsApi.list(id), enabled: metadataVerified && !commentSuspended, refetchInterval: 5000, refetchIntervalInBackground: false });
  const members = useQuery({ queryKey: commentMembersKey(id, me.user.id, commentSession), queryFn: () => commentsApi.members(id), enabled: metadataVerified && !commentSuspended });
  const commentAccessDenied = (comments.isError && isDocAccessDenied(comments.error)) || (members.isError && isDocAccessDenied(members.error)) || commentSuspended;
  const commentsAvailable = sync.blocked !== "table_unsupported" && metadataVerified && !commentAccessDenied && comments.isSuccess && members.isSuccess;
  const mentionSummary = useMemo(() => {
    if (mentionsTarget?.doc !== id || mentionsTarget.user !== me.user.id || !metadataVerified || !sync.client.doc) return null;
    return collectDocumentMentions(sync.client.doc.view(), commentsAvailable && !members.isFetching ? members.data : []);
  }, [mentionsTarget, id, me.user.id, metadataVerified, sync.client.doc, sync.version, commentsAvailable, members.isFetching, members.data]);
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
  // 没有标题时不占用正文左侧空间（与飞书一致）；手动打开的抽屉仍显示空态提示。
  const outlineVisible = outlineOpen && (outline.length > 0 || !outlineWide);
  const outlineFrame = useRef(0);
  const onBodyScroll = useCallback(() => {
    if (!outlineVisible || outlineFrame.current) return;
    outlineFrame.current = requestAnimationFrame(() => {
      outlineFrame.current = 0;
      const area = scrollArea.current;
      if (!area) return;
      const base = area.getBoundingClientRect().top;
      const tops: Record<string, number> = {};
      for (const it of outline) {
        const el = area.querySelector<HTMLElement>(`[data-block="${it.id}"]`);
        if (el) tops[it.id] = el.getBoundingClientRect().top - base;
      }
      setOutlineActive(activeOutlineId(outline, tops, 96, false));
    });
  }, [outline, outlineVisible]);
  useEffect(() => { onBodyScroll(); }, [onBodyScroll]);
  useEffect(() => () => { if (outlineFrame.current) cancelAnimationFrame(outlineFrame.current); }, []);

  const infoStats = useMemo(() => {
    const d = sync.client.doc;
    return infoTarget?.doc === id && infoTarget.user === me.user.id && d ? documentTextStats(d.view()) : null;
  }, [infoTarget, id, me.user.id, sync.client.doc, sync.version]);
  // 个人 AI：仅在可复制该文档内容时可用（服务端同样校验）。
  const aiAvailable = metadataVerified && canCopyDocument(meta.data);
  const runAI = aiAvailable ? (messages: AIMessage[]) => aiApi.complete(id, messages) : undefined;
  const docMarkdown = () => { const d = sync.client.doc; return d ? viewToMarkdown(d.view()) : ""; };
  const appendMarkdown = (md: string) => {
    const d = sync.client.doc;
    if (!d || !canEditRef.current || !sync.client.caughtUp || !recordExternalUndo.current || !parseMarkdown(md).length) { setPageNotice({ ok: false, text: "当前无法写入文档，请确认编辑权限和同步状态。" }); return; }
    const tx = appendMarkdownOps(d, md);
    if (tx.ops.length) { recordExternalUndo.current(tx, { preserveCreatedBlocks: true }); sync.client.push(tx.ops); setPageNotice({ ok: true, text: "已插入到文末。" }); }
  };
  const saveTemplate = async (md: string) => {
    if (!md.trim()) { setPageNotice({ ok: false, text: "没有可保存的内容。" }); return; }
    const name = await askText("保存为模板", "模板名称", (title || "未命名模板").slice(0, 100));
    if (!name?.trim()) return;
    const current = exportContext.current;
    if (!current.mounted || current.id !== id || current.user !== me.user.id || current.client !== sync.client || !current.verified || !canCopyContent(current.meta) || current.client.blocked || !current.client.caughtUp) return;
    try { await templatesApi.add(name.trim(), md); void qc.invalidateQueries({ queryKey: ["my-templates"] }); setPageNotice({ ok: true, text: `已保存为模板「${name.trim()}」，新建文档时可在模板中选择。` }); }
    catch (err) { setPageNotice({ ok: false, text: err instanceof ApiError ? err.message : "保存模板失败，请重试。" }); }
  };
  useEffect(() => { if (!pageNotice) return; const timer = window.setTimeout(() => setPageNotice(null), 4000); return () => window.clearTimeout(timer); }, [pageNotice]);
  const exportDocument = async (format: "md" | "docx" = "md") => {
    if (exportingMarkdown.current || !permissionsVerified || !canCopyDocument(meta.data)) return;
    const d = sync.client.doc;
    if (!d) return;
    if (!sync.client.caughtUp || sync.client.blocked) {
      setExportNotice({ id, user: me.user.id, text: "文档尚未完成同步，请同步完成后再导出。" });
      return;
    }
    const view = d.view();
    const snapshot = JSON.stringify(view);
    exportingMarkdown.current = true;
    setExportNotice(null);
    try {
      // Word export embeds images; fetch them first so the loss list is accurate.
      const images = format === "docx" ? await fetchDocxImages(view.blocks) : undefined;
      const losses = format === "docx" ? docxExportLosses(view, { images, origin: location.origin }) : markdownExportLosses(view);
      const label = format === "docx" ? "Word" : "Markdown";
      if (losses.length && !await ask(`${label} 导出可能丢失内容`, `${losses.join("；")}。仍要下载吗？`, false)) return;
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
      const name = (title || current.meta?.title || "未命名").trim() || "未命名";
      const blob = format === "docx"
        ? new Blob([buildDocx(view, { title: name, images, origin: location.origin })], { type: DOCX_MIME })
        : new Blob([viewToMarkdown(view)], { type: "text/markdown;charset=utf-8" });
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      try {
        a.href = url;
        a.download = `${name}.${format}`;
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
  const importWord = async (file: File) => {
    const d = sync.client.doc;
    if (!d || importingWord.current) return;
    if (!canEditRef.current) { setTemplateError("当前为只读状态，无法导入。"); return; }
    importingWord.current = true;
    try {
      let result: DocxImportResult;
      try { result = await readDocxFile(file, { images: true }); } catch (error) { setTemplateError(docxImportErrorMessage(error)); return; }
      if (result.warnings.length && !await ask("Word 导入可能丢失内容", `${result.warnings.join("；")}。仍要导入其余内容吗？`, false)) return;
      const ready = () => {
        const context = exportContext.current;
        return context.mounted && context.id === id && context.user === me.user.id && context.client === sync.client && d === sync.client.doc && canEditRef.current && sync.client.caughtUp && sync.client.status === "synced" && !!recordExternalUndo.current;
      };
      if (!ready()) { setTemplateError("请等待文档同步完成后再导入。"); return; }
      let blocks;
      try { blocks = await uploadDocxImportImages(result, (image) => docsApi.uploadImportImage(id, image, me.user.id), ready); }
      catch {
        if (exportContext.current.mounted && exportContext.current.id === id && exportContext.current.user === me.user.id) setTemplateError("图片上传或文档状态异常，正文未导入；已上传的图片可能作为未引用附件保留，请检查后重试。");
        return;
      }
      if (!ready() || !recordExternalUndo.current) { setTemplateError("文档状态已变化，正文未导入；已上传的图片可能作为未引用附件保留。"); return; }
      const tx = appendBlocksOps(d, blocks);
      if (tx.ops.length) { recordExternalUndo.current(tx, { preserveCreatedBlocks: true }); sync.client.push(tx.ops); }
      setTemplateError("");
    } finally { importingWord.current = false; }
  };
  const importFile = (file: File) => { void (isDocxFile(file) ? importWord(file) : importMd(file)); };
  const allDocs = useQuery({ queryKey: ["docs"], queryFn: docsApi.list });
  const mentionDocs = useMemo(() => (allDocs.data ?? []).filter((d) => d.id !== id).map((d) => ({ id: d.id, title: d.title })), [allDocs.data, id]);
  // Commenting and editing are separate capabilities: a viewer may comment
  // without ever gaining permission to modify the document.
  const canEditRole = metadataVerified && (meta.data?.role === "edit" || meta.data?.role === "manage");
  useEffect(() => { if (!canEditRole) setHistory((mode) => mode === "history" ? null : mode); }, [canEditRole]);
  const canComment = sync.blocked !== "table_unsupported" && metadataVerified && canWriteComments(meta.data);
  // Keep the composer mounted while policy is being revalidated so the local
  // draft and selection survive, but do not submit using stale permissions.
  const canSubmitComment = permissionsVerified && canComment;
  useEffect(() => { if (!canComment) freezeCommentDrafts(); }, [canComment, freezeCommentDrafts]);
  const canEditContent = canEditRole && !readingMode && !sync.blocked && !sync.client.projectionOnly;
  canEditRef.current = canEditContent;
  const saveNamedVersion = async (label: string, requestId: string) => {
    const client = sync.client;
    const notReady = (text: string) => Object.assign(new Error(text), { name: "VersionNotReady" });
    const point = namedVersionPoint(client, canEditRef.current, permissionsVerified);
    if (!point) throw notReady("请确认编辑权限并等待文档同步完成后再保存。");
    const { seq, epoch } = point;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      await docsApi.createVersionEntry(id, label, seq, epoch, requestId, me.user.id, controller.signal);
      await qc.invalidateQueries({ queryKey: ["versions", me.user.id, id] });
      const current = exportContext.current;
      if (current.mounted && current.id === id && current.user === me.user.id && current.client === client && current.verified) setPageNotice({ ok: true, text: "已保存文档版本，可在已存版本中查看。" });
    } finally { clearTimeout(timeout); }
  };
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
  const activeIsTitle = !!activeMatch && idKey(activeMatch.block) === idKey(TITLE);
  const hasTitleMatches = matches.some((match) => idKey(match.block) === idKey(TITLE));
  const requestFindScroll = useCallback(() => setFindNavigation(findScrollIntent.current.request()), []);
  const openFind = useCallback((mode: FindReplaceMode) => {
    setFindMode(mode);
    setFindOpen(true);
    setFindMessage("");
    setFindPending(null);
    requestFindScroll();
    // Focus an already-open panel for repeated keyboard shortcuts; the panel
    // itself handles initial desktop focus and avoids summoning a phone keyboard.
    if (findOpen) requestAnimationFrame(() => findPanel.current?.querySelector<HTMLInputElement>("input")?.focus());
  }, [findOpen, requestFindScroll]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!presenting && !history && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f" && !event.isComposing) {
        event.preventDefault();
        openFind("find");
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [openFind, presenting, history]);
  useEffect(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindReplacement("");
    setFindIndex(0);
    setFindMessage("");
    setFindPending(null);
  }, [id]);
  useEffect(() => {
    if (!findOpen) return;
    const ticket = findScrollIntent.current.pending(!findUpdating);
    if (ticket === null) return;
    if (activeFindIndex < 0) { findScrollIntent.current.complete(ticket); return; }
    const frame = requestAnimationFrame(() => {
      if (findScrollIntent.current.complete(ticket)) scrollArea.current?.querySelector<HTMLElement>('[data-find-active="true"]')?.scrollIntoView({ block: window.matchMedia("(max-width: 479px)").matches ? "start" : "center", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [findOpen, activeFindIndex, findNavigation, findUpdating]);
  const blankBody = !!sync.client.doc && isEmptyStarterDocument(sync.client.doc);
  const pendingStarter = peekStarter(me.user.id, id);
  const pendingImport = !!pendingStarter || !!pendingWord || pendingWordLoading || !!pendingWordError;
  const boardPending = hasBoard(me.user.id, id);
  const showTemplates = !!meta.data && sync.ready && sync.caughtUp && sync.client.droppedOnResync === 0 && sync.status === "synced" && canEditContent && blankBody && !templatesHidden && !pendingImport && !boardPending;
  // 「新建画板」：空文档同步完成后插入画板块并直接打开画板。
  useEffect(() => {
    if (!boardPending || !sync.ready || !sync.caughtUp || sync.status !== "synced" || sync.client.droppedOnResync > 0 || !canEditContent || !recordExternalUndo.current) return;
    const doc = sync.client.doc;
    if (!doc) return;
    const kind = peekBoardKind(me.user.id, id);
    takeBoard(me.user.id, id);
    if (!kind || !isEmptyStarterDocument(doc)) return;
    const tx = insertStarterBlocks(doc, [kind === "mindmap" ? MINDMAP_SEED : BOARD_SEED]);
    if (!tx) return;
    const board = bodyBlocks(doc).find((b) => doc.blockInfo(b).type === "flowchart");
    if (board) requestFlowOpen(idKey(board));
    recordExternalUndo.current(tx, { preserveCreatedBlocks: true });
    sync.client.push(tx.ops);
  });
  const applyPendingStarter = () => {
    const content = peekStarter(me.user.id, id);
    const doc = sync.client.doc;
    if (!content || !doc || submittedStarter.current) return;
    if (!canEditRef.current || !sync.client.caughtUp || sync.client.status !== "synced" || sync.client.droppedOnResync > 0 || !recordExternalUndo.current) { setTemplateError("文档当前无法安全导入，请检查编辑权限和同步状态。"); return; }
    submittedStarter.current = true;
    const tx = content.blocks ? insertStarterBlocks(doc, content.blocks) : insertStarterTemplate(doc, content.markdown);
    if (!tx) { submittedStarter.current = false; setTemplateError("文档已有内容或含不支持的内容，未导入。原文已保留。"); return; }
    recordExternalUndo.current(tx, { preserveCreatedBlocks: true });
    setPendingSubmitted(true);
    setTemplateError("");
    sync.client.push(tx.ops);
  };
  const applyPendingWord = async () => {
    const file = pendingWord?.file;
    const doc = sync.client.doc;
    if (!file || !doc || pendingWordSubmitted || importingPendingWord.current) return;
    const ready = () => {
      const context = exportContext.current;
      return context.mounted && context.id === id && context.user === me.user.id && context.client === sync.client && doc === sync.client.doc && canEditRef.current && sync.client.caughtUp && sync.client.status === "synced" && sync.client.droppedOnResync === 0 && !!recordExternalUndo.current && isEmptyStarterDocument(doc);
    };
    if (!ready()) { setTemplateError("文档不为空或当前无法安全导入，原 Word 文件仍保存在本地。"); return; }
    importingPendingWord.current = true; setPendingWordBusy(true); setTemplateError("");
    try {
      const parsed = await readDocxFile(file, { images: true });
      const blocks = await uploadDocxImportImages(parsed, (image) => docsApi.uploadImportImage(id, image, me.user.id), ready);
      if (!ready() || !recordExternalUndo.current) throw new Error("document changed");
      const tx = insertStarterBlocks(doc, blocks, true);
      if (!tx) throw new Error("document changed");
      recordExternalUndo.current(tx, { preserveCreatedBlocks: true });
      setPendingWordSubmitted(true);
      sync.client.push(tx.ops);
    } catch {
      const context = exportContext.current;
      if (context.mounted && context.id === id && context.user === me.user.id) setTemplateError("导入未完成，原 Word 文件仍保存在本地；已上传的图片可能作为未引用附件保留，请检查文档后重试。");
    } finally { importingPendingWord.current = false; setPendingWordBusy(false); }
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
        if (!d) {
          void qc.invalidateQueries({ queryKey: docMetaKey(id, me.user.id) });
          void qc.invalidateQueries({ queryKey: ["docs"] });
          return;
        }
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
    const backup = pendingDocumentBackup(me.user.id, id, sync.client.clientId, sync.client.pendingOps(), sync.client.pendingHistoryEpoch);
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
  const showArchivedDraft = () => {
    const key = recoveryState?.user === me.user.id && recoveryState.doc === id ? recoveryState.selected : "";
    if (!key) return;
    try {
      const saved = readRecoveryDraft(localStorage, me.user.id, id, key);
      if (!saved) { setRetrySyncError("本地草稿不存在，请检查浏览器存储。"); return; }
      setDraftPreview({ user: me.user.id, doc: id, ops: saved.ops, archived: true, archiveKey: key }); setRetrySyncError("");
    } catch { setRetrySyncError("无法读取本地草稿；原始备份仍保存在浏览器中。"); }
  };
  const keepDraftAndContinue = () => {
    const client = sync.client;
    if (client.blocked !== "history_changed" || !client.caughtUp || !client.unacked || !metadataVerified) return;
    let archived = false;
    try {
      const token = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join("");
      const ops = client.pendingOps();
      const key = archivePendingDraft(localStorage, me.user.id, id, token, { clientId: client.clientId, ops, blocked: "history_changed", historyEpoch: client.pendingHistoryEpoch });
      archived = true;
      const keys = recoveryDraftKeys(localStorage, me.user.id, id);
      setRecoveryState({ user: me.user.id, doc: id, keys, selected: key });
      if (!client.discardQuarantined()) { setRetrySyncError("当前文档尚未同步完成；草稿已保留，请稍后重试。"); return; }
      setDraftPreview((old) => old?.user === me.user.id && old.doc === id && !old.archived ? { ...old, ops, archived: true, archiveKey: key } : old);
      setRetrySyncError("");
    } catch { setRetrySyncError(archived ? "草稿副本已保存，但无法完成切换；请检查本地备份。" : "无法保存草稿副本，原草稿未清除；请先下载备份。"); }
  };
  const deleteArchivedDraft = async () => {
    const key = recoveryState?.user === me.user.id && recoveryState.doc === id ? recoveryState.selected : "";
    if (!key) return;
    let raw: string | null;
    try { raw = localStorage.getItem(key); } catch { setRetrySyncError("无法读取本地草稿，请检查浏览器存储。"); return; }
    if (raw === null) { setRetrySyncError("本地草稿不存在，请刷新后重试。"); return; }
    if (!await ask("删除本地草稿？", "删除后无法从本机恢复，请先下载备份。")) return;
    const current = exportContext.current;
    if (!current.mounted || current.id !== id || current.user !== me.user.id || current.client !== sync.client) return;
    try {
      if (!removeRecoveryDraft(localStorage, me.user.id, id, key, raw)) { setRetrySyncError("草稿已变化或不存在，请重新查看后重试。"); return; }
      const keys = recoveryDraftKeys(localStorage, me.user.id, id);
      setRecoveryState((old) => old?.user === me.user.id && old.doc === id ? { ...old, keys, selected: keys.includes(old.selected) ? old.selected : keys[0] ?? "" } : old);
      setDraftPreview((old) => old?.user === me.user.id && old.doc === id && old.archiveKey === key ? null : old);
      setRetrySyncError("");
    } catch { setRetrySyncError("无法删除本地草稿，请检查浏览器存储后重试。"); }
  };
  const retryPending = async () => {
    if (sync.client.blocked === "missing_dependency" || sync.client.blocked === "invalid_history" || sync.client.blocked === "history_changed") {
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
        {recoveryKeys.length > 0 && <p className="mt-3">本账号还有已保留的本地草稿。 <button type="button" onClick={downloadStoredDrafts} className="text-primary underline">下载本账号草稿备份</button></p>}
        {sync.storageError && <p className="mt-3">浏览器存储不可用或本地草稿损坏，关闭页面后可能无法恢复。</p>}
        {sync.otherPending && <p className="mt-3">本账号还有其他本地草稿。 <button type="button" onClick={downloadStoredDrafts} className="text-primary underline">下载本账号草稿备份</button></p>}
        {sync.legacyPending && <p className="mt-3">存在无法确认账号归属的旧版离线记录，请联系管理员安全恢复。</p>}
        {retrySyncError && <p className="mt-3">{retrySyncError}</p>}
        <button type="button" className="mt-4 rounded-md border px-3 py-1.5 text-foreground hover:bg-hover" disabled={meta.isFetching} onClick={() => void meta.refetch()}>{meta.isFetching ? "正在重试…" : "重试"}</button>
      </div>
    </div>;
  }
  if (meta.data && meta.data.kind !== "doc") return <ResourceTypeNotice id={id} kind={meta.data.kind} verified={metadataState === "ready"}>
    {sync.client.unacked > 0 && <p className="mt-3 text-[13px] text-muted-foreground">未同步的文档修改仍保留在本地。 <button type="button" onClick={downloadPending} className="text-primary underline">下载本地备份</button></p>}
    {sync.otherPending && <p className="mt-3 text-[13px] text-muted-foreground">本账号还有其他本地草稿。 <button type="button" onClick={downloadStoredDrafts} className="text-primary underline">下载本账号草稿备份</button></p>}
    {sync.storageError && <p className="mt-3 text-[13px] text-muted-foreground">浏览器存储不可用或本地草稿损坏，请检查后恢复。</p>}
    {sync.legacyPending && <p className="mt-3 text-[13px] text-muted-foreground">存在无法确认账号归属的旧版离线记录，请联系管理员安全恢复。</p>}
    {retrySyncError && <p className="mt-3 text-[13px] text-muted-foreground">{retrySyncError}</p>}
  </ResourceTypeNotice>;
  if (sync.blocked === "table_unsupported") return <div className="grid flex-1 place-items-center px-6" role="alert" data-table-unsupported>
    <div className="max-w-md text-center text-[14px] text-muted-foreground">
      <p>当前版本无法安全显示此文档中的表格内容，请更新应用或联系管理员。</p>
      {sync.client.unacked > 0 && <p className="mt-3">未同步的修改仍保留在本地。 <button type="button" onClick={downloadPending} className="text-primary underline">下载本地备份</button></p>}
      {sync.otherPending && <p className="mt-3">本账号还有其他本地草稿。 <button type="button" onClick={downloadStoredDrafts} className="text-primary underline">下载本账号草稿备份</button></p>}
      {sync.storageError && <p className="mt-3">浏览器存储不可用或本地草稿损坏，请先检查后恢复。</p>}
      {sync.legacyPending && <p className="mt-3">存在无法确认账号归属的旧版离线记录，请联系管理员安全恢复。</p>}
    </div>
  </div>;
  if (sync.blocked === "projection_unavailable" || sync.blocked === "protocol_incompatible") return <div className="grid flex-1 place-items-center px-6" role="alert" data-projection-unavailable>
    <div className="max-w-md text-center text-[14px] text-muted-foreground">
      <p>{sync.blocked === "protocol_incompatible" ? "服务端暂不支持安全同步，正在重新连接；如问题持续，请联系管理员更新服务。" : "文档暂时无法安全显示，正在重新连接；如问题持续，请联系文档所有者。"}</p>
      {sync.client.unacked > 0 && <p className="mt-3">未同步的修改仍保留在本地。 <button type="button" onClick={downloadPending} className="text-primary underline">下载本地备份</button></p>}
      {sync.storageError && <p className="mt-3">浏览器存储不可用或本地草稿损坏，请先检查后恢复。</p>}
    </div>
  </div>;
  const replaceFound = (all: boolean) => {
    setFindPending(null);
    const doc = sync.client.doc;
    if (!doc || findUpdating || !currentFindResult || currentFindResult.doc !== doc || !canEditRef.current || sync.client.blocked || !sync.client.caughtUp || sync.client.status !== "synced" || sync.client.unacked !== 0 || !recordExternalUndo.current) {
      setFindMessage("请等待文档同步完成并确认有编辑权限后重试。");
      return;
    }
    const selected = all ? matches : activeMatch ? [activeMatch] : [];
    if (!selected.length) return;
    if (selected.some((match) => idKey(match.block) === idKey(TITLE))) {
      setFindMessage("暂不支持替换标题；请选择正文结果。全部替换需要先排除标题匹配。");
      return;
    }
    if (all && selected.some((match) => match.table)) {
      const result = findBatchReplace.current?.(selected, findReplacement) ?? { status: "unavailable" as const, count: 0 };
      if (result.status === "replaced" || result.status === "unchanged") { setFindIndex(0); if (result.status === "replaced") { setFindMessage(""); setFindPending({ count: result.count, skipped: 0, historyChanges: sync.client.droppedOnResync }); } else setFindMessage(`${result.count} 处已是目标内容，文档未修改。`); requestFindScroll(); }
      else setFindMessage(result.status === "stale" ? "内容已变化，请重新查找；文档未修改。" : result.status === "size" || result.status === "work" ? "替换内容或范围过大，请缩小范围；文档未修改。" : "当前无法安全替换，请确认编辑权限和同步状态。");
      return;
    }
    if (!all && activeMatch?.table) {
      const outcome = tableFindReplace.current?.(activeMatch, findReplacement) ?? "unavailable";
      if (outcome === "replaced") { setFindMessage(""); setFindPending({ count: 1, skipped: 0, historyChanges: sync.client.droppedOnResync }); }
      else setFindMessage(outcome === "unchanged" ? "该处已是目标内容，文档未修改。" : outcome === "stale" ? "表格已变化，请重新查找；未修改内容。" : outcome === "size" ? "替换内容或表格过大；未修改内容。" : "当前无法安全替换，请确认编辑权限和同步状态。");
      if (outcome === "replaced" || outcome === "unchanged") requestFindScroll();
      return;
    }
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
    if (tx.ops.length) { setFindMessage(""); setFindPending({ count: result.replaced, skipped: result.skipped, historyChanges: sync.client.droppedOnResync }); }
    else setFindMessage(result.skipped ? `${result.skipped} 处内容已变化并跳过；文档未修改。` : `${result.replaced} 处已是目标内容，文档未修改。`);
    if (result.replaced) requestFindScroll();
  };

  const toggleComments = () => {
    setCommentHistoryTarget(null);
    if (commentAccessDenied) { commentRecoveryGate.current.reset(); revalidateCommentAccess(); return; }
    if (commentsOpen) freezeCommentDrafts();
    setCommentsTarget(commentsOpen ? null : { doc: id, user: me.user.id, session: commentSession });
  };
  const openPresentation = () => {
    if (commentsOpen) freezeCommentDrafts();
    setFindOpen(false); setHistory(null); setSharing(false); setAiOpen(false); setTitleCheckTarget(null); setInfoTarget(null); setVersionTarget(null); setPreview(null); setPresenting(true);
  };
  const closePresentation = () => {
    if (commentsOpen) freezeCommentDrafts();
    setPresenting(false);
  };
  const commentsPanel = commentsAvailable && commentsOpen ? (
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
            if (presenting && thread !== null && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 639px)").matches) {
              freezeCommentDrafts();
              setCommentsTarget(null);
            }
            setActiveThread(thread);
          }}
          onClose={() => {
            freezeCommentDrafts();
            setCommentsTarget(null);
            setDraft(null);
            setActiveThread(null);
          }}
        />
  ) : null;

  return (
    <div className="flex min-w-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar
          userId={me.user.id}
          sidebarDocked={sidebarDocked}
          onGlobalSearch={onGlobalSearch}
          ancestors={ancestors.data ?? []}
          shareAnchor={shareAnchor}
          onShare={() => setSharing((v) => !v)}
          onComments={toggleComments}
          onCommentHistory={commentsAvailable ? () => {
            if (commentsOpen) freezeCommentDrafts();
            setCommentsTarget(null);
            setCommentHistoryTarget({ doc: id, user: me.user.id, session: commentSession });
          } : undefined}
          onFind={() => openFind("replace")}
          onAI={aiAvailable ? () => setAiOpen((v) => !v) : undefined}
          aiOpen={aiOpen}
          onSaveTemplate={aiAvailable ? () => void saveTemplate(docMarkdown()) : undefined}
          readingMode={readingMode}
          onToggleReading={() => setReadingMode((value) => !value)}
          onCreate={() => newDoc.mutate()}
          creating={newDoc.isPending}
          onHistory={canEditRole ? () => { setPresenting(false); setHistory("history"); } : undefined}
          onSavedVersions={() => { setPresenting(false); setHistory("saved"); }}
          onPresentation={metadataVerified && sync.client.doc ? openPresentation : undefined}
          onCreateVersion={canEditContent ? () => setVersionTarget({ doc: id, user: me.user.id }) : undefined}
          onTitleCheck={() => setTitleCheckTarget({ doc: id, user: me.user.id })}
          onDocumentInfo={() => setInfoTarget({ doc: id, user: me.user.id })}
          onMentionedPeople={sync.client.doc ? () => setMentionsTarget({ doc: id, user: me.user.id }) : undefined}
          onExport={downloadAllowed ? (format) => void exportDocument(format) : undefined}
          onImport={canEditContent ? importFile : undefined}
          onOutline={() => setOutlineOpen((v) => !v)}
          width={width}
          onWidthChange={(value) => { writeDocWidth(me.user.id, id, value); setWidth(value); }}
          readOnly={!canEditRole || sync.blocked === "history_changed"}
          allowContentCopy={contentCopyAllowed}
          allowDocumentPrint={downloadAllowed}
          metadataVerified={metadataVerified}
          meta={meta.data}
          title={title}
          workspace={meta.data?.workspaceName || me.workspaces[0]?.name || "我的空间"}
          status={metadataVerified ? sync.status : "offline"}
          draftConflict={sync.blocked === "history_changed"}
          peers={sync.peers}
          me={presence}
        />
        {newDoc.isError && <p role="alert" className="border-b px-5 py-2 text-[13px] text-destructive">新建文档失败，请稍后重试。</p>}
        {pageNotice && <p role={pageNotice.ok ? "status" : "alert"} className={cn("border-b px-5 py-2 text-[13px]", pageNotice.ok ? "text-muted-foreground" : "text-destructive")} data-page-notice>{pageNotice.text}</p>}
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
        {(sync.blocked || (meta.isError && sync.client.unacked > 0)) && <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-5 py-2 text-[13px] text-amber-900">
          <span>{sync.blocked === "history_changed" ? "文档历史已变化或草稿版本无法确认，本地草稿没有自动合并；当前显示的是云端内容。" : sync.blocked === "missing_dependency" ? "本地修改依赖的历史尚不可用，暂无法自动合并；内容仍保留在本地。缺失历史恢复后会自动重试。" : sync.blocked === "invalid_history" ? "服务端文档历史不完整，无法确认同步状态；请联系管理员。" : `${sync.blocked === "read_only" ? "当前无编辑权限，" : meta.isError ? "暂时无法验证权限，" : "同步遇到冲突，"}未同步的修改保留在本地，尚未保存到云端。`}</span>{" "}
          {sync.client.unacked > 0 && <button type="button" onClick={downloadPending} className="min-h-8 underline">下载本地备份</button>}
          {sync.blocked === "history_changed" && <><button type="button" onClick={() => setDraftPreview({ user: me.user.id, doc: id, ops: sync.client.pendingOps(), archived: false })} className="min-h-8 underline" data-preview-pending-draft>查看本地草稿</button><button type="button" disabled={!sync.caughtUp || !metadataVerified} onClick={keepDraftAndContinue} className="min-h-8 underline disabled:opacity-50" data-keep-pending-draft>{canEditRole ? "保留草稿并继续编辑" : "保留草稿并查看文档"}</button></>}
          {sync.blocked && sync.blocked !== "missing_dependency" && sync.blocked !== "invalid_history" && sync.blocked !== "history_changed" && <button type="button" disabled={retryingSync} onClick={() => void retryPending()} className="min-h-8 underline disabled:opacity-50">{retryingSync ? "检查中…" : "检查权限并重试"}</button>}
          {retrySyncError && <span className="ml-2">{retrySyncError}</span>}
        </div>}
        {recoveryKeys.length > 0 && <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-[#F6F8FF] px-5 py-2 text-[13px] text-muted-foreground dark:bg-surface" data-recovery-drafts>
          <span>本机保留 {recoveryKeys.length} 份未合并草稿。</span>
          {recoveryKeys.length > 1 && <select aria-label="选择本地草稿" value={recoveryState?.selected ?? ""} onChange={(event) => setRecoveryState((old) => old && old.user === me.user.id && old.doc === id ? { ...old, selected: event.target.value } : old)} className="max-w-36 rounded border bg-surface px-1 py-0.5">{recoveryKeys.map((key, index) => <option key={key} value={key}>草稿 {index + 1}</option>)}</select>}
          <button type="button" onClick={showArchivedDraft} className="text-primary hover:underline">查看</button>
          <button type="button" onClick={downloadStoredDrafts} className="text-primary hover:underline">下载备份</button>
          <button type="button" onClick={() => void deleteArchivedDraft()} className="text-muted-foreground hover:text-destructive hover:underline" data-delete-recovery-draft>删除本地副本</button>
          {retrySyncError && <span role="alert">{retrySyncError}</span>}
        </div>}
        {draftPreview?.user === me.user.id && draftPreview.doc === id && <PendingDraftPreview ops={draftPreview.ops} onClose={() => setDraftPreview(null)} onDownload={draftPreview.archived ? downloadStoredDrafts : downloadPending} />}
        {sync.storageError && <p role="alert" className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-[13px] text-amber-900">本地草稿无法安全读取或保存，未同步内容可能无法在关闭页面后恢复。{sync.client.unacked > 0 && <> <button type="button" onClick={downloadPending} className="underline">下载本地备份</button></>}</p>}
        {sync.legacyPending && <p role="status" className="border-b px-5 py-2 text-[13px] text-muted-foreground">发现旧版未按账号区分的离线记录，无法安全确认归属，因此未自动加载。原记录仍保留在浏览器中，请联系管理员安全恢复。</p>}
        {sync.otherPending && <p role="status" className="border-b px-5 py-2 text-[13px] text-muted-foreground">本账号还有其他标签页或旧会话的本地草稿，未自动合并。 <button type="button" onClick={downloadStoredDrafts} className="underline">下载本账号草稿备份</button>{retrySyncError && <span className="ml-2">{retrySyncError}</span>}</p>}
        <div ref={scrollArea} className={cn("min-h-0 flex-1 overflow-y-auto", history ? "xl:pr-96" : aiOpen && runAI ? "xl:pr-[358px]" : commentsAvailable && commentsOpen && "xl:pr-[296px] min-[1720px]:pr-0")} onScroll={onBodyScroll} data-doc-scroll>
          <div className="flex min-h-full">
          {outline.length > 0 && <OutlineTrigger hostRef={scrollArea} buttonRef={outlineTrigger} panelId={outlinePanelId} expanded={outlineVisible} yieldToSidePanel={(commentsAvailable && commentsOpen) || !!history} onToggle={() => setOutlineOpen((value) => !value)} />}
          {outlineVisible && (
            <OutlinePanel
              id={outlinePanelId}
              items={outline}
              activeId={outlineActive}
              hostRef={scrollArea}
              yieldToSidePanel={(commentsAvailable && commentsOpen) || !!history}
              pinned={outlinePinned}
              onPinnedChange={(next) => { setOutlinePinned(next); saveOutlinePinned(next); }}
              allowCopy={contentCopyAllowed}
              allowPrint={downloadAllowed}
              onClose={() => { setOutlineOpen(false); focusOutlineEntry(); }}
              title={docTitle({ title })}
              onTop={() => { setOutlineActive(null); scrollArea.current?.scrollTo({ top: 0, behavior: "smooth" }); if (!outlineWide) { setOutlineOpen(false); focusOutlineEntry(); } }}
              onJump={(bid) => {
                const area = scrollArea.current;
                const el = area?.querySelector<HTMLElement>(`[data-block="${bid}"]`);
                if (area && el) {
                  setOutlineActive(bid);
                  area.scrollTo({ top: area.scrollTop + el.getBoundingClientRect().top - area.getBoundingClientRect().top - 24, behavior: "smooth" });
                  if (!outlineWide) { setOutlineOpen(false); focusOutlineEntry(); }
                }
              }}
            />
          )}
          <div className={cn("min-w-0 flex-1", outlineVisible && !((commentsAvailable && commentsOpen) || history) && (outlinePinned ? "min-[1456px]:pr-[248px]" : "xl:pr-14"))}>
          <DocumentCover key={`${me.user.id}:${id}`} id={id} userId={me.user.id} visible={metadataVerified} enabled={canEditContent} hasIcon={!!displayDocumentIcon(meta.data?.icon)} allowCopy={contentCopyAllowed} allowPrint={downloadAllowed} onRevalidate={() => { void meta.refetch(); }}>{({ addButton, hasCover }) => <article data-document-focus-scope data-print-doc={downloadAllowed ? "1" : undefined} data-document-print-restricted={!downloadAllowed ? "true" : undefined} data-doc-wide={width !== "default" ? "true" : undefined} data-doc-width={width} className={cn("mx-auto w-full px-7 sm:px-16", docWidthClass(width), hasCover ? "pt-8" : "pt-12 sm:pt-14", showTemplates ? "flex min-h-full flex-col pb-12" : "pb-40")}>
            <div className="group/doc-cover relative" data-outline-anchor data-document-print-restricted={!downloadAllowed ? "true" : undefined} onCopy={(event) => { if (!contentCopyAllowed) event.preventDefault(); }} onCut={(event) => { if (!contentCopyAllowed) event.preventDefault(); }}>{addButton}<DocumentIconEditor id={id} userId={me.user.id} icon={meta.data?.icon} enabled={canEditContent} onRevalidate={() => { void meta.refetch(); }} onUpdated={async (icon) => {
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
              readOnly={!canEditContent || !!history || presenting}
              placeholder="请输入标题"
              onLocalEdit={onTitle}
              findMatches={displayedMatches}
              activeFindMatch={activeMatch}
              onEnter={() => body.current?.querySelector<HTMLElement>("[data-editor]")?.focus()}
              className="text-[32px] font-medium leading-[1.3] tracking-tight [&_textarea]:font-medium [&_textarea]:leading-[1.3]"
            /></DocumentIconEditor>{metadataVerified && meta.data && <DocAuthorLine name={meta.data.creatorName} seed={meta.data.creatorId} updatedAt={meta.data.updatedAt} />}</div>
            <div ref={body} className="mt-8" data-document-print-restricted={!downloadAllowed ? "true" : undefined}>
              <Editor
                sync={sync}
                userId={me.user.id}
                onUndoRegistrar={onUndoRegistrar}
                onTableFindRegistrar={onTableFindRegistrar}
                onFindBatchRegistrar={onFindBatchRegistrar}
                findMatches={displayedMatches}
                activeFindMatch={activeMatch}
                findNavigation={findNavigation}
                me={presence}
                readOnly={!canEditContent || !!history || presenting}
                onCopyBlock={!contentCopyAllowed}
                disableFileDownloads={!downloadAllowed}
                docs={mentionDocs}
                upload={canEditContent ? (f, progress) => docsApi.upload(id, f, progress) : undefined}
                copyClipboardAssets={canEditContent ? (source, ids, request, signal) => docsApi.copyClipboardAssets(id, source, ids, request, me.user.id, signal) : undefined}
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
                ai={runAI}
                onShareBlock={metadataVerified ? (link) => { void navigator.clipboard?.writeText(link).catch(() => {}); setSharing(true); setPageNotice({ ok: true, text: "已复制该段落的链接，可在分享面板中设置访问权限。" }); } : undefined}
                onSaveTemplate={aiAvailable ? (md) => void saveTemplate(md) : undefined}
                people={(commentsAvailable && members.isSuccess ? members.data : []).map((m) => ({ id: m.id, name: m.name, email: m.email || undefined, role: m.id === meta.data?.creatorId ? "所有者" : "协作者" }))}
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
            {metadataVerified && pendingWordError && <p role="alert" className="mt-4 text-[13px] text-destructive">{pendingWordError}</p>}
            {metadataVerified && pendingWord && <div className="mt-4 rounded-md border bg-sidebar/50 p-3 text-[13px]" role="status" data-pending-word>
              <p className="text-muted-foreground">{pendingWord.missing ? "本地暂存已失效，请使用原文件重新导入。" : pendingWordSubmitted ? "导入操作已发送，请核对内容；原 Word 文件仍暂存在本地。" : !sync.ready || !sync.caughtUp ? "正在检查文档状态，原 Word 文件仍暂存在本地。" : !blankBody ? "文档已有内容，请核对是否已导入；原 Word 文件仍暂存在本地。" : `待导入 Word：${pendingWord.name}。确认文档为空后导入。`}{!pendingWord.persistent && !pendingWord.missing && " 浏览器持久暂存不可用，请勿刷新或关闭页面。"}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {!pendingWordSubmitted && pendingWord.file && <button type="button" disabled={pendingWordBusy || !canEditContent || !blankBody || !sync.caughtUp || sync.status !== "synced"} onClick={() => void applyPendingWord()} className="rounded-md bg-primary px-3 py-1 text-white disabled:opacity-50">{pendingWordBusy ? "正在导入…" : "导入内容"}</button>}
                {pendingWord.file && <button type="button" disabled={pendingWordBusy || !downloadAllowed} className="text-primary hover:underline disabled:opacity-50" onClick={() => { const a = document.createElement("a"); const url = URL.createObjectURL(pendingWord.file!); a.href = url; a.download = pendingWord.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }}>下载原 Word</button>}
                <button type="button" disabled={pendingWordBusy} className="text-muted-foreground hover:underline disabled:opacity-50" onClick={() => { void clearPendingWord(me.user.id, id, pendingWord).then(() => { const current = exportContext.current; if (current.mounted && current.user === me.user.id && current.id === id) { setPendingWordState(null); setPendingWordSubmitted(false); setTemplateError(""); } }).catch(() => { const current = exportContext.current; if (current.mounted && current.user === me.user.id && current.id === id) setTemplateError("无法清除本地暂存，请检查浏览器存储后重试。"); }); }}>清除暂存</button>
              </div>
            </div>}
            {templateError && <p role="alert" className="mt-3 text-[13px] text-destructive">{templateError}</p>}
            {showTemplates && <StarterTemplates onChoose={applyStarter} onHide={() => setTemplatesHidden(true)} />}
          </article>}</DocumentCover>
          </div>
          </div>
          {findOpen && <div aria-hidden="true" className="h-[60dvh] min-[480px]:hidden" />}
        </div>
        {findOpen && <div ref={findPanel}>
          <FindReplacePanel
            mode={findMode}
            query={findQuery}
            replacement={findReplacement}
            matchCount={matches.length}
            activeIndex={activeFindIndex}
            canReplace={findCanReplace && !activeIsTitle}
            canReplaceAll={findCanReplace && !hasTitleMatches}
            scopeNotice="搜索标题、正文、分栏和表格；公式不在范围内。"
            warningMessage={`${hasTitleMatches && findMode === "replace" ? "标题暂不支持替换，含标题匹配时无法全部替换。" : ""}${matches.length > 500 ? "结果较多，仅高亮当前项。" : ""}${!sync.caughtUp ? "文档尚未同步完成，结果可能不完整。" : ""}`}
            statusMessage={findPending ? replacementSyncNotice(findPending, sync.client) : findUpdating ? "搜索结果正在更新，暂时无法替换。" : findMessage}
            onModeChange={setFindMode}
            onQueryChange={(value) => { setFindQuery(value); setFindIndex(0); setFindMessage(""); setFindPending(null); requestFindScroll(); }}
            onReplacementChange={(value) => { setFindReplacement(value); setFindMessage(""); setFindPending(null); }}
            onNavigate={(direction) => { if (matches.length) { setFindIndex((current) => (Math.max(0, Math.min(current, matches.length - 1)) + direction + matches.length) % matches.length); requestFindScroll(); } }}
            onReplace={() => replaceFound(false)}
            onReplaceAll={() => replaceFound(true)}
            onClose={() => setFindOpen(false)}
          />
        </div>}
      </div>
      {presenting && metadataVerified && meta.data && sync.client.doc && <DocumentPresentation key={`presentation:${me.user.id}:${id}`} id={id} userId={me.user.id} title={title} icon={meta.data.icon} view={sync.client.doc.view()} synced={sync.status === "synced" && sync.caughtUp && sync.client.unacked === 0} allowCopy={contentCopyAllowed} allowPrint={downloadAllowed} commentsOpen={commentsAvailable && commentsOpen} onComments={commentsAvailable ? toggleComments : undefined} onRevalidate={() => { void meta.refetch(); }} onClose={closePresentation} commentDoc={sync.client.doc} comments={commentsAvailable ? comments.data ?? [] : []} activeThread={activeThread} contentRef={presentationBody} onActivateComment={commentsAvailable ? (thread) => { pendingCommentScroll.current = null; setActiveThread(thread); setCommentsTarget({ doc: id, user: me.user.id, session: commentSession }); } : undefined}>{commentsPanel}</DocumentPresentation>}
      {preview && <AttachmentPreview src={preview.src} name={preview.alt} mime={preview.mime} allowCopy={contentCopyAllowed} allowPrint={downloadAllowed} onClose={() => setPreview(null)} />}
      {aiOpen && runAI && <DocAIPanel title={title} body={docMarkdown} ai={runAI} canInsert={canEditContent} onInsert={appendMarkdown} onClose={() => setAiOpen(false)} />}
      {sharing && metadataVerified && meta.data && <ShareDialog meta={meta.data} anchorRef={shareAnchor} onClose={() => setSharing(false)} />}
      {commentHistoryOpen && commentsAvailable && comments.data && <HistoryCommentsPanel key={`${id}:${me.user.id}:${commentSession}`} id={id} userId={me.user.id} session={commentSession} comments={comments.data} members={members.data ?? []} canSubmit={canSubmitComment} allowCopy={contentCopyAllowed} allowPrint={downloadAllowed} onClose={() => setCommentHistoryTarget(null)} onAccessDenied={revalidateCommentAccess} onPolicyDenied={() => { void meta.refetch(); }} />}
      {metadataVerified && meta.data && infoTarget?.doc === id && infoTarget.user === me.user.id && <DocumentInfoDialog meta={meta.data} stats={infoStats} comments={commentsAvailable ? (comments.data?.length ?? null) : null} synced={sync.caughtUp && sync.status === "synced"} allowCopy={contentCopyAllowed} allowPrint={downloadAllowed} onClose={closeDocumentInfo} />}
      {mentionSummary && <DocumentMentionsDialog summary={mentionSummary} synced={sync.caughtUp && sync.status === "synced" && sync.client.unacked === 0} allowCopy={contentCopyAllowed} allowPrint={downloadAllowed} onClose={() => {
        const previous = document.activeElement;
        setMentionsTarget(null);
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (active && active !== previous && active !== document.body && active !== document.documentElement) return;
          document.querySelector<HTMLButtonElement>("[data-more-menu]")?.focus({ preventScroll: true });
        });
      }} onJump={(person) => {
        const current = sync.client.doc && collectDocumentMentions(sync.client.doc.view()).people.find((item) => item.userId === person.userId);
        const area = scrollArea.current;
        if (!current || !area) return false;
        const block = area.querySelector<HTMLElement>(`[data-block="${current.firstBlock}"]`);
        const target = block && [...block.querySelectorAll<HTMLElement>("[data-member]")].find((item) => item.dataset.member === String(person.userId));
        if (!target) return false;
        area.scrollTo({ top: area.scrollTop + target.getBoundingClientRect().top - area.getBoundingClientRect().top - 48, behavior: "smooth" });
        const marker = String(performance.now());
        target.setAttribute("data-mention-located", marker);
        window.setTimeout(() => { if (target.getAttribute("data-mention-located") === marker) target.removeAttribute("data-mention-located"); }, 2500);
        return true;
      }} />}
      {metadataVerified && meta.data && titleCheckTarget?.doc === id && titleCheckTarget.user === me.user.id && <TitleConsistency key={`${me.user.id}:${id}`} id={id} allowCopy={contentCopyAllowed} allowPrint={downloadAllowed} onClose={() => setTitleCheckTarget(null)} onAccessDenied={() => { void meta.refetch(); }} />}
      {metadataVerified && versionTarget?.doc === id && versionTarget.user === me.user.id && <NamedVersionDialog key={`save-version:${me.user.id}:${id}`} docId={id} userId={me.user.id} title={docTitle({ title })} onSave={saveNamedVersion} onClose={() => setVersionTarget(null)} />}
      {metadataVerified && history && (history !== "history" || canEditRole) && (
        <VersionPanel
          key={`version-history:${me.user.id}:${id}:${history}:${linkedVersion === null ? "invalid" : linkedVersion ?? "none"}`}
          id={id}
          userId={me.user.id}
          onCreateVersion={() => setVersionTarget({ doc: id, user: me.user.id })}
          canEdit={canEditContent}
          canViewHistory={canEditRole}
          mode={history}
          initialVersionId={history === "saved" ? linkedVersion : undefined}
          canRestore={!!namedVersionPoint(sync.client, canEditContent, permissionsVerified)}
          allowCopy={contentCopyAllowed}
          disableFileDownloads={!downloadAllowed}
          currentView={sync.client.doc?.view()}
          onClose={() => { setHistory(null); if (linkedVersion !== undefined) location.hash = withoutVersionHash(location.hash); }}
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
      {!presenting && commentsPanel}
    </div>
  );
}

const STATUS: Record<SyncStatus, { label: string; color: string }> = {
  synced: { label: "已同步", color: "#00B42A" },
  syncing: { label: "同步中…", color: "#3370FF" },
  connecting: { label: "连接中…", color: "#FF8800" },
  offline: { label: "离线，恢复后自动同步", color: "#8F959E" },
};

function TopBar({
  userId,
  sidebarDocked,
  onGlobalSearch,
  ancestors,
  meta,
  title,
  workspace,
  status,
  draftConflict = false,
  peers,
  me,
  shareAnchor,
  onShare,
  onComments,
  onFind,
  onAI,
  aiOpen,
  onSaveTemplate,
  readingMode,
  onToggleReading,
  onCreate,
  creating,
  onHistory,
  onSavedVersions,
  onPresentation,
  onCreateVersion,
  onTitleCheck,
  onDocumentInfo,
  onMentionedPeople,
  onCommentHistory,
  onExport,
  onImport,
  onOutline,
  width,
  onWidthChange,
  readOnly,
  allowContentCopy,
  allowDocumentPrint,
  metadataVerified,
}: {
  userId: number;
  sidebarDocked: boolean;
  onGlobalSearch?: () => void;
  ancestors: import("@/lib/api").DocMeta[];
  shareAnchor: React.RefObject<HTMLButtonElement | null>;
  onShare: () => void;
  onComments: () => void;
  onFind: () => void;
  onAI?: () => void;
  aiOpen?: boolean;
  onSaveTemplate?: () => void;
  readingMode: boolean;
  onToggleReading: () => void;
  onCreate: () => void;
  creating: boolean;
  onOutline: () => void;
  width: DocWidth;
  onWidthChange: (value: DocWidth) => void;
  onHistory?: () => void;
  onSavedVersions: () => void;
  onPresentation?: () => void;
  onCreateVersion?: () => void;
  onTitleCheck: () => void;
  onDocumentInfo: () => void;
  onMentionedPeople?: () => void;
  onCommentHistory?: () => void;
  onExport?: (format: "md" | "docx") => void;
  onImport?: (f: File) => void;
  readOnly: boolean;
  allowContentCopy: boolean;
  allowDocumentPrint: boolean;
  metadataVerified: boolean;
  meta?: DocMeta;
  title: string;
  workspace: string;
  status: SyncStatus;
  draftConflict?: boolean;
  peers: RemotePeer[];
  me: Presence;
}) {
  const s = STATUS[status];
  const [saved, setSaved] = useState({ doc: meta?.id, seenSynced: false, saved: false });
  const savedFlag = saved.doc === meta?.id ? saved : { doc: meta?.id, seenSynced: false, saved: false };
  useEffect(() => {
    setSaved((prev) => {
      const base = prev.doc === meta?.id ? prev : { doc: meta?.id, seenSynced: false, saved: false };
      const next = nextSavedFlag(base, status);
      return next === prev ? prev : { ...next, doc: meta?.id };
    });
  }, [status, meta?.id]);
  const metaText = draftConflict ? "本地草稿待处理" : headerMetaText(status, savedFlag.saved, meta?.updatedAt);
  const metaTitle = meta ? `创建者：${meta.creatorName}${meta.updatedAt ? ` · 最近修改：${formatEditTime(meta.updatedAt)}` : ""}` : undefined;
  return (
    <header className={cn("flex h-14 shrink-0 items-center gap-1 border-b pl-14 pr-2 sm:gap-3 md:h-16 md:pr-5", sidebarDocked && "md:pl-5")}>
      <div className="min-w-0 flex-1">
      <nav className="flex min-w-0 items-center gap-1.5 text-[13px]" data-document-print-restricted={!allowDocumentPrint ? "true" : undefined} onCopy={(event) => { if (!allowContentCopy) event.preventDefault(); }} onCut={(event) => { if (!allowContentCopy) event.preventDefault(); }}>
        <a href="#/" className="hidden truncate text-muted-foreground hover:text-foreground sm:block">
          {workspace}
        </a>
        <span className="hidden shrink-0 text-primary sm:block">
          {meta?.kind === "base" ? <BaseIcon /> : <DocumentGlyph icon={meta?.icon} fallback={<DocIcon />} />}
        </span>
        {ancestors.map((a, i) => (
          <span key={a.id} className="flex min-w-0 items-center gap-1.5">
            <span className={cn("text-subtle", i === 0 && "hidden sm:inline")}>/</span>
            <a href={hrefOf(a)} className="truncate text-muted-foreground hover:text-foreground">
              {docTitle(a)}
            </a>
          </span>
        ))}
        <span className={cn("text-subtle", !ancestors.length && "hidden sm:inline")}>/</span>
        <span className="truncate font-medium text-foreground">{meta ? docTitle({ title }) : "…"}</span>
        {metadataVerified && meta && <StarButton docId={meta.id} />}
      </nav>
      <span className="hidden items-center gap-1 text-[11px] text-subtle sm:flex" data-status={draftConflict ? "blocked" : status} data-header-meta title={metaTitle}><span className="size-1.5 rounded-full" style={{ background: draftConflict ? "#D83931" : s.color }} />{metaText}</span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
        {readOnly && <span className="hidden rounded bg-hover px-2 py-0.5 text-xs text-muted-foreground sm:inline">只读</span>}
        <Button ref={shareAnchor} size="sm" disabled={!meta || !metadataVerified} className="h-9 gap-1.5 bg-[#1456f0] px-2.5 text-[14px] font-normal hover:bg-[#0f4dd6] sm:h-8 sm:w-20" onClick={onShare}>
          <BuildingIcon className="size-4" />分享
        </Button>
        {!readOnly && <ModeMenu reading={readingMode} onToggle={onToggleReading} />}
        <NotificationBell onOpenDoc={(id) => (location.hash = `#/doc/${id}`)} />
        <DocMenu userId={userId} onAI={onAI} onSaveTemplate={onSaveTemplate} meta={metadataVerified ? meta : undefined} onHistory={metadataVerified ? onHistory : undefined} onSavedVersions={metadataVerified ? onSavedVersions : undefined} onPresentation={metadataVerified ? onPresentation : undefined} onCreateVersion={metadataVerified ? onCreateVersion : undefined} onTitleCheck={metadataVerified ? onTitleCheck : undefined} onDocumentInfo={metadataVerified ? onDocumentInfo : undefined} onMentionedPeople={metadataVerified ? onMentionedPeople : undefined} onCommentHistory={metadataVerified ? onCommentHistory : undefined} onExport={onExport} onImport={onImport} onOutline={onOutline} width={width} onWidthChange={onWidthChange} onComments={onComments} onFind={onFind} onPrint={() => window.print()} />
        <span className="mx-1 hidden h-6 w-px bg-border sm:block" />
        <button onClick={onGlobalSearch} title="搜索文档" aria-label="搜索文档" className="hidden size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover lg:grid"><SearchIcon className="size-[17px]" /></button>
        <button onClick={onCreate} disabled={creating} title="新建文档" aria-label="新建文档" className="hidden size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover disabled:opacity-50 lg:grid"><AddIcon className="size-[18px]" /></button>
        {onAI && <button onClick={onAI} title="AI 助手" aria-label="AI 助手" aria-pressed={!!aiOpen} className={cn("hidden h-8 items-center gap-1 rounded-md px-1.5 hover:bg-hover sm:flex", aiOpen ? "text-primary" : "text-muted-foreground")} data-doc-ai><Sparkles size={16} /><span className="hidden text-[13px] xl:inline">AI</span></button>}
        <button onClick={onComments} title="评论" aria-label="评论" className="hidden h-8 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-hover sm:flex"><MessageSquare size={17} /><span className="hidden text-[13px] xl:inline">评论</span></button>
        <div className="ml-1 hidden items-center -space-x-1.5 sm:flex" aria-label="协作者">
          <Avatar name={me.name} color={me.color} size={26} ring title={`${me.name}（你）`} />
          {peers.slice(0, 5).map((p) => <Avatar key={p.clientId} name={p.state.name} color={p.state.color} size={26} ring />)}
          {peers.length > 5 && <span className="grid size-[26px] place-items-center rounded-full bg-hover text-[11px] ring-2 ring-white">+{peers.length - 5}</span>}
        </div>
      </div>
    </header>
  );
}

/** 飞书标题下的作者行：头像 + 创建者 | 修改日期。 */
function DocAuthorLine({ name, seed, updatedAt }: { name: string; seed: number; updatedAt?: string }) {
  const day = updatedAt ? formatEditDay(updatedAt) : "";
  return <div contentEditable={false} className="mt-[19px] flex h-5 select-none items-center text-[12px] leading-5 text-subtle" data-doc-author>
    <span className="flex min-w-0 items-center gap-1"><Avatar name={name || "?"} color={colorFor(seed)} size={20} /><span className="truncate">{name}</span></span>
    {day && <><span className="mx-3 h-3 w-px shrink-0 bg-[#DEE0E3] dark:bg-border" /><span className="shrink-0" title={updatedAt ? formatEditTime(updatedAt) : undefined}>{day}</span></>}
  </div>;
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
      className={cn("hidden size-6 shrink-0 place-items-center rounded hover:bg-hover sm:grid", starred ? "text-[#ffc60a]" : "text-subtle hover:text-foreground")}
      title={starred ? "取消收藏" : "收藏"}
      aria-label={starred ? "取消收藏" : "收藏"}
      aria-pressed={starred}
      onClick={() => {
        (starred ? extrasApi.unstar(docId) : extrasApi.star(docId)).then(() => qc.invalidateQueries({ queryKey: ["favorites"] }));
      }}
      data-star-doc
    >
      <Star size={15} strokeWidth={1.7} fill={starred ? "currentColor" : "none"} />
    </button>
  );
}

function StarMenuItem({ docId, onDone }: { docId: number; onDone: () => void }) {
  const qc = useQueryClient();
  const favs = useQuery({ queryKey: ["favorites"], queryFn: extrasApi.favorites });
  const starred = favs.data?.some((d) => d.id === docId) ?? false;
  return <button className="flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-hover" onClick={() => { (starred ? extrasApi.unstar(docId) : extrasApi.star(docId)).then(() => qc.invalidateQueries({ queryKey: ["favorites"] })); onDone(); }}><Star size={15} className="shrink-0 text-[#646A73] dark:text-muted-foreground" />{starred ? "取消收藏" : "添加到收藏"}</button>;
}

function PinMenuItem({ docId, userId, onDone }: { docId: number; userId: number; onDone: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const pins = useQuery({ queryKey: ["pins"], queryFn: extrasApi.pins, refetchOnMount: "always", retry: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const pinned = !!pins.data?.some((item) => item.id === docId);
  const toggle = async () => {
    if (!pins.isSuccess || pins.isFetching || locked.current) return;
    locked.current = true; setPending(true); setError("");
    try {
      await extrasApi.pinForAccount(docId, userId, !pinned);
      await qc.invalidateQueries({ queryKey: ["pins"] });
      if (live.current) onDone();
    } catch {
      void qc.invalidateQueries({ queryKey: ["pins"] });
      if (live.current) setError(t("置顶状态未能确认，请重新检查后再试。"));
    } finally { locked.current = false; if (live.current) setPending(false); }
  };
  return <div><button type="button" disabled={pending || pins.isPending || pins.isFetching || pins.isError || !!error} onClick={() => void toggle()} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-hover disabled:opacity-50"><Pin size={15} className="shrink-0 text-[#646A73] dark:text-muted-foreground"/>{t(pinned ? "从“置顶”移除" : "添加到“置顶”")}</button>{(pins.isError || error) && <p role="alert" className="px-3 pb-2 text-[12px] text-destructive">{error || t("无法读取置顶状态。")} <button type="button" className="underline" onClick={() => { setError(""); void pins.refetch(); }}>{t("重新检查")}</button></p>}</div>;
}

function DocMenu({
  userId,
  meta,
  onHistory,
  onSavedVersions,
  onPresentation,
  onCreateVersion,
  onTitleCheck,
  onDocumentInfo,
  onMentionedPeople,
  onCommentHistory,
  onExport,
  onImport,
  onOutline,
  width,
  onWidthChange,
  onComments,
  onFind,
  onPrint,
  onAI,
  onSaveTemplate,
}: {
  userId: number;
  meta?: DocMeta;
  onHistory?: () => void;
  onSavedVersions?: () => void;
  onPresentation?: () => void;
  onCreateVersion?: () => void;
  onTitleCheck?: () => void;
  onDocumentInfo?: () => void;
  onMentionedPeople?: () => void;
  onCommentHistory?: () => void;
  onExport?: (format: "md" | "docx") => void;
  onImport?: (f: File) => void;
  onOutline: () => void;
  width?: DocWidth;
  onWidthChange?: (value: DocWidth) => void;
  onPrint: () => void;
  onAI?: () => void;
  onSaveTemplate?: () => void;
  onComments: () => void;
  onFind: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const [moveOpen, setMoveOpen] = useState(false);
  const [sub, setSub] = useState<"download" | "width" | null>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) { setOpen(false); setSub(null); } };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); setSub(null); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
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
  const close = () => { setOpen(false); setSub(null); };
  const trash = async () => {
    if (!meta) return;
    // 版本化云盘删除：folder 子树会被 fence 拒绝旧式语句
    await driveApi.trash(meta.id, meta.driveRevision ?? 0);
    qc.invalidateQueries({ queryKey: ["docs"] });
    qc.invalidateQueries({ queryKey: ["drive"] });
    qc.invalidateQueries({ queryKey: ["trash"] });
    location.hash = "#/";
  };
  const item = "block w-full rounded px-3 py-1.5 text-left text-[13px] hover:bg-hover";
  const row = "flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-hover";
  const icon = "shrink-0 text-[#646A73] dark:text-muted-foreground";
  const group = "border-t border-[#DEE0E3] py-1 first:border-t-0 dark:border-border";
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
    <div className="relative" ref={menuRoot}>
      <button ref={menuTrigger} className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground sm:size-8" title="更多" aria-label="更多" aria-expanded={open} aria-haspopup="menu" onClick={() => { setOpen((o) => !o); setSub(null); }} data-more-menu>
        <MoreIcon className="size-4" />
      </button>
      {copyPending && <span role="status" className="absolute right-0 top-9 z-40 whitespace-nowrap rounded-md border bg-surface px-3 py-2 text-[13px] text-muted-foreground shadow-lg">正在创建副本…</span>}
      {copyNotice && <div role="status" className="absolute right-0 top-9 z-40 flex w-64 items-start gap-2 rounded-md border bg-surface px-3 py-2 text-[13px] shadow-lg"><span className="min-w-0 flex-1">{copyNotice}</span><button type="button" aria-label="关闭提示" onClick={() => setCopyNotice("")} className="text-muted-foreground hover:text-foreground">×</button></div>}
      {copyError && <div role="alert" className="absolute right-0 top-9 z-40 flex w-64 items-start gap-2 rounded-md border bg-surface px-3 py-2 text-[13px] text-destructive shadow-lg"><span className="min-w-0 flex-1">{copyError}</span><button type="button" aria-label="关闭错误提示" onClick={() => setCopyError("")} className="text-muted-foreground hover:text-foreground">×</button></div>}
      {open && (
        <div className="absolute right-0 top-9 z-30 w-[min(240px,calc(100vw-24px))] max-h-[calc(100dvh-4rem)] sm:w-[176px] overflow-y-auto rounded-lg border border-[#DEE0E3] bg-surface py-1 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border sm:max-h-none sm:overflow-visible" data-doc-more-menu>
          {/* 飞书「…」菜单分组（2026-11-11 实测）：页宽 / 查找 / 收藏与位置 / 模板、副本、下载 / 打印 / 文档信息与历史 / 删除 */}
          {onWidthChange && width && (
            <div className={cn(group, "relative")} data-doc-width-menu onMouseEnter={() => { if (window.matchMedia("(hover: hover)").matches) setSub("width"); }} onMouseLeave={() => setSub((value) => value === "width" ? null : value)}>
              <button className={cn(row, sub === "width" && "bg-hover")} type="button" aria-haspopup="true" aria-expanded={sub === "width"} onClick={() => setSub("width")}>
                <PanelsTopLeft size={15} className={icon} /><span className="flex-1">页宽设置</span><ChevronRight size={14} className="text-subtle" />
              </button>
              {sub === "width" && <div className="px-2 pb-2 sm:absolute sm:right-full sm:top-0 sm:z-40 sm:p-0">
                <DocWidthOptions width={width} onChange={(value) => { onWidthChange(value); setSub(null); close(); }} />
              </div>}
            </div>
          )}
          {onPresentation && <div className={group}><button className={row} onClick={() => { close(); onPresentation(); }} data-document-present><Presentation size={15} className={icon} />演示模式</button></div>}
          <div className={group}>
            <button className={row} onClick={() => { close(); onFind(); }}><Search size={15} className={icon} />查找和替换</button>
            <button className={row} onClick={() => { close(); onOutline(); }} data-outline><ListTree size={15} className={icon} />目录</button>
            {onAI && <button className={cn(row, "sm:hidden")} onClick={() => { close(); onAI(); }}><Sparkles size={15} className={icon} />AI 助手</button>}
            <button className={cn(row, "sm:hidden")} onClick={() => { close(); onComments(); }}><MessageSquare size={15} className={icon} />评论</button>
          </div>
          {meta && <div className={group}>
            {meta.role === "manage" && <button className={row} onClick={() => { close(); setMoveOpen(true); }}><FolderInput size={15} className={icon} />{t("移动到")}</button>}
            <PinMenuItem docId={meta.id} userId={userId} onDone={() => { close(); requestAnimationFrame(() => menuTrigger.current?.focus()); }} />
            {meta && <StarMenuItem docId={meta.id} onDone={close} />}
          </div>}
          <div className={group}>
            {onSaveTemplate && <button className={row} onClick={() => { close(); onSaveTemplate(); }} data-save-template><LayoutTemplate size={15} className={icon} />保存为模板</button>}
            {canCopyDocument(meta) && <button className={cn(row, "disabled:opacity-50")} disabled={copyPending} onClick={() => void duplicate()} data-duplicate><Copy size={15} className={icon} />创建副本</button>}
            {<div className="relative" onMouseEnter={() => setSub("download")} onMouseLeave={() => setSub(null)}>
              <button className={cn(row, sub === "download" && "bg-hover")} aria-haspopup="menu" aria-expanded={sub === "download"} onClick={() => setSub("download")} data-download-menu><Download size={15} className={icon} /><span className="flex-1">下载为</span><ChevronRight size={14} className="text-subtle" /></button>
              <div role="menu" className={cn("mx-2 mb-2 rounded-lg border border-[#DEE0E3] bg-surface py-1 shadow-[0_6px_24px_rgba(31,35,41,0.12)] dark:border-border sm:absolute sm:right-full sm:top-0 sm:z-40 sm:mx-0 sm:mb-0 sm:w-44", sub !== "download" && "hidden")}>
                {onExport && <button className={row} onClick={() => { close(); onExport("md"); }}><FileText size={15} className={icon} />导出 Markdown</button>}
                {onExport && <button className={row} onClick={() => { close(); onExport("docx"); }} data-export-docx><FileType size={15} className={icon} />导出 Word（.docx）</button>}
                {<button className={row} onClick={() => { close(); onPrint(); }} data-export-pdf><FileDown size={15} className={icon} />导出 PDF（打印）</button>}
              </div>
            </div>}
            {onImport && (
              <label className={cn(row, "cursor-pointer")} data-import-md>
                <FileUp size={15} className={icon} />导入 Markdown
                <input type="file" accept=".md,.markdown,text/markdown" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ""; close(); }} />
              </label>
            )}
            {onImport && (
              <label className={cn(row, "cursor-pointer")} data-import-docx>
                <FileUp size={15} className={icon} />导入 Word
                <input type="file" accept={`.docx,${DOCX_MIME}`} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ""; close(); }} />
              </label>
            )}
          </div>
          {<div className={group}><button className={row} onClick={() => { close(); onPrint(); }}><Printer size={15} className={icon} />打印</button></div>}
          {onCreateVersion && <div className={group}><button className={row} onClick={() => { close(); onCreateVersion(); }} data-save-named-version><FileText size={15} className={icon} />另存为版本</button></div>}
          <div className={group}>
            {onDocumentInfo && <button className={row} onClick={() => { close(); onDocumentInfo(); }} data-document-info><Info size={15} className={icon} />文档信息</button>}
            {onMentionedPeople && <button className={row} onClick={() => { close(); onMentionedPeople(); }} data-document-mentions><AtSign size={15} className={icon} />{t("提及的人")}</button>}
            {onSavedVersions && <button className={row} onClick={() => { close(); onSavedVersions(); }} data-view-saved-versions><FileText size={15} className={icon} />查看已存版本</button>}
            {onHistory && <button className={row} onClick={() => { close(); onHistory(); }} data-doc-history><History size={15} className={icon} />历史记录</button>}
            {onCommentHistory && <button className={row} onClick={() => { close(); onCommentHistory(); }} data-comment-history-entry><MessageSquare size={15} className={icon} />{t("历史评论")}</button>}
            {onTitleCheck && <button className={row} onClick={() => { close(); onTitleCheck(); }}><SpellCheck size={15} className={icon} />检查文档名称</button>}
            <button className={row} onClick={() => { close(); openAISettings(); }} data-ai-settings-entry><Sparkles size={15} className={icon} />AI 设置</button>
          </div>
          {meta?.role === "manage" && <div className={group}>
            <button className={cn(row, "text-destructive")} onClick={trash}><Trash2 size={15} />删除（移到回收站）</button>
          </div>}
        </div>
      )}
      {moveOpen && meta?.role === "manage" && <DocumentMoveDialog docId={meta.id} userId={userId} onClose={() => { setMoveOpen(false); requestAnimationFrame(() => menuTrigger.current?.focus()); }} onMoved={() => { setMoveOpen(false); requestAnimationFrame(() => menuTrigger.current?.focus()); }} />}
    </div>
  );
}
