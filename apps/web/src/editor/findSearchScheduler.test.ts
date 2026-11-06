import { afterEach, describe, expect, it, vi } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { scheduleFindSnapshot, type FindSnapshot } from "./findSearchScheduler";

afterEach(() => vi.useRealTimers());

describe("find snapshot scheduling", () => {
  it("coalesces rapid query and remote updates into the latest snapshot", () => {
    vi.useFakeTimers();
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const block = tx.create("paragraph", null, ROOT);
    tx.insert(block, 0, "前目标后");
    const delivered: FindSnapshot[] = [];
    const first = scheduleFindSnapshot(doc, "目", 1, (snapshot) => delivered.push(snapshot));
    vi.advanceTimersByTime(149);
    expect(delivered).toEqual([]);
    first();
    doc.insertText(block, 0, "远端");
    scheduleFindSnapshot(doc, "目标", 2, (snapshot) => delivered.push(snapshot));
    vi.advanceTimersByTime(149);
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].version).toBe(2);
    expect(delivered[0].query).toBe("目标");
    expect(delivered[0].matches.map((match) => match.text)).toEqual(["目标"]);
    expect(delivered[0].matches[0].start).toBe(3);
  });

  it("cancels pending work when the panel closes or the document changes", () => {
    vi.useFakeTimers();
    const doc = new Doc(1);
    const delivered = vi.fn();
    const cancel = scheduleFindSnapshot(doc, "内容", 1, delivered);
    cancel();
    vi.runAllTimers();
    expect(delivered).not.toHaveBeenCalled();
  });
});
