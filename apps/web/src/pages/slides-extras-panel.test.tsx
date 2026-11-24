import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  slidesExtrasApi,
  type SlidesComment,
  type SlidesVersionMeta,
} from "@/lib/slides-extras-api";
import {
  filterSlidesComments,
  slidePageNumber,
  SlidesExtrasPanel,
} from "./slides-extras-panel";

const sampleComments: SlidesComment[] = [
  {
    id: 101,
    slidesId: 9,
    pageId: 11,
    shapeId: "shape-hero",
    authorId: 2,
    authorName: "李四",
    body: "封面标题建议加大字号",
    resolved: false,
    createdAt: "2026-11-24T04:10:00Z",
    updatedAt: "2026-11-24T04:10:00Z",
  },
  {
    id: 102,
    slidesId: 9,
    pageId: 12,
    shapeId: "",
    authorId: 1,
    authorName: "张三",
    body: "已核对第二页营收数据",
    resolved: true,
    createdAt: "2026-11-24T05:00:00Z",
    updatedAt: "2026-11-24T05:05:00Z",
  },
];

const sampleVersions: SlidesVersionMeta[] = [
  {
    id: 22,
    slidesId: 9,
    label: "恢复前自动备份",
    autoSaved: true,
    createdBy: 1,
    actorName: "张三",
    createdAt: "2026-11-24T05:30:00Z",
    pageCount: 4,
  },
  {
    id: 21,
    slidesId: 9,
    label: "评审定稿 v1",
    autoSaved: false,
    createdBy: 2,
    actorName: "李四",
    createdAt: "2026-11-24T04:00:00Z",
    pageCount: 3,
  },
];

describe("SlidesExtrasPanel helpers", () => {
  it("resolves slide page numbers for both 0-based and 1-based pageIndexById maps", () => {
    const zeroBased = new Map<number, number>([
      [11, 0],
      [12, 1],
      [13, 2],
    ]);
    const oneBased = new Map<number, number>([
      [11, 1],
      [12, 2],
      [13, 3],
    ]);
    expect(slidePageNumber(11, zeroBased)).toBe(1);
    expect(slidePageNumber(12, zeroBased)).toBe(2);
    expect(slidePageNumber(11, oneBased)).toBe(1);
    expect(slidePageNumber(13, oneBased)).toBe(3);
    expect(slidePageNumber(999, oneBased)).toBeNull();
    expect(slidePageNumber(null, oneBased)).toBeNull();
  });

  it("filters comments by current page, all pages, and unresolved state", () => {
    expect(filterSlidesComments(sampleComments, "all", 11).map((c) => c.id)).toEqual([101, 102]);
    expect(filterSlidesComments(sampleComments, "current", 11).map((c) => c.id)).toEqual([101]);
    expect(filterSlidesComments(sampleComments, "current", null)).toEqual([]);
    expect(filterSlidesComments(sampleComments, "unresolved", 11).map((c) => c.id)).toEqual([101]);
  });
});

describe("SlidesExtrasPanel comments tab", () => {
  const pageIndexById = new Map<number, number>([
    [11, 1],
    [12, 2],
  ]);

  it("renders segmented tabs, filter pills, composer with current slide & shape, and comment actions for managers", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["slides-comments", 9, 1], { comments: sampleComments });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SlidesExtrasPanel
          deckId={9}
          userId={1}
          currentPageId={11}
          selectedShapeId="shape-hero"
          pageIndexById={pageIndexById}
          canEdit
          canManage
          initialTab="comments"
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("data-slides-extras-panel");
    expect(html).toContain('data-slides-tab="comments"');
    expect(html).toContain('data-slides-tab="versions"');
    expect(html).toContain("评论批注");
    expect(html).toContain("历史版本");
    expect(html).toContain("当前页");
    expect(html).toContain("全部页面");
    expect(html).toContain("未解决");
    expect(html).toContain("第 1 页");
    expect(html).toContain("第 2 页");
    expect(html).toContain('data-slides-composer-shape="shape-hero"');
    expect(html).toContain("发送评论");
    expect(html).toContain("封面标题建议加大字号");
    expect(html).toContain("已核对第二页营收数据");
    expect(html).toContain('data-slides-comment-jump="11"');
    expect(html).toContain('data-slides-comment-resolve="101"');
    expect(html).toContain("标记已解决");
    expect(html).toContain("重新打开");
    expect(html).toContain('data-slides-comment-delete="101"');
    expect(html).toContain('data-slides-comment-delete="102"');
    expect(html).not.toContain("<select");
  });

  it("enforces viewer and editor action visibility per comment ownership", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["slides-comments", 9, 1], { comments: sampleComments });

    // Viewer (userId=1): owns #102, does NOT own #101.
    const viewerHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SlidesExtrasPanel
          deckId={9}
          userId={1}
          currentPageId={11}
          selectedShapeId={null}
          pageIndexById={pageIndexById}
          canEdit={false}
          canManage={false}
          initialTab="comments"
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(viewerHtml).not.toContain('data-slides-comment-resolve="101"');
    expect(viewerHtml).not.toContain('data-slides-comment-delete="101"');
    expect(viewerHtml).toContain('data-slides-comment-resolve="102"');
    expect(viewerHtml).toContain('data-slides-comment-delete="102"');

    // Editor (userId=1, canEdit=true, canManage=false): can resolve #101, cannot delete #101.
    const editorHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SlidesExtrasPanel
          deckId={9}
          userId={1}
          currentPageId={11}
          selectedShapeId={null}
          pageIndexById={pageIndexById}
          canEdit
          canManage={false}
          initialTab="comments"
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(editorHtml).toContain('data-slides-comment-resolve="101"');
    expect(editorHtml).not.toContain('data-slides-comment-delete="101"');
    expect(editorHtml).toContain('data-slides-comment-delete="102"');
  });
});

