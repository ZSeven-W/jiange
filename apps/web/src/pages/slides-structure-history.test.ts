import { describe, expect, it } from "vitest";
import {
  commitStructureTravel,
  emptyStructureHistory,
  pushStructureAction,
  SLIDE_STRUCTURE_HISTORY_LIMIT,
  snapshotSlidePage,
  structureActionLabel,
  type SlideStructureAction,
} from "./slides-structure-history";

describe("slides structure history", () => {
  it("pushes actions, clears redo on new edit, and caps stack length", () => {
    let h = emptyStructureHistory();
    const snap = snapshotSlidePage({
      title: "第一页",
      body: "正文",
      background: "#ffffff",
      layout: "title",
      notes: "备注",
      hidden: false,
      shapes: [{ id: "s1", kind: "star", x: 10, y: 10, color: "#3370ff" }],
    });
    const del: SlideStructureAction = { kind: "delete", seq: 1, pageId: 10, index: 1, snapshot: snap };
    h = pushStructureAction(h, del);
    expect(h.undo).toHaveLength(1);
    expect(structureActionLabel(h.undo.at(-1), false)).toBe("撤销删除页面");

    const restored: SlideStructureAction = { ...del, pageId: 99 };
    h = commitStructureTravel(h, false, del, restored);
    expect(h.undo).toHaveLength(0);
    expect(h.redo).toHaveLength(1);
    expect(h.redo[0].pageId).toBe(99);
    expect(structureActionLabel(h.redo.at(-1), true)).toBe("重做删除页面");

    // Pushing a new action clears redo
    const reorder: SlideStructureAction = { kind: "reorder", seq: 2, pageId: 99, fromIndex: 1, toIndex: 0 };
    h = pushStructureAction(h, reorder);
    expect(h.redo).toHaveLength(0);
    expect(h.undo).toHaveLength(1);

    for (let i = 0; i < SLIDE_STRUCTURE_HISTORY_LIMIT + 10; i++) {
      h = pushStructureAction(h, { kind: "visibility", seq: i + 3, pageId: 1, beforeHidden: false, afterHidden: true });
    }
    expect(h.undo).toHaveLength(SLIDE_STRUCTURE_HISTORY_LIMIT);
  });
});
