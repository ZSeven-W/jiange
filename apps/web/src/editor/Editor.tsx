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
  len,
  LIST_TYPES,
  markdownShortcut,
  normalize,
  TEXTLESS,
  parseText,
  pasteBlocks,
  setBlockType,
  splitBlock,
  toggleMark,
  type ClipBlock,
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

interface Props {
  sync: SyncDoc;
  readOnly?: boolean;
  /** docs offered by the @ menu */
  docs?: MentionDoc[];
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
}

/**
 * Jiange's self-written block editor. The DOM is a projection of the
 * collaborative Doc: every input is intercepted (beforeinput/keydown), turned
 * into Tx ops, and the view re-renders from the model. IME composition is
 * left to the browser and committed as one insert on compositionend.
 */
export function Editor({ sync, me, readOnly, docs = [], upload, comments = [], activeThread = null, onComment, onActivateThread, onCopyBlock, onPreviewImage, onMathSource }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sel = useRef<Sel | null>(null);
  const composing = useRef<{ sel: Sel } | null>(null);
  const stored = useRef<Record<string, string | null> | null>(null);
  const um = useMemo(() => new UndoManager<Sel>(), []);
  const [, force] = useState(0);
  const [remount, setRemount] = useState<Record<string, number>>({});
  const [slash, setSlash] = useState<{
    at: Pos;
    index: number;
    kind: "/" | "@";
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingUpload = useRef<{ b: OpId; kind: string } | null>(null);
  const [toolbar, setToolbar] = useState<{ x: number; y: number } | null>(null);
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
    (fn: (tx: Tx, s: Sel) => Pos | Sel | void, tag?: string) => {
      const d = sync.client.doc,
        s = sel.current;
      if (!d || !s) return;
      const tx = new Tx(d);
      const r = fn(tx, s);
      const next: Sel | null = r ? ("a" in r ? r : { a: r, f: r }) : s;
      if (tx.ops.length) {
        um.record(tx, s, next, tag);
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
      if (!d) return;
      const b = { client: Number(blockKey.split(":")[0]), clock: Number(blockKey.split(":")[1]) };
      if (!d.hasBlock(b)) return;
      const src0 = d.text(b);
      const askFn = onMathSource ?? ((s0: string) => askText("公式（LaTeX）", "x^2+y^2=z^2", s0));
      const src = await askFn(src0);
      if (src === null) return;
      if (!sel.current) sel.current = { a: { b, o: 0 }, f: { b, o: 0 } }; // run() 需要选区
      run((tx) => {
        const vis = tx.doc.visibleIds(b);
        if (vis.length) tx.delete(b, 0, vis.length);
        if (src) tx.insert(b, 0, src);
        return { b, o: src.length };
      });
      um.seal();
    },
    [sync.client, run, um, onMathSource],
  );

  /** 流程图块：双击弹多行编辑框改写 Mermaid 源码。 */
  const editDiagramSource = useCallback(
    async (blockKey: string) => {
      const d = sync.client.doc;
      if (!d) return;
      const b = { client: Number(blockKey.split(":")[0]), clock: Number(blockKey.split(":")[1]) };
      if (!d.hasBlock(b)) return;
      const src0 = d.text(b);
      const src = await askArea("流程图（Mermaid）", undefined, src0);
      if (src === null) return;
      if (!sel.current) sel.current = { a: { b, o: 0 }, f: { b, o: 0 } };
      run((tx) => {
        const vis = tx.doc.visibleIds(b);
        if (vis.length) tx.delete(b, 0, vis.length);
        if (src.trim()) tx.insert(b, 0, src.trim());
        return { b, o: src.trim().length };
      });
      um.seal();
    },
    [sync.client, run, um],
  );

  /** 在块 b 之后插入空段落并把光标移进去（飞书式 + 按钮）。 */
  const onInsertAfter = useCallback(
    (b: OpId) => {
      const d = sync.client.doc;
      if (!d || !d.hasBlock(b)) return;
      if (!sel.current) sel.current = { a: { b, o: 0 }, f: { b, o: 0 } };
      run((tx) => {
        const info = tx.doc.blockInfo(b);
        const nb = tx.create("paragraph", b, info.parent);
        return { b: nb, o: 0 };
      }, "insert-block");
      um.seal();
    },
    [sync.client, run, um],
  );

  const insertText = useCallback(
    (text: string, tag = "type") =>
      run((tx, s) => {
        let p = collapsed(s) ? s.a : deleteRange(tx, s);
        const marks = stored.current;
        const n = tx.insert(p.b, p.o, text);
        if (marks) for (const [k, v] of Object.entries(marks)) tx.format(p.b, p.o, p.o + n, k, v);
        p = { b: p.b, o: p.o + n };
        const md = markdownShortcut(tx, p, [...text].pop() ?? "");
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
      if (!d) return;
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
    if (!el || !ds || ds.rangeCount === 0 || !el.contains(ds.anchorNode)) return;
    const a = domToPos(el, ds.anchorNode!, ds.anchorOffset),
      f = domToPos(el, ds.focusNode!, ds.focusOffset);
    if (!a || !f) return;
    const prev = sel.current;
    if (prev && (!eqId(prev.f.b, f.b) || Math.abs(prev.f.o - f.o) > 1)) {
      um.seal();
      stored.current = null;
    }
    sel.current = { a, f };
    publish();
    updateOverlays();
    // slash menu closes when the caret leaves its query
    setSlash((m) => {
      if (!m) return m;
      const d = sync.client.doc;
      if (!d || !eqId(m.at.b, f.b) || f.o <= m.at.o || !collapsed(sel.current!)) return null;
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
    if (s && !collapsed(s) && (document.activeElement === el || w.contains(document.activeElement))) {
      const ds = document.getSelection();
      const r = ds && ds.rangeCount && el.contains(ds.anchorNode) ? ds.getRangeAt(0).getBoundingClientRect() : null;
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
    if (el && s && d && document.activeElement === el && !composing.current) {
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
      if (e.inputType === "insertCompositionText" || composing.current) return;
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
          const at = collapsed(s) ? s.a : normalize(d, s).start;
          insertText(t);
          if (t === "/" || t === "@") setSlash({ at, index: 0, kind: t });
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
    const onCompStart = () => {
      readSel();
      const s = sel.current,
        d = sync.client.doc;
      if (!s || !d) return;
      if (!collapsed(s)) run((tx, s2) => deleteRange(tx, s2));
      composing.current = { sel: sel.current! };
    };
    const onCompEnd = (e: CompositionEvent) => {
      const c = composing.current;
      composing.current = null;
      if (!c) return;
      sel.current = c.sel;
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
    const q = [...doc.text(slash.at.b)].slice(slash.at.o + 1, sel.current.f.o).join("");
    if (slash.kind === "@") {
      const ql = q.toLowerCase();
      return docs
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
    }
    return filterItems(q).filter((it) => upload || (it.id !== "image" && it.id !== "file"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slash, doc, sync.version, sel.current, docs]);

  /** Uploads files and inserts image/file blocks after block b. */
  const insertFiles = async (files: File[], b: OpId, replace = false) => {
    if (!upload) return;
    for (const f of files) {
      const r = await upload(f);
      const type = r.mime.startsWith("image/") && r.mime !== "image/svg+xml" ? "image" : "file";
      const d = sync.client.doc;
      if (!d || !d.hasBlock(b)) return;
      if (!sel.current) sel.current = { a: { b, o: 0 }, f: { b, o: 0 } };
      run((tx) => {
        const info = tx.doc.blockInfo(b);
        const props = {
          fileId: String(r.id),
          name: r.name,
          mime: r.mime,
          size: String(r.size),
        };
        let nb: OpId;
        if (replace && len(tx.doc, b) === 0 && !TEXTLESS.has(info.type)) {
          tx.setProp(b, "type", type);
          for (const [k, v] of Object.entries(props)) tx.setProp(b, k, v);
          nb = b;
        } else nb = tx.create(type, b, info.parent, props);
        replace = false;
        b = nb;
        const p = tx.create("paragraph", nb, info.parent);
        return { b: p, o: 0 };
      });
      um.seal();
    }
  };

  const applySlash = async (it: MenuItem) => {
    const m = slash;
    setSlash(null);
    if (!m) return;
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
    if (it.id === "image" || it.id === "file") {
      const s0 = sel.current;
      if (s0) run((tx) => void tx.delete(m.at.b, m.at.o, s0.f.o));
      pendingUpload.current = { b: m.at.b, kind: it.id };
      if (fileInput.current) {
        fileInput.current.accept = it.id === "image" ? "image/*" : "";
        fileInput.current.click();
      }
      return;
    }
    if (it.id === "math") {
      const src = await askText("公式（LaTeX）", "例如 \\frac{a}{b} 或 x^2 + y^2 = z^2");
      if (!src || !src.trim()) return;
      run((tx) => {
        const vis = tx.doc.visibleIds(m.at.b);
        if (vis.length) tx.delete(m.at.b, 0, vis.length);
        tx.setProp(m.at.b, "type", "math");
        tx.insert(m.at.b, 0, src.trim());
        return { b: m.at.b, o: src.trim().length };
      });
      um.seal();
      return;
    }
    if (it.id === "diagram") {
      const src = await askArea("流程图（Mermaid）", "graph TD\n  A[开始] --> B{条件}\n  B -->|是| C[处理]\n  B -->|否| D[结束]");
      if (!src || !src.trim()) return;
      run((tx) => {
        const vis = tx.doc.visibleIds(m.at.b);
        if (vis.length) tx.delete(m.at.b, 0, vis.length);
        tx.setProp(m.at.b, "type", "diagram");
        tx.insert(m.at.b, 0, src.trim());
        return { b: m.at.b, o: src.trim().length };
      });
      um.seal();
      return;
    }
    if (it.id === "video" || it.id === "bookmark") {
      const url = await askText(it.id === "video" ? "插入视频" : "插入网页卡片", "https://…");
      if (!url) return;
      run((tx) => {
        // 清掉 "/shipin" 之类的命令文本再插块
        const vis = tx.doc.visibleIds(m.at.b);
        if (vis.length) tx.delete(m.at.b, 0, vis.length);
        const info = tx.doc.blockInfo(m.at.b);
        const props: Record<string, string> = { url };
        if (it.id === "bookmark") {
          let host = url;
          try {
            host = new URL(url).hostname;
          } catch {
            /* keep raw */
          }
          props.name = host;
        }
        tx.setProp(m.at.b, "type", it.id);
        for (const [k, v] of Object.entries(props)) tx.setProp(m.at.b, k, v);
        const nb = tx.create("paragraph", m.at.b, info.parent);
        return { b: nb, o: 0 };
      });
      um.seal();
      return;
    }
    run((tx, s) => {
      tx.delete(m.at.b, m.at.o, s.f.o);
      const b = m.at.b;
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
        return { b, o: m.at.o };
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
        let cb: OpId;
        if (len(tx.doc, b) === 0 && !TEXTLESS.has(info.type)) {
          tx.setProp(b, "type", "columns");
          cb = b;
        } else {
          cb = tx.create("columns", b, info.parent);
        }
        const c1 = tx.create("paragraph", null, cb);
        void c1;
        const c2 = tx.create("paragraph", null, cb);
        void c2;
        const nb = tx.create("paragraph", cb, info.parent);
        return { b: nb, o: 0 };
      }
      tx.setProp(b, "type", TYPE_FOR[it.id] ?? it.id);
      return { b, o: m.at.o };
    });
    um.seal();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || composing.current) return;
    readSel();
    const mod = e.metaKey || e.ctrlKey;
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
      if (e.key === "Escape") {
        setSlash(null);
        return;
      }
    }
    const s = sel.current,
      d = sync.client.doc;
    if (!s || !d) return;
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
    const s = sel.current,
      d = sync.client.doc;
    if (!s || !d || collapsed(s)) return;
    e.preventDefault();
    const clip = copyRange(d, s);
    e.clipboardData.setData("text/plain", clipText(clip));
    e.clipboardData.setData(CLIP_MIME, JSON.stringify(clip));
    if (cut) run((tx, s2) => deleteRange(tx, s2));
  };
  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const files = [...e.clipboardData.files];
    if (files.length && upload && sel.current) {
      void insertFiles(files, sel.current.f.b, true);
      return;
    }
    const raw = e.clipboardData.getData(CLIP_MIME);
    let clip: ClipBlock[];
    try {
      clip = raw ? JSON.parse(raw) : parseText(e.clipboardData.getData("text/plain"));
    } catch {
      clip = parseText(e.clipboardData.getData("text/plain"));
    }
    run((tx, s) => pasteBlocks(tx, collapsed(s) ? s.a : deleteRange(tx, s), clip));
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
    if (!d) return;
    const tx = new Tx(d);
    tx.setProp(b, "checked", d.blockInfo(b).props.checked === "true" ? "" : "true");
    um.record(tx, sel.current, sel.current);
    sync.client.push(tx.ops);
    force((x) => x + 1);
  };

  const onDrop = (e: React.DragEvent) => {
    if (!drag) return;
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
  const slashPos = slash && root.current && wrap.current ? caretRect(root.current, slash.at) : null;
  const base = wrap.current?.getBoundingClientRect();

  return (
    <div ref={wrap} className="relative" onDragOver={(e) => drag && e.preventDefault()} onDrop={onDrop}>
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
        onFocus={() => {
          if (!sel.current && doc && blocks.length)
            sel.current = {
              a: { b: blocks[0], o: 0 },
              f: { b: blocks[0], o: 0 },
            };
        }}
        onBlur={(e) => !wrap.current?.contains(e.relatedTarget as Node) && setToolbar(null)}
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
                spans={doc.richChars(b)}
                anchors={anchorFlags(doc, b, comments)}
                activeThread={activeThread}
                onAnchorClick={(cid) => onActivateThread?.(cid)}
                onSetProp={(key, value) => {
                  const tx = new Tx(doc);
                  tx.setProp(b, key, value);
                  um.record(tx, sel.current, sel.current, "prop");
                  sync.client.push(tx.ops);
                  force((x) => x + 1);
                  publish();
                }}
                onInsertAfter={onInsertAfter ? () => onInsertAfter(b) : undefined}
                onPreviewImage={onPreviewImage}
                onMathSource={editMathSource}
                onDiagramSource={editDiagramSource}
                childBlocks={doc.children(b).map((ch) => {
                  const ci = doc.blockInfo(ch);
                  return { id: idKey(ch), type: ci.type, props: ci.props, spans: doc.richChars(ch) };
                })}
                onAddColumn={() => {
                  const tx = new Tx(doc);
                  tx.create("paragraph", null, b);
                  um.record(tx, sel.current, sel.current, "column");
                  sync.client.push(tx.ops);
                  force((x) => x + 1);
                  publish();
                }}
                onDeleteColumn={(col) => {
                  const tx = new Tx(doc);
                  const cid = { client: Number(col.split(":")[0]), clock: Number(col.split(":")[1]) };
                  if (doc.hasBlock(cid)) tx.deleteBlock(cid);
                  um.record(tx, sel.current, sel.current, "column");
                  sync.client.push(tx.ops);
                  force((x) => x + 1);
                  publish();
                }}
                onTableEdit={(r, c, v) => {
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
                onToggle={() => toggleTodo(b)}
                onDragStart={() => setDrag({ b, over: null, after: false })}
                onDragOver={(after) => drag && setDrag({ ...drag, over: b, after })}
                onDragEnd={() => setDrag(null)}
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
          if (p && files.length) void insertFiles(files, p.b, true);
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
      {toolbar && sel.current && (
        <FormatToolbar
          x={toolbar.x}
          y={toolbar.y}
          marks={tb}
          blockType={curType}
          onMark={(key, value) => run((tx, s) => toggleMark(tx, s, key, value))}
          onLink={(url) => run((tx, s) => toggleMark(tx, s, "link", url))}
          onType={(t) => run((tx, s) => setBlockType(tx, s, t))}
          onComment={onComment ? () => {
            const s = sel.current;
            if (!doc || !s) return;
            const a = doc.visibleIds(s.a.b);
            const endB = doc.visibleIds(s.f.b);
            const sameBlock = eqId(s.a.b, s.f.b);
            const startChar = a[Math.min(s.a.o, a.length - 1)];
            const endChar = endB[sameBlock ? Math.max(0, Math.min(s.f.o, endB.length) - 1) : endB.length - 1];
            const text = doc
              .richChars(s.a.b)
              .slice(sameBlock ? Math.min(s.a.o, s.f.o) : s.a.o, sameBlock ? Math.max(s.a.o, s.f.o) : undefined)
              .map((c) => c.ch)
              .join("");
            onComment({
              block: idKey(s.a.b),
              startChar: idKey(startChar),
              endChar: idKey(endChar),
              quote: text.slice(0, 200),
            });
          } : undefined}
        />
      )}
      {slash && slashPos && base && (
        <SlashMenu
          x={slashPos.left - base.left}
          y={slashPos.bottom - base.top + 6}
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
  onAddColumn?: () => void;
  onDeleteColumn?: (col: string) => void;
  anchors?: (number | null)[];
  activeThread?: number | null;
  onAnchorClick?: (cid: number) => void;
  onSetProp?: (key: string, value: string) => void;
  onTableEdit?: (r: number, c: number, value: string) => void;
  /** 悬停 + 按钮：在当前块后插入空段落并聚焦 */
  onInsertAfter?: () => void;
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
  onToggle: () => void;
  onDragStart: () => void;
  onDragOver: (after: boolean) => void;
  onDragEnd: () => void;
}

function Block({ id, type, props, number, spans, childBlocks, onAddColumn, onDeleteColumn, anchors, activeThread, onAnchorClick, onSetProp, onTableEdit, onInsertAfter, onPreviewImage, onMathSource, onDiagramSource, dropLine, onToggle, onDragStart, onDragOver, onDragEnd }: BlockProps) {
  const indent = Number(props.indent ?? "0");
  const checked = props.checked === "true";
  const threadIds = new Set<number>();
  for (const a of anchors ?? []) if (a != null) threadIds.add(a);
  const commentBadge = threadIds.size;
  const firstThread = anchors?.find((a) => a != null) ?? null;
  const runs: { text: string; marks: Record<string, string>; anchor: number | null }[] = [];
  for (let i = 0; i < spans.length; i++) {
    const c = spans[i];
    const anchor = anchors?.[i] ?? null;
    const last = runs[runs.length - 1];
    if (last && sameMarks(last.marks, c.marks) && last.anchor === anchor) last.text += c.ch;
    else runs.push({ text: c.ch, marks: c.marks, anchor });
  }
  let prefix: ReactNode = null;
  if (type === "bullet") prefix = <span className="select-none text-primary">{["•", "◦", "▪"][indent % 3]}</span>;
  if (type === "ordered") prefix = <span className="select-none tabular-nums text-primary">{number}.</span>;
  if (type === "todo")
    prefix = (
      <button
        contentEditable={false}
        onMouseDown={(e) => {
          e.preventDefault();
          onToggle();
        }}
        className={cn("mt-[5px]", checked ? "text-primary" : "text-[#bbbfc4]")}
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
        onDragOver(e.clientY > r.top + r.height / 2);
      }}
    >
      {dropLine && <div className={cn("pointer-events-none absolute inset-x-0 h-[2px] rounded bg-primary", dropLine === "before" ? "-top-px" : "-bottom-px")} />}
      <span className="absolute -left-7 top-1/2 hidden -translate-y-1/2 flex-col items-center group-hover:flex" contentEditable={false}>
        {onInsertAfter && (
          <button
            className="grid h-5 w-5 place-items-center rounded text-[14px] leading-none text-subtle hover:bg-hover hover:text-foreground"
            title="在此处插入内容"
            onClick={onInsertAfter}
            data-insert-after
          >
            +
          </button>
        )}
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", "");
            e.dataTransfer.effectAllowed = "move";
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          title="拖动以移动"
          className="grid h-5 w-5 cursor-grab place-items-center rounded text-[12px] leading-none text-subtle hover:bg-hover"
        >
          ⋮⋮
        </span>
      </span>
      {type === "diagram" ? (
        <div
          contentEditable={false}
          className={cn("my-2 select-none overflow-x-auto rounded-lg bg-surface py-3", onDiagramSource && "cursor-pointer hover:bg-hover")}
          onDoubleClick={() => onDiagramSource?.(id)}
          data-diagram
          title="双击编辑流程图"
        >
          {spans.length ? <DiagramView src={spans.map((c) => c.ch).join("")} /> : <span className="text-[13px] text-subtle">空流程图——双击输入 Mermaid</span>}
        </div>
      ) : type === "math" ? (
        <MathBlock src={spans.map((c) => c.ch).join("")} onSource={onMathSource ? () => onMathSource(id) : undefined} />
      ) : type === "columns" ? (
        <div contentEditable={false} className="group/cols relative my-2 rounded-lg border p-2" data-columns>
          <div className="flex gap-2">
            {(childBlocks ?? []).map((ch) => (
              <div key={ch.id} className="group/col min-w-0 flex-1 rounded-md bg-sidebar/40 p-2" data-column={ch.id}>
                <div data-text className="whitespace-pre-wrap break-words text-[15px] leading-7">
                  {ch.spans.map((c, i) => (
                    <Run key={i} text={c.ch} marks={c.marks} />
                  ))}
                  {ch.spans.length === 0 && <span className="text-subtle">空栏</span>}
                </div>
                <button
                  className="absolute -right-1 -top-1 hidden size-5 place-items-center rounded-full border bg-surface text-[11px] text-subtle hover:text-destructive group-hover/col:grid"
                  title="删除此栏"
                  onClick={() => onDeleteColumn?.(ch.id)}
                  data-del-column
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button className="mt-1 px-1 text-[12px] text-subtle hover:text-primary" onClick={() => onAddColumn?.()} data-add-column>
            + 添加一栏
          </button>
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
      {type === "table" ? (
        <TableBlock data={props.tableData ?? ""} onEdit={(r, c, v) => onTableEdit?.(r, c, v)} onDelete={() => onSetProp?.("type", "paragraph")} readOnly={!onTableEdit} />
      ) : type === "divider" ? (
        <hr contentEditable={false} className="border-border" />
      ) : type === "image" ? (
        <figure contentEditable={false} className="my-2 select-none">
          <img
            src={`/api/files/${props.fileId}`}
            alt={props.name}
            className="max-h-[480px] max-w-full cursor-zoom-in rounded-lg border"
            draggable={false}
            onClick={() => onPreviewImage?.(`/api/files/${props.fileId}`, props.name ?? "图片")}
            data-preview-image
          />
        </figure>
      ) : type === "video" ? (
        <div contentEditable={false} className="my-2 w-full max-w-[640px] overflow-hidden rounded-lg border" data-video>
          {/^https?:\/\/.+/.test(props.url ?? "") && (props.url ?? "").match(/\.(mp4|webm|mov)(\?|$)/i) ? (
            <video src={props.url} controls className="aspect-video w-full bg-black" />
          ) : (
            <a href={props.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 px-3.5 py-3 hover:bg-hover">
              <span className="grid size-8 place-items-center rounded-md bg-[#E1EAFF] text-primary"><Play size={14} strokeWidth={1.7} /></span>
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-medium">{props.name || props.url}</span>
                <span className="block truncate text-[12px] text-subtle">{props.url}</span>
              </span>
            </a>
          )}
        </div>
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
        <a contentEditable={false} href={`/api/files/${props.fileId}`} className="my-1 flex w-[360px] select-none items-center gap-3 rounded-lg border px-3.5 py-2.5 hover:bg-hover" data-file-card>
          <span className="grid size-8 place-items-center rounded-md bg-[#FFF3E8] text-[10px] font-bold text-[#FF8800]">{(props.name?.split(".").pop() ?? "FILE").slice(0, 4).toUpperCase()}</span>
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-medium">{props.name}</span>
            <span className="block text-[12px] text-subtle">{fmtSize(Number(props.size ?? 0))}</span>
          </span>
        </a>
      ) : type === "code" ? (
        <div className="overflow-hidden rounded-lg border border-[#e5e7eb] dark:border-[#3c4043]">
          <div contentEditable={false} className="flex items-center gap-2 border-b border-[#e5e7eb] bg-[#f7f8fa] px-3 py-1.5 dark:border-[#3c4043] dark:bg-[#23262a]" data-code-header>
            <select
              value={props.lang ?? "plain"}
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
            <button
              className="ml-auto text-[12px] text-subtle hover:text-foreground"
              onClick={() => navigator.clipboard?.writeText(spans.map((c) => c.ch).join(""))}
              title="复制代码"
              data-code-copy
            >
              复制
            </button>
          </div>
          <div data-text className="min-w-0 whitespace-pre-wrap break-words px-4 py-2.5 font-mono text-[13px] leading-6">
            {runs.length === 0 ? <br /> : runs.map((r, i) => <Run key={i} text={r.text} marks={r.marks} />)}
          </div>
        </div>
      ) : type === "callout" ? (
        <div className={cn("flex gap-2 rounded-lg px-3.5 py-3", prefix && "flex gap-2")} style={{ background: CALLOUT_BG[Number(props.color ?? 0)] ?? CALLOUT_BG[0] }}>
          <span contentEditable={false} className="select-none pt-0.5 text-[15px] leading-6">
            <button
              className="rounded px-0.5 hover:bg-black/5"
              title="更换图标"
              onClick={() => onSetProp?.("emoji", CALLOUT_EMOJI[(CALLOUT_EMOJI.indexOf(props.emoji ?? "💡") + 1) % CALLOUT_EMOJI.length])}
              data-callout-emoji
            >
              {props.emoji ?? "💡"}
            </button>
          </span>
          <div data-text className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {runs.length === 0 ? <br /> : runs.map((r, i) => <Run key={i} text={r.text} marks={r.marks} />)}
          </div>
          <span contentEditable={false} className="ml-auto flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-hover:opacity-100" data-callout-colors>
            {CALLOUT_BG.map((bg, i) => (
              <button
                key={i}
                className={cn("h-3.5 w-3.5 rounded-full border", Number(props.color ?? 0) === i && "ring-1 ring-primary ring-offset-1")}
                style={{ background: bg }}
                title={`颜色 ${i + 1}`}
                onClick={() => onSetProp?.("color", String(i))}
              />
            ))}
          </span>
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
                    <Run text={r.text} marks={r.marks} />
                  </span>
                ) : (
                  <Run key={i} text={r.text} marks={r.marks} />
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
  if (marks.link?.startsWith("#/doc/"))
    return (
      <a
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
  if (marks.link)
    return (
      <a href={marks.link} className={cls} onClick={(e) => (e.metaKey || e.ctrlKey ? window.open(marks.link, "_blank", "noopener") : e.preventDefault())}>
        {text}
      </a>
    );
  return Object.keys(marks).length ? <span className={cls}>{text}</span> : <>{text}</>;
}

function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
}


/** 公式块：LaTeX 源码渲染视图，点击编辑源码。 */
function MathBlock({ src, onSource }: { src: string; onSource?: () => void }) {
  return (
    <div
      contentEditable={false}
      className={cn("my-2 select-none overflow-x-auto rounded-lg px-3 py-2 text-[17px] italic leading-relaxed", onSource && "cursor-pointer hover:bg-hover")}
      onDoubleClick={onSource}
      data-math
      title="双击编辑公式"
    >
      {src ? <MathView src={src} /> : <span className="not-italic text-subtle">空公式——点击输入 LaTeX</span>}
    </div>
  );
}
