import { describe, expect, it } from "vitest";
import type { DocView } from "@/lib/api";
import { cellTableWrites } from "@/editor/tableCells";
import { documentTextStats } from "./docInfoStats";

const block = (type: string, text = "", props: Record<string, string> = {}): DocView["blocks"][number] => ({ id: type, parent: "0:0", type, props, spans: [{ text, marks: {} }] });

describe("document visible text statistics", () => {
  it("counts text, visible table cells, captions and flow labels without hidden data or source DSL", () => {
    const table = cellTableWrites({}, [["甲", "隐藏"], ["B C", "好"]], 1);
    const view: DocView = { blocks: [
      block("title", "标题不计"), block("paragraph", "你好 A😀\n"),
      block("table", "", { ...table, tableMerges: "[[0,0,1,2]]" }),
      block("image", "", { caption: "图示" }),
      block("flowchart", "", { "fc.n.a": JSON.stringify({ id: "a", shape: "rect", text: "开始", x: 0, y: 0, w: 80, h: 40 }) }),
      block("diagram", "", { source: "flowchart LR" }),
      { ...block("paragraph"), spans: [{ text: "x^2", marks: { math: "x^2" } }] },
    ] };
    // 6 paragraph + 5 visible table + 2 caption + 2 flow characters.
    expect(documentTextStats(view)).toEqual({ characters: 15, nonWhitespace: 12 });
  });
  it("counts legacy table data and handles missing captions", () => {
    expect(documentTextStats({ blocks: [block("table", "", { tableData: JSON.stringify([["旧", " X"]]) })] })).toEqual({ characters: 3, nonWhitespace: 2 });
  });
  it("handles an empty view and missing captions", () => {
    expect(documentTextStats({ blocks: [block("title", "标题"), block("image")] })).toEqual({ characters: 0, nonWhitespace: 0 });
  });
});
