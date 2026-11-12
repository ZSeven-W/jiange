import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { BOARD_SEED, hasBoard, stageBoard, takeBoard } from "./boardStarter";
import { insertStarterBlocks } from "./starterTemplateOps";
import { bodyBlocks } from "@/editor/model";

describe("board starter", () => {
  it("stages per user and document", () => {
    stageBoard(1, 7);
    expect(hasBoard(1, 7)).toBe(true);
    expect(hasBoard(2, 7)).toBe(false);
    takeBoard(1, 7);
    expect(hasBoard(1, 7)).toBe(false);
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
