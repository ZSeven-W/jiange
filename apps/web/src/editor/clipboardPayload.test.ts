import { describe, expect, it, vi } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { blockClipboardHTML, blockClipboardPlain, blockPayloadFromHTML, clipboardBlocks, columnClipboardBlocks, confirmBlockClipboard, cutConfirmedBlock, hasHiddenTableContent, writeBlockClipboard } from "./clipboardPayload";
import { deleteRange, mathSpans, pasteBlocks } from "./model";
import { tableRowsOf, writeTable } from "./tableCells";

describe("clipboard payload validation", () => {
  it("writes human-readable text and bounded structured HTML, and handles denial", async () => {
    class Item { constructor(readonly entries: Record<string, Blob>) {} }
    const write = vi.fn(async (_items: unknown[]) => {});
    const block = [{ type: "table", props: { tableData: '[["值","另"]]' }, chars: [] }];
    const raw = await writeBlockClipboard({ write } as unknown as Clipboard, Item as unknown as typeof ClipboardItem, blockClipboardPlain(block[0]), block);
    expect(raw).toBe(JSON.stringify(block));
    const item = write.mock.calls[0][0][0] as Item;
    expect(await item.entries["text/plain"].text()).toBe("值\t另");
    expect(await item.entries["text/html"].text()).toContain("data-jiange-blocks=");
    expect(await item.entries["text/html"].text()).toContain("<table><tr><td>值</td><td>另</td></tr></table>");
    expect(await writeBlockClipboard(undefined, Item as unknown as typeof ClipboardItem, "x", block)).toBeNull();
    write.mockRejectedValueOnce(new Error("denied"));
    expect(await writeBlockClipboard({ write } as unknown as Clipboard, Item as unknown as typeof ClipboardItem, "x", block)).toBeNull();
    expect(await writeBlockClipboard({ write: () => new Promise(() => {}) } as unknown as Clipboard, Item as unknown as typeof ClipboardItem, "x", block, 1)).toBeNull();
    expect(blockClipboardHTML("x".repeat(2 * 1024 * 1024 + 1), "x")).toBeNull();
  });

  it("avoids exposing hidden merged data and escapes visible HTML", () => {
    const hidden = { type: "table", props: { tableData: JSON.stringify([["<b>可见</b>", "隐藏内容"]]), tableMerges: "[[0,0,1,2]]" }, chars: [] };
    expect(hasHiddenTableContent(hidden)).toBe(true);
    const visible = { ...hidden, props: { ...hidden.props, tableData: JSON.stringify([["<b>可见</b>", ""]]) } };
    expect(hasHiddenTableContent(visible)).toBe(false);
    const html = blockClipboardHTML(JSON.stringify([visible]), blockClipboardPlain(visible), [visible])!;
    expect(html).toContain('colspan="2"');
    expect(html).toContain("&lt;b&gt;可见&lt;/b&gt;");
    expect(html).not.toContain("<b>可见</b>");
  });

  it("requires exact readback of the structured HTML before confirming a cut", async () => {
    const raw = '[{"type":"divider","props":{},"chars":[]}]';
    const html = blockClipboardHTML(raw, "---")!;
    expect(blockPayloadFromHTML(html)).toBe(raw);
    const read = vi.fn(async () => [{ types: ["text/html"], getType: async () => new Blob([html], { type: "text/html" }) }]);
    expect(await confirmBlockClipboard({ read } as unknown as Clipboard, raw, 30)).toBe(true);
    expect(await confirmBlockClipboard({ read } as unknown as Clipboard, "different", 30)).toBe(false);
    expect(await confirmBlockClipboard({ read: () => new Promise(() => {}) } as unknown as Clipboard, raw, 1)).toBe(false);
    expect(blockPayloadFromHTML('<div data-jiange-blocks="%%%"></div>')).toBeNull();
    expect(blockPayloadFromHTML(html + html)).toBeNull();
    expect(blockPayloadFromHTML(blockClipboardHTML('[{"type":"paragraph","props":{},"chars":[]}]', "x")!)).toBeNull();
    expect(blockPayloadFromHTML(`<html><body><!--StartFragment-->${html}<!--EndFragment--></body></html>`)).toBe(raw);
    expect(blockPayloadFromHTML(html.replace("<div data-jiange-blocks", "<DIV DATA-JIANGE-BLOCKS"))).toBe(raw);
    expect(blockPayloadFromHTML(`<script>${html}</script>`)).toBeNull();
    const remove = vi.fn();
    expect(await cutConfirmedBlock({ read } as unknown as Clipboard, "different", () => true, remove, 30)).toBe("unconfirmed");
    expect(await cutConfirmedBlock({ read } as unknown as Clipboard, raw, () => false, remove, 30)).toBe("changed");
    expect(remove).not.toHaveBeenCalled();
    expect(await cutConfirmedBlock({ read } as unknown as Clipboard, raw, () => true, remove, 30)).toBe("cut");
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it.each(["table", "image", "file", "divider", "bookmark", "video", "flowchart"])("recognizes a structured %s block without parsing unrelated HTML", (type) => {
    const raw = JSON.stringify([{ type, props: {}, chars: [] }]);
    const html = blockClipboardHTML(raw, "内容")!;
    expect(blockPayloadFromHTML(`${html}<img src="https://example.invalid/tracker">`)).toBe(raw);
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
