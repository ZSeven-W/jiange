import { describe, expect, it } from "vitest";
import { formatTableTSV, parseTableTSV, planTableAppendRow, planTableClear, planTableCut, planTablePaste } from "./tableClipboard";

describe("document table clipboard", () => {
  it("appends a blank row while preserving all existing cells", () => {
    const before = [["甲", "乙"], ["丙", "丁"]];
    expect(planTableAppendRow(before)).toEqual({ ok: true, changed: true, rows: [["甲", "乙"], ["丙", "丁"], ["", ""]] });
    expect(before).toEqual([["甲", "乙"], ["丙", "丁"]]);
    expect(planTableAppendRow(Array.from({ length: 200 }, () => ["x"]))).toMatchObject({ ok: false });
    expect(planTableAppendRow([["x"], ["x", "y"]])).toMatchObject({ ok: false });
  });
  it("round-trips tabs, quotes, empty cells and multiline text", () => {
    const rows = [["甲", "含\t制表符", ""], ["多\n行", '引号"内', "尾"]];
    const text = formatTableTSV(rows, { r0: 0, r1: 1, c0: 0, c1: 2 });
    expect(parseTableTSV(text + "\r\n")).toEqual(rows);
  });
  it("expands rows and columns without altering untouched cells", () => {
    const before = [["原", "保留"], ["下", "旧"]];
    const result = planTablePaste(before, [], 1, 1, "甲\t乙\r\n丙\t丁\r\n");
    expect(result).toEqual({ ok: true, changed: true, rows: [["原", "保留", ""], ["下", "甲", "乙"], ["", "丙", "丁"]] });
    expect(before).toEqual([["原", "保留"], ["下", "旧"]]);
  });
  it("rejects incompatible merged-cell or invalid quoted paste as one operation", () => {
    const before = [["保留", ""], ["下", "右"]];
    expect(planTablePaste(before, [[0, 0, 1, 2]], 0, 0, "甲\t乙")).toMatchObject({ ok: false, message: expect.stringContaining("合并") });
    expect(planTablePaste(before, [], 0, 0, '"未闭合\t内容')).toMatchObject({ ok: false });
    expect(before).toEqual([["保留", ""], ["下", "右"]]);
  });
  it("copies and cuts visible cells while preserving hidden merged content", () => {
    const before = [["合并内容", "隐藏数据"], ["甲", "乙"]];
    const merges: [number, number, number, number][] = [[0, 0, 1, 2]];
    const range = { r0: 0, r1: 1, c0: 0, c1: 1 };
    expect(formatTableTSV(before, range, merges)).toBe("合并内容\t\n甲\t乙");
    expect(planTableCut(before, merges, range)).toEqual({ ok: true, changed: true, rows: [["", "隐藏数据"], ["", ""]] });
    expect(planTableCut(before, merges, { r0: 0, r1: 0, c0: 0, c1: 0 })).toMatchObject({ ok: false, message: expect.stringContaining("合并") });
    expect(before).toEqual([["合并内容", "隐藏数据"], ["甲", "乙"]]);
  });
  it("clears the selected visible anchors without modifying hidden or unselected data", () => {
    const before = [["合并内容", "隐藏数据", "保留"], ["甲", "乙", "丙"]];
    const merges: [number, number, number, number][] = [[0, 0, 1, 2]];
    expect(planTableClear(before, merges, { r0: 1, r1: 0, c0: 1, c1: 0 })).toEqual({ ok: true, changed: true, rows: [["", "隐藏数据", "保留"], ["", "", "丙"]] });
    expect(planTableClear(before, merges, { r0: 0, r1: 0, c0: 0, c1: 0 })).toMatchObject({ ok: false, message: expect.stringContaining("合并") });
    expect(before).toEqual([["合并内容", "隐藏数据", "保留"], ["甲", "乙", "丙"]]);
  });
  it("rejects an oversized clear without modifying any cells", () => {
    const before = Array.from({ length: 21 }, () => Array(50).fill("保留"));
    expect(planTableClear(before, [], { r0: 0, r1: 20, c0: 0, c1: 49 })).toMatchObject({ ok: false, message: expect.stringContaining("清空") });
    expect(before.every((row) => row.every((cell) => cell === "保留"))).toBe(true);
  });
  it("pastes compatible rectangles into merged anchors without overwriting hidden cells", () => {
    const before = [["旧", "隐藏数据"], ["甲", "乙"]];
    const merges: [number, number, number, number][] = [[0, 0, 1, 2]];
    expect(planTablePaste(before, merges, 0, 0, "新\t\n丙\t丁")).toEqual({ ok: true, changed: true, rows: [["新", "隐藏数据"], ["丙", "丁"]] });
    expect(planTablePaste(before, merges, 0, 0, '"第一行\n第二行"')).toEqual({ ok: true, changed: true, rows: [["第一行\n第二行", "隐藏数据"], ["甲", "乙"]] });
    expect(planTablePaste(before, merges, 0, 0, "新\t冲突")).toMatchObject({ ok: false, message: expect.stringContaining("合并") });
    expect(planTablePaste(before, merges, 0, 1, "\t\n")).toMatchObject({ ok: false, message: expect.stringContaining("合并") });
  });
  it("rejects oversized text and table growth before making changes", () => {
    expect(planTablePaste([[""]], [], 0, 0, "x".repeat(256 * 1024 + 1))).toMatchObject({ ok: false });
    expect(planTablePaste([[""]], [], 0, 0, Array(51).fill("x").join("\t"))).toMatchObject({ ok: false });
  });
});
