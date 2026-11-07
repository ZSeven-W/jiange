import { describe, expect, it } from "vitest";
import type { Field } from "@/lib/api";
import { mergeVisibleFieldOrder, planFieldReorder } from "./fieldReorder";

const fields: Field[] = [1, 2, 3].map((id) => ({ id, name: String(id), type: "text", position: id }));
const ids = [1, 2, 3];

describe("field drag ordering", () => {
  it("translates original boundaries correctly when moving right or left", () => {
    expect(planFieldReorder(fields, 1, 2, ids)).toEqual({ kind: "move", desiredIds: [2, 1, 3] });
    expect(planFieldReorder(fields, 1, 3, ids)).toEqual({ kind: "move", desiredIds: [2, 3, 1] });
    expect(planFieldReorder(fields, 3, 1, ids)).toEqual({ kind: "move", desiredIds: [1, 3, 2] });
    expect(planFieldReorder(fields, 3, 0, ids)).toEqual({ kind: "move", desiredIds: [3, 1, 2] });
  });
  it("does not send a write for no-op, stale order or invalid boundaries", () => {
    expect(planFieldReorder(fields, 2, 1, ids)).toEqual({ kind: "noop" });
    expect(planFieldReorder(fields, 2, 2, ids)).toEqual({ kind: "noop" });
    expect(planFieldReorder([fields[1], fields[0], fields[2]], 1, 2, ids)).toEqual({ kind: "stale" });
    expect(planFieldReorder(fields, 1, 4, ids)).toEqual({ kind: "invalid" });
  });
  it("keeps the primary field fixed while allowing other fields to move", () => {
    const withPrimary = fields.map((field, i) => ({ ...field, isPrimary: i === 0 }));
    expect(planFieldReorder(withPrimary, 1, 3, ids)).toEqual({ kind: "invalid" });
    expect(planFieldReorder(withPrimary, 3, 0, ids)).toEqual({ kind: "invalid" });
    expect(planFieldReorder(withPrimary, 3, 1, ids)).toEqual({ kind: "move", desiredIds: [1, 3, 2] });
    const legacy = [fields[0], { ...fields[1], isPrimary: true }, fields[2]];
    expect(planFieldReorder(legacy, 1, 3, ids)).toEqual({ kind: "invalid" });
    expect(planFieldReorder(legacy, 3, 0, ids)).toEqual({ kind: "invalid" });
  });
  it("keeps hidden fields in their slots and rejects incomplete or stale orders", () => {
    expect(mergeVisibleFieldOrder([1, 4, 2, 3], [1, 2, 3], [2, 1, 3])).toEqual([2, 4, 1, 3]);
    expect(mergeVisibleFieldOrder([1, 4, 2, 3], [2, 1, 3], [2, 1, 3])).toBeNull();
    expect(mergeVisibleFieldOrder([1, 4, 2, 3], [1, 2, 3], [2, 1, 9])).toBeNull();
    expect(mergeVisibleFieldOrder([1, 4, 2, 3], [1, 2, 3], [2, 1, 1])).toBeNull();
  });
});
