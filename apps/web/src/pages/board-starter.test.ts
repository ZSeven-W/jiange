import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { BOARD_SEED, MINDMAP_SEED, hasBoard, peekBoardKind, stageBoard, takeBoard } from "./board-starter";
import { insertStarterBlocks } from "./starter-template-ops";
import { bodyBlocks } from "@/editor/model";
import { readFlow } from "@/editor/flowchart/model";

describe("board starter", () => {
  it("stages per user and document", () => {
    stageBoard(1, 7);
    expect(hasBoard(1, 7)).toBe(true);
    expect(hasBoard(2, 7)).toBe(false);
    takeBoard(1, 7);
    expect(hasBoard(1, 7)).toBe(false);
  });

  it("stages a mind map for the correct user and inserts a real tree", () => {
    stageBoard(5, 9, "mindmap");
    expect(peekBoardKind(5, 9)).toBe("mindmap");
    expect(peekBoardKind(6, 9)).toBeNull();
    const doc = new Doc(1); new Tx(doc).create("paragraph", null, ROOT);
    expect(insertStarterBlocks(doc, [MINDMAP_SEED])).not.toBeNull();
    const graph = readFlow(doc.blockInfo(bodyBlocks(doc)[0]).props);
    expect(graph.mind).toHaveLength(4);
    expect(graph.mind?.filter((topic) => topic.parent === null)).toHaveLength(1);
    takeBoard(5, 9);
    expect(peekBoardKind(5, 9)).toBeNull();
  });

  it("inserts a single flowchart block into an empty document only", () => {
    const doc = new Doc(1);
    new Tx(doc).create("paragraph", null, ROOT);
    const tx = insertStarterBlocks(doc, [BOARD_SEED]);
    expect(tx).not.toBeNull();
    const first = bodyBlocks(doc)[0];
    expect(doc.blockInfo(first).type).toBe("flowchart");
    expect(doc.blockInfo(first).props["fc.theme"]).toBe("feishu");
    expect(insertStarterBlocks(doc, [BOARD_SEED])).toBeNull();
  });
});
