import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { eqId, idKey, Tx, UndoManager, type Doc, type OpId } from "@jiange/collab";
import type { Comment } from "@/lib/api";
import type { SyncDoc } from "@/lib/useSyncDoc";
import type { Presence } from "@/lib/presence";
import { cn } from "@/lib/utils";
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
  len,
  LIST_TYPES,
  markdownShortcut,
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
import { SlashMenu } from "./SlashMenu";
import { applyTableEdit, parseTableData } from "./model";
import { FormatToolbar } from "./FormatToolbar";
import { askText } from "@/components/ui/ask";
import { Copy, MessageCircle, Play } from "lucide-react";
import { TodoCheck } from "./menuIcons";
import { MathView } from "./MathView";
import { DiagramView } from "./DiagramView";
import { askArea } from "@/components/ui/ask";
import { AddIcon } from "@/components/FeishuIcons";
import { shouldRetryImage, type ImageFailure } from "./imageRetry";
import { captureCompositionSelection, resolveCompositionSelection, type CompositionAnchor } from "./compositionAnchor";
import { createColumn, requestColumnDeletion, safeColumnUndo } from "./columnSafety";
import { captureSlashInsertion, insertSlashBlock, safeSlashUndo, sourceUnchanged } from "./slashInsert";
import { insertUploadedFiles, uploadTargetUnchanged, validateUploadCommand } from "./uploadInsert";
import { clipboardBlocks } from "./clipboardPayload";
import type { SlashInsertion } from "./slashInsert";
import { commentSelection } from "./commentAnchor";
import { isSearchableBlockType, type FindMatch } from "./findReplace";

const CLIP_MIME = "application/x-jiange-blocks";
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

interface Props {
  sync: SyncDoc;
  readOnly?: boolean;
  /** Register a transaction from another document control with this editor's undo stack. */
  onUndoRegistrar?: (record: ExternalUndoRecorder | null) => void;
  /** Search results are an ephemeral view; they never alter the document. */
  findMatches?: readonly FindMatch[];
  activeFindMatch?: FindMatch | null;
  /** docs offered by the @ menu */
  docs?: MentionDoc[];
  /** workspace members offered by the @ menu（@人提及） */
  people?: { id: number; name: string }[];
  /** stores a file and returns its id; enables image/file blocks */
  upload?: (f: File) => Promise<Uploaded>;
  me: Presence;
  /** unresolved comments anchor-highlighted in the text */
  comments?: Comment[];
  /** thread currently open in the panel (stronger highlight) */
  activeThread?: number | null;
  /** called with the current selection's anchor when 评论 is clicked */
  onComment?: (anchor: { block: string; startChar: string; endChar: string; quote: string }) => void;
  /** user clicked an anchored range */
  onActivateThread?: (id: number | null) => void;
  /** 防复制下载：禁用复制/剪切 */
  onCopyBlock?: boolean;
  /** 点击图片 → 大图预览 */
  onPreviewImage?: (src: string, alt: string) => void;
  /** 公式块编辑器（默认 askText；返回 null 表示取消） */
  onMathSource?: (src: string) => Promise<string | null>;
  /** @人 提及插入（发通知用） */
  onMentionPerson?: (userId: number, name: string) => void;
}

/**
 * Jiange's self-written block editor. The DOM is a projection of the
 * collaborative Doc: every input is intercepted (beforeinput/keydown), turned
 * into Tx ops, and the view re-renders from the model. IME composition is
 * left to the browser and committed as one insert on compositionend.
 */
