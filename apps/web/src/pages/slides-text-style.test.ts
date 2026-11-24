import { describe, expect, it } from "vitest";
import type { SlidesPage } from "@/lib/api";
import {
  buildSlidePageMeta,
  hydrateSlideTextStyles,
  normalizeSlideFieldTextStyle,
} from "./slides-text-style";

function makePage(id: number, meta?: SlidesPage["meta"]): SlidesPage {
  return {
    id,
    slidesId: 7,
    pos: id,
    title: "",
    body: "",
    background: "",
    notes: "",
    shapes: [],
    hidden: false,
    revision: 1,
    updatedAt: "",
    ...(meta !== undefined ? { meta } : {}),
  };
}

describe("slides text style cloud hydration and meta building", () => {
  it("normalizes valid field text styles and strips invalid or out-of-range values", () => {
    expect(normalizeSlideFieldTextStyle(undefined)).toBeUndefined();
    expect(normalizeSlideFieldTextStyle({})).toBeUndefined();
    expect(
      normalizeSlideFieldTextStyle({
        fontSize: 48,
        bold: true,
        italic: false,
        color: "#3370ff",
        align: "center",
      }),
    ).toEqual({
      fontSize: 48,
      bold: true,
      italic: false,
      color: "#3370ff",
      align: "center",
    });

    // Rejects invalid color/fontSize/align while keeping valid properties
    expect(
      normalizeSlideFieldTextStyle({
        fontSize: 200,
        color: "red",
        align: "justify" as "left",
        italic: true,
      }),
    ).toEqual({ italic: true });

    expect(
      normalizeSlideFieldTextStyle({
        fontSize: 8,
        color: "#fff",
      }),
    ).toBeUndefined();
  });

  it("hydrates per-page title/body text styles directly from cloud page.meta", () => {
    const pages: SlidesPage[] = [
      makePage(1),
      makePage(2, {
        titleStyle: { fontSize: 44, bold: true, color: "#ffffff", align: "center" },
        bodyStyle: { fontSize: 20, color: "#cbd5e1" },
        transition: "fade",
      }),
      makePage(3, {
        transition: "push",
      }),
    ];

    expect(hydrateSlideTextStyles(pages)).toEqual({
      2: {
        title: { fontSize: 44, bold: true, color: "#ffffff", align: "center" },
        body: { fontSize: 20, color: "#cbd5e1" },
      },
    });
    expect(hydrateSlideTextStyles(undefined)).toEqual({});
  });

  it("builds normalized cloud SlidePageMeta payloads omitting defaults and empty groups", () => {
    expect(buildSlidePageMeta(undefined, "none", undefined)).toEqual({});
    expect(
      buildSlidePageMeta(
        { title: {}, body: { color: "invalid" } },
        "none",
        { singleton: ["only-one"] },
      ),
    ).toEqual({});

    expect(
      buildSlidePageMeta(
        {
          title: { fontSize: 54, bold: true, color: "#14532d" },
          body: { italic: true, align: "right", color: "#3f6212" },
        },
        "wipe",
        {
          "grp-1": ["s1", "s2", "s1"],
          "grp-bad": ["single"],
        },
      ),
    ).toEqual({
      titleStyle: { fontSize: 54, bold: true, color: "#14532d" },
      bodyStyle: { italic: true, align: "right", color: "#3f6212" },
      transition: "wipe",
      shapeGroups: { "grp-1": ["s1", "s2"] },
    });
  });
});
