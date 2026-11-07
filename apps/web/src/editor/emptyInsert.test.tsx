import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx } from "@jiange/collab";
import type { SyncDoc } from "@/lib/useSyncDoc";
import { Editor } from "./Editor";

function render(text: string, readOnly = false, extra = false) {
  const doc = new Doc(1);
  const tx = new Tx(doc);
  const block = tx.create("paragraph", null, ROOT);
  if (text) tx.insert(block, 0, text);
  if (extra) tx.create("paragraph", block, ROOT);
  const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
  return renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} readOnly={readOnly} />);
}

describe("empty document insertion affordance", () => {
  it("shows the existing insertion button without hover for a single empty editable paragraph", () => {
    const html = render("");
    expect(html).toContain("data-editor-placeholder");
    expect(html).toMatch(/<span class="[^"]*top-\[2px\][^"]*\bflex\b(?![^\"]*\bhidden\b)[^"]*"[^>]*><button[^>]*data-insert-after/);
  });

  it("uses the normal hover affordance for nonempty or multiple paragraphs and hides it in read-only mode", () => {
    expect(render("内容")).toMatch(/<span class="[^"]*\bhidden\b[^"]*group-hover:flex[^"]*"[^>]*><button[^>]*data-insert-after/);
    expect(render("", false, true)).toMatch(/<span class="[^"]*\bhidden\b[^"]*group-hover:flex[^"]*"[^>]*><button[^>]*data-insert-after/);
    expect(render("", true)).not.toContain("data-insert-after");
  });
});