export function Editor({ sync, me, readOnly, onUndoRegistrar, findMatches = [], activeFindMatch = null, docs = [], people = [], upload, comments = [], activeThread = null, onComment, onActivateThread, onCopyBlock, onPreviewImage, onMathSource, onMentionPerson }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sel = useRef<Sel | null>(null);
  const composing = useRef<{ sel: Sel; anchor?: CompositionAnchor; snapshot?: ReturnType<Doc["richChars"]> } | null>(null);
  const blockedComposition = useRef<Sel | null>(null);
  const stored = useRef<Record<string, string | null> | null>(null);
  const um = useMemo(() => new UndoManager<Sel>(), []);
  const readOnlyRef = useRef(!!readOnly);
  readOnlyRef.current = !!readOnly;
  const commentAllowedRef = useRef(!!onComment);
  commentAllowedRef.current = !!onComment;
  const currentClient = useRef(sync.client);
  currentClient.current = sync.client;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [conflictDraft, setConflictDraft] = useState<{ text: string; message: string } | null>(null);
  const [columnNotice, setColumnNotice] = useState("");
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
  const [, force] = useState(0);
  const [remount, setRemount] = useState<Record<string, number>>({});
  const [slash, setSlash] = useState<{
    at: Pos;
    index: number;
    kind: "/" | "@";
    fromButton?: boolean;
    insertAfter?: OpId;
    buttonQuery?: string;
  } | null>(null);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const menuComposition = useRef<OpId | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingUpload = useRef<{ captured: SlashInsertion; client: SyncDoc["client"]; type: string; parent: OpId; cursor: Pos | null; boundaryIds?: OpId[] } | null>(null);
  const [toolbar, setToolbar] = useState<{ x: number; y: number } | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [touchActiveBlock, setTouchActiveBlock] = useState<string | null>(null);
  const [drag, setDrag] = useState<{
    b: OpId;
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
    const body = new Set(bodyBlocks(doc).map(idKey));
    const cached = new Map<string, { ids: OpId[]; positions: Map<string, number>; chars: ReturnType<Doc["richChars"]> }>();
    for (const match of findMatches) {
      const key = idKey(match.block);
      if (match.doc !== doc || !match.ids.length || !body.has(key) || !doc.hasBlock(match.block) || !isSearchableBlockType(doc.blockInfo(match.block).type)) continue;
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
    if (d.hasBlock(s.ab) && d.hasBlock(s.fb))
      sel.current = {
        a: { b: s.ab, o: d.resolveAnchor(s.ab, s.a) },
        f: { b: s.fb, o: d.resolveAnchor(s.fb, s.f) },
      };
  }, [sync.version, sync.client]);

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
    (fn: (tx: Tx, s: Sel) => Pos | Sel | void, tag?: string, preserveCreatedBlocks = false) => {
      const d = sync.client.doc,
        s = sel.current;
      if (!d || !s || readOnlyRef.current) return;
      // Cross-column selections cannot be represented as a root block range.
      // Never let a structural operation delete unrelated document blocks.
      if (!eqId(s.a.b, s.f.b) && (isColumnText(d, s.a.b) || isColumnText(d, s.f.b))) { setColumnNotice("暂不支持跨栏编辑，请在同一栏内选择内容。"); return; }
      const tx = new Tx(d);
      const r = fn(tx, s);
      const next: Sel | null = r ? ("a" in r ? r : { a: r, f: r }) : s;
      if (tx.ops.length) {
        um.record(preserveCreatedBlocks ? safeSlashUndo(tx) : tx, s, next, tag);
        sync.client.push(tx.ops);
      }
      sel.current = next;
      force((x) => x + 1);
      publish();
    },
    [sync.client, um, publish],
  );

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
      setSlash({ at, index: 0, kind: "/", fromButton: true, insertAfter: emptyParagraph ? undefined : b, buttonQuery: "" });
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
        if (marks) for (const [k, v] of Object.entries(marks)) tx.format(p.b, p.o, p.o + n, k, v);
        p = { b: p.b, o: p.o + n };
        const md = isColumnText(tx.doc, p.b) ? null : markdownShortcut(tx, p, [...text].pop() ?? "");
        if (md) {
          um.seal();
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
    if (!el || !ds || ds.rangeCount === 0 || !el.contains(ds.anchorNode) || !el.contains(ds.focusNode)) {
      if (!wrap.current?.contains(document.activeElement)) { setToolbar(null); setCommentError(null); }
      return;
    }
    const a = domToPos(el, ds.anchorNode!, ds.anchorOffset),
      f = domToPos(el, ds.focusNode!, ds.focusOffset);
    if (!a || !f) return;
    const prev = sel.current;
    if (!prev || !eqId(prev.a.b, a.b) || prev.a.o !== a.o || !eqId(prev.f.b, f.b) || prev.f.o !== f.o) setCommentError(null);
    if (prev && (!eqId(prev.f.b, f.b) || Math.abs(prev.f.o - f.o) > 1)) {
      um.seal();
      stored.current = null;
    }
    sel.current = { a, f };
    const activeKey = idKey(f.b);
    setTouchActiveBlock((current) => current === activeKey ? current : activeKey);
    publish();
    updateOverlays();
    // slash menu closes when the caret leaves its query
    setSlash((m) => {
      if (!m) return m;
      const d = sync.client.doc;
      if (!d || !eqId(m.at.b, f.b) || !collapsed(sel.current!)) return null;
      if (m.fromButton) return f.o === m.at.o ? m : null;
      if (f.o <= m.at.o) return null;
      const q = [...d.text(f.b)].slice(m.at.o, f.o).join("");
      return q.startsWith(m.kind) && !/\s/.test(q) && q.length <= 16 ? m : null;
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
    if (el && s && d && (document.activeElement === el || el.contains(document.activeElement)) && !composing.current) {
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
      if (readOnlyRef.current || e.inputType === "insertCompositionText" || composing.current) return;
      if (slashRef.current?.fromButton) {
        if (e.inputType === "insertText" || e.inputType === "insertReplacementText") {
          e.preventDefault();
          const value = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
          setSlash((m) => m?.fromButton ? { ...m, buttonQuery: ((m.buttonQuery ?? "") + value).slice(0, 32), index: 0 } : m);
          return;
        }
        if (e.inputType.startsWith("delete")) {
          e.preventDefault();
          setSlash((m) => m?.fromButton ? { ...m, buttonQuery: [...(m.buttonQuery ?? "")].slice(0, -1).join(""), index: 0 } : m);
          return;
        }
      }
      e.preventDefault();
      readSel();
      const s = sel.current,
        d = sync.client.doc;
      if (!s || !d) return;
      switch (e.inputType) {
        case "insertText":
        case "insertReplacementText": {
          const t = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
          if (!t) return;
          insertText(t);
          const end = sel.current?.f;
          if ((t === "/" || t === "@") && end && !isColumnText(d, end.b)) setSlash({ at: { b: end.b, o: Math.max(0, end.o - 1) }, index: 0, kind: t });
          else setSlash((cur) => (cur ? { ...cur, index: 0 } : cur)); // 过滤词变化 → 高亮回到第一项
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
      if (!collapsed(s)) return run((tx, s2) => deleteRange(tx, s2), "delete");
      const ranges = e.getTargetRanges();
      if (ranges.length) {
        const r = ranges[0];
        const a = domToPos(el, r.startContainer, r.startOffset),
          f = domToPos(el, r.endContainer, r.endOffset);
        if (a && f && !(eqId(a.b, f.b) && a.o === f.o)) {
          if (eqId(a.b, f.b)) return run((tx) => deleteRange(tx, { a, f }), "delete");
        }
      }
      const back = e.inputType.includes("Backward");
      const p = s.a;
      if (back && p.o === 0) return run((tx) => joinBackward(tx, p.b));
      if (!back && p.o === len(d, p.b)) return run((tx) => joinForward(tx, p.b));
      const step = e.inputType.includes("Word") ? wordLen(d.text(p.b), p.o, back) : 1;
      run(
        (tx) =>
          deleteRange(tx, {
            a: p,
            f: { b: p.b, o: back ? p.o - step : p.o + step },
          }),
        "delete",
      );
    };
    const onCompStart = (event: CompositionEvent) => {
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
      composing.current = { sel: s, anchor, snapshot: d.richChars(s.a.b) };
    };
    const onCompEnd = (e: CompositionEvent) => {
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
        if (e.data) setSlash((m) => m?.fromButton ? { ...m, buttonQuery: ((m.buttonQuery ?? "") + e.data).slice(0, 32), index: 0 } : m);
        return;
      }
      if (!c) return;
      const currentDoc = sync.client.doc;
      const selection = currentDoc && c.anchor ? resolveCompositionSelection(currentDoc, c.anchor) : null;
      if (!selection) {
        setRemount((m) => ({ ...m, [idKey(c.sel.a.b)]: (m[idKey(c.sel.a.b)] ?? 0) + 1 }));
        if (e.data) setConflictDraft({ text: e.data, message: "输入位置已被协作者修改或删除，内容未应用。请复制草稿后重试。" });
        return;
      }
      sel.current = selection;
      // throw away the browser's DOM mutations for this block and commit the text
      setRemount((m) => ({
        ...m,
        [idKey(c.sel.a.b)]: (m[idKey(c.sel.a.b)] ?? 0) + 1,
      }));
      if (e.data) insertText(e.data, "ime");
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
    const q = slash.fromButton ? (slash.buttonQuery ?? "") : [...doc.text(slash.at.b)].slice(slash.at.o + 1, sel.current.f.o).join("");
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
  }, [slash, doc, sync.version, sel.current, docs]);

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
        assets.push(await upload(f));
      }
    } catch {
      if (mounted.current) setColumnNotice("上传失败，原文未修改。请检查网络后重试。");
      return;
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

  const applySlash = async (it: MenuItem) => {
    if (readOnlyRef.current) return;
    const m = slash;
    setSlash(null);
    if (!m) return;
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
    if (it.id.startsWith("doc:")) {
      run((tx, s) => {
        tx.delete(m.at.b, m.at.o, s.f.o);
        const n = tx.insert(m.at.b, m.at.o, it.label);
        tx.format(m.at.b, m.at.o, m.at.o + n, "link", `#/doc/${it.id.slice(4)}`);
        tx.insert(m.at.b, m.at.o + n, " ");
        tx.format(m.at.b, m.at.o + n, m.at.o + n + 1, "link", null);
        return { b: m.at.b, o: m.at.o + n + 1 };
      });
      um.seal();
      return;
    }
    if (it.id.startsWith("user:")) {
      const rest = it.id.slice(5);
      const uid = Number(rest.split(":")[0]);
      const name = decodeURIComponent(rest.split(":").slice(1).join(":"));
      run((tx, s) => {
        tx.delete(m.at.b, m.at.o, s.f.o);
        const n = tx.insert(m.at.b, m.at.o, `@${name} `);
        tx.format(m.at.b, m.at.o, m.at.o + n - 1, "mention", String(uid));
        return { b: m.at.b, o: m.at.o + n };
      });
      um.seal();
      onMentionPerson?.(uid, name);
      return;
    }
    if (it.id === "image" || it.id === "file") {
      const originalDoc = sync.client.doc;
      const captured = originalDoc && captureSlashInsertion(originalDoc, m.at, sel.current, !!m.fromButton, m.insertAfter);
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
      const captured = originalDoc && captureSlashInsertion(originalDoc, m.at, sel.current, !!m.fromButton, m.insertAfter);
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
    run((tx, s) => {
      const b = targetBlock(tx);
      if (!b) return;
      if (!m.fromButton) tx.delete(m.at.b, m.at.o, s.f.o);
      const offset = m.fromButton ? 0 : m.at.o;
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
      if (it.id === "callout") {
        tx.setProp(b, "type", "callout");
        if (!tx.doc.blockInfo(b).props.emoji) tx.setProp(b, "emoji", "💡");
        return { b, o: offset };
      }
      if (it.id === "table") {
        const info = tx.doc.blockInfo(b);
        if (len(tx.doc, b) === 0 && !TEXTLESS.has(info.type)) {
          tx.setProp(b, "type", "table");
          tx.setProp(b, "tableData", JSON.stringify([["列 1", "列 2", "列 3"], ["", "", ""]]));
          const nb = tx.create("paragraph", b, info.parent);
          return { b: nb, o: 0 };
        }
        const tb = tx.create("table", b, info.parent, { tableData: JSON.stringify([["列 1", "列 2", "列 3"], ["", "", ""]]) });
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
    um.seal();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (readOnlyRef.current) return;
    if (e.nativeEvent.isComposing || composing.current) return;
    readSel();
    const mod = e.metaKey || e.ctrlKey;
    if (slash && e.key === "Escape") { e.preventDefault(); setSlash(null); return; }
    if (slash?.fromButton && (e.key === "Backspace" || e.key === "Delete")) {
      e.preventDefault();
      if (e.key === "Backspace") setSlash((m) => m?.fromButton ? { ...m, buttonQuery: [...(m.buttonQuery ?? "")].slice(0, -1).join(""), index: 0 } : m);
      return;
    }
    if (slash?.fromButton && e.key === "Tab") {
      e.preventDefault();
      if (slashItems.length) void applySlash(slashItems[Math.min(slash.index, slashItems.length - 1)]);
      return;
    }
    if (slash && !slashItems.length && e.key === "Enter") { e.preventDefault(); return; }
    if (slash && slashItems.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = slashItems.length;
        setSlash({
          ...slash,
          index: (slash.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n,
        });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        void applySlash(slashItems[Math.min(slash.index, slashItems.length - 1)]);
        return;
      }
    }
    const s = sel.current,
      d = sync.client.doc;
    if (!s || !d) return;
    if (!eqId(s.a.b, s.f.b) && (isColumnText(d, s.a.b) || isColumnText(d, s.f.b))) {
      if (!e.metaKey && !e.ctrlKey || e.key === "Backspace" || e.key === "Delete") e.preventDefault();
      if (e.key === "Backspace" || e.key === "Delete" || e.key.length === 1) setColumnNotice("暂不支持跨栏编辑，请在同一栏内选择内容。");
      return;
    }
    const k = e.key.toLowerCase();
    if (mod && k === "z") {
      e.preventDefault();
      return undo(e.shiftKey);
    }
    if (mod && k === "y") {
      e.preventDefault();
      return undo(true);
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
    if (!s || !d || collapsed(s)) return;
    if (selectionContainsColumns(d, s)) {
      e.preventDefault();
      setColumnNotice("暂不支持复制或剪切包含分栏的选区，请分别选择栏内内容。");
      return;
    }
    if (!eqId(s.a.b, s.f.b) && (isColumnText(d, s.a.b) || isColumnText(d, s.f.b))) { if (cut) { e.preventDefault(); setColumnNotice("暂不支持跨栏剪切，请在同一栏内选择内容。"); } return; }
    e.preventDefault();
    const clip = copyRange(d, s);
    e.clipboardData.setData("text/plain", clipText(clip));
    e.clipboardData.setData(CLIP_MIME, JSON.stringify(clip));
    if (cut) run((tx, s2) => deleteRange(tx, s2));
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (readOnlyRef.current) return;
    e.preventDefault();
    readSel();
    const files = [...e.clipboardData.files];
    const plain = e.clipboardData.getData("text/plain");
    const raw = e.clipboardData.getData(CLIP_MIME);
    if (slashRef.current?.fromButton) {
      if (files.length) { setColumnNotice("请先选择图片或附件命令，再选择文件。"); return; }
      if (plain) setSlash((m) => m?.fromButton ? { ...m, buttonQuery: ((m.buttonQuery ?? "") + plain).slice(0, 32), index: 0 } : m);
      else setColumnNotice("插入菜单中只能粘贴文字，请先选择命令或关闭菜单。");
      return;
    }
    const currentDoc = sync.client.doc;
    if (currentDoc && sel.current && isColumnText(currentDoc, sel.current.f.b)) {
      if (files.length) { setColumnNotice("暂不支持在分栏中粘贴图片或附件，请先将文件插入正文。"); return; }
      if (!plain) { setColumnNotice("剪贴板中没有可粘贴的文字，原内容已保留。"); return; }
      insertText(plain, "paste");
      um.seal();
      return;
    }
    if (files.length) {
      if (!upload || !sel.current) { setColumnNotice("当前无法上传附件，原内容已保留。"); return; }
      const d = sync.client.doc, selection = sel.current;
      if (!d || !collapsed(selection) || !d.hasBlock(selection.f.b)) { setColumnNotice("请先将光标移至段首或段尾再插入附件。"); return; }
      const length = len(d, selection.f.b), offset = selection.f.o;
      if (offset > 0 && offset < length) { setColumnNotice("暂不能安全拆分段落，请将光标移至段首或段尾再插入附件。"); return; }
      const info = d.blockInfo(selection.f.b);
      void insertFiles(files, { captured: { doc: d, anchor: selection.f.b, beforeAnchor: offset === 0, commandIds: null }, client: sync.client, type: info.type, parent: info.parent, cursor: { ...selection.f }, boundaryIds: d.visibleIds(selection.f.b) });
      return;
    }
    const clip = clipboardBlocks(raw, plain);
    if (!clip) { setColumnNotice("剪贴板中没有可粘贴的内容，原内容已保留。"); return; }
    run((tx, s) => {
      let at = collapsed(s) ? s.a : deleteRange(tx, s);
      if (isSourceBlock(tx.doc, at.b)) at = { b: tx.create("paragraph", at.b, tx.doc.blockInfo(at.b).parent), o: 0 };
      return pasteBlocks(tx, at, clip);
    });
    um.seal();
  };

  // ---- rendering
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

  const onDrop = (e: React.DragEvent) => {
    if (!drag || readOnlyRef.current) return;
    e.preventDefault();
    const d = sync.client.doc!;
    const { b, over, after } = drag;
    setDrag(null);
    if (!over || eqId(over, b)) return;
    const bs = bodyBlocks(d);
    const i = bs.findIndex((x) => eqId(x, over));
    const target = after ? over : i > 0 ? bs[i - 1] : null;
    if (target && eqId(target, b)) return;
    const s0 = sel.current;
    sel.current = s0 ?? { a: { b, o: 0 }, f: { b, o: 0 } };
    run((tx) => tx.move(b, target, d.blockInfo(b).parent));
  };

  const tb = sel.current && doc && !collapsed(sel.current) ? activeMarks(doc, sel.current) : {};
  const curType = sel.current && doc?.hasBlock(sel.current.f.b) ? doc.blockInfo(sel.current.f.b).type : "paragraph";
  const slashPos = slash && root.current && wrap.current ? caretRect(root.current, slash.insertAfter ? { b: slash.at.b, o: 0 } : slash.at) : null;
  const base = wrap.current?.getBoundingClientRect();
  useEffect(() => {
    if (readOnly) { setSlash(null); setToolbar(null); setDrag(null); pendingUpload.current = null; }
  }, [readOnly]);

  return (
    <div ref={wrap} className="relative" onDragOver={(e) => drag && e.preventDefault()} onDrop={onDrop}>
      {columnNotice && <div role="status" contentEditable={false} className="mb-3 flex items-center gap-3 rounded-md border bg-surface p-2 text-[13px] text-muted-foreground"><span>{columnNotice}</span><button type="button" className="ml-auto text-primary" onClick={() => setColumnNotice("")}>关闭</button></div>}
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
        className="outline-none"
        onKeyDown={onKeyDown}
        onCopy={(e) => (onCopyBlock ? e.preventDefault() : onCopy(e))}
        onCut={(e) => (onCopyBlock ? e.preventDefault() : onCopy(e, true))}
        onPaste={onPaste}
        onFocus={(event) => {
          // A nested editable column receives focus before the browser places
          // the clicked caret. Restoring a stale/root selection at that point
          // would redirect the first keystroke into another block.
          if (event.target !== event.currentTarget) { sel.current = null; return; }
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
            return (
              <Block
                key={k + ":" + (remount[k] ?? 0)}
                id={k}
                type={info.type}
                props={info.props}
                number={numbers.get(k)}
                spans={composing.current?.snapshot && eqId(composing.current.sel.a.b, b) ? composing.current.snapshot : doc.richChars(b)}
                findRanges={findRanges.get(k)}
                anchors={anchorFlags(doc, b, comments)}
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
                touchActive={touchActiveBlock === k || (!touchActiveBlock && blocks.length === 1)}
                onPreviewImage={onPreviewImage}
                onMathSource={readOnly ? undefined : editMathSource}
                onDiagramSource={readOnly ? undefined : editDiagramSource}
                childBlocks={doc.children(b).map((ch) => {
                  const ci = doc.blockInfo(ch);
                  return { id: idKey(ch), type: ci.type, props: ci.props, spans: composing.current?.snapshot && eqId(composing.current.sel.a.b, ch) ? composing.current.snapshot : doc.richChars(ch) };
                })}
                columnRemount={remount}
                syncVersion={sync.version}
                syncStatus={sync.status}
                onAddColumn={readOnly ? undefined : () => {
                  if (readOnlyRef.current) return;
                  const tx = new Tx(doc);
                  const children = doc.children(b);
                  createColumn(tx, b, children.at(-1) ?? null);
                  um.record(safeColumnUndo(tx), sel.current, sel.current, "column");
                  sync.client.push(tx.ops);
                  force((x) => x + 1);
                  publish();
                }}
                onDeleteColumn={readOnly ? undefined : (col) => {
                  if (readOnlyRef.current) return;
                  const cid = { client: Number(col.split(":")[0]), clock: Number(col.split(":")[1]) };
                  // Block tombstones cannot be undone with the same ID. A
                  // collaborator may still send edits to it after undo.
                  if (requestColumnDeletion(doc, cid) === "unsupported") setColumnNotice("暂不支持安全删除分栏：协作者可能仍在编辑，栏内容已保留。");
                }}
                onTableEdit={readOnly ? undefined : (r, c, v) => {
                  if (readOnlyRef.current) return;
                  const tx = new Tx(doc);
                  const info = doc.blockInfo(b);
                  const rows = applyTableEdit(parseTableData(info.props.tableData), r, c, v);
                  tx.setProp(b, "tableData", JSON.stringify(rows));
                  um.record(tx, sel.current, sel.current, "table");
                  sync.client.push(tx.ops);
                  force((x) => x + 1);
                  publish();
                }}
                dropLine={drag && drag.over && eqId(drag.over, b) ? (drag.after ? "after" : "before") : null}
                onToggle={readOnly ? undefined : () => toggleTodo(b)}
                onDragStart={readOnly ? undefined : () => setDrag({ b, over: null, after: false })}
                onDragOver={readOnly ? undefined : (after) => drag && setDrag({ ...drag, over: b, after })}
                onDragEnd={readOnly ? undefined : () => setDrag(null)}
                canCopy={!onCopyBlock}
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
      {(!readOnly || onComment) && toolbar && sel.current && (
        <FormatToolbar
          x={toolbar.x}
          y={toolbar.y}
          marks={tb}
          blockType={curType}
          readOnly={readOnly}
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
      {!readOnly && slash && slashPos && base && (
        <SlashMenu
          x={slashPos.left - base.left}
          y={slashPos.bottom - base.top + 6}
          query={slash.fromButton ? slash.buttonQuery : undefined}
          items={slashItems}
          index={Math.min(slash.index, Math.max(0, slashItems.length - 1))}
          onPick={applySlash}
          onHover={(i) => setSlash({ ...slash, index: i })}
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

const BLOCK_CLASS: Record<string, string> = {
  paragraph: "text-[16px] leading-[1.75] py-[3px]",
  h1: "text-[26px] font-semibold leading-[1.4] mt-5 mb-1",
  h2: "text-[22px] font-semibold leading-[1.4] mt-4 mb-0.5",
  h3: "text-[18px] font-semibold leading-[1.5] mt-3",
  h4: "text-[16px] font-semibold leading-[1.6] mt-3",
  h5: "text-[15px] font-semibold leading-[1.6] mt-3",
  h6: "text-[14px] font-semibold leading-[1.6] mt-3 text-muted-foreground",
  bullet: "text-[16px] leading-[1.75] py-[2px]",
  ordered: "text-[16px] leading-[1.75] py-[2px]",
  todo: "text-[16px] leading-[1.75] py-[2px]",
  quote: "text-[16px] leading-[1.75] py-[2px] border-l-[3px] border-border pl-3.5 text-muted-foreground my-1",
  code: "font-mono text-[14px] leading-[1.6] bg-sidebar rounded-md px-4 py-3 my-2",
};

interface BlockProps {
  /** columns 容器：渲染其子块（每栏一个） */
  childBlocks?: { id: string; type: string; props: Record<string, string>; spans: { ch: string; marks: Record<string, string> }[] }[];
  columnRemount?: Record<string, number>;
  syncVersion: number;
  syncStatus: SyncDoc["status"];
  onAddColumn?: () => void;
  onDeleteColumn?: (col: string) => void;
  anchors?: (number | null)[];
  findRanges?: { start: number; end: number; active: boolean }[];
  activeThread?: number | null;
  onAnchorClick?: (cid: number) => void;
  onSetProp?: (key: string, value: string) => void;
  onTableEdit?: (r: number, c: number, value: string) => void;
  /** 悬停 + 按钮：在当前块后插入空段落并聚焦 */
  onInsertAfter?: () => void;
  touchActive?: boolean;
  onPreviewImage?: (src: string, alt: string) => void;
  /** 公式块：请求编辑源码 */
  onMathSource?: (blockKey: string) => void;
  onDiagramSource?: (blockKey: string) => void;
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
}

function Block({ id, type, props, number, spans, childBlocks, columnRemount, syncVersion, syncStatus, onAddColumn, onDeleteColumn, anchors, findRanges, activeThread, onAnchorClick, onSetProp, onTableEdit, onInsertAfter, touchActive, onPreviewImage, onMathSource, onDiagramSource, dropLine, onToggle, onDragStart, onDragOver, onDragEnd, canCopy }: BlockProps) {
  const indent = Number(props.indent ?? "0");
  const checked = props.checked === "true";
  const threadIds = new Set<number>();
  for (const a of anchors ?? []) if (a != null) threadIds.add(a);
  const commentBadge = threadIds.size;
  const firstThread = anchors?.find((a) => a != null) ?? null;
  const highlighted = new Array<0 | 1 | 2>(spans.length).fill(0);
  for (const range of findRanges ?? []) {
    for (let i = Math.max(0, range.start); i < Math.min(spans.length, range.end); i++) highlighted[i] = range.active ? 2 : 1;
  }
  const runs: { text: string; marks: Record<string, string>; anchor: number | null; highlight: 0 | 1 | 2 }[] = [];
  for (let i = 0; i < spans.length; i++) {
    const c = spans[i];
    const anchor = anchors?.[i] ?? null;
    const last = runs[runs.length - 1];
    const highlight = highlighted[i];
    if (last && sameMarks(last.marks, c.marks) && last.anchor === anchor && last.highlight === highlight) last.text += c.ch;
    else runs.push({ text: c.ch, marks: c.marks, anchor, highlight });
  }
  const renderRun = (run: typeof runs[number]) => {
    if (!run.highlight) return <Run text={run.text} marks={run.marks} />;
    // Search highlight must remain visible over a user's existing background
    // mark; suppress it only in this projection, never in the CRDT model.
    const marks = { ...run.marks };
    delete marks.bg;
    return <mark data-find-match data-find-active={run.highlight === 2 ? "true" : undefined} className={cn("rounded-[2px] text-inherit", run.highlight === 2 ? "bg-[#ffb74d]" : "bg-[#ffe69b]")}><Run text={run.text} marks={marks} /></mark>;
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
      className={cn("group relative", type === "divider" ? "py-3" : type === "image" || type === "file" ? "" : (BLOCK_CLASS[type] ?? BLOCK_CLASS.paragraph))}
      style={{ marginLeft: indent * 24 }}
      onDragOver={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onDragOver?.(e.clientY > r.top + r.height / 2);
      }}
    >
      {dropLine && <div className={cn("pointer-events-none absolute inset-x-0 h-[2px] rounded bg-primary", dropLine === "before" ? "-top-px" : "-bottom-px")} />}
      <span className={cn("absolute -left-7 top-[2px] hidden items-center sm:-left-9 group-hover:flex group-focus-within:flex", touchActive && "[@media(hover:none)]:flex")} contentEditable={false}>
        {onInsertAfter && (
          <button
            className="relative grid size-7 place-items-center rounded-md border bg-surface text-subtle hover:bg-hover hover:text-foreground before:absolute before:-inset-1 before:content-['']"
            title="插入内容"
            aria-label="插入内容"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onInsertAfter}
            data-insert-after
          ><AddIcon className="size-[14px]" /></button>
        )}
        {onDragStart && <span draggable onDragStart={(e) => { e.dataTransfer.setData("text/plain", ""); e.dataTransfer.effectAllowed = "move"; onDragStart(); }} onDragEnd={onDragEnd} title="拖动以移动" className="absolute -left-4 grid h-6 w-4 cursor-grab place-items-center rounded text-[12px] leading-none text-subtle hover:bg-hover">⋮⋮</span>}
      </span>
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
        <div contentEditable={false} className="group/cols relative my-2 rounded-lg border p-2" data-columns>
          <div className="flex gap-2">
            {(childBlocks ?? []).map((ch) => (
              <div key={`${ch.id}:${columnRemount?.[ch.id] ?? 0}`} className="group/col min-w-0 flex-1 rounded-md bg-sidebar/40 p-2" data-column={ch.id} data-block={ch.id}>
                <div data-text contentEditable={!!onSetProp} suppressContentEditableWarning className="min-h-7 whitespace-pre-wrap break-words text-[15px] leading-7 outline-none">
                  {ch.spans.map((c, i) => (
                    <Run key={i} text={c.ch} marks={c.marks} />
                  ))}
                  {ch.spans.length === 0 && <br />}
                </div>
                {onDeleteColumn && <button
                  className="absolute -right-1 -top-1 hidden size-5 place-items-center rounded-full border bg-surface text-[11px] text-subtle hover:text-destructive group-hover/col:grid"
                  title="删除此栏"
                  onClick={() => onDeleteColumn?.(ch.id)}
                  data-del-column
                >
                  ✕
                </button>}
              </div>
            ))}
          </div>
          {onAddColumn && <button className="mt-1 px-1 text-[12px] text-subtle hover:text-primary" onClick={onAddColumn} data-add-column>
            + 添加一栏
          </button>}
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
      {type === "math" || type === "diagram" || type === "columns" ? null : type === "table" ? (
        <TableBlock data={props.tableData ?? ""} onEdit={(r, c, v) => onTableEdit?.(r, c, v)} onDelete={() => onSetProp?.("type", "paragraph")} readOnly={!onTableEdit} />
      ) : type === "divider" ? (
        <hr contentEditable={false} className="border-border" />
      ) : type === "image" ? (
        <InlineImage key={props.fileId} fileId={props.fileId} name={props.name} version={syncVersion} status={syncStatus} onPreviewImage={onPreviewImage} />
      ) : type === "video" ? (
        <VideoBlock url={props.url} name={props.name} />
      ) : type === "bookmark" ? (
        <a
          contentEditable={false}
          href={props.url}
          target="_blank"
          rel="noreferrer"
          className="my-2 flex w-full max-w-[520px] select-none items-center gap-3 rounded-lg border px-3.5 py-3 no-underline hover:bg-hover"
          data-bookmark
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent text-[15px] font-semibold text-primary">
            {(props.name ?? "W").slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium text-foreground">{props.name || props.url}</span>
            <span className="block truncate text-[12px] text-subtle">{props.url}</span>
          </span>
          <span className="shrink-0 text-subtle">↗</span>
        </a>
      ) : type === "file" ? (
        <div contentEditable={false} className="my-1 flex w-[360px] max-w-full select-none items-center gap-3 rounded-lg border px-3.5 py-2.5" data-file-card>
          <span className="grid size-8 place-items-center rounded-md bg-[#FFF3E8] text-[10px] font-bold text-[#FF8800]">{(props.name?.split(".").pop() ?? "FILE").slice(0, 4).toUpperCase()}</span>
          <span className="min-w-0">
            {canCopy ? <a href={`/api/files/${props.fileId}`} className="block truncate text-[14px] font-medium hover:underline">{props.name}</a> : <span className="block truncate text-[14px] font-medium">{props.name}</span>}
            <span className="block text-[12px] text-subtle">{canCopy ? fmtSize(Number(props.size ?? 0)) : "下载已关闭"}</span>
          </span>
        </div>
      ) : type === "code" ? (
        <div className="overflow-hidden rounded-lg border border-[#e5e7eb] dark:border-[#3c4043]">
          <div contentEditable={false} className="flex items-center gap-2 border-b border-[#e5e7eb] bg-[#f7f8fa] px-3 py-1.5 dark:border-[#3c4043] dark:bg-[#23262a]" data-code-header>
            <select
              value={props.lang ?? "plain"}
              disabled={!onSetProp}
              onChange={(e) => onSetProp?.("lang", e.target.value)}
              className="cursor-pointer rounded bg-transparent text-[12px] text-muted-foreground outline-none"
              title="代码语言"
              data-code-lang
            >
              {CODE_LANGS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {canCopy && <button
              className="ml-auto text-[12px] text-subtle hover:text-foreground"
              onClick={() => navigator.clipboard?.writeText(spans.map((c) => c.ch).join(""))}
              title="复制代码"
              data-code-copy
            >
              复制
            </button>}
          </div>
          <div data-text className="min-w-0 whitespace-pre-wrap break-words px-4 py-2.5 font-mono text-[13px] leading-6">
            {runs.length === 0 ? <br /> : runs.map((r, i) => <span key={i}>{renderRun(r)}</span>)}
          </div>
        </div>
      ) : type === "callout" ? (
        <div className={cn("flex gap-2 rounded-lg px-3.5 py-3", prefix && "flex gap-2")} style={{ background: CALLOUT_BG[Number(props.color ?? 0)] ?? CALLOUT_BG[0] }}>
          <span contentEditable={false} className="select-none pt-0.5 text-[15px] leading-6">
            <button
              className="rounded px-0.5 hover:bg-black/5"
              title="更换图标"
              disabled={!onSetProp}
              onClick={() => onSetProp?.("emoji", CALLOUT_EMOJI[(CALLOUT_EMOJI.indexOf(props.emoji ?? "💡") + 1) % CALLOUT_EMOJI.length])}
              data-callout-emoji
            >
              {props.emoji ?? "💡"}
            </button>
          </span>
          <div data-text className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {runs.length === 0 ? <br /> : runs.map((r, i) => <span key={i}>{renderRun(r)}</span>)}
          </div>
          {onSetProp && <span contentEditable={false} className="ml-auto flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-hover:opacity-100" data-callout-colors>
            {CALLOUT_BG.map((bg, i) => (
              <button
                key={i}
                className={cn("h-3.5 w-3.5 rounded-full border", Number(props.color ?? 0) === i && "ring-1 ring-primary ring-offset-1")}
                style={{ background: bg }}
                title={`颜色 ${i + 1}`}
                onClick={() => onSetProp?.("color", String(i))}
              />
            ))}
          </span>}
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
              runs.map((r, i) =>
                r.anchor != null ? (
                  <span
                    key={i}
                    className={cn("cursor-pointer border-b-2 border-[#F5B1E5] dark:bg-[#3a3121]", activeThread === r.anchor ? "bg-[#FBDC8D] dark:bg-[#4a3d1f]" : "bg-[#FFF3D6] dark:bg-[#3a3121]")}
                    onClick={() => onAnchorClick?.(r.anchor!)}
                    data-comment-anchor={r.anchor}
                  >
                    {renderRun(r)}
                  </span>
                ) : (
                  <span key={i}>{renderRun(r)}</span>
                ),
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const CODE_LANGS: [string, string][] = [
  ["plain", "纯文本"], ["typescript", "TypeScript"], ["javascript", "JavaScript"], ["go", "Go"],
  ["python", "Python"], ["rust", "Rust"], ["java", "Java"], ["sql", "SQL"], ["json", "JSON"],
  ["bash", "Bash"], ["css", "CSS"], ["html", "HTML"],
];
const CALLOUT_BG = ["#F5F6F7", "#E1EAFF", "#D9F5D6", "#FEEAD2", "#FFF4C9", "#F8DEF8", "#FDEBE1"];
const CALLOUT_EMOJI = ["💡", "📌", "⚠️", "✅", "🔥", "📝", "❓", "🎯"];

/** Simple table block: plain-text grid stored as JSON in a block prop. */
function TableBlock({ data, onEdit, onDelete, readOnly }: { data: string; onEdit: (r: number, c: number, v: string) => void; onDelete: () => void; readOnly: boolean }) {
  const rows = parseTableData(data);
  const size = (r: string[]) => Math.max(...r.map((c) => [...c].length));
  return (
    <div contentEditable={false} className="group/t my-2 w-fit max-w-full select-none overflow-x-auto rounded-lg border" data-table-block>
      <table className="border-collapse text-[13px]">
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className={ri > 0 && ri % 2 === 0 ? "bg-sidebar/40" : ""}>
              {row.map((cell, ci) => (
                <td key={ci} className={cn("min-w-[90px] border p-0 align-top", ri === 0 && "bg-sidebar/70 font-medium")} style={{ width: Math.max(90, Math.min(260, 18 + size(row) * 9)) }}>
                  {readOnly ? (
                    <span className="block px-2.5 py-1.5">{cell}</span>
                  ) : (
                    <input
                      value={cell}
                      onChange={(e) => onEdit(ri, ci, e.target.value)}
                      className="w-full bg-transparent px-2.5 py-1.5 outline-none focus:bg-surface"
                      data-table-cell={`${ri}:${ci}`}
                    />
                  )}
                </td>
              ))}
              {!readOnly && (
                <td className="w-6 border-l-0 p-0 align-middle">
                  <button className="hidden px-1 text-[11px] text-subtle hover:text-destructive group-hover/t:block" title="删除此行" onClick={() => onDeleteRow(ri)}>
                    ✕
                  </button>
                </td>
              )}
            </tr>
          ))}
          {!readOnly && (
            <tr>
              <td colSpan={rows[0].length + 1} className="border-t-0 p-0">
                <span className="flex gap-3 px-2 py-1 text-[12px] text-subtle">
                  <button className="hover:text-primary" onClick={() => onAddRow()} data-table-add-row>+ 行</button>
                  <button className="hover:text-primary" onClick={() => onAddCol()} data-table-add-col>+ 列</button>
                  <button className="hover:text-destructive" onClick={onDelete} data-table-del>删除表格</button>
                </span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  function onAddRow() {
    const width = rows[0].length;
    onEdit(-1, width, "");
  }
  function onAddCol() {
    onEdit(-2, rows[0].length, "");
  }
  function onDeleteRow(ri: number) {
    onEdit(-3, ri, "");
  }
}

function sameMarks(a: Record<string, string>, b: Record<string, string>) {
  const ka = Object.keys(a),
    kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/**
 * Per-char comment coverage for one block: flags[i] is the top-level thread
 * id covering char i (unresolved only; replies resolve with their parent).
 */
export function anchorFlags(doc: Doc, b: OpId, comments: Comment[]): (number | null)[] | undefined {
  const mine = comments.filter((c) => !c.resolved && !c.parentId && c.block === idKey(b));
  if (mine.length === 0) return undefined;
  const ids = doc.visibleIds(b);
  const flags: (number | null)[] = new Array(ids.length).fill(null);
  const key = (x: OpId) => idKey(x);
  for (const c of mine) {
    let si = -1;
    let ei = -1;
    for (let i = 0; i < ids.length; i++) {
      if (key(ids[i]) === c.startChar) si = i;
      if (key(ids[i]) === c.endChar) ei = i;
    }
    if (si < 0 || ei < 0) continue; // anchor deleted; panel still shows the quote
    for (let i = Math.min(si, ei); i <= Math.max(si, ei) && i < flags.length; i++) flags[i] = c.id;
  }
  return flags;
}

function Run({ text, marks }: { text: string; marks: Record<string, string> }) {
  const cls = cn(
    marks.bold && "font-semibold",
    marks.italic && "italic",
    (marks.underline || marks.strike) && [marks.underline && "underline", marks.strike && "line-through"],
    marks.code && "rounded-[4px] bg-[#F2F3F5] px-1 py-px font-mono text-[0.88em] text-[#D83931]",
    marks.link && "cursor-pointer text-primary underline-offset-2 hover:underline",
  );
  const style = marks.color || marks.bg ? { color: marks.color || undefined, background: marks.bg || undefined } : undefined;
  if (marks.link?.startsWith("#/doc/"))
    return (
      <a
        style={style}
        href={marks.link}
        data-mention
        className={cn(cls, "rounded px-1 py-px font-medium no-underline hover:underline", "bg-[#E1EAFF]")}
        onClick={(e) => {
          e.preventDefault();
          location.hash = marks.link;
        }}
      >
        {text}
      </a>
    );
  if (marks.mention)
    return (
      <span className="rounded bg-accent px-0.5 font-medium not-italic text-primary" title={`@成员 #${marks.mention}`}>
        {text}
      </span>
    );
  if (marks.math)
    return (
      <span className="mx-0.5 not-italic" title={`$${marks.math}$`}>
        <MathView src={marks.math} />
      </span>
    );
  if (marks.link)
    return (
      <a style={style} href={marks.link} className={cls} onClick={(e) => (e.metaKey || e.ctrlKey ? window.open(marks.link, "_blank", "noopener") : e.preventDefault())}>
        {text}
      </a>
    );
  return Object.keys(marks).length ? <span className={cls} style={style}>{text}</span> : <>{text}</>;
}

function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
}

function InlineImage({ fileId, name, version, status, onPreviewImage }: { fileId?: string; name?: string; version: number; status: SyncDoc["status"]; onPreviewImage?: (src: string, alt: string) => void }) {
  const [failure, setFailure] = useState<ImageFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [automatic, setAutomatic] = useState(0);
  const src = `/api/files/${fileId}`;
  useEffect(() => {
    if (!failure || !shouldRetryImage(failure, version, status, automatic)) return;
    setFailure(null);
    setAutomatic((n) => n + 1);
    setAttempt((n) => n + 1);
  }, [failure, version, status, automatic]);
  return <figure contentEditable={false} className="my-2 select-none">
    {failure ? <button type="button" className="rounded border px-3 py-2 text-[13px] text-subtle hover:bg-hover" onClick={() => { setFailure(null); setAttempt((n) => n + 1); }}>图片暂不可用，点击重试</button> : <img key={attempt} src={src} alt={name} className="max-h-[480px] max-w-full cursor-zoom-in rounded-lg border" draggable={false} onClick={() => onPreviewImage?.(src, name ?? "图片")} onError={() => setFailure({ version, status })} data-preview-image />}
  </figure>;
}


/** 公式块：LaTeX 源码渲染视图，点击编辑源码。 */
function MathBlock({ src, onSource }: { src: string; onSource?: () => void }) {
  return (
    <div
      contentEditable={false}
      className={cn("my-2 select-none overflow-x-auto rounded-lg px-3 py-2 text-[17px] italic leading-relaxed", onSource && "cursor-pointer hover:bg-hover")}
      onDoubleClick={onSource}
      data-math
      title={onSource ? "双击编辑公式" : undefined}
    >
      {src ? <MathView src={src} /> : <span className="not-italic text-subtle">{onSource ? "空公式——双击输入 LaTeX" : "空公式"}</span>}
    </div>
  );
}


/** 视频块：mp4/webm 源用原生播放器；源失效（404/格式不支持）自动回退链接卡片。 */
function VideoBlock({ url, name }: { url?: string; name?: string }) {
  const [failed, setFailed] = useState(false);
  const native = !failed && /^https?:\/\/.+/.test(url ?? "") && (url ?? "").match(/\.(mp4|webm|mov)(\?|$)/i);
  return (
    <div contentEditable={false} className="my-2 w-full max-w-[640px] overflow-hidden rounded-lg border" data-video>
      {native ? (
        <video src={url} controls className="aspect-video w-full bg-black" onError={() => setFailed(true)} />
      ) : (
        <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-3 px-3.5 py-3 no-underline hover:bg-hover">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#E1EAFF] text-primary">
            <Play size={14} strokeWidth={1.7} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-medium text-foreground">{name || url || "视频链接"}</span>
            <span className="block truncate text-[12px] text-subtle">{url}</span>
          </span>
        </a>
      )}
    </div>
  );
}
