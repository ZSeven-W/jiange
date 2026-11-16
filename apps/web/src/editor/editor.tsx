import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { encodeOps, eqId, idKey, Tx, UndoManager, type Doc, type OpId } from "@jiange/collab";
import type { Comment } from "@/lib/api";
import type { SyncDoc } from "@/lib/use-sync-doc";
import type { Presence } from "@/lib/presence";
import { cn } from "@/lib/utils";
import { safeURL } from "@/lib/safe-url";
import { parseMentionNotificationHash } from "@/lib/mention-notification-link";
import {
  activeMarks,
  bodyBlocks,
  clipText,
  collapsed,
  copyRange,
  deleteRange,
  joinBackward,
  joinForward,
  isSourceBlock,
  isColumnText,
  selectionContainsColumns,
  snapMathPos,
  len,
  LIST_TYPES,
  markdownShortcut,
  mathSpansFromChars,
  normalize,
  TEXTLESS,
  pasteBlocks,
  setBlockType,
  splitBlock,
  toggleMark,
  type Pos,
  type Sel,
} from "./model";
import { blockEl, caretRect, domToPos, posToDom } from "./dom";
import { filterItems, type MenuItem } from "./pinyin";
import { SlashMenu, nextSlashIndex, slashGridSize } from "./slash-menu";
import { TABLE_PICKER_LIMIT, validTablePickerSize, type TableSize } from "./table-size-picker";
import { SlashLinkPopover } from "./slash-link-popover";
import { captureInlineLink, captureInlineLinkSelection, insertInlineLink, resolveInlineLink, type InlineLinkAnchor } from "./slash-link";
import { captureLinkRange, resolveLinkRange, sameLinkRange, type LinkRange } from "./link-range";
import { applyTableEdit, CLIPPABLE_BLOCKS, createBlankTable, NEW_TABLE, parseTableData, type ClipBlock } from "./model";
import { blockAlign, FormatToolbar, type Align } from "./format-toolbar";
import { CalloutColorBar, CalloutEmoji } from "./callout-controls";
import { CodeBlockHeader } from "./code-block-header";
import { CodeLineNumbers } from "./code-line-numbers";
import { AIBlockPanel } from "./ai-panel";
import { FlowchartBlock, type FlowPeer, type FlowPresence, type FlowUpload, type FlowAssets } from "./flowchart/flowchart-block";
import { flowOpenRequests } from "./flowchart/open-requests";
import { flowIntentWrites, readFlow, type FlowChangeOutcome, type FlowGraph } from "./flowchart/model";
import type { AIAction, AIMessage } from "@/lib/ai";
import { parseMarkdown, toMarkdown } from "@/lib/markdown";
import { LinkCard } from "./link-card";
import { FileCard, fmtSize } from "./file-card";
import { ApiError, conditionalBatchBase64, linkApi } from "@/lib/api";
import { ImageBlock } from "./image-block";
import { TableBlock, type TableReorderSession, type TableResizeSession } from "./table-block";
import { equalizedTableWidths, parseTableWidths, updatedSelectedTableWidths, validTableWidths, visibleTableWidths } from "./table-widths";
import { TableWidthHistory, type TableWidthBefore } from "./table-width-history";
import { applyTableOp, coverMap, parseMerges, parseMergesStrict, planSelectionDelete, planTableAxisDelete, planTableReorder, remapWidths, type CellRange, type Merge, type TableOp, type Widths } from "./table-ops";
import { planAnchorFormats } from "./table-anchor-transfer";
import { alignmentCells, fillCells, readTableAlignments, readTableFills, remapTableFills, tableFormatCells, type TableFormatTarget } from "./table-fill";
import { planTableAppendRow, planTableClear, planTableCut, planTablePaste } from "./table-clipboard";
import { planRichTablePaste, type RichTableClipboard } from "./table-rich-clipboard";
import { TableStructureHistory } from "./table-structure-history";
import { MemberCard, type MemberInfo } from "./member-card";
import { ask, askText } from "@/components/ui/ask";
import { ArrowLeft, ArrowRight, MessageCircle, Play, Trash2 } from "lucide-react";
import { GripDots, TodoCheck } from "./menu-icons";
import { BlockHandle, blockLink, COLORABLE, CONVERTIBLE, linkedBlock, navigateDocumentHash, REVISIT_DOCUMENT_LINK, MAX_INDENT, TEXT_BLOCKS, type BlockMenuAbilities, type BlockMenuAction } from "./block-handle";
import { CALLOUT_COLORS, calloutStyle } from "./block-styles";
import { MathView } from "./math-view";
import { DiagramView } from "./diagram-view";
import { askArea } from "@/components/ui/ask";
import { AddIcon } from "@/components/feishu-icons";
import { shouldRetryImage, type ImageFailure } from "./image-retry";
import { captureCompositionSelection, resolveCompositionSelection, type CompositionAnchor } from "./composition-anchor";
import { createColumn, insertColumnAfter, MAX_COLUMNS, requestColumnDeletion, safeColumnUndo } from "./column-safety";
import { applyColumnWidths, captureColumnWidths, columnWeights, COLUMN_WIDTHS } from "./column-widths";
import { ColumnAlignmentHistory, type ConditionalAlignmentPlan } from "./column-alignment-history";
import { ColumnWidthHistory } from "./column-width-history";
import { ColumnMoveHistory } from "./column-move-history";
import { applyColumnMove, captureColumnMove } from "./column-move";
import { ColumnAlignmentCommit } from "./column-alignment-commit";
import { acquireAlignmentOwner, type AlignmentOwnerLease } from "./column-alignment-owner";
import { browserConditionalJournalEnvironment, ConditionalJournal, conditionalJournalStorageKey } from "@/lib/conditional-journal";
import { captureSlashInsertion, captureSlashQuery, consumeSlashQuery, resolveSlashQuery, updateSlashQuery, insertSlashBlock, safeSlashUndo, sourceUnchanged } from "./slash-insert";
import { insertUploadedFiles, uploadTargetUnchanged, validateUploadCommand } from "./upload-insert";
import { CLIP_MIME, blockClipboardPlain, blockPayloadFromHTML, clipboardBlocks, columnClipboardBlocks, cutConfirmedBlock, hasHiddenTableContent, writeBlockClipboard } from "./clipboard-payload";
import { copyClipboardAssetsWithRetry, planClipboardAssets } from "./clipboard-assets";
import { pastedDocumentLink } from "./document-link-paste";
import type { SlashInsertion, SlashQuery } from "./slash-insert";
import { blockCommentAnchor, COMMENTABLE_BLOCKS, commentSelection, projectCommentAnchors } from "./comment-anchor";
import { searchableLocations, type FindMatch } from "./find-replace";
import { readTableFindState, resolveTableFindMatch } from "./table-find";
import { applyTableFindReplace, type TableFindResult } from "./table-find-apply";
import { applyFindBatch, canStepFindBatch, FindBatchHistory, type BatchStatus } from "./find-batch";
import { validEditorSelection } from "./selection-safety";
import { editorClipboardRoute, isNativeControl } from "./native-control";
import { TableCellHistory } from "./table-cell-history";
import { applyTableHistory, tableHistoryGuard } from "./table-history-undo";
import { applyTableWrites, cellTableWrites, isCellTable, setTableCellAlignments, setTableCellFills, stableTableDeleteWrites, stableTableInsertWrites, stableTableReorderWrites, tableDataOf, tableRepairWrites, tableRowsOf, writeTable, type TableAlign, type TableAlignAxis } from "./table-cells";

const TYPE_FOR: Record<string, string> = { h1: "h1", h2: "h2", h3: "h3" };

export interface MentionDoc {
  id: number;
  title: string;
}
export interface Uploaded {
  id: number;
  name: string;
  mime: string;
  size: number;
}

export interface ExternalUndoOptions {
  /** Preserve newly created blocks so late remote edits cannot be tombstoned by undo. */
  preserveCreatedBlocks?: boolean;
  /** Leave focus in the invoking control instead of focusing the editor. */
  preserveFocus?: boolean;
}
export type ExternalUndoRecorder = (tx: Tx, options?: ExternalUndoOptions) => void;
export type TableFindReplacer = (match: FindMatch, replacement: string) => TableFindResult;
export type FindBatchReplacer = (matches: readonly FindMatch[], replacement: string) => { status: BatchStatus; count: number };

interface Props {
  sync: SyncDoc;
  /** Account identity binds durable conditional operations to this session. */
  userId?: number;
  readOnly?: boolean;
  /** Register a transaction from another document control with this editor's undo stack. */
  onUndoRegistrar?: (record: ExternalUndoRecorder | null) => void;
  onTableFindRegistrar?: (replace: TableFindReplacer | null) => void;
  onFindBatchRegistrar?: (replace: FindBatchReplacer | null) => void;
  /** Search results are an ephemeral view; they never alter the document. */
  findMatches?: readonly FindMatch[];
  activeFindMatch?: FindMatch | null;
  findNavigation?: number;
  /** docs offered by the @ menu */
  docs?: MentionDoc[];
  /** Documents eligible for recognizing a pasted document URL. */
  documentLinkDocs?: MentionDoc[];
  documentLinkDocsUpdatedAt?: number;
  /** workspace members offered by the @ menu（@人提及） */
  people?: MemberInfo[];
  /** stores a file and returns its id; enables image/file blocks */
  upload?: (f: File, onProgress?: (percent: number) => void) => Promise<Uploaded>;
  copyClipboardAssets?: (sourceDocId: number, fileIds: number[], requestId: string, signal: AbortSignal) => Promise<{ mapping: Record<string, number> }>;
  me: Presence;
  /** unresolved comments anchor-highlighted in the text */
  comments?: Comment[];
  /** thread currently open in the panel (stronger highlight) */
  activeThread?: number | null;
  /** called with the current selection's anchor when 评论 is clicked */
  onComment?: (anchor: { block: string; startChar: string; endChar: string; quote: string }) => void;
  /** user clicked an anchored range */
  onActivateThread?: (id: number | null) => void;
  /** 禁用正文复制/剪切 */
  onCopyBlock?: boolean;
  /** 单独控制附件下载；未提供时兼容旧的合并设置。 */
  disableFileDownloads?: boolean;
  /** 点击图片 → 大图预览 */
  onPreviewImage?: (src: string, alt: string, mime?: string) => void;
  /** 公式块编辑器（默认 askText；返回 null 表示取消） */
  onMathSource?: (src: string) => Promise<string | null>;
  /** @人 提及插入（发通知用） */
  /** 个人 AI（未提供时隐藏块菜单中的 AI / 翻译）。 */
  ai?: (messages: AIMessage[]) => Promise<string>;
  /** 块菜单「分享」：传入块链接，由页面打开分享面板。 */
  onShareBlock?: (link: string) => void;
  /** 块菜单「保存为模板」：传入所选块的 Markdown。 */
  onSaveTemplate?: (markdown: string) => void;
}

/**
 * Jiange's self-written block editor. The DOM is a projection of the
 * collaborative Doc: every input is intercepted (beforeinput/keydown), turned
 * into Tx ops, and the view re-renders from the model. IME composition is
 * left to the browser and committed as one insert on compositionend.
 */
