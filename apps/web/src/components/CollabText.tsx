import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { eqId, type Anchor, type OpId } from "@jiange/collab";
import { diff } from "@/lib/textdiff";
import { cpIndex, utf16Index, type Presence } from "@/lib/presence";
import type { SyncDoc } from "@/lib/useSyncDoc";
import { cn } from "@/lib/utils";

interface Props {
  readOnly?: boolean;
  sync: SyncDoc;
  block: OpId;
  me: Presence;
  placeholder?: string;
  singleLine?: boolean;
  className?: string;
  onLocalEdit?: (text: string) => void;
  onEnter?: () => void;
}

/**
 * A plain-text editor bound to one collaborative block. Local edits become
 * Fugue ops; remote edits keep the caret in place via anchors; remote carets
 * are drawn on a mirror layer that shares the textarea's text metrics.
 */
export function CollabText({ sync, block, me, placeholder, singleLine, className, onLocalEdit, onEnter, readOnly }: Props) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const shown = useRef("");
  const saved = useRef<{ a: Anchor; b: Anchor } | null>(null);
  const doc = sync.client.doc?.hasBlock(block) ? sync.client.doc : null;
  const text = doc ? doc.text(block) : "";

  // capture our selection as anchors right before remote ops are applied
  useEffect(
    () =>
      sync.onBeforeRemote(() => {
        const el = ta.current;
        const d = sync.client.doc;
        if (!el || !d?.hasBlock(block) || document.activeElement !== el) return;
        const v = el.value;
        saved.current = {
          a: d.anchorAt(block, cpIndex(v, el.selectionStart)),
          b: d.anchorAt(block, cpIndex(v, el.selectionEnd)),
        };
      }),
    [sync, block],
  );

  const autosize = useCallback(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el || el.value === text) {
      shown.current = text;
      autosize();
      return;
    }
    el.value = text;
    shown.current = text;
    const s = saved.current;
    const d = sync.client.doc;
    if (s && d?.hasBlock(block) && document.activeElement === el) {
      el.setSelectionRange(utf16Index(text, d.resolveAnchor(block, s.a)), utf16Index(text, d.resolveAnchor(block, s.b)));
    }
    saved.current = null;
    autosize();
  }, [text, block, sync, autosize]);

  const publishCursor = useCallback(() => {
    const el = ta.current;
    const d = sync.client.doc;
    if (!el || !d?.hasBlock(block)) return;
    const v = el.value;
    sync.client.setAwareness({
      ...me,
      cursor: {
        block,
        anchor: d.anchorAt(block, cpIndex(v, el.selectionEnd)),
        focus: d.anchorAt(block, cpIndex(v, el.selectionStart)),
      },
    } satisfies Presence);
  }, [sync, block, me]);

  const onInput = () => {
    const el = ta.current;
    const d = sync.client.doc;
    if (!el || !d?.hasBlock(block)) return;
    let next = el.value;
    if (singleLine && next.includes("\n")) {
      next = next.replace(/\n/g, "");
      el.value = next;
    }
    const ch = diff(shown.current, next);
    shown.current = next;
    if (!ch) return;
    const ops = [...(ch.remove ? d.deleteText(block, ch.index, ch.remove) : []), ch.insert ? d.insertText(block, ch.index, ch.insert) : null];
    sync.client.push(ops);
    autosize();
    publishCursor();
    onLocalEdit?.(next);
  };

  // remote carets in this block
  const carets = doc
    ? sync.peers
        .filter((p) => p.state.cursor && eqId(p.state.cursor.block, block))
        .map((p) => ({
          id: p.clientId,
          name: p.state.name,
          color: p.state.color,
          at: doc.resolveAnchor(block, p.state.cursor!.anchor),
        }))
        .sort((x, y) => x.at - y.at)
    : [];
  const cps = [...text];
  const pieces: React.ReactNode[] = [];
  let last = 0;
  for (const c of carets) {
    // keep the caret glued to the character before it so CJK line breaking can't separate them
    const glue = c.at > last ? cps[c.at - 1] : "";
    pieces.push(cps.slice(last, Math.max(last, c.at - 1)).join(""));
    pieces.push(
      <span key={c.id} className="whitespace-nowrap">
        {glue}
        <span className="relative inline-block w-0 align-baseline" data-peer={c.name}>
          <span className="absolute -left-px top-[-1.05em] h-[1.25em] w-[2px] rounded-full" style={{ background: c.color }} />
          <span
            className="absolute -left-px bottom-[1.05em] whitespace-nowrap rounded-[3px] rounded-bl-none px-1 py-px text-[11px] font-medium leading-[14px] text-white"
            style={{ background: c.color }}
          >
            {c.name}
          </span>
        </span>
      </span>,
    );
    last = c.at;
  }
  pieces.push(cps.slice(last).join("") + "\u200b");

  const shared: CSSProperties = {
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  };
  return (
    <div className={cn("relative", className)}>
      <div ref={mirror} aria-hidden className="pointer-events-none absolute inset-0 text-transparent" style={shared}>
        {pieces}
      </div>
      <textarea
        ref={ta}
        rows={1}
        defaultValue={text}
        placeholder={placeholder}
        spellCheck={false}
        disabled={!doc}
        readOnly={readOnly}
        onInput={onInput}
        onSelect={publishCursor}
        onFocus={publishCursor}
        onKeyDown={(e) => {
          if (singleLine && e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEnter?.();
          }
        }}
        className="relative block w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-subtle/70 disabled:cursor-wait"
        style={shared}
      />
    </div>
  );
}
