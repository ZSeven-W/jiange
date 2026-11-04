import { useMemo } from "react";
import { cn } from "@/lib/utils";

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
}

/** 从文档块列表提取标题大纲（h1-h6）。 */
export function outlineOf(blocks: { id: string; type: string; spans: { text: string }[] }[]): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const b of blocks) {
    if (!/^h[1-6]$/.test(b.type)) continue;
    const text = b.spans.map((s) => s.text).join("").trim();
    if (text) out.push({ id: b.id, level: Number(b.type[1]), text });
  }
  return out;
}

/** 飞书式目录面板：标题层级列表，点击滚动到对应块。 */
export function OutlinePanel({
  items,
  activeId,
  onJump,
  onClose,
}: {
  items: OutlineItem[];
  activeId: string | null;
  onJump: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="fixed inset-y-0 right-0 z-30 flex w-72 flex-col border-l bg-surface shadow-xl" data-outline-panel>
      <header className="flex h-[52px] shrink-0 items-center border-b px-4 text-[15px] font-semibold">
        目录
        <button className="ml-auto rounded p-1 text-subtle hover:bg-hover hover:text-foreground" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </header>
      <nav className="flex-1 overflow-y-auto p-2 text-[13px]" data-outline-list>
        {items.length === 0 && <p className="px-2 py-8 text-center text-subtle">在文档中使用标题即可生成目录</p>}
        {items.map((it) => (
          <button
            key={it.id}
            className={cn(
              "block w-full truncate rounded px-2 py-1.5 text-left hover:bg-hover",
              activeId === it.id ? "bg-accent font-medium text-accent-foreground" : "text-foreground",
            )}
            style={{ paddingLeft: 8 + (it.level - 1) * 14 }}
            onClick={() => onJump(it.id)}
            data-outline-item={it.id}
          >
            {it.text}
          </button>
        ))}
      </nav>
    </aside>
  );
}

/** 飞书式图片大图预览遮罩。 */
export function ImagePreview({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80" onClick={onClose} data-image-preview>
      <img src={src} alt={alt} className="max-h-[88vh] max-w-[92vw] rounded-lg object-contain shadow-2xl" />
      <button className="absolute right-4 top-4 rounded-full bg-white/10 px-3 py-1.5 text-[13px] text-white hover:bg-white/20" aria-label="关闭">
        ✕
      </button>
    </div>
  );
}

/** useOutline 的 useMemo 辅助保持纯函数即可；这里无需额外 hook。 */
export function useNothing() {
  return useMemo(() => null, []);
}
