import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx } from "@jiange/collab";
import type { SyncDoc } from "@/lib/useSyncDoc";
import { Editor } from "./Editor";

function renderDocument(url: string) {
  const doc = new Doc(1);
  const tx = new Tx(doc);
  const text = tx.create("paragraph", null, ROOT);
  tx.insert(text, 0, "文字链接");
  tx.format(text, 0, 4, "link", url);
  const bookmark = tx.create("bookmark", text, ROOT);
  tx.setProp(bookmark, "url", url);
  tx.setProp(bookmark, "name", "网页");
  const video = tx.create("video", bookmark, ROOT);
  tx.setProp(video, "url", url);
  tx.setProp(video, "name", "视频");
  const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
  return renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} />);
}

describe("untrusted document links in the editor", () => {
  it.each(["javascript:alert(1)", "data:text/html,bad", " JAVASCRIPT:alert(1)", "java\nscript:alert(1)", "//example.com/path"]) ("retains content without linking %s", (url) => {
    const html = renderDocument(url);
    expect(html).toContain("文字链接");
    expect(html).toContain("网页");
    expect(html).toContain("视频");
    expect(html).not.toMatch(/<a\b/);
    expect(html).not.toMatch(/<video\b/);
  });

  it("keeps https links usable in text, bookmarks, and video cards", () => {
    const html = renderDocument("https://example.com/page");
    expect((html.match(/href="https:\/\/example.com\/page"/g) ?? [])).toHaveLength(3);
  });

  it("keeps internal document mentions and validated video sources usable", () => {
    const internal = renderDocument("#/doc/42");
    expect(internal).toContain('href="#/doc/42" data-mention');
    const video = renderDocument("https://example.com/video.mp4");
    expect(video).toContain('src="https://example.com/video.mp4"');
  });
});
