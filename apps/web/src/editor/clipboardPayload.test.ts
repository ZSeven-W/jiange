import { describe, expect, it, vi } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { CLIP_MIME, clipboardBlocks, columnClipboardBlocks, writeBlockClipboard } from "./clipboardPayload";
import { deleteRange, mathSpans, pasteBlocks } from "./model";
import { tableRowsOf, writeTable } from "./tableCells";

describe("clipboard payload validation", () => {
  it("does not report a block copy as successful if the clipboard event did not write", () => {
    let listener: ((event: ClipboardEvent) => void) | undefined;
    const doc = {
      addEventListener: (_: string, callback: (event: ClipboardEvent) => void) => { listener = callback; },
      removeEventListener: vi.fn(),
      execCommand: vi.fn(() => true),
    } as unknown as Document;
    const block = [{ type: "table", props: { tableData: '[["值"]]' }, chars: [] }];
    expect(writeBlockClipboard(doc, "", block)).toBe(false);
    const data = new Map<string, string>();
    vi.mocked(doc.execCommand).mockImplementation(() => {
      listener?.({ clipboardData: { setData: (key: string, value: string) => data.set(key, value) }, preventDefault: vi.fn() } as unknown as ClipboardEvent);
      return true;
    });
    expect(writeBlockClipboard(doc, "", block)).toBe(true);
    expect(JSON.parse(data.get(CLIP_MIME)!)).toEqual(block);
    vi.mocked(doc.execCommand).mockImplementation(() => {
      listener?.({ clipboardData: null } as ClipboardEvent);
      return true;
    });
    expect(writeBlockClipboard(doc, "", block)).toBe(false);
  });
  it.each(["", "null", "{}", "[]", '[{"type":"paragraph","props":{}}]', '[{"type":"paragraph","props":{},"chars":[{}]}]', '[{"type":"paragraph","props":{},"chars":[{"ch":"ab","marks":{}}]}]'])("keeps selected text when payload is unusable: %s", (raw) => {
    const doc = new Doc(1), tx = new Tx(doc), block = tx.create("paragraph", null, ROOT);
    tx.insert(block, 0, "原文保留");
    const clip = clipboardBlocks(raw, "");
    if (clip) {
      const op = new Tx(doc);
      const at = deleteRange(op, { a: { b: block, o: 0 }, f: { b: block, o: 4 } });
      pasteBlocks(op, at, clip);
    }
    expect(clip).toBeNull();
    expect(doc.text(block)).toBe("原文保留");
  });

  it("pastes a single copied image block after the caret, or in place of an empty paragraph", () => {
    const doc = new Doc(1), tx = new Tx(doc), block = tx.create("paragraph", null, ROOT);
    tx.insert(block, 0, "正文");
    const clip = clipboardBlocks('[{"type":"image","props":{"fileId":"7","caption":"图"},"chars":[]}]', "")!;
    expect(clip).toHaveLength(1);
    const caret = pasteBlocks(new Tx(doc), { b: block, o: 2 }, clip);
    const types = doc.view().blocks.filter((b) => b.parent !== undefined).map((b) => b.type);
    expect(types).toContain("image");
    expect(doc.text(block)).toBe("正文");
    expect(doc.blockInfo(caret.b).type).toBe("paragraph");
    const empty = new Tx(doc).create("paragraph", caret.b, ROOT);
    pasteBlocks(new Tx(doc), { b: empty, o: 0 }, clipboardBlocks('[{"type":"divider","props":{},"chars":[]}]', "")!);
    expect(doc.blockInfo(empty).type).toBe("divider");
  });

  it.each([true, false])("preserves explicit empty table cells when pasted (empty paragraph: %s)", (empty) => {
    const doc = new Doc(1), init = new Tx(doc);
    const table = init.create("table", null, ROOT, { tableData: JSON.stringify([["原值", "保留"]]) });
    const props = doc.blockInfo(table).props;
    writeTable(new Tx(doc), table, props, [["", "保留"]], doc.client);
    const copied = [{ type: "table", props: doc.blockInfo(table).props, chars: [] }];
    const clip = clipboardBlocks(JSON.stringify(copied), "")!;
    const paragraph = new Tx(doc).create("paragraph", table, ROOT);
    if (!empty) new Tx(doc).insert(paragraph, 0, "正文");
    pasteBlocks(new Tx(doc), { b: paragraph, o: empty ? 0 : 2 }, clip);
    const pasted = doc.view().blocks.filter((block) => block.type === "table").at(-1)!;
    expect(tableRowsOf(pasted.props)).toEqual([["", "保留"]]);
    expect(pasted.props["tbl.v"]).toBeUndefined();
  });

  it("rejects a sparse clipboard table whose axes would expand beyond the limit", () => {
    const rows = Array.from({ length: 501 }, (_, i) => `r${i}`);
    const cols = Array.from({ length: 101 }, (_, i) => `c${i}`);
    const props = { "tbl.v": "2", "tbl.rows": JSON.stringify(rows), "tbl.cols": JSON.stringify(cols), tableData: "[]" };
    expect(clipboardBlocks(JSON.stringify([{ type: "table", props, chars: [] }]), "")).toBeNull();
  });

  it("falls back to literal plain text for invalid custom data", () => {
    expect(clipboardBlocks('{"bad":true}', "# 标题")?.[0].chars.map((x) => x.ch).join("")).toBe("# 标题");
  });

  it("retains valid internal rich text and multiple empty lines", () => {
    const rich = [{ type: "paragraph", props: {}, chars: [{ ch: "好", marks: { bold: "true" } }] }];
    expect(clipboardBlocks(JSON.stringify(rich), "其他")).toEqual(rich);
    expect(clipboardBlocks("", "\n")?.length).toBe(2);
  });

  it("keeps formula formatting when pasting inside a column and assigns a fresh identity", () => {
    const doc = new Doc(1), tx = new Tx(doc), container = tx.create("columns", null, ROOT), block = tx.create("paragraph", null, container);
    tx.insert(block, 0, "abc");
    tx.format(block, 0, 3, "math", "x^2");
    tx.format(block, 0, 3, "mathId", "original");
    const rich = [{ type: "paragraph", props: {}, chars: doc.richChars(block) }];
    const clip = columnClipboardBlocks(JSON.stringify(rich), "abc")!;
    pasteBlocks(new Tx(doc), { b: block, o: 3 }, clip);
    expect(doc.text(block)).toBe("abcabc");
    const spans = mathSpans(doc, block);
    expect(spans.map(({ start, end }) => [start, end])).toEqual([[0, 3], [3, 6]]);
    expect(spans[1].id).not.toBe(spans[0].id);
    expect(columnClipboardBlocks("", "一\n二")?.[0].chars.map(({ ch }) => ch).join("")).toBe("一\n二");
    const unsupported = [{ type: "image", props: { fileId: "1" }, chars: [] }, { type: "paragraph", props: {}, chars: [{ ch: "字", marks: {} }] }];
    expect(columnClipboardBlocks(JSON.stringify(unsupported), "字")).toBeNull();
  });
});
