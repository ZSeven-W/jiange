import { useLayoutEffect, useState, type RefObject } from "react";

/** UTF-16 offsets where each logical line of `text` starts. */
export function codeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** Find the text node + local offset for a UTF-16 offset inside `root`. */
function locate(root: HTMLElement, offset: number): { node: Text; local: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    if (offset < seen + len) return { node: n, local: offset - seen };
    seen += len;
  }
  return null;
}

/**
 * Measure the vertical position of each logical line start so numbers stay
 * aligned with soft-wrapped lines. Returns null when layout is unavailable.
 */
function measure(root: HTMLElement, starts: number[], lineHeight: number): number[] | null {
  const base = root.getBoundingClientRect();
  const tops: number[] = [];
  let any = false;
  for (const start of starts) {
    const at = locate(root, start);
    let top: number | null = null;
    if (at) {
      const range = document.createRange();
      range.setStart(at.node, at.local);
      range.setEnd(at.node, Math.min(at.local + 1, at.node.data.length));
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      if (rect && (rect.height > 0 || rect.top !== 0)) { top = rect.top - base.top; any = true; }
    }
    tops.push(top ?? (tops.length ? tops[tops.length - 1] + lineHeight : 0));
  }
  return any ? tops : null;
}

/** 飞书代码块左侧行号：按逻辑行编号，自动换行时与每行首个视觉行对齐。 */
export function CodeLineNumbers({ text, textRef, wrap }: { text: string; textRef: RefObject<HTMLElement | null>; wrap: boolean }) {
  const starts = codeLineStarts(text);
  const [tops, setTops] = useState<number[] | null>(null);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const run = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
      const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
      const next = measure(el, codeLineStarts(text), lh);
      setTops(next && next.map((t) => t - pad));
    };
    run();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(run);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, wrap, textRef]);
  return <div contentEditable={false} aria-hidden className="relative shrink-0 select-none pb-[26px] pt-0.5 text-right font-mono text-[14px] leading-[22px] text-[#8F959E]" style={{ minWidth: `${String(starts.length).length}ch` }} data-code-lines={starts.length}>
    {tops && tops.length === starts.length
      ? <>{starts.map((_, i) => <span key={i} className="absolute right-0" style={{ top: `calc(0.125rem + ${tops[i]}px)` }}>{i + 1}</span>)}<span className="invisible">{starts.length}</span></>
      : starts.map((_, i) => <div key={i}>{i + 1}</div>)}
  </div>;
}
