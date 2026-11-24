import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Network, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { MindPaints, MindTopic } from "./mindmap";
import {
  priorityBadgeMeta,
  progressWedgePath,
  type MindBadges,
  type MindBoundaries,
  type MindSummaries,
} from "./whiteboard-extras";

const BRANCH_COLORS = ["#3370ff", "#2ea121", "#ff8800", "#722ed1", "#d83931", "#14a3a3"] as const;

export interface MindMapOutlineViewProps {
  topics: readonly MindTopic[];
  collapsed?: ReadonlySet<string>;
  paints?: MindPaints;
  badges?: MindBadges;
  boundaries?: MindBoundaries;
  summaries?: MindSummaries;
  selectedId?: string | null;
  readOnly?: boolean;
  onSelect?: (id: string) => void;
  onToggleFold?: (id: string) => void;
  onUpdateTitle?: (id: string, text: string) => void;
  onAddChild?: (parentId: string) => string | void;
  onAddSibling?: (topicId: string) => string | void;
  onDelete?: (id: string) => void;
  onSwitchToCanvas?: () => void;
}

export interface OutlineRow {
  topic: MindTopic;
  depth: number;
  branchColor: string;
  childCount: number;
  folded: boolean;
}

export function buildOutlineRows(
  topics: readonly MindTopic[],
  collapsed: ReadonlySet<string> = new Set(),
  paints: MindPaints = {},
): OutlineRow[] {
  const children = new Map<string, MindTopic[]>();
  const roots: MindTopic[] = [];
  for (const topic of topics) {
    if (topic.parent === null) {
      roots.push(topic);
    } else {
      const list = children.get(topic.parent);
      if (list) list.push(topic);
      else children.set(topic.parent, [topic]);
    }
  }
  const sortTopics = (a: MindTopic, b: MindTopic) => a.order - b.order || a.id.localeCompare(b.id);
  roots.sort(sortTopics);
  for (const list of children.values()) list.sort(sortTopics);

  const out: OutlineRow[] = [];
  const seen = new Set<string>();
  const visit = (topic: MindTopic, depth: number, inheritedColor: string) => {
    if (seen.has(topic.id) || depth > 32) return;
    seen.add(topic.id);
    const kids = children.get(topic.id) ?? [];
    const folded = collapsed.has(topic.id);
    const color = paints[topic.id]?.stroke ?? inheritedColor;
    out.push({ topic, depth, branchColor: color, childCount: kids.length, folded });
    if (!folded) {
      kids.forEach((child, idx) => {
        const nextColor =
          depth === 0
            ? (paints[child.id]?.stroke ?? BRANCH_COLORS[idx % BRANCH_COLORS.length])
            : color;
        visit(child, depth + 1, nextColor);
      });
    }
  };
  roots.forEach((root) => visit(root, 0, paints[root.id]?.stroke ?? "#3370ff"));
  return out;
}

export type OutlineKeyAction = "add-sibling" | "add-child" | "delete" | null;

export function resolveOutlineKeyAction(
  key: string,
  topic: MindTopic,
  opts: { shiftKey?: boolean; isComposing?: boolean } = {},
): OutlineKeyAction {
  if (opts.isComposing) return null;
  if (key === "Enter") return topic.parent === null ? "add-child" : "add-sibling";
  if (key === "Tab" && !opts.shiftKey) return "add-child";
  if (key === "Backspace" && topic.text === "" && topic.parent !== null) return "delete";
  return null;
}

