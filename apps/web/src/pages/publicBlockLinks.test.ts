import { describe, expect, it } from "vitest";
import { publicBlockKey, publicBlockLink } from "./publicBlockLinks";

describe("public document block links", () => {
  it("keeps the share token in the fragment and reads a valid block id", () => {
    const href = publicBlockLink("https://example.test/app/#/p/abc123?block=1%3A2", "abc123", "3:9");
    expect(href).toBe("https://example.test/app/#/p/abc123?block=3%3A9");
    expect(publicBlockKey("#/p/abc123?block=3%3A9", "abc123")).toBe("3:9");
  });
  it("rejects another token, ambiguous parameters, malformed and oversized ids", () => {
    for (const hash of ["#/p/other?block=1%3A2", "#/p/abc123?block=1%3A2&block=2%3A3", "#/p/abc123?block=bad", "#/p/abc123?block=9007199254740992%3A2", "#/doc/1?block=1%3A2"]) expect(publicBlockKey(hash, "abc123")).toBeNull();
    expect(publicBlockLink("https://example.test/#/p/other", "abc123", "1:2")).toBeNull();
    expect(publicBlockLink("https://example.test/#/p/abc123", "abc123", "bad")).toBeNull();
  });
});
