import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocView } from "@/lib/api";
import { canDiffViews, diffInlineTokens, diffViews, summarizeDiff } from "./version-diff";

vi.mock("./read-only-doc", () => ({ ReadOnlyDoc: () => null }));
import { VersionDiffView } from "./version-panel";

const block = (type: string, text: string, marks: Record<string, string> = {}): DocView["blocks"][number] => ({ id: type, parent: "0:0", type, props: {}, spans: [{ text, marks }] });
describe("history block comparison", () => {
  it("detects changed formulas and diagrams without rendering their source", () => {
    const before: DocView = { blocks: [block("math", "E=mc^2"), block("diagram", "flowchart LR"), block("paragraph", "x^2", { math: "x^2" })] };
    const after: DocView = { blocks: [block("math", "a+b"), block("diagram", "flowchart TB"), block("paragraph", "y^2", { math: "y^2" })] };
    const result = diffViews(before, after);
    expect(result.filter((row) => row.kind === "changed")).toHaveLength(3);
    const visible = JSON.stringify(result);
    for (const source of ["E=mc^2", "flowchart LR", "flowchart TB", "x^2", "y^2"]) expect(visible).not.toContain(source);
    expect(visible).toContain("[公式]");
    expect(visible).toContain("[Mermaid 图表]");
  });
  it("rejects quadratic comparisons that exceed the bounded workspace", () => {
    const view: DocView = { blocks: Array.from({ length: 500 }, (_, i) => block("paragraph", String(i))) };
    expect(canDiffViews(view, view)).toBe(false);
    expect(() => diffViews(view, view)).toThrow(RangeError);
  });
});

describe("inline token diff and diff summary", () => {
  it("computes character-level CJK and word-level Latin inline diffs", () => {
    const cjk = diffInlineTokens("飞书文档支持历史对比", "飞书文档支持逐词版本对比功能");
    expect(cjk.filter((t) => t.kind !== "added").map((t) => t.text).join("")).toBe("飞书文档支持历史对比");
    expect(cjk.filter((t) => t.kind !== "removed").map((t) => t.text).join("")).toBe("飞书文档支持逐词版本对比功能");
    expect(cjk).toEqual([
      { kind: "same", text: "飞书文档支持" },
      { kind: "removed", text: "历史" },
      { kind: "added", text: "逐词版本" },
      { kind: "same", text: "对比" },
      { kind: "added", text: "功能" },
    ]);

    const latin = diffInlineTokens("Release v1.0 draft notes!", "Release v2.0 final notes!");
    expect(latin.filter((t) => t.kind !== "added").map((t) => t.text).join("")).toBe("Release v1.0 draft notes!");
    expect(latin.filter((t) => t.kind !== "removed").map((t) => t.text).join("")).toBe("Release v2.0 final notes!");
    expect(latin.some((t) => t.kind === "removed" && t.text === "v1")).toBe(true);
    expect(latin.some((t) => t.kind === "added" && t.text === "v2")).toBe(true);
    expect(latin.some((t) => t.kind === "removed" && t.text === "draft")).toBe(true);
    expect(latin.some((t) => t.kind === "added" && t.text === "final")).toBe(true);
  });

  it("handles empty, identical, and oversized strings safely without throwing", () => {
    expect(diffInlineTokens("", "")).toEqual([]);
    expect(diffInlineTokens("不变", "不变")).toEqual([{ kind: "same", text: "不变" }]);
    expect(diffInlineTokens("", "新增内容")).toEqual([{ kind: "added", text: "新增内容" }]);
    expect(diffInlineTokens("删除内容", "")).toEqual([{ kind: "removed", text: "删除内容" }]);

    const bigOld = "前缀" + "甲乙丙丁".repeat(300) + "后缀";
    const bigNew = "前缀" + "戊己庚辛".repeat(300) + "后缀";
    const bigDiff = diffInlineTokens(bigOld, bigNew);
    expect(bigDiff[0]).toEqual({ kind: "same", text: "前缀" });
    expect(bigDiff[bigDiff.length - 1]).toEqual({ kind: "same", text: "后缀" });
    expect(bigDiff.filter((t) => t.kind !== "added").map((t) => t.text).join("")).toBe(bigOld);
    expect(bigDiff.filter((t) => t.kind !== "removed").map((t) => t.text).join("")).toBe(bigNew);
  });

  it("summarizes diff counts and renders Feishu diff jump bar with inline highlights", () => {
    const before: DocView = {
      blocks: [
        block("paragraph", "保留段落"),
        block("paragraph", "旧版接口说明"),
        block("paragraph", "待移除段落"),
      ],
    };
    const after: DocView = {
      blocks: [
        block("paragraph", "保留段落"),
        block("paragraph", "新版接口文档说明"),
        block("paragraph", "全新补充段落"),
      ],
    };
    const rows = diffViews(before, after);
    const summary = summarizeDiff(rows);
    expect(summary).toEqual({ added: 0, removed: 0, changed: 2, total: 2 });

    const mixed: DocView = {
      blocks: [
        block("paragraph", "保留段落"),
        block("paragraph", "新版接口文档说明"),
        block("paragraph", "待移除段落"),
        block("paragraph", "额外新增段落"),
      ],
    };
    expect(summarizeDiff(diffViews(before, mixed))).toEqual({ added: 1, removed: 0, changed: 1, total: 2 });

    const html = renderToStaticMarkup(createElement(VersionDiffView, { oldView: before, newView: mixed }));
    expect(html).toContain("data-version-diff-bar");
    expect(html).toContain("+1 新增");
    expect(html).toContain("~1 修改");
    expect(html).toContain("-0 删除");
    expect(html).toContain("上一处");
    expect(html).toContain("下一处");
    expect(html).toContain('data-diff-change-idx="0"');
    expect(html).toContain('data-diff-change-idx="1"');
    expect(html).toContain("bg-[#d9f7e6]");
    expect(html).toContain("text-[#0b6b3a]");
    expect(html).toContain("bg-[#ffece8]");
    expect(html).toContain("text-[#cb2634]");
    expect(html).toContain("line-through");
  });
});
