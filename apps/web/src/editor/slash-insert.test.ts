import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx, UndoManager } from "@zseven-w/collab";
import { bodyBlocks } from "./model";
import { canOpenSlashMenu, captureSlashInsertion, captureSlashQuery, consumeSlashQuery, insertBlockAtSlashOffset, resolveSlashQuery, updateSlashQuery, validSlashQueryText, insertSlashBlock, safeSlashUndo, sourceUnchanged } from "./slash-insert";

function setup(text: string) {
  const doc = new Doc(1);
  const tx = new Tx(doc);
  const block = tx.create("paragraph", null, ROOT);
  tx.insert(block, 0, text);
  return { doc, block };
}
const state = (doc: Doc) => bodyBlocks(doc).map((b) => [doc.blockInfo(b).type, doc.text(b)]);

describe("typed slash and mention query identity", () => {
  it.each([["/", 0, true], ["前 /", 2, true], ["前\n/", 2, true], ["https://", 6, false], ["文/", 1, false]] as const)("checks slash trigger context in %s", (text, offset, expected) => {
    const { doc, block } = setup(text);
    expect(canOpenSlashMenu(doc, { b: block, o: offset })).toBe(expected);
  });
  it("keeps code blocks and inline code literal", () => {
    const { doc, block } = setup("/");
    new Tx(doc).format(block, 0, 1, "code", "1");
    expect(canOpenSlashMenu(doc, { b: block, o: 0 })).toBe(false);
    new Tx(doc).format(block, 0, 1, "code", null);
    new Tx(doc).setProp(block, "type", "code");
    expect(canOpenSlashMenu(doc, { b: block, o: 0 })).toBe(false);
  });
  it.each(["numbered list", "bulleted list"])("tracks a spaced alias: %s", (alias) => {
    const { doc, block } = setup("/");
    let query = captureSlashQuery(doc, { b: block, o: 0 }, { b: block, o: 1 }, "/")!;
    for (const ch of alias) {
      const end = doc.visibleIds(block).length;
      doc.insertText(block, end, ch);
      query = updateSlashQuery(query, { b: block, o: end + 1 }, "append")!;
      expect(query).not.toBeNull();
    }
    expect(resolveSlashQuery(doc, query)?.text).toBe(`/${alias}`);
    doc.insertText(block, doc.visibleIds(block).length, " ");
    expect(updateSlashQuery(query, { b: block, o: alias.length + 2 }, "append")).toBeNull();
  });
  it("keeps selection tracking and input tracking consistent for spaced queries", () => {
    expect(validSlashQueryText("/", "/numbered ")).toBe(true);
    expect(validSlashQueryText("/", "/bulleted list")).toBe(true);
    expect(validSlashQueryText("/", "/numbered other")).toBe(false);
    expect(validSlashQueryText("@", "@numbered list")).toBe(false);
    expect(validSlashQueryText("/", `/${"a".repeat(32)}`)).toBe(false);
  });
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

  it("safely splits a local middle-of-paragraph insertion while preserving marks and supporting undo", () => {
    const { doc, block } = setup("前/查询后");
    new Tx(doc).format(block, 4, 5, "bold", "true");
    const end = { b: block, o: 4 };
    const captured = captureSlashInsertion(doc, { b: block, o: 1 }, { a: end, f: end }, false)!;
    const tx = new Tx(doc);
    const caret = insertSlashBlock(tx, captured, "diagram", {}, "graph TD; A-->B");
    expect(caret && caret !== "middle").toBe(true);
    expect(state(doc)).toEqual([["paragraph", "前"], ["diagram", "graph TD; A-->B"], ["paragraph", "后"]]);
    expect(doc.richChars(bodyBlocks(doc)[2])[0]?.marks.bold).toBe("true");
    const undo = new UndoManager();
    undo.record(safeSlashUndo(tx), null, null);
    undo.undo(doc);
    expect(doc.text(block)).toBe("前/查询后");
    expect(doc.text(bodyBlocks(doc)[2])).toBe("");
    undo.redo(doc);
    expect(state(doc)).toEqual([["paragraph", "前"], ["diagram", "graph TD; A-->B"], ["paragraph", "后"]]);
  });

  it("splits synchronous mid-paragraph slash blocks (table/reminder/embed) cleanly", () => {
    const { doc, block } = setup("前半段 后半段");
    new Tx(doc).format(block, 4, 7, "italic", "true");
    const tx = new Tx(doc);
    const { inserted, caret } = insertBlockAtSlashOffset(tx, block, 4, "embed", { resourceKind: "sheet", resourceId: "12", title: "预算" });
    expect(doc.blockInfo(inserted).props.resourceKind).toBe("sheet");
    expect(state(doc)).toEqual([["paragraph", "前半段 "], ["embed", ""], ["paragraph", "后半段"]]);
    expect(doc.text(caret.b)).toBe("后半段");
    expect(caret.o).toBe(0);
    expect(doc.richChars(caret.b).every((c) => c.marks.italic === "true")).toBe(true);
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
