import { describe, expect, it } from "vitest";
import { collectDocumentMentions } from "./documentMentions";
import type { DocView } from "@/lib/api";

function block(id: string, type: string, spans: { text: string; marks: Record<string, string> }[]): DocView["blocks"][number] {
  return { id, parent: "0:0", type, props: {}, spans };
}

describe("document mention summary", () => {
  it("groups contiguous formatted spans and counts separate mentions in document order", () => {
    const view: DocView = { blocks: [
      block("1:1", "paragraph", [
        { text: "@小", marks: { mention: "2", bold: "true" } },
        { text: "简", marks: { mention: "2" } },
        { text: " 请查看 ", marks: {} },
        { text: "@小简", marks: { mention: "2" } },
      ]),
      block("1:2", "paragraph", [{ text: "@小明", marks: { mention: "3" } }]),
    ] };
    const result = collectDocumentMentions(view, [{ id: 2, name: "简同学" }]);
    expect(result).toEqual({ people: [
      { userId: 2, name: "简同学", count: 2, firstBlock: "1:1", resolvedName: true },
      { userId: 3, name: "小明", count: 1, firstBlock: "1:2", resolvedName: false },
    ], truncated: false });
  });

  it("ignores non-text, formula, document-link and invalid identity marks", () => {
    const view: DocView = { blocks: [
      block("1:1", "code", [{ text: "@code", marks: { mention: "4" } }]),
      block("bad", "paragraph", [{ text: "@bad", marks: { mention: "4" } }]),
      block("1:2", "paragraph", [
        { text: "@math", marks: { mention: "4", math: "x" } },
        { text: "@doc", marks: { mention: "5", link: "#/doc/9" } },
        { text: "@invalid", marks: { mention: "9007199254740992" } },
        { text: "@zero", marks: { mention: "0" } },
      ]),
    ] };
    expect(collectDocumentMentions(view)).toEqual({ people: [], truncated: false });
  });

  it("limits the number of scanned spans and reports an incomplete result", () => {
    const spans = Array.from({ length: 50_001 }, (_, index): { text: string; marks: Record<string, string> } => ({ text: index === 0 ? "@一" : "x", marks: index === 0 ? { mention: "1" } : {} }));
    const result = collectDocumentMentions({ blocks: [block("1:1", "paragraph", spans)] });
    expect(result.people).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});