export function Editor({ sync, userId, me, readOnly, onUndoRegistrar, onTableFindRegistrar, onFindBatchRegistrar, findMatches = [], activeFindMatch = null, findNavigation = 0, docs = [], documentLinkDocs = [], documentLinkDocsUpdatedAt = 0, people = [], upload, copyClipboardAssets, comments = [], activeThread = null, onComment, onActivateThread, onCopyBlock, disableFileDownloads, onPreviewImage, onMathSource, ai, onShareBlock, onSaveTemplate }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sel = useRef<Sel | null>(null);
  const composing = useRef<{ sel: Sel; anchor?: CompositionAnchor; snapshot?: ReturnType<Doc["richChars"]>; findRanges?: { start: number; end: number; active: boolean }[]; slashQuery?: SlashQuery } | null>(null);
  const blockedComposition = useRef<Sel | null>(null);
  const stored = useRef<Record<string, string | null> | null>(null);
  const um = useMemo(() => new UndoManager<Sel>(), [sync.client]);
  const tableHistory = useMemo(() => new TableCellHistory(), [sync.client]);
  const columnAlignmentHistory = useMemo(() => new ColumnAlignmentHistory(), [sync.client]);
  const columnWidthHistory = useMemo(() => new ColumnWidthHistory(), [sync.client]);
  const columnMoveHistory = useMemo(() => new ColumnMoveHistory(), [sync.client]);
  const tableWidthHistory = useMemo(() => new TableWidthHistory(), [sync.client]);
  const tableStructureHistory = useMemo(() => new TableStructureHistory(), [sync.client]);
  const tableStructureFocus = useMemo(() => new Map<string, { block: string; row: number; col: number; fallback: HTMLTextAreaElement }>(), [sync.client]);
  const findBatchHistory = useMemo(() => new FindBatchHistory(), [sync.client]);
  const tableCellUndoRef = useRef<(target: EventTarget | null, redo: boolean) => boolean>(() => false);
  const tableHistoryActionRef = useRef<(key: string, redo: boolean) => void>(() => {});
  const columnAlignmentHistoryActionRef = useRef<(key: string, redo: boolean) => void>(() => {});
  const tableStructureHistoryActionRef = useRef<(key: string, redo: boolean) => void>(() => {});
  const tableFindActionRef = useRef<TableFindReplacer>(() => "unavailable");
  const findBatchActionRef = useRef<FindBatchReplacer>(() => ({ status: "unavailable", count: 0 }));
  const findBatchHistoryActionRef = useRef<(key: string, redo: boolean) => void>(() => {});
  const replaceTableFind = useCallback<TableFindReplacer>((match, replacement) => tableFindActionRef.current(match, replacement), []);
  const replaceFindBatch = useCallback<FindBatchReplacer>((matches, replacement) => findBatchActionRef.current(matches, replacement), []);
  const readOnlyRef = useRef(!!readOnly);
  const copyBlockedRef = useRef(!!onCopyBlock);
  copyBlockedRef.current = !!onCopyBlock;
  const blockClipboardBusy = useRef(false);
  const copyClipboardAssetsRef = useRef(copyClipboardAssets);
  copyClipboardAssetsRef.current = copyClipboardAssets;
  const assetPasteController = useRef<AbortController | null>(null);
  const assetPasteRetry = useRef<{ key: string; requestId: string } | null>(null);
  useEffect(() => () => { assetPasteController.current?.abort(); assetPasteController.current = null; assetPasteRetry.current = null; }, [sync.client]);
  const [aiPanel, setAiPanel] = useState<{ key: string; x: number; y: number; initial?: AIAction; range?: { start: number; end: number } } | null>(null);
  const aiRangeText = useRef("");
  const [flowAutoOpen, setFlowAutoOpen] = useState<string | null>(null);
  // Open requests are consumed once the block has mounted with autoOpen.
  useEffect(() => { const d = sync.client.doc; if (!d) return; for (const k of flowOpenRequests) if (bodyBlocks(d).some((b) => idKey(b) === k)) flowOpenRequests.delete(k); });
  const onShareBlockRef = useRef(onShareBlock);
  onShareBlockRef.current = onShareBlock;
  const onSaveTemplateRef = useRef(onSaveTemplate);
  onSaveTemplateRef.current = onSaveTemplate;
  readOnlyRef.current = !!readOnly;
  const commentAllowedRef = useRef(!!onComment);
  commentAllowedRef.current = !!onComment;
  const currentClient = useRef(sync.client);
  currentClient.current = sync.client;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const currentUserId = useRef(userId); currentUserId.current = userId;
  const pendingAlignmentPlan = useRef<
    | { kind: "history"; plan: ConditionalAlignmentPlan; doc: Doc; key: string; redo: boolean; history: ColumnAlignmentHistory | ColumnWidthHistory | ColumnMoveHistory | TableWidthHistory }
    | { kind: "table-resize"; plan: ConditionalAlignmentPlan; doc: Doc; structureBefore: string | null }
    | null
  >(null);
  const alignmentOwner = useRef<{ lease: AlignmentOwnerLease; client: SyncDoc["client"]; userId: number } | null>(null);
  const alignmentOwnerRelease = useRef<Promise<void>>(Promise.resolve());
  const alignmentRequest = useRef<{ controller: AbortController; owner: ColumnAlignmentCommit } | null>(null);
  const alignmentBusy = useRef(false);
  const alignmentPendingRef = useRef(false);
  const [alignmentPending, setAlignmentPending] = useState(false);
  const [alignmentMessage, setAlignmentMessage] = useState("");
  const [waitingResizeSync, setWaitingResizeSync] = useState(false);
  const setPendingAlignment = useCallback((pending: boolean) => { alignmentPendingRef.current = pending; setAlignmentPending(pending); }, []);
  const conditionalAlignment = useMemo(() => {
    if (typeof window === "undefined" || !Number.isSafeInteger(userId) || !userId || userId < 1) return null;
    try {
      const client = sync.client, account = userId;
      const journal = new ConditionalJournal(browserConditionalJournalEnvironment(), client.docId, account);
      return new ColumnAlignmentCommit(journal, {
        active: () => mounted.current && currentClient.current === client && currentUserId.current === account && !readOnlyRef.current,
        observe: () => ({ docId: client.docId, userId: account, epoch: client.epoch, lastSeq: client.lastSeq, caughtUp: client.caughtUp, blocked: client.blocked, unacked: client.unacked }),
      });
    } catch { return null; }
  }, [sync.client, userId]);
  const [conflictDraft, setConflictDraft] = useState<{ text: string; message: string } | null>(null);
  const [slashLink, setSlashLink] = useState<{ captured: InlineLinkAnchor; client: SyncDoc["client"]; x: number; y: number; initialText?: string } | null>(null);
  const [columnNotice, setColumnNotice] = useState("");
  const [mentionNavigationNotice, setMentionNavigationNotice] = useState("");
  const [batchSyncNotice, setBatchSyncNotice] = useState<"undo" | "redo" | null>(null);
  const [tableHistoryConflict, setTableHistoryConflict] = useState<{ client: SyncDoc["client"]; key: string; redo: boolean; revision: number; reason?: "size" | "unsupported" } | null>(null);
  useEffect(() => {
    if (batchSyncNotice && canStepFindBatch(sync.client)) setBatchSyncNotice(null);
  }, [batchSyncNotice, sync.client, sync.status, sync.caughtUp, sync.blocked, sync.client.unacked]);
  const recordExternal = useCallback<ExternalUndoRecorder>((tx, options) => {
    if (readOnlyRef.current || tx.doc !== sync.client.doc || !tx.ops.length) return;
    // Template/import operations can race with other replicas editing the new
    // blocks. Undo only our inserted character IDs and retain the blocks, so a
    // late remote operation cannot be hidden by a block tombstone.
    const recorded = options?.preserveCreatedBlocks ? new Tx(tx.doc) : tx;
    if (recorded !== tx) recorded.items = tx.items.filter((item) => item.k === "ins");
    um.seal();
    um.record(recorded, sel.current, sel.current);
    um.seal();
    if (options?.preserveFocus) return;
    const active = document.activeElement;
    requestAnimationFrame(() => {
      // A template card disappears after insertion. Keep the next undo and
      // typing action on the editor without stealing a newly chosen focus.
      if (!readOnlyRef.current && (document.activeElement === document.body || document.activeElement === active)) root.current?.focus();
    });
  }, [sync.client, um]);
  useLayoutEffect(() => {
    onUndoRegistrar?.(recordExternal);
    return () => onUndoRegistrar?.(null);
  }, [onUndoRegistrar, recordExternal]);
  useLayoutEffect(() => {
    onTableFindRegistrar?.(replaceTableFind);
    return () => onTableFindRegistrar?.(null);
  }, [onTableFindRegistrar, replaceTableFind]);
  useLayoutEffect(() => {
    onFindBatchRegistrar?.(replaceFindBatch);
    return () => onFindBatchRegistrar?.(null);
  }, [onFindBatchRegistrar, replaceFindBatch]);
  const [, force] = useState(0);
  const releaseAlignmentOwner = useCallback(() => { const owner = alignmentOwner.current; alignmentOwner.current = null; if (owner) alignmentOwnerRelease.current = owner.lease.release(); }, []);
  const ensureAlignmentOwner = useCallback(async () => {
    if (!conditionalAlignment || !userId) return false;
    const client = sync.client;
    if (alignmentOwner.current?.client === client && alignmentOwner.current.userId === userId) return true;
    if (alignmentOwner.current) releaseAlignmentOwner();
    await alignmentOwnerRelease.current;
    if (!mounted.current || currentClient.current !== client || currentUserId.current !== userId) return false;
    const lease = await acquireAlignmentOwner(typeof navigator === "undefined" ? undefined : navigator.locks, client.docId, userId);
    if (!lease) return false;
    if (!mounted.current || currentClient.current !== client || currentUserId.current !== userId) { await lease.release(); return false; }
    alignmentOwner.current = { lease, client, userId };
    return true;
  }, [conditionalAlignment, sync.client, userId, releaseAlignmentOwner]);
  useEffect(() => {
    let alive = true;
    pendingAlignmentPlan.current = null; setPendingAlignment(false); setAlignmentMessage(""); setWaitingResizeSync(false);
    const check = () => {
      if (conditionalAlignment) void conditionalAlignment.hasPending().then((pending) => {
        if (!alive || currentClient.current !== sync.client || currentUserId.current !== userId) return;
        if (alignmentBusy.current && !pendingAlignmentPlan.current && !pending) return;
        if (!pending && pendingAlignmentPlan.current) { setPendingAlignment(true); setAlignmentMessage("本地操作记录已变化，无法确认结果，请检查文档历史。"); return; }
        setPendingAlignment(pending);
        setAlignmentMessage(pending ? "有一项布局操作尚待核对。" : "");
      }).catch(() => { if (alive && currentClient.current === sync.client && currentUserId.current === userId) { setPendingAlignment(true); setAlignmentMessage("无法读取本地操作记录，请检查浏览器存储后重试。"); } });
    };
    const changed = (event: StorageEvent) => { if (userId && (event.key === null || event.key === conditionalJournalStorageKey(userId, sync.client.docId))) check(); };
    check(); window.addEventListener("storage", changed);
    return () => {
      alive = false; window.removeEventListener("storage", changed);
      if (alignmentRequest.current?.owner === conditionalAlignment) { alignmentRequest.current.controller.abort(); alignmentRequest.current = null; alignmentBusy.current = false; }
      if (alignmentOwner.current?.client === sync.client && alignmentOwner.current.userId === userId) releaseAlignmentOwner();
    };
  }, [conditionalAlignment, setPendingAlignment, releaseAlignmentOwner, sync.client, userId]);

  const reconcileAlignment = useCallback(async () => {
    if (!conditionalAlignment || alignmentBusy.current || !mounted.current) return;
    if (readOnlyRef.current) { setAlignmentMessage("当前不可编辑，恢复权限后才能核对该操作。"); return; }
    alignmentBusy.current = true;
    const controller = new AbortController(); alignmentRequest.current = { controller, owner: conditionalAlignment };
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    let discarded = false, superseded = false, historyConflict = false, initialResize = false;
    try {
      if (!await ensureAlignmentOwner()) { if (mounted.current && currentClient.current === sync.client && currentUserId.current === userId) setAlignmentMessage("另一页面正在核对该操作，或浏览器不支持跨页面锁。"); return; }
      const result = await conditionalAlignment.finish(controller.signal, (attempt) => {
        const pending = pendingAlignmentPlan.current;
        if (!pending) return true; // This page has no corresponding in-memory undo stack after recovery.
        if (attempt.batch !== conditionalBatchBase64(encodeOps([pending.plan.op]))) return false;
        const d = sync.client.doc;
        if (pending.kind === "table-resize") {
          initialResize = true;
          if (d !== pending.doc) return false;
          const result = tableWidthHistory.finishInitial(d, um, pending.plan);
          if (result.status === "unobserved" || result.status === "invalid") return false;
          if (result.status === "recorded") tableStructureHistory.recordEdit(d, pending.plan.op.block, result.key, pending.structureBefore, false, um);
          else if (result.status === "no-history") discarded = true;
          else if (result.status === "changed") historyConflict = true;
          else superseded = true;
          pendingAlignmentPlan.current = null;
          return true;
        }
        if (d === pending.doc && pending.history.finishConditional(d, um, pending.plan) === "ready") {
          if (pending.key.startsWith("table-width:")) tableStructureHistory.afterEditStep(d, pending.plan.op.block, pending.key, pending.redo, [pending.plan.op]);
          pendingAlignmentPlan.current = null; return true;
        }
        if (um.peekMarker(pending.redo) === pending.key && um.discardMarker(pending.redo, pending.key, um.revision)) {
          pending.history.discard(pending.doc, pending.key, pending.redo); pendingAlignmentPlan.current = null; discarded = true; return true;
        }
        return false;
      });
      if (!mounted.current || currentClient.current !== sync.client || currentUserId.current !== userId) return;
      if (result === "committed" || result === "not_committed") {
        setPendingAlignment(false); pendingAlignmentPlan.current = null; releaseAlignmentOwner(); force((x) => x + 1);
        setAlignmentMessage("");
        setColumnNotice(result === "not_committed" ? "文档已变化，布局操作未执行；请重新操作。" : superseded ? "列宽调整已提交，但随后被其他修改覆盖；请检查表格。" : historyConflict ? "列宽调整已保存；后续表格修改可能影响这次撤销。" : discarded ? "操作已保存，但后续修改使本地撤销记录无法继续使用。" : initialResize ? "" : "布局操作已保存。");
      } else if (result === "empty" && !pendingAlignmentPlan.current) { setPendingAlignment(false); setAlignmentMessage(""); releaseAlignmentOwner(); }
      else if (result === "needs_finalize") setAlignmentMessage("操作已保存，但本地历史已变化；请先处理较新的撤销记录后再核对。");
      else if (result === "history_changed" || result === "mismatch" || result === "empty") setAlignmentMessage("无法确认操作结果，请保留当前记录并检查文档历史。");
      else if (result === "blocked") setAlignmentMessage("暂时无法核对操作，请检查账号权限和浏览器存储。");
      else setAlignmentMessage("操作结果尚未确认，可核对状态或重试相同操作。");
    } catch { if (mounted.current && currentClient.current === sync.client && currentUserId.current === userId) setAlignmentMessage("暂时无法核对操作，原请求仍保存在本地。"); }
    finally { window.clearTimeout(timer); if (alignmentRequest.current?.controller === controller) { alignmentRequest.current = null; alignmentBusy.current = false; } }
  }, [conditionalAlignment, ensureAlignmentOwner, sync.client, userId, columnAlignmentHistory, tableWidthHistory, tableStructureHistory, um, releaseAlignmentOwner, setPendingAlignment]);

  const retryAlignment = useCallback(async () => {
    if (!conditionalAlignment || alignmentBusy.current || !mounted.current) return;
    if (readOnlyRef.current) { setAlignmentMessage("当前不可编辑，恢复权限后才能重试该操作。"); return; }
    alignmentBusy.current = true;
    const controller = new AbortController(); alignmentRequest.current = { controller, owner: conditionalAlignment };
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      if (!await ensureAlignmentOwner()) { if (mounted.current && currentClient.current === sync.client && currentUserId.current === userId) setAlignmentMessage("另一页面正在处理该操作，或浏览器不支持跨页面锁。"); return; }
      const result = await conditionalAlignment.retry(controller.signal, () => {
        const pending = pendingAlignmentPlan.current;
        return !pending || sync.client.doc === pending.doc && (pending.kind === "table-resize" ? tableWidthHistory.canSubmitInitial(pending.doc, um, pending.plan) : pending.history.canSubmitConditional(pending.doc, um, pending.plan));
      });
      if (mounted.current && currentClient.current === sync.client && currentUserId.current === userId) setAlignmentMessage(result === "sent" ? "已重试，正在核对结果。" : result === "needs_resolution" ? "文档状态已变化，正在核对结果。" : "暂无法重试，原请求仍保存在本地。");
    } catch { if (mounted.current && currentClient.current === sync.client && currentUserId.current === userId) setAlignmentMessage("重试失败，原请求仍保存在本地。"); }
    finally { window.clearTimeout(timer); if (alignmentRequest.current?.controller === controller) { alignmentRequest.current = null; alignmentBusy.current = false; } }
    void reconcileAlignment();
  }, [conditionalAlignment, ensureAlignmentOwner, sync.client, userId, columnAlignmentHistory, tableWidthHistory, um, reconcileAlignment]);

  const startAlignmentUndo = useCallback(async (key: string, redo: boolean) => {
    if (!mounted.current) return;
    if (alignmentBusy.current) { setColumnNotice("上一项布局操作仍在核对，请稍后再试。"); return; }
    setColumnNotice(""); setTableHistoryConflict(null);
    if (alignmentPendingRef.current) { setAlignmentMessage("请先核对尚未完成的布局操作。"); void reconcileAlignment(); return; }
    if (!conditionalAlignment) { setColumnNotice("当前浏览器无法安全提交布局撤销。"); return; }
    if (!canStepFindBatch(sync.client)) { setColumnNotice(`请等待文档同步完成后再${redo ? "重做" : "撤销"}布局。`); return; }
    if (sync.client.epoch === null) { setColumnNotice("当前服务端不支持安全撤销，请升级服务端后重试。"); return; }
    alignmentBusy.current = true;
    const controller = new AbortController(); alignmentRequest.current = { controller, owner: conditionalAlignment };
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      if (!await ensureAlignmentOwner()) { if (mounted.current && currentClient.current === sync.client && currentUserId.current === userId) setColumnNotice("另一页面正在处理该文档，或浏览器不支持跨页面锁。"); return; }
      const d = sync.client.doc, epoch = sync.client.epoch, head = sync.client.lastSeq;
      if (!d || !canStepFindBatch(sync.client) || epoch === null || readOnlyRef.current || controller.signal.aborted) { releaseAlignmentOwner(); return; }
      const history = key.startsWith("table-width:") ? tableWidthHistory : key.startsWith("column-move:") ? columnMoveHistory : key.startsWith("column-width:") ? columnWidthHistory : columnAlignmentHistory;
      if (key.startsWith("table-width:")) {
        const match = /^table-width:(\d+):(\d+):\d+$/.exec(key);
        if (!match || tableStructureHistory.beforeEditStep(d, { client: Number(match[1]), clock: Number(match[2]) }, key, redo) === "conflict") {
          releaseAlignmentOwner(); setTableHistoryConflict({ client: sync.client, key, redo, revision: um.revision }); return;
        }
      }
      const prepared = history.prepareConditional(d, um, key, redo);
      if (prepared.status !== "ready") {
        releaseAlignmentOwner();
        if (um.peekMarker(redo) === key) setTableHistoryConflict({ client: sync.client, key, redo, revision: um.revision, ...(prepared.status === "unsupported" ? { reason: "unsupported" } : {}) });
        return;
      }
      const { plan } = prepared;
      pendingAlignmentPlan.current = { kind: "history", plan, doc: d, key, redo, history };
      setPendingAlignment(true); setAlignmentMessage("正在安全提交布局操作…");
      const result = await conditionalAlignment.start(plan.op, epoch, head, controller.signal, () => sync.client.doc === d && history.canSubmitConditional(d, um, plan));
      if (!mounted.current || currentClient.current !== sync.client || currentUserId.current !== userId) return;
      if (result === "blocked") { pendingAlignmentPlan.current = null; setPendingAlignment(false); releaseAlignmentOwner(); setAlignmentMessage(""); setColumnNotice("文档状态已变化，未执行布局操作。"); }
      else if (result === "occupied") { pendingAlignmentPlan.current = null; setAlignmentMessage("已有操作待核对，请先处理该记录。"); }
      else setAlignmentMessage(result === "sent" ? "操作已提交，正在核对同步结果。" : "操作结果尚未确认，可核对状态或重试相同操作。");
    } catch {
      let pending = true;
      try { pending = await conditionalAlignment.hasPending(); } catch { /* A damaged record must remain protected. */ }
      if (mounted.current && currentClient.current === sync.client && currentUserId.current === userId) {
        setPendingAlignment(pending);
        if (pending) setAlignmentMessage("操作结果尚未确认，原请求仍保存在本地。");
        else { pendingAlignmentPlan.current = null; releaseAlignmentOwner(); setColumnNotice("无法安全提交布局操作，请检查浏览器存储。"); }
      }
    } finally { window.clearTimeout(timer); if (alignmentRequest.current?.controller === controller) { alignmentRequest.current = null; alignmentBusy.current = false; } }
    void reconcileAlignment();
  }, [conditionalAlignment, ensureAlignmentOwner, sync.client, userId, columnAlignmentHistory, columnWidthHistory, columnMoveHistory, tableWidthHistory, tableStructureHistory, um, releaseAlignmentOwner, setPendingAlignment, reconcileAlignment]);

  /** Submit an online resize against a confirmed server head; keep uncertain requests recoverable. */
  const startTableResize = useCallback(async (doc: Doc, block: OpId, before: TableWidthBefore, value: string, structureBefore: string | null, fallback: () => boolean) => {
    if (!mounted.current) return;
    if (alignmentBusy.current || alignmentPendingRef.current) { setColumnNotice("上一项布局操作仍在核对，请稍后再试。"); return; }
    if (!conditionalAlignment) { setColumnNotice("当前浏览器无法安全提交列宽调整。"); return; }
    setColumnNotice("");
    alignmentBusy.current = true;
    const controller = new AbortController(); alignmentRequest.current = { controller, owner: conditionalAlignment };
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    let submitted = false;
    try {
      if (!await ensureAlignmentOwner()) { if (mounted.current && currentClient.current === sync.client && currentUserId.current === userId) setColumnNotice("另一页面正在处理该文档，或浏览器不支持跨页面锁。"); return; }
      if (!canStepFindBatch(sync.client)) {
        setWaitingResizeSync(true); setPendingAlignment(true); setAlignmentMessage("正在等待文档同步后提交列宽调整…");
        const deadline = Date.now() + 2000;
        while (!canStepFindBatch(sync.client) && sync.client.status !== "offline" && !sync.client.blocked && !controller.signal.aborted && mounted.current && Date.now() < deadline) await new Promise((resolve) => window.setTimeout(resolve, 100));
        if (!mounted.current || currentClient.current !== sync.client || currentUserId.current !== userId) return;
        if (controller.signal.aborted) { setPendingAlignment(false); setAlignmentMessage(""); releaseAlignmentOwner(); setColumnNotice("已取消列宽调整。"); return; }
        if (sync.client.blocked || readOnlyRef.current) { setPendingAlignment(false); setAlignmentMessage(""); releaseAlignmentOwner(); setColumnNotice("文档暂时不可编辑，未调整列宽。"); return; }
        if (!canStepFindBatch(sync.client)) {
          setPendingAlignment(false); setAlignmentMessage("");
          if (fallback() && sync.client.status !== "offline") setColumnNotice("同步较慢，列宽已保存在本地，待同步后上传。");
          releaseAlignmentOwner();
          return;
        }
        setWaitingResizeSync(false); setPendingAlignment(false); setAlignmentMessage("");
      }
      const epoch = sync.client.epoch, head = sync.client.lastSeq;
      if (sync.client.doc !== doc || !canStepFindBatch(sync.client) || epoch === null || readOnlyRef.current || controller.signal.aborted) { releaseAlignmentOwner(); setColumnNotice("文档同步状态已变化，未调整列宽，请重试。"); return; }
      um.seal();
      const prepared = tableWidthHistory.prepareInitial(doc, um, block, before, value);
      if (prepared.status !== "ready") { releaseAlignmentOwner(); setColumnNotice("表格内容或列宽已变化，未应用调整；请重试。"); return; }
      const { plan } = prepared;
      pendingAlignmentPlan.current = { kind: "table-resize", plan, doc, structureBefore };
      setPendingAlignment(true); setAlignmentMessage("正在安全提交列宽调整…");
      const result = await conditionalAlignment.start(plan.op, epoch, head, controller.signal, () => sync.client.doc === doc && tableWidthHistory.canSubmitInitial(doc, um, plan), () => { submitted = true; });
      if (!mounted.current || currentClient.current !== sync.client || currentUserId.current !== userId) return;
      if (result === "blocked") { pendingAlignmentPlan.current = null; setPendingAlignment(false); releaseAlignmentOwner(); setAlignmentMessage(""); setColumnNotice("文档状态已变化，未调整列宽；请重试。"); }
      else if (result === "occupied") { pendingAlignmentPlan.current = null; setAlignmentMessage("已有操作待核对，请先处理该记录。"); }
      else setAlignmentMessage(result === "sent" ? "列宽调整已提交，正在核对同步结果。" : "列宽调整结果尚未确认，可核对状态或重试相同操作。");
    } catch {
      let pending = true;
      try { pending = await conditionalAlignment.hasPending(); } catch { /* Keep a damaged record protected. */ }
      if (mounted.current && currentClient.current === sync.client && currentUserId.current === userId) {
        setPendingAlignment(pending);
        if (pending) setAlignmentMessage("列宽调整结果尚未确认，原请求仍保存在本地。");
        else if (submitted) { setPendingAlignment(true); setAlignmentMessage("列宽操作可能已提交，但本地记录不可用；请检查文档历史。"); }
        else {
          pendingAlignmentPlan.current = null; releaseAlignmentOwner();
          if (fallback()) setColumnNotice("安全提交暂不可用，列宽已按本地协作方式保存。");
          else setColumnNotice("无法安全提交列宽调整，请检查浏览器存储。");
        }
      }
    } finally { window.clearTimeout(timer); if (alignmentRequest.current?.controller === controller) { alignmentRequest.current = null; alignmentBusy.current = false; if (mounted.current) setWaitingResizeSync(false); } }
    await reconcileAlignment();
    for (let attempt = 0; attempt < 4 && alignmentPendingRef.current && mounted.current; attempt++) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      await reconcileAlignment();
    }
  }, [conditionalAlignment, ensureAlignmentOwner, sync.client, userId, tableWidthHistory, um, releaseAlignmentOwner, setPendingAlignment, reconcileAlignment]);

  useEffect(() => {
    if (!alignmentPending) return;
    void reconcileAlignment();
    const timer = window.setInterval(() => void reconcileAlignment(), 2500);
    return () => window.clearInterval(timer);
  }, [alignmentPending, reconcileAlignment]);
  const [remount, setRemount] = useState<Record<string, number>>({});
  const [slash, setSlash] = useState<{
    at: Pos;
    index: number;
    kind: "/" | "@";
    fromButton?: boolean;
    insertAfter?: OpId;
    buttonQuery?: string;
    tableSize?: TableSize;
    query?: SlashQuery;
    buttonContext?: { doc: Doc; parent: OpId; type: string };
  } | null>(null);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  // Keep callbacks observing the latest menu even before React renders.
  const changeSlash = useCallback((next: typeof slash | ((current: typeof slash) => typeof slash)) => {
    const value = typeof next === "function" ? next(slashRef.current) : next;
    slashRef.current = value;
    setSlash(value);
  }, []);
  const menuComposition = useRef<OpId | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingUpload = useRef<{ captured: SlashInsertion; client: SyncDoc["client"]; type: string; parent: OpId; cursor: Pos | null; boundaryIds?: OpId[] } | null>(null);
  const [toolbar, setToolbar] = useState<{ x: number; y: number } | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [touchActiveBlock, setTouchActiveBlock] = useState<string | null>(null);
  /** 跨块选区覆盖的块（文档顺序）；>1 时第一个块显示可操作全部选中块的手柄。 */
  const [selBlocks, setSelBlocks] = useState<string[]>([]);
  const selBlocksRef = useRef(selBlocks);
  selBlocksRef.current = selBlocks;
  const [toast, setToast] = useState("");
  /** 正在上传的附件：在插入位置的块下方显示占位与进度（不写入文档）。 */
  const [uploading, setUploading] = useState<{ anchor: string; name: string; percent: number; index: number; total: number } | null>(null);
  const [memberCard, setMemberCard] = useState<{ id: number; name: string; x: number; y: number } | null>(null);
  const [linkCard, setLinkCard] = useState<{ href: string; x: number; y: number; range: LinkRange; docTitle?: string } | null>(null);
  const editingLinkCard = useRef(false);
  const linkHide = useRef<number | null>(null);
  const keepLinkCard = () => { if (linkHide.current) { window.clearTimeout(linkHide.current); linkHide.current = null; } };
  const hideLinkCard = () => { if (editingLinkCard.current) return; keepLinkCard(); linkHide.current = window.setTimeout(() => { setLinkCard(null); setMemberCard(null); }, 250); };
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(""), 2400); return () => window.clearTimeout(t); }, [toast]);
  const [drag, setDrag] = useState<{
    b: OpId;
    /** 跨块选区整体拖动时的全部块（文档顺序）；单块拖动时只有 b。 */
    group: OpId[];
    over: OpId | null;
    after: boolean;
  } | null>(null);
  const [carets, setCarets] = useState<
    {
      id: number;
      name: string;
      color: string;
      x: number;
      y: number;
      h: number;
    }[]
  >([]);
  const doc = sync.client.doc;
  const blocks = doc ? bodyBlocks(doc) : [];
  const findRanges = useMemo(() => {
    const ranges = new Map<string, { start: number; end: number; active: boolean }[]>();
    if (!doc) return ranges;
    const locations = new Map(searchableLocations(doc).map(({ block, parent }) => [idKey(block), parent]));
    const cached = new Map<string, { ids: OpId[]; positions: Map<string, number>; chars: ReturnType<Doc["richChars"]> }>();
    for (const match of findMatches) {
      const key = idKey(match.block);
      const parent = locations.get(key);
      if (match.doc !== doc || !match.ids.length || !parent || !eqId(parent, match.parent)) continue;
      let state = cached.get(key);
      if (!state) {
        const ids = doc.visibleIds(match.block);
        state = { ids, positions: new Map(ids.map((id, i) => [idKey(id), i])), chars: doc.richChars(match.block) };
        cached.set(key, state);
      }
      const start = state.positions.get(idKey(match.ids[0]));
      if (start === undefined || match.ids.some((id, i) => !state!.ids[start + i] || !eqId(id, state!.ids[start + i]))) continue;
      const chars = state.chars.slice(start, start + match.ids.length);
      if (chars.some((char) => !!char.marks.math) || chars.map((char) => char.ch).join("") !== match.text) continue;
      const list = ranges.get(key) ?? [];
      list.push({ start, end: start + match.ids.length, active: match === activeFindMatch });
      ranges.set(key, list);
    }
    return ranges;
  }, [doc, sync.version, findMatches, activeFindMatch]);
  const tableFindCells = useMemo(() => {
    const cells = new Map<string, { row: number; col: number; value: string; ranges: { start: number; end: number; active: boolean }[] }[]>();
    if (!doc) return cells;
    const states = new Map<string, ReturnType<typeof readTableFindState>>();
    for (const match of findMatches) {
      if (!match.table) continue;
      const key = idKey(match.block);
      if (!states.has(key)) states.set(key, readTableFindState(doc, match.block));
      const resolved = resolveTableFindMatch(doc, match, states.get(key));
      if (!resolved) continue;
      const list = cells.get(key) ?? [], existing = list.find((item) => item.row === match.table!.row && item.col === match.table!.col);
      const range = { start: match.start, end: match.end, active: match === activeFindMatch };
      if (existing) existing.ranges.push(range);
      else list.push({ row: match.table.row, col: match.table.col, value: resolved.before, ranges: [range] });
      cells.set(key, list);
    }
    return cells;
  }, [doc, sync.version, findMatches, activeFindMatch]);
  const findRangesRef = useRef(findRanges);
  findRangesRef.current = findRanges;

  // keep the caret anchored across remote ops
  const saved = useRef<{
    a: ReturnType<Doc["anchorAt"]>;
    ab: OpId;
    f: ReturnType<Doc["anchorAt"]>;
    fb: OpId;
  } | null>(null);
  useEffect(
    () =>
      sync.onBeforeRemote(() => {
        const d = sync.client.doc,
          s = sel.current;
        if (!d || !s || !d.hasBlock(s.a.b) || !d.hasBlock(s.f.b)) return;
        saved.current = {
          a: d.anchorAt(s.a.b, s.a.o),
          ab: s.a.b,
          f: d.anchorAt(s.f.b, s.f.o),
          fb: s.f.b,
        };
      }),
    [sync],
  );
  useEffect(() => {
    const s = saved.current,
      d = sync.client.doc;
    if (!s || !d) return;
    saved.current = null;
    if (d.hasBlock(s.ab) && d.hasBlock(s.fb)) {
      const restored = {
        a: { b: s.ab, o: d.resolveAnchor(s.ab, s.a) },
        f: { b: s.fb, o: d.resolveAnchor(s.fb, s.f) },
      };
      const at = collapsed(restored) ? snapMathPos(d, restored.a) : null;
      sel.current = at ? { a: at, f: at } : restored;
    }
  }, [sync.version, sync.client]);

  // 表格单元格级存储的收敛：并发编辑后镜像过期、或旧客户端直接改了 tableData 时，
  // 由在线的可编辑客户端补写（不进入撤销栈；多个客户端同时补写的值相同，自然收敛）。
  useEffect(() => {
    if (readOnly) return;
    const timer = window.setTimeout(() => {
      const d = sync.client.doc;
      if (!d || readOnlyRef.current || !sync.client.caughtUp) return;
      const tx = new Tx(d);
      for (const b of bodyBlocks(d).flatMap((x) => [x, ...d.children(x)])) {
        const info = d.blockInfo(b);
        if (info.type !== "table") continue;
        const writes = tableRepairWrites(info.props, d.client);
        if (writes) applyTableWrites(tx, b, info.props, writes);
      }
      if (tx.ops.length) sync.client.push(tx.ops);
    }, 300 + Math.floor(Math.random() * 600));
    return () => window.clearTimeout(timer);
  }, [sync.version, sync.client, readOnly]);

  const publish = useCallback(() => {
    const d = sync.client.doc,
      s = sel.current;
    if (!d || !s || !d.hasBlock(s.f.b)) return;
    sync.client.setAwareness({
      ...me,
      cursor: { block: s.f.b, anchor: d.anchorAt(s.f.b, s.f.o) },
    } satisfies Presence);
  }, [sync.client, me]);

  /** Runs an edit as one undoable transaction. */
  const run = useCallback(
    (fn: (tx: Tx, s: Sel) => Pos | Sel | void, tag?: string, preserveCreatedBlocks = false, guardColumnAlignment = false) => {
      const d = sync.client.doc,
        original = sel.current;
      if (!d || !original || readOnlyRef.current) return;
      if (!validEditorSelection(d, original)) { sel.current = null; setColumnNotice("编辑位置已变化，请重新选择位置。"); return; }
      const at = collapsed(original) ? snapMathPos(d, original.a) : null;
      const s = at ? { a: at, f: at } : original;
      // Cross-column selections cannot be represented as a root block range.
      // Never let a structural operation delete unrelated document blocks.
      if (!eqId(s.a.b, s.f.b) && (isColumnText(d, s.a.b) || isColumnText(d, s.f.b))) { setColumnNotice("暂不支持跨栏编辑，请在同一栏内选择内容。"); return; }
      const column = guardColumnAlignment && eqId(s.a.b, s.f.b) && isColumnText(d, s.f.b) ? s.f.b : null;
      const alignmentBefore = column ? columnAlignmentHistory.capture(d, column) : null;
      if (column && !alignmentBefore) { setColumnNotice("分栏已变化，请重新选择。"); return; }
      const tx = new Tx(d);
      const r = fn(tx, s);
      const next: Sel | null = r ? ("a" in r ? r : { a: r, f: r }) : s;
      if (tx.ops.length) {
        if (column && alignmentBefore) columnAlignmentHistory.record(d, um, column, alignmentBefore);
        else um.record(preserveCreatedBlocks ? safeSlashUndo(tx) : tx, s, next, tag);
        sync.client.push(tx.ops);
      }
      sel.current = next;
      force((x) => x + 1);
      publish();
    },
    [sync.client, um, publish, columnAlignmentHistory],
  );

  const focusEditorPosition = (doc: Doc, position: Pos, afterLink = false) => {
    const captured = captureInlineLink(doc, position);
    requestAnimationFrame(() => {
      const el = root.current, active = document.activeElement;
      if (!captured || !mounted.current || !el || readOnlyRef.current || currentClient.current !== sync.client || sync.client.doc !== doc || (active && active !== document.body && !el.contains(active))) return;
      const current = resolveInlineLink(doc, captured);
      if (!current) return;
      el.focus({ preventScroll: true });
      const point = posToDom(el, current), selection = document.getSelection();
      if (!point || !selection) return;
      sel.current = { a: current, f: current };
      selection.setBaseAndExtent(point.node, point.offset, point.node, point.offset);
      if (afterLink) stored.current = { ...(stored.current ?? {}), link: null };
    });
  };

  /** AI 结果写回：替换该块文字，或在其后插入；多段结果按 Markdown 拆成多个块。 */
  const applyAiResult = useCallback((blockKey: string, result: string, mode: "replace" | "insert", range?: { start: number; end: number }) => {
    const d = sync.client.doc;
    if (!d || readOnlyRef.current) return;
    const b = { client: Number(blockKey.split(":")[0]), clock: Number(blockKey.split(":")[1]) };
    if (!d.hasBlock(b)) { setToast("原段落已被删除，未写入 AI 结果。"); return; }
    const TEXTUAL = new Set(["paragraph", "h1", "h2", "h3", "bullet", "ordered", "todo", "quote", "code"]);
    const parsed = parseMarkdown(result).filter((x) => TEXTUAL.has(x.type));
    const pieces: { type: string; text: string; props: Record<string, string> }[] = parsed.length ? parsed.map((x) => ({ type: x.type, text: x.text, props: (x.type === "todo" ? { checked: x.props.checked ?? "" } : x.type === "code" && x.props.lang ? { lang: x.props.lang } : {}) as Record<string, string> })) : [{ type: "paragraph", text: result.trim(), props: {} }];
    if (range) {
      // 选中文字：只替换该范围（文字已变化时拒绝写入）；插入则放在所在块之后。
      const n = len(d, b);
      if (range.end > n || [...d.text(b)].slice(range.start, range.end).join("") !== aiRangeText.current) { setToast("选中的文字已变化，未写入 AI 结果。"); return; }
      if (mode === "replace") {
        sel.current = { a: { b, o: range.start }, f: { b, o: range.end } };
        const flat = result.replace(/\s*\n+\s*/g, " ").trim();
        run((tx) => { tx.delete(b, range.start, range.end); if (flat) tx.insert(b, range.start, flat); return { b, o: range.start + [...flat].length }; });
        um.seal();
        return;
      }
    }
    sel.current = { a: { b, o: 0 }, f: { b, o: len(d, b) } };
    run((tx) => {
      const parent = tx.doc.blockInfo(b).parent;
      let rest = pieces;
      let after = b;
      if (mode === "replace") {
        const n = len(tx.doc, b);
        if (n) tx.delete(b, 0, n);
        if (rest[0]?.text) tx.insert(b, 0, rest[0].text);
        rest = rest.slice(1);
      }
      for (const piece of rest) {
        const nb = tx.create(piece.type, after, parent, piece.props);
        if (piece.text) tx.insert(nb, 0, piece.text);
        after = nb;
      }
      return { b: after, o: len(tx.doc, after) };
    });
    um.seal();
  }, [sync.client, run, um]);

  /** 公式块：弹编辑框改写源码。 */
  const editMathSource = useCallback(
    async (blockKey: string) => {
      const d = sync.client.doc;
      if (!d || readOnlyRef.current) return;
      const b = { client: Number(blockKey.split(":")[0]), clock: Number(blockKey.split(":")[1]) };
      if (!d.hasBlock(b)) return;
      const src0 = d.text(b);
      const chars = d.visibleIds(b);
      const askFn = onMathSource ?? ((s0: string) => askText("公式（LaTeX）", "x^2+y^2=z^2", s0));
      const src = await askFn(src0);
      if (src === null) return;
      if (!mounted.current) return;
      if (currentClient.current !== sync.client || readOnlyRef.current || sync.client.doc !== d || !sourceUnchanged(d, b, "math", chars)) { setConflictDraft({ text: src, message: "文档内容或编辑权限已变化，本次操作没有应用。请复制草稿后重试。" }); return; }
      if (!sel.current) sel.current = { a: { b, o: 0 }, f: { b, o: 0 } }; // run() 需要选区
      run((tx) => {
        const vis = tx.doc.visibleIds(b);
        if (vis.length) tx.delete(b, 0, vis.length);
        if (src) tx.insert(b, 0, src);
        return { b, o: [...src].length };
      });
      um.seal();
    },
    [sync.client, run, um, onMathSource],
  );

  /** 删除块（hover ✕）：连子块一起删（columns 的子块、无文本依赖）。 */
  const deleteBlockByKey = useCallback(
    (blockKey: string) => {
      const d = sync.client.doc;
      if (!d) return;
      const b = { client: Number(blockKey.split(":")[0]), clock: Number(blockKey.split(":")[1]) };
      if (!d.hasBlock(b)) return;
      void ask("删除此块？", undefined, true).then((ok) => {
        if (!ok) return;
        if (!sel.current) sel.current = { a: { b, o: 0 }, f: { b, o: 0 } };
        run((tx) => {
          // 先删子块（columns 容器）
          for (const ch of d.children(b)) tx.deleteBlock(ch);
          tx.deleteBlock(b);
          return undefined;
        });
        um.seal();
      });
    },
    [sync.client, run, um],
  );

  /**
   * 块菜单动作。手柄所在块属于当前跨块选区时作用于全部选中块，否则只作用于该块；
   * 复制/剪切走与键盘相同的剪贴板路径（受复制权限约束），评论复用划词评论锚点。
   */
  const replaceFile = useCallback(async (b: OpId, f: File, progress: (p: number) => void) => {
    if (!upload || readOnlyRef.current) throw new Error("readonly");
    const client = sync.client;
    const asset = await upload(f, progress);
    const d = client.doc;
    if (!mounted.current || readOnlyRef.current || sync.client !== client || !d || !d.hasBlock(b)) throw new Error("changed");
    const tx = new Tx(d);
    tx.setProp(b, "fileId", String(asset.id));
    tx.setProp(b, "name", asset.name);
    tx.setProp(b, "mime", asset.mime);
    tx.setProp(b, "size", String(asset.size));
    um.record(tx, sel.current, sel.current, "prop");
    client.push(tx.ops);
    force((x) => x + 1);
    publish();
    um.seal();
  }, [upload, sync.client, um]);
  const copyBlockLink = useCallback(async (blockKey: string) => {
    const url = blockLink(window.location.href, blockKey);
    if (!navigator.clipboard?.writeText) return setToast(`请手动复制：${url}`);
    try { await navigator.clipboard.writeText(url); setToast("已复制块链接"); } catch { setToast(`复制失败，请手动复制：${url}`); }
  }, []);
  const blockAction = useCallback(
    (blockKey: string, action: BlockMenuAction) => {
      const d = sync.client.doc;
      const el = root.current;
      if (!d || !el) return;
      const b = { client: Number(blockKey.split(":")[0]), clock: Number(blockKey.split(":")[1]) };
      if (!d.hasBlock(b)) return;
      // 只读/仅评论：只允许不改正文的操作（复制、复制链接、评论、分享、AI 预览）。
      if (readOnlyRef.current && !["copy", "link", "comment", "share", "ai", "translate", "template"].includes(action.kind)) return;
      const cur = readOnlyRef.current ? null : sel.current;
      const span = selBlocksRef.current;
      const multi = !!cur && !eqId(cur.a.b, cur.f.b) && span.length > 1 && span.includes(blockKey);
      const whole: Sel = { a: { b, o: 0 }, f: { b, o: len(d, b) } };
      const target: Sel = multi ? cur! : whole;
      const end: Pos = { b, o: len(d, b) };
      const editing = (fn: (tx: Tx, s: Sel) => void) => {
        if (readOnlyRef.current) return;
        sel.current = target;
        run((tx, s) => { fn(tx, s); return multi ? undefined : end; });
        um.seal();
      };
      switch (action.kind) {
        case "insertAfter":
          return;
        case "delete":
          if (!multi) return deleteBlockByKey(blockKey);
          void ask(`删除选中的 ${span.length} 个块？`, undefined, true).then((ok) => {
            if (!ok || readOnlyRef.current || !validEditorSelection(d, target)) return;
            sel.current = target;
            run((tx) => {
              for (const x of normalize(tx.doc, target).blocks) {
                for (const ch of tx.doc.children(x)) tx.deleteBlock(ch);
                tx.deleteBlock(x);
              }
              return undefined;
            });
            sel.current = null;
            setSelBlocks([]);
            um.seal();
          });
          return;
        case "convert":
          return editing((tx, s) => setBlockType(tx, s, action.type));
        case "indent":
          return editing((tx, s) => {
            for (const x of normalize(tx.doc, s).blocks) {
              const info = tx.doc.blockInfo(x);
              if (!TEXT_BLOCKS.has(info.type)) continue;
              const was = Number(info.props.indent ?? "0") || 0;
              const next = Math.max(0, Math.min(MAX_INDENT, was + action.delta));
              if (next !== was) tx.setProp(x, "indent", String(next));
            }
          });
        case "ai":
        case "translate": {
          const w = wrap.current, node = blockEl(el, b);
          if (!w || !node) return;
          const base = w.getBoundingClientRect(), r = node.getBoundingClientRect();
          setAiPanel({ key: blockKey, x: Math.max(0, Math.round(r.left - base.left)), y: Math.round(r.bottom - base.top + 6), initial: action.kind === "translate" ? action.lang : undefined });
          return;
        }
        case "share":
          onShareBlockRef.current?.(blockLink(location.href, blockKey));
          return;
        case "template": {
          const keys = multi ? normalize(d, target).blocks : [b];
          const md = toMarkdown(keys.map((x) => { const info = d.blockInfo(x); return { type: info.type, props: info.props, text: d.text(x), spans: d.richChars(x).length ? [{ text: d.text(x), marks: {} }] : [] }; }));
          onSaveTemplateRef.current?.(md);
          return;
        }
        case "align":
          return editing((tx, s) => setSelectionAlignment(tx, s, action.value));
        case "color":
          return editing((tx, s) => {
            for (const x of normalize(tx.doc, s).blocks) {
              if (!COLORABLE.has(tx.doc.blockInfo(x).type) || isSourceBlock(tx.doc, x)) continue;
              const n = len(tx.doc, x);
              if (n) tx.format(x, 0, n, action.key, action.value);
            }
          });
        case "copy":
        case "cut": {
          const info = d.blockInfo(b);
          if (!multi && CLIPPABLE_BLOCKS.has(info.type)) {
            if (copyBlockedRef.current || blockClipboardBusy.current) return;
            if (action.kind === "cut" && (!sync.client.caughtUp || sync.client.status !== "synced")) { setToast("请等待文档同步完成后剪切，原内容已保留。"); return; }
            const source: ClipBlock[] = [{ type: info.type, props: { ...info.props }, chars: [], source: { origin: location.origin, docId: sync.client.docId } }];
            const serialized = JSON.stringify(source);
            if (serialized.length > 2 * 1024 * 1024) { setToast("块内容过大，原内容已保留。"); return; }
            const clip = clipboardBlocks(serialized, "");
            if (!clip) { setToast("块内容过大或无法复制，原内容已保留。"); return; }
            if (hasHiddenTableContent(clip[0])) { setToast("合并单元格包含隐藏内容，请先拆分后复制或剪切。"); return; }
            let before: Uint8Array | undefined;
            try { if (action.kind === "cut") before = d.encodeState(); }
            catch { setToast("无法安全准备剪切，原内容已保留。"); return; }
            const client = sync.client;
            const clipboard = navigator.clipboard;
            const Item = typeof ClipboardItem === "undefined" ? undefined : ClipboardItem;
            blockClipboardBusy.current = true;
            void (async () => {
              try {
                const raw = await writeBlockClipboard(clipboard, Item, blockClipboardPlain(clip[0]), clip);
                if (!mounted.current || currentClient.current !== client) return;
                if (!raw) { setToast("无法确认剪贴板写入，原内容已保留。"); return; }
                if (action.kind === "copy") { setToast("已复制"); return; }
                const outcome = await cutConfirmedBlock(clipboard, raw, () => {
                  if (!mounted.current || currentClient.current !== client || copyBlockedRef.current || readOnlyRef.current || client.doc !== d || !client.caughtUp || client.status !== "synced" || !d.hasBlock(b) || !before) return false;
                  if (!validEditorSelection(d, { a: { b, o: 0 }, f: { b, o: 0 } })) return false;
                  try {
                    const after = d.encodeState();
                    return before.length === after.length && !before.some((value, index) => value !== after[index]);
                  } catch { return false; }
                }, () => {
                  sel.current = { a: { b, o: 0 }, f: { b, o: 0 } };
                  run((tx) => { tx.deleteBlock(b); return undefined; });
                  um.seal();
                });
                if (!mounted.current || currentClient.current !== client) return;
                if (outcome === "unconfirmed") setToast("无法确认剪贴板格式，原内容已保留。请检查剪贴板后重试。");
                else if (outcome === "changed") setToast("文档状态已变化，原内容已保留；剪贴板中有复制内容。");
                else setToast("已剪切");
              } catch { if (mounted.current && currentClient.current === client) setToast("剪贴板操作未完成，原内容已保留。"); }
            })().finally(() => { blockClipboardBusy.current = false; });
            return;
          }
          if (collapsed(target)) { setToast("此块没有可复制的文字。"); return; }
          el.focus({ preventScroll: true });
          sel.current = target;
          const a = posToDom(el, target.a), f = posToDom(el, target.f);
          const ds = document.getSelection();
          if (!a || !f || !ds) return;
          ds.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
          readSel();
          if (!document.execCommand(action.kind)) setToast("浏览器阻止了剪贴板操作，请使用 Ctrl/⌘ + C。");
          else if (action.kind === "copy") setToast(multi ? `已复制 ${span.length} 个块` : "已复制");
          return;
        }
        case "link":
          return void copyBlockLink(blockKey);
        case "comment": {
          if (!onComment) return;
          if (COMMENTABLE_BLOCKS.has(d.blockInfo(b).type)) {
            const blockSel = blockCommentAnchor(d, b);
            if (!blockSel.ok) { setToast("此块暂不支持评论。"); return; }
            onComment(blockSel.anchor);
            return;
          }
          const selection = commentSelection(d, whole);
          if (!selection.ok) { setToast("此块没有可评论的文字。"); return; }
          sel.current = whole;
          onComment(selection.anchor);
          return;
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sync.client, run, um, deleteBlockByKey, onComment],
  );

  // 打开带 ?block= 的块链接时滚动到该块并短暂高亮。
  const linkedDone = useRef<string | null>(null);
  const linkedHighlight = useRef<{ element: HTMLElement; timer: number; attribute: string } | null>(null);
  useEffect(() => {
    const clear = () => { const current = linkedHighlight.current; if (current) { window.clearTimeout(current.timer); current.element.removeAttribute(current.attribute); linkedHighlight.current = null; } };
    const revisit = () => { linkedDone.current = null; clear(); setMentionNavigationNotice(""); force((value) => value + 1); };
    window.addEventListener("hashchange", revisit);
    window.addEventListener(REVISIT_DOCUMENT_LINK, revisit);
    return () => { window.removeEventListener("hashchange", revisit); window.removeEventListener(REVISIT_DOCUMENT_LINK, revisit); clear(); };
  }, []);
  useEffect(() => {
    const hash = window.location.hash, route = /^#\/doc\/(\d+)(?:\?|$)/.exec(hash);
    const key = route && Number(route[1]) === sync.client.docId ? linkedBlock(hash) : null;
    if (!key || linkedDone.current === hash) return;
    const params = new URLSearchParams(hash.split("?")[1] ?? "");
    if (params.has("mention")) {
      const anchor = parseMentionNotificationHash(hash, sync.client.docId), doc = sync.client.doc;
      if (!anchor || !doc || !sync.client.caughtUp || sync.client.blocked || sync.client.epoch === null || !userId) return;
      if (anchor.epoch !== sync.client.epoch) { linkedDone.current = hash; setMentionNavigationNotice("该提及来自旧的文档历史，无法定位。"); return; }
      const [bc, bt] = anchor.block.split(":").map(Number), block = { client: bc, clock: bt };
      if (!doc.hasBlock(block) || !doc.view().blocks.some((item) => item.id === anchor.block)) { linkedDone.current = hash; setMentionNavigationNotice("提及位置已被删除。"); return; }
      const ids = doc.visibleIds(block), index = ids.findIndex((id) => idKey(id) === anchor.char);
      const marks = index < 0 ? undefined : doc.richChars(block)[index]?.marks;
      if (!marks || marks.mention !== String(userId) || marks.math || marks.link?.startsWith("#/doc/")) { linkedDone.current = hash; setMentionNavigationNotice("提及位置已被修改或删除。"); return; }
      const point = root.current && posToDom(root.current, { b: block, o: index + 1 });
      const node = point && (point.node.nodeType === Node.ELEMENT_NODE ? point.node as Element : point.node.parentElement);
      const el = node?.closest<HTMLElement>(`[data-member="${userId}"]`);
      if (!el || !root.current?.contains(el)) return;
      linkedDone.current = hash; setMentionNavigationNotice(""); el.scrollIntoView({ block: "center", inline: "nearest" }); el.setAttribute("data-mention-located", "true");
      const timer = window.setTimeout(() => { el.removeAttribute("data-mention-located"); if (linkedHighlight.current?.timer === timer) linkedHighlight.current = null; }, 2500);
      linkedHighlight.current = { element: el, timer, attribute: "data-mention-located" }; return;
    }
    const el = root.current?.querySelector<HTMLElement>(`[data-block="${CSS.escape(key)}"]`);
    if (!el) return;
    linkedDone.current = hash;
    el.scrollIntoView({ block: "center" });
    el.setAttribute("data-block-linked", "true");
    const timer = window.setTimeout(() => { el.removeAttribute("data-block-linked"); if (linkedHighlight.current?.timer === timer) linkedHighlight.current = null; }, 2000);
    linkedHighlight.current = { element: el, timer, attribute: "data-block-linked" };
  });

  /** 流程图块：双击弹多行编辑框改写 Mermaid 源码。 */
  const editDiagramSource = useCallback(
    async (blockKey: string) => {
      const d = sync.client.doc;
      if (!d || readOnlyRef.current) return;
      const b = { client: Number(blockKey.split(":")[0]), clock: Number(blockKey.split(":")[1]) };
      if (!d.hasBlock(b)) return;
      const src0 = d.text(b);
      const chars = d.visibleIds(b);
      const src = await askArea("流程图（Mermaid）", undefined, src0);
      if (src === null) return;
      if (!mounted.current) return;
      if (currentClient.current !== sync.client || readOnlyRef.current || sync.client.doc !== d || !sourceUnchanged(d, b, "diagram", chars)) { setConflictDraft({ text: src, message: "文档内容或编辑权限已变化，本次操作没有应用。请复制草稿后重试。" }); return; }
      if (!sel.current) sel.current = { a: { b, o: 0 }, f: { b, o: 0 } };
      run((tx) => {
        const vis = tx.doc.visibleIds(b);
        if (vis.length) tx.delete(b, 0, vis.length);
        if (src.trim()) tx.insert(b, 0, src.trim());
        return { b, o: [...src.trim()].length };
      });
      um.seal();
    },
    [sync.client, run, um],
  );

  /** Opening the menu is read-only; the new block is created only after a choice. */
  const onInsertAfter = useCallback(
    (b: OpId) => {
      const d = sync.client.doc;
      if (!d || !d.hasBlock(b) || readOnlyRef.current) return;
      root.current?.focus();
      const emptyParagraph = d.blockInfo(b).type === "paragraph" && len(d, b) === 0;
      const at = { b, o: emptyParagraph ? 0 : len(d, b) };
      sel.current = { a: at, f: at };
      const info = d.blockInfo(b);
      changeSlash({ at, index: 0, kind: "/", fromButton: true, insertAfter: emptyParagraph ? undefined : b, buttonQuery: "", buttonContext: { doc: d, parent: info.parent, type: info.type } });
      force((x) => x + 1);
      um.seal();
    },
    [sync.client, um],
  );

  const insertText = useCallback(
    (text: string, tag = "type") =>
      run((tx, s) => {
        let p = collapsed(s) ? s.a : deleteRange(tx, s);
        if (isSourceBlock(tx.doc, p.b)) p = { b: tx.create("paragraph", p.b, tx.doc.blockInfo(p.b).parent), o: 0 };
        const marks = stored.current;
        const n = tx.insert(p.b, p.o, text);
        if (marks) for (const [k, v] of Object.entries(marks)) if (k !== "math" && k !== "mathId") tx.format(p.b, p.o, p.o + n, k, v);
        p = { b: p.b, o: p.o + n };
        const md = isColumnText(tx.doc, p.b) ? null : markdownShortcut(tx, p, [...text].pop() ?? "");
        if (md) {
          um.seal();
          // 飞书：**粗体**、`代码` 等行内 Markdown 转换后，继续输入不再沿用该格式。
          if (eqId(md.b, p.b) && md.o > 0 && md.o < p.o) {
            const at = activeMarksAt(tx.doc, md);
            const off = Object.fromEntries(["bold", "italic", "strike", "code"].filter((k) => at[k] !== undefined && !marks?.[k]).map((k) => [k, null]));
            if (Object.keys(off).length) stored.current = { ...(stored.current ?? {}), ...off };
          }
          return md;
        }
        return p;
      }, tag),
    [run, um],
  );

  const undo = useCallback(
    (redo: boolean) => {
      const d = sync.client.doc;
      if (!d || readOnlyRef.current) return;
      const marker = um.peekMarker(redo);
      if (marker) { if (marker.startsWith("find-batch:")) findBatchHistoryActionRef.current(marker, redo); else if (marker.startsWith("table-structure:")) tableStructureHistoryActionRef.current(marker, redo); else if (marker.startsWith("column-align:") || marker.startsWith("column-width:") || marker.startsWith("column-move:") || marker.startsWith("table-width:")) columnAlignmentHistoryActionRef.current(marker, redo); else tableHistoryActionRef.current(marker, redo); return; }
      const r = redo ? um.redo(d) : um.undo(d);
      if (!r) return;
      sync.client.push(r.ops);
      const s = r.selection;
      if (s) {
        const fix = (p: Pos): Pos => {
          const b = um.map(p.b);
          return d.hasBlock(b) ? { b, o: Math.min(p.o, len(d, b)) } : (sel.current?.a ?? p);
        };
        sel.current = { a: fix(s.a), f: fix(s.f) };
      }
      force((x) => x + 1);
    },
    [sync.client, um],
  );

  // ---- DOM selection <-> model selection
  const readSel = useCallback(() => {
    const el = root.current,
      ds = document.getSelection();
    if (el && document.activeElement && el.contains(document.activeElement) && isNativeControl(document.activeElement)) {
      sel.current = null;
      setToolbar(null);
      return;
    }
    if (!el || !ds || ds.rangeCount === 0 || !el.contains(ds.anchorNode) || !el.contains(ds.focusNode)) {
      if (!wrap.current?.contains(document.activeElement)) { setToolbar(null); setCommentError(null); setSelBlocks((prev) => prev.length ? [] : prev); }
      return;
    }
    let a = domToPos(el, ds.anchorNode!, ds.anchorOffset),
      f = domToPos(el, ds.focusNode!, ds.focusOffset);
    if (!a || !f) return;
    const current = sync.client.doc;
    if (!current || !validEditorSelection(current, { a, f })) { sel.current = null; setToolbar(null); return; }
    if (current && eqId(a.b, f.b) && a.o === f.o) a = f = snapMathPos(current, a);
    const prev = sel.current;
    if (!prev || !eqId(prev.a.b, a.b) || prev.a.o !== a.o || !eqId(prev.f.b, f.b) || prev.f.o !== f.o) setCommentError(null);
    if (prev && (!eqId(prev.f.b, f.b) || Math.abs(prev.f.o - f.o) > 1)) {
      um.seal();
      stored.current = null;
    }
    sel.current = { a, f };
    const spanKeys = !eqId(a.b, f.b) && !isColumnText(current, a.b) && !isColumnText(current, f.b) ? normalize(current, { a, f }).blocks.map(idKey) : [];
    setSelBlocks((prevKeys) => prevKeys.length === spanKeys.length && prevKeys.every((key, i) => key === spanKeys[i]) ? prevKeys : spanKeys);
    const activeKey = idKey(f.b);
    setTouchActiveBlock((current) => current === activeKey ? current : activeKey);
    publish();
    updateOverlays();
    // slash menu closes when the caret leaves its query
    changeSlash((m) => {
      if (!m) return m;
      const d = sync.client.doc;
      if (!d || !eqId(m.at.b, f.b) || !collapsed(sel.current!)) return null;
      if (m.fromButton) return f.o === m.at.o ? m : null;
      const q = m.query && resolveSlashQuery(d, m.query);
      if (!q || f.o !== q.end || /\s/.test(q.text) || [...q.text].length > 16) return null;
      return q.start === m.at.o ? m : { ...m, at: { b: f.b, o: q.start } };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publish, um, sync.client]);

  useEffect(() => {
    const on = () => !composing.current && readSel();
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, [readSel]);

  const updateOverlays = () => {
    const el = root.current,
      w = wrap.current,
      d = sync.client.doc,
      s = sel.current;
    if (!el || !w || !d) return;
    const base = w.getBoundingClientRect();
    const ds = document.getSelection();
    if (s && !collapsed(s) && (!readOnlyRef.current || commentAllowedRef.current) && ds && ds.rangeCount && el.contains(ds.anchorNode) && el.contains(ds.focusNode)) {
      const r = ds.getRangeAt(0).getBoundingClientRect();
      if (r && r.width + r.height > 0) {
        const t = {
          x: Math.round(r.left - base.left + r.width / 2),
          y: Math.round(r.top - base.top),
        };
        setToolbar((o) => (o && o.x === t.x && o.y === t.y ? o : t));
      }
    } else setToolbar((o) => (o ? null : o));
    const cs: {
      id: number;
      name: string;
      color: string;
      x: number;
      y: number;
      h: number;
    }[] = [];
    for (const p of sync.peers) {
      const c = p.state.cursor;
      if (!c || !d.hasBlock(c.block) || !blockEl(el, c.block)) continue;
      const rect = caretRect(el, {
        b: c.block,
        o: d.resolveAnchor(c.block, c.anchor),
      });
      if (rect)
        cs.push({
          id: p.clientId,
          name: p.state.name,
          color: p.state.color,
          x: Math.round(rect.left - base.left),
          y: Math.round(rect.top - base.top),
          h: Math.round(rect.height || 22),
        });
    }
    setCarets((o) => (JSON.stringify(o) === JSON.stringify(cs) ? o : cs));
  };

  // after every render: put the DOM selection where the model says
  useLayoutEffect(() => {
    const el = root.current,
      s = sel.current,
      d = sync.client.doc;
    if (el && s && d && (document.activeElement === el || el.contains(document.activeElement)) && !isNativeControl(document.activeElement) && !composing.current) {
      const a = posToDom(el, s.a),
        f = posToDom(el, s.f);
      const ds = document.getSelection();
      if (a && f && ds) {
        const cur = ds.rangeCount
          ? {
              a: domToPos(el, ds.anchorNode!, ds.anchorOffset),
              f: domToPos(el, ds.focusNode!, ds.focusOffset),
            }
          : null;
        const same = cur?.a && cur.f && eqId(cur.a.b, s.a.b) && cur.a.o === s.a.o && eqId(cur.f.b, s.f.b) && cur.f.o === s.f.o;
        if (!same) ds.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
      }
    }
    updateOverlays();
  });

  // ---- input pipeline
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onBeforeInput = (e: InputEvent) => {
      if (isNativeControl(e.target)) {
        if ((e.inputType === "historyUndo" || e.inputType === "historyRedo") && tableCellUndoRef.current(e.target, e.inputType === "historyRedo")) e.preventDefault();
        return;
      }
      if (readOnlyRef.current || e.inputType === "insertCompositionText" || composing.current) return;
      if (slashRef.current?.fromButton) {
        if (e.inputType === "insertText" || e.inputType === "insertReplacementText") {
          e.preventDefault();
          const value = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
          changeSlash((m) => m?.fromButton ? { ...m, buttonQuery: ((m.buttonQuery ?? "") + value).slice(0, 32), tableSize: undefined, index: 0 } : m);
          return;
        }
        if (e.inputType.startsWith("delete")) {
          e.preventDefault();
          changeSlash((m) => m?.fromButton ? { ...m, buttonQuery: [...(m.buttonQuery ?? "")].slice(0, -1).join(""), tableSize: undefined, index: 0 } : m);
          return;
        }
      }
      e.preventDefault();
      readSel();
      const s = sel.current,
        d = sync.client.doc;
      if (!s || !d || !validEditorSelection(d, s)) return;
      const active = slashRef.current;
      const oldQuery = active && !active.fromButton ? active.query : undefined;
      const oldRange = oldQuery && resolveSlashQuery(d, oldQuery);
      const tracking = !!oldRange && collapsed(s) && eqId(s.f.b, oldQuery!.block) && s.f.o === oldRange.end;
      if (active && !active.fromButton && !tracking) changeSlash(null);
      if (active && !active.fromButton && e.inputType !== "insertText" && e.inputType !== "insertReplacementText" && !e.inputType.startsWith("delete")) changeSlash(null);
      const finishDelete = () => {
        if (!tracking || !oldQuery || slashRef.current?.query !== oldQuery) return;
        const end = sel.current?.f;
        const query = end && updateSlashQuery(oldQuery, end, "delete");
        changeSlash(query ? { ...active!, query, at: { b: query.block, o: resolveSlashQuery(d, query)!.start }, index: 0 } : null);
      };
      switch (e.inputType) {
        case "insertText":
        case "insertReplacementText": {
          const t = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
          if (!t) return;
          insertText(t);
          const end = sel.current?.f;
          if ((t === "/" || t === "@") && end && !isColumnText(d, end.b)) {
            const at = { b: end.b, o: Math.max(0, end.o - 1) };
            const query = captureSlashQuery(d, at, end, t);
            changeSlash(query ? { at, query, index: 0, kind: t } : null);
          } else if (tracking && oldQuery && end && slashRef.current?.query === oldQuery) {
            const query = updateSlashQuery(oldQuery, end, "append");
            changeSlash(query ? { ...active!, query, at: { b: query.block, o: resolveSlashQuery(d, query)!.start }, index: 0 } : null);
          }
          return;
        }
        case "insertLineBreak":
          insertText("\n", "break");
          return;
        case "insertParagraph":
          run((tx, s2) => splitBlock(tx, collapsed(s2) ? s2.a : deleteRange(tx, s2)));
          um.seal();
          return;
        case "historyUndo":
          return undo(false);
        case "historyRedo":
          return undo(true);
        case "formatBold":
          return run((tx, s2) => toggleMark(tx, s2, "bold"));
        case "formatItalic":
          return run((tx, s2) => toggleMark(tx, s2, "italic"));
        case "formatUnderline":
          return run((tx, s2) => toggleMark(tx, s2, "underline"));
        case "insertFromPaste":
        case "insertFromDrop":
          return; // handled by paste/drop listeners
        default:
          if (!e.inputType.startsWith("delete")) return;
      }
      // deletions
      if (!collapsed(s)) { run((tx, s2) => deleteRange(tx, s2), "delete"); finishDelete(); return; }
      const ranges = e.getTargetRanges();
      if (ranges.length) {
        const r = ranges[0];
        const a = domToPos(el, r.startContainer, r.startOffset),
          f = domToPos(el, r.endContainer, r.endOffset);
        if (a && f && !validEditorSelection(d, { a, f })) { setColumnNotice("编辑位置已变化，请重新选择位置。"); return; }
        if (a && f && !(eqId(a.b, f.b) && a.o === f.o)) {
          if (eqId(a.b, f.b)) { run((tx) => deleteRange(tx, { a, f }), "delete"); finishDelete(); return; }
        }
      }
      const back = e.inputType.includes("Backward");
      const p = s.a;
      if (back && p.o === 0) { run((tx) => joinBackward(tx, p.b)); finishDelete(); return; }
      if (!back && p.o === len(d, p.b)) { run((tx) => joinForward(tx, p.b)); finishDelete(); return; }
      const step = e.inputType.includes("Word") ? wordLen(d.text(p.b), p.o, back) : 1;
      run(
        (tx) =>
          deleteRange(tx, {
            a: p,
            f: { b: p.b, o: back ? p.o - step : p.o + step },
          }),
        "delete",
      );
      finishDelete();
    };
    const onCompStart = (event: CompositionEvent) => {
      if (isNativeControl(event.target)) return;
      if (readOnlyRef.current) return;
      blockedComposition.current = null;
      readSel();
      const s = sel.current,
        d = sync.client.doc;
      if (!s || !d) return;
      if (!eqId(s.a.b, s.f.b)) {
        event.preventDefault();
        blockedComposition.current = s;
        setColumnNotice("暂不支持跨块输入法替换，请在单个文本块内操作。");
        return;
      }
      if (slashRef.current?.fromButton) {
        menuComposition.current = slashRef.current.at.b;
        composing.current = { sel: s };
        return;
      }
      // Keep selected characters intact until composition actually commits.
      const anchor = captureCompositionSelection(d, s);
      if (!anchor) { event.preventDefault(); blockedComposition.current = s; setColumnNotice("输入位置无效，请重新选择文字。"); return; }
      const menu = slashRef.current;
      const range = menu?.query && resolveSlashQuery(d, menu.query);
      const slashQuery = menu?.query && range && collapsed(s) && eqId(s.f.b, menu.query.block) && s.f.o === range.end ? menu.query : undefined;
      if (menu && !menu.fromButton && !slashQuery) changeSlash(null);
      composing.current = { sel: s, anchor, snapshot: d.richChars(s.a.b), findRanges: findRangesRef.current.get(idKey(s.a.b)) ?? [], slashQuery };
    };
    const onCompEnd = (e: CompositionEvent) => {
      if (isNativeControl(e.target)) return;
      if (blockedComposition.current) {
        const blocked = blockedComposition.current;
        blockedComposition.current = null;
        const current = sync.client.doc;
        // Some IMEs ignore preventDefault and mutate every selected DOM block.
        // Recreate the projection from the unchanged CRDT, including any
        // intervening blocks and nested column text.
        const affected = current ? bodyBlocks(current).flatMap((b) => [b, ...current.children(b)]) : [blocked.a.b, blocked.f.b];
        setRemount((m) => {
          const next = { ...m };
          for (const b of affected) next[idKey(b)] = (next[idKey(b)] ?? 0) + 1;
          return next;
        });
        if (e.data) setConflictDraft({ text: e.data, message: "暂不支持跨块输入，内容未应用。请复制草稿后在单个文本块内重试。" });
        force((x) => x + 1);
        return;
      }
      const c = composing.current;
      if (readOnlyRef.current) {
        if (c) setRemount((m) => ({ ...m, [idKey(c.sel.a.b)]: (m[idKey(c.sel.a.b)] ?? 0) + 1 }));
        if (c && e.data) setConflictDraft({ text: e.data, message: "编辑权限已变化，输入内容未应用。请复制草稿后重试。" });
        composing.current = null; menuComposition.current = null; return;
      }
      composing.current = null;
      if (menuComposition.current) {
        const block = menuComposition.current;
        menuComposition.current = null;
        setRemount((m) => ({ ...m, [idKey(block)]: (m[idKey(block)] ?? 0) + 1 }));
        if (e.data) changeSlash((m) => m?.fromButton ? { ...m, buttonQuery: ((m.buttonQuery ?? "") + e.data).slice(0, 32), tableSize: undefined, index: 0 } : m);
        return;
      }
      if (!c) return;
      const currentDoc = sync.client.doc;
      const selection = currentDoc && c.anchor ? resolveCompositionSelection(currentDoc, c.anchor) : null;
      // A peer may have turned only part of the captured selection into a
      // formula while composition was active. Expanding now would delete
      // characters the user did not select, so preserve the IME draft.
      const bounds = currentDoc && selection && !collapsed(selection) ? normalize(currentDoc, selection) : null;
      const expanded = bounds && (bounds.start.o !== Math.min(selection!.a.o, selection!.f.o) || bounds.end.o !== Math.max(selection!.a.o, selection!.f.o));
      if (!selection || expanded) {
        setRemount((m) => ({ ...m, [idKey(c.sel.a.b)]: (m[idKey(c.sel.a.b)] ?? 0) + 1 }));
        if (e.data) setConflictDraft({ text: e.data, message: "输入位置已被协作者修改或删除，内容未应用。请复制草稿后重试。" });
        return;
      }
      const at = collapsed(selection) ? snapMathPos(currentDoc!, selection.a) : null;
      sel.current = at ? { a: at, f: at } : selection;
      // throw away the browser's DOM mutations for this block and commit the text
      setRemount((m) => ({
        ...m,
        [idKey(c.sel.a.b)]: (m[idKey(c.sel.a.b)] ?? 0) + 1,
      }));
      const menu = slashRef.current;
      const range = c.slashQuery && currentDoc && resolveSlashQuery(currentDoc, c.slashQuery);
      const track = !!range && menu?.query === c.slashQuery && !!at && eqId(at.b, c.slashQuery!.block) && at.o === range.end;
      if (menu && !menu.fromButton && !track) changeSlash(null);
      if (e.data) {
        insertText(e.data, "ime");
        if (track && c.slashQuery && sel.current?.f) {
          const query = updateSlashQuery(c.slashQuery, sel.current.f, "append");
          changeSlash(query ? { ...menu!, query, at: { b: query.block, o: resolveSlashQuery(currentDoc!, query)!.start }, index: 0 } : null);
        }
      }
      else force((x) => x + 1);
    };
    el.addEventListener("beforeinput", onBeforeInput);
    el.addEventListener("compositionstart", onCompStart);
    el.addEventListener("compositionend", onCompEnd);
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput);
      el.removeEventListener("compositionstart", onCompStart);
      el.removeEventListener("compositionend", onCompEnd);
    };
  }, [sync.client, run, insertText, undo, readSel, um]);

  const slashItems = useMemo(() => {
    if (!slash || !doc || !sel.current || !doc.hasBlock(slash.at.b)) return [];
    const resolved = slash.query && resolveSlashQuery(doc, slash.query);
    if (!slash.fromButton && !resolved) return [];
    const q = slash.fromButton ? (slash.buttonQuery ?? "") : [...resolved!.text].slice(1).join("");
    if (slash.kind === "@") {
      const ql = q.toLowerCase();
      const docItems = docs
        .filter((x) => (x.title || "未命名文档").toLowerCase().includes(ql))
        .slice(0, 8)
        .map((x): MenuItem => ({
          id: `doc:${x.id}`,
          label: x.title || "未命名文档",
          group: "提及文档",
          icon: "▤",
          py: [],
          en: [],
        }));
      const peopleItems = people
        .filter((m) => m.name !== me.name && m.name.toLowerCase().includes(ql))
        .slice(0, 5)
        .map((m): MenuItem => ({
          id: `user:${m.id}:${encodeURIComponent(m.name)}`,
          label: m.name,
          group: "提及成员",
          icon: "☺",
          py: [],
          en: [],
        }));
      return [...peopleItems, ...docItems];
    }
    return filterItems(q).filter((it) => upload || (it.id !== "image" && it.id !== "file"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slash, doc, sync.version, sel.current, docs, people]);

  useEffect(() => {
    const menu = slashRef.current;
    if (!menu || menu.fromButton) return;
    const current = sync.client.doc;
    const range = current && menu.query && resolveSlashQuery(current, menu.query);
    if (!range) changeSlash(null);
    else if (menu.at.o !== range.start) changeSlash({ ...menu, at: { b: menu.at.b, o: range.start } });
  }, [sync.version, sync.client, changeSlash]);

  /** Upload first; remove the captured command only after a successful insert. */
  const insertFiles = async (files: File[], context: { captured: SlashInsertion; client: SyncDoc["client"]; type: string; parent: OpId; cursor: Pos | null; boundaryIds?: OpId[] }) => {
    const { captured, client } = context;
    if (!upload || readOnlyRef.current) return;
    const preflight = validateUploadCommand(captured);
    if (preflight !== "ok" || !uploadTargetUnchanged(captured, context.type, context.parent, context.boundaryIds)) {
      setColumnNotice(preflight === "middle" ? "命令前后都有文字，暂不能安全拆分段落；请移到段首或段尾后重试。" : "文档内容已变化，附件未上传；原文已保留。");
      return;
    }
    const assets: Uploaded[] = [];
    try {
      for (const f of files) {
        if (!mounted.current) return;
        if (readOnlyRef.current || currentClient.current !== client || client.doc !== captured.doc) { setColumnNotice("文档内容或编辑权限已变化，附件未插入；原文已保留。"); return; }
        const index = assets.length;
        setUploading({ anchor: idKey(captured.anchor), name: f.name, percent: 0, index, total: files.length });
        assets.push(await upload(f, (percent) => { if (mounted.current) setUploading((u) => u && u.index === index ? { ...u, percent } : u); }));
      }
    } catch {
      if (mounted.current) { setUploading(null); setColumnNotice("上传失败，原文未修改。请检查网络后重试。"); }
      return;
    } finally {
      if (mounted.current) setUploading(null);
    }
    if (!mounted.current) return;
    if (readOnlyRef.current || currentClient.current !== client || client.doc !== captured.doc || !uploadTargetUnchanged(captured, context.type, context.parent, context.boundaryIds)) { setColumnNotice("文档内容或编辑权限已变化，附件未插入；原文已保留。"); return; }
    const at = { b: captured.anchor, o: 0 };
    const previousSelection = sel.current;
    const unchangedCursor = !!context.cursor && !!previousSelection && collapsed(previousSelection) && eqId(previousSelection.f.b, context.cursor.b) && previousSelection.f.o === context.cursor.o;
    const previousAnchors = previousSelection && captured.doc.hasBlock(previousSelection.a.b) && captured.doc.hasBlock(previousSelection.f.b)
      ? { a: captured.doc.anchorAt(previousSelection.a.b, previousSelection.a.o), f: captured.doc.anchorAt(previousSelection.f.b, previousSelection.f.o) }
      : null;
    sel.current = { a: at, f: at };
    let result: Pos | "middle" | null = null;
    run((tx) => {
      result = insertUploadedFiles(tx, captured, assets);
      return result && result !== "middle" ? result : undefined;
    }, undefined, true);
    if (!result || result === "middle") {
      sel.current = previousSelection;
      setColumnNotice(result === "middle" ? "命令前后都有文字，暂不能安全拆分段落；请移到段首或段尾后重试。" : "文档内容已变化，附件未插入；原文已保留。");
    } else if (!unchangedCursor && previousSelection && previousAnchors && captured.doc.hasBlock(previousSelection.a.b) && captured.doc.hasBlock(previousSelection.f.b)) {
      sel.current = { a: { b: previousSelection.a.b, o: captured.doc.resolveAnchor(previousSelection.a.b, previousAnchors.a) }, f: { b: previousSelection.f.b, o: captured.doc.resolveAnchor(previousSelection.f.b, previousAnchors.f) } };
      publish();
    }
    um.seal();
  };

  const applySlash = async (it: MenuItem, size?: TableSize) => {
    if (readOnlyRef.current) return;
    const m = slashRef.current;
    if (size && (!m?.fromButton || it.id !== "table" || !validTablePickerSize(size))) return;
    const chosenTable = size ? createBlankTable(size.rows, size.columns) : NEW_TABLE;
    if (!chosenTable) return;
    changeSlash(null);
    if (!m) return;
    // A remote mark change can turn a previously typed command into a formula
    // while its menu is open. Never remove part of that formula as a command.
    const original = sync.client.doc;
    const checked = original && m.query && resolveSlashQuery(original, m.query);
    if (!m.fromButton) {
      if (!original || !m.query || !checked) {
        setColumnNotice("命令内容已发生变化，原文已保留，请重新输入命令。");
        return;
      }
    } else {
      const context = m.buttonContext;
      if (!original || !context || context.doc !== original || !original.hasBlock(m.at.b)) {
        setColumnNotice("命令内容已发生变化，原文已保留，请重新输入命令。");
        return;
      }
      const info = original.blockInfo(m.at.b);
      if (info.type !== context.type || !eqId(info.parent, context.parent)) { setColumnNotice("命令位置已发生变化，原文已保留，请重试。"); return; }
    }
    const targetBlock = (tx: Tx): OpId | null => {
      const anchor = m.insertAfter ?? m.at.b;
      if (!tx.doc.hasBlock(anchor)) return null;
      const info = tx.doc.blockInfo(anchor);
      if (m.insertAfter) return tx.create("paragraph", anchor, info.parent);
      if (m.fromButton) {
        // Insert a new block before the empty paragraph instead of changing it:
        // a concurrent writer may already be adding text to that paragraph.
        const siblings = tx.doc.children(info.parent);
        const index = siblings.findIndex((id) => eqId(id, anchor));
        if (index < 0) return null;
        return tx.create("paragraph", index > 0 ? siblings[index - 1] : null, info.parent);
      }
      return anchor;
    };
    if (it.id === "link") {
      const caret = root.current ? caretRect(root.current, checked ? { b: m.at.b, o: checked.start } : m.at) : null;
      const result: { captured: InlineLinkAnchor | null } = { captured: null };
      run((tx) => {
        if (!m.fromButton && (!m.query || !resolveSlashQuery(tx.doc, m.query))) return;
        const block = m.fromButton && !m.insertAfter ? m.at.b : targetBlock(tx);
        if (!block || !tx.doc.hasBlock(block)) return;
        const offset = m.query ? consumeSlashQuery(tx, m.query) : 0;
        if (offset === null) return;
        result.captured = captureInlineLink(tx.doc, { b: block, o: offset });
        return { b: block, o: offset };
      }, undefined, !!m.insertAfter);
      if (!result.captured) { setColumnNotice("命令内容或编辑位置已变化，原文已保留，请重试。"); return; }
      um.seal();
      setSlashLink({ captured: result.captured, client: sync.client, x: caret?.left ?? window.innerWidth / 2, y: caret?.bottom ?? 80 });
      return;
    }
    if (it.id.startsWith("doc:")) {
      let applied = false;
      run((tx) => {
        const start = m.query ? consumeSlashQuery(tx, m.query) : null;
        if (start === null) return;
        const n = tx.insert(m.at.b, start, it.label);
        tx.format(m.at.b, start, start + n, "link", `#/doc/${it.id.slice(4)}`);
        tx.insert(m.at.b, start + n, " ");
        tx.format(m.at.b, start + n, start + n + 1, "link", null);
        applied = true;
        return { b: m.at.b, o: start + n + 1 };
      });
      if (!applied) setColumnNotice("命令内容已发生变化，原文已保留，请重新输入命令。");
      um.seal();
      return;
    }
    if (it.id.startsWith("user:")) {
      const rest = it.id.slice(5);
      const uid = Number(rest.split(":")[0]);
      const name = decodeURIComponent(rest.split(":").slice(1).join(":"));
      let applied = false;
      run((tx) => {
        const start = m.query ? consumeSlashQuery(tx, m.query) : null;
        if (start === null) return;
        const n = tx.insert(m.at.b, start, `@${name} `);
        tx.format(m.at.b, start, start + n - 1, "mention", String(uid));
        applied = true;
        return { b: m.at.b, o: start + n };
      });
      if (!applied) setColumnNotice("命令内容已发生变化，原文已保留，请重新输入命令。");
      um.seal();
      return;
    }
    if (it.id === "image" || it.id === "file") {
      const originalDoc = sync.client.doc;
      const at = checked ? { b: m.at.b, o: checked.start } : m.at;
      const end = checked ? { b: m.at.b, o: checked.end } : null;
      const captured = originalDoc && captureSlashInsertion(originalDoc, at, end ? { a: end, f: end } : null, !!m.fromButton, m.insertAfter);
      if (captured && fileInput.current) {
        const info = originalDoc!.blockInfo(captured.anchor);
        pendingUpload.current = { captured, client: sync.client, type: info.type, parent: info.parent, cursor: sel.current ? { ...sel.current.f } : null };
        fileInput.current.accept = it.id === "image" ? "image/*" : "";
        fileInput.current.click();
      }
      return;
    }
    if (it.id === "math" || it.id === "diagram" || it.id === "video" || it.id === "bookmark") {
      const originalDoc = sync.client.doc;
      const at = checked ? { b: m.at.b, o: checked.start } : m.at;
      const end = checked ? { b: m.at.b, o: checked.end } : null;
      const captured = originalDoc && captureSlashInsertion(originalDoc, at, end ? { a: end, f: end } : null, !!m.fromButton, m.insertAfter);
      if (!originalDoc || !captured) return;
      const input = it.id === "math"
        ? await askText("公式（LaTeX）", "例如 \\frac{a}{b} 或 x^2 + y^2 = z^2")
        : it.id === "diagram"
          ? await askArea("流程图（Mermaid）", "graph TD\n  A[开始] --> B{条件}\n  B -->|是| C[处理]\n  B -->|否| D[结束]")
          : await askText(it.id === "video" ? "插入视频" : "插入网页卡片", "https://…");
      if (!input?.trim()) return;
      if (!mounted.current) return;
      if (currentClient.current !== sync.client || readOnlyRef.current || sync.client.doc !== originalDoc) { setConflictDraft({ text: input, message: "文档内容或编辑权限已变化，本次操作没有应用。请复制草稿后重试。" }); return; }
      const value = input.trim();
      const props: Record<string, string> = {};
      if (it.id === "video" || it.id === "bookmark") {
        props.url = value;
        if (it.id === "bookmark") {
          try { props.name = new URL(value).hostname; } catch { props.name = value; }
        }
      }
      if (!sel.current && originalDoc.hasBlock(captured.anchor)) {
        const p = { b: captured.anchor, o: 0 };
        sel.current = { a: p, f: p };
      }
      let inserted = false;
      let middle = false;
      run((tx) => {
        const p = insertSlashBlock(tx, captured, it.id, props, it.id === "math" || it.id === "diagram" ? value : "");
        middle = p === "middle";
        inserted = p !== null && p !== "middle";
        return p && p !== "middle" ? p : undefined;
      }, undefined, true);
      if (!inserted) setConflictDraft({ text: value, message: middle ? "命令前后都有文字，暂不能安全拆分段落。请将命令移至段首或段尾后重试，草稿已保留。" : "文档内容已变化，本次操作没有应用。请复制草稿后重试。" });
      um.seal();
      return;
    }
    let applied = false;
    run((tx) => {
      // Validate before creating a block, so a stale query cannot leave partial
      // mutations behind.
      if (!m.fromButton && (!m.query || !resolveSlashQuery(tx.doc, m.query))) return;
      const b = targetBlock(tx);
      if (!b) return;
      const offset = m.query ? consumeSlashQuery(tx, m.query) : 0;
      if (offset === null) return;
      applied = true;
      if (it.id === "divider") {
        const info = tx.doc.blockInfo(b);
        if (len(tx.doc, b) === 0) {
          tx.setProp(b, "type", "divider");
          const nb = tx.create("paragraph", b, info.parent);
          return { b: nb, o: 0 };
        }
        const dv = tx.create("divider", b, info.parent);
        const nb = tx.create("paragraph", dv, info.parent);
        return { b: nb, o: 0 };
      }
      if (it.id === "flowchart") {
        const info = tx.doc.blockInfo(b);
        const props = { "fc.v": "1", "fc.theme": "feishu" };
        let fb = b;
        if (len(tx.doc, b) === 0 && !TEXTLESS.has(info.type)) { tx.setProp(b, "type", "flowchart"); for (const [k, v] of Object.entries(props)) tx.setProp(b, k, v); }
        else fb = tx.create("flowchart", b, info.parent, props);
        const nb = tx.create("paragraph", fb, info.parent);
        setFlowAutoOpen(idKey(fb));
        return { b: nb, o: 0 };
      }
      if (it.id === "callout") {
        tx.setProp(b, "type", "callout");
        if (!tx.doc.blockInfo(b).props.emoji) tx.setProp(b, "emoji", "💡");
        return { b, o: offset };
      }
      if (it.id === "table") {
        const info = tx.doc.blockInfo(b);
        if (len(tx.doc, b) === 0 && !TEXTLESS.has(info.type)) {
          tx.setProp(b, "type", "table");
          tx.setProp(b, "tableData", JSON.stringify(chosenTable));
          tx.setProp(b, "tableHeader", "none");
          const nb = tx.create("paragraph", b, info.parent);
          return { b: nb, o: 0 };
        }
        const tb = tx.create("table", b, info.parent, { tableData: JSON.stringify(chosenTable), tableHeader: "none" });
        const nb = tx.create("paragraph", tb, info.parent);
        return { b: nb, o: 0 };
      }
      if (it.id === "columns") {
        const info = tx.doc.blockInfo(b);
        const cb = tx.create("columns", b, info.parent);
        const c1 = createColumn(tx, cb, null);
        createColumn(tx, cb, c1);
        const nb = tx.create("paragraph", cb, info.parent);
        return { b: nb, o: 0 };
      }
      tx.setProp(b, "type", TYPE_FOR[it.id] ?? it.id);
      return { b, o: offset };
    }, undefined, it.id === "columns");
    if (!applied) setColumnNotice("命令内容或编辑位置已变化，原文已保留，请重试。");
    um.seal();
  };

  const openTablePicker = () => changeSlash((current) => current?.fromButton ? { ...current, tableSize: current.tableSize ?? { rows: 1, columns: 1 } } : current);
  const pickSlashItem = (item: MenuItem) => {
    if (item.id === "table" && slashRef.current?.fromButton) openTablePicker();
    else void applySlash(item);
  };
  const pickTableSize = (size: TableSize) => {
    const current = slashRef.current, item = slashItems.find((candidate) => candidate.id === "table");
    if (!current?.fromButton || !current.tableSize || !item || !validTablePickerSize(size)) return;
    root.current?.focus({ preventScroll: true });
    void applySlash(item, size);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isNativeControl(e.target)) {
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && (key === "z" || key === "y") && !e.nativeEvent.isComposing && !readOnlyRef.current && e.target instanceof Element && e.target.closest("[data-column-move-handle]")) { e.preventDefault(); undo(key === "y" || e.shiftKey); return; }
      if ((e.metaKey || e.ctrlKey) && (key === "z" || key === "y") && !e.nativeEvent.isComposing && !readOnlyRef.current && e.target instanceof Element && e.target.closest("[data-table-row-grip], [data-table-col-grip]")) { e.preventDefault(); undo(key === "y" || e.shiftKey); return; }
      if ((e.metaKey || e.ctrlKey) && (key === "z" || key === "y") && !e.nativeEvent.isComposing && tableCellUndoRef.current(e.target, key === "y" || e.shiftKey)) e.preventDefault();
      return;
    }
    if (readOnlyRef.current) return;
    if (e.nativeEvent.isComposing || composing.current) return;
    readSel();
    const mod = e.metaKey || e.ctrlKey;
    if (slash?.tableSize) {
      if (e.key === "Escape") { e.preventDefault(); changeSlash((current) => current ? { ...current, tableSize: undefined } : null); return; }
      if (e.key === "Tab") { e.preventDefault(); document.querySelector<HTMLElement>("[data-table-size-picker]")?.focus(); return; }
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const rows = Math.max(1, Math.min(TABLE_PICKER_LIMIT, slash.tableSize.rows + (e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0)));
        const columns = Math.max(1, Math.min(TABLE_PICKER_LIMIT, slash.tableSize.columns + (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0)));
        changeSlash((current) => current?.tableSize ? { ...current, tableSize: { rows, columns } } : current); return;
      }
      if (e.key === "Enter") { e.preventDefault(); pickTableSize(slash.tableSize); return; }
    }
    if (slash && e.key === "Escape") { e.preventDefault(); changeSlash(null); return; }
    if (slash?.fromButton && (e.key === "Backspace" || e.key === "Delete")) {
      e.preventDefault();
      if (e.key === "Backspace") changeSlash((m) => m?.fromButton ? { ...m, buttonQuery: [...(m.buttonQuery ?? "")].slice(0, -1).join(""), tableSize: undefined, index: 0 } : m);
      return;
    }
    if (slash?.fromButton && e.key === "Tab") {
      e.preventDefault();
      if (slashItems.length) pickSlashItem(slashItems[Math.min(slash.index, slashItems.length - 1)]);
      return;
    }
    if (slash && !slashItems.length && e.key === "Enter") { e.preventDefault(); return; }
    if (slash && slashItems.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (e.key === "ArrowRight" && slash.fromButton && slashItems[Math.min(slash.index, slashItems.length - 1)]?.id === "table") { e.preventDefault(); openTablePicker(); return; }
        const grid = slashGridSize(slashItems, slash.fromButton ? slash.buttonQuery : undefined);
        const next = nextSlashIndex(slash.index, e.key, slashItems.length, grid);
        if (next !== null) {
          e.preventDefault();
          changeSlash((current) => current ? { ...current, index: next } : null);
          return;
        }
      }
      if (e.key === "Enter") {
        e.preventDefault();
        pickSlashItem(slashItems[Math.min(slash.index, slashItems.length - 1)]);
        return;
      }
    }
    const k = e.key.toLowerCase();
    // Undo belongs to the editor even when a remote deletion or a non-editable
    // formula temporarily leaves no valid DOM selection.
    if (mod && k === "z") {
      e.preventDefault();
      return undo(e.shiftKey);
    }
    if (mod && k === "y") {
      e.preventDefault();
      return undo(true);
    }
    const s = sel.current,
      d = sync.client.doc;
    if (!s || !d || !validEditorSelection(d, s)) return;
    if (!eqId(s.a.b, s.f.b) && (isColumnText(d, s.a.b) || isColumnText(d, s.f.b))) {
      if (!e.metaKey && !e.ctrlKey || e.key === "Backspace" || e.key === "Delete") e.preventDefault();
      if (e.key === "Backspace" || e.key === "Delete" || e.key.length === 1) setColumnNotice("暂不支持跨栏编辑，请在同一栏内选择内容。");
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && k === "k") {
      e.preventDefault();
      if (!eqId(s.a.b, s.f.b) || isSourceBlock(d, s.a.b)) { setColumnNotice("请选择同一段中的文字后插入链接。"); return; }
      const captured = captureInlineLinkSelection(d, s);
      if (!captured) { setColumnNotice("无法在当前位置插入链接，请重新选择文字。"); return; }
      const at = { b: s.a.b, o: Math.min(s.a.o, s.f.o) }, rect = root.current ? caretRect(root.current, at) : null;
      changeSlash(null); setToolbar(null); um.seal();
      setSlashLink({ captured, client: sync.client, initialText: captured.text, x: rect?.left ?? window.innerWidth / 2, y: rect?.bottom ?? 80 });
      return;
    }
    const markKeys: Record<string, string> = {
      b: "bold",
      i: "italic",
      u: "underline",
      e: "code",
    };
    if (mod && !e.shiftKey && markKeys[k]) {
      e.preventDefault();
      if (collapsed(s)) {
        const cur = stored.current ?? {};
        const on = activeMarksAt(d, s.a)[markKeys[k]] !== undefined;
        stored.current = {
          ...cur,
          [markKeys[k]]: (cur[markKeys[k]] !== undefined ? cur[markKeys[k]] === null : on) ? null : "true",
        };
        return;
      }
      return run((tx, s2) => toggleMark(tx, s2, markKeys[k]));
    }
    if (mod && e.shiftKey && k === "x") {
      e.preventDefault();
      return run((tx, s2) => toggleMark(tx, s2, "strike"));
    }
    if (mod && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      if (isColumnText(d, s.f.b)) return;
      const bs = bodyBlocks(d);
      const i = bs.findIndex((b) => eqId(b, s.f.b));
      const up = e.key === "ArrowUp";
      if ((up && i <= 0) || (!up && i >= bs.length - 1)) return;
      return run((tx) => {
        tx.move(s.f.b, up ? (i >= 2 ? bs[i - 2] : null) : bs[i + 1], d.blockInfo(s.f.b).parent);
      });
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const info = d.blockInfo(s.f.b);
      if (info.type === "code") return insertText("  ");
      if (!LIST_TYPES.has(info.type)) return;
      const cur = Number(info.props.indent ?? "0");
      const next = Math.max(0, Math.min(5, cur + (e.shiftKey ? -1 : 1)));
      return run((tx, s2) => {
        for (const b of normalize(tx.doc, s2).blocks) if (LIST_TYPES.has(tx.doc.blockInfo(b).type)) tx.setProp(b, "indent", String(next));
      });
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      run((tx, s2) => splitBlock(tx, collapsed(s2) ? s2.a : deleteRange(tx, s2)));
      um.seal();
      return;
    }
    if (e.key === "Backspace" && collapsed(s) && s.a.o === 0) {
      e.preventDefault();
      return run((tx) => joinBackward(tx, s.a.b));
    }
  };

  const onCopy = (e: React.ClipboardEvent, cut = false) => {
    readSel();
    const s = sel.current,
      d = sync.client.doc;
    if (!s || !d || !validEditorSelection(d, s) || collapsed(s)) return;
    if (selectionContainsColumns(d, s)) {
      e.preventDefault();
      setColumnNotice("暂不支持复制或剪切包含分栏的选区，请分别选择栏内内容。");
      return;
    }
    if (!eqId(s.a.b, s.f.b) && (isColumnText(d, s.a.b) || isColumnText(d, s.f.b))) { if (cut) { e.preventDefault(); setColumnNotice("暂不支持跨栏剪切，请在同一栏内选择内容。"); } return; }
    e.preventDefault();
    const clip = copyRange(d, s).map((block) => ({ ...block, source: { origin: location.origin, docId: sync.client.docId } }));
    e.clipboardData.setData("text/plain", clipText(clip));
    e.clipboardData.setData(CLIP_MIME, JSON.stringify(clip));
    if (cut) run((tx, s2) => deleteRange(tx, s2));
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (isNativeControl(e.target)) return;
    if (readOnlyRef.current) return;
    e.preventDefault();
    readSel();
    const files = [...e.clipboardData.files];
    const plain = e.clipboardData.getData("text/plain");
    const raw = e.clipboardData.getData(CLIP_MIME) || blockPayloadFromHTML(e.clipboardData.getData("text/html")) || "";
    if (slashRef.current?.fromButton) {
      if (files.length) { setColumnNotice("请先选择图片或附件命令，再选择文件。"); return; }
      if (plain) changeSlash((m) => m?.fromButton ? { ...m, buttonQuery: ((m.buttonQuery ?? "") + plain).slice(0, 32), tableSize: undefined, index: 0 } : m);
      else setColumnNotice("插入菜单中只能粘贴文字，请先选择命令或关闭菜单。");
      return;
    }
    const currentDoc = sync.client.doc;
    const active = slashRef.current, selection = sel.current;
    const oldQuery = active?.query;
    const oldRange = currentDoc && oldQuery && resolveSlashQuery(currentDoc, oldQuery);
    const tracking = !!oldRange && !!selection && collapsed(selection) && eqId(selection.f.b, oldQuery!.block) && selection.f.o === oldRange.end;
    if (active && !tracking) changeSlash(null);
    const documentLink = documentLinkDocsUpdatedAt > 0 && Date.now() - documentLinkDocsUpdatedAt < 30_000 && !active && !files.length && currentDoc && selection && validEditorSelection(currentDoc, selection) && currentDoc.blockInfo(selection.f.b).type !== "code" && !isSourceBlock(currentDoc, selection.f.b)
      ? pastedDocumentLink(raw, plain, location.origin, location.pathname, documentLinkDocs)
      : null;
    if (currentDoc && sel.current && isColumnText(currentDoc, sel.current.f.b)) {
      if (files.length) { setColumnNotice("暂不支持在分栏中粘贴图片或附件，请先将文件插入正文。"); return; }
      const clip = documentLink ?? columnClipboardBlocks(raw, plain);
      if (!clip) { setColumnNotice("分栏暂不支持粘贴该内容，原内容已保留。"); return; }
      run((tx, s) => {
        const at = collapsed(s) ? s.a : deleteRange(tx, s);
        return pasteBlocks(tx, at, clip);
      }, "paste");
      um.seal();
      return;
    }
    if (files.length) {
      if (active) changeSlash(null);
      if (!upload || !sel.current) { setColumnNotice("当前无法上传附件，原内容已保留。"); return; }
      const d = sync.client.doc, selection = sel.current;
      if (!d || !collapsed(selection) || !d.hasBlock(selection.f.b)) { setColumnNotice("请先将光标移至段首或段尾再插入附件。"); return; }
      const length = len(d, selection.f.b), offset = selection.f.o;
      if (offset > 0 && offset < length) { setColumnNotice("暂不能安全拆分段落，请将光标移至段首或段尾再插入附件。"); return; }
      const info = d.blockInfo(selection.f.b);
      void insertFiles(files, { captured: { doc: d, anchor: selection.f.b, beforeAnchor: offset === 0, commandIds: null }, client: sync.client, type: info.type, parent: info.parent, cursor: { ...selection.f }, boundaryIds: d.visibleIds(selection.f.b) });
      return;
    }
    const clip = documentLink ?? clipboardBlocks(raw, plain);
    if (!clip) { setColumnNotice("剪贴板中没有可粘贴的内容，原内容已保留。"); return; }
    const assetPlan = planClipboardAssets(clip, location.origin);
    if (!assetPlan.ok) { setColumnNotice(assetPlan.message); return; }
    if (assetPlan.assets) {
      const assets = assetPlan.assets, copy = copyClipboardAssetsRef.current, client = sync.client, d = client.doc, selection = sel.current;
      if (!copy || !d || !selection || !validEditorSelection(d, selection) || readOnlyRef.current || !client.caughtUp || client.status !== "synced") { setColumnNotice("当前无法安全复制附件，请确认编辑权限和同步状态。"); return; }
      if (assetPasteController.current) { setColumnNotice("正在处理上一次附件粘贴，请稍候。"); return; }
      const captured: Sel = { a: { b: { ...selection.a.b }, o: selection.a.o }, f: { b: { ...selection.f.b }, o: selection.f.o } };
      let before: Uint8Array;
      try { before = d.encodeState(); } catch { setColumnNotice("无法确认文档状态，原内容已保留。"); return; }
      const key = JSON.stringify([assets.sourceDocId, assets.fileIds]);
      let requestId = assetPasteRetry.current?.key === key ? assetPasteRetry.current.requestId : "";
      if (!requestId) {
        try { const random = crypto.getRandomValues(new Uint8Array(16)); requestId = Array.from(random, (v) => v.toString(16).padStart(2, "0")).join(""); }
        catch { setColumnNotice("无法创建安全的粘贴请求，原内容已保留。"); return; }
        assetPasteRetry.current = { key, requestId };
      }
      const controller = new AbortController();
      assetPasteController.current = controller;
      const stillCurrent = () => {
        const selected = sel.current;
        if (!mounted.current || currentClient.current !== client || client.doc !== d || readOnlyRef.current || !copyClipboardAssetsRef.current || !client.caughtUp || client.status !== "synced" || !selected || !eqId(selected.a.b, captured.a.b) || selected.a.o !== captured.a.o || !eqId(selected.f.b, captured.f.b) || selected.f.o !== captured.f.o || !validEditorSelection(d, captured)) return false;
        try { const now = d.encodeState(); return before.length === now.length && !before.some((v, i) => v !== now[i]); } catch { return false; }
      };
      changeSlash(null);
      setColumnNotice("正在复制附件并准备粘贴…");
      void (async () => {
        try {
          const mapped = await copyClipboardAssetsWithRetry(copy, clip, assets, requestId, client.docId, controller.signal, stillCurrent);
          if (!stillCurrent()) { if (mounted.current && currentClient.current === client) setColumnNotice("文档或选区已变化，未粘贴；请重新选择位置后再试。"); return; }
          sel.current = captured;
          run((tx, s) => {
            let at = collapsed(s) ? s.a : deleteRange(tx, s);
            if (isSourceBlock(tx.doc, at.b)) at = { b: tx.create("paragraph", at.b, tx.doc.blockInfo(at.b).parent), o: 0 };
            return pasteBlocks(tx, at, mapped);
          });
          assetPasteRetry.current = null;
          setColumnNotice("");
          um.seal();
        } catch (error) {
          if (!mounted.current || currentClient.current !== client) return;
          if (!stillCurrent()) setColumnNotice("文档或选区已变化，未粘贴；请重新选择位置后再试。");
          else if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) setColumnNotice(error.message || "无权复制源附件，原内容已保留。");
          else setColumnNotice("无法确认附件复制结果，原内容已保留；在此页面再次粘贴可安全重试。");
        } finally { if (assetPasteController.current === controller) assetPasteController.current = null; }
      })();
      return;
    }
    run((tx, s) => {
      let at = collapsed(s) ? s.a : deleteRange(tx, s);
      if (isSourceBlock(tx.doc, at.b)) at = { b: tx.create("paragraph", at.b, tx.doc.blockInfo(at.b).parent), o: 0 };
      return pasteBlocks(tx, at, clip);
    });
    if (tracking && oldQuery && slashRef.current?.query === oldQuery && sel.current?.f) {
      const query = updateSlashQuery(oldQuery, sel.current.f, "append");
      changeSlash(query ? { ...active!, query, at: { b: query.block, o: resolveSlashQuery(currentDoc!, query)!.start }, index: 0 } : null);
    }
    um.seal();
  };

  // ---- rendering
  tableFindActionRef.current = (match, replacement) => {
    const d = sync.client.doc;
    if (!d || readOnlyRef.current || !sync.client.caughtUp || sync.client.status !== "synced" || sync.client.unacked !== 0 || !match.table) return "unavailable";
    const aliases = findBatchHistory.capture(d, [match.block]);
    const result = applyTableFindReplace(d, sync.client, um, tableHistory, match, replacement);
    if (result.status === "replaced") findBatchHistory.recordTableChange(`table:${idKey(match.block)}:${match.table.row}:${match.table.col}`, aliases, false);
    if (result.ops.length) { sync.client.push(result.ops); force((x) => x + 1); publish(); }
    return result.status;
  };
  findBatchActionRef.current = (matches, replacement) => {
    const d = sync.client.doc;
    if (!d || readOnlyRef.current || !sync.client.caughtUp || sync.client.status !== "synced" || sync.client.unacked !== 0) return { status: "unavailable", count: 0 };
    const result = applyFindBatch(d, um, findBatchHistory, matches, replacement);
    if (result.ops.length) { sync.client.push(result.ops); force((x) => x + 1); publish(); }
    return { status: result.status, count: result.count };
  };
  const numbers = new Map<string, number>();
  {
    const counters: number[] = [];
    for (const b of blocks) {
      const info = doc!.blockInfo(b);
      const ind = Number(info.props.indent ?? "0");
      if (info.type === "ordered") {
        counters.length = ind + 1;
        counters[ind] = (counters[ind] ?? 0) + 1;
        numbers.set(idKey(b), counters[ind]);
      } else counters.length = 0;
    }
  }

  const toggleTodo = (b: OpId) => {
    const d = sync.client.doc;
    if (!d || readOnlyRef.current) return;
    const tx = new Tx(d);
    tx.setProp(b, "checked", d.blockInfo(b).props.checked === "true" ? "" : "true");
    um.record(tx, sel.current, sel.current);
    sync.client.push(tx.ops);
    force((x) => x + 1);
  };

  // Cell coordinates are only safe while both the table's type and data
  // register are unchanged. A remote edit, including a same-value write or a
  // row deletion and re-addition, invalidates the local undo rather than
  // overwriting another collaborator's work.
  tableHistoryActionRef.current = (key, redo) => {
    const d = sync.client.doc;
    if (!d || readOnlyRef.current) return;
    const location = /^table:(\d+):(\d+):/.exec(key);
    const block = location ? { client: Number(location[1]), clock: Number(location[2]) } : null;
    const aliases = block ? findBatchHistory.capture(d, [block]) : [];
    if (block && tableStructureHistory.beforeEditStep(d, block, key, redo) === "conflict") {
      if (um.peekMarker(redo) === key) setTableHistoryConflict({ client: sync.client, key, redo, revision: um.revision });
      return;
    }
    const result = applyTableHistory(d, sync.client, um, tableHistory, key, redo);
    if (result.status !== "ready") {
      if (um.peekMarker(redo) === key) setTableHistoryConflict({ client: sync.client, key, redo, revision: um.revision });
      return;
    }
    setTableHistoryConflict(null);
    if (block) {
      tableStructureHistory.afterEditStep(d, block, key, redo, result.ops);
      tableWidthHistory.rebaseData(d, block, result.rebase.logical, result.rebase.actual, result.ops);
    }
    findBatchHistory.finishTableChange(d, key, redo, aliases);
    sync.client.push(result.ops);
    force((x) => x + 1);
    publish();
  };
  columnAlignmentHistoryActionRef.current = (key, redo) => {
    if (!sync.client.doc || readOnlyRef.current) return;
    void startAlignmentUndo(key, redo);
  };
  tableStructureHistoryActionRef.current = (key, redo) => {
    const d = sync.client.doc;
    if (!d || readOnlyRef.current) return;
    const focused = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
    const position = focused?.dataset.tableCell?.match(/^(\d+):(\d+)$/);
    const focusedBlock = focused?.closest<HTMLElement>("[data-block]")?.dataset.block;
    const remembered = redo ? tableStructureFocus.get(key) : undefined;
    const result = tableStructureHistory.step(d, um, key, redo);
    if (result.status !== "ready") {
      if (um.peekMarker(redo) === key) setTableHistoryConflict({ client: sync.client, key, redo, revision: um.revision });
      return;
    }
    const location = /^table-structure:(\d+):(\d+):/.exec(key);
    if (location && result.rebase) {
      tableHistory.rebaseStructure(sync.client, `table:${location[1]}:${location[2]}:`, result.rebase.logical.data, result.rebase.actual.data, result.rebase.logical.guard, result.rebase.actual.guard);
      tableWidthHistory.rebaseStructure(d, { client: Number(location[1]), clock: Number(location[2]) }, result.rebase.logicalSnapshot, result.rebase.actualSnapshot);
    }
    setTableHistoryConflict(null); sync.client.push(result.ops); force((x) => x + 1); publish();
    if (!redo) tableStructureFocus.delete(key);
    if (redo && remembered && focused !== remembered.fallback) tableStructureFocus.delete(key);
    if (redo && remembered && focused === remembered.fallback) {
      tableStructureFocus.delete(key);
      requestAnimationFrame(() => {
        if (!document.hasFocus() || sync.client.doc !== d || document.activeElement !== focused && document.activeElement !== document.body) return;
        root.current?.querySelector<HTMLTextAreaElement>(`[data-block="${remembered.block}"] [data-table-cell="${remembered.row}:${remembered.col}"]`)?.focus({ preventScroll: true });
      });
    } else if (location && position && focusedBlock === `${location[1]}:${location[2]}`) requestAnimationFrame(() => {
      if (!document.hasFocus() || document.activeElement !== document.body || sync.client.doc !== d) return;
      const block = root.current?.querySelector<HTMLElement>(`[data-block="${focusedBlock}"]`);
      const row = Number(position[1]), col = Number(position[2]);
      const cells = [...(block?.querySelectorAll<HTMLTextAreaElement>("[data-table-cell]") ?? [])];
      cells.sort((a, b) => {
        const distance = (element: HTMLTextAreaElement) => { const [r, c] = (element.dataset.tableCell ?? "").split(":").map(Number); return Math.abs(r - row) * 1000 + Math.abs(c - col); };
        return distance(a) - distance(b);
      });
      if (cells[0]) {
        cells[0].focus({ preventScroll: true });
        if (!redo && document.activeElement === cells[0]) {
          if (tableStructureFocus.size >= 500) tableStructureFocus.delete(tableStructureFocus.keys().next().value!);
          tableStructureFocus.set(key, { block: focusedBlock, row, col, fallback: cells[0] });
        }
      }
    });
  };
  findBatchHistoryActionRef.current = (key, redo) => {
    const d = sync.client.doc;
    if (!d || readOnlyRef.current) return;
    if (!canStepFindBatch(sync.client)) { setBatchSyncNotice(redo ? "redo" : "undo"); return; }
    setBatchSyncNotice(null);
    const result = findBatchHistory.step(d, um, key, redo);
    if (result.status !== "ready") {
      if (um.peekMarker(redo) === key) setTableHistoryConflict({ client: sync.client, key, redo, revision: um.revision, reason: result.status === "size" ? "size" : undefined });
      return;
    }
    setTableHistoryConflict(null);
    for (const rebase of result.rebases) tableHistory.rebase(sync.client, `table:${idKey(rebase.block)}:`, rebase.logical, rebase.actual, rebase.guard);
    sync.client.push(result.ops); force((x) => x + 1); publish();
  };
  tableCellUndoRef.current = (target, redo) => {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) || !target.hasAttribute("data-table-cell")) return false;
    const cell = /^(\d+):(\d+)$/.exec(target.dataset.tableCell ?? "");
    const block = target.closest<HTMLElement>("[data-block]");
    if (!cell || !block?.dataset.block) return true;
    const key = `table:${block.dataset.block}:${cell[1]}:${cell[2]}`;
    const tableKey = `table:${block.dataset.block}:-1:-1`;
    if (um.peekMarker(redo)?.startsWith("find-batch:")) findBatchHistoryActionRef.current(um.peekMarker(redo)!, redo);
    else if (um.peekMarker(redo)?.startsWith(`table-structure:${block.dataset.block}:`)) tableStructureHistoryActionRef.current(um.peekMarker(redo)!, redo);
    else if (um.peekMarker(redo)?.startsWith(`table-width:${block.dataset.block}:`)) columnAlignmentHistoryActionRef.current(um.peekMarker(redo)!, redo);
    else if (um.peekMarker(redo) === key) tableHistoryActionRef.current(key, redo);
    else if (um.peekMarker(redo) === tableKey) tableHistoryActionRef.current(tableKey, redo);
    else if (redo ? um.canRedo : um.canUndo) setColumnNotice("最近的操作不在当前单元格，请先从文档中撤销或重做该操作。");
    return true;
  };

  const onDrop = (e: React.DragEvent) => {
    if (!drag || readOnlyRef.current) return;
    e.preventDefault();
    const d = sync.client.doc!;
    const { b, over, after, group } = drag;
    setDrag(null);
    if (!over) return;
    const bs = bodyBlocks(d);
    const plan = dropPlan(bs, group.filter((x) => d.hasBlock(x)), over, after);
    if (!plan) return;
    const s0 = sel.current;
    sel.current = s0 && validEditorSelection(d, s0) ? s0 : { a: { b, o: 0 }, f: { b, o: 0 } };
    const parent = d.blockInfo(b).parent;
    run((tx) => {
      let prev = plan.target;
      for (const x of plan.moving) { tx.move(x, prev, parent); prev = x; }
    });
    um.seal();
  };

  const tb = sel.current && doc && validEditorSelection(doc, sel.current) && !collapsed(sel.current) ? activeMarks(doc, sel.current) : {};
  const curType = sel.current && doc?.hasBlock(sel.current.f.b) ? doc.blockInfo(sel.current.f.b).type : "paragraph";
  const curAlign = sel.current && doc?.hasBlock(sel.current.f.b) ? doc.blockInfo(sel.current.f.b).props.align : undefined;
  const slashRange = slash?.query && doc ? resolveSlashQuery(doc, slash.query) : null;
  const slashAt = slashRange && slash ? { b: slash.at.b, o: slashRange.start } : slash?.at;
  const slashPos = slash && (slash.fromButton || slashRange) && slashAt && root.current && wrap.current ? caretRect(root.current, slash.insertAfter ? { b: slash.at.b, o: 0 } : slashAt) : null;
  const base = wrap.current?.getBoundingClientRect();
  useEffect(() => {
    if (readOnly) { changeSlash(null); setToolbar(null); setDrag(null); pendingUpload.current = null; }
  }, [readOnly]);

  return (
    <div ref={wrap} className="relative" onDragOver={(e) => drag && e.preventDefault()} onDrop={onDrop} onMouseOver={(e) => {
      const r = root.current, w = wrap.current;
      if (editingLinkCard.current && !(e.target as HTMLElement).closest?.("[data-link-card]")) return;
      const person = (e.target as HTMLElement).closest?.<HTMLElement>("[data-member]");
      if (person && r && w && r.contains(person)) {
        keepLinkCard();
        const id = Number(person.dataset.member);
        if (memberCard?.id === id) return;
        const pr = person.getBoundingClientRect(), wr = w.getBoundingClientRect();
        setLinkCard(null);
        setMemberCard({ id, name: (person.textContent ?? "").replace(/^@/, ""), x: pr.left - wr.left, y: pr.bottom - wr.top + 6 });
        return;
      }
      if (memberCard && !(e.target as HTMLElement).closest?.("[data-member-card]")) hideLinkCard();
      const a = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[data-link], a[data-mention]");
      if (!a || !r || !w || !r.contains(a)) { if (linkCard && !(e.target as HTMLElement).closest?.("[data-link-card]")) hideLinkCard(); return; }
      keepLinkCard();
      const href = a.getAttribute("href") ?? "";
      const from = domToPos(r, a, 0), to = domToPos(r, a, a.childNodes.length), current = sync.client.doc;
      if (!from || !to || !current) return;
      const range = captureLinkRange(current, from, to, href, a.hasAttribute("data-link"));
      if (!range) return;
      if (linkCard && sameLinkRange(linkCard.range, range)) return;
      if (editingLinkCard.current) return;
      const ar = a.getBoundingClientRect(), wr = w.getBoundingClientRect();
      setLinkCard({ href, x: ar.left - wr.left, y: ar.bottom - wr.top + 6, range, docTitle: a.hasAttribute("data-mention") ? (a.textContent ?? "").replace(/^@/, "") : undefined });
    }} onMouseLeave={hideLinkCard}>
      {memberCard && <MemberCard
        key={`${memberCard.id}@${memberCard.x},${memberCard.y}`}
        member={people.find((m) => m.id === memberCard.id)}
        fallbackName={memberCard.name}
        isMe={people.find((m) => m.id === memberCard.id)?.name === me.name}
        x={memberCard.x}
        y={memberCard.y}
        onEnter={keepLinkCard}
        onLeave={hideLinkCard}
        onCopyEmail={onCopyBlock ? undefined : (email) => { void navigator.clipboard?.writeText(email).then(() => setToast("已复制邮箱"), () => setToast(`请手动复制：${email}`)); }}
      />}
      {linkCard && <LinkCard
        key={`${linkCard.href}@${linkCard.x},${linkCard.y}`}
        href={linkCard.href}
        docTitle={linkCard.docTitle}
        x={linkCard.x}
        y={linkCard.y}
        onEnter={keepLinkCard}
        onLeave={hideLinkCard}
        onEditingChange={(editing) => { editingLinkCard.current = editing; if (editing) keepLinkCard(); }}
        onOpen={() => { if (!resolveLinkRange(sync.client.doc!, linkCard.range)) { setLinkCard(null); setToast("链接已变化，请重新选择。"); return; } if (linkCard.docTitle !== undefined) { setLinkCard(null); navigateDocumentHash(linkCard.href); } else window.open(linkCard.href, "_blank", "noopener,noreferrer"); }}
        onCopy={() => { if (!resolveLinkRange(sync.client.doc!, linkCard.range)) { setLinkCard(null); setToast("链接已变化，请重新选择。"); return; } const url = linkCard.docTitle !== undefined ? new URL(linkCard.href, location.href).href : linkCard.href; void navigator.clipboard?.writeText(url).then(() => setToast("已复制链接"), () => setToast(`请手动复制：${linkCard.href}`)); }}
        onEdit={readOnly ? undefined : (url) => {
          const range = linkCard.range, current = sync.client.doc, resolved = current && resolveLinkRange(current, range);
          editingLinkCard.current = false; setLinkCard(null);
          if (!resolved || !safeURL(url)) { setConflictDraft({ text: url, message: "链接或编辑位置已变化，本次操作没有应用。请复制草稿后重试。" }); return; }
          sel.current = { a: resolved.from, f: resolved.to };
          let applied = false;
          run((tx) => { const valid = resolveLinkRange(tx.doc, range); if (!valid) return; tx.format(valid.from.b, valid.from.o, valid.to.o, "link", url); applied = true; return valid.to; });
          if (!applied) setConflictDraft({ text: url, message: "链接或编辑位置已变化，本次操作没有应用。请复制草稿后重试。" });
          else um.seal();
        }}
        onUnlink={readOnly ? undefined : () => {
          const range = linkCard.range, current = sync.client.doc, resolved = current && resolveLinkRange(current, range);
          editingLinkCard.current = false; setLinkCard(null);
          if (!resolved) { setToast("链接已变化，请重新选择。"); return; }
          sel.current = { a: resolved.from, f: resolved.to };
          let applied = false;
          run((tx) => { const valid = resolveLinkRange(tx.doc, range); if (!valid) return; tx.format(valid.from.b, valid.from.o, valid.to.o, "link", null); applied = true; return valid.to; });
          if (!applied) setToast("链接已变化，请重新选择。"); else um.seal();
        }}
      />}
      {slashLink && <SlashLinkPopover x={slashLink.x} y={slashLink.y} initialText={slashLink.initialText} onCancel={() => { const position = resolveInlineLink(slashLink.captured.doc, slashLink.captured); setSlashLink(null); if (position) focusEditorPosition(slashLink.captured.doc, position); }} onConfirm={(text, url) => {
        const captured = slashLink.captured, position = resolveInlineLink(captured.doc, captured);
        if (currentClient.current !== slashLink.client || sync.client !== slashLink.client || readOnlyRef.current || sync.client.doc !== captured.doc || !position) {
          setSlashLink(null); setConflictDraft({ text: `${text}\n${url}`, message: "文档内容或编辑权限已变化，本次操作没有应用。请复制草稿后重试。" }); return;
        }
        sel.current = { a: position, f: position };
        const result: { position: Pos | null } = { position: null };
        run((tx) => { result.position = insertInlineLink(tx, captured, text, url); return result.position ?? undefined; });
        setSlashLink(null);
        if (!result.position) setConflictDraft({ text: `${text}\n${url}`, message: "文档内容已变化，本次操作没有应用。请复制草稿后重试。" });
        else { um.seal(); focusEditorPosition(captured.doc, result.position, true); }
      }}/>}
      {toast && <div role="status" contentEditable={false} className="fixed bottom-8 left-1/2 z-50 -translate-x-1/2 rounded-md bg-[#1F2329]/90 px-3.5 py-2 text-[13px] text-white shadow-lg" data-editor-toast>{toast}</div>}
      {columnNotice && <div role="status" contentEditable={false} className="mb-3 flex items-center gap-3 rounded-md border bg-surface p-2 text-[13px] text-muted-foreground"><span>{columnNotice}</span><button type="button" className="ml-auto text-primary" onClick={() => setColumnNotice("")}>关闭</button></div>}
      {mentionNavigationNotice && <div role="status" contentEditable={false} className="mb-3 flex items-center gap-3 rounded-md border bg-surface p-2 text-[13px] text-muted-foreground"><span>{mentionNavigationNotice}</span><button type="button" className="ml-auto text-primary" onClick={() => setMentionNavigationNotice("")}>关闭</button></div>}
      {alignmentPending && <div role="status" contentEditable={false} className="mb-3 flex flex-wrap items-center gap-3 rounded-md border bg-surface p-2 text-[13px] text-muted-foreground" data-column-alignment-pending><span>{alignmentMessage || "正在核对布局操作。"}</span>{waitingResizeSync ? <button type="button" className="text-primary" onClick={() => alignmentRequest.current?.controller.abort()} data-table-resize-wait-cancel>取消</button> : <><button type="button" className="text-primary" onClick={() => void reconcileAlignment()}>核对状态</button><button type="button" className="text-primary" onClick={() => void retryAlignment()}>重试相同操作</button></>}</div>}
      {batchSyncNotice && <div role="status" contentEditable={false} className="mb-3 flex items-center gap-3 rounded-md border bg-surface p-2 text-[13px] text-muted-foreground"><span>请等待文档同步完成后再{batchSyncNotice === "redo" ? "重做" : "撤销"}批量替换。</span><button type="button" className="ml-auto text-primary" onClick={() => setBatchSyncNotice(null)}>关闭</button></div>}
      {tableHistoryConflict?.client === sync.client && <div role="status" contentEditable={false} className="mb-3 flex flex-wrap items-center gap-3 rounded-md border bg-surface p-2 text-[13px] text-muted-foreground">
        <span>{tableHistoryConflict.reason === "unsupported" ? "当前布局无法安全处理" : tableHistoryConflict.key.startsWith("column-move:") ? "分栏顺序已变化" : tableHistoryConflict.key.startsWith("column-width:") ? "分栏或栏宽已变化" : tableHistoryConflict.key.startsWith("table-width:") ? "表格结构或列宽已变化" : tableHistoryConflict.key.startsWith("column-align:") ? "分栏对齐或位置已变化" : tableHistoryConflict.reason === "size" ? "操作内容过大" : "表格或正文已变化"}，未执行{tableHistoryConflict.redo ? "重做" : "撤销"}。可以跳过此条本地记录，继续处理其他操作。</span>
        <button type="button" className="text-primary" onClick={() => {
          if (tableHistoryConflict.client === sync.client && um.discardMarker(tableHistoryConflict.redo, tableHistoryConflict.key, tableHistoryConflict.revision)) {
            if (tableHistoryConflict.key.startsWith("column-align:")) { if (sync.client.doc) columnAlignmentHistory.discard(sync.client.doc, tableHistoryConflict.key, tableHistoryConflict.redo); }
            else if (tableHistoryConflict.key.startsWith("column-width:")) { if (sync.client.doc) columnWidthHistory.discard(sync.client.doc, tableHistoryConflict.key, tableHistoryConflict.redo); }
            else if (tableHistoryConflict.key.startsWith("table-width:")) { if (sync.client.doc) tableWidthHistory.discard(sync.client.doc, tableHistoryConflict.key, tableHistoryConflict.redo); }
            else if (tableHistoryConflict.key.startsWith("column-move:")) { if (sync.client.doc) columnMoveHistory.discard(sync.client.doc, tableHistoryConflict.key, tableHistoryConflict.redo); }
            else if (tableHistoryConflict.key.startsWith("find-batch:")) findBatchHistory.discard(tableHistoryConflict.key);
            else if (tableHistoryConflict.key.startsWith("table-structure:")) tableStructureHistory.discard(tableHistoryConflict.key);
            else { tableHistory.discard(sync.client, tableHistoryConflict.key, tableHistoryConflict.redo); findBatchHistory.discardTableChange(tableHistoryConflict.key, tableHistoryConflict.redo); }
          }
          else setColumnNotice("撤销记录已变化，未跳过任何记录，请重新操作。");
          setTableHistoryConflict(null);
        }}>跳过此条{tableHistoryConflict.redo ? "重做" : "撤销"}记录</button>
        <button type="button" className="ml-auto text-primary" onClick={() => setTableHistoryConflict(null)}>关闭</button>
      </div>}
      {conflictDraft !== null && <div role="alert" contentEditable={false} className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-[13px] text-foreground">
        <p>{conflictDraft.message}</p>
        <textarea aria-label="未应用的草稿" readOnly value={conflictDraft.text} className="mt-2 w-full resize-y rounded border bg-surface p-2" rows={3} />
        <button type="button" className="mt-2 rounded border px-2 py-1 hover:bg-hover" onClick={() => setConflictDraft(null)}>关闭</button>
      </div>}
      {conflictDraft === null && doc && !readOnly && blocks.length === 1 && doc.blockInfo(blocks[0]).type === "paragraph" && doc.richChars(blocks[0]).length === 0 && <span aria-hidden="true" data-editor-placeholder className="pointer-events-none absolute left-0 top-[2px] text-[16px] leading-7 text-subtle">输入“/”快速插入内容</span>}
      <div
        ref={root}
        contentEditable={!!doc && !readOnly}
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-multiline
        data-editor
        className={cn("outline-none", (columnNotice || mentionNavigationNotice || alignmentPending || batchSyncNotice || tableHistoryConflict || conflictDraft) && "pt-10")}
        onKeyDown={onKeyDown}
        onCopy={(e) => { const route = editorClipboardRoute(e.target, !!onCopyBlock); if (route === "block") e.preventDefault(); else if (route === "editor") onCopy(e); }}
        onCut={(e) => { const route = editorClipboardRoute(e.target, !!onCopyBlock); if (route === "block") e.preventDefault(); else if (route === "editor") onCopy(e, true); }}
        onPaste={onPaste}
        onFocus={(event) => {
          // A nested editable column receives focus before the browser places
          // the clicked caret. Restoring a stale/root selection at that point
          // would redirect the first keystroke into another block.
          if (event.target !== event.currentTarget) {
            sel.current = null;
            if (isNativeControl(event.target)) { changeSlash(null); setToolbar(null); um.seal(); }
            return;
          }
          if (!sel.current && doc && blocks.length)
            sel.current = {
              a: { b: blocks[0], o: 0 },
              f: { b: blocks[0], o: 0 },
            };
          if (sel.current) setTouchActiveBlock(idKey(sel.current.f.b));
        }}
        onBlur={(e) => {
          if (!wrap.current?.contains(e.relatedTarget as Node)) setToolbar(null);
        }}
      >
        {doc &&
          blocks.map((b) => {
            const k = idKey(b);
            const info = doc.blockInfo(b);
            const version = (key: string) => { const v = doc.propVersion(b, key); return v ? idKey(v) : null; };
            const tableSnapshot = info.type === "table" ? { data: version("tableData"), merges: version("tableMerges"), widths: version("tableWidths"), type: version("type"), rows: version("tbl.rows"), cols: version("tbl.cols") } : null;
            const tableClipboard = (operation: { kind: "paste"; row: number; col: number; text: string; literal?: boolean; rich?: RichTableClipboard } | { kind: "cut" | "clear"; range: CellRange } | { kind: "append" }): string | null => {
              if (readOnlyRef.current || sync.client.doc !== doc || !doc.hasBlock(b)) return "文档状态已变化，表格未修改。";
              const current = doc.blockInfo(b);
              if (current.type !== "table" || !tableSnapshot || version("tableData") !== tableSnapshot.data || version("tableMerges") !== tableSnapshot.merges || version("type") !== tableSnapshot.type || tableDataOf(current.props) !== tableDataOf(info.props)) return "表格已变化，请重新选择。";
              const beforeRows = tableRowsOf(current.props);
              const merges = parseMerges(current.props.tableMerges, beforeRows.length, beforeRows[0]?.length ?? 0);
              const richPlan = operation.kind === "paste" && operation.rich ? planRichTablePaste(beforeRows, merges, operation.row, operation.col, operation.rich) : null;
              const result = richPlan ?? (operation.kind === "paste" ? planTablePaste(beforeRows, merges, operation.row, operation.col, operation.text, operation.literal) : operation.kind === "cut" ? planTableCut(beforeRows, merges, operation.range) : operation.kind === "clear" ? planTableClear(beforeRows, merges, operation.range) : planTableAppendRow(beforeRows));
              if (!result.ok) return result.message;
              if (operation.kind === "append") return applyTableStructure(result.rows, merges, undefined, { kind: "insertRow", at: beforeRows.length });
              if (operation.kind === "paste" && operation.rich) {
                if (!isCellTable(current.props) && Object.entries(current.props).some(([key, value]) => key.startsWith("tbl.") && value !== "")) return "表格数据状态不完整，请等待同步后重试。";
                const migration = new Tx(doc);
                if (!isCellTable(current.props)) applyTableWrites(migration, b, current.props, cellTableWrites(current.props, beforeRows, doc.client));
                const before = tableStructureHistory.snapshot(doc, b), tx = new Tx(doc);
                writeTable(tx, b, doc.blockInfo(b).props, result.rows, doc.client);
                const covered = coverMap(merges), fills: { row: number; col: number; fill: string }[] = [], alignments: { row: number; col: number; axis: TableAlignAxis; align: TableAlign }[] = [];
                operation.rich.cells.forEach((row, dr) => row.forEach((cell, dc) => {
                  const r = operation.row + dr, c = operation.col + dc;
                  if (covered.get(`${r}:${c}`) === "hidden") return;
                  fills.push({ row: r, col: c, fill: cell.fill });
                  alignments.push({ row: r, col: c, axis: "horizontal", align: cell.horizontal }, { row: r, col: c, axis: "vertical", align: cell.vertical });
                }));
                setTableCellFills(tx, b, fills); setTableCellAlignments(tx, b, alignments);
                if (richPlan?.ok && richPlan.merges.length !== merges.length) tx.setProp(b, "tableMerges", JSON.stringify(richPlan.merges));
                if (tx.ops.length) { um.seal(); const marker = tableStructureHistory.record(doc, b, tx, um, before); if (marker) um.recordMarker(marker); sync.client.push([...migration.ops, ...tx.ops]); um.seal(); force(x => x + 1); publish(); }
                else if (migration.ops.length) { sync.client.push(migration.ops); force(x => x + 1); }
                return null;
              }
              if (!result.changed) return null;
              const aliases = findBatchHistory.capture(doc, [b]);
              const structureBefore = tableStructureHistory.capture(doc, b, um);
              const tx = new Tx(doc);
              writeTable(tx, b, current.props, result.rows, doc.client);
              if (!tx.ops.length) return null;
              const next = doc.propVersion(b, "tableData");
              const key = `table:${idKey(b)}:-1:-1`;
              tableHistory.record(sync.client, key, JSON.stringify(beforeRows), tableDataOf(doc.blockInfo(b).props), tableSnapshot.data, next ? idKey(next) : null, tableHistoryGuard(doc, b), operation.kind, Date.now(), false);
              findBatchHistory.recordTableChange(key, aliases, false);
              um.seal();
              um.recordMarker(key, false);
              tableStructureHistory.recordEdit(doc, b, key, structureBefore, false, um);
              sync.client.push(tx.ops);
              um.seal();
              force((x) => x + 1);
              publish();
              return null;
            };
            const tableFormat = (target: TableFormatTarget, format: { kind: "fill"; value: string } | { kind: "align"; axis: TableAlignAxis; value: TableAlign }): string | null => {
              if (readOnlyRef.current || sync.client.doc !== doc || !doc.hasBlock(b)) return "文档状态已变化，表格未修改。";
              const current = doc.blockInfo(b), rows = tableRowsOf(current.props), cols = rows[0]?.length ?? 0;
              if (current.type !== "table" || !tableSnapshot || version("tableData") !== tableSnapshot.data || version("tableMerges") !== tableSnapshot.merges || version("type") !== tableSnapshot.type || tableDataOf(current.props) !== tableDataOf(info.props)) return "表格已变化，请重新选择。";
              const merges = parseMergesStrict(current.props.tableMerges, rows.length, cols);
              if (!merges) return "表格合并数据无效，请等待同步后重试。";
              const cells = tableFormatCells(rows.length, cols, merges, target);
              if (!cells) return "选区无效。";
              if (format.kind === "fill" && format.value !== "" && !/^#[0-9a-f]{6}$/i.test(format.value)) return "颜色无效。";
              if (format.kind === "align" && ((format.axis !== "horizontal" && format.axis !== "vertical") || !(format.axis === "horizontal" ? ["left", "center", "right"] : ["top", "middle", "bottom"]).includes(format.value))) return "对齐方式无效。";
              if (!isCellTable(current.props) && Object.entries(current.props).some(([key, value]) => key.startsWith("tbl.") && value !== "")) return "表格数据状态不完整，请等待同步后重试。";
              const migration = new Tx(doc);
              if (!isCellTable(current.props)) applyTableWrites(migration, b, current.props, cellTableWrites(current.props, rows, doc.client));
              const before = tableStructureHistory.snapshot(doc, b), tx = new Tx(doc);
              if (format.kind === "fill") setTableCellFills(tx, b, cells.map(cell => ({ ...cell, fill: format.value })));
              else setTableCellAlignments(tx, b, cells.map(cell => ({ ...cell, axis: format.axis, align: format.value })));
              if (tx.ops.length) { um.seal(); const marker = tableStructureHistory.record(doc, b, tx, um, before); if (marker) um.recordMarker(marker); sync.client.push([...migration.ops, ...tx.ops]); um.seal(); force(x => x + 1); publish(); }
              else if (migration.ops.length) { sync.client.push(migration.ops); force(x => x + 1); }
              return null;
            };
            const applyTableStructure = (rows: string[][], merges: Merge[], widths?: Widths, operation?: TableOp): string | null => {
              if (readOnlyRef.current || sync.client.doc !== doc || !doc.hasBlock(b) || doc.blockInfo(b).type !== "table") return "文档状态已变化，表格未修改。";
              const current = doc.blockInfo(b).props, previous = tableRowsOf(current);
              let stableMove: Extract<TableOp, { kind: "reorderRows" | "reorderCols" }> | null = null;
              if (operation?.kind === "reorderRows" || operation?.kind === "reorderCols") stableMove = operation;
              else if (operation?.kind === "moveRow" || operation?.kind === "moveCol") stableMove = {
                kind: operation.kind === "moveRow" ? "reorderRows" : "reorderCols",
                indices: [operation.index], before: operation.to < operation.index ? operation.to : operation.to + 1,
              };
              const axisEdit = operation?.kind === "insertRow" || operation?.kind === "insertCol" || operation?.kind === "deleteRow" || operation?.kind === "deleteCol" ? operation : null;
              const stableStructure = !!stableMove || !!axisEdit;
              const fills = operation && !stableStructure ? remapTableFills(readTableFills(current, previous.length, previous[0]?.length ?? 0), operation) : null;
              const horizontal = operation && !stableStructure ? remapTableFills(readTableAlignments(current, previous.length, previous[0]?.length ?? 0, "horizontal"), operation) : null;
              const vertical = operation && !stableStructure ? remapTableFills(readTableAlignments(current, previous.length, previous[0]?.length ?? 0, "vertical"), operation) : null;
              if (!isCellTable(current) && Object.entries(current).some(([key, value]) => key.startsWith("tbl.") && value !== "")) { setColumnNotice("表格数据状态不完整，未修改表格，请等待同步后重试。"); return "表格数据状态不完整，请等待同步后重试。"; }
              const migrationWrites = isCellTable(current) ? null : cellTableWrites(current, previous, doc.client);
              const virtualProps = migrationWrites ? { ...current, ...migrationWrites } : current;
              let structuralWrites: Record<string, string> | null = null;
              let anchorFormats: Extract<ReturnType<typeof planAnchorFormats>, { ok: true }> | null = null;
              if (stableStructure && (!tableSnapshot || version("tableData") !== tableSnapshot.data || version("tableMerges") !== tableSnapshot.merges || version("tableWidths") !== tableSnapshot.widths || version("tbl.rows") !== tableSnapshot.rows || version("tbl.cols") !== tableSnapshot.cols || tableDataOf(current) !== tableDataOf(info.props))) { setColumnNotice("表格结构已变化，请重新操作。"); return "表格结构已变化，请重新操作。"; }
              if (stableMove) {
                const sourceMerges = parseMergesStrict(current.tableMerges, previous.length, previous[0]?.length ?? 0);
                const plan = sourceMerges && planTableReorder(previous, sourceMerges, stableMove);
                if (!plan || JSON.stringify(plan.rows) !== JSON.stringify(rows) || JSON.stringify(plan.merges) !== JSON.stringify(merges)) { setColumnNotice("表格结构已变化，未移动行列。"); return "表格结构已变化，未移动行列。"; }
                structuralWrites = stableTableReorderWrites(virtualProps, stableMove.kind === "reorderRows" ? "row" : "column", plan.order);
                if (!structuralWrites) { setColumnNotice("表格数据尚未同步完成，未移动行列，请稍后重试。"); return "表格数据尚未同步完成，未移动行列，请稍后重试。"; }
              } else if (axisEdit) {
                const sourceMerges = parseMergesStrict(current.tableMerges, previous.length, previous[0]?.length ?? 0);
                if (!sourceMerges || !validTableWidths(current.tableWidths ?? "")) { setColumnNotice("表格结构或列宽无效，未修改表格。"); return "表格结构或列宽无效，未修改表格。"; }
                const deletion = axisEdit.kind === "deleteRow" || axisEdit.kind === "deleteCol" ? planTableAxisDelete(previous, sourceMerges, axisEdit) : null;
                if (deletion && !deletion.ok) return deletion.message;
                const plan = deletion?.ok ? deletion : applyTableOp(previous, sourceMerges, axisEdit);
                if (JSON.stringify(plan.rows) !== JSON.stringify(rows) || JSON.stringify(plan.merges) !== JSON.stringify(merges)) { setColumnNotice("表格结构已变化，请重新操作。"); return "表格结构已变化，请重新操作。"; }
                if (deletion?.ok && deletion.transfers.length) {
                  const formats = planAnchorFormats(virtualProps, deletion.transfers);
                  if (!formats.ok) return formats.message;
                  anchorFormats = formats;
                }
                const axis = axisEdit.kind === "insertRow" || axisEdit.kind === "deleteRow" ? "row" : "column";
                if (axisEdit.kind === "insertRow" || axisEdit.kind === "insertCol") {
                  const count = axis === "row" ? previous.length : previous[0].length;
                  const nextRows = previous.length + (axis === "row" ? 1 : 0), nextCols = previous[0].length + (axis === "column" ? 1 : 0);
                  if (nextRows > 200 || nextCols > 50 || nextRows * nextCols > 5000) { setColumnNotice("表格已达到行列上限。"); return "表格已达到行列上限。"; }
                  if (!Number.isSafeInteger(axisEdit.at) || axisEdit.at < 0 || axisEdit.at > count || !stableTableReorderWrites(virtualProps, axis, Array.from({ length: count }, (_, index) => index))) { setColumnNotice("表格数据尚未同步完成，未插入行列。"); return "表格数据尚未同步完成，未插入行列。"; }
                  try {
                    for (let attempt = 0; attempt < 3 && !structuralWrites; attempt++) {
                      const reserved = doc.allocateOpIds(1)[0];
                      structuralWrites = stableTableInsertWrites(virtualProps, axis, axisEdit.at, `a${reserved.client.toString(36)}_${reserved.clock.toString(36)}`);
                    }
                  } catch { /* Exhausted IDs leave the table unchanged. */ }
                } else structuralWrites = stableTableDeleteWrites(virtualProps, axis, [axisEdit.index]);
                if (!structuralWrites) { setColumnNotice("无法安全修改行列，请检查表格大小或同步状态。"); return "无法安全修改行列，请检查表格大小或同步状态。"; }
              }
              const migration = new Tx(doc);
              if (migrationWrites) applyTableWrites(migration, b, current, migrationWrites);
              const before = tableStructureHistory.snapshot(doc, b), tx = new Tx(doc);
              if (structuralWrites) {
                applyTableWrites(tx, b, doc.blockInfo(b).props, structuralWrites);
                if (anchorFormats) {
                  writeTable(tx, b, doc.blockInfo(b).props, rows, doc.client);
                  setTableCellFills(tx, b, anchorFormats.fills);
                  setTableCellAlignments(tx, b, anchorFormats.alignments);
                }
              }
              else writeTable(tx, b, doc.blockInfo(b).props, rows, doc.client);
              if (fills) setTableCellFills(tx, b, fillCells(fills));
              if (horizontal && vertical) setTableCellAlignments(tx, b, [...alignmentCells(horizontal, "horizontal"), ...alignmentCells(vertical, "vertical")]);
              tx.setProp(b, "tableMerges", JSON.stringify(merges));
              if (widths) {
                const original = stableStructure ? parseTableWidths(current.tableWidths) : undefined;
                tx.setProp(b, "tableWidths", JSON.stringify(original ? [...widths.slice(0, rows[0]?.length ?? 0), ...original.slice(previous[0]?.length ?? 0)] : widths));
              }
              um.seal();
              const marker = tableStructureHistory.record(doc, b, tx, um, before);
              if (marker) um.recordMarker(marker);
              sync.client.push([...migration.ops, ...tx.ops]);
              um.seal(); force((x) => x + 1); publish();
              return null;
            };
            const commentProjection = projectCommentAnchors(doc, b, comments, activeThread);
            return (
              <Block
                key={k + ":" + (remount[k] ?? 0)}
                id={k}
                type={info.type}
                props={info.props}
                number={numbers.get(k)}
                spans={composing.current?.snapshot && eqId(composing.current.sel.a.b, b) ? composing.current.snapshot : doc.richChars(b)}
                findRanges={composing.current?.snapshot && eqId(composing.current.sel.a.b, b) ? composing.current.findRanges : findRanges.get(k)}
                tableFindCells={tableFindCells.get(k)}
                findNavigation={findNavigation}
                anchors={commentProjection.flags}
                commentThreads={commentProjection.threadIds}
                blockThreads={commentProjection.blockThreadIds}
                onBlockComment={onComment ? () => blockAction(k, { kind: "comment" }) : undefined}
                activeThread={activeThread}
                onAnchorClick={(cid) => onActivateThread?.(cid)}
                onSetProp={readOnly ? undefined : (key, value) => {
                  if (readOnlyRef.current) return;
                  const tx = new Tx(doc);
                  tx.setProp(b, key, value);
                  um.record(tx, sel.current, sel.current, "prop");
                  sync.client.push(tx.ops);
                  force((x) => x + 1);
                  publish();
                }}
                onInsertAfter={!readOnly ? () => onInsertAfter(b) : undefined}
                alwaysShowInsert={!readOnly && blocks.length === 1 && info.type === "paragraph" && doc.richChars(b).length === 0}
                touchActive={touchActiveBlock === k || (!touchActiveBlock && blocks.length === 1)}
                onPreviewImage={onPreviewImage}
                onMathSource={readOnly ? undefined : editMathSource}
                onDiagramSource={readOnly ? undefined : editDiagramSource}
                onDeleteBlock={readOnly ? undefined : deleteBlockByKey}
                onBlockAction={blockAction}
                selectionCount={!readOnly && selBlocks.length > 1 && selBlocks[0] === k ? selBlocks.length : undefined}
                inSelection={!readOnly && selBlocks.length > 1 && selBlocks.includes(k)}
                blockAbilities={withPageAbilities(readOnly ? readOnlyBlockAbilities(info.type, !onCopyBlock, !!onComment) : blockAbilities(info.type, selBlocks.length > 1 && selBlocks[0] === k, !onCopyBlock, !!onComment), info.type, { ai: !!ai && !onCopyBlock, share: !!onShareBlock, template: !!onSaveTemplate && !onCopyBlock })}
                childBlocks={doc.children(b).map((ch) => {
                  const ci = doc.blockInfo(ch);
                  const key = idKey(ch);
                  const composingHere = composing.current?.snapshot && eqId(composing.current.sel.a.b, ch);
                  const commentProjection = projectCommentAnchors(doc, ch, comments, activeThread);
                  return { id: key, type: ci.type, props: ci.props, spans: composingHere ? composing.current!.snapshot! : doc.richChars(ch), findRanges: composingHere ? composing.current!.findRanges : findRanges.get(key), anchors: commentProjection.flags, commentThreads: commentProjection.threadIds };
                })}
                columnRemount={remount}
                syncVersion={sync.version}
                syncStatus={sync.status}
                onMoveColumn={readOnly ? undefined : (column, after) => {
                  if (readOnlyRef.current || sync.client.doc !== doc) return;
                  if (alignmentPendingRef.current && pendingAlignmentPlan.current) { setColumnNotice("请先核对尚未完成的布局操作。"); return; }
                  const parse = (value: string) => { const match = /^(\d+):(\d+)$/.exec(value); return match ? { client: Number(match[1]), clock: Number(match[2]) } : null; };
                  const target = parse(column), previous = after ? parse(after) : null;
                  if (!target || after && !previous) { setColumnNotice("分栏位置无效，未移动内容。"); return; }
                  const snapshot = captureColumnMove(doc, b, target);
                  if (!snapshot) { setColumnNotice("分栏顺序已变化或位置无效，无法移动。"); return; }
                  const tx = new Tx(doc), result = applyColumnMove(tx, snapshot, previous);
                  if (result === "changed" || result === "invalid") { setColumnNotice("分栏顺序已变化，未移动内容，请重试。"); return; }
                  if (result === "applied") { columnMoveHistory.record(doc, um, snapshot); sync.client.push(tx.ops); force((x) => x + 1); publish(); }
                }}
                onAddColumn={readOnly ? undefined : (after) => {
                  if (readOnlyRef.current || sync.client.doc !== doc) return;
                  const tx = new Tx(doc);
                  const anchor = after ? { client: Number(after.split(":")[0]), clock: Number(after.split(":")[1]) } : null;
                  const result = insertColumnAfter(tx, b, anchor);
                  if (result !== "created") { setColumnNotice(result === "limit" ? "每组分栏最多支持 10 栏。" : "分栏已变化，请重新操作。"); return; }
                  um.record(safeColumnUndo(tx), sel.current, sel.current, "column");
                  sync.client.push(tx.ops);
                  force((x) => x + 1);
                  publish();
                }}
                onBeginColumnResize={readOnly ? undefined : (left, right) => {
                  if (readOnlyRef.current || sync.client.doc !== doc) return null;
                  if (alignmentPendingRef.current && pendingAlignmentPlan.current) { setColumnNotice("请先核对尚未完成的布局操作。"); return null; }
                  const snapshot = captureColumnWidths(doc, b, left, right);
                  const before = columnWidthHistory.capture(doc, b);
                  if (!snapshot || !before) { setColumnNotice("分栏或栏宽数据已变化，无法调整。"); return null; }
                  const index = snapshot.ids.indexOf(left);
                  return {
                    leftWeight: snapshot.weights[index], rightWeight: snapshot.weights[index + 1],
                    cancel: () => setColumnNotice("显示区域已变化，未调整栏宽，请重试。"),
                    commit: (fraction) => {
                      if (readOnlyRef.current || sync.client.doc !== doc) return;
                      if (alignmentPendingRef.current && pendingAlignmentPlan.current) { setColumnNotice("请先核对尚未完成的布局操作。"); return; }
                      const tx = new Tx(doc), result = applyColumnWidths(tx, snapshot, fraction);
                      if (result === "changed" || result === "invalid") { setColumnNotice("分栏或栏宽已变化，未应用调整，请重试。"); return; }
                      if (result === "applied") { columnWidthHistory.record(doc, um, b, before); sync.client.push(tx.ops); force((x) => x + 1); publish(); }
                    },
                  };
                }}
                onDeleteColumn={readOnly ? undefined : (col) => {
                  if (readOnlyRef.current) return;
                  const cid = { client: Number(col.split(":")[0]), clock: Number(col.split(":")[1]) };
                  // Block tombstones cannot be undone with the same ID. A
                  // collaborator may still send edits to it after undo.
                  if (requestColumnDeletion(doc, cid) === "unsupported") setColumnNotice("暂不支持安全删除分栏：协作者可能仍在编辑，栏内容已保留。");
                }}
                onBeginTableResize={readOnly ? undefined : (index, selectedIndices) => {
                  if (readOnlyRef.current || sync.client.doc !== doc) return null;
                  if (alignmentPendingRef.current || alignmentBusy.current) { setColumnNotice("请先核对尚未完成的布局操作。"); return null; }
                  const before = tableWidthHistory.capture(doc, b);
                  const structureBefore = tableStructureHistory.capture(doc, b, um);
                  const indices = selectedIndices ? [...selectedIndices] : [index];
                  if (!before || !tableSnapshot || version("tableData") !== tableSnapshot.data || version("tableMerges") !== tableSnapshot.merges || version("tableWidths") !== tableSnapshot.widths || tableDataOf(doc.blockInfo(b).props) !== tableDataOf(info.props) || !indices.length || new Set(indices).size !== indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= before.columns) || !indices.includes(index)) { setColumnNotice("表格结构或列宽已变化，无法调整，请重试。"); return null; }
                  return {
                    cancel: () => {},
                    commit: (widths) => {
                      if (readOnlyRef.current || sync.client.doc !== doc) return;
                      if (alignmentPendingRef.current || alignmentBusy.current) { setColumnNotice("请先核对尚未完成的布局操作。"); return; }
                      const current = tableWidthHistory.capture(doc, b);
                      if (!current || current.guard !== before.guard || current.version !== before.version || current.value !== before.value || widths.length !== before.columns || widths.some((width) => !Number.isFinite(width) || width < 100 || width > 100000)) {
                        setColumnNotice("表格内容或列宽已变化，未应用调整；请重试。"); return;
                      }
                      // Preserve other automatic widths and any extra stored
                      // widths which may have been removed by an old client.
                      const value = updatedSelectedTableWidths(before.value, before.columns, indices, indices.map(i => widths[i]));
                      if (value === null) { setColumnNotice("表格列宽无效，未应用调整。"); return; }
                      if (value === before.value) return;
                      const fallback = () => {
                        if (readOnlyRef.current || sync.client.doc !== doc) return false;
                        const latest = tableWidthHistory.capture(doc, b);
                        if (!latest || latest.guard !== before.guard || latest.version !== before.version || latest.value !== before.value) { setColumnNotice("表格内容或列宽已变化，未应用调整；请重试。"); return false; }
                        const tx = new Tx(doc); tx.setProp(b, "tableWidths", value);
                        if (tx.ops.length) { const key = tableWidthHistory.record(doc, um, b, before); tableStructureHistory.recordEdit(doc, b, key, structureBefore, false, um); sync.client.push(tx.ops); force((x) => x + 1); publish(); return true; }
                        return false;
                      };
                      if (conditionalAlignment && typeof navigator !== "undefined" && navigator.locks && sync.client.epoch !== null && sync.client.status !== "offline" && !sync.client.blocked) return startTableResize(doc, b, before, value, structureBefore, fallback);
                      fallback();
                    },
                  };
                }}
                onBeginTableReorder={readOnly ? undefined : () => {
                  if (readOnlyRef.current || sync.client.doc !== doc || !doc.hasBlock(b) || !tableSnapshot) return null;
                  if (alignmentPendingRef.current || alignmentBusy.current) { setColumnNotice("上一项布局操作仍在核对，请稍后再试。"); return null; }
                  const current = doc.blockInfo(b);
                  if (current.type !== "table" || version("tableData") !== tableSnapshot.data || version("tableMerges") !== tableSnapshot.merges || version("tableWidths") !== tableSnapshot.widths || version("tbl.rows") !== tableSnapshot.rows || version("tbl.cols") !== tableSnapshot.cols || tableDataOf(current.props) !== tableDataOf(info.props)) { setColumnNotice("表格已变化，请重新拖动。"); return null; }
                  const before = tableStructureHistory.snapshot(doc, b), location = doc.blockLocation(b);
                  const locationKey = `${idKey(location.parent)}:${idKey(location.version)}`;
                  return { cancel: () => {}, commit: (op) => {
                    if (alignmentPendingRef.current || alignmentBusy.current) return "上一项布局操作仍在核对，未移动行列；请稍后重试。";
                    if (readOnlyRef.current || sync.client.doc !== doc || !doc.hasBlock(b) || tableStructureHistory.snapshot(doc, b) !== before) return "表格内容或格式已变化，未移动行列；请重试。";
                    const now = doc.blockLocation(b);
                    if (`${idKey(now.parent)}:${idKey(now.version)}` !== locationKey) return "表格位置已变化，未移动行列；请重试。";
                    const props = doc.blockInfo(b).props, rows = tableRowsOf(props), merges = parseMergesStrict(props.tableMerges, rows.length, rows[0]?.length ?? 0);
                    if (!merges || !validTableWidths(props.tableWidths ?? "")) return "表格合并或列宽数据无效，未移动行列。";
                    if (!isCellTable(props) && Object.entries(props).some(([key, value]) => key.startsWith("tbl.") && value !== "")) return "表格数据状态不完整，未移动行列。";
                    const plan = planTableReorder(rows, merges, op);
                    if (!plan) return "无法拆开合并单元格，请调整选区或目标位置。";
                    if (plan.order.every((old,index) => old === index)) return null;
                    const originalWidths = parseTableWidths(props.tableWidths), mappedWidths = remapWidths(originalWidths, op, rows[0].length);
                    const widths = mappedWidths && originalWidths ? [...mappedWidths, ...originalWidths.slice(rows[0].length)] : mappedWidths;
                    return applyTableStructure(plan.rows, plan.merges, widths, op);
                  } };
                }}
                onTableEdit={readOnly ? undefined : (r, c, v, kind) => {
                  if (readOnlyRef.current || sync.client.doc !== doc || !doc.hasBlock(b)) return;
                  const tx = new Tx(doc);
                  const info = doc.blockInfo(b);
                  if (info.type !== "table") return;
                  const before = tableRowsOf(info.props);
                  const old = before[r]?.[c];
                  if (r >= 0 && typeof old !== "string") return;
                  if (r >= 0 && old === v) return;
                  const widthBefore = r >= 0 && !isCellTable(info.props) ? tableWidthHistory.capture(doc, b) : null;
                  const previousVersion = doc.propVersion(b, "tableData");
                  const historyGuard = tableHistoryGuard(doc, b);
                  const aliases = findBatchHistory.capture(doc, [b]);
                  const structureBefore = tableStructureHistory.capture(doc, b, um);
                  const rows = applyTableEdit(before, r, c, v);
                  // 单元格级写入：只写变动的单元格（+ 兼容镜像），不覆盖协作者的其他单元格。
                  writeTable(tx, b, info.props, rows, doc.client);
                  if (widthBefore) tableWidthHistory.rebaseMigration(doc, b, widthBefore, info.props);
                  if (tx.ops.length) {
                    const next = doc.propVersion(b, "tableData");
                    const key = r < 0 ? `table:${idKey(b)}:-1:-1` : `table:${idKey(b)}:${r}:${c}`;
                    const beforeValue = r < 0 ? tableDataOf(info.props) : old;
                    const afterValue = r < 0 ? tableDataOf(doc.blockInfo(b).props) : v;
                    const merged = tableHistory.record(sync.client, key, beforeValue, afterValue, previousVersion ? idKey(previousVersion) : null, next ? idKey(next) : null, historyGuard, kind, Date.now(), um.peekMarker(false) === key);
                    findBatchHistory.recordTableChange(key, aliases, merged);
                    um.recordMarker(key, merged);
                    tableStructureHistory.recordEdit(doc, b, key, structureBefore, merged, um);
                  }
                  sync.client.push(tx.ops);
                  force((x) => x + 1);
                  publish();
                }}
                onTableHeader={readOnly ? undefined : (axis, enabled) => {
                  if (readOnlyRef.current || sync.client.doc !== doc || !doc.hasBlock(b) || doc.blockInfo(b).type !== "table") return;
                  // A legacy grid is migrated independently of the visible header
                  // change. Undo must not remove its axes: offline collaborators may
                  // already have addressed cells using those stable IDs.
                  const props = doc.blockInfo(b).props, migration = new Tx(doc);
                  if (!isCellTable(props) && Object.entries(props).some(([key, value]) => key.startsWith("tbl.") && value !== "")) { setColumnNotice("表格数据状态不完整，未更改标题，请等待同步后重试。"); return; }
                  if (!isCellTable(props)) applyTableWrites(migration, b, props, cellTableWrites(props, tableRowsOf(props), doc.client));
                  const before = tableStructureHistory.snapshot(doc, b);
                  const tx = new Tx(doc);
                  tx.setProp(b, axis === "row" ? "tableHeader" : "tableHeaderColumn", enabled ? (axis === "row" ? "row" : "column") : "none");
                  if (!tx.ops.length) { if (migration.ops.length) { sync.client.push(migration.ops); force((x) => x + 1); } return; }
                  um.seal();
                  const marker = tableStructureHistory.record(doc, b, tx, um, before);
                  if (marker) um.recordMarker(marker);
                  sync.client.push([...migration.ops, ...tx.ops]); um.seal(); force((x) => x + 1); publish();
                }}
                onTableFill={readOnly ? undefined : (range, value) => tableFormat(range, { kind: "fill", value })}
                onTableAlign={readOnly ? undefined : (range, axis, value) => tableFormat(range, { kind: "align", axis, value })}
                onTablePaste={readOnly ? undefined : (row, col, text, literal, rich) => tableClipboard({ kind: "paste", row, col, text, literal, rich })}
                onTableCut={readOnly || onCopyBlock ? undefined : (range) => tableClipboard({ kind: "cut", range })}
                onTableClear={readOnly ? undefined : (range) => tableClipboard({ kind: "clear", range })}
                onTableAppendRow={readOnly ? undefined : () => tableClipboard({ kind: "append" })}
                onTableDeleteSelection={readOnly ? undefined : (range) => {
                  if (readOnlyRef.current || sync.client.doc !== doc || !doc.hasBlock(b)) return "文档状态已变化，表格未修改。";
                  const current = doc.blockInfo(b);
                  if (current.type !== "table" || !tableSnapshot || version("tableData") !== tableSnapshot.data || version("tableMerges") !== tableSnapshot.merges || version("tableWidths") !== tableSnapshot.widths || version("type") !== tableSnapshot.type || version("tbl.rows") !== tableSnapshot.rows || version("tbl.cols") !== tableSnapshot.cols || tableDataOf(current.props) !== tableDataOf(info.props)) return "表格已变化，请重新选择。";
                  const rows = tableRowsOf(current.props);
                  const merges = parseMergesStrict(current.props.tableMerges, rows.length, rows[0]?.length ?? 0);
                  if (!merges || !validTableWidths(current.props.tableWidths ?? "")) return "表格结构或列宽无效，表格未修改。";
                  const widths = parseTableWidths(current.props.tableWidths);
                  const plan = planSelectionDelete(rows, merges, widths, range);
                  if (!plan) return "选区已变化，请重新选择完整的行或列。";
                  const hadEditorFocus = root.current?.contains(document.activeElement) ?? false;
                  if (plan.kind !== "table" && !isCellTable(current.props) && Object.entries(current.props).some(([key, value]) => key.startsWith("tbl.") && value !== "")) return "表格数据状态不完整，请等待同步后重试。";
                  const migrationWrites = plan.kind !== "table" && !isCellTable(current.props) ? cellTableWrites(current.props, rows, doc.client) : null;
                  let deletionWrites: Record<string, string> | null = null;
                  if (plan.kind !== "table") {
                    const start = plan.kind === "rows" ? Math.min(range.r0, range.r1) : Math.min(range.c0, range.c1);
                    const end = plan.kind === "rows" ? Math.max(range.r0, range.r1) : Math.max(range.c0, range.c1);
                    deletionWrites = stableTableDeleteWrites(migrationWrites ? { ...current.props, ...migrationWrites } : current.props, plan.kind === "rows" ? "row" : "column", Array.from({ length: end - start + 1 }, (_, index) => start + index));
                    if (!deletionWrites || deletionWrites.tableData !== JSON.stringify(plan.rows)) return "表格数据尚未同步完成，未删除行列。";
                  }
                  const migration = new Tx(doc);
                  if (migrationWrites) applyTableWrites(migration, b, current.props, migrationWrites);
                  const before = tableStructureHistory.snapshot(doc, b);
                  const tx = new Tx(doc);
                  if (plan.kind === "table") tx.setProp(b, "type", "paragraph");
                  else {
                    applyTableWrites(tx, b, doc.blockInfo(b).props, deletionWrites!);
                    tx.setProp(b, "tableMerges", JSON.stringify(plan.merges));
                    if (plan.widths) tx.setProp(b, "tableWidths", JSON.stringify(widths ? [...plan.widths.slice(0, plan.rows[0].length), ...widths.slice(rows[0].length)] : plan.widths));
                  }
                  if (tx.ops.length) {
                    um.seal();
                    const marker = tableStructureHistory.record(doc, b, tx, um, before);
                    if (marker) um.recordMarker(marker);
                    sync.client.push([...migration.ops, ...tx.ops]); um.seal(); force((x) => x + 1); publish();
                    if (plan.kind === "table" && hadEditorFocus) requestAnimationFrame(() => {
                      if (sync.client.doc === doc && doc.hasBlock(b) && doc.blockInfo(b).type === "paragraph" && document.activeElement === document.body) root.current?.focus();
                    });
                  }
                  return null;
                }}
                dropLine={drag && drag.over && eqId(drag.over, b) ? (drag.after ? "after" : "before") : null}
                onToggle={readOnly ? undefined : () => toggleTodo(b)}
                onDragStart={readOnly ? undefined : () => {
                  const leader = selBlocks.length > 1 && selBlocks[0] === k;
                  const group = leader ? dragGroup(doc, bodyBlocks(doc), selBlocks) : [b];
                  setDrag({ b, group: group.length ? group : [b], over: null, after: false });
                }}
                onDragOver={readOnly ? undefined : (after) => drag && setDrag({ ...drag, over: b, after })}
                onDragEnd={readOnly ? undefined : () => setDrag(null)}
                canCopy={!onCopyBlock}
                canDownload={!(disableFileDownloads ?? onCopyBlock)}
                onReplaceFile={!readOnly && upload ? (f, progress) => replaceFile(b, f, progress) : undefined}
                flowAI={ai && !onCopyBlock ? ai : undefined}
                flowAutoOpen={flowAutoOpen === k || flowOpenRequests.has(k)}
                flowUpload={!readOnly && upload ? upload : undefined}
                flowAssets={{ docId: sync.client.docId, copy: copyClipboardAssets }}
                flowPeers={doc.blockInfo(b).type === "flowchart" ? sync.peers.filter((p) => p.state.flow?.block === k).map((p) => ({ id: p.clientId, name: p.state.name, color: p.state.color, x: p.state.flow?.x, y: p.state.flow?.y, sel: Array.isArray(p.state.flow?.sel) ? p.state.flow!.sel : undefined })) : undefined}
                onFlowPresence={(f) => sync.client.setAwareness({ ...me, cursor: null, flow: f ? { block: k, ...f } : null } satisfies Presence)}
                onFlowComment={onComment ? (text) => onComment({ block: k, startChar: "", endChar: "", quote: `[流程图] ${text}`.slice(0, 200) }) : undefined}
                onFlowChange={readOnly ? undefined : (graph, base) => {
                  if (readOnlyRef.current || sync.client.doc !== doc || !doc.hasBlock(b) || doc.blockInfo(b).type !== "flowchart") return { graph: base, conflicts: ["document"], applied: false, appliedKeys: [] };
                  if (flowAutoOpen === k) setFlowAutoOpen(null);
                  const tx = new Tx(doc);
                  const intent = flowIntentWrites(doc.blockInfo(b).props, base, graph);
                  for (const [key, value] of Object.entries(intent.writes)) tx.setProp(b, key, value);
                  if (tx.ops.length) {
                    um.seal();
                    um.record(tx, sel.current, sel.current, "prop");
                    sync.client.push(tx.ops);
                    um.seal();
                    force((x) => x + 1);
                  }
                  // No publish(): it would drop the flowchart pointer/selection presence.
                  return { graph: readFlow(doc.blockInfo(b).props), conflicts: intent.conflicts, applied: tx.ops.length > 0, appliedKeys: tx.ops.length ? Object.keys(intent.writes) : [] };
                }}
                onTableChange={readOnly ? undefined : applyTableStructure}
                uploadNotice={uploading?.anchor === k ? uploading : null}
              />
            );
          })}
      </div>
      <input
        ref={fileInput}
        type="file"
        hidden
        data-file-input
        onChange={(e) => {
          const p = pendingUpload.current,
            files = [...(e.target.files ?? [])];
          e.target.value = "";
          pendingUpload.current = null;
          if (p && files.length) void insertFiles(files, p);
        }}
      />
      {carets.map((c) => (
        <div key={c.id} className="pointer-events-none absolute" style={{ left: c.x, top: c.y, height: c.h }} data-remote-caret={c.name}>
          <div className="absolute -left-px top-0 h-full w-[2px] rounded-full" style={{ background: c.color }} />
          <div className="absolute -left-px -top-[17px] whitespace-nowrap rounded-[3px] rounded-bl-none px-1 text-[11px] font-medium leading-[16px] text-white" style={{ background: c.color }}>
            {c.name}
          </div>
        </div>
      ))}
      {aiPanel && ai && sync.client.doc?.hasBlock({ client: Number(aiPanel.key.split(":")[0]), clock: Number(aiPanel.key.split(":")[1]) }) && (
        <AIBlockPanel
          key={`${aiPanel.key}:${aiPanel.initial ?? ""}`}
          x={aiPanel.x}
          y={aiPanel.y}
          text={aiPanel.range ? aiRangeText.current : sync.client.doc.text({ client: Number(aiPanel.key.split(":")[0]), clock: Number(aiPanel.key.split(":")[1]) })}
          initial={aiPanel.initial}
          ai={ai}
          canEdit={!readOnly}
          onReplace={(result) => applyAiResult(aiPanel.key, result, "replace", aiPanel.range)}
          onInsert={(result) => applyAiResult(aiPanel.key, result, "insert", aiPanel.range)}
          onClose={() => setAiPanel(null)}
        />
      )}
      {(!readOnly || onComment) && toolbar && sel.current && (
        <FormatToolbar
          x={toolbar.x}
          y={toolbar.y}
          marks={tb}
          blockType={curType}
          align={curAlign}
          readOnly={readOnly}
          onAI={ai && !onCopyBlock && sel.current && eqId(sel.current.a.b, sel.current.f.b) ? () => {
            const cur = sel.current, d = sync.client.doc, w = wrap.current;
            if (!cur || !d || !w || !eqId(cur.a.b, cur.f.b) || !d.hasBlock(cur.a.b)) return;
            const start = Math.min(cur.a.o, cur.f.o), end = Math.max(cur.a.o, cur.f.o);
            if (start === end) return;
            aiRangeText.current = [...d.text(cur.a.b)].slice(start, end).join("");
            const node = blockEl(w, cur.a.b), base = w.getBoundingClientRect(), r = node?.getBoundingClientRect();
            setToolbar(null);
            setAiPanel({ key: idKey(cur.a.b), x: r ? Math.max(0, Math.round(r.left - base.left)) : 0, y: r ? Math.round(r.bottom - base.top + 6) : toolbar.y + 24, range: { start, end } });
          } : undefined}
          onAlign={(a) => {
            const d = sync.client.doc, s = sel.current;
            if (alignmentPendingRef.current && pendingAlignmentPlan.current && d && s && isColumnText(d, s.f.b)) { setColumnNotice("请先核对尚未完成的布局操作。"); return; }
            run((tx, selection) => setSelectionAlignment(tx, selection, a), undefined, false, true);
          }}
          onClearFormat={() => run((tx, s) => {
            const { start, end, blocks } = normalize(tx.doc, s);
            for (const b of blocks) {
              const from = eqId(b, start.b) ? start.o : 0;
              const to = eqId(b, end.b) ? end.o : len(tx.doc, b);
              if (to > from) for (const key of CLEARABLE_MARKS) tx.format(b, from, to, key, null);
            }
          })}
          onCopyLink={() => { const s = sel.current; if (s) void copyBlockLink(`${s.f.b.client}:${s.f.b.clock}`); }}
          commentError={commentError}
          onMark={(key, value) =>
            run((tx, s) => {
              if (value === "") {
                // 清除型 mark（颜色/高亮）：直接 format null
                const { start, end, blocks } = normalize(tx.doc, s);
                for (const b of blocks) {
                  const from = eqId(b, start.b) ? start.o : 0;
                  const to = eqId(b, end.b) ? end.o : len(tx.doc, b);
                  tx.format(b, from, to, key, null);
                }
              } else toggleMark(tx, s, key, value);
            })
          }
          onLink={(url) => run((tx, s) => toggleMark(tx, s, "link", url))}
          onType={(t) => run((tx, s) => { if (!isColumnText(tx.doc, s.f.b)) return setBlockType(tx, s, t); setColumnNotice("暂不支持更改栏内块类型。"); })}
          onComment={onComment ? () => {
            const s = sel.current;
            if (!doc || !s) return;
            const selection = commentSelection(doc, s);
            if (!selection.ok) {
              setCommentError(selection.reason === "cross-block" ? "暂不支持跨段落评论，请选择同一段文字。" : "请选择同一段中的有效文字。");
              return;
            }
            setCommentError(null);
            onComment(selection.anchor);
          } : undefined}
        />
      )}
      {/* 飞书：输入「/」后在其后显示灰色「输入关键词」占位，开始输入即消失。 */}
      {!readOnly && slash?.kind === "/" && !slash.fromButton && slashRange && slashRange.text === "/" && base && root.current && (() => {
        const r = caretRect(root.current, { b: slash.at.b, o: slashRange.start + 1 });
        return r ? <span aria-hidden className="pointer-events-none absolute select-none whitespace-nowrap text-[16px] text-[#BBBFC4]" style={{ left: r.left - base.left + 2, top: r.top - base.top, lineHeight: `${r.bottom - r.top}px` }} data-slash-placeholder>输入关键词</span> : null;
      })()}
      {!readOnly && slash && slashPos && base && (
        <SlashMenu
          x={slashPos.left - base.left}
          y={slashPos.bottom - base.top + 6}
          query={slash.fromButton ? slash.buttonQuery : undefined}
          items={slashItems}
          index={Math.min(slash.index, Math.max(0, slashItems.length - 1))}
          onPick={pickSlashItem}
          onHover={(i) => changeSlash((current) => current ? { ...current, index: i, tableSize: slashItems[i]?.id === "table" ? current.tableSize : undefined } : null)}
          tableSize={slash.tableSize}
          onTableOpen={slash.fromButton ? openTablePicker : undefined}
          onTableSizeChange={(size) => { if (validTablePickerSize(size)) changeSlash((current) => current?.tableSize ? { ...current, tableSize: size } : current); }}
          onTableSizePick={pickTableSize}
          onTableSizeClose={() => { changeSlash((current) => current ? { ...current, tableSize: undefined } : null); root.current?.focus({ preventScroll: true }); }}
        />
      )}
    </div>
  );
}

