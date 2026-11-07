import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import { bodyBlocks } from "./model";
import { captureSlashInsertion, captureSlashQuery, consumeSlashQuery, resolveSlashQuery, updateSlashQuery, insertSlashBlock, safeSlashUndo, sourceUnchanged } from "./slashInsert";

function setup(text: string) {
  const doc = new Doc(1);
  const tx = new Tx(doc);
  const block = tx.create("paragraph", null, ROOT);
  tx.insert(block, 0, text);
  return { doc, block };
}
const state = (doc: Doc) => bodyBlocks(doc).map((b) => [doc.blockInfo(b).type, doc.text(b)]);

describe("typed slash and mention query identity", () => {
  it.each(["/", "@"] as const)("follows %s when a peer inserts before it and rejects inserted query text", (kind) => {
    const { doc, block } = setup(`前${kind}查询`);
    const query = captureSlashQuery(doc, { b: block, o: 1 }, { b: block, o: 4 }, kind)!;
    doc.insertText(block, 0, "协作");
    expect(resolveSlashQuery(doc, query)).toEqual({ start: 3, end: 6, text: `${kind}查询` });
    doc.insertText(block, 5, "远端");
    expect(resolveSlashQuery(doc, query)).toBeNull();
  });
  it("accepts local append and deletion without accepting replacement characters", () => {
    const { doc, block } = setup("/查");
    const query = captureSlashQuery(doc, { b: block, o: 0 }, { b: block, o: 2 }, "/")!;
    doc.insertText(block, 2, "询😀");
    const appended = updateSlashQuery(query, { b: block, o: 4 }, "append")!;
    expect(resolveSlashQuery(doc, appended)?.text).toBe("/查询😀");
    new Tx(doc).delete(block, 3, 4);
    const shortened = updateSlashQuery(appended, { b: block, o: 3 }, "delete")!;
    expect(resolveSlashQuery(doc, shortened)?.text).toBe("/查询");
    new Tx(doc).delete(block, 1, 2);
    doc.insertText(block, 1, "查");
    expect(resolveSlashQuery(doc, shortened)).toBeNull();
  });
  it("rejects removed, moved, converted, or formula-marked query blocks", () => {
    const { doc, block } = setup("/查");
    const query = captureSlashQuery(doc, { b: block, o: 0 }, { b: block, o: 2 }, "/")!;
    new Tx(doc).format(block, 1, 2, "math", "查");
    expect(resolveSlashQuery(doc, query)).toBeNull();
    new Tx(doc).format(block, 1, 2, "math", null);
    new Tx(doc).setProp(block, "type", "quote");
    expect(resolveSlashQuery(doc, query)).toBeNull();
  });
  it.each(["/", "@"] as const)("consumes only verified %s IDs after a peer edit, and undo preserves the peer's text", (kind) => {
    const { doc, block } = setup(`前${kind}查询`);
    const query = captureSlashQuery(doc, { b: block, o: 1 }, { b: block, o: 4 }, kind)!;
    doc.insertText(block, 0, "远端");
    const tx = new Tx(doc);
    const at = consumeSlashQuery(tx, query);
    expect(at).toBe(3);
    tx.insert(block, at!, "目标");
    expect(doc.text(block)).toBe("远端前目标");
    const undo = new UndoManager();
    undo.record(tx, null, null);
    undo.undo(doc);
    expect(doc.text(block)).toBe(`远端前${kind}查询`);
  });
  it("produces no operations when a peer changes the captured command", () => {
    const { doc, block } = setup("@成员");
    const query = captureSlashQuery(doc, { b: block, o: 0 }, { b: block, o: 3 }, "@")!;
    doc.insertText(block, 2, "远端");
    const original = doc.text(block), tx = new Tx(doc);
    expect(consumeSlashQuery(tx, query)).toBeNull();
    expect(tx.ops).toHaveLength(0);
    expect(doc.text(block)).toBe(original);
  });
  it("tracks a real peer's prefix insertion and rejects its insertion inside the query", () => {
    const { doc, block } = setup("前/标题");
    const peer = Doc.fromState(2, doc.encodeState());
    const query = captureSlashQuery(doc, { b: block, o: 1 }, { b: block, o: 4 }, "/")!;
    const prefix = peer.insertText(block, 0, "协作者");
    if (prefix) doc.apply(prefix);
    expect(resolveSlashQuery(doc, query)?.start).toBe(4);
    const inside = peer.insertText(block, 6, "冲突");
    if (inside) doc.apply(inside);
    const before = doc.text(block), tx = new Tx(doc);
    expect(consumeSlashQuery(tx, query)).toBeNull();
    expect(doc.text(block)).toBe(before);
    expect(tx.ops).toHaveLength(0);
  });
});

