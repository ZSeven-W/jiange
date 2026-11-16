import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc";
import { idKey, parseKey } from "../src/id";
import fixture from "./fixtures/read-only-projection.json";

describe("Go read-only projection interoperability", () => {
  it("renders visible text and formatting while retaining visible character anchors", () => {
    const bytes = Uint8Array.from(Buffer.from(fixture.state, "base64"));
    const doc = Doc.fromState(6, bytes);
    expect(doc.view()).toEqual(fixture.view);
    const paragraph = parseKey("4:2");
    expect([1, 2, 3, 4].map((index) => idKey(doc.anchorAt(paragraph, index).char))).toEqual(["4:3", "4:5", "4:6", "4:7"]);
    expect(doc.resolveAnchor(paragraph, { char: parseKey("4:6"), side: 1 })).toBe(3);
    expect(Buffer.from(bytes).toString("utf8")).not.toMatch(/SECRET|密/);
  });
});
