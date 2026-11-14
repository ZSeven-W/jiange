import { describe, expect, it } from "vitest";
import type { SlidesPage } from "@/lib/api";
import { applyBackgroundChangeReceipts, applyBackgroundReceipts, backgroundPopoverPosition } from "./slides-background";

const page = (id: number, background = ""): SlidesPage => ({ id, slidesId: 2, pos: id, title: `第${id}页`, body: "正文", notes: "备注", shapes: [], hidden: false, background, revision: 1, updatedAt: "2026-01-01T00:00:00Z" });

describe("background batch receipts", () => {
  it("keeps the palette above a low mobile trigger and within the viewport", () => {
    expect(backgroundPopoverPosition({ right: 370, top: 740, bottom: 768 }, 390, 844, 300)).toEqual({ left: 120, top: 436, width: 250, maxHeight: 400 });
    expect(backgroundPopoverPosition({ right: 280, top: 100, bottom: 128 }, 390, 844, 265).top).toBe(132);
  });
  it("merges a complete receipt without losing content or reordering pages", () => {
    const before = [page(2), page(1, "#112233")];
    const result = applyBackgroundReceipts(before, "#112233", [{ id: 1, revision: 1, updatedAt: "2026-01-02T00:00:00Z" }, { id: 2, revision: 2, updatedAt: "2026-01-02T00:00:00Z" }]);
    expect(result?.map((item) => [item.id, item.revision, item.background, item.body])).toEqual([[2, 2, "#112233", "正文"], [1, 1, "#112233", "正文"]]);
  });
  it("rejects incomplete, duplicate and unexpected revisions", () => {
    const before = [page(1), page(2)];
    const one = { id: 1, revision: 2, updatedAt: "2026-01-02T00:00:00Z" };
    expect(applyBackgroundReceipts(before, "#112233", [one])).toBeNull();
    expect(applyBackgroundReceipts(before, "#112233", [one, one])).toBeNull();
    expect(applyBackgroundReceipts(before, "#112233", [one, { ...one, id: 2, revision: 4 }])).toBeNull();
    expect(applyBackgroundReceipts([page(1), page(1)], "#112233", [one, { ...one, id: 2 }])).toBeNull();
  });
  it("validates heterogeneous restoration against each page's own target", () => {
    const before = [page(1, "#112233"), page(2, "#112233")];
    const targets = [{ id: 1, background: "" }, { id: 2, background: "#abcdef" }];
    const receipts = [{ id: 2, revision: 2, updatedAt: "2026-01-02T00:00:00Z" }, { id: 1, revision: 2, updatedAt: "2026-01-02T00:00:00Z" }];
    expect(applyBackgroundChangeReceipts(before, targets, receipts)?.map((item) => item.background)).toEqual(["", "#abcdef"]);
    expect(applyBackgroundChangeReceipts(before, [targets[0], targets[0]], receipts)).toBeNull();
  });
});
