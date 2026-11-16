import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx, UndoManager } from "@jiange/collab";
import type { SyncDoc } from "@/lib/useSyncDoc";
import { Editor, setSelectionAlignment } from "./Editor";
import { deleteRange, joinBackward, joinForward, normalize, splitBlock, toggleMark } from "./model";
import { selectionContainsColumns } from "./model";
import { createColumn, insertColumnAfter, MAX_COLUMNS, requestColumnDeletion, safeColumnUndo } from "./columnSafety";
import { captureCompositionAnchor, captureCompositionSelection, resolveCompositionAnchor, resolveCompositionSelection } from "./compositionAnchor";

function setup() {
  const doc = new Doc(1);
  const tx = new Tx(doc);
  const before = tx.create("paragraph", null, ROOT);
  tx.insert(before, 0, "前文");
  const columns = tx.create("columns", before, ROOT);
  const left = tx.create("paragraph", null, columns);
  const right = tx.create("paragraph", left, columns);
  tx.insert(left, 0, "左栏😀");
  tx.insert(right, 0, "右栏");
  const after = tx.create("paragraph", columns, ROOT);
  tx.insert(after, 0, "后文");
  return { doc, before, columns, left, right, after };
}

describe("column text scope", () => {
  it("inserts a column between existing columns without changing their content", () => {
    const { doc, columns, left, right } = setup();
    const tx = new Tx(doc);
    expect(insertColumnAfter(tx, columns, left)).toBe("created");
    const children = doc.children(columns);
    expect(children).toHaveLength(3);
    expect(children[0]).toEqual(left); expect(children[2]).toEqual(right);
    expect(doc.text(children[1])).toBe("");
    expect(doc.text(left)).toBe("左栏😀"); expect(doc.text(right)).toBe("右栏");
  });

  it("refuses local inserts at the ten-column limit or after stale anchors", () => {
    const { doc, columns, left, right } = setup();
    while (doc.children(columns).length < MAX_COLUMNS) {
      const tx = new Tx(doc);
      expect(insertColumnAfter(tx, columns, doc.children(columns).at(-1)!)).toBe("created");
    }
    const full = new Tx(doc);
    expect(insertColumnAfter(full, columns, right)).toBe("limit"); expect(full.ops).toHaveLength(0);
    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const html = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-add-column/);
    expect(html).not.toContain("data-insert-column-after");
    doc.deleteBlock(left);
    const stale = new Tx(doc);
    expect(insertColumnAfter(stale, columns, left)).toBe("changed"); expect(stale.ops).toHaveLength(0);
  });

  it("preserves concurrent inserts even if they collectively exceed the local limit", () => {
    const { doc, columns } = setup();
    while (doc.children(columns).length < MAX_COLUMNS - 1) insertColumnAfter(new Tx(doc), columns, doc.children(columns).at(-1)!);
    const peer = Doc.fromState(2, doc.encodeState());
    const a = new Tx(doc), b = new Tx(peer);
    expect(insertColumnAfter(a, columns, doc.children(columns).at(-1)!)).toBe("created");
    expect(insertColumnAfter(b, columns, peer.children(columns).at(-1)!)).toBe("created");
    for (const op of b.ops) doc.apply(op);
    expect(doc.children(columns)).toHaveLength(MAX_COLUMNS + 1);
  });

  it("aligns only the selected column, supports undo and renders the saved value", () => {
    const { doc, left, right } = setup();
    const peer = Doc.fromState(2, doc.encodeState());
    const otherText = peer.insertText(right, 0, "协作")!;
    const selection = { a: { b: left, o: 0 }, f: { b: left, o: 2 } };
    const tx = new Tx(doc);
    setSelectionAlignment(tx, selection, "center");
    expect(doc.blockInfo(left).props.align).toBe("center");
    expect(doc.blockInfo(right).props.align).toBeUndefined();
    doc.apply(otherText);
    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const html = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} />);
    expect(html).toMatch(/data-text[^>]*style="text-align:center"/);
    const undo = new UndoManager();
    undo.record(tx, null, null);
    undo.undo(doc);
    expect(doc.blockInfo(left).props.align || "left").toBe("left");
    expect(doc.text(right)).toBe("协作右栏");
    undo.redo(doc);
    expect(doc.blockInfo(left).props.align).toBe("center");
    expect(doc.text(right)).toBe("协作右栏");
  });

  it("does not align across columns or rewrite an unchanged alignment", () => {
    const { doc, left, right } = setup();
    const same = new Tx(doc);
    setSelectionAlignment(same, { a: { b: left, o: 0 }, f: { b: left, o: 1 } }, "left");
    expect(same.ops).toHaveLength(0);
    const cross = new Tx(doc);
    setSelectionAlignment(cross, { a: { b: left, o: 0 }, f: { b: right, o: 1 } }, "right");
    expect(cross.ops).toHaveLength(0);
    doc.deleteBlock(left);
    const stale = new Tx(doc);
    setSelectionAlignment(stale, { a: { b: left, o: 0 }, f: { b: left, o: 0 } }, "right");
    expect(stale.ops).toHaveLength(0);
  });

  it("formats, inserts line breaks, and undoes one column without affecting its neighbor", () => {
    const { doc, columns, left, right } = setup();
    const tx = new Tx(doc);
    toggleMark(tx, { a: { b: left, o: 0 }, f: { b: left, o: 2 } }, "bold");
    splitBlock(tx, { b: left, o: 2 });
    expect(doc.text(left)).toBe("左栏\n😀");
    expect(doc.text(right)).toBe("右栏");
    expect(doc.children(columns)).toHaveLength(2);
    expect(doc.richChars(left)[0].marks.bold).toBe("true");
    const undo = new UndoManager();
    undo.record(tx, null, null);
    undo.undo(doc);
    expect(doc.text(left)).toBe("左栏😀");
    expect(doc.text(right)).toBe("右栏");
  });

  it("never deletes a column through cross-column or surrounding text operations", () => {
    const { doc, before, columns, left, right, after } = setup();
    const tx = new Tx(doc);
    deleteRange(tx, { a: { b: left, o: 1 }, f: { b: right, o: 1 } });
    expect(tx.ops).toHaveLength(0);
    deleteRange(tx, { a: { b: before, o: 1 }, f: { b: after, o: 1 } });
    joinForward(tx, before);
    joinBackward(tx, after);
    expect(doc.hasBlock(columns)).toBe(true);
    expect(doc.text(left)).toBe("左栏😀");
    expect(doc.text(right)).toBe("右栏");
    const reversed = normalize(doc, { a: { b: left, o: 2 }, f: { b: left, o: 0 } });
    expect(reversed.blocks).toEqual([left]);
    expect([reversed.start.o, reversed.end.o]).toEqual([0, 2]);
    expect(selectionContainsColumns(doc, { a: { b: before, o: 0 }, f: { b: after, o: 1 } })).toBe(true);
    expect(selectionContainsColumns(doc, { a: { b: left, o: 0 }, f: { b: left, o: 1 } })).toBe(false);
  });

  it.each(["before undo", "after undo"])("retains a collaborator's column text arriving %s", (arrival) => {
    const doc = new Doc(1);
    const init = new Tx(doc);
    const parent = init.create("columns", null, ROOT);
    const add = new Tx(doc);
    const column = createColumn(add, parent, null);
    const peer = Doc.fromState(2, doc.encodeState());
    const remote = peer.insertText(column, 0, "协作内容")!;
    const undo = new UndoManager();
    undo.record(safeColumnUndo(add), null, null);
    if (arrival === "before undo") doc.apply(remote);
    undo.undo(doc);
    if (arrival === "after undo") doc.apply(remote);
    expect(doc.hasBlock(column)).toBe(true);
    expect(doc.text(column)).toBe("协作内容");
    expect(doc.view().blocks.some((block) => block.id === `${column.client}:${column.clock}`)).toBe(true);
  });

  it.each(["before undo", "after undo"])("retains new column containers when remote text arrives %s", (arrival) => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const container = tx.create("columns", null, ROOT);
    const left = createColumn(tx, container, null);
    createColumn(tx, container, left);
    const peer = Doc.fromState(2, doc.encodeState());
    const remote = peer.insertText(left, 0, "远端文字")!;
    const undo = new UndoManager();
    undo.record(safeColumnUndo(tx), null, null);
    if (arrival === "before undo") doc.apply(remote);
    undo.undo(doc);
    if (arrival === "after undo") doc.apply(remote);
    expect(doc.hasBlock(container)).toBe(true);
    expect(doc.hasBlock(left)).toBe(true);
    expect(doc.text(left)).toBe("远端文字");
    expect(doc.view().blocks.some((block) => block.id === `${left.client}:${left.clock}`)).toBe(true);
  });

  it.each(["before", "after"])("refuses unsafe deletion and retains collaborator text arriving %s the request", (arrival) => {
    const { doc, left } = setup();
    const peer = Doc.fromState(2, doc.encodeState());
    const remote = peer.insertText(left, 2, "远端")!;
    if (arrival === "before") doc.apply(remote);
    expect(requestColumnDeletion(doc, left)).toBe("unsupported");
    if (arrival === "after") doc.apply(remote);
    expect(doc.hasBlock(left)).toBe(true);
    expect(doc.text(left)).toBe("左栏远端😀");
    expect(doc.view().blocks.some((block) => block.id === `${left.client}:${left.clock}`)).toBe(true);
  });

  it("resolves IME insertion against remote changes and refuses a missing anchor", () => {
    const { doc, left } = setup();
    const captured = captureCompositionAnchor(doc, { b: left, o: 1 });
    const peer = Doc.fromState(2, doc.encodeState());
    const remote = peer.insertText(left, 0, "远")!;
    doc.apply(remote);
    const resolved = resolveCompositionAnchor(doc, captured)!;
    expect(resolved.o).toBe(2);
    doc.insertText(resolved.b, resolved.o, "中");
    expect(doc.text(left)).toBe("远左中栏😀");
    doc.deleteText(left, 1, 1);
    expect(resolveCompositionAnchor(doc, captured)).toBeNull();
    expect(resolveCompositionAnchor(new Doc(3), captured)).toBeNull();
  });

  it("preserves an IME selection until commit and refuses concurrent edits within it", () => {
    const { doc, left } = setup();
    const captured = captureCompositionAnchor(doc, { b: left, o: 0 }, 2);
    expect(doc.text(left)).toBe("左栏😀"); // cancellation leaves the selection untouched
    const peer = Doc.fromState(2, doc.encodeState());
    doc.apply(peer.insertText(left, 0, "远")!);
    const selected = resolveCompositionSelection(doc, captured)!;
    expect([selected.a.o, selected.f.o]).toEqual([1, 3]);
    doc.apply(peer.insertText(left, 2, "协作")!);
    expect(resolveCompositionSelection(doc, captured)).toBeNull();
    expect(doc.text(left)).toContain("协作");
  });

  it("refuses IME input after a collaborator deletes the containing columns block", () => {
    const { doc, columns, left } = setup();
    const captured = captureCompositionAnchor(doc, { b: left, o: 1 });
    doc.deleteBlock(columns);
    expect(resolveCompositionSelection(doc, captured)).toBeNull();
  });

  it("refuses cross-block IME without deleting selected text or late peer edits", () => {
    const { doc, before, after } = setup();
    const peer = Doc.fromState(2, doc.encodeState());
    const late = peer.insertText(after, 1, "远端")!;
    const captured = captureCompositionSelection(doc, { a: { b: before, o: 1 }, f: { b: after, o: 1 } });
    expect(captured).toBeNull();
    expect(doc.text(before)).toBe("前文");
    expect(doc.text(after)).toBe("后文");
    doc.apply(late);
    expect(doc.text(after)).toBe("后远端文");
  });

  it("does not delete a same-block selection when composition is cancelled", () => {
    const { doc, left } = setup();
    const captured = captureCompositionSelection(doc, { a: { b: left, o: 2 }, f: { b: left, o: 0 } });
    expect(captured).not.toBeNull();
    expect(doc.text(left)).toBe("左栏😀");
    expect(resolveCompositionSelection(doc, captured!)?.a.o).toBe(0);
    expect(resolveCompositionSelection(doc, captured!)?.f.o).toBe(2);
  });

  it("renders separate editable blocks and keeps protected files unavailable", () => {
    const { doc } = setup();
    const tx = new Tx(doc);
    tx.create("file", null, ROOT, { fileId: "7", name: "文件.pdf", size: "100" });
    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const view = (readOnly: boolean, onCopyBlock: boolean) => renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} readOnly={readOnly} onCopyBlock={onCopyBlock} />);
    const html = view(false, false);
    expect((html.match(/data-column=/g) ?? [])).toHaveLength(2);
    expect((html.match(/contentEditable="true"/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('href="/api/files/7"');
    expect(html).toContain('aria-label="在第 1 栏后添加分栏"');
    expect(html).toContain("data-column-scroll");
    const protectedHTML = view(true, true);
    expect(protectedHTML).not.toContain('href="/api/files/7"');
    expect(protectedHTML).toContain("下载已关闭");
    expect(protectedHTML).not.toContain('contentEditable="true"');
  });
});
