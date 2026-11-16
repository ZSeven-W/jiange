import { describe, expect, it } from "vitest";
import type { BaseRecord, Field, User } from "@/lib/api";
import { memberName, personIDs, personRuleIDs, recordTitle, REGISTRY } from "./registry";
import { matchRule } from "./fill";
import { planPaste, rangeText, toText } from "./tsv";

const members: User[] = [
  { id: 7, name: "张三", email: "", createdAt: "" },
  { id: 9, name: "李四", email: "", createdAt: "" },
];
const single = (multiple?: boolean): Field => ({ id: 1, name: "人员", type: "person", position: 1, multiple });
const rec = (cells: BaseRecord["cells"]): BaseRecord => ({ id: 2, baseId: 1, position: 1, cells, creatorId: 7 });

describe("person field registry (允许多选)", () => {
  it("normalizes scalar and array cells into ids", () => {
    expect(personIDs(7)).toEqual([7]);
    expect(personIDs([7, 9])).toEqual([7, 9]);
    expect(personIDs(0)).toEqual([]);
    expect(personIDs(undefined)).toEqual([]);
    expect(personIDs(["a"])).toEqual([]);
  });

  it("parses member names and legacy digit ids, respecting the single/multiple mode", () => {
    expect(REGISTRY.person.parse("张三", single(), members)).toBe(7);
    expect(REGISTRY.person.parse("张三、李四", single(true), members)).toEqual([7, 9]);
    expect(REGISTRY.person.parse("张三,李四", single(true), members)).toEqual([7, 9]);
    expect(REGISTRY.person.parse("7", single(), members)).toBe(7);
    expect(REGISTRY.person.parse("张三、李四", single(), members)).toBeUndefined(); // single mode: one member only
    expect(REGISTRY.person.parse("路人", single(true), members)).toBeUndefined(); // unknown member
    expect(REGISTRY.person.parse("", single(true), members)).toBeNull();
  });

  it("formats names joined by 、 and falls back to ids without members", () => {
    expect(REGISTRY.person.format([7, 9], single(true), members)).toBe("张三、李四");
    expect(REGISTRY.person.format(7, single(), members)).toBe("张三");
    expect(REGISTRY.person.format([7, 9], single(true))).toBe("7,9");
    expect(REGISTRY.person.format(undefined, single(), members)).toBe("");
  });

  it("compares by the first member id", () => {
    expect(REGISTRY.person.compare([9], [7], single(true))).toBeGreaterThan(0);
    expect(REGISTRY.person.compare(2, 7, single())).toBeLessThan(0);
  });

  it("joins array member names in the record title and omits unknown ids", () => {
    expect(recordTitle(rec({ 1: [7, 9] }), [single(true)], members)).toBe("张三、李四");
    expect(recordTitle(rec({ 1: [7, 9] }), [single(true)], [members[0]])).toBe("张三");
    expect(recordTitle(rec({ 1: 7 }), [single()], members)).toBe("张三");
    expect(memberName(9, members)).toBe("李四");
  });

  it("normalizes saved filter values", () => {
    expect(personRuleIDs(7)).toEqual([7]);
    expect(personRuleIDs("7")).toEqual([7]);
    expect(personRuleIDs([7, 9])).toEqual([7, 9]);
    expect(personRuleIDs("abc")).toEqual([]);
  });
});

describe("person fill rules (填色)", () => {
  it("matches membership on scalar and array cells", () => {
    expect(matchRule(rec({ 1: [7, 9] }), single(true), { op: "contains", v: [9] }, members)).toBe(true);
    expect(matchRule(rec({ 1: [7, 9] }), single(true), { op: "contains", v: [2] }, members)).toBe(false);
    expect(matchRule(rec({ 1: [7, 9] }), single(true), { op: "not_contains", v: [2] }, members)).toBe(true);
    expect(matchRule(rec({ 1: 7 }), single(), { op: "is", v: 7 }, members)).toBe(true);
    expect(matchRule(rec({ 1: 7 }), single(), { op: "is_not", v: 7 }, members)).toBe(false);
    expect(matchRule(rec({}), single(), { op: "is", v: 7 }, members)).toBe(false);
  });
});

describe("person TSV copy/paste", () => {
  it("copies member names and pastes them back to ids", () => {
    expect(toText(single(true), [7, 9], members)).toBe("张三、李四");
    const plan = planPaste([rec({ 1: [7] })], [single(true)], 0, 0, "张三、李四", members);
    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].cells[1]).toEqual([7, 9]);
    // Unknown names and single-mode overflow skip the cell.
    const bad = planPaste([rec({ 1: [7] })], [single(true)], 0, 0, "张三、路人", members);
    expect(bad.patches).toHaveLength(0);
    expect(bad.skipped).toHaveLength(1);
    const overflow = planPaste([rec({ 1: 7 })], [single()], 0, 0, "张三、李四", members);
    expect(overflow.patches).toHaveLength(0);
    const legacy = planPaste([rec({ 1: 7 })], [single()], 0, 0, "9", members);
    expect(legacy.patches[0].cells[1]).toBe(9);
    expect(rangeText([rec({ 1: [7, 9] })], [single(true)], members, 0, 0, 0, 0)).toBe("张三、李四");
  });
});
