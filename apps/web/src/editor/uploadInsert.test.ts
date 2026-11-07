import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { bodyBlocks } from "./model";
import { captureSlashInsertion, safeSlashUndo } from "./slashInsert";
import { insertUploadedFiles, uploadTargetUnchanged, validateUploadCommand } from "./uploadInsert";

const image = { id: 7, name: "图.png", mime: "image/png", size: 24 };
const file = { id: 8, name: "附件.pdf", mime: "application/pdf", size: 12 };
function setup(text: string) {
  const doc = new Doc(1), tx = new Tx(doc), block = tx.create("paragraph", null, ROOT);
  if (text) tx.insert(block, 0, text);
  return { doc, block };
}
const view = (doc: Doc) => bodyBlocks(doc).map((b) => [doc.blockInfo(b).type, doc.text(b)]);

describe("uploaded block insertion", () => {
  it("rejects a captured command changed to a formula before upload", () => {
    const { doc, block } = setup("/图片"), end = { b: block, o: 3 };
    const captured = captureSlashInsertion(doc, { b: block, o: 0 }, { a: end, f: end }, false)!;
    new Tx(doc).format(block, 1, 3, "math", "图片");
    expect(validateUploadCommand(captured)).toBe("changed");
    const tx = new Tx(doc);
    expect(insertUploadedFiles(tx, captured, [image])).toBeNull();
    expect(tx.ops).toHaveLength(0);
    expect(doc.text(block)).toBe("/图片");
  });
  it("removes only the captured command, keeps surrounding text and preserves the original paragraph", () => {
    const { doc, block } = setup("正文/图片"), end = { b: block, o: 5 };
    const captured = captureSlashInsertion(doc, { b: block, o: 2 }, { a: end, f: end }, false)!;
    const tx = new Tx(doc);
    insertUploadedFiles(tx, captured, [image, file]);
    expect(view(doc)).toEqual([["paragraph", "正文"], ["image", ""], ["file", ""], ["paragraph", ""]]);
    expect(doc.hasBlock(block)).toBe(true);
    const undo = new UndoManager();
    undo.record(safeSlashUndo(tx), null, null);
    undo.undo(doc);
    expect(doc.text(block)).toBe("正文/图片");
  });

  it("does not delete collaborator text inserted into the command", () => {
    const { doc, block } = setup("前/图片"), end = { b: block, o: 4 };
    const captured = captureSlashInsertion(doc, { b: block, o: 1 }, { a: end, f: end }, false)!;
    expect(validateUploadCommand(captured)).toBe("ok");
    doc.insertText(block, 2, "协作");
    expect(validateUploadCommand(captured)).toBe("changed");
    const before = doc.text(block), tx = new Tx(doc);
    expect(insertUploadedFiles(tx, captured, [image])).toBeNull();
    expect(tx.ops).toHaveLength(0);
    expect(doc.text(block)).toBe(before);
  });

  it("refuses a middle command without changing either side", () => {
    const { doc, block } = setup("前/图片后"), end = { b: block, o: 4 };
    const captured = captureSlashInsertion(doc, { b: block, o: 1 }, { a: end, f: end }, false)!;
    expect(validateUploadCommand(captured)).toBe("middle");
    const tx = new Tx(doc);
    expect(insertUploadedFiles(tx, captured, [image])).toBe("middle");
    expect(tx.ops).toHaveLength(0);
    expect(doc.text(block)).toBe("前/图片后");
  });

  it("keeps late collaborator text on the original empty paragraph visible", () => {
    const { doc, block } = setup("");
    const captured = captureSlashInsertion(doc, { b: block, o: 0 }, null, true)!;
    const peer = Doc.fromState(2, doc.encodeState());
    const late = peer.insertText(block, 0, "协作者");
    insertUploadedFiles(new Tx(doc), captured, [image]);
    if (late) doc.apply(late);
    expect(view(doc)).toEqual([["image", ""], ["paragraph", "协作者"]]);
  });

  it("detects a block converted or moved while a file is uploading", () => {
    const { doc, block } = setup("正文");
    const captured = captureSlashInsertion(doc, { b: block, o: 2 }, null, true, block)!;
    expect(uploadTargetUnchanged(captured, "paragraph", ROOT)).toBe(true);
    const tx = new Tx(doc);
    tx.setProp(block, "type", "h1");
    expect(uploadTargetUnchanged(captured, "paragraph", ROOT)).toBe(false);
    tx.setProp(block, "type", "paragraph");
    const container = tx.create("columns", block, ROOT);
    tx.move(block, null, container);
    expect(uploadTargetUnchanged(captured, "paragraph", ROOT)).toBe(false);
  });

  it("detects text added while pasting an attachment at a paragraph boundary", () => {
    const { doc, block } = setup("正文");
    const captured = captureSlashInsertion(doc, { b: block, o: 2 }, null, true, block)!;
    const before = doc.visibleIds(block);
    expect(uploadTargetUnchanged(captured, "paragraph", ROOT, before)).toBe(true);
    doc.insertText(block, 2, "协作");
    expect(uploadTargetUnchanged(captured, "paragraph", ROOT, before)).toBe(false);
    expect(doc.text(block)).toBe("正文协作");
  });
});
