import { describe, expect, it } from "vitest";
import { formatTableTSV, parseTableTSV, planTablePaste } from "./tableClipboard";

describe("document table clipboard", () => {
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
  it("rejects a paste touching merged cells or invalid quoted TSV as one operation", () => {
    const before = [["保留", ""], ["下", "右"]];
    expect(planTablePaste(before, [[0, 0, 1, 2]], 0, 0, "甲\t乙")).toMatchObject({ ok: false, message: expect.stringContaining("合并") });
    expect(planTablePaste(before, [], 0, 0, '"未闭合\t内容')).toMatchObject({ ok: false });
    expect(before).toEqual([["保留", ""], ["下", "右"]]);
  });
  it("rejects oversized text and table growth before making changes", () => {
    expect(planTablePaste([[""]], [], 0, 0, "x".repeat(256 * 1024 + 1))).toMatchObject({ ok: false });
    expect(planTablePaste([[""]], [], 0, 0, Array(51).fill("x").join("\t"))).toMatchObject({ ok: false });
  });
});
