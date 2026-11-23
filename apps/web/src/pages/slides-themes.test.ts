import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SlidesPage } from "@/lib/api";
import {
  applyThemeToPageTextStyle,
  applyThemeToTextStyles,
  getSlideTheme,
  matchSlideTheme,
  SLIDE_THEMES,
} from "./slides-themes";
import { SlideFormatPanel } from "./slide-format-panel";
import { PresenterView, SlideSurface } from "./slides-presenter";

const samplePage: SlidesPage = {
  id: 1,
  slidesId: 7,
  pos: 1,
  title: "主题标题",
  body: "主题正文",
  notes: "备注内容",
  background: "#0f1f3d",
  shapes: [],
  hidden: false,
  revision: 1,
  updatedAt: "",
};

describe("slides theme presets", () => {
  it("defines all 6 curated Feishu presentation themes with exact palette values", () => {
    expect(SLIDE_THEMES).toHaveLength(6);
    expect(SLIDE_THEMES.map((t) => t.id)).toEqual([
      "feishu-blue",
      "deep-ocean",
      "fresh-mint",
      "warm-amber",
      "dark-geek",
      "minimal-mono",
    ]);
    expect(getSlideTheme("feishu-blue")).toEqual({
      id: "feishu-blue",
      name: "飞书经典蓝",
      background: "#ffffff",
      titleColor: "#1f2329",
      bodyColor: "#4e5969",
      accent: "#3370ff",
    });
    expect(getSlideTheme("deep-ocean")).toEqual({
      id: "deep-ocean",
      name: "深海商务",
      background: "#0f1f3d",
      titleColor: "#ffffff",
      bodyColor: "#cbd5e1",
      accent: "#4e83fd",
    });
    expect(getSlideTheme("fresh-mint")).toEqual({
      id: "fresh-mint",
      name: "清新森绿",
      background: "#f0fdf4",
      titleColor: "#14532d",
      bodyColor: "#3f6212",
      accent: "#00b42a",
    });
    expect(getSlideTheme("warm-amber")).toEqual({
      id: "warm-amber",
      name: "暖阳活力",
      background: "#fffbeb",
      titleColor: "#78350f",
      bodyColor: "#92400e",
      accent: "#ff8800",
    });
    expect(getSlideTheme("dark-geek")).toEqual({
      id: "dark-geek",
      name: "暗夜极客",
      background: "#18181b",
      titleColor: "#fafafa",
      bodyColor: "#d4d4d8",
      accent: "#7b56d9",
    });
    expect(getSlideTheme("minimal-mono")).toEqual({
      id: "minimal-mono",
      name: "极简黑白",
      background: "#f8fafc",
      titleColor: "#0f172a",
      bodyColor: "#475569",
      accent: "#1f2329",
    });
    expect(getSlideTheme("nonexistent")).toBeUndefined();
  });

  it("matches slide background and text colors back to the corresponding theme preset", () => {
    const deep = getSlideTheme("deep-ocean")!;
    expect(
      matchSlideTheme("#0F1F3D", {
        title: { color: "#FFFFFF" },
        body: { color: "#CBD5E1" },
      })?.id,
    ).toBe("deep-ocean");
    expect(matchSlideTheme("#0f1f3d", { title: { color: "#ff0000" } })).toBeNull();
    expect(matchSlideTheme("")).toBeNull();
    expect(matchSlideTheme(deep.background)?.id).toBe("deep-ocean");
  });

  it("applies theme title/body colors across one or all slides while preserving typography overrides", () => {
    const mint = getSlideTheme("fresh-mint")!;
    const single = applyThemeToPageTextStyle(
      {
        title: { fontSize: 48, bold: true, align: "center", color: "#111111" },
        body: { italic: true, fontSize: 24 },
      },
      mint,
    );
    expect(single).toEqual({
      title: { fontSize: 48, bold: true, align: "center", color: "#14532d" },
      body: { italic: true, fontSize: 24, color: "#3f6212" },
    });

    const all = applyThemeToTextStyles(
      { 1: { title: { fontSize: 44 } }, 99: { body: { bold: true } } },
      [1, 2, 3],
      mint,
    );
    expect(all[1]).toEqual({
      title: { fontSize: 44, color: "#14532d" },
      body: { color: "#3f6212" },
    });
    expect(all[2]).toEqual({
      title: { color: "#14532d" },
      body: { color: "#3f6212" },
    });
    expect(all[3]).toEqual({
      title: { color: "#14532d" },
      body: { color: "#3f6212" },
    });
    expect(all[99]).toEqual({ body: { bold: true } });
  });

  it("renders theme cards and apply-all control in SlideFormatPanel", () => {
    const html = renderToStaticMarkup(
      createElement(SlideFormatPanel, {
        background: "#0f1f3d",
        layout: "",
        shapes: [],
        usedColors: ["#0f1f3d"],
        textStyle: { title: { color: "#ffffff" }, body: { color: "#cbd5e1" } },
        transition: "fade",
        canEdit: true,
        busy: false,
        applying: false,
        onChange: () => {},
        onLayoutChange: () => {},
        onMore: () => {},
        onApplyAll: () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain("主题方案");
    expect(html).toContain("主题应用到全部");
    for (const theme of SLIDE_THEMES) {
      expect(html).toContain(`data-slide-theme-card="${theme.id}"`);
      expect(html).toContain(theme.name);
    }
    expect(html).toContain('data-slide-theme-card="deep-ocean" aria-pressed="true"');
  });

  it("syncs custom title/body text styles into SlideSurface and PresenterView using cqw units", () => {
    const customStyle = {
      title: { fontSize: 48, bold: false, italic: true, color: "#3370ff", align: "right" as const },
      body: { fontSize: 24, bold: true, italic: true, color: "#cbd5e1", align: "center" as const },
    };
    const surfaceHtml = renderToStaticMarkup(
      createElement(SlideSurface, { content: samplePage, textStyle: customStyle }),
    );
    expect(surfaceHtml).toContain("font-size:5cqw");
    expect(surfaceHtml).toContain("font-weight:400");
    expect(surfaceHtml).toContain("font-style:italic");
    expect(surfaceHtml).toContain("color:#3370ff");
    expect(surfaceHtml).toContain("text-align:right");
    expect(surfaceHtml).toContain("font-size:2.5cqw");
    expect(surfaceHtml).toContain("font-weight:700");
    expect(surfaceHtml).toContain("color:#cbd5e1");
    expect(surfaceHtml).toContain("text-align:center");

    const presenterHtml = renderToStaticMarkup(
      createElement(PresenterView, {
        pages: [samplePage],
        currentId: samplePage.id,
        content: samplePage,
        contentFor: () => samplePage,
        textStyles: { [samplePage.id]: customStyle },
        onSelect: () => {},
        onExit: () => {},
      }),
    );
    expect(presenterHtml).toContain("font-size:5cqw");
    expect(presenterHtml).toContain("color:#3370ff");
    expect(presenterHtml).toContain("font-size:2.5cqw");
    expect(presenterHtml).toContain("color:#cbd5e1");
  });
});
