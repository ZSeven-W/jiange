import { describe, expect, it } from "vitest";
import type { SlidesPage } from "../src/model.js";
import { playableSlides, presentationStart, presentationKeyTarget } from "../src/visibility.js";

const page = (id: number, hidden: boolean): SlidesPage => ({ id, slidesId: 1, pos: id, title: "", body: "", background: "", notes: "", shapes: [], hidden, revision: 1, updatedAt: "" });

describe("presentation visibility", () => {
  it("skips hidden pages without changing their order", () => {
    const slides = [page(1, false), page(2, true), page(3, false)];
    expect(playableSlides(slides).map((p) => p.id)).toEqual([1, 3]);
    expect(presentationStart(slides, 1)?.id).toBe(1);
    expect(presentationStart(slides, 2)?.id).toBe(3);
    expect(presentationStart(slides, 99)?.id).toBe(1);
  });
  it("wraps after a hidden last page and rejects an all-hidden deck", () => {
    expect(presentationStart([page(1, false), page(2, true)], 2)?.id).toBe(1);
    expect(presentationStart([page(1, true)], 1)).toBeNull();
    expect(presentationStart([], null)).toBeNull();
  });
});

describe("presentation keyboard navigation", () => {
  const pages = [page(1, false), page(2, true), page(3, false), page(4, false)];
  it("skips hidden pages and respects the ends of the deck", () => {
    expect(presentationKeyTarget(pages, 1, " ")?.id).toBe(3);
    expect(presentationKeyTarget(pages, 3, "PageUp")?.id).toBe(1);
    expect(presentationKeyTarget(pages, 3, "Home")?.id).toBe(1);
    expect(presentationKeyTarget(pages, 1, "End")?.id).toBe(4);
    expect(presentationKeyTarget(pages, 4, "PageDown")?.id).toBe(4);
    expect(presentationKeyTarget(pages, 1, "ArrowLeft")?.id).toBe(1);
    expect(presentationKeyTarget(pages, 2, "Enter")).toBeNull();
    expect(presentationKeyTarget(pages, 1, "a")).toBeNull();
  });
});
