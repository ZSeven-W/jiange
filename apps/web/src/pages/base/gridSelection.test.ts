import { describe, expect, it, vi } from "vitest";
import type { BaseRecord, Field } from "@/lib/api";
import { batchTargetsAuthorized, captureGridSelection, validGridSelection, waitForBatchTargets, type BatchAccess } from "./gridSelection";

const records: BaseRecord[] = [1, 2, 3].map((id) => ({ id, baseId: 1, position: id, cells: { 1: `行${id}` } }));
const fields: Field[] = [1, 2, 3].map((id) => ({ id, name: `字段${id}`, type: "text", position: id }));

describe("grid selection identity", () => {
  it("retains a rectangle only while the visible record and field order is unchanged", () => {
    const selection = captureGridSelection({ ar: 0, af: 0, rr: 1, rf: 1 }, records, fields)!;
    expect(validGridSelection(selection, records.map((r) => ({ ...r, cells: { 1: "新值" } })), [...fields])).toBe(true);
    expect(validGridSelection(selection, [records[1], records[0], records[2]], fields)).toBe(false);
    expect(validGridSelection(selection, records.slice(1), fields)).toBe(false);
    expect(validGridSelection(selection, [...records, { ...records[0], id: 4 }], fields)).toBe(false);
    expect(validGridSelection(selection, records, [fields[1], fields[0], fields[2]])).toBe(false);
    expect(validGridSelection(selection, records, fields.slice(1))).toBe(false);
  });

  it("rejects out-of-bounds or stale selection instead of targeting a replacement row", () => {
    expect(captureGridSelection({ ar: 0, af: 0, rr: 3, rf: 0 }, records, fields)).toBeNull();
    expect(captureGridSelection({ ar: 0, af: -1, rr: 0, rf: 0 }, records, fields)).toBeNull();
    const selection = captureGridSelection({ ar: 1, af: 0, rr: 1, rf: 0 }, records, fields)!;
    expect(validGridSelection(selection, [records[0], records[2]], fields)).toBe(false);
  });

  it("keeps already-captured batch IDs stable across self-triggered reordering but stops on permission loss", () => {
    expect(batchTargetsAuthorized([1, 2], [1, 2], [records[1], records[0], records[2]], fields)).toBe(true);
    expect(batchTargetsAuthorized([1, 2], [1, 2], [records[0], records[2]], fields)).toBe(false);
    expect(batchTargetsAuthorized([1, 2], [1, 2], records, [fields[0], fields[2]])).toBe(false);
  });
  it("waits through a self-triggered refresh and resumes only with authorized targets", async () => {
    vi.useFakeTimers();
    try {
      let current: BatchAccess = { baseId: 1, mounted: true, canEdit: true, detailAccessReady: false, selectionAccessReady: false, authorizedRecords: records, fields };
      const wait = waitForBatchTargets(() => current, 1, [1, 2], [1, 2]);
      current = { ...current, detailAccessReady: true, selectionAccessReady: true, authorizedRecords: [records[1], records[0], records[2], { ...records[0], id: 4 }] };
      await vi.advanceTimersByTimeAsync(50);
      await expect(wait).resolves.toBe(true);
      current = { ...current, detailAccessReady: false };
      const denied = waitForBatchTargets(() => current, 1, [1, 2], [1, 2]);
      current = { ...current, detailAccessReady: true, authorizedRecords: [records[0]] };
      await vi.advanceTimersByTimeAsync(50);
      await expect(denied).resolves.toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("stops waiting on timeout or unmount without issuing further writes", async () => {
    vi.useFakeTimers();
    try {
      let current: BatchAccess = { baseId: 1, mounted: true, canEdit: true, detailAccessReady: false, selectionAccessReady: false, authorizedRecords: records, fields };
      const timed = waitForBatchTargets(() => current, 1, [1], [1], 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(timed).resolves.toBe(false);
      const closed = waitForBatchTargets(() => current, 1, [1], [1]);
      current = { ...current, mounted: false };
      await vi.advanceTimersByTimeAsync(50);
      await expect(closed).resolves.toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
