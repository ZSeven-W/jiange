import { describe, expect, it } from "vitest";
import type { SlidesPage } from "@/lib/api";
import { playableSlides, presentationStart } from "./slidesVisibility";

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
