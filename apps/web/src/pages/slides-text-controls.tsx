import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, List, RotateCcw } from "lucide-react";
import { FeishuSelect } from "@/components/feishu-select";
import { useI18n } from "@/lib/i18n";
import type { SlideFieldTextStyle, SlideTextAlign } from "./slides-text-style";

const FONT_SIZES = [16, 18, 21, 24, 28, 32, 36, 44, 54, 64] as const;
const QUICK_COLORS: readonly [string, string][] = [
  ["#1f2329", "深灰"],
  ["#3370ff", "飞书蓝"],
  ["#00b42a", "绿色"],
  ["#ff8800", "橙色"],
  ["#f54a45", "红色"],
  ["#7b56d9", "紫色"],
];

export interface SlideTextControlsProps {
  target: "title" | "body";
  style: SlideFieldTextStyle;
  defaultFontSize: number;
  defaultBold: boolean;
  defaultAlign: SlideTextAlign;
  defaultColor: string;
  bulleted?: boolean;
  onChange: (patch: Partial<SlideFieldTextStyle>) => void;
  onReset: () => void;
  onToggleBullet?: () => void;
}

/**
 * Feishu-style floating text format pill shown when editing slide Title or Body.
 * Floats cleanly above the slide canvas without shifting layout or changing zoom.
 */
export function SlideTextControls({
  target,
  style,
  defaultFontSize,
  defaultBold,
  defaultAlign,
  defaultColor,
  bulleted = false,
  onChange,
  onReset,
  onToggleBullet,
}: SlideTextControlsProps) {
  const { t } = useI18n();
  const fontSize = style.fontSize ?? defaultFontSize;
  const bold = style.bold ?? defaultBold;
  const italic = !!style.italic;
  const align = style.align ?? defaultAlign;
  const color = style.color ?? defaultColor;
  const hasCustom =
    style.fontSize !== undefined ||
    style.bold !== undefined ||
    style.italic !== undefined ||
    style.color !== undefined ||
    style.align !== undefined;

  const sizeOptions = Array.from(new Set([...FONT_SIZES, fontSize]))
    .sort((a, b) => a - b)
    .map((n) => ({ value: String(n), label: `${n}px` }));

  const alignments: [SlideTextAlign, string, typeof AlignLeft][] = [
    ["left", "左对齐", AlignLeft],
    ["center", "居中", AlignCenter],
    ["right", "右对齐", AlignRight],
  ];

  return (
    <div
      data-slides-text-controls={target}
      role="group"
      aria-label={t("文本格式")}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).tagName !== "INPUT") e.preventDefault();
      }}
      className="pointer-events-auto absolute left-1/2 top-2.5 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-1.5 overflow-x-auto whitespace-nowrap rounded-lg border border-[#dee0e3] bg-white/95 px-2.5 py-1 text-[12px] text-[#4e5969] shadow-[0_4px_16px_rgba(31,35,41,0.12)] backdrop-blur-xs [&>*]:shrink-0"
    >
      <span className="rounded bg-[#f2f3f5] px-1.5 py-0.5 text-[11px] font-medium text-[#646a73]">
        {target === "title" ? t("标题") : t("正文")}
      </span>
      <FeishuSelect
        ariaLabel={t("文字字号")}
        title={t("文字字号")}
        value={String(fontSize)}
        options={sizeOptions}
        onChange={(val) => onChange({ fontSize: Number(val) })}
        className="h-6 border border-[#d0d3d6] px-1.5 text-[12px] tabular-nums"
        chevronSize={11}
        menuMinWidth={76}
      />
      <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
      <button
        type="button"
        aria-label={t("加粗")}
        title={t("加粗")}
        aria-pressed={bold}
        onClick={() => onChange({ bold: !bold })}
        className={`grid size-6 place-items-center rounded ${bold ? "bg-[#e8efff] text-[#3370ff]" : "hover:bg-[#f2f3f5]"}`}
      >
        <Bold size={13} />
      </button>
      <button
        type="button"
        aria-label={t("斜体")}
        title={t("斜体")}
        aria-pressed={italic}
        onClick={() => onChange({ italic: !italic })}
        className={`grid size-6 place-items-center rounded ${italic ? "bg-[#e8efff] text-[#3370ff]" : "hover:bg-[#f2f3f5]"}`}
      >
        <Italic size={13} />
      </button>
      <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
      <div className="flex items-center gap-1" role="group" aria-label={t("文字颜色")}>
        {QUICK_COLORS.map(([hex, name]) => (
          <button
            key={hex}
            type="button"
            aria-label={`${t("文字颜色")} ${t(name)}`}
            title={t(name)}
            aria-pressed={color.toLowerCase() === hex}
            onClick={() => onChange({ color: hex })}
            className={`size-4 rounded-full border transition-transform hover:scale-110 ${
              color.toLowerCase() === hex ? "border-[#3370ff] ring-2 ring-[#3370ff]/30" : "border-[#d0d3d6]"
            }`}
            style={{ backgroundColor: hex }}
          />
        ))}
        <label className="relative ml-0.5 flex cursor-pointer items-center rounded px-1 py-0.5 text-[11px] hover:bg-[#f2f3f5]" title={t("自定义颜色")}>
          <span className="font-semibold" style={{ color }}>A</span>
          <input
            type="color"
            aria-label={t("自定义文字颜色")}
            value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#1f2329"}
            onChange={(e) => onChange({ color: e.target.value })}
            className="sr-only"
          />
        </label>
      </div>
      <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
      <div className="flex items-center gap-0.5" role="group" aria-label={t("文字对齐")}>
        {alignments.map(([val, label, Icon]) => (
          <button
            key={val}
            type="button"
            aria-label={t(label)}
            title={t(label)}
            aria-pressed={align === val}
            onClick={() => onChange({ align: val })}
            className={`grid size-6 place-items-center rounded ${align === val ? "bg-[#e8efff] text-[#3370ff]" : "hover:bg-[#f2f3f5]"}`}
          >
            <Icon size={13} />
          </button>
        ))}
      </div>
      {target === "body" && onToggleBullet && (
        <>
          <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
          <button
            type="button"
            aria-label={t("项目符号列表")}
            title={t("项目符号列表")}
            aria-pressed={bulleted}
            onClick={onToggleBullet}
            className={`inline-flex h-6 items-center gap-1 rounded px-1.5 ${
              bulleted ? "bg-[#e8efff] text-[#3370ff]" : "hover:bg-[#f2f3f5]"
            }`}
          >
            <List size={13} />
            <span>{t("列表")}</span>
          </button>
        </>
      )}
      {hasCustom && (
        <>
          <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
          <button
            type="button"
            aria-label={t("恢复默认样式")}
            title={t("恢复默认样式")}
            onClick={onReset}
            className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
          >
            <RotateCcw size={12} />
          </button>
        </>
      )}
    </div>
  );
}
