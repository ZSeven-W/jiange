import { describe, expect, it } from "vitest";
import type { DocMeta, SlidesPage } from "@/lib/api";
import { encodeSlideClipboard, mayCopySlide, parseSlideClipboard, verifyCrossSlidePaste } from "./slides-clipboard";

describe("slide clipboard reference", () => {
  it("round trips only the origin, account, deck, page and version", () => {
    const value = { origin: "https://jiange.example", userId: 1, deckId: 2, pageId: 3, revision: 4 };
    expect(parseSlideClipboard(encodeSlideClipboard(value))).toEqual(value);
    expect(encodeSlideClipboard(value)).not.toContain("正文");
  });
  it("rejects external text, extra fields and invalid identifiers", () => {
    expect(parseSlideClipboard("hello")).toBeNull();
    expect(parseSlideClipboard('JIANGE_SLIDE_V1:{"origin":"https://jiange.example","userId":1,"deckId":2,"pageId":3,"revision":4,"extra":1}')).toBeNull();
    expect(parseSlideClipboard(encodeSlideClipboard({ origin: "https://jiange.example", userId: 1, deckId: 2, pageId: 0, revision: 4 }))).toBeNull();
    expect(parseSlideClipboard(encodeSlideClipboard({ origin: "https://jiange.example/path", userId: 1, deckId: 2, pageId: 3, revision: 4 }))).toBeNull();
    expect(parseSlideClipboard("JIANGE_SLIDE_V1:" + "x".repeat(1024))).toBeNull();
  });
  it("respects a source's copy permission", () => {
    const meta = { kind: "slides", role: "view" } as DocMeta;
    expect(mayCopySlide(meta)).toBe(true);
    expect(mayCopySlide({ ...meta, copyProtected: true })).toBe(false);
    expect(mayCopySlide({ ...meta, role: "edit", copyMinRole: "manage" })).toBe(false);
    expect(mayCopySlide({ ...meta, role: "manage", copyProtected: true })).toBe(true);
  });
  it("accepts only exact content with a complete image mapping", () => {
    const source: SlidesPage = { id: 3, slidesId: 2, pos: 1, title: "标题", body: "正文", notes: "备注", background: "", layout: "blank", shapes: [{ id: "i", kind: "image", x: 1, y: 1, color: "#ffffff", fileId: 8 }], hidden: false, revision: 2, updatedAt: "" };
    const page = { ...source, id: 5, slidesId: 4, pos: 2, revision: 1, shapes: [{ ...source.shapes[0], fileId: 9 }] };
    expect(verifyCrossSlidePaste(source, 4, { page, mapping: { "8": 9 } })).toEqual(page);
    expect(verifyCrossSlidePaste(source, 4, { page, mapping: {} })).toBeNull();
    expect(verifyCrossSlidePaste(source, 4, { page: { ...page, body: "丢失" }, mapping: { "8": 9 } })).toBeNull();
    expect(verifyCrossSlidePaste(source, 4, { page, mapping: { "8": 8 } })).toBeNull();
  });
});
