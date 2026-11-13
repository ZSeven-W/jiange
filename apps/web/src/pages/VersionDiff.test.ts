import { describe, expect, it } from "vitest";
import type { DocView } from "@/lib/api";
import { canDiffViews, diffViews } from "./VersionDiff";
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
