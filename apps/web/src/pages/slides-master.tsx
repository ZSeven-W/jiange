import type { SlideMasterMeta, SlidesPage } from "@/lib/api";

export type SlideMasterMap = Record<number, SlideMasterMeta>;

export const SLIDE_MASTER_ACCENT_PRESETS = [
  "#3370ff",
  "#00b42a",
  "#ff7d00",
  "#722ed1",
  "#f54a45",
  "#14c9c9",
  "#1f2329",
] as const;

export const SLIDE_MASTER_FONT_OPTIONS = [
  { value: "", label: "系统默认" },
  { value: "sans", label: "现代黑体（Sans）" },
  { value: "serif", label: "雅致宋体（Serif）" },
  { value: "kai", label: "演示楷体（Kai）" },
  { value: "mono", label: "等宽代码（Mono）" },
  { value: "rounded", label: "圆润体（Rounded）" },
] as const;

const FONT_STACK_MAP: Record<string, string> = {
  sans: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Source Han Serif SC", "Songti SC", Georgia, serif',
  kai: '"Kaiti SC", STKaiti, KaiTi, serif',
  mono: '"JetBrains Mono", "SFMono-Regular", Menlo, monospace',
  rounded: '"PingFang SC", "Hiragino Maru Gothic ProN", "Rounded Mplus 1c", sans-serif',
  Inter: 'Inter, "PingFang SC", sans-serif',
  "PingFang SC": '"PingFang SC", "Microsoft YaHei", sans-serif',
  "Microsoft YaHei": '"Microsoft YaHei", "PingFang SC", sans-serif',
  "Songti SC": '"Songti SC", Georgia, serif',
  "Kaiti SC": '"Kaiti SC", KaiTi, serif',
  Georgia: 'Georgia, "Songti SC", serif',
  "sans-serif": "sans-serif",
  monospace: "monospace",
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Validates safe https://, http://, or internal /api/files/... media & logo URLs. */
export function isSafeSlideMediaUrl(raw: string | undefined): boolean {
  if (!raw) return true;
  if (raw.length > 2048) return false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  if (raw.startsWith("/api/files/")) {
    const rest = raw.slice("/api/files/".length);
    return rest.length > 0 && !rest.includes("..") && !rest.includes("\\") && !rest.startsWith("/");
  }
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.host.length > 0;
  } catch {
    return false;
  }
}

export function resolveSlideMasterFontFamily(fontFamily: string | undefined): string | undefined {
  if (!fontFamily) return undefined;
  const trimmed = fontFamily.trim();
  if (!trimmed || trimmed === "default") return undefined;
  return FONT_STACK_MAP[trimmed];
}

export function normalizeSlideMaster(master: SlideMasterMeta | undefined): SlideMasterMeta | undefined {
  if (!master || typeof master !== "object") return undefined;
  const out: SlideMasterMeta = {};
  if (typeof master.brandName === "string") {
    const v = master.brandName.trim();
    if (v && Array.from(v).length <= 80) out.brandName = v;
  }
  if (typeof master.footerText === "string") {
    const v = master.footerText.trim();
    if (v && Array.from(v).length <= 160) out.footerText = v;
  }
  if (master.showPageNumber === true) out.showPageNumber = true;
  if (typeof master.logoUrl === "string") {
    const v = master.logoUrl.trim();
    if (v && isSafeSlideMediaUrl(v)) out.logoUrl = v;
  }
  if (typeof master.accentColor === "string") {
    const v = master.accentColor.trim();
    if (HEX_COLOR_RE.test(v)) out.accentColor = v;
  }
  if (typeof master.fontFamily === "string") {
    const v = master.fontFamily.trim();
    if (v && v !== "default" && v in FONT_STACK_MAP) out.fontFamily = v;
  }
  if (master.headerRule === true) out.headerRule = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function hydrateSlideMasters(
  pages: readonly Pick<SlidesPage, "id" | "meta">[] | undefined,
): SlideMasterMap {
  if (!pages?.length) return {};
  const result: SlideMasterMap = {};
  for (const page of pages) {
    const normalized = normalizeSlideMaster(page.meta?.master);
    if (normalized) result[page.id] = normalized;
  }
  return result;
}

/**
 * Renders the Slide Master / Brand Kit chrome (top accent rule, brand logo & badge,
 * footer text, and live slide page number) scaled cleanly via CSS container query units.
 */
export function SlideMasterOverlay({
  master,
  slideIndex,
  totalSlides,
  dark = false,
}: {
  master?: SlideMasterMeta;
  slideIndex?: number;
  totalSlides?: number;
  dark?: boolean;
}) {
  if (!master) return null;
  const accent = master.accentColor && HEX_COLOR_RE.test(master.accentColor) ? master.accentColor : "#3370ff";
  const safeLogo = master.logoUrl && isSafeSlideMediaUrl(master.logoUrl) ? master.logoUrl : undefined;
  const hasBrandHeader = !!safeLogo || !!master.brandName;
  const showPageNum = Boolean(master.showPageNumber) && slideIndex !== undefined && totalSlides !== undefined && totalSlides > 0;
  const hasFooter = !!master.footerText || showPageNum;
  if (!master.headerRule && !hasBrandHeader && !hasFooter) return null;

  return (
    <div data-slide-master-overlay className="pointer-events-none absolute inset-0 z-[2] overflow-hidden">
      {master.headerRule && (
        <div
          data-slide-master-header-rule
          aria-hidden="true"
          className="absolute inset-x-0 top-0"
          style={{ height: "0.68cqw", backgroundColor: accent }}
        />
      )}
      {hasBrandHeader && (
        <div
          data-slide-master-brand
          className="absolute right-[3%] top-[2.5%] flex items-center gap-[0.65cqw]"
        >
          {safeLogo && (
            <img
              src={safeLogo}
              alt={master.brandName || ""}
              draggable={false}
              className="object-contain"
              style={{ height: "2.35cqw", maxWidth: "10cqw" }}
            />
          )}
          {master.brandName && (
            <span
              className="truncate font-semibold tracking-tight"
              style={{
                fontSize: "1.15cqw",
                maxWidth: "24cqw",
                color: dark ? "#f5f6f7" : accent,
              }}
            >
              {master.brandName}
            </span>
          )}
        </div>
      )}
      {hasFooter && (
        <div
          data-slide-master-footer
          className="absolute inset-x-[4%] bottom-[2%] flex items-center justify-between gap-[2cqw]"
          style={{
            fontSize: "1.1cqw",
            color: dark ? "rgba(229,231,235,0.75)" : "#8f959e",
          }}
        >
          <span className="truncate">{master.footerText ?? ""}</span>
          {showPageNum && (
            <span
              data-slide-master-page-number
              className="shrink-0 font-medium tabular-nums"
              style={{ color: dark ? "#e5e7eb" : accent }}
            >
              {slideIndex! + 1} / {totalSlides}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
