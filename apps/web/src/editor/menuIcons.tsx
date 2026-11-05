import {
  ChevronRight,
  Code2,
  Columns2,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image as ImageIcon,
  Lightbulb,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Paperclip,
  Play,
  Quote,
  Sigma,
  SquareCheck,
  Table2,
  Type,
} from "lucide-react";
import type { ReactNode } from "react";

/** 斜杠菜单 icon：id → lucide 组件（lucide 没有的用自绘 SVG 补齐）。 */
export const MENU_ICONS: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>> = {
  paragraph: Type,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  h4: Heading4,
  h5: Heading5,
  h6: Heading6,
  bullet: List,
  ordered: ListOrdered,
  todo: SquareCheck,
  quote: Quote,
  code: Code2,
  image: ImageIcon,
  file: Paperclip,
  callout: Lightbulb,
  math: Sigma,
  video: Play,
  bookmark: Link2,
  table: Table2,
  columns: Columns2,
  doc: FileText, // @ 提及文档
};

/** 渲染斜杠菜单项 icon；未知 id 回退自绘占位。 */
export function MenuGlyph({ id, fallback }: { id: string; fallback?: string }) {
  const key = id.startsWith("doc:") ? "doc" : id;
  const Icon = MENU_ICONS[key];
  if (Icon) return <Icon size={14} strokeWidth={1.7} />;
  return <span className="text-[11px] font-semibold">{fallback ?? id}</span>;
}

/** @文档提及内联标记（lucide 无对应，自绘小表格页图形）。 */
export function MentionMark({ size = 11, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.2h12M2 9.8h12M5.8 6.2v7.3" />
    </svg>
  );
}

/** 待办复选框（勾选态实心，lucide 样式对齐）。 */
export function TodoCheck({ checked }: { checked: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="3" fill={checked ? "currentColor" : "none"} />
      {checked && <path d="m5.4 8.2 2 2 3.2-3.6" stroke="#fff" />}
    </svg>
  );
}

/** 甘特条内左移/右移手柄（自绘）。 */
export function GripDots({ className }: { className?: string }) {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" className={className} aria-hidden>
      <circle cx="2.5" cy="3" r="1.1" />
      <circle cx="7.5" cy="3" r="1.1" />
      <circle cx="2.5" cy="7" r="1.1" />
      <circle cx="7.5" cy="7" r="1.1" />
      <circle cx="2.5" cy="11" r="1.1" />
      <circle cx="7.5" cy="11" r="1.1" />
    </svg>
  );
}