describe("SlidesExtrasPanel versions tab", () => {
  const pageIndexById = new Map<number, number>([[11, 1]]);

  it("renders version creation form, badges, page counts, and enabled restore buttons for editors", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["slides-comments", 9, 1], { comments: [] });
    qc.setQueryData(["slides-versions", 9, 1], { versions: sampleVersions });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SlidesExtrasPanel
          deckId={9}
          userId={1}
          currentPageId={11}
          selectedShapeId={null}
          pageIndexById={pageIndexById}
          canEdit
          canManage
          initialTab="versions"
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("data-slides-versions-pane");
    expect(html).toContain("data-slides-version-input");
    expect(html).toContain("保存版本");
    expect(html).toContain("评审定稿 v1");
    expect(html).toContain("恢复前自动备份");
    expect(html).toContain("手动命名");
    expect(html).toContain("自动备份");
    expect(html).toContain("共 4 页");
    expect(html).toContain("共 3 页");
    expect(html).toContain('data-slides-version-restore="21"');
    expect(html).not.toContain('data-slides-version-restore="21" disabled');
    expect(html).not.toContain("<select");
  });

  it("hides save form and disables restore buttons for read-only viewers", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["slides-comments", 9, 1], { comments: [] });
    qc.setQueryData(["slides-versions", 9, 1], { versions: sampleVersions });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <SlidesExtrasPanel
          deckId={9}
          userId={1}
          currentPageId={11}
          selectedShapeId={null}
          pageIndexById={pageIndexById}
          canEdit={false}
          canManage={false}
          initialTab="versions"
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(html).not.toContain("data-slides-version-save");
    expect(html).toContain("只读权限下可浏览历史版本");
    expect(html).toMatch(
      /disabled[^>]*data-slides-version-restore="21"|data-slides-version-restore="21"[^>]*disabled/,
    );
  });
});

describe("slidesExtrasApi", () => {
  it("sends X-Jiange-User-Id header, JSON payloads, handles 204 DELETE, and throws ApiError on failures", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const headers = init?.headers as Record<string, string>;
        expect(headers["X-Jiange-User-Id"]).toBe("7");

        if (method === "GET" && url === "/api/slides/9/comments") {
          return new Response(JSON.stringify({ comments: sampleComments }), { status: 200 });
        }
        if (method === "POST" && url === "/api/slides/9/comments") {
          expect(headers["Content-Type"]).toBe("application/json");
          expect(JSON.parse(String(init?.body))).toEqual({
            pageId: 11,
            shapeId: "shape-hero",
            body: "新批注",
          });
          return new Response(JSON.stringify({ comment: sampleComments[0] }), { status: 201 });
        }
        if (method === "PATCH" && url === "/api/slides/9/comments/101") {
          return new Response(JSON.stringify({ comment: { ...sampleComments[0], resolved: true } }), {
            status: 200,
          });
        }
        if (method === "DELETE" && url === "/api/slides/9/comments/101") {
          return new Response(null, { status: 204 });
        }
        if (method === "GET" && url === "/api/slides/9/versions") {
          return new Response(JSON.stringify({ versions: sampleVersions }), { status: 200 });
        }
        if (method === "POST" && url === "/api/slides/9/versions") {
          expect(JSON.parse(String(init?.body))).toEqual({ label: "v1" });
          return new Response(JSON.stringify({ version: sampleVersions[1] }), { status: 201 });
        }
        if (method === "POST" && url === "/api/slides/9/versions/21/restore") {
          return new Response(JSON.stringify({ pages: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "forbidden", message: "无权操作" }), {
          status: 403,
        });
      });
      globalThis.fetch = fetchMock as typeof fetch;

      expect((await slidesExtrasApi.listComments(9, 7)).comments).toHaveLength(2);
      expect(
        (
          await slidesExtrasApi.createComment(9, 7, {
            pageId: 11,
            shapeId: "shape-hero",
            body: "新批注",
          })
        ).comment.id,
      ).toBe(101);
      expect(
        (await slidesExtrasApi.updateComment(9, 7, 101, { resolved: true })).comment.resolved,
      ).toBe(true);
      await expect(slidesExtrasApi.deleteComment(9, 7, 101)).resolves.toBeUndefined();
      expect((await slidesExtrasApi.listVersions(9, 7)).versions).toHaveLength(2);
      expect((await slidesExtrasApi.createVersion(9, 7, "v1")).version.id).toBe(21);
      expect((await slidesExtrasApi.restoreVersion(9, 7, 21)).pages).toEqual([]);
      await expect(slidesExtrasApi.restoreVersion(9, 7, 999)).rejects.toBeInstanceOf(ApiError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
