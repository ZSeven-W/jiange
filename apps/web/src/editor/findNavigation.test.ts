import { describe, expect, it } from "vitest";
import { FindScrollIntent } from "./findNavigation";

describe("find scroll intent", () => {
  it("does not request another scroll when remote updates change the result index", () => {
    const intent = new FindScrollIntent();
    const opened = intent.request();
    expect(intent.pending(true)).toBe(opened);
    expect(intent.complete(opened)).toBe(true);
    // Results become stale, are recomputed, and their active index may change.
    expect(intent.pending(false)).toBeNull();
    expect(intent.pending(true)).toBeNull();
  });

  it("waits for the latest search and does not consume a newer request", () => {
    const intent = new FindScrollIntent();
    const first = intent.request();
    expect(intent.pending(false)).toBeNull();
    const second = intent.request();
    expect(intent.complete(first)).toBe(false);
    expect(intent.pending(false)).toBeNull();
    expect(intent.pending(true)).toBe(second);
    expect(intent.complete(second)).toBe(true);
    expect(intent.pending(true)).toBeNull();
  });
});
