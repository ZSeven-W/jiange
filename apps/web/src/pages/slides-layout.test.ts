import { describe, expect, it } from "vitest";
import { blankSlideLayout, hasLargeSlideTitle, isBlankSlideLayout } from "./slides-layout";

describe("slide blank layout", () => {
  it("retains the source text geometry and recognises both blank variants", () => {
    expect(blankSlideLayout("")).toBe("blank");
    expect(blankSlideLayout("title")).toBe("blank-title");
    expect(blankSlideLayout("blank-title")).toBe("blank-title");
    expect(isBlankSlideLayout("blank")).toBe(true);
    expect(isBlankSlideLayout("blank-title")).toBe(true);
    expect(isBlankSlideLayout("title")).toBe(false);
    expect(hasLargeSlideTitle("blank-title")).toBe(true);
    expect(hasLargeSlideTitle("blank")).toBe(false);
  });
});