function activeMarksAt(doc: Doc, p: Pos): Record<string, string> {
  const chars = doc.richChars(p.b);
  return p.o > 0 ? chars[p.o - 1].marks : (chars[0]?.marks ?? {});
}

function wordLen(text: string, o: number, back: boolean): number {
  const cps = [...text];
  let i = o,
    n = 0;
  const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);
  if (back) {
    while (i > 0 && !isWord(cps[i - 1])) (i--, n++);
    while (i > 0 && isWord(cps[i - 1]) && !/\p{Script=Han}/u.test(cps[i - 1])) (i--, n++);
    if (n === 0 && i > 0) n = 1;
  } else {
    while (i < cps.length && !isWord(cps[i])) (i++, n++);
    while (i < cps.length && isWord(cps[i]) && !/\p{Script=Han}/u.test(cps[i])) (i++, n++);
    if (n === 0 && i < cps.length) n = 1;
  }
  return n;
}

/** 块菜单在某类块上可用的动作；跨块选区（multi）时按“作用于其中适用的块”放开。 */
/** 可设置段落对齐的块（与飞书一致：文本类块，不含代码块）。 */
export const ALIGNABLE = new Set(["paragraph", "h1", "h2", "h3", "h4", "h5", "h6", "bullet", "ordered", "todo", "quote", "callout"]);
/** Align visible text while rejecting stale or cross-column selections. */
export function setSelectionAlignment(tx: Tx, selection: Sel, align: Align): void {
  const doc = tx.doc;
  if (!validEditorSelection(doc, selection) || !eqId(selection.a.b, selection.f.b) && (isColumnText(doc, selection.a.b) || isColumnText(doc, selection.f.b))) return;
  for (const block of normalize(doc, selection).blocks) {
    const info = doc.blockInfo(block);
    if (ALIGNABLE.has(info.type) && blockAlign(info.props.align) !== align) tx.setProp(block, "align", align);
  }
}
/** “清除格式”移除的行内样式。 */
export const CLEARABLE_MARKS = ["bold", "italic", "underline", "strike", "code", "color", "bg", "link"] as const;

