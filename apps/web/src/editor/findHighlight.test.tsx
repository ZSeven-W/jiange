import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx, idKey } from "@jiange/collab";
import type { Comment } from "@/lib/api";
import type { SyncDoc } from "@/lib/useSyncDoc";
import { Editor } from "./Editor";
import { findMatches } from "./findReplace";

describe("editor find highlights", () => {
  it("preserves code-point text, marks and comments across highlighted runs", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const block = tx.create("paragraph", null, ROOT);
    tx.insert(block, 0, "前中😀文后");
    tx.format(block, 1, 3, "bold", "true");
    const ids = doc.visibleIds(block);
    const comment: Comment = { id: 11, docId: 1, userId: 1, userName: "测试", block: idKey(block), startChar: idKey(ids[1]), endChar: idKey(ids[3]), quote: "中😀文", body: "评论", resolved: false, createdAt: "", updatedAt: "" };
    const matches = findMatches(doc, "中😀文");
    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const html = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} comments={[comment]} findMatches={matches} activeFindMatch={matches[0]} />);
    expect(html.replace(/<[^>]*>/g, "")).toContain("前中😀文后");
    expect(html).toContain('data-comment-anchor="11"');
    expect(html).toContain("font-semibold");
    expect((html.match(/data-find-active="true"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("does not highlight a stale match after remote text changes", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const block = tx.create("paragraph", null, ROOT);
    tx.insert(block, 0, "前中😀文后");
    const matches = findMatches(doc, "中😀文");
    doc.insertText(block, 2, "远端");
    const sync = { client: { doc }, peers: [], version: 1 } as unknown as SyncDoc;
    const html = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} findMatches={matches} activeFindMatch={matches[0]} />);
    expect(html.replace(/<[^>]*>/g, "")).toContain("前中远端😀文后");
    expect(html).not.toContain("data-find-match");
  });

  it("temporarily shows the search color over text with a background mark", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const block = tx.create("paragraph", null, ROOT);
    tx.insert(block, 0, "标记文字");
    tx.format(block, 0, 4, "bg", "#00ff00");
    const matches = findMatches(doc, "标记");
    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const highlighted = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} findMatches={matches} activeFindMatch={matches[0]} />);
    expect(highlighted).toMatch(/<mark[^>]*data-find-active="true"[^>]*>标记<\/mark>/);
    expect(doc.richChars(block)[0].marks.bg).toBe("#00ff00");
    const normal = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} />);
    expect(normal).toContain("background:#00ff00");
  });

  it("highlights the active match inside a column and removes it after a move", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const columns = tx.create("columns", null, ROOT);
    const left = tx.create("paragraph", null, columns);
    tx.insert(left, 0, "前😀目标后");
    tx.format(left, 2, 4, "bg", "#00ff00");
    const matches = findMatches(doc, "目标");
    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const html = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} findMatches={matches} activeFindMatch={matches[0]} />);
    expect(html).toContain(`data-column="${idKey(left)}"`);
    expect((html.match(/data-find-active="true"/g) ?? [])).toHaveLength(1);
    expect(html).not.toContain("background:#00ff00");
    expect(doc.richChars(left)[2].marks.bg).toBe("#00ff00");
    new Tx(doc).move(left, columns, ROOT);
    const stale = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} findMatches={matches} activeFindMatch={matches[0]} />);
    expect(stale).not.toContain("data-find-match");
  });

  it("keeps inline formula source out of search and groups a highlighted link", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const columns = tx.create("columns", null, ROOT);
    const left = tx.create("paragraph", null, columns);
    tx.insert(left, 0, "abc链接");
    tx.format(left, 0, 3, "math", "x^2");
    tx.format(left, 3, 5, "link", "https://example.com");
    const matches = findMatches(doc, "链接");
    const sync = { client: { doc }, peers: [], version: 0 } as unknown as SyncDoc;
    const html = renderToStaticMarkup(<Editor sync={sync} me={{ name: "测试", color: "#3370ff" }} findMatches={matches} activeFindMatch={matches[0]} />);
    expect(html).toContain('title="$x^2$"');
    expect((html.match(/href="https:\/\/example.com"/g) ?? [])).toHaveLength(1);
    expect(html).toContain("data-find-active=\"true\"");
    expect(findMatches(doc, "abc")).toHaveLength(0);
  });
});
