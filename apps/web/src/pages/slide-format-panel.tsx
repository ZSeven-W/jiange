import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Palette, Play, X } from "lucide-react";
import type { SlideCreationLayout, SlideLayout, SlideShape, SlideShapeAnimation } from "@/lib/api";
import { FeishuSelect } from "@/components/feishu-select";
import { useI18n } from "@/lib/i18n";
import { blankSlideLayout, isBlankSlideLayout } from "./slides-layout";
import { backgroundPopoverPosition, SLIDE_BACKGROUND_COLORS } from "./slides-background";
import { isTwoColumnSlide } from "./slides-layout-preset";
import type { SlidePageTextStyles } from "./slides-text-style";
import {
  nextSlideAnimationOrder,
  type SlidePageShapeAnimations,
} from "./slides-animations";
import {
  SlideChartEditor,
  SlideElementAnimationControls,
  SlideTableEditor,
} from "./slides-table-chart-editor";
import {
  matchSlideTheme,
  SLIDE_THEMES,
  type SlideThemeId,
  type SlideThemePreset,
} from "./slides-themes";
import {
  SLIDE_TRANSITION_OPTIONS,
  type SlideTransitionKind,
} from "./slides-transitions";

export function SlideFormatPanel({
  background,
  layout,
  shapes,
  selectedShape,
  usedColors,
  textStyle,
  transition = "none",
  pageAnimations,
  canEdit,
  busy,
  applying,
  onChange,
  onLayoutChange,
  onMore,
  onApplyAll,
  onApplyTheme,
  onApplyThemeAll,
  onTransitionChange,
  onPreviewTransition,
  onApplyTransitionAll,
  onShapeChange,
  onShapeAnimationChange,
  onPreviewShapeAnimation,
  onClose,
}: {
  background: string;
  layout: SlideLayout;
  shapes: SlideShape[];
  selectedShape?: SlideShape | null;
  usedColors: string[];
  textStyle?: SlidePageTextStyles;
  transition?: SlideTransitionKind;
  pageAnimations?: SlidePageShapeAnimations;
  canEdit: boolean;
  busy: boolean;
  applying: boolean;
  onChange: (color: string) => void;
  onLayoutChange: (layout: SlideCreationLayout) => void;
  onMore: () => void;
  onApplyAll: () => void;
  onApplyTheme?: (theme: SlideThemePreset) => void;
  onApplyThemeAll?: (theme: SlideThemePreset) => void;
  onTransitionChange?: (transition: SlideTransitionKind) => void;
  onPreviewTransition?: (transition: SlideTransitionKind) => void;
  onApplyTransitionAll?: (transition: SlideTransitionKind) => void;
  onShapeChange?: (id: string, patch: Partial<SlideShape>) => void;
  onShapeAnimationChange?: (shapeId: string, anim: SlideShapeAnimation | null) => void;
  onPreviewShapeAnimation?: (shapeId: string, anim: SlideShapeAnimation) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [palette, setPalette] = useState(false);
  const [pickedThemeId, setPickedThemeId] = useState<SlideThemeId | null>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!palette) return;
    const outside = (event: PointerEvent) => { if (!paletteRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPalette(false); };
    const close = () => setPalette(false);
    const scroll = (event: Event) => { if (!paletteRef.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", close); window.removeEventListener("scroll", scroll, true); };
  }, [palette]);
  const colors = [...new Set(usedColors.filter((color) => /^#[0-9a-f]{6}$/i.test(color)).map((color) => color.toLowerCase()))].slice(0, 7);
  const twoColumn = isTwoColumnSlide({ layout, shapes });
  const matchedTheme = matchSlideTheme(background, textStyle);
  const activeTheme =
    matchedTheme ??
    (pickedThemeId ? SLIDE_THEMES.find((theme) => theme.id === pickedThemeId) : undefined) ??
    SLIDE_THEMES[0];
  const choose = (color: string) => { onChange(color); setPalette(false); trigger.current?.focus(); };
  const chooseTheme = (theme: SlideThemePreset) => {
    setPickedThemeId(theme.id);
    onChange(theme.background);
    onApplyTheme?.(theme);
  };
  const themeLabel = (theme: SlideThemePreset) =>
    theme.id === "feishu-blue"
      ? t("飞书经典蓝")
      : theme.id === "deep-ocean"
        ? t("深海商务")
        : theme.id === "fresh-mint"
          ? t("清新森绿")
          : theme.id === "warm-amber"
            ? t("暖阳活力")
            : theme.id === "dark-geek"
              ? t("暗夜极客")
              : theme.id === "minimal-mono"
                ? t("极简黑白")
                : theme.name;
  const transitionOptions = SLIDE_TRANSITION_OPTIONS.map((opt) => ({
    value: opt.value,
    label:
      opt.value === "none"
        ? t("无")
        : opt.value === "fade"
          ? t("淡入淡出")
          : opt.value === "push"
            ? t("推入")
            : opt.value === "wipe"
              ? t("擦除")
              : opt.label,
  }));
  return <aside className="z-20 flex max-h-[42%] w-full shrink-0 flex-col border-t border-[#dee0e3] bg-white md:max-h-none md:w-[294px] md:border-l md:border-t-0" data-slide-format aria-label={t("幻灯片格式")} onKeyDown={(event) => { if (event.key !== "Escape") return; event.preventDefault(); event.stopPropagation(); if (palette) { setPalette(false); trigger.current?.focus(); } else onClose(); }}>
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[#e5e6eb] px-5 text-[14px] font-medium text-[#1f2329]"><Palette size={16} strokeWidth={1.7}/><span>{t("幻灯片格式")}</span><button type="button" onClick={onClose} className="ml-auto grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]" aria-label={t("关闭幻灯片格式")}><X size={16}/></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4 text-[13px] text-[#1f2329]">
      {selectedShape?.kind === "table" && onShapeChange && (
        <SlideTableEditor
          shape={selectedShape}
          canEdit={canEdit}
          onChange={(patch) => onShapeChange(selectedShape.id, patch)}
        />
      )}
      {selectedShape?.kind === "chart" && onShapeChange && (
        <SlideChartEditor
          shape={selectedShape}
          canEdit={canEdit}
          onChange={(patch) => onShapeChange(selectedShape.id, patch)}
        />
      )}
      {selectedShape && onShapeAnimationChange && (
        <SlideElementAnimationControls
          shapeId={selectedShape.id}
          animation={pageAnimations?.[selectedShape.id]}
          defaultOrder={nextSlideAnimationOrder(pageAnimations)}
          canEdit={canEdit}
          onChange={(anim) => onShapeAnimationChange(selectedShape.id, anim)}
          onPreview={onPreviewShapeAnimation}
        />
      )}
      <div className="mb-4 font-medium">{t("背景")}</div>
      <div className="relative flex h-9 items-center justify-between"><span>{t("颜色填充")}</span><button ref={trigger} type="button" disabled={!canEdit} aria-label={t("选择背景颜色")} aria-expanded={palette} onClick={() => setPalette((open) => !open)} className="grid size-7 place-items-center rounded border border-[#dee0e3] hover:border-[#3370ff] disabled:opacity-40"><span className="grid size-5 place-items-center rounded-sm border border-[#d0d3d6]" style={{ background: background || "linear-gradient(135deg,#fff 45%,#f28b82 47%,#f28b82 53%,#fff 55%)" }}/></button>
        {palette && trigger.current && createPortal(<div ref={paletteRef} role="group" aria-label={t("背景颜色")} style={backgroundPopoverPosition(trigger.current.getBoundingClientRect(), window.innerWidth, window.innerHeight, colors.length ? 300 : 265)} className="fixed z-[100] overflow-y-auto rounded-lg border border-[#dee0e3] bg-white p-3 text-[12px] shadow-[0_6px_24px_rgba(31,35,41,0.16)]">
          {colors.length > 0 && <><p className="mb-2 text-[#8f959e]">{t("幻灯片使用过的颜色")}</p><div className="mb-3 flex flex-wrap gap-1.5">{colors.map((color) => <ColorButton key={color} color={color} disabled={!canEdit} selected={background.toLowerCase() === color} onClick={() => choose(color)}/>)}</div></>}
          <p className="mb-2 text-[#8f959e]">{t("基础色")}</p><div className="grid grid-cols-7 gap-1.5">{SLIDE_BACKGROUND_COLORS.map((color) => <ColorButton key={color} color={color} disabled={!canEdit} selected={background.toLowerCase() === color} onClick={() => choose(color)}/>)}</div>
          <div className="mt-3 border-t border-[#e5e6eb] pt-1"><button type="button" disabled={!canEdit} onClick={() => choose("")} className="flex h-8 w-full items-center gap-2 rounded px-1 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><span className="size-4 rounded-full border border-[#dee0e3]" style={{ background: "linear-gradient(135deg,#fff 45%,#f28b82 47%,#f28b82 53%,#fff 55%)" }}/>{t("无填充")}</button><button type="button" disabled={!canEdit} onClick={() => { setPalette(false); onMore(); }} className="flex h-8 w-full items-center gap-2 rounded px-1 text-left hover:bg-[#f2f3f5] disabled:opacity-40"><span className="size-4 rounded-full" style={{ background: "conic-gradient(#f65,#fc4,#4c8,#48f,#b6e,#f65)" }}/>{t("更多颜色")}<ChevronRight size={14} className="ml-auto"/></button></div>
        </div>, document.body)}
      </div>
      <button type="button" disabled={!canEdit || busy} onClick={onApplyAll} className="mt-4 h-8 w-full rounded-md border border-[#dee0e3] text-[12px] hover:bg-[#f2f3f5] disabled:opacity-40">{applying ? t("正在应用…") : t("应用到全部")}</button>

      <div className="mt-5 border-t border-[#e5e6eb] pt-4">
        <div className="mb-3 font-medium">{t("主题方案")}</div>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label={t("主题方案")}>
          {SLIDE_THEMES.map((theme) => {
            const selected = matchedTheme?.id === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                data-slide-theme-card={theme.id}
                aria-pressed={selected}
                disabled={!canEdit}
                onClick={() => chooseTheme(theme)}
                className="group text-left disabled:opacity-40"
              >
                <span
                  className={`relative flex aspect-video flex-col justify-between overflow-hidden rounded-md border p-2 transition-shadow ${
                    selected
                      ? "border-2 border-[#3370ff] shadow-[0_0_0_2px_rgba(51,112,255,0.16)]"
                      : "border-[#dee0e3] group-hover:border-[#3370ff]/70"
                  }`}
                  style={{ backgroundColor: theme.background }}
                >
                  <span className="h-[3px] w-7 rounded-full" style={{ backgroundColor: theme.accent }} />
                  <span className="flex flex-col gap-1">
                    <span className="text-[11px] font-semibold leading-none" style={{ color: theme.titleColor }}>Aa</span>
                    <span className="h-[3px] w-4/5 rounded-full opacity-75" style={{ backgroundColor: theme.bodyColor }} />
                    <span className="h-[2.5px] w-3/5 rounded-full opacity-50" style={{ backgroundColor: theme.bodyColor }} />
                  </span>
                  {selected && (
                    <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-[#3370ff] text-white">
                      <Check size={10} strokeWidth={2.5} />
                    </span>
                  )}
                </span>
                <span className={`mt-1 block truncate text-center text-[11px] ${selected ? "font-medium text-[#3370ff]" : "text-[#646a73]"}`}>
                  {themeLabel(theme)}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          data-slide-theme-apply-all
          disabled={!canEdit || busy}
          onClick={() => onApplyThemeAll?.(activeTheme)}
          className="mt-3 h-8 w-full rounded-md border border-[#dee0e3] text-[12px] hover:bg-[#f2f3f5] disabled:opacity-40"
        >
          {applying ? t("正在应用…") : t("主题应用到全部")}
        </button>
      </div>

      <div className="mt-5 border-t border-[#e5e6eb] pt-4" data-slide-transition-section>
        <div className="mb-3 font-medium">{t("切换动画")}</div>
        <div className="flex h-9 items-center justify-between gap-2">
          <span className="text-[#4e5969]">{t("切换效果")}</span>
          <FeishuSelect
            ariaLabel={t("页面切换动画")}
            title={t("页面切换动画")}
            value={transition}
            options={transitionOptions}
            disabled={!canEdit}
            onChange={(val) => onTransitionChange?.(val as SlideTransitionKind)}
            className="h-8 w-[124px] border border-[#dee0e3] px-2 text-[12px]"
            chevronSize={12}
            menuMinWidth={124}
            dataAttr={{ "data-slide-transition-select": true }}
          />
        </div>
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            data-slide-transition-preview
            disabled={transition === "none"}
            onClick={() => onPreviewTransition?.(transition)}
            className="flex h-8 flex-1 items-center justify-center gap-1 rounded-md border border-[#dee0e3] text-[12px] hover:bg-[#f2f3f5] disabled:opacity-40"
          >
            <Play size={12} />
            <span>{t("预览动画")}</span>
          </button>
          <button
            type="button"
            data-slide-transition-apply-all
            disabled={!canEdit}
            title={t("将当前切换动画应用到全部页面")}
            onClick={() => onApplyTransitionAll?.(transition)}
            className="h-8 flex-1 rounded-md border border-[#dee0e3] text-[12px] hover:bg-[#f2f3f5] disabled:opacity-40"
          >
            {t("应用到全部")}
          </button>
        </div>
      </div>

      <div className="mt-5 border-t border-[#e5e6eb] pt-4"><div className="mb-3 font-medium">{t("布局")}</div><div className="mb-2 text-[12px] text-[#8f959e]">{t("默认母版")}</div><div className="grid grid-cols-2 gap-2" role="group" aria-label={t("幻灯片布局")}>
        <button type="button" disabled={!canEdit} aria-pressed={isBlankSlideLayout(layout) && !twoColumn} onClick={() => onLayoutChange(blankSlideLayout(layout))} className="text-center disabled:opacity-40"><span className={`block aspect-video rounded-md border bg-white ${isBlankSlideLayout(layout) && !twoColumn ? "border-2 border-[#3370ff]" : "border-[#dee0e3]"}`}/><span className="mt-1 block text-[12px] text-[#646a73]">{t("空白")}</span></button>
        <button type="button" disabled={!canEdit} aria-pressed={layout === "title"} onClick={() => onLayoutChange("title")} className="text-center disabled:opacity-40"><span className={`grid aspect-video place-items-center rounded-md border bg-white ${layout === "title" ? "border-2 border-[#3370ff]" : "border-[#dee0e3]"}`}><span className="h-1.5 w-1/2 rounded bg-[#646a73]"/></span><span className="mt-1 block text-[12px] text-[#646a73]">{t("标题")}</span></button>
        <button type="button" disabled={!canEdit} aria-pressed={layout === ""} onClick={() => onLayoutChange("")} className="text-center disabled:opacity-40"><span className={`block aspect-video rounded-md border bg-white p-2 ${layout === "" ? "border-2 border-[#3370ff]" : "border-[#dee0e3]"}`}><span className="block h-1 w-3/4 rounded bg-[#b8bec5]"/><span className="mt-2 block h-0.5 w-1/2 rounded bg-[#dee0e3]"/><span className="mt-1 block h-0.5 w-2/3 rounded bg-[#dee0e3]"/></span><span className="mt-1 block text-[12px] text-[#646a73]">{t("标题与正文")}</span></button>
        <button type="button" disabled={!canEdit} aria-pressed={twoColumn} onClick={() => onLayoutChange("two-column")} className="text-center disabled:opacity-40"><span className={`relative block aspect-video rounded-md border bg-white ${twoColumn ? "border-2 border-[#3370ff]" : "border-[#dee0e3]"}`}><span className="absolute left-[8%] top-[12%] h-[5%] w-[55%] rounded-full bg-[#8f959e]"/><span className="absolute left-[8%] top-[30%] h-[55%] w-[38%] rounded-sm bg-[#e5e6eb]"/><span className="absolute right-[8%] top-[30%] h-[55%] w-[38%] rounded-sm bg-[#e5e6eb]"/></span><span className="mt-1 block text-[12px] text-[#646a73]">{t("标题与两栏内容")}</span></button>
      </div></div>
    </div>
  </aside>;
}

function ColorButton({ color, disabled, selected, onClick }: { color: string; disabled: boolean; selected: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return <button type="button" aria-label={t("背景颜色 {color}", { color })} aria-pressed={selected} title={color} disabled={disabled} onClick={onClick} className="grid size-6 place-items-center rounded-full border border-black/10 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#3370ff] disabled:opacity-40" style={{ backgroundColor: color }}>{selected && <Check size={13} strokeWidth={2} className={color === "#1f2329" ? "text-white" : "text-[#1f2329]"}/>}</button>;
}