export function blockAbilities(type: string, multi: boolean, canCopy: boolean, canComment: boolean): BlockMenuAbilities {
  const textish = COLORABLE.has(type) || type === "code";
  return {
    convert: multi || CONVERTIBLE.has(type),
    color: multi || COLORABLE.has(type),
    indent: multi || TEXT_BLOCKS.has(type),
    align: multi || ALIGNABLE.has(type),
    copy: canCopy && (multi || textish || CLIPPABLE_BLOCKS.has(type)),
    cut: canCopy && (multi || textish || CLIPPABLE_BLOCKS.has(type)),
    link: true,
    comment: canComment && (textish || (!multi && COMMENTABLE_BLOCKS.has(type))),
    insertAfter: true,
    delete: true,
  };
}

/** 页面级能力（AI、分享、保存为模板）叠加到块菜单能力上；AI 只处理文字类块。 */
export function withPageAbilities(base: BlockMenuAbilities, type: string, page: { ai: boolean; share: boolean; template: boolean }): BlockMenuAbilities {
  const textish = COLORABLE.has(type) || type === "code";
  return { ...base, ai: page.ai && textish, share: page.share, template: page.template && (textish || type === "divider" || type === "table") };
}

/**
 * 整体拖动：被拖的块（按文档顺序）与落点。落在被拖块自身上视为无操作；
 * 目标前驱若也在被拖块中，向前找到第一个不在其中的块。
 */
