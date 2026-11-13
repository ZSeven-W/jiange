import { beforeEach, describe, expect, it } from "vitest";
import { docWidthClass, readDocWidth, writeDocWidth } from "./docWidth";

describe("document width preference", () => {
  beforeEach(() => localStorage.clear());
  it("keeps the previous full-width setting and scopes preferences to account and document", () => {
    localStorage.setItem("jiange:doc-wide:1:2", "1");
    expect(readDocWidth(1, 2)).toBe("full");
    expect(readDocWidth(1, 3)).toBe("default");
    expect(readDocWidth(2, 2)).toBe("default");
    writeDocWidth(1, 2, "wider");
    expect(readDocWidth(1, 2)).toBe("wider");
    expect(docWidthClass(readDocWidth(1, 2))).toBe("max-w-[1200px]");
    writeDocWidth(1, 2, "default");
    expect(readDocWidth(1, 2)).toBe("default");
    expect(localStorage.getItem("jiange:doc-wide:1:2")).toBeNull();
  });
  it("treats unrecognised stored data as the default", () => {
    localStorage.setItem("jiange:doc-wide:1:2", "garbage");
    expect(readDocWidth(1, 2)).toBe("default");
  });
});
