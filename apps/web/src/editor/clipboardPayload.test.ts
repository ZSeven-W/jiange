import { describe, expect, it } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { clipboardBlocks } from "./clipboardPayload";
import { deleteRange, pasteBlocks } from "./model";

describe("clipboard payload validation", () => {
  it.each(["", "null", "{}", "[]", '[{"type":"paragraph","props":{}}]', '[{"type":"paragraph","props":{},"chars":[{}]}]', '[{"type":"paragraph","props":{},"chars":[{"ch":"ab","marks":{}}]}]', '[{"type":"image","props":{"fileId":"7"},"chars":[]}]', '[{"type":"divider","props":{},"chars":[]}]'])("keeps selected text when payload is unusable: %s", (raw) => {
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

  it("falls back to literal plain text for invalid custom data", () => {
    expect(clipboardBlocks('{"bad":true}', "# 标题")?.[0].chars.map((x) => x.ch).join("")).toBe("# 标题");
  });

  it("retains valid internal rich text and multiple empty lines", () => {
    const rich = [{ type: "paragraph", props: {}, chars: [{ ch: "好", marks: { bold: "true" } }] }];
    expect(clipboardBlocks(JSON.stringify(rich), "其他")).toEqual(rich);
    expect(clipboardBlocks("", "\n")?.length).toBe(2);
  });
});
