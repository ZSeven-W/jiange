import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "../src/index.js";

describe("client-participating tombstone GC barrier", () => {
  it("prunes leaf tombstones at or below barrierClock while preserving live text, mark anchors, and newer tombstones", () => {
    const doc = new Doc(1);
    const tx1 = new Tx(doc);
    const block = tx1.create("paragraph", null, ROOT);
    tx1.insert(block, 0, "abcdefghij");
    // Delete 'e'..'j' (6 trailing chars -> leaf tombstones)
    const tx2 = new Tx(doc);
    tx2.delete(block, 4, 10);

    expect(doc.tombstoneStats()).toEqual({ liveChars: 4, tombstones: 6 });

    // Barrier at clock 0 removes nothing
    expect(doc.compactAtBarrier(0)).toBe(0);

    // Compact at current clock removes all 6 leaf tombstones
    const barrierClock = tx2.ops.at(-1)!.id.clock;
    const removed = doc.compactAtBarrier(barrierClock);
    expect(removed).toBe(6);
    expect(doc.tombstoneStats()).toEqual({ liveChars: 4, tombstones: 0 });
    expect(doc.text(block)).toBe("abcd");

    // Subsequent edits after coordinated compaction still work cleanly
    const tx3 = new Tx(doc);
    tx3.insert(block, 4, "!");
    expect(doc.text(block)).toBe("abcd!");
  });

  it("retains tombstones anchored by marks", () => {
    const doc = new Doc(2);
    const tx1 = new Tx(doc);
    const block = tx1.create("paragraph", null, ROOT);
    tx1.insert(block, 0, "hello world");
    tx1.format(block, 0, 5, "bold", "1");
    const tx2 = new Tx(doc);
    tx2.delete(block, 0, 5);

    const before = doc.tombstoneStats();
    expect(before.tombstones).toBe(5);
    const removed = doc.compactAtBarrier(tx2.ops.at(-1)!.id.clock);
    // Anchor endpoints of the bold mark must be preserved
    expect(removed).toBeLessThan(5);
    expect(doc.text(block)).toBe(" world");
  });
});
