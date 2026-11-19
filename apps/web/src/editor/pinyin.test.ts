import { describe, expect, it } from "vitest";
import { filterItems, pinyinMatch } from "./pinyin";

describe("pinyin", () => {
  it("matches abbreviations, full and mixed pinyin", () => {
    const py = ["yi", "ji", "biao", "ti"];
    for (const q of ["yjbt", "bt", "biaoti", "yijibt", "yjbiao", "biaot"]) expect(pinyinMatch(py, q)).toBe(true);
    for (const q of ["xyz", "tb", "yjbtx"]) expect(pinyinMatch(py, q)).toBe(false);
    expect(filterItems("bt").map((i) => i.id)).toEqual(["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9"]);
    expect(filterItems("yxlb").map((i) => i.id)).toEqual(["ordered"]);
    expect(filterItems("db").map((i) => i.id)).toContain("todo");
    expect(filterItems("代码").map((i) => i.id)).toEqual(["code"]);
  });
  it("recognizes Feishu aliases for supported commands", () => {
    for (const [query, id] of [
      ["url", "link"], ["eq", "math"], ["rw", "todo"], ["numbered list", "ordered"], ["bulleted list", "bullet"],
      ["wj", "file"], ["wj", "video"], ["sp", "file"], ["sp", "video"],
      ["h7", "h7"], ["h8", "h8"], ["h9", "h9"], ["qjbt", "h7"],
      ["rq", "reminder"], ["reminder", "reminder"], ["日期提醒", "reminder"],
      ["sheet", "embed-sheet"], ["base", "embed-base"], ["survey", "embed-survey"], ["slides", "embed-slides"],
      ["dzbg", "embed-sheet"], ["dwbg", "embed-base"],
    ]) expect(filterItems(query).map((item) => item.id)).toContain(id);
  });
});
