import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { eqId, idKey, Tx, UndoManager, type Doc, type OpId } from "@jiange/collab";
import type { SyncDoc } from "@/lib/useSyncDoc";
import type { Presence } from "@/lib/presence";
import { cn } from "@/lib/utils";
import {
  activeMarks, bodyBlocks, clipText, collapsed, copyRange, deleteRange, joinBackward, joinForward, len, LIST_TYPES,
  markdownShortcut, normalize, parseText, pasteBlocks, setBlockType, splitBlock, toggleMark, type ClipBlock, type Pos, type Sel,
} from "./model";
import { blockEl, caretRect, domToPos, posToDom } from "./dom";
import { filterItems, type MenuItem } from "./pinyin";
import { SlashMenu } from "./SlashMenu";
import { FormatToolbar } from "./FormatToolbar";

const CLIP_MIME = "application/x-jiange-blocks";
const TYPE_FOR: Record<string, string> = { h1: "h1", h2: "h2", h3: "h3" };

interface Props {
  sync: SyncDoc;
  me: Presence;
}

/**
 * Jiange's self-written block editor. The DOM is a projection of the
 * collaborative Doc: every input is intercepted (beforeinput/keydown), turned
 * into Tx ops, and the view re-renders from the model. IME composition is
 * left to the browser and committed as one insert on compositionend.
 */
