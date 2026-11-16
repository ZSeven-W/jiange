import { describe, expect, it } from "vitest";
import { parseHash } from "./route";
import { savedVersionLink, validVersionEntryId, versionFromHash, withoutVersionHash, withVersionHash } from "./version-link";

describe("saved version links", () => {
  it("opens a specific entry without carrying unrelated URL parameters", () => {
    const link = savedVersionLink("https://example.test/app?secret=123#/doc/7", 7, "n:42");
    expect(link).toBe("https://example.test/app#/doc/7?version=n%3A42");
    expect(parseHash(new URL(link!).hash)).toEqual({ page: "doc", id: 7, versionId: "n:42" });
    expect(parseHash("#/doc/7?block=123")).toEqual({ page: "doc", id: 7 });
    expect(withoutVersionHash("#/doc/7?version=n%3A42&block=123")).toBe("#/doc/7?block=123");
    expect(withVersionHash("#/doc/7?version=n%3A42&block=123", "n:43")).toBe("#/doc/7?version=n%3A43&block=123");
    expect(withVersionHash("#/base/7", "n:43")).toBeNull();
  });
  it("rejects malformed, ambiguous and unsafe IDs without silently selecting another version", () => {
    for (const value of ["n:0", "n:01", "n:9007199254740992", "s:-1", "other:1"]) expect(validVersionEntryId(value)).toBe(false);
    expect(versionFromHash("#/doc/7?version=n%3A0")).toBeNull();
    expect(versionFromHash("#/doc/7?version=n%3A1&version=n%3A2")).toBeNull();
    expect(savedVersionLink("https://example.test/", 7, "n:0")).toBeNull();
    expect(savedVersionLink("javascript:alert(1)", 7, "n:1")).toBeNull();
  });
});
