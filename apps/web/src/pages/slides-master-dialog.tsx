import { useEffect, useState } from "react";
import { Check, LayoutTemplate, Trash2, X } from "lucide-react";
import type { SlideMasterMeta } from "@/lib/api";
import { FeishuSelect } from "@/components/feishu-select";
import { useI18n } from "@/lib/i18n";
import {
  isSafeSlideMediaUrl,
  normalizeSlideMaster,
  resolveSlideMasterFontFamily,
  SLIDE_MASTER_ACCENT_PRESETS,
  SLIDE_MASTER_FONT_OPTIONS,
  SlideMasterOverlay,
} from "./slides-master";

export interface SlidesMasterDialogProps {
  initialMaster?: SlideMasterMeta;
  slideIndex: number;
  totalSlides: number;
  canEdit: boolean;
  onApplyCurrentPage: (master: SlideMasterMeta | undefined) => void;
  onApplyAllPages: (master: SlideMasterMeta | undefined) => void;
  onClearMaster: () => void;
  onClose: () => void;
}

/**
 * Feishu-style Slide Master / Custom Brand Kit configuration modal.
 * Lets editors define brand name, logo URL, accent color, font family,
 * top header accent rule, footer text, and automatic slide page numbers.
 */
export function SlidesMasterDialog({
  initialMaster,
  slideIndex,
  totalSlides,
  canEdit,
  onApplyCurrentPage,
  onApplyAllPages,
  onClearMaster,
  onClose,
}: SlidesMasterDialogProps) {
  const { t } = useI18n();
  const [brandName, setBrandName] = useState(initialMaster?.brandName ?? "");
  const [footerText, setFooterText] = useState(initialMaster?.footerText ?? "");
  const [accentColor, setAccentColor] = useState(initialMaster?.accentColor ?? "#3370ff");
  const [fontFamily, setFontFamily] = useState(initialMaster?.fontFamily ?? "");
  const [logoUrl, setLogoUrl] = useState(initialMaster?.logoUrl ?? "");
  const [showPageNumber, setShowPageNumber] = useState(Boolean(initialMaster?.showPageNumber));
  const [headerRule, setHeaderRule] = useState(Boolean(initialMaster?.headerRule));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const trimmedLogo = logoUrl.trim();
  const logoUrlValid = isSafeSlideMediaUrl(trimmedLogo);

  const draftMaster = normalizeSlideMaster({
    brandName,
    footerText,
    accentColor,
    fontFamily: fontFamily || undefined,
    logoUrl: logoUrlValid ? trimmedLogo : undefined,
    showPageNumber,
    headerRule,
  });

  const fontOptions = SLIDE_MASTER_FONT_OPTIONS.map((opt) => ({
    value: opt.value,
    label: t(opt.label),
  }));

  const previewFont = resolveSlideMasterFontFamily(fontFamily);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("母版与品牌设置")}
      data-slides-master-dialog
      className="fixed inset-0 z-[95] grid place-items-center bg-black/35 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90dvh] w-full max-w-[540px] flex-col overflow-hidden rounded-xl border border-[#dee0e3] bg-white shadow-[0_12px_36px_rgba(31,35,41,0.2)]">
        <header className="flex h-13 shrink-0 items-center justify-between border-b border-[#e5e6eb] px-5">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-[#1f2329]">
            <LayoutTemplate size={16} className="text-[#3370ff]" />
            <span>{t("母版与品牌")}</span>
          </div>
          <button
            type="button"
            aria-label={t("关闭母版设置")}
            onClick={onClose}
            className="grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"
          >
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-[13px] text-[#1f2329]">
          {/* Live miniature slide preview */}
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-[#646a73]">{t("品牌效果预览")}</div>
            <div
              data-slides-master-preview
              className="relative aspect-video w-full overflow-hidden rounded-lg border border-[#dee0e3] bg-white px-[6%] py-[8%] shadow-2xs"
              style={{ containerType: "inline-size", fontFamily: previewFont }}
            >
              <SlideMasterOverlay
                master={draftMaster}
                slideIndex={slideIndex}
                totalSlides={Math.max(1, totalSlides)}
              />
              <div className="relative z-[1] mt-[6%] font-semibold text-[#1f2329]" style={{ fontSize: "4.6cqw" }}>
                {t("演示文稿标题示例")}
              </div>
              <div className="relative z-[1] mt-[3%] text-[#4e5969]" style={{ fontSize: "2.3cqw" }}>
                {t("统一品牌主色、字体、页眉装饰条与页脚页码")}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[12px] text-[#4e5969]">{t("品牌名称")}</span>
              <input
                type="text"
                maxLength={80}
                disabled={!canEdit}
                data-slides-master-brand-name
                aria-label={t("品牌名称")}
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                placeholder={t("例如：Jiange Labs")}
                className="h-8 w-full rounded-md border border-[#dee0e3] bg-white px-2.5 text-[13px] text-[#1f2329] outline-none focus:border-[#3370ff] disabled:opacity-40"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[12px] text-[#4e5969]">{t("页脚文案")}</span>
              <input
                type="text"
                maxLength={160}
                disabled={!canEdit}
                data-slides-master-footer-text
                aria-label={t("页脚文案")}
                value={footerText}
                onChange={(e) => setFooterText(e.target.value)}
                placeholder={t("例如：内部保密 · 2026 年度复盘")}
                className="h-8 w-full rounded-md border border-[#dee0e3] bg-white px-2.5 text-[13px] text-[#1f2329] outline-none focus:border-[#3370ff] disabled:opacity-40"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <span className="mb-1.5 block text-[12px] text-[#4e5969]">{t("品牌主色")}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {SLIDE_MASTER_ACCENT_PRESETS.map((color) => {
                  const selected = accentColor.toLowerCase() === color.toLowerCase();
                  return (
                    <button
                      key={color}
                      type="button"
                      disabled={!canEdit}
                      aria-label={`${t("品牌主色")} ${color}`}
                      aria-pressed={selected}
                      data-slides-master-accent={color}
                      onClick={() => setAccentColor(color)}
                      className="grid size-6 place-items-center rounded-full border border-black/10 transition-transform hover:scale-105 disabled:opacity-40"
                      style={{ backgroundColor: color }}
                    >
                      {selected && <Check size={12} className="text-white" strokeWidth={2.5} />}
                    </button>
                  );
                })}
                <label
                  className="relative flex h-6 cursor-pointer items-center gap-1 rounded border border-[#dee0e3] px-1.5 text-[11px] text-[#4e5969] hover:bg-[#f2f3f5]"
                  title={t("自定义品牌主色")}
                >
                  <span className="size-3.5 rounded-xs border border-black/10" style={{ backgroundColor: accentColor }} />
                  <span className="font-mono uppercase">{accentColor}</span>
                  <input
                    type="color"
                    disabled={!canEdit}
                    aria-label={t("自定义品牌主色")}
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    className="sr-only"
                  />
                </label>
              </div>
            </div>

            <div>
              <span className="mb-1.5 block text-[12px] text-[#4e5969]">{t("品牌字体")}</span>
              <FeishuSelect
                ariaLabel={t("品牌字体")}
                title={t("品牌字体")}
                value={fontFamily}
                options={fontOptions}
                disabled={!canEdit}
                onChange={setFontFamily}
                className="h-8 w-full border border-[#dee0e3] px-2.5 text-[13px]"
                chevronSize={12}
                menuMinWidth={180}
                dataAttr={{ "data-slides-master-font-select": true }}
              />
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-[12px] text-[#4e5969]">{t("Logo 图片链接")}</span>
            <input
              type="text"
              maxLength={2048}
              disabled={!canEdit}
              data-slides-master-logo-url
              aria-label={t("Logo 图片链接")}
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://... /api/files/..."
              className={`h-8 w-full rounded-md border bg-white px-2.5 text-[13px] text-[#1f2329] outline-none disabled:opacity-40 ${
                logoUrlValid ? "border-[#dee0e3] focus:border-[#3370ff]" : "border-[#f54a45] focus:border-[#f54a45]"
              }`}
            />
            {!logoUrlValid && (
              <p role="alert" className="mt-1 text-[11px] text-[#d83931]">
                {t("请输入合法的 https://、http:// 或 /api/files/ 图片地址")}
              </p>
            )}
          </label>

          <div className="flex flex-wrap items-center gap-5 rounded-lg border border-[#e5e6eb] bg-[#fafbfc] px-3.5 py-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[#1f2329]">
              <input
                type="checkbox"
                disabled={!canEdit}
                data-slides-master-show-page-number
                checked={showPageNumber}
                onChange={(e) => setShowPageNumber(e.target.checked)}
                className="size-4 cursor-pointer accent-[#3370ff]"
              />
              <span>{t("显示页码")}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[#1f2329]">
              <input
                type="checkbox"
                disabled={!canEdit}
                data-slides-master-header-rule
                checked={headerRule}
                onChange={(e) => setHeaderRule(e.target.checked)}
                className="size-4 cursor-pointer accent-[#3370ff]"
              />
              <span>{t("顶部品牌装饰条")}</span>
            </label>
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[#e5e6eb] bg-[#fafbfc] px-5 py-3">
          <button
            type="button"
            disabled={!canEdit}
            data-slides-master-clear
            onClick={() => {
              onClearMaster();
              onClose();
            }}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-[#dee0e3] bg-white px-2.5 text-[12px] text-[#d83931] hover:bg-[#fff2f0] disabled:opacity-40"
          >
            <Trash2 size={13} />
            <span>{t("清除母版")}</span>
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canEdit || !logoUrlValid}
              data-slides-master-apply-page
              onClick={() => {
                onApplyCurrentPage(draftMaster);
                onClose();
              }}
              className="h-8 rounded-md border border-[#d0d3d6] bg-white px-3 text-[12px] font-medium text-[#1f2329] hover:bg-[#f2f3f5] disabled:opacity-40"
            >
              {t("仅应用当前页")}
            </button>
            <button
              type="button"
              disabled={!canEdit || !logoUrlValid}
              data-slides-master-apply-all
              onClick={() => {
                onApplyAllPages(draftMaster);
                onClose();
              }}
              className="h-8 rounded-md bg-[#3370ff] px-3 text-[12px] font-medium text-white hover:bg-[#245bdb] disabled:opacity-40"
            >
              {t("应用到全部幻灯片")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
