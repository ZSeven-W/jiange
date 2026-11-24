import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  hydrateSlideMasters,
  isSafeSlideMediaUrl,
  normalizeSlideMaster,
  resolveSlideMasterFontFamily,
  SlideMasterOverlay,
} from "./slides-master";
import { buildSlidePageMeta } from "./slides-text-style";
import { SlidesMasterDialog } from "./slides-master-dialog";

describe("slides master brand kit helpers and dialog", () => {
  it("validates safe URLs, normalizes master metadata, and preserves master in buildSlidePageMeta", () => {
    expect(isSafeSlideMediaUrl("https://cdn.example.com/logo.png")).toBe(true);
    expect(isSafeSlideMediaUrl("http://localhost:8080/logo.png")).toBe(true);
    expect(isSafeSlideMediaUrl("/api/files/42")).toBe(true);
    expect(isSafeSlideMediaUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeSlideMediaUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isSafeSlideMediaUrl("/api/files/../secret")).toBe(false);

    expect(normalizeSlideMaster({ brandName: "  ", showPageNumber: false, headerRule: false })).toBeUndefined();
    const clean = normalizeSlideMaster({
      brandName: "  Jiange Labs  ",
      footerText: "Confidential",
      showPageNumber: true,
      logoUrl: "/api/files/7",
      accentColor: "#3370ff",
      fontFamily: "serif",
      headerRule: true,
    });
    expect(clean).toEqual({
      brandName: "Jiange Labs",
      footerText: "Confidential",
      showPageNumber: true,
      logoUrl: "/api/files/7",
      accentColor: "#3370ff",
      fontFamily: "serif",
      headerRule: true,
    });
    expect(resolveSlideMasterFontFamily("serif")).toContain("Songti SC");
    expect(resolveSlideMasterFontFamily("")).toBeUndefined();

    const hydrated = hydrateSlideMasters([
      { id: 1, meta: { master: clean } },
      { id: 2, meta: undefined },
    ]);
    expect(hydrated[1]).toEqual(clean);
    expect(hydrated[2]).toBeUndefined();

    const built = buildSlidePageMeta(undefined, "fade", undefined, undefined, clean);
    expect(built.transition).toBe("fade");
    expect(built.master).toEqual(clean);
  });

  it("renders SlideMasterOverlay with accent rule, brand badge, footer, and live page number", () => {
    const html = renderToStaticMarkup(
      <SlideMasterOverlay
        master={{
          brandName: "Acme Corp",
          footerText: "All Hands 2026",
          showPageNumber: true,
          logoUrl: "https://cdn.example.com/acme.png",
          accentColor: "#ff7d00",
          headerRule: true,
        }}
        slideIndex={2}
        totalSlides={10}
      />,
    );
    expect(html).toContain("data-slide-master-overlay");
    expect(html).toContain("data-slide-master-header-rule");
    expect(html).toContain("Acme Corp");
    expect(html).toContain("All Hands 2026");
    expect(html).toContain("3 / 10");
    expect(html).toContain("https://cdn.example.com/acme.png");
    expect(html).toContain("#ff7d00");
  });

  it("renders SlidesMasterDialog with FeishuSelect (zero native select), live preview, and all action buttons", () => {
    const html = renderToStaticMarkup(
      <SlidesMasterDialog
        initialMaster={{
          brandName: "Jiange",
          footerText: "2026 Deck",
          accentColor: "#3370ff",
          fontFamily: "sans",
          logoUrl: "/api/files/12",
          showPageNumber: true,
          headerRule: true,
        }}
        slideIndex={0}
        totalSlides={5}
        canEdit
        onApplyCurrentPage={() => {}}
        onApplyAllPages={() => {}}
        onClearMaster={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain("data-slides-master-dialog");
    expect(html).not.toContain("<select");
    expect(html).toContain("data-slides-master-font-select");
    expect(html).toContain("data-slides-master-preview");
    expect(html).toContain("data-slides-master-brand-name");
    expect(html).toContain("data-slides-master-footer-text");
    expect(html).toContain("data-slides-master-logo-url");
    expect(html).toContain("data-slides-master-show-page-number");
    expect(html).toContain("data-slides-master-header-rule");
    expect(html).toContain("data-slides-master-clear");
    expect(html).toContain("data-slides-master-apply-page");
    expect(html).toContain("data-slides-master-apply-all");
    expect(html).toContain("仅应用当前页");
    expect(html).toContain("应用到全部幻灯片");
    expect(html).toContain("清除母版");
    expect(html).toContain("1 / 5");
    expect(html).toContain("/api/files/12");
  });

  it("blocks apply buttons and displays alert when initial logoUrl is unsafe", () => {
    const html = renderToStaticMarkup(
      <SlidesMasterDialog
        initialMaster={{
          brandName: "Jiange",
          logoUrl: "javascript:alert(1)",
        }}
        slideIndex={0}
        totalSlides={2}
        canEdit
        onApplyCurrentPage={() => {}}
        onApplyAllPages={() => {}}
        onClearMaster={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("请输入合法的 https://、http:// 或 /api/files/ 图片地址");
    expect(html).toMatch(/disabled=""[^>]*data-slides-master-apply-page/);
    expect(html).toMatch(/disabled=""[^>]*data-slides-master-apply-all/);
  });
});