export function dropPlan(body: OpId[], group: OpId[], over: OpId, after: boolean): { moving: OpId[]; target: OpId | null } | null {
  const inGroup = (x: OpId) => group.some((g) => eqId(g, x));
  if (!group.length || inGroup(over)) return null;
  const moving = body.filter(inGroup);
  if (!moving.length) return null;
  let i = body.findIndex((x) => eqId(x, over));
  if (i < 0) return null;
  if (!after) i -= 1;
  while (i >= 0 && inGroup(body[i])) i -= 1;
  const target = i >= 0 ? body[i] : null;
  // 已在原位（目标紧挨在整组之前且整组连续）时不产生移动。
  const first = body.findIndex((x) => eqId(x, moving[0]));
  const contiguous = moving.every((x, j) => eqId(body[first + j], x));
  if (contiguous && (first === 0 ? target === null : target !== null && eqId(body[first - 1], target))) return null;
  return { moving, target };
}

/** 选区覆盖的顶层正文块（按文档顺序）；不在正文顶层的块不参与整体拖动。 */
function dragGroup(doc: Doc | null, body: OpId[], keys: string[]): OpId[] {
  if (!doc) return [];
  return body.filter((x) => keys.includes(idKey(x)));
}

/** 只读或仅评论的读者：块手柄只提供复制、复制链接和评论（受复制保护与评论权限约束）。 */
export function readOnlyBlockAbilities(type: string, canCopy: boolean, canComment: boolean): BlockMenuAbilities {
  const textish = COLORABLE.has(type) || type === "code";
  return { convert: false, color: false, indent: false, align: false, copy: canCopy && (textish || CLIPPABLE_BLOCKS.has(type)), cut: false, link: true, comment: canComment && (textish || COMMENTABLE_BLOCKS.has(type)), insertAfter: false, delete: false };
}

