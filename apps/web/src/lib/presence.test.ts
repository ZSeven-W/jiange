import { describe, expect, it } from "vitest";
import { colorFor, cpIndex, initial, utf16Index } from "./presence";

describe("presence helpers", () => {
  it("converts between UTF-16 and code point indices", () => {
    const s = "a😀b汉";
    expect(cpIndex(s, 0)).toBe(0);
    expect(cpIndex(s, 3)).toBe(2);
    expect(utf16Index(s, 2)).toBe(3);
    for (let cp = 0; cp <= 4; cp++) expect(cpIndex(s, utf16Index(s, cp))).toBe(cp);
  });
  it("derives initials and stable colors", () => {
    expect(initial("kay")).toBe("K");
    expect(initial("阿离")).toBe("阿");
    expect(colorFor(3)).toBe(colorFor(3));
  });
});
