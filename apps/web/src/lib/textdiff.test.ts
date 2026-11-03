import { describe, expect, it } from "vitest";
import { diff } from "./textdiff";

describe("diff", () => {
  it("finds a single changed region", () => {
    expect(diff("hello", "hello")).toBeNull();
    expect(diff("hello", "help")).toEqual({ index: 3, remove: 2, insert: "p" });
    expect(diff("", "飞书🙂")).toEqual({ index: 0, remove: 0, insert: "飞书🙂" });
    expect(diff("a🙂b", "ab")).toEqual({ index: 1, remove: 1, insert: "" });
  });
});