const BLOCK_CLASS: Record<string, string> = {
  paragraph: "text-[16px] leading-[1.75] py-[3px]",
  h1: "text-[26px] font-medium leading-[1.4] mt-5 mb-[6px]",
  h2: "text-[22px] font-medium leading-[1.4] mt-[17px] mb-[5px]",
  h3: "text-[20px] font-medium leading-[1.45] mt-4",
  h4: "text-[18px] font-medium leading-[1.5] mt-3",
  h5: "text-[16px] font-medium leading-[1.6] mt-2.5",
  h6: "text-[16px] font-medium leading-[1.6] mt-2.5",
  bullet: "text-[16px] leading-[1.75] py-[3px]",
  ordered: "text-[16px] leading-[1.75] py-[3px]",
  todo: "text-[16px] leading-[1.75] py-[3px]",
  quote: "text-[16px] leading-[1.75] py-[3px] border-l-2 border-[#BBBFC4] dark:border-border pl-3 text-muted-foreground my-1",
  code: "my-2",
  callout: "text-[16px] leading-[1.75] py-[8px]",
};

interface BlockProps {
  /** 流程图块：写回图（逐对象属性）；未提供表示只读。 */
  onFlowChange?: (graph: FlowGraph, base: FlowGraph) => FlowChangeOutcome;
  flowAI?: (messages: AIMessage[]) => Promise<string>;
  flowAutoOpen?: boolean;
  flowPeers?: FlowPeer[];
  onFlowPresence?: (p: FlowPresence | null) => void;
  onFlowComment?: (quote: string) => void;
  flowUpload?: FlowUpload;
  flowAssets?: FlowAssets;
  /** columns 容器：渲染其子块（每栏一个） */
  childBlocks?: { id: string; type: string; props: Record<string, string>; spans: { ch: string; marks: Record<string, string> }[]; anchors?: (number | null)[]; commentThreads?: number[]; findRanges?: { start: number; end: number; active: boolean }[] }[];
  columnRemount?: Record<string, number>;
  syncVersion: number;
  syncStatus: SyncDoc["status"];
  onAddColumn?: (after: string | null) => void;
  onMoveColumn?: (column: string, after: string | null) => void;
  onBeginColumnResize?: (left: string, right: string) => { leftWeight: number; rightWeight: number; commit: (fraction: number) => void; cancel: () => void } | null;
  onBeginTableResize?: (index: number, indices?: readonly number[]) => TableResizeSession | null;
  onBeginTableReorder?: () => TableReorderSession | null;
  onDeleteColumn?: (col: string) => void;
  anchors?: (number | null)[];
  commentThreads?: number[];
  blockThreads?: number[];
  onBlockComment?: () => void;
  findRanges?: { start: number; end: number; active: boolean }[];
  tableFindCells?: { row: number; col: number; value: string; ranges: { start: number; end: number; active: boolean }[] }[];
  findNavigation?: number;
  activeThread?: number | null;
  onAnchorClick?: (cid: number) => void;
  onSetProp?: (key: string, value: string) => void;
  onTableEdit?: (r: number, c: number, value: string, kind?: string) => void;
  onTableHeader?: (axis: "row" | "column", enabled: boolean) => void;
  onTableFill?: (target: TableFormatTarget, fill: string) => string | null;
  onTableAlign?: (target: TableFormatTarget, axis: TableAlignAxis, align: TableAlign) => string | null;
  onTablePaste?: (r: number, c: number, text: string, literal?: boolean, rich?: RichTableClipboard) => string | null;
  onTableCut?: (range: CellRange) => string | null;
  onTableClear?: (range: CellRange) => string | null;
  onTableAppendRow?: () => string | null;
  onTableDeleteSelection?: (range: CellRange) => string | null;
  /** 悬停 + 按钮：在当前块后插入空段落并聚焦 */
  onInsertAfter?: () => void;
  /** The insertion affordance is visible on an otherwise blank document. */
  alwaysShowInsert?: boolean;
  touchActive?: boolean;
  onPreviewImage?: (src: string, alt: string, mime?: string) => void;
  /** 公式块：请求编辑源码 */
  onMathSource?: (blockKey: string) => void;
  onDiagramSource?: (blockKey: string) => void;
  /** 删除整个块（媒体/公式/图表等 TEXTLESS 块的 hover ✕） */
  onDeleteBlock?: (blockKey: string) => void;
  /** 块菜单动作（转换、颜色、缩进、复制、评论等），由编辑器决定作用于单块还是跨块选区。 */
  onBlockAction?: (blockKey: string, action: BlockMenuAction) => void;
  blockAbilities?: BlockMenuAbilities;
  /** 跨块选区的第一个块：选中块数（显示常驻手柄） */
  selectionCount?: number;
  inSelection?: boolean;
  id: string;
  type: string;
  props: Record<string, string>;
  number?: number;
  spans: { ch: string; marks: Record<string, string> }[];
  dropLine: "before" | "after" | null;
  onToggle?: () => void;
  onDragStart?: () => void;
  onDragOver?: (after: boolean) => void;
  onDragEnd?: () => void;
  canCopy?: boolean;
  canDownload?: boolean;
  onReplaceFile?: (file: File, progress: (p: number) => void) => Promise<void>;
  onTableChange?: (rows: string[][], merges: Merge[], widths?: Widths, op?: TableOp) => string | null | void;
  uploadNotice?: { name: string; percent: number; index: number; total: number } | null;
}

