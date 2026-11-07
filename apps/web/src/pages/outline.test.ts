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

import { diffViews, type DiffRow } from "./VersionDiff";
import type { DocView } from "@/lib/api";

const mk = (blocks: [string, string][]): DocView => ({
  blocks: blocks.map(([type, text], i) => ({
    id: String(i),
    parent: "0",
    type,
    props: {},
    spans: [{ text, marks: {} }],
  })),
});

describe("version diff", () => {
  it("marks added / removed / changed / same", () => {
    const oldV = mk([
      ["paragraph", "第一段"],
      ["paragraph", "第二段"],
      ["paragraph", "第三段"],
    ]);
    const newV = mk([
      ["paragraph", "第一段"],
      ["paragraph", "第二段改"],
      ["paragraph", "新增段"],
      ["paragraph", "第三段"],
    ]);
    const rows = diffViews(oldV, newV);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain("same");
    expect(kinds).toContain("changed");
    expect(kinds).toContain("added");
    expect(rows.filter((r) => r.kind === "removed")).toHaveLength(0);
    const changed = rows.find((r) => r.kind === "changed") as DiffRow;
    expect(changed.oldText).toBe("第二段");
    expect(changed.newText).toBe("第二段改");
  });
  it("removes produce removed rows", () => {
    const rows = diffViews(mk([["paragraph", "A"], ["paragraph", "B"]]), mk([["paragraph", "A"]]));
    expect(rows.map((r) => r.kind)).toEqual(["same", "removed"]);
  });
});