export function MindMapOutlineView({
  topics,
  collapsed = new Set(),
  paints = {},
  badges = {},
  boundaries = {},
  summaries = {},
  selectedId = null,
  readOnly = false,
  onSelect,
  onToggleFold,
  onUpdateTitle,
  onAddChild,
  onAddSibling,
  onDelete,
  onSwitchToCanvas,
}: MindMapOutlineViewProps) {
  const { t } = useI18n();
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  useEffect(() => {
    if (!pendingFocusId) return;
    const el = inputRefs.current.get(pendingFocusId);
    if (el) {
      el.focus();
      el.select();
      setPendingFocusId(null);
    }
  }, [pendingFocusId, topics]);

  const rows = useMemo(() => buildOutlineRows(topics, collapsed, paints), [topics, collapsed, paints]);

  const triggerAddChild = (parentId: string) => {
    if (readOnly || !onAddChild) return;
    const createdId = onAddChild(parentId);
    if (typeof createdId === "string" && createdId) setPendingFocusId(createdId);
  };

  const triggerAddSibling = (topic: MindTopic) => {
    if (readOnly) return;
    if (topic.parent === null) {
      triggerAddChild(topic.id);
      return;
    }
    const createdId = onAddSibling?.(topic.id);
    if (typeof createdId === "string" && createdId) setPendingFocusId(createdId);
  };

  return (
    <div
      data-mindmap-outline
      onPointerDown={(e) => e.stopPropagation()}
      className="flex h-full w-full flex-col overflow-hidden bg-surface"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[#DEE0E3] bg-[#F8F9FA] px-5 py-2.5 dark:border-border dark:bg-hover/40">
        <div className="flex items-center gap-2.5">
          <span className="text-[14px] font-semibold text-foreground">{t("大纲视图")}</span>
          <span className="rounded-full bg-[#eef3fe] px-2 py-0.5 text-[11px] font-medium text-[#3370ff]">
            {topics.length} {t("个主题")}
          </span>
          {!readOnly && (
            <span className="hidden text-[12px] text-subtle sm:inline">
              {t("Enter 添加同级 · Tab 添加子主题")}
            </span>
          )}
        </div>
        {onSwitchToCanvas && (
          <button
            type="button"
            data-outline-back-canvas
            onClick={onSwitchToCanvas}
            className="flex h-7 items-center gap-1.5 rounded-md border border-[#DEE0E3] bg-surface px-2.5 text-[12px] font-medium text-foreground hover:bg-hover dark:border-border"
          >
            <Network size={13} className="text-[#3370ff]" />
            <span>{t("导图视图")}</span>
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {rows.length === 0 ? (
          <div className="grid h-40 place-items-center text-[13px] text-subtle">
            {t("暂无思维导图主题")}
          </div>
        ) : (
          <div className="mx-auto max-w-[780px] space-y-1">
            {rows.map(({ topic, depth, branchColor, childCount, folded }) => {
              const isSelected = selectedId === topic.id;
              const badge = badges[topic.id];
              const boundary = boundaries[topic.id];
              const summary = summaries[topic.id];
              const pMeta = badge?.priority ? priorityBadgeMeta(badge.priority) : null;
              return (
                <div
                  key={topic.id}
                  data-outline-row={topic.id}
                  data-outline-depth={depth}
                  onClick={() => onSelect?.(topic.id)}
                  style={{ paddingLeft: depth * 22 + 8 }}
                  className={cn(
                    "group/row flex items-center gap-1.5 rounded-lg py-1.5 pr-2 transition-colors",
                    isSelected
                      ? "bg-[#eef3fe] ring-1 ring-[#3370ff]/40 dark:bg-primary/15"
                      : "hover:bg-[#f5f6f7] dark:hover:bg-hover/60",
                  )}
                >
                  {childCount > 0 ? (
                    <button
                      type="button"
                      data-outline-fold={topic.id}
                      aria-label={folded ? t("展开分支") : t("收起分支")}
                      aria-expanded={!folded}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFold?.(topic.id);
                      }}
                      className="grid size-5 shrink-0 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground"
                    >
                      {folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </button>
                  ) : (
                    <span className="size-5 shrink-0" />
                  )}

                  <span
                    className={cn(
                      "shrink-0 rounded-full",
                      depth === 0 ? "size-2.5" : "size-2",
                    )}
                    style={{ background: branchColor }}
                    aria-hidden
                  />

                  {readOnly ? (
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate px-1 text-foreground",
                        depth === 0 ? "text-[16px] font-semibold" : depth === 1 ? "text-[14px] font-medium" : "text-[13px]",
                      )}
                    >
                      {topic.text || t("未命名主题")}
                    </span>
                  ) : (
                    <input
                      ref={(node) => {
                        if (node) inputRefs.current.set(topic.id, node);
                        else inputRefs.current.delete(topic.id);
                      }}
                      type="text"
                      data-outline-input={topic.id}
                      aria-label={t("主题标题")}
                      maxLength={500}
                      value={topic.text}
                      placeholder={depth === 0 ? t("中心主题") : t("输入主题")}
                      onFocus={() => onSelect?.(topic.id)}
                      onChange={(e) => onUpdateTitle?.(topic.id, e.target.value)}
                      onKeyDown={(e) => {
                        const action = resolveOutlineKeyAction(e.key, topic, {
                          shiftKey: e.shiftKey,
                          isComposing: e.nativeEvent.isComposing,
                        });
                        if (!action) return;
                        e.preventDefault();
                        e.stopPropagation();
                        if (action === "add-sibling") triggerAddSibling(topic);
                        else if (action === "add-child") triggerAddChild(topic.id);
                        else if (action === "delete") onDelete?.(topic.id);
                      }}
                      className={cn(
                        "min-w-0 flex-1 select-text rounded bg-transparent px-1.5 py-0.5 text-foreground outline-none focus:bg-surface focus:ring-1 focus:ring-[#3370ff]",
                        depth === 0 ? "text-[16px] font-semibold" : depth === 1 ? "text-[14px] font-medium" : "text-[13px]",
                      )}
                    />
                  )}

                  {/* Inline badges */}
                  <div className="flex shrink-0 items-center gap-1">
                    {pMeta && (
                      <span
                        data-outline-badge-priority={badge!.priority}
                        className="rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none"
                        style={{
                          background: pMeta.bg,
                          color: pMeta.fg,
                          border: `1px solid ${pMeta.border}`,
                        }}
                      >
                        {pMeta.label}
                      </span>
                    )}
                    {badge?.progress !== undefined && (
                      <span
                        data-outline-badge-progress={badge.progress}
                        className="inline-flex items-center gap-1 rounded bg-[#f2f3f5] px-1.5 py-0.5 text-[10px] font-medium leading-none text-[#1f2329] dark:bg-hover dark:text-foreground"
                      >
                        <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
                          <circle
                            cx="6"
                            cy="6"
                            r="5"
                            fill="#ffffff"
                            stroke={badge.progress === 100 ? "#2ea121" : "#3370ff"}
                            strokeWidth="1.2"
                          />
                          {badge.progress > 0 && (
                            <path
                              d={progressWedgePath(6, 6, 4.4, badge.progress)}
                              fill={badge.progress === 100 ? "#2ea121" : "#3370ff"}
                            />
                          )}
                        </svg>
                        {badge.progress}%
                      </span>
                    )}
                    {badge?.tag && (
                      <span
                        data-outline-badge-tag={badge.tag}
                        className="rounded bg-[#f0ebff] px-1.5 py-0.5 text-[10px] font-medium leading-none text-[#6425d0]"
                      >
                        {badge.tag}
                      </span>
                    )}
                    {boundary && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium leading-none"
                        style={{
                          color: boundary.color,
                          border: `1px dashed ${boundary.color}`,
                          background: `${boundary.color}14`,
                        }}
                      >
                        {boundary.label || t("外框")}
                      </span>
                    )}
                    {summary && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium leading-none"
                        style={{
                          color: summary.color,
                          background: `${summary.color}16`,
                        }}
                      >
                        {`}`}{summary.label}
                      </span>
                    )}
                    {folded && childCount > 0 && (
                      <span className="rounded-full bg-[#e1eaff] px-1.5 py-0.5 text-[10px] font-medium text-[#3370ff]">
                        +{childCount}
                      </span>
                    )}
                  </div>

                  {/* Row Actions */}
                  {!readOnly && (
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
                      <button
                        type="button"
                        data-outline-add-child={topic.id}
                        title={t("添加子主题")}
                        onClick={(e) => {
                          e.stopPropagation();
                          triggerAddChild(topic.id);
                        }}
                        className="flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] font-medium text-[#3370ff] hover:bg-[#e1eaff]"
                      >
                        <Plus size={12} />
                        <span>{t("子主题")}</span>
                      </button>
                      {topic.parent !== null && (
                        <button
                          type="button"
                          data-outline-delete={topic.id}
                          title={t("删除主题")}
                          aria-label={t("删除主题")}
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete?.(topic.id);
                          }}
                          className="grid size-6 place-items-center rounded text-subtle hover:bg-[#fde8e8] hover:text-[#d83931]"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