function Block({ onFlowChange, flowAI, flowAutoOpen, flowPeers, onFlowPresence, onFlowComment, flowUpload, flowAssets, id, type, props, number, spans, childBlocks, columnRemount, syncVersion, syncStatus, onAddColumn, onMoveColumn, onBeginColumnResize, onBeginTableResize, onBeginTableReorder, onDeleteColumn, anchors, commentThreads, blockThreads, onBlockComment, findRanges, tableFindCells, findNavigation, activeThread, onAnchorClick, onSetProp, onTableEdit, onTableHeader, onTableFill, onTableAlign, onTablePaste, onTableCut, onTableClear, onTableAppendRow, onTableDeleteSelection, onInsertAfter, alwaysShowInsert, touchActive, onPreviewImage, onMathSource, onDiagramSource, onDeleteBlock, onBlockAction, blockAbilities, selectionCount, inSelection, dropLine, onToggle, onDragStart, onDragOver, onDragEnd, canCopy, canDownload, onReplaceFile, onTableChange, uploadNotice }: BlockProps) {
  const indent = Number(props.indent ?? "0");
  const codeTextRef = useRef<HTMLDivElement>(null);
  const resize = useRef<{ pointer: number; startX: number; firstPixels: number; pairPixels: number; left: string; right: string; operation: NonNullable<ReturnType<NonNullable<BlockProps["onBeginColumnResize"]>>>; target: HTMLElement; scroller: HTMLElement; viewport: number; scrollLeft: number } | null>(null);
  const [resizePreview, setResizePreview] = useState<{ left: string; right: string; first: number; second: number } | null>(null);
  const draggingColumn = useRef<string | null>(null);
  const [columnDrop, setColumnDrop] = useState<{ id: string; side: "before" | "after" } | null>(null);
  const [columnMenu, setColumnMenu] = useState<{ id: string; left: number; top: number } | null>(null);
  const columnMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!columnMenu) return;
    const outside = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest("[data-column-move-menu], [data-column-move-handle]")) setColumnMenu(null); };
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setColumnMenu(null); requestAnimationFrame(() => { [...document.querySelectorAll<HTMLButtonElement>("[data-column-move-handle]")].find((handle) => handle.dataset.columnMoveHandle === columnMenu.id)?.focus({ preventScroll: true }); }); } };
    const dismiss = () => setColumnMenu(null);
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", close); window.addEventListener("scroll", dismiss, true); window.addEventListener("resize", dismiss);
    requestAnimationFrame(() => columnMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", close); window.removeEventListener("scroll", dismiss, true); window.removeEventListener("resize", dismiss); };
  }, [columnMenu]);
  const widthIds = childBlocks?.map((child) => child.id) ?? [];
  const weights = columnWeights(props[COLUMN_WIDTHS], widthIds);
  const cancelResize = () => {
    const active = resize.current; resize.current = null; setResizePreview(null);
    if (active?.target.hasPointerCapture(active.pointer)) active.target.releasePointerCapture(active.pointer);
  };
  const moveColumnBy = (column: string, direction: -1 | 1) => {
    const ids = (childBlocks ?? []).map((child) => child.id), index = ids.indexOf(column);
    if (!onMoveColumn || index < 0 || direction === -1 && index === 0 || direction === 1 && index === ids.length - 1) return;
    onMoveColumn(column, direction === -1 ? (index >= 2 ? ids[index - 2] : null) : ids[index + 1]);
  };
  const dropColumn = (target: string, side: "before" | "after") => {
    const source = draggingColumn.current;
    draggingColumn.current = null; setColumnDrop(null);
    if (!source || source === target || !onMoveColumn) return;
    const remaining = (childBlocks ?? []).map((child) => child.id).filter((id) => id !== source), index = remaining.indexOf(target);
    if (index < 0) return;
    onMoveColumn(source, side === "after" ? target : index ? remaining[index - 1] : null);
  };
  const focusColumnHandle = (column: string) => requestAnimationFrame(() => {
    const handles = document.querySelectorAll<HTMLButtonElement>("[data-column-move-handle]");
    [...handles].find((handle) => handle.dataset.columnMoveHandle === column)?.focus({ preventScroll: true });
  });
  const checked = props.checked === "true";
  const commentBadge = commentThreads?.length ?? 0;
  const firstThread = commentThreads?.includes(activeThread ?? -1) ? activeThread : (commentThreads?.[0] ?? null);
  const highlighted = new Array<0 | 1 | 2>(spans.length).fill(0);
  for (const range of findRanges ?? []) {
    for (let i = Math.max(0, range.start); i < Math.min(spans.length, range.end); i++) highlighted[i] = range.active ? 2 : 1;
  }
  type RenderRun = { text: string; marks: Record<string, string>; anchor: number | null; highlight: 0 | 1 | 2 };
  const makeRuns = (chars: typeof spans, flags: (0 | 1 | 2)[], commentFlags?: (number | null)[]): RenderRun[] => {
    const result: RenderRun[] = [];
    const atoms = new Map(mathSpansFromChars(chars).map((atom) => [atom.start, atom]));
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i], atom = atoms.get(i);
      if (atom) {
        const covered = (commentFlags ?? []).slice(atom.start, atom.end).filter((value): value is number => value != null);
        const anchor = activeThread != null && covered.includes(activeThread) ? activeThread : (covered[0] ?? null);
        result.push({ text: chars.slice(atom.start, atom.end).map((char) => char.ch).join(""), marks: c.marks, anchor, highlight: 0 });
        i = atom.end - 1;
        continue;
      }
      const anchor = commentFlags?.[i] ?? null, last = result[result.length - 1], highlight = flags[i];
      if (last && !last.marks.math && sameMarks(last.marks, c.marks) && last.anchor === anchor && last.highlight === highlight) last.text += c.ch;
      else result.push({ text: c.ch, marks: c.marks, anchor, highlight });
    }
    return result;
  };
  const runs = makeRuns(spans, highlighted, anchors);
  const renderRun = (run: typeof runs[number]) => {
    if (!run.highlight) return <Run text={run.text} marks={run.marks} />;
    // Search highlight must remain visible over a user's existing background
    // mark; suppress it only in this projection, never in the CRDT model.
    const marks = { ...run.marks };
    delete marks.bg;
    return <mark data-find-match data-find-active={run.highlight === 2 ? "true" : undefined} className={cn("rounded-[2px] text-inherit", run.highlight === 2 ? "bg-[#ffb74d]" : "bg-[#ffe69b]")}><Run text={run.text} marks={marks} /></mark>;
  };
  const renderAnchoredRun = (run: typeof runs[number], i: number) => run.anchor != null ? (
    <span key={i} className={cn("cursor-pointer border-b-2 border-[#F5B1E5] dark:bg-[#3a3121]", activeThread === run.anchor ? "bg-[#FBDC8D] dark:bg-[#4a3d1f]" : "bg-[#FFF3D6] dark:bg-[#3a3121]")} onClick={() => onAnchorClick?.(run.anchor!)} data-comment-anchor={run.anchor}>{renderRun(run)}</span>
  ) : <span key={i}>{renderRun(run)}</span>;
  const renderColumnText = (ch: NonNullable<BlockProps["childBlocks"]>[number]) => {
    const flags = new Array<0 | 1 | 2>(ch.spans.length).fill(0);
    for (const range of ch.findRanges ?? []) {
      for (let i = Math.max(0, range.start); i < Math.min(ch.spans.length, range.end); i++) flags[i] = range.active ? 2 : 1;
    }
    return makeRuns(ch.spans, flags, ch.anchors).map(renderAnchoredRun);
  };
  const [handleOpen, setHandleOpen] = useState(false);
  const emptyText = spans.length === 0 && TEXT_BLOCKS.has(type);
  const tableDisplayWidths = type === "table" ? visibleTableWidths(tableRowsOf(props), parseTableWidths(props.tableWidths)) : [];
  const equalizeAllTableWidths = () => {
    const indices = tableDisplayWidths.map((_, index) => index), next = equalizedTableWidths(tableDisplayWidths, indices);
    if (!next || next.every((width, index) => width === tableDisplayWidths[index])) return;
    const session = onBeginTableResize?.(0, indices);
    if (!session) return;
    try { const result = session.commit(next); if (result) void result.catch(() => {}); } catch { session.cancel(); }
  };
  let prefix: ReactNode = null;
  if (type === "bullet") prefix = <span className="select-none text-primary">{["•", "◦", "▪"][indent % 3]}</span>;
  if (type === "ordered") prefix = <span className="select-none tabular-nums text-primary">{number}.</span>;
  if (type === "todo")
    prefix = (
      <button
        contentEditable={false}
        onMouseDown={(e) => {
          e.preventDefault();
          onToggle?.();
        }}
        className={cn("mt-[5px]", checked ? "text-primary" : "text-[#bbbfc4]")}
        disabled={!onToggle}
        aria-label="完成"
      >
        <TodoCheck checked={checked} />
      </button>
    );
  return (
    <div
      data-block={id}
      data-type={type}
      className={cn("group relative", type === "divider" ? "py-5" : type === "image" || type === "file" ? "" : (BLOCK_CLASS[type] ?? BLOCK_CLASS.paragraph), inSelection && "rounded-[4px] bg-primary/[0.06]", handleOpen && !inSelection && "rounded-[4px] bg-[#E6ECFD] dark:bg-primary/15", blockThreads?.length && "rounded-[6px] outline outline-1 outline-offset-2 outline-[#F7D46E]", blockThreads?.includes(activeThread ?? -1) && "bg-[#FFF6D1]/60 outline-2 outline-[#F0B400] dark:bg-[#5a4a12]/30")}
      data-block-selected={inSelection ? "true" : undefined}
      data-comment-block={blockThreads?.length ? blockThreads.join(" ") : undefined}
      style={{ marginLeft: indent * 24, textAlign: props.align === "center" || props.align === "right" ? props.align : undefined }}
      onDragOver={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onDragOver?.(e.clientY > r.top + r.height / 2);
      }}
    >
      {dropLine && <div className={cn("pointer-events-none absolute inset-x-0 h-[2px] rounded bg-primary", dropLine === "before" ? "-top-px" : "-bottom-px")} />}
      <span className={cn("absolute items-center", alwaysShowInsert ? "-left-[26px] sm:-left-[36px] top-[5px] sm:top-[2px]" : "-left-7 sm:-left-[62px]", !alwaysShowInsert && (type === "columns" ? "top-[11px]" : "top-[2px]"), alwaysShowInsert || handleOpen || (selectionCount ?? 0) > 1 ? "flex" : "hidden group-hover:flex group-focus-within:flex", touchActive && "[@media(hover:none)]:flex")} contentEditable={false} data-block-controls>
        {onInsertAfter && (emptyText || (!onDragStart && !onDeleteBlock && !onBlockAction)) && !((selectionCount ?? 0) > 1) ? (
          <button
            className={cn("relative grid size-7 place-items-center rounded-md text-subtle hover:bg-hover hover:text-foreground before:absolute before:-inset-1 before:content-['']", alwaysShowInsert && "size-[22px] border border-[#DEE0E3] bg-surface sm:size-7")}
            title="插入内容"
            aria-label="插入内容"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onInsertAfter}
            data-insert-after
          ><AddIcon className="size-[16px]" /></button>
        ) : (onDragStart || onDeleteBlock || onInsertAfter || onBlockAction) ? (
          <BlockHandle
            type={type}
            indent={indent}
            align={props.align}
            tableHeaders={type === "table" && onTableHeader ? { row: props.tableHeader !== "none", column: props.tableHeaderColumn === "column", toggle: (axis) => onTableHeader(axis, axis === "row" ? props.tableHeader === "none" : props.tableHeaderColumn !== "column"), equalize: onBeginTableResize ? equalizeAllTableWidths : undefined, equalizeDisabled: tableDisplayWidths.length < 2 } : undefined}
            count={selectionCount ?? 1}
            open={handleOpen}
            onOpenChange={setHandleOpen}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            can={blockAbilities ?? { convert: !!onSetProp && CONVERTIBLE.has(type), insertAfter: !!onInsertAfter, delete: !!onDeleteBlock }}
            onAction={(action) => {
              if (action.kind === "insertAfter") return onInsertAfter?.();
              if (onBlockAction) return onBlockAction(id, action);
              if (action.kind === "delete") return onDeleteBlock?.(id);
              if (action.kind === "convert" && action.type !== type) onSetProp?.("type", action.type);
            }}
          />
        ) : null}
      </span>
      {type === "flowchart" && (
        <div className="my-2">
          <FlowchartBlock graph={readFlow(props)} height={Math.min(1200, Math.max(200, Number(props["fc.h"]) || 360))} readOnly={!onFlowChange} autoOpen={flowAutoOpen} ai={flowAI} onChange={onFlowChange} peers={flowPeers} onPresence={onFlowPresence} onComment={onFlowComment} upload={flowUpload} assets={flowAssets} canCopy={canCopy} />
        </div>
      )}
      {type === "diagram" ? (
        <div
          contentEditable={false}
          className={cn("my-2 select-none overflow-x-auto rounded-lg bg-surface py-3", onDiagramSource && "cursor-pointer hover:bg-hover")}
          onDoubleClick={() => onDiagramSource?.(id)}
          data-diagram
          title={onDiagramSource ? "双击编辑流程图" : undefined}
        >
          {spans.length ? <DiagramView src={spans.map((c) => c.ch).join("")} /> : <span className="text-[13px] text-subtle">{onDiagramSource ? "空流程图——双击输入 Mermaid" : "空流程图"}</span>}
        </div>
      ) : type === "math" ? (
        <MathBlock src={spans.map((c) => c.ch).join("")} onSource={onMathSource ? () => onMathSource(id) : undefined} />
      ) : type === "columns" ? (
        <div contentEditable={false} className="group/cols relative my-2" data-columns>
          <div className="-ml-6 overflow-x-auto pl-6" data-column-scroll><div className="flex w-full">
            {(childBlocks ?? []).map((ch, index, columns) => {
              const threads = ch.commentThreads ?? [];
              const weight = resizePreview?.left === ch.id ? resizePreview.first : resizePreview?.right === ch.id ? resizePreview.second : weights[index];
              return <Fragment key={`${ch.id}:${columnRemount?.[ch.id] ?? 0}`}><div className="group/col relative min-w-[132px] flex-1 sm:min-w-0" style={{ flexGrow: weight, flexBasis: "0%" }} data-column={ch.id} data-block={ch.id}
                onDragOver={(event) => {
                  if (!draggingColumn.current) return;
                  event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
                  const rect = event.currentTarget.getBoundingClientRect(), side = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
                  setColumnDrop((current) => current?.id === ch.id && current.side === side ? current : { id: ch.id, side });
                }}
                onDrop={(event) => { if (!draggingColumn.current) return; event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); dropColumn(ch.id, event.clientX < rect.left + rect.width / 2 ? "before" : "after"); }}>
                {columnDrop?.id === ch.id && <span aria-hidden className={cn("pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 rounded bg-[#3370ff]", columnDrop.side === "before" ? "-left-1" : "-right-1")} />}
                {onMoveColumn && <button type="button" draggable aria-label={`第 ${index + 1} 栏菜单`} aria-haspopup="menu" aria-expanded={columnMenu?.id === ch.id} title="拖动或使用菜单移动分栏" data-column-move-handle={ch.id} className="pointer-events-none absolute -left-6 top-0 z-20 grid h-7 w-5 cursor-grab place-items-center rounded text-[#8f959e] opacity-0 hover:bg-[#eff0f1] hover:text-[#3370ff] active:cursor-grabbing focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/col:pointer-events-auto group-hover/col:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
                  onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setColumnMenu((current) => current?.id === ch.id ? null : { id: ch.id, left: Math.max(8, Math.min(rect.left, window.innerWidth - 180)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 120)) }); }}
                  onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.setData("text/plain", ""); event.dataTransfer.effectAllowed = "move"; draggingColumn.current = ch.id; setColumnMenu(null); }}
                  onDragEnd={(event) => { event.stopPropagation(); draggingColumn.current = null; setColumnDrop(null); }}
                  onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); moveColumnBy(ch.id, event.key === "ArrowLeft" ? -1 : 1); } }}><GripDots /></button>}
                <div data-text contentEditable={!!onSetProp} suppressContentEditableWarning className="min-h-7 whitespace-pre-wrap break-words text-[15px] leading-7 outline-none" style={{ textAlign: blockAlign(ch.props.align) }}>
                  {renderColumnText(ch)}
                  {ch.spans.length === 0 && <br />}
                </div>
                {threads.length > 0 && <button contentEditable={false} className="mt-1 flex items-center gap-0.5 rounded-full border border-[#f5b1e5] bg-surface px-1.5 py-0.5 text-[11px] font-medium text-[#c950a8] shadow-sm" title={`${threads.length} 条评论`} onMouseDown={(e) => e.preventDefault()} onClick={() => onAnchorClick?.(threads.includes(activeThread ?? -1) ? activeThread! : threads[0])} data-comment-bubble><MessageCircle size={11} strokeWidth={1.7} /> {threads.length}</button>}
              </div>{index < columns.length - 1 && <div className="group/gutter relative w-8 shrink-0" contentEditable={false}
                onDragOver={(event) => { if (!draggingColumn.current) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setColumnDrop((current) => current?.id === ch.id && current.side === "after" ? current : { id: ch.id, side: "after" }); }}
                onDrop={(event) => { if (!draggingColumn.current) return; event.preventDefault(); event.stopPropagation(); dropColumn(ch.id, "after"); }}>
                  {onBeginColumnResize && <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={`调整第 ${index + 1} 栏和第 ${index + 2} 栏宽度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(100 * weight / (weight + (resizePreview?.right === columns[index + 1].id ? resizePreview.second : weights[index + 1])))} title="拖动调整栏宽" data-column-resize={ch.id} className="absolute inset-0 z-10 hidden cursor-col-resize outline-none sm:block [@media(hover:none)]:hidden"
                    onPointerDown={(event) => {
                      if (event.button !== 0 || resize.current) return;
                      const gap = event.currentTarget.parentElement, left = gap?.previousElementSibling, right = gap?.nextElementSibling, scroller = gap?.closest("[data-column-scroll]");
                      if (!(left instanceof HTMLElement) || !(right instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return;
                      const firstPixels = left.getBoundingClientRect().width, pairPixels = firstPixels + right.getBoundingClientRect().width;
                      const operation = onBeginColumnResize(ch.id, columns[index + 1].id);
                      if (!operation || pairPixels < 20) return;
                      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
                      resize.current = { pointer: event.pointerId, startX: event.clientX, firstPixels, pairPixels, left: ch.id, right: columns[index + 1].id, operation, target: event.currentTarget, scroller, viewport: scroller.clientWidth, scrollLeft: scroller.scrollLeft };
                    }}
                    onPointerMove={(event) => {
                      const active = resize.current; if (!active || active.pointer !== event.pointerId) return;
                      const fraction = Math.max(0.1, Math.min(0.9, (active.firstPixels + event.clientX - active.startX) / active.pairPixels));
                      const total = active.operation.leftWeight + active.operation.rightWeight;
                      setResizePreview({ left: active.left, right: active.right, first: total * fraction, second: total * (1 - fraction) });
                    }}
                    onPointerUp={(event) => {
                      const active = resize.current; if (!active || active.pointer !== event.pointerId) return;
                      const delta = event.clientX - active.startX, fraction = Math.max(0.1, Math.min(0.9, (active.firstPixels + delta) / active.pairPixels));
                      const movedViewport = !active.scroller.isConnected || active.scroller.clientWidth !== active.viewport || active.scroller.scrollLeft !== active.scrollLeft;
                      cancelResize(); if (movedViewport) active.operation.cancel(); else if (Math.abs(delta) >= 1) active.operation.commit(fraction);
                    }}
                    onPointerCancel={cancelResize}
                    onLostPointerCapture={() => { if (resize.current) cancelResize(); }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && resize.current) { event.preventDefault(); event.stopPropagation(); cancelResize(); return; }
                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                      event.preventDefault(); event.stopPropagation();
                      const operation = onBeginColumnResize(ch.id, columns[index + 1].id); if (!operation) return;
                      const fraction = operation.leftWeight / (operation.leftWeight + operation.rightWeight);
                      operation.commit(Math.max(0.1, Math.min(0.9, fraction + (event.key === "ArrowLeft" ? -0.05 : 0.05))));
                    }}>
                    <span className="absolute inset-y-0 left-1/2 w-px bg-transparent group-hover/gutter:bg-[#3370ff] group-focus-within/gutter:bg-[#3370ff]" />
                  </div>}
                  {onAddColumn && columns.length < MAX_COLUMNS && <button type="button" aria-label={`在第 ${index + 1} 栏后添加分栏`} title="添加分栏" onMouseDown={(event) => event.preventDefault()} onClick={() => onAddColumn(ch.id)} className="absolute left-1/2 top-1.5 z-20 hidden size-4 -translate-x-1/2 place-items-center rounded-full bg-[#3370ff] text-white opacity-0 shadow-sm group-hover/gutter:opacity-100 group-focus-visible/gutter:opacity-100 sm:grid [@media(hover:none)]:hidden" data-insert-column-after={ch.id}><AddIcon className="size-3" /></button>}
                </div>}</Fragment>;
            })}
          </div></div>
          {onAddColumn && <button type="button" disabled={(childBlocks?.length ?? 0) >= MAX_COLUMNS} title={(childBlocks?.length ?? 0) >= MAX_COLUMNS ? "每组分栏最多支持 10 栏" : "添加分栏"} className="mt-1 text-[12px] text-subtle enabled:hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 sm:opacity-0 sm:group-hover/cols:opacity-100 sm:focus-visible:opacity-100 [@media(hover:none)]:opacity-100" onClick={() => onAddColumn(childBlocks?.at(-1)?.id ?? null)} data-add-column>
            + 添加一栏
          </button>}
          {columnMenu && onMoveColumn && typeof document !== "undefined" && createPortal((() => {
            const index = (childBlocks ?? []).findIndex((child) => child.id === columnMenu.id), count = childBlocks?.length ?? 0;
            const action = (direction: -1 | 1) => { const id = columnMenu.id; setColumnMenu(null); moveColumnBy(id, direction); focusColumnHandle(id); };
            return <div ref={columnMenuRef} role="menu" aria-label="分栏操作" data-column-move-menu style={{ position: "fixed", left: columnMenu.left, top: columnMenu.top }} className="z-[70] w-40 rounded-lg border border-[#dee0e3] bg-surface p-1 text-[13px] shadow-[0_6px_24px_rgba(31,35,41,0.14)]">
              <button type="button" role="menuitem" disabled={index <= 0} onClick={() => action(-1)} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover disabled:opacity-40"><ArrowLeft size={15} />向左移动</button>
              <button type="button" role="menuitem" disabled={index < 0 || index >= count - 1} onClick={() => action(1)} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover disabled:opacity-40"><ArrowRight size={15} />向右移动</button>
              {onDeleteColumn && <button type="button" role="menuitem" title="安全删除尚未完成" onClick={() => { const id = columnMenu.id; setColumnMenu(null); onDeleteColumn(id); focusColumnHandle(id); }} className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-muted-foreground hover:bg-hover"><Trash2 size={15} />删除分栏</button>}
            </div>;
          })(), document.body)}
        </div>
      ) : commentBadge > 0 && (
        <button
          contentEditable={false}
          className="absolute -right-1 top-1/2 z-10 flex -translate-y-1/2 translate-x-full items-center gap-0.5 rounded-full border border-[#f5b1e5] bg-surface px-1.5 py-0.5 text-[11px] font-medium text-[#c950a8] shadow-sm hover:bg-[#FBF3FA] dark:text-[#e88ec7]"
          title={`${commentBadge} 条评论`}
          onClick={() => onAnchorClick?.(firstThread!)}
          data-comment-bubble
        >
          <MessageCircle size={11} strokeWidth={1.7} className="inline" /> {commentBadge}
        </button>
      )}
      {type === "math" || type === "diagram" || type === "columns" || type === "flowchart" ? null : type === "table" ? (
        <TableBlock
          data={tableDataOf(props)}
          fillProps={props}
          findCells={tableFindCells}
          findNavigation={findNavigation}
          widths={parseTableWidths(props.tableWidths)}
          header={props.tableHeader !== "none"}
          headerColumn={props.tableHeaderColumn === "column"}
          onHeader={onTableHeader ? (on) => onTableHeader("row", on) : undefined}
          onHeaderColumn={onTableHeader ? (on) => onTableHeader("column", on) : undefined}
          onBeginResize={onBeginTableResize}
          onBeginReorder={onBeginTableReorder}
          merges={props.tableMerges}
          onEdit={(r, c, v, kind) => onTableEdit?.(r, c, v, kind)}
          onPasteCells={onTablePaste}
          onCutCells={onTableCut}
          onClearCells={onTableClear}
          onAppendRow={onTableAppendRow}
          onDeleteSelection={onTableDeleteSelection}
          onChange={onTableChange}
          onFill={onTableFill}
          onAlign={onTableAlign}
          onDelete={() => onSetProp?.("type", "paragraph")}
          readOnly={!onTableEdit}
          canCopy={canCopy}
        />
      ) : type === "divider" ? (
        <hr contentEditable={false} className="h-px border-0 bg-[#DEE0E3] dark:bg-border" data-divider />
      ) : type === "image" ? (
        <ImageBlock fileId={props.fileId} name={props.name} mime={props.mime} width={props.imageWidth ? Number(props.imageWidth) || undefined : undefined} align={props.align} caption={props.caption} version={syncVersion} status={syncStatus} canDownload={!!canDownload} onPreview={onPreviewImage} onProp={onSetProp} onReplace={onReplaceFile} onDelete={onDeleteBlock ? () => onDeleteBlock(id) : undefined} onComment={onBlockComment} />
      ) : type === "video" ? (
        <VideoBlock url={props.url} name={props.name} disableFileDownloads={!canDownload} />
      ) : type === "bookmark" ? (
        <BookmarkBlock url={props.url} name={props.name} title={props.title} description={props.description} icon={props.icon} preview={props.preview} onProps={onSetProp} />
      ) : type === "file" ? (
        <FileCard fileId={props.fileId} name={props.name} size={props.size} canDownload={!!canDownload} onPreview={onPreviewImage && isPreviewable(props.mime) ? () => onPreviewImage(`/api/files/${props.fileId}`, props.name ?? "附件", props.mime) : undefined} />
      ) : type === "code" ? (
        <div className="rounded-md border border-[#D9DBDF] bg-[#F3F5F6] dark:border-border dark:bg-[#23262a]" data-code-wrap-mode={props.wrap === "false" ? "nowrap" : "wrap"}>
          <CodeBlockHeader
            lang={props.lang}
            wrap={props.wrap !== "false"}
            onLang={onSetProp ? (v) => onSetProp("lang", v) : undefined}
            onWrap={onSetProp ? (w) => onSetProp("wrap", w ? "true" : "false") : undefined}
            onCopy={canCopy ? () => navigator.clipboard?.writeText(spans.map((c) => c.ch).join("")) : undefined}
          />
          <div className="flex gap-6 pl-7">
            <CodeLineNumbers text={spans.map((c) => c.ch).join("")} textRef={codeTextRef} wrap={props.wrap !== "false"} />
            <div ref={codeTextRef} data-text className={cn("min-w-0 flex-1 pb-[26px] pr-7 pt-0.5 font-mono text-[14px] leading-[22px]", props.wrap === "false" ? "overflow-x-auto whitespace-pre" : "whitespace-pre-wrap break-words")}>
              {runs.length === 0 ? <br /> : runs.map(renderAnchoredRun)}
            </div>
          </div>
        </div>
      ) : type === "callout" ? (
        <div className={cn("flex gap-2 rounded-lg border px-3.5 py-[15px]", prefix && "flex gap-2")} style={calloutStyle(props.color)} data-callout-color={Number(props.color ?? 0)}>
          <CalloutEmoji emoji={props.emoji} onPick={onSetProp ? (e) => onSetProp("emoji", e) : undefined} />
          <div data-text className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {runs.length === 0 ? <br /> : runs.map(renderAnchoredRun)}
          </div>
          {onSetProp && <CalloutColorBar color={props.color} onPick={(i) => onSetProp("color", String(i))} />}
        </div>
      ) : (
        <div className={cn(prefix && "flex gap-2")}>
          {prefix && (
            <span contentEditable={false} className="flex min-w-[18px] justify-center">
              {prefix}
            </span>
          )}
          <div data-text className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", type === "todo" && checked && "text-subtle line-through")}>
            {runs.length === 0 ? (
              <br />
            ) : (
              runs.map(renderAnchoredRun)
            )}
          </div>
        </div>
      )}
      {uploadNotice && <div contentEditable={false} role="status" className="my-2 flex w-[360px] max-w-full select-none items-center gap-3 rounded-lg border border-dashed bg-sidebar/50 px-3.5 py-2.5 text-[13px]" data-upload-placeholder>
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#E1EAFF] text-[11px] font-semibold text-primary">{Math.round(uploadNotice.percent)}%</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-foreground">正在上传 {uploadNotice.name}{uploadNotice.total > 1 ? `（${uploadNotice.index + 1}/${uploadNotice.total}）` : ""}</span><span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-border"><span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${uploadNotice.percent}%` }} /></span></span>
      </div>}
    </div>
  );
}


