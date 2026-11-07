import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { Editor } from "./Editor";
import type { SyncDoc } from "@/lib/useSyncDoc";

function render(blockType: "paragraph" | "column") {
  const doc = new Doc(1), tx = new Tx(doc);
  const container = blockType === "column" ? tx.create("columns", null, ROOT) : ROOT;
  const block = tx.create("paragraph", null, container);
  tx.insert(block, 0, "前x^2x^2后😀");
  tx.format(block, 1, 4, "math", "x^2");
  tx.format(block, 1, 4, "mathId", "first");
  tx.format(block, 2, 3, "bold", "true");
  tx.format(block, 2, 3, "link", "#/doc/2");
  tx.format(block, 4, 7, "math", "x^2");
  tx.format(block, 4, 7, "mathId", "second");
  const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
  return renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} />);
}

describe("inline math rendering", () => {
  it.each(["paragraph", "column"] as const)("renders adjacent formula instances once each in %s with mixed marks", (kind) => {
    const html = render(kind);
    expect(html.match(/data-inline-math/g)).toHaveLength(2);
    expect(html.match(/data-model-length="3"/g)).toHaveLength(2);
    expect(html).not.toContain("data-mention");
    expect(html).toContain("后😀");
  });
});
