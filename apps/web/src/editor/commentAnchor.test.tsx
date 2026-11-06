import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx, idKey } from "@jiange/collab";
import { commentSelection } from "./commentAnchor";
import { FormatToolbar } from "./FormatToolbar";

function setup() {
  const doc = new Doc(1);
  const tx = new Tx(doc);
  const first = tx.create("paragraph", null, ROOT);
  tx.insert(first, 0, "甲😀乙丙");
  const second = tx.create("paragraph", first, ROOT);
  tx.insert(second, 0, "另一段");
  return { doc, first, second };
}

describe("comment selection anchors", () => {
  it("uses the same inclusive IDs and quote for forward and reverse selections", () => {
    const { doc, first } = setup();
    const a = { b: first, o: 1 };
    const f = { b: first, o: 3 };
    const forward = commentSelection(doc, { a, f });
    const backward = commentSelection(doc, { a: f, f: a });
    expect(backward).toEqual(forward);
    expect(forward).toEqual({ ok: true, anchor: { block: idKey(first), startChar: idKey(doc.visibleIds(first)[1]), endChar: idKey(doc.visibleIds(first)[2]), quote: "😀乙" } });
  });

  it("handles the first and last character and rejects empty or invalid offsets", () => {
    const { doc, first } = setup();
    const pos = (o: number) => ({ b: first, o });
    expect(commentSelection(doc, { a: pos(0), f: pos(4) })).toEqual({ ok: true, anchor: { block: idKey(first), startChar: idKey(doc.visibleIds(first)[0]), endChar: idKey(doc.visibleIds(first)[3]), quote: "甲😀乙丙" } });
    expect(commentSelection(doc, { a: pos(0), f: pos(0) })).toEqual({ ok: false, reason: "empty" });
    expect(commentSelection(doc, { a: pos(4), f: pos(4) })).toEqual({ ok: false, reason: "empty" });
    expect(commentSelection(doc, { a: pos(-1), f: pos(1) })).toEqual({ ok: false, reason: "invalid" });
    expect(commentSelection(doc, { a: pos(1), f: pos(5) })).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects selections across blocks in either direction", () => {
    const { doc, first, second } = setup();
    const a = { b: first, o: 2 };
    const f = { b: second, o: 1 };
    expect(commentSelection(doc, { a, f })).toEqual({ ok: false, reason: "cross-block" });
    expect(commentSelection(doc, { a: f, f: a })).toEqual({ ok: false, reason: "cross-block" });
  });

  it("does not anchor hidden formula source", () => {
    const { doc, first } = setup();
    new Tx(doc).setProp(first, "type", "math");
    expect(commentSelection(doc, { a: { b: first, o: 0 }, f: { b: first, o: 1 } })).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("selection toolbar permissions", () => {
  const props = { x: 0, y: 0, marks: {}, blockType: "paragraph", onMark: vi.fn(), onLink: vi.fn(), onType: vi.fn() };
  it("shows comment but no formatting actions in read-only mode", () => {
    const html = renderToStaticMarkup(<FormatToolbar {...props} readOnly onComment={() => {}} />);
    expect(html).toContain('aria-label="评论"');
    expect(html).not.toContain('aria-label="加粗"');
    expect(html).not.toContain('title="文字颜色"');
    expect(html).not.toContain('title="链接"');
  });
  it("does not show comment when no callback is supplied", () => {
    const html = renderToStaticMarkup(<FormatToolbar {...props} />);
    expect(html).not.toContain('aria-label="评论"');
    expect(html).toContain('aria-label="加粗"');
  });
});
