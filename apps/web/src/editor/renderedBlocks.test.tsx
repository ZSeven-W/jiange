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

describe("separate copy and download controls", () => {
  it.each([
    { onCopyBlock: true, disableFileDownloads: false, codeCopy: false, fileLink: true },
    { onCopyBlock: false, disableFileDownloads: true, codeCopy: true, fileLink: false },
  ])("allows only the independently permitted action", ({ onCopyBlock, disableFileDownloads, codeCopy, fileLink }) => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const code = tx.create("code", null, ROOT);
    tx.insert(code, 0, "example");
    tx.create("file", code, ROOT, { fileId: "12", name: "report.pdf", size: "500" });
    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const html = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} onCopyBlock={onCopyBlock} disableFileDownloads={disableFileDownloads} />);
    expect(html.includes("data-code-copy")).toBe(codeCopy);
    expect(html.includes('href="/api/files/12"')).toBe(fileLink);
  });

  it("limits media download controls independently of text copying", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const first = tx.create("video", null, ROOT, { url: "https://example.com/demo.mp4", name: "视频" });
    tx.create("video", first, ROOT, { url: "https://example.com/watch", name: "外部视频" });
    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const restricted = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} disableFileDownloads />);
    expect(restricted).toContain('controlsList="nodownload"');
    expect(restricted).not.toContain('href="https://example.com/watch"');
    expect(restricted).toContain("当前不提供外部链接");
    const allowed = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} disableFileDownloads={false} />);
    expect(allowed).not.toContain('controlsList="nodownload"');
    expect(allowed).toContain('href="https://example.com/watch"');
  });
});