/** Simple table block: plain-text grid stored as JSON in a block prop. */
function sameMarks(a: Record<string, string>, b: Record<string, string>) {
  const ka = Object.keys(a),
    kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

function Run({ text, marks }: { text: string; marks: Record<string, string> }) {
  const href = safeURL(marks.link);
  const cls = cn(
    marks.bold && "font-semibold",
    marks.italic && "italic",
    (marks.underline || marks.strike) && [marks.underline && "underline", marks.strike && "line-through"],
    marks.code && "mx-px rounded-[4px] border border-border bg-sidebar px-[3px] py-px font-mono text-[0.875em] text-foreground",
    href && "cursor-pointer text-primary underline-offset-2 hover:underline",
  );
  const style = marks.color || marks.bg ? { color: marks.color || undefined, background: marks.bg || undefined } : undefined;
  // The rendered formula does not have the same character length as its
  // source. Treat it as an atomic projection even when other marks overlap.
  if (marks.math)
    return (
      <span className="mx-0.5 not-italic" title={`$${marks.math}$`} data-model-length={[...text].length} data-inline-math contentEditable={false}>
        <MathView src={marks.math} />
      </span>
    );
  if (href?.startsWith("#/doc/"))
    return (
      <a
        style={style}
        href={href}
        data-mention
        className={cn(cls, "rounded px-1 py-px font-medium no-underline hover:underline", "bg-[#E1EAFF]")}
        onClick={(e) => {
          e.preventDefault();
          navigateDocumentHash(href);
        }}
      >
        {text}
      </a>
    );
  if (marks.mention)
    return (
      <span className="cursor-default rounded bg-accent px-0.5 font-medium not-italic text-primary" data-member={marks.mention}>
        {text}
      </span>
    );
  if (href)
    return (
      <a style={style} href={href} className={cls} data-link onClick={(e) => {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) window.open(href, "_blank", "noopener,noreferrer");
      }}>
        {text}
      </a>
    );
  return Object.keys(marks).length ? <span className={cls} style={style}>{text}</span> : <>{text}</>;
}


function BookmarkBlock({ url, name, title, description, icon, preview, onProps }: { url?: string; name?: string; title?: string; description?: string; icon?: string; preview?: string; onProps?: (key: string, value: string) => void }) {
  const href = safeURL(url);
  const [iconFailed, setIconFailed] = useState(false);
  const asked = useRef(false);
  const setProps = useRef(onProps);
  setProps.current = onProps;
  const canFetch = !!onProps;
  const live = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // 编辑者打开时补抓一次网页标题/图标（服务端代理抓取，带 SSRF 防护）；失败记为 preview=none，不再重试。
  useEffect(() => {
    if (!canFetch || !href || preview || title || asked.current) return;
    asked.current = true;
    linkApi.preview(href).then((p) => {
      const set = setProps.current;
      if (!live.current || !set) return;
      if (p.title) set("title", p.title);
      if (p.description) set("description", p.description);
      if (p.icon) set("icon", p.icon);
      set("preview", "ok");
    }, () => { if (live.current) setProps.current?.("preview", "none"); });
  }, [canFetch, href, preview, title]);
  const iconURL = safeURL(icon);
  const content = <>
    {iconURL && !iconFailed
      ? <img src={iconURL} alt="" referrerPolicy="no-referrer" className="size-9 shrink-0 rounded-md border bg-surface object-contain p-1.5" onError={() => setIconFailed(true)} data-bookmark-icon />
      : <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent text-[15px] font-semibold text-primary">{(name ?? "W").slice(0, 1).toUpperCase()}</span>}
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[14px] font-medium text-foreground" data-bookmark-title>{title || name || url || "网页卡片"}</span>
      {description && <span className="line-clamp-1 block text-[12px] text-muted-foreground" data-bookmark-desc>{description}</span>}
      <span className="block truncate text-[12px] text-subtle">{url}</span>
    </span>
    {href && <span className="shrink-0 text-subtle">↗</span>}
  </>;
  const className = "my-2 flex w-full max-w-[560px] select-none items-center gap-3 rounded-lg border border-[#DEE0E3] px-3.5 py-3 no-underline dark:border-border";
  return href
    ? <a contentEditable={false} href={href} target="_blank" rel="noopener noreferrer" className={cn(className, "hover:bg-hover")} data-bookmark>{content}</a>
    : <div contentEditable={false} className={className} data-bookmark>{content}</div>;
}



/** 公式块：LaTeX 源码渲染视图，点击编辑源码。 */
function MathBlock({ src, onSource }: { src: string; onSource?: () => void }) {
  return (
    <div
      contentEditable={false}
      className={cn("my-2 select-none overflow-x-auto rounded-lg px-3 py-3 text-center text-[17px] italic leading-relaxed", onSource && "cursor-pointer hover:bg-hover")}
      onDoubleClick={onSource}
      data-math
      title={onSource ? "双击编辑公式" : undefined}
    >
      {src ? <MathView src={src} /> : <span className="not-italic text-subtle">{onSource ? "空公式——双击输入 LaTeX" : "空公式"}</span>}
    </div>
  );
}


/** 视频块：mp4/webm 源用原生播放器；源失效（404/格式不支持）自动回退链接卡片。 */
function VideoBlock({ url, name, disableFileDownloads = false }: { url?: string; name?: string; disableFileDownloads?: boolean }) {
  const [failed, setFailed] = useState(false);
  const href = safeURL(url);
  const native = !failed && href && /^https?:\/\//i.test(href) && /\.(mp4|webm|mov)(\?|$)/i.test(href);
  const content = <>
    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#E1EAFF] text-primary"><Play size={14} strokeWidth={1.7} /></span>
    <span className="min-w-0"><span className="block truncate text-[14px] font-medium text-foreground">{name || (!disableFileDownloads && url) || "视频链接"}</span><span className="block truncate text-[12px] text-subtle">{disableFileDownloads ? "当前不提供外部链接" : url}</span></span>
  </>;
  return (
    <div contentEditable={false} className="my-2 w-full max-w-[640px] overflow-hidden rounded-lg border" data-video>
      {native ? (
        <video src={href} controls controlsList={disableFileDownloads ? "nodownload" : undefined} onContextMenu={(event) => { if (disableFileDownloads) event.preventDefault(); }} className="aspect-video w-full bg-black" onError={() => setFailed(true)} />
      ) : href && !disableFileDownloads ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 px-3.5 py-3 no-underline hover:bg-hover">{content}</a>
      ) : (
        <div className="flex items-center gap-3 px-3.5 py-3">{content}</div>
      )}
    </div>
  );
}


/** 可在线预览的附件 mime：图片/PDF/纯文本类。 */
function isPreviewable(mime?: string): boolean {
  return !!mime && (mime.startsWith("image/") || mime === "application/pdf" || mime.startsWith("text/") || /^(application\/(json|xml|javascript|x-yaml|sql))$/.test(mime));
}
