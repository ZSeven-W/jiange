import { describe, expect, it } from "vitest";
import { encodeSlideClipboard, parseSlideClipboard } from "./slides-clipboard";

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
});
