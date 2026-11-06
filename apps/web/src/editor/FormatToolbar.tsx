import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Baseline, Bold, ChevronDown, Code2, Highlighter, Italic, Link2, MessageSquarePlus, Strikethrough, Underline } from "lucide-react";

const TYPES: [string, string][] = [["paragraph", "正文"], ["h1", "一级标题"], ["h2", "二级标题"], ["h3", "三级标题"], ["bullet", "无序列表"], ["ordered", "有序列表"], ["todo", "待办"], ["quote", "引用"], ["code", "代码块"]];
const MARKS = [
  { key: "bold", label: "加粗", Icon: Bold },
  { key: "italic", label: "斜体", Icon: Italic },
  { key: "underline", label: "下划线", Icon: Underline },
  { key: "strike", label: "删除线", Icon: Strikethrough },
  { key: "code", label: "行内代码", Icon: Code2 },
] as const;

/** 飞书风格文本色板：文字色（上排）与背景高亮（下排同色浅版）。 */
const PALETTE = ["#212121", "#F54A45", "#FF8800", "#FFC60A", "#00B42A", "#3370FF", "#7B61FF", "#E63995"];

export function FormatToolbar({ x, y, marks, blockType, onMark, onLink, onType, onComment, readOnly, commentError }: {
  x: number; y: number; marks: Record<string, string>; blockType: string;
  onMark: (key: string, value?: string) => void; onLink: (url: string) => void; onType: (t: string) => void;
  onComment?: () => void;
  readOnly?: boolean;
  commentError?: string | null;
}) {
  const [link, setLink] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const typeMenuRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState<"color" | "bg" | null>(null);
  const [menu, setMenu] = useState(false);
  const [placement, setPlacement] = useState<{ left: number; top: number; maxWidth: number } | null>(null);

  // A fixed toolbar escapes the editor's scrolling clip. visualViewport also
  // tracks the area above a mobile keyboard and pinch-zoom offsets.
  useLayoutEffect(() => {
    const place = () => {
      const toolbar = toolbarRef.current;
      const parent = toolbar?.parentElement;
      if (!toolbar || !parent) return;
      const viewport = window.visualViewport;
      const leftBound = viewport?.offsetLeft ?? 0;
      const topBound = viewport?.offsetTop ?? 0;
      const rightBound = leftBound + (viewport?.width ?? window.innerWidth);
      const bottomBound = topBound + (viewport?.height ?? window.innerHeight);
      const maxWidth = Math.max(1, rightBound - leftBound - 16);
      // Set the width cap before measuring so wrapped toolbars have their real height.
      toolbar.style.maxWidth = `${maxWidth}px`;
      const parentRect = parent.getBoundingClientRect();
      const rect = toolbar.getBoundingClientRect();
      const anchorX = parentRect.left + x;
      const anchorY = parentRect.top + y;
      const left = Math.max(leftBound + 8, Math.min(anchorX - rect.width / 2, rightBound - rect.width - 8));
      const above = anchorY - rect.height - 8;
      const below = anchorY + 28;
      const preferredTop = above >= topBound + 8 ? above : below + rect.height <= bottomBound - 8 ? below : above;
      const top = Math.max(topBound + 8, Math.min(preferredTop, bottomBound - rect.height - 8));
      setPlacement((previous) => previous && previous.left === left && previous.top === top && previous.maxWidth === maxWidth ? previous : { left, top, maxWidth });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [x, y, link, blockType, onComment, readOnly, commentError]);

  // The type and color popovers remain descendants (so editor selection is
  // retained) but flip/clamp to the visible viewport and scroll if necessary.
  useLayoutEffect(() => {
    const fit = (element: HTMLDivElement | null) => {
      if (!element) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const right = left + (viewport?.width ?? window.innerWidth);
      const bottom = top + (viewport?.height ?? window.innerHeight);
      element.style.transform = "";
      element.style.maxHeight = `${Math.max(1, bottom - top - 16)}px`;
      element.style.overflowY = "auto";
      const rect = element.getBoundingClientRect();
      const dx = rect.left < left + 8 ? left + 8 - rect.left : rect.right > right - 8 ? right - 8 - rect.right : 0;
      let dy = 0;
      if (rect.bottom > bottom - 8) {
        const flipped = -rect.height - 40;
        dy = rect.top + flipped >= top + 8 ? flipped : bottom - 8 - rect.bottom;
      }
      if (rect.top + dy < top + 8) dy = top + 8 - rect.top;
      element.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const update = () => { fit(typeMenuRef.current); fit(paletteRef.current); };
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [palette, menu, placement]);
  const label = TYPES.find(([t]) => t === blockType)?.[1] ?? "正文";
  return (
    <div
      ref={toolbarRef}
      data-format-toolbar
      className="fixed z-30 flex min-h-10 w-max flex-wrap items-center gap-0.5 rounded-lg border bg-surface px-1.5 py-1 text-foreground shadow-[0_4px_16px_rgba(31,35,41,0.16)]"
      style={placement ? { left: placement.left, top: placement.top, maxWidth: placement.maxWidth } : { left: 0, top: 0, visibility: "hidden" }}
      onMouseDown={(e) => (e.target as HTMLElement).tagName !== "INPUT" && e.preventDefault()}
    >
      {!readOnly && (link !== null ? (
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (link.trim()) onLink(link.trim()); setLink(null); }}>
          <input autoFocus value={link} onChange={(e) => setLink(e.target.value)} placeholder="粘贴或输入链接" className="h-8 w-56 max-w-[calc(100vw-96px)] rounded border px-2 text-base outline-none focus:border-primary sm:h-7 sm:text-[13px]" />
          <button className="h-7 rounded bg-primary px-2.5 text-[13px] text-white">确定</button>
        </form>
      ) : (
        <>
          <div className="relative">
            <button className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 text-[13px] hover:bg-hover" onClick={() => setMenu((m) => !m)}>
              {label} <ChevronDown size={12} className="text-subtle" />
            </button>
            {menu && (
              <div ref={typeMenuRef} className="absolute left-0 top-8 z-40 w-32 rounded-lg border bg-surface p-1 shadow-lg">
                {TYPES.map(([t, l]) => (
                  <button key={t} className={cn("block w-full rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-hover", t === blockType && "text-primary")} onClick={() => { onType(t); setMenu(false); }}>
                    {l}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="mx-1 h-4 w-px bg-border" />
          {MARKS.map(({ key, label: markLabel, Icon }) => (
            <button key={key} type="button" title={markLabel} aria-label={markLabel} aria-pressed={!!marks[key]} onClick={() => onMark(key)} className={cn("grid size-7 shrink-0 place-items-center rounded hover:bg-hover", marks[key] && "bg-accent text-primary")}>
              <Icon size={15} strokeWidth={1.8} />
            </button>
          ))}
          <button title="链接" onClick={() => (marks.link ? onMark("link", marks.link) : setLink(""))} className={cn("grid h-7 min-w-7 place-items-center rounded px-1.5 text-[13px] hover:bg-hover", marks.link && "bg-accent text-primary")}>
            <Link2 size={14} strokeWidth={1.7} />
          </button>
          <span className="relative flex">
            <button
              title="文字颜色"
              onClick={() => setPalette((p) => (p === "color" ? null : "color"))}
              className={cn("grid h-7 min-w-7 place-items-center rounded px-1 hover:bg-hover", marks.color && "bg-accent")}
              data-color-btn
            >
              <Baseline size={14} strokeWidth={1.7} />
              <span className="h-[3px] w-3.5 rounded-sm" style={{ background: marks.color ?? "#3370FF" }} />
            </button>
            <button
              title="背景高亮"
              onClick={() => setPalette((p) => (p === "bg" ? null : "bg"))}
              className={cn("grid h-7 min-w-7 place-items-center rounded px-1 hover:bg-hover", marks.bg && "bg-accent")}
              data-bg-btn
            >
              <Highlighter size={14} strokeWidth={1.7} />
            </button>
            {palette && (
              <div ref={paletteRef} className="absolute left-0 top-9 z-40 w-[184px] rounded-lg border bg-surface p-2 shadow-lg" data-color-pop>
                <div className="mb-1 px-1 text-[11px] text-subtle">{palette === "color" ? "文字颜色" : "背景高亮"}</div>
                <div className="grid grid-cols-4 gap-1">
                  {PALETTE.map((c) => (
                    <button
                      key={c}
                      className={cn("grid h-7 place-items-center rounded hover:ring-1 hover:ring-primary", marks[palette] === c && "ring-2 ring-primary")}
                      style={{ background: palette === "bg" ? `${c}33` : undefined }}
                      onClick={() => {
                        onMark(palette, marks[palette] === c ? undefined : c);
                        setPalette(null);
                      }}
                      title={c}
                    >
                      <span style={{ color: c }} className="text-[13px] font-medium">
                        A
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  className="mt-1.5 block w-full rounded px-2 py-1 text-left text-[12px] text-muted-foreground hover:bg-hover"
                  onClick={() => {
                    onMark(palette, ""); // 空串 = 清除
                    setPalette(null);
                  }}
                  data-clear-color
                >
                  清除{palette === "color" ? "文字颜色" : "背景高亮"}
                </button>
              </div>
            )}
          </span>
        </>
      ))}
      {onComment && (
        <button className="mx-0.5 grid h-7 w-7 place-items-center rounded hover:bg-hover" title="评论" aria-label="评论" onClick={onComment} data-comment-btn>
          <MessageSquarePlus size={15} strokeWidth={1.7} />
        </button>
      )}
      {commentError && <span role="alert" className="max-w-52 px-2 text-[12px] text-destructive">{commentError}</span>}
    </div>
  );
}
