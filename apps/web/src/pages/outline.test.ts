import { describe, expect, it } from "vitest";
import { outlineOf } from "./OutlinePanel";
import { parseMarkdown, toMarkdown } from "@/lib/markdown";

describe("outline & h4-h6", () => {
  it("extracts heading outline with levels", () => {
    const items = outlineOf([
      { id: "1", type: "h1", spans: [{ text: "标题一" }] },
      { id: "2", type: "paragraph", spans: [{ text: "正文" }] },
      { id: "3", type: "h3", spans: [{ text: "子标题" }] },
    ]);
    expect(items).toEqual([
      { id: "1", level: 1, text: "标题一" },
      { id: "3", level: 3, text: "子标题" },
    ]);
  });
  it("markdown imports h4-h6 and round-trips", () => {
    const md = "#### 四级\n##### 五级\n###### 六级\n";
    const out = toMarkdown(parseMarkdown(md));
    expect(out).toBe(md);
    expect(parseMarkdown(md).map((b) => b.type)).toEqual(["h4", "h5", "h6"]);
  });
});
