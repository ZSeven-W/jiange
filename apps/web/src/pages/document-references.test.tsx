import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentReferencesPanel, fetchDocumentReferenceGraph, fetchDocumentReferences, referenceNodeHref } from "./document-references";

afterEach(() => vi.unstubAllGlobals());
describe("document reference list", () => {
  it("binds the account and validates reference targets and contexts", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ incoming: [{ id: 3, title: "方案", contexts: [{ block: "1:2", text: "项目说明" }] }], outgoing: [{ id: 4, title: "共享", href: "#/s/token" }] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ incoming: [{ id: 3, title: "方案", contexts: [{ block: "bad" }] }], outgoing: [] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ incoming: [], outgoing: [{ id: 4, title: "无效", href: "javascript:alert(1)" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    expect((await fetchDocumentReferences(5, 7, signal)).incoming[0].contexts?.[0].block).toBe("1:2");
    expect(fetcher.mock.calls[0][0]).toBe("/api/docs/5/references");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", cache: "no-store", headers: { "X-Jiange-User-Id": "7" }, signal });
    await expect(fetchDocumentReferences(5, 7, signal)).rejects.toThrow("引用查询结果无效");
    await expect(fetchDocumentReferences(5, 7, signal)).rejects.toThrow("引用查询结果无效");
  });
  it("shows the section without rendering unverified results", () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><DocumentReferencesPanel id={1} userId={2} enabled={false} synced={false} allowCopy={false}/></QueryClientProvider>);
    expect(html).toContain("反向引用");
    expect(html).toContain("文档尚未同步");
    expect(html).not.toContain("暂无反向引用");
  });
  it("shows the hide control only to an eligible editor", () => {
    const client = new QueryClient();
    const render = (onHide?: () => Promise<boolean>) => renderToStaticMarkup(<QueryClientProvider client={client}><DocumentReferencesPanel id={1} userId={2} enabled synced allowCopy onHide={onHide}/></QueryClientProvider>);
    expect(render()).not.toContain('aria-label="隐藏文档引用"');
    expect(render(async () => true)).toContain('aria-label="隐藏文档引用"');
  });
  it("validates multi-resource anchors, embed relations, and multi-hop graph payloads", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        indexed: true,
        incoming: [
          { id: 10, title: "季度PPT", kind: "slides", contexts: [{ block: "slide:7", text: "参考 #/doc/5" }] },
          { id: 11, title: "需求库", kind: "base", contexts: [{ block: "rec:9", text: "关联" }] },
        ],
        outgoing: [
          { id: 12, title: "排期表", kind: "sheet", relationKind: "embed" },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        centerId: 5,
        depth: 2,
        truncated: false,
        indexed: true,
        nodes: [
          { id: 5, title: "主文档", kind: "doc", depth: 0 },
          { id: 12, title: "排期表", kind: "sheet", depth: 1 },
          { id: 15, title: "二跳问卷", kind: "survey", depth: 2 },
        ],
        edges: [
          { sourceId: 5, targetId: 12, relationKind: "embed" },
          { sourceId: 12, targetId: 15, relationKind: "link" },
        ],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    const refs = await fetchDocumentReferences(5, 7, signal);
    expect(refs.incoming[0].kind).toBe("slides");
    expect(refs.outgoing[0].relationKind).toBe("embed");
    expect(referenceNodeHref(refs.outgoing[0])).toBe("#/sheet/12");
    const graph = await fetchDocumentReferenceGraph(5, 7, 2, signal);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges[0].relationKind).toBe("embed");
    expect(fetcher.mock.calls[1][0]).toBe("/api/docs/5/reference-graph?depth=2");
  });
});