describe("asynchronous slash insertion", () => {
  it("does not remove a command that a peer turns into part of a formula", () => {
    const { doc, block } = setup("/图片"), end = { b: block, o: 3 };
    const captured = captureSlashInsertion(doc, { b: block, o: 0 }, { a: end, f: end }, false)!;
    new Tx(doc).format(block, 1, 3, "math", "图片");
    const tx = new Tx(doc);
    expect(insertSlashBlock(tx, captured, "image", {})).toBeNull();
    expect(tx.ops).toHaveLength(0);
    expect(doc.text(block)).toBe("/图片");
    expect(captureSlashInsertion(doc, { b: block, o: 0 }, { a: end, f: end }, false)).toBeNull();
  });
  it.each(["math", "diagram", "video", "bookmark"])("preserves surrounding text and supports undo for %s", (type) => {
    const { doc, block } = setup("前/查询");
    const at = { b: block, o: 1 };
    const end = { b: block, o: 4 };
    const captured = captureSlashInsertion(doc, at, { a: end, f: end }, false)!;
    const tx = new Tx(doc);
    const isSource = type === "math" || type === "diagram";
    insertSlashBlock(tx, captured, type, isSource ? {} : { url: "https://example.com" }, isSource ? "x^2" : "");
    expect(state(doc)).toEqual([["paragraph", "前"], [type, isSource ? "x^2" : ""], ["paragraph", ""]]);
    const undo = new UndoManager();
    undo.record(safeSlashUndo(tx), null, null);
    undo.undo(doc);
    expect(state(doc)).toEqual([["paragraph", "前/查询"], [type, ""], ["paragraph", ""]]);
    if (!isSource) expect(doc.blockInfo(bodyBlocks(doc)[1]).props.url).toBe("");
    undo.redo(doc);
    expect(state(doc)).toEqual([["paragraph", "前"], [type, isSource ? "x^2" : ""], ["paragraph", ""]]);
    if (!isSource) expect(doc.blockInfo(bodyBlocks(doc)[1]).props.url).toBe("https://example.com");
  });

  it("reuses the original empty paragraph after a slash-only command", () => {
    const { doc, block } = setup("/公式");
    const end = { b: block, o: 3 };
    const captured = captureSlashInsertion(doc, { b: block, o: 0 }, { a: end, f: end }, false)!;
    expect(insertSlashBlock(new Tx(doc), captured, "math", {}, "x^2")).toEqual({ b: block, o: 0 });
    expect(state(doc)).toEqual([["math", "x^2"], ["paragraph", ""]]);
  });

  it("tracks the command by ID when text is inserted before it", () => {
    const { doc, block } = setup("前/查询");
    const end = { b: block, o: 4 };
    const captured = captureSlashInsertion(doc, { b: block, o: 1 }, { a: end, f: end }, false)!;
    doc.insertText(block, 0, "协作");
    insertSlashBlock(new Tx(doc), captured, "math", {}, "x^2");
    expect(doc.text(block)).toBe("协作前");
  });

  it("preserves text order when a command starts the paragraph", () => {
    const { doc, block } = setup("/查询后面的字");
    const end = { b: block, o: 3 };
    const captured = captureSlashInsertion(doc, { b: block, o: 0 }, { a: end, f: end }, false)!;
    expect(insertSlashBlock(new Tx(doc), captured, "math", {}, "x^2")).toEqual({ b: block, o: 0 });
    expect(state(doc)).toEqual([["math", "x^2"], ["paragraph", "后面的字"]]);
  });

  it("refuses a middle-of-paragraph insertion without changing or reordering text", () => {
    const { doc, block } = setup("前/查询后");
    const end = { b: block, o: 4 };
    const captured = captureSlashInsertion(doc, { b: block, o: 1 }, { a: end, f: end }, false)!;
    const tx = new Tx(doc);
    expect(insertSlashBlock(tx, captured, "diagram", {}, "graph TD; A-->B")).toBe("middle");
    expect(tx.ops).toHaveLength(0);
    expect(state(doc)).toEqual([["paragraph", "前/查询后"]]);
  });

  it("rechecks ordering after peer text arrives on both sides while the dialog is open", () => {
    const { doc, block } = setup("/查询");
    const end = { b: block, o: 3 };
    const captured = captureSlashInsertion(doc, { b: block, o: 0 }, { a: end, f: end }, false)!;
    const peer = Doc.fromState(2, doc.encodeState());
    const before = peer.insertText(block, 0, "远端前");
    const after = peer.insertText(block, peer.visibleIds(block).length, "远端后");
    if (before) doc.apply(before);
    if (after) doc.apply(after);
    const tx = new Tx(doc);
    expect(insertSlashBlock(tx, captured, "math", {}, "x^2")).toBe("middle");
    expect(tx.ops).toHaveLength(0);
    expect(doc.text(block)).toBe("远端前/查询远端后");
  });

  it("refuses to remove remote text inserted inside the command", () => {
    const { doc, block } = setup("前/查询后");
    const end = { b: block, o: 4 };
    const captured = captureSlashInsertion(doc, { b: block, o: 1 }, { a: end, f: end }, false)!;
    doc.insertText(block, 3, "远端");
    const before = doc.text(block);
    const tx = new Tx(doc);
    expect(insertSlashBlock(tx, captured, "math", {}, "x^2")).toBeNull();
    expect(tx.ops).toHaveLength(0);
    expect(doc.text(block)).toBe(before);
  });

  it("does not insert when the captured block changes type while a dialog is open", () => {
    const { doc, block } = setup("/公式");
    const end = { b: block, o: 3 };
    const captured = captureSlashInsertion(doc, { b: block, o: 0 }, { a: end, f: end }, false)!;
    new Tx(doc).setProp(block, "type", "quote");
    const tx = new Tx(doc);
    expect(insertSlashBlock(tx, captured, "math", {}, "x^2")).toBeNull();
    expect(tx.ops).toHaveLength(0);
    expect(doc.text(block)).toBe("/公式");
  });

  it("leaves an empty block untouched when opened through the plus button", () => {
    const { doc, block } = setup("");
    const captured = captureSlashInsertion(doc, { b: block, o: 0 }, null, true)!;
    doc.insertText(block, 0, "协作者文字");
    insertSlashBlock(new Tx(doc), captured, "diagram", {}, "graph TD; A-->B");
    expect(state(doc)).toEqual([["diagram", "graph TD; A-->B"], ["paragraph", "协作者文字"]]);
  });

  it("detects source edits, replacement and block type changes during a dialog", () => {
    const { doc, block } = setup("x^2");
    const tx = new Tx(doc);
    tx.setProp(block, "type", "math");
    const ids = doc.visibleIds(block);
    expect(sourceUnchanged(doc, block, "math", ids)).toBe(true);
    doc.insertText(block, 3, "+y");
    expect(sourceUnchanged(doc, block, "math", ids)).toBe(false);
    tx.delete(block, 0, doc.visibleIds(block).length);
    tx.insert(block, 0, "x^2");
    expect(sourceUnchanged(doc, block, "math", ids)).toBe(false);
    expect(sourceUnchanged(doc, block, "diagram", doc.visibleIds(block))).toBe(false);
  });

  it("keeps the inserted block alive for a peer edit arriving after undo", () => {
    const { doc, block } = setup("/公式");
    const end = { b: block, o: 3 };
    const captured = captureSlashInsertion(doc, { b: block, o: 0 }, { a: end, f: end }, false)!;
    const tx = new Tx(doc);
    insertSlashBlock(tx, captured, "math", {}, "x^2");
    const inserted = bodyBlocks(doc)[0];
    const peer = Doc.fromState(2, doc.encodeState());
    const late = peer.insertText(inserted, 3, "+y");
    const undo = new UndoManager();
    undo.record(safeSlashUndo(tx), null, null);
    undo.undo(doc);
    if (late) doc.apply(late);
    expect(doc.hasBlock(inserted)).toBe(true);
    expect(doc.text(inserted)).toBe("+y");
    expect(doc.text(block)).toBe("/公式");
  });
});
