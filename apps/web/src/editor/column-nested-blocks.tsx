import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { COLUMN_CHILD_BLOCK_CHOICES } from "./column-ops-commit";

export interface ColumnNestedBlockItem {
  id: string;
  type: string;
  props: Record<string, string>;
  text: string;
  number?: number;
}

const NESTED_TEXT_CLASS: Record<string, string> = {
  h1: "text-[22px] font-bold leading-snug",
  h2: "text-[18px] font-semibold leading-snug",
  h3: "text-[16px] font-semibold leading-snug",
  paragraph: "text-[15px] leading-7",
  bullet: "text-[15px] leading-7",
  ordered: "text-[15px] leading-7",
  todo: "text-[15px] leading-7",
  quote: "border-l-2 border-[#BBBFC4] pl-3 text-[15px] leading-7 text-muted-foreground",
  callout: "rounded-md border border-[#dee0e3] bg-[#f5f6f7] px-3 py-2 text-[14px] leading-6 dark:border-border dark:bg-muted/40",
  code: "rounded-md bg-[#f5f6f7] px-3 py-2 font-mono text-[13px] leading-6 dark:bg-[#23262a]",
};

export function ColumnNestedBlocks({
  columnId,
  blocks,
  canEdit,
  onAddBlock,
  onCommitText,
  onToggleTodo,
  onDeleteBlock,
}: {
  columnId: string;
  blocks: ColumnNestedBlockItem[];
  canEdit: boolean;
  onAddBlock?: (columnId: string, type: string) => void;
  onCommitText?: (blockId: string, text: string) => void;
  onToggleTodo?: (blockId: string) => void;
  onDeleteBlock?: (blockId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  return (
    <div className="mt-1 space-y-1.5" data-column-nested-list={columnId}>
      {blocks.map((nb) => {
        const checked = nb.props.checked === "true";
        return (
          <div
            key={nb.id}
            data-column-child-block={nb.id}
            data-column-child-type={nb.type}
            className="group/col-child relative flex items-start gap-1.5 rounded-[4px] pr-5"
          >
            {nb.type === "divider" ? (
              <hr className="my-2.5 h-px w-full border-0 bg-[#DEE0E3] dark:bg-border" />
            ) : (
              <div className="flex min-w-0 flex-1 items-start gap-1.5">
                {nb.type === "bullet" && (
                  <span className="mt-[10px] size-1.5 shrink-0 rounded-full bg-foreground/70" aria-hidden />
                )}
                {nb.type === "ordered" && (
                  <span className="shrink-0 text-[15px] leading-7 text-muted-foreground">{nb.number ?? 1}.</span>
                )}
                {nb.type === "todo" && (
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!canEdit}
                    onChange={() => onToggleTodo?.(nb.id)}
                    aria-label="切换待办状态"
                    className="mt-2 size-3.5 shrink-0 accent-primary"
                  />
                )}
                {nb.type === "callout" && (
                  <span className="mt-2 shrink-0 text-[14px]" aria-hidden>{nb.props.emoji || "💡"}</span>
                )}
                <div
                  contentEditable={canEdit}
                  suppressContentEditableWarning
                  data-column-child-editor={nb.id}
                  className={cn(
                    "min-h-7 min-w-0 flex-1 whitespace-pre-wrap break-words outline-none",
                    NESTED_TEXT_CLASS[nb.type] ?? NESTED_TEXT_CLASS.paragraph,
                    nb.type === "todo" && checked && "text-subtle line-through",
                  )}
                  onBlur={(event) => {
                    if (!canEdit || !onCommitText) return;
                    const next = event.currentTarget.innerText.replace(/\r\n/g, "\n");
                    if (next !== nb.text) onCommitText(nb.id, next);
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter" && !event.shiftKey && nb.type !== "code") {
                      event.preventDefault();
                      const next = event.currentTarget.innerText.replace(/\r\n/g, "\n");
                      if (next !== nb.text) onCommitText?.(nb.id, next);
                      onAddBlock?.(columnId, nb.type === "bullet" || nb.type === "todo" || nb.type === "ordered" ? nb.type : "paragraph");
                    }
                  }}
                >
                  {nb.text}
                </div>
              </div>
            )}
            {canEdit && onDeleteBlock && (
              <button
                type="button"
                aria-label="删除栏内内容块"
                title="删除此块"
                data-delete-column-child={nb.id}
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteBlock(nb.id);
                }}
                className="absolute right-0 top-1 grid size-5 place-items-center rounded text-subtle opacity-0 hover:bg-hover hover:text-destructive group-hover/col-child:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        );
      })}
      {canEdit && onAddBlock && (
        <div ref={menuRef} className="relative">
          <button
            type="button"
            data-add-column-block={columnId}
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-subtle opacity-0 transition-opacity hover:bg-hover hover:text-primary group-hover/col:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Plus size={12} />
            <span>添加块</span>
          </button>
          {menuOpen && (
            <div
              role="menu"
              aria-label="在分栏内添加内容块"
              data-add-column-block-menu={columnId}
              className="absolute left-0 top-7 z-30 grid w-44 grid-cols-2 gap-0.5 rounded-lg border border-[#dee0e3] bg-surface p-1 text-[12px] shadow-[0_6px_24px_rgba(31,35,41,0.14)]"
            >
              {COLUMN_CHILD_BLOCK_CHOICES.map((item) => (
                <button
                  key={item.type}
                  type="button"
                  role="menuitem"
                  data-add-column-block-type={item.type}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuOpen(false);
                    onAddBlock(columnId, item.type);
                  }}
                  className="flex h-7 items-center rounded px-2 text-left text-foreground hover:bg-hover"
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
