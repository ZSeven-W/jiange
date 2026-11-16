import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentReferenceGraph, searchReferenceDocuments } from "./document-reference-graph";

afterEach(() => vi.unstubAllGlobals());
describe("document reference graph", () => {
  it("searches under the expected account and rejects malformed results", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ docs: [{ id: 4, title: "方案" }], truncated: false }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ docs: [{ id: -1, title: "错误" }], truncated: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    expect((await searchReferenceDocuments("需求", 7, signal)).docs[0].id).toBe(4);
    expect(fetcher.mock.calls[0][0]).toBe("/api/account-document-search?q=%E9%9C%80%E6%B1%82");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", cache: "no-store", headers: { "X-Jiange-User-Id": "7" }, signal });
    await expect(searchReferenceDocuments("需求", 7, signal)).rejects.toThrow("文档搜索结果无效");
  });
  it("renders a modal with search and no stale graph while permission is unverified", () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><DocumentReferenceGraph rootId={1} rootTitle="需求" userId={7} enabled={false} loadReferences={async () => ({ incoming: [], outgoing: [] })} onClose={() => {}}/></QueryClientProvider>);
    expect(html).toContain('aria-label="文档关系图"');
    expect(html).toContain('aria-label="搜索文档关系图"');
    expect(html).toContain('aria-label="缩小关系图"');
    expect(html).toContain('aria-label="放大关系图"');
    expect(html).toContain('aria-label="适应关系图画布"');
    expect(html).toContain("正在确认文档权限");
    expect(html).not.toContain("data-reference-graph-node");
  });
});
