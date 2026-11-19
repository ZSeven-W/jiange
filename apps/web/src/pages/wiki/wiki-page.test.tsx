import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Me, WikiSpace, WikiSpaceDetail } from "@/lib/api";
import { nodeHref, parseHash } from "@/lib/route";
import { WikiSpacesPage } from "./wiki-spaces-page";
import { WikiSpacePage } from "./wiki-space-page";

const me: Me = {
  user: { id: 1, email: "owner@example.test", name: "Owner", createdAt: "2026-11-19T00:00:00Z" },
  workspaces: [{ id: 10, name: "研发团队空间", ownerId: 1 }],
};

describe("Wiki routes and pages", () => {
  it("parses wiki routes and routes wiki nodes via nodeHref", () => {
    expect(parseHash("#/wiki")).toEqual({ page: "wiki" });
    expect(parseHash("#/wiki/12")).toEqual({ page: "wiki-space", spaceId: 12, nodeId: null });
    expect(parseHash("#/wiki/12/node/45")).toEqual({ page: "wiki-space", spaceId: 12, nodeId: 45 });
    expect(nodeHref({ id: 45, kind: "doc", wikiSpaceId: 12 })).toBe("#/wiki/12/node/45");
    expect(nodeHref({ id: 45, kind: "doc", wikiSpaceId: null })).toBe("#/doc/45");
  });

  it("renders accessible Wiki spaces in WikiSpacesPage", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spaces: WikiSpace[] = [
      {
        id: 7,
        workspaceId: 10,
        name: "产品与研发知识库",
        description: "核心设计规范",
        icon: "📚",
        visibility: "workspace",
        creatorId: 1,
        creatorName: "Owner",
        callerRole: "manage",
        nodeCount: 3,
        createdAt: "2026-11-19T00:00:00Z",
        updatedAt: "2026-11-19T00:00:00Z",
      },
    ];
    qc.setQueryData(["wiki-spaces", 10, 1], spaces);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <WikiSpacesPage me={me} />
      </QueryClientProvider>,
    );
    expect(html).toContain("知识库");
    expect(html).toContain("产品与研发知识库");
    expect(html).toContain("全员可见");
    expect(html).toContain("新建知识库");
  });

  it("renders WikiSpacePage overview and hides create button for view-only member", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const detail: WikiSpaceDetail = {
      space: {
        id: 7,
        workspaceId: 10,
        name: "只读知识库",
        description: "全员阅读",
        icon: "📘",
        visibility: "workspace",
        creatorId: 2,
        creatorName: "Admin",
        callerRole: "view",
        nodeCount: 1,
        createdAt: "2026-11-19T00:00:00Z",
        updatedAt: "2026-11-19T00:00:00Z",
      },
      grants: [],
      nodes: [
        {
          id: 99,
          workspaceId: 10,
          wikiSpaceId: 7,
          parentId: null,
          kind: "doc",
          title: "入职指南",
          creatorId: 2,
          creatorName: "Admin",
          role: "view",
          revision: 1,
          inheritParentAcl: true,
          createdAt: "2026-11-19T00:00:00Z",
          updatedAt: "2026-11-19T00:00:00Z",
        },
      ],
    };
    qc.setQueryData(["wiki-space", 7, 1], detail);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <WikiSpacePage spaceId={7} nodeId={null} me={me} />
      </QueryClientProvider>,
    );
    expect(html).toContain("只读知识库");
    expect(html).toContain("入职指南");
    expect(html).not.toContain("data-wiki-create-menu");
    expect(html).not.toContain("data-wiki-space-settings");
  });
});