export function Editor({ sync, me }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sel = useRef<Sel | null>(null);
  const composing = useRef<{ sel: Sel } | null>(null);
  const stored = useRef<Record<string, string | null> | null>(null);
  const um = useMemo(() => new UndoManager<Sel>(), []);
  const [, force] = useState(0);
  const [remount, setRemount] = useState<Record<string, number>>({});
  const [slash, setSlash] = useState<{ at: Pos; index: number } | null>(null);
  const [toolbar, setToolbar] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ b: OpId; over: OpId | null; after: boolean } | null>(null);
  const [carets, setCarets] = useState<{ id: number; name: string; color: string; x: number; y: number; h: number }[]>([]);
  const doc = sync.client.doc;
  const blocks = doc ? bodyBlocks(doc) : [];

  // keep the caret anchored across remote ops
  const saved = useRef<{ a: ReturnType<Doc["anchorAt"]>; ab: OpId; f: ReturnType<Doc["anchorAt"]>; fb: OpId } | null>(null);
  useEffect(
    () =>
      sync.onBeforeRemote(() => {
        const d = sync.client.doc, s = sel.current;
        if (!d || !s || !d.hasBlock(s.a.b) || !d.hasBlock(s.f.b)) return;
        saved.current = { a: d.anchorAt(s.a.b, s.a.o), ab: s.a.b, f: d.anchorAt(s.f.b, s.f.o), fb: s.f.b };
      }),
    [sync],
  );
  useEffect(() => {
    const s = saved.current, d = sync.client.doc;
    if (!s || !d) return;
    saved.current = null;
    if (d.hasBlock(s.ab) && d.hasBlock(s.fb)) sel.current = { a: { b: s.ab, o: d.resolveAnchor(s.ab, s.a) }, f: { b: s.fb, o: d.resolveAnchor(s.fb, s.f) } };
  }, [sync.version, sync.client]);

  const publish = useCallback(() => {
    const d = sync.client.doc, s = sel.current;
    if (!d || !s || !d.hasBlock(s.f.b)) return;
    sync.client.setAwareness({ ...me, cursor: { block: s.f.b, anchor: d.anchorAt(s.f.b, s.f.o) } } satisfies Presence);
  }, [sync.client, me]);

  /** Runs an edit as one undoable transaction. */
  const run = useCallback(
    (fn: (tx: Tx, s: Sel) => Pos | Sel | void, tag?: string) => {
      const d = sync.client.doc, s = sel.current;
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
    const el = root.current, ds = document.getSelection();
    if (!el || !ds || ds.rangeCount === 0 || !el.contains(ds.anchorNode)) return;
    const a = domToPos(el, ds.anchorNode!, ds.anchorOffset), f = domToPos(el, ds.focusNode!, ds.focusOffset);
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
      return q.startsWith("/") && !/\s/.test(q) && q.length <= 16 ? m : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publish, um, sync.client]);

  useEffect(() => {
    const on = () => !composing.current && readSel();
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, [readSel]);

  const updateOverlays = () => {
    const el = root.current, w = wrap.current, d = sync.client.doc, s = sel.current;
    if (!el || !w || !d) return;
    const base = w.getBoundingClientRect();
    if (s && !collapsed(s) && (document.activeElement === el || w.contains(document.activeElement))) {
      const ds = document.getSelection();
      const r = ds && ds.rangeCount && el.contains(ds.anchorNode) ? ds.getRangeAt(0).getBoundingClientRect() : null;
      if (r && r.width + r.height > 0) {
        const t = { x: Math.round(r.left - base.left + r.width / 2), y: Math.round(r.top - base.top) };
        setToolbar((o) => (o && o.x === t.x && o.y === t.y ? o : t));
      }
    } else setToolbar((o) => (o ? null : o));
    const cs: { id: number; name: string; color: string; x: number; y: number; h: number }[] = [];
    for (const p of sync.peers) {
      const c = p.state.cursor;
      if (!c || !d.hasBlock(c.block) || !blockEl(el, c.block)) continue;
      const rect = caretRect(el, { b: c.block, o: d.resolveAnchor(c.block, c.anchor) });
      if (rect) cs.push({ id: p.clientId, name: p.state.name, color: p.state.color, x: Math.round(rect.left - base.left), y: Math.round(rect.top - base.top), h: Math.round(rect.height || 22) });
    }
    setCarets((o) => (JSON.stringify(o) === JSON.stringify(cs) ? o : cs));
  };

  // after every render: put the DOM selection where the model says
  useLayoutEffect(() => {
    const el = root.current, s = sel.current, d = sync.client.doc;
    if (el && s && d && document.activeElement === el && !composing.current) {
      const a = posToDom(el, s.a), f = posToDom(el, s.f);
      const ds = document.getSelection();
      if (a && f && ds) {
        const cur = ds.rangeCount ? { a: domToPos(el, ds.anchorNode!, ds.anchorOffset), f: domToPos(el, ds.focusNode!, ds.focusOffset) } : null;
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
      const s = sel.current, d = sync.client.doc;
      if (!s || !d) return;
      switch (e.inputType) {
        case "insertText":
        case "insertReplacementText": {
          const t = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
          if (!t) return;
          const at = collapsed(s) ? s.a : normalize(d, s).start;
          insertText(t);
          if (t === "/") setSlash({ at, index: 0 });
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
        const a = domToPos(el, r.startContainer, r.startOffset), f = domToPos(el, r.endContainer, r.endOffset);
        if (a && f && !(eqId(a.b, f.b) && a.o === f.o)) {
          if (eqId(a.b, f.b)) return run((tx) => deleteRange(tx, { a, f }), "delete");
        }
      }
      const back = e.inputType.includes("Backward");
      const p = s.a;
      if (back && p.o === 0) return run((tx) => joinBackward(tx, p.b));
      if (!back && p.o === len(d, p.b)) return run((tx) => joinForward(tx, p.b));
      const step = e.inputType.includes("Word") ? wordLen(d.text(p.b), p.o, back) : 1;
      run((tx) => deleteRange(tx, { a: p, f: { b: p.b, o: back ? p.o - step : p.o + step } }), "delete");
    };
    const onCompStart = () => {
      readSel();
      const s = sel.current, d = sync.client.doc;
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
      setRemount((m) => ({ ...m, [idKey(c.sel.a.b)]: (m[idKey(c.sel.a.b)] ?? 0) + 1 }));
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
    return filterItems(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slash, doc, sync.version, sel.current]);

  const applySlash = (it: MenuItem) => {
    const m = slash;
    setSlash(null);
    if (!m) return;
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
        setSlash({ ...slash, index: (slash.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        applySlash(slashItems[Math.min(slash.index, slashItems.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        setSlash(null);
        return;
      }
    }
    const s = sel.current, d = sync.client.doc;
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
    const markKeys: Record<string, string> = { b: "bold", i: "italic", u: "underline", e: "code" };
    if (mod && !e.shiftKey && markKeys[k]) {
      e.preventDefault();
      if (collapsed(s)) {
        const cur = stored.current ?? {};
        const on = activeMarksAt(d, s.a)[markKeys[k]] !== undefined;
        stored.current = { ...cur, [markKeys[k]]: (cur[markKeys[k]] !== undefined ? cur[markKeys[k]] === null : on) ? null : "true" };
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
    const s = sel.current, d = sync.client.doc;
    if (!s || !d || collapsed(s)) return;
    e.preventDefault();
    const clip = copyRange(d, s);
    e.clipboardData.setData("text/plain", clipText(clip));
    e.clipboardData.setData(CLIP_MIME, JSON.stringify(clip));
    if (cut) run((tx, s2) => deleteRange(tx, s2));
  };
  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
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
        contentEditable={!!doc}
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-multiline
        data-editor
        className="outline-none"
        onKeyDown={onKeyDown}
        onCopy={(e) => onCopy(e)}
        onCut={(e) => onCopy(e, true)}
        onPaste={onPaste}
        onFocus={() => {
          if (!sel.current && doc && blocks.length) sel.current = { a: { b: blocks[0], o: 0 }, f: { b: blocks[0], o: 0 } };
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
                dropLine={drag && drag.over && eqId(drag.over, b) ? (drag.after ? "after" : "before") : null}
                onToggle={() => toggleTodo(b)}
                onDragStart={() => setDrag({ b, over: null, after: false })}
                onDragOver={(after) => drag && setDrag({ ...drag, over: b, after })}
                onDragEnd={() => setDrag(null)}
              />
            );
          })}
      </div>
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
  let i = o, n = 0;
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
  bullet: "text-[16px] leading-[1.75] py-[2px]",
  ordered: "text-[16px] leading-[1.75] py-[2px]",
  todo: "text-[16px] leading-[1.75] py-[2px]",
  quote: "text-[16px] leading-[1.75] py-[2px] border-l-[3px] border-border pl-3.5 text-muted-foreground my-1",
  code: "font-mono text-[14px] leading-[1.6] bg-sidebar rounded-md px-4 py-3 my-2",
};

interface BlockProps {
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

function Block({ id, type, props, number, spans, dropLine, onToggle, onDragStart, onDragOver, onDragEnd }: BlockProps) {
  const indent = Number(props.indent ?? "0");
  const checked = props.checked === "true";
  const runs: { text: string; marks: Record<string, string> }[] = [];
  for (const c of spans) {
    const last = runs[runs.length - 1];
    if (last && sameMarks(last.marks, c.marks)) last.text += c.ch;
    else runs.push({ text: c.ch, marks: c.marks });
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
        className={cn("mt-[6px] grid size-4 place-items-center rounded-[3px] border text-[11px] leading-none text-white", checked ? "border-primary bg-primary" : "border-[#bbbfc4] bg-white")}
        aria-label="完成"
      >
        {checked ? "✓" : ""}
      </button>
    );
  return (
    <div
      data-block={id}
      data-type={type}
      className={cn("group relative", type === "divider" ? "py-3" : BLOCK_CLASS[type] ?? BLOCK_CLASS.paragraph)}
      style={{ marginLeft: indent * 24 }}
      onDragOver={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onDragOver(e.clientY > r.top + r.height / 2);
      }}
    >
      {dropLine && <div className={cn("pointer-events-none absolute inset-x-0 h-[2px] rounded bg-primary", dropLine === "before" ? "-top-px" : "-bottom-px")} />}
      <span
        contentEditable={false}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", "");
          e.dataTransfer.effectAllowed = "move";
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        title="拖动以移动"
        className="absolute -left-7 top-1/2 hidden h-6 w-5 -translate-y-1/2 cursor-grab select-none place-items-center rounded text-[12px] leading-none text-subtle hover:bg-hover group-hover:grid"
      >
        ⋮⋮
      </span>
      {type === "divider" ? (
        <hr contentEditable={false} className="border-border" />
      ) : (
        <div className={cn(prefix && "flex gap-2")}>
          {prefix && (
            <span contentEditable={false} className="flex min-w-[18px] justify-center">
              {prefix}
            </span>
          )}
          <div data-text className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", type === "todo" && checked && "text-subtle line-through")}>
            {runs.length === 0 ? <br /> : runs.map((r, i) => <Run key={i} {...r} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function sameMarks(a: Record<string, string>, b: Record<string, string>) {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

function Run({ text, marks }: { text: string; marks: Record<string, string> }) {
  const cls = cn(
    marks.bold && "font-semibold",
    marks.italic && "italic",
    (marks.underline || marks.strike) && [marks.underline && "underline", marks.strike && "line-through"],
    marks.code && "rounded-[4px] bg-[#F2F3F5] px-1 py-px font-mono text-[0.88em] text-[#D83931]",
    marks.link && "cursor-pointer text-primary underline-offset-2 hover:underline",
  );
  if (marks.link)
    return (
      <a href={marks.link} className={cls} onClick={(e) => (e.metaKey || e.ctrlKey ? window.open(marks.link, "_blank", "noopener") : e.preventDefault())}>
        {text}
      </a>
    );
  return Object.keys(marks).length ? <span className={cls}>{text}</span> : <>{text}</>;
}
