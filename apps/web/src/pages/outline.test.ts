import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compactOutlinePlacement, OutlinePanel, OutlineTrigger, outlineOf } from "./OutlinePanel";
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

import { activeOutlineId } from "./OutlinePanel";

describe("outline reading position", () => {
  const items = [{ id: "a", level: 2, text: "A" }, { id: "b", level: 3, text: "B" }, { id: "c", level: 2, text: "C" }];
  it("highlights the last heading above the reading line", () => {
    expect(activeOutlineId(items, { a: -300, b: 40, c: 600 }, 96)).toBe("b");
    expect(activeOutlineId(items, { a: -300, b: -100, c: 20 }, 96)).toBe("c");
  });
  it("falls back to the first heading before any heading is reached", () => {
    expect(activeOutlineId(items, { a: 200, b: 400, c: 600 }, 96)).toBe("a");
    expect(activeOutlineId([], {}, 96)).toBeNull();
  });
});

import { visibleOutline } from "./OutlinePanel";

describe("collapsible outline", () => {
  const items = [
    { id: "a", level: 2, text: "A" }, { id: "a1", level: 3, text: "A1" }, { id: "a1x", level: 4, text: "A1x" },
    { id: "b", level: 2, text: "B" }, { id: "b1", level: 3, text: "B1" },
  ];
  it("marks headings that have deeper headings after them", () => {
    expect(visibleOutline(items, new Set()).map((r) => [r.item.id, r.hasChildren])).toEqual([["a", true], ["a1", true], ["a1x", false], ["b", true], ["b1", false]]);
  });
  it("hides every descendant of a folded heading until a sibling level returns", () => {
    expect(visibleOutline(items, new Set(["a"])).map((r) => r.item.id)).toEqual(["a", "b", "b1"]);
    expect(visibleOutline(items, new Set(["a1", "b"])).map((r) => r.item.id)).toEqual(["a", "a1", "b"]);
  });

  it("makes section folds and the unpinned outline reachable by keyboard", () => {
    const html = renderToStaticMarkup(createElement(OutlinePanel, { items, activeId: "a", pinned: false, onJump: () => {}, onClose: () => {} }));
    expect(html).toContain('aria-label="折叠 A"');
    expect(html).not.toContain('tabindex="-1"');
    expect(html).toContain('aria-label="展开目录"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("exposes the document outline toggle and its expanded state", () => {
    const props = { hostRef: { current: null }, buttonRef: { current: null }, panelId: "document-outline", onToggle: () => {} };
    const closed = renderToStaticMarkup(createElement(OutlineTrigger, { ...props, expanded: false }));
    const open = renderToStaticMarkup(createElement(OutlineTrigger, { ...props, expanded: true }));
    expect(closed).toContain('aria-label="展开目录"');
    expect(closed).toContain('aria-expanded="false"');
    expect(open).toContain('aria-label="关闭目录"');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('aria-controls="document-outline"');
  });

  it("anchors the toggle to the document and clamps it within the viewport", () => {
    expect(compactOutlinePlacement(268, 64, 420, 983)).toEqual({ left: 268, top: 420 });
    expect(compactOutlinePlacement(0, 64, -120, 983)).toEqual({ left: 0, top: 72 });
    expect(compactOutlinePlacement(268, 64, 950, 983)).toEqual({ left: 268, top: 803 });
  });
});
