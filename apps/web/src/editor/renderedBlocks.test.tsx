import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx, type OpId } from "@jiange/collab";
import type { SyncDoc } from "@/lib/useSyncDoc";
import { Editor } from "./Editor";

// Mermaid renders asynchronously in the browser. This test exercises the
// editor's surrounding block projection independently of Mermaid itself.
vi.mock("./DiagramView", () => ({ DiagramView: () => <span data-diagram-preview>流程图预览</span> }));

describe("rendered formula and diagram blocks", () => {
  it.each([false, true])("only shows their previews in readOnly=%s", (readOnly) => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    let after: OpId | null = null;
    for (const [type, text] of [
      ["math", "x^2+y^2"],
      ["diagram", "flowchart LR\nA-->B"],
      ["paragraph", "普通正文保留显示"],
    ]) {
      const block = tx.create(type, after, ROOT);
      tx.insert(block, 0, text);
      after = block;
    }
    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const html = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} readOnly={readOnly} />);
    expect(html).toContain('class="jiange-math"');
    expect(html).toContain("data-diagram-preview");
    expect(html).toContain("普通正文保留显示");
    expect(html).not.toContain("x^2+y^2");
    expect(html).not.toContain("flowchart LR");
    expect((html.match(/data-text=/g) ?? [])).toHaveLength(1);
  });
});
