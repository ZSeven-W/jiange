import { describe, expect, it } from "vitest";
import { formatTSV, fromText, parseTSV, planPaste, rangeText, toText } from "./tsv";
import type { BaseRecord, Field } from "@/lib/api";

const fields: Field[] = [
  { id: 1, name: "标题", type: "text", position: 1 },
  { id: 2, name: "状态", type: "select", options: ["待办", "完成"], position: 2 },
  { id: 3, name: "估时", type: "number", position: 3 },
  { id: 4, name: "完成", type: "checkbox", position: 4 },
];
const recs: BaseRecord[] = [
  { id: 11, position: 1, cells: { 1: "拖拽", 2: "完成", 3: 10, 4: true } },
  { id: 12, position: 2, cells: { 1: "分享" } },
];

describe("parseTSV", () => {
  it("splits on tabs and newlines, drops the trailing newline", () => {
    expect(parseTSV("a\tb\nc\td\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
  it("keeps CRLF out of cells", () => {
    expect(parseTSV("a\tb\r\nc")).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });
  it("supports quoted cells with embedded tabs, newlines and escaped quotes", () => {
    expect(parseTSV('"a\tb"\t"x""y"\n"line1\nline2"')).toEqual([
      ["a\tb", 'x"y'],
      ["line1\nline2"],
    ]);
  });
  it("round-trips through formatTSV", () => {
    const rows = [
      ["plain", 'has "quote"', "tab\there", "nl\nhere"],
      ["", "2", "3"],
    ];
    expect(parseTSV(formatTSV(rows))).toEqual(rows);
  });
});

describe("cell text conversion", () => {
  it("renders checkbox as TRUE/FALSE and others as strings", () => {
    expect(toText(fields[0], "hi")).toBe("hi");
    expect(toText(fields[2], 10)).toBe("10");
    expect(toText(fields[3], true)).toBe("TRUE");
    expect(toText(fields[3], false)).toBe("FALSE");
    expect(toText(fields[0], undefined)).toBe("");
  });
  it("parses per type and skips invalid values", () => {
    expect(fromText(fields[2], "3.5")).toBe(3.5);
    expect(fromText(fields[2], "abc")).toBeUndefined();
    expect(fromText(fields[2], "")).toBeNull();
    expect(fromText(fields[1], "待办")).toBe("待办");
    expect(fromText(fields[1], "不存在")).toBeUndefined();
    expect(fromText(fields[3], "TRUE")).toBe(true);
    expect(fromText(fields[3], "0")).toBeNull();
    expect(fromText(fields[3], "也许")).toBeUndefined();
  });
});

describe("planPaste", () => {
  it("patches existing rows and creates the missing tail rows", () => {
    const plan = planPaste(recs, fields, 1, 0, "新任务\t待办\t3\ttrue\n再来\t完成\t2\tFALSE");
    expect(plan.patches).toEqual([{ rid: 12, cells: { 1: "新任务", 2: "待办", 3: 3, 4: true } }]);
    expect(plan.addRows).toEqual([{ cells: { 1: "再来", 2: "完成", 3: 2, 4: null } }]);
  });
  it("skips invalid cells instead of failing the row", () => {
    const plan = planPaste(recs, fields, 0, 2, "5\tnope\n6\t7");
    expect(plan.patches).toEqual([
      { rid: 11, cells: { 3: 5 } },
      { rid: 12, cells: { 3: 6 } },
    ]);
  });
});

describe("rangeText", () => {
  it("serializes a rectangle with headers and empties", () => {
    expect(rangeText(recs, fields, 0, 1, 0, 1)).toBe("拖拽\t完成\n分享\t");
  });
});
