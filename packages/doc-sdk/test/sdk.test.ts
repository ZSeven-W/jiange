import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { bodyBlocks, copyRange, splitBlock } from "../src/index.js";

describe("headless document model", () => {
  it("splits and copies collaborative text without a DOM", () => {
    const doc = new Doc(1), tx = new Tx(doc), block = tx.create("paragraph", null, ROOT);
    tx.insert(block, 0, "协作指南");
    const next = splitBlock(tx, { b: block, o: 2 });
    expect(bodyBlocks(doc)).toHaveLength(2);
    expect(doc.text(block)).toBe("协作");
    expect(doc.text(next.b)).toBe("指南");
    expect(copyRange(doc, { a: { b: next.b, o: 0 }, f: { b: next.b, o: 2 } })[0].chars.map((c) => c.ch).join("")).toBe("指南");
  });
});
