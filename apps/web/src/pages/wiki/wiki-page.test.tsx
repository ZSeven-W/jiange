import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Me, WikiSpace, WikiSpaceDetail } from "@/lib/api";
import { nodeHref, parseHash } from "@/lib/route";
import { WikiSpacesPage } from "./wiki-spaces-page";
import { WikiSpacePage } from "./wiki-space-page";
import { WikiMoveNodeDialog, WikiImportDriveDialog } from "./wiki-move-import-dialogs";
import { WikiShortcutDialog } from "./wiki-shortcut-dialog";
import { WikiSpaceSettingsDialog } from "./wiki-space-settings-dialog";

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
      shortcuts: [
        {
          id: 501,
          workspaceId: 10,
          wikiSpaceId: 7,
          parentId: null,
          targetNodeId: 201,
          title: "设计系统规范",
          creatorId: 2,
          creatorName: "Admin",
          createdAt: "2026-11-20T00:00:00Z",
          updatedAt: "2026-11-20T00:00:00Z",
          targetAccessible: true,
          targetKind: "doc",
          targetTitle: "设计系统规范",
          targetWikiSpaceId: 8,
          targetWikiSpaceName: "设计中心",
        },
        {
          id: 502,
          workspaceId: 10,
          wikiSpaceId: 7,
          parentId: null,
          targetNodeId: 202,
          title: "",
          creatorId: 2,
          creatorName: "Admin",
          createdAt: "2026-11-20T00:00:00Z",
          updatedAt: "2026-11-20T00:00:00Z",
          targetAccessible: false,
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
    expect(html).toContain('data-wiki-shortcut-row="501"');
    expect(html).toContain("设计系统规范");
    expect(html).toContain("设计中心");
    expect(html).toContain('data-wiki-shortcut-locked="502"');
    expect(html).toContain("无权访问或已删除");
    expect(html).not.toContain("data-wiki-create-menu");
    expect(html).not.toContain("data-wiki-space-settings");
  });

  it("renders FeishuSelect comboboxes across wiki workspace switcher and dialogs without native selects", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const multiWsMe: Me = {
      ...me,
      workspaces: [
        { id: 10, name: "研发团队空间", ownerId: 1 },
        { id: 11, name: "设计团队空间", ownerId: 1 },
      ],
    };
    const space: WikiSpace = {
      id: 7,
      workspaceId: 10,
      name: "产品与研发知识库",
      description: "核心设计规范",
      icon: "📚",
      visibility: "workspace",
      creatorId: 1,
      creatorName: "Owner",
      callerRole: "manage",
      nodeCount: 1,
      createdAt: "2026-11-19T00:00:00Z",
      updatedAt: "2026-11-19T00:00:00Z",
    };
    const otherSpace: WikiSpace = { ...space, id: 8, name: "设计知识库" };
    const node = {
      id: 99,
      workspaceId: 10,
      wikiSpaceId: 7,
      parentId: null,
      kind: "doc" as const,
      title: "入职指南",
      creatorId: 1,
      creatorName: "Owner",
      role: "manage" as const,
      revision: 1,
      inheritParentAcl: true,
      createdAt: "2026-11-19T00:00:00Z",
      updatedAt: "2026-11-19T00:00:00Z",
    };
    qc.setQueryData(["wiki-spaces", 10, 1], [space, otherSpace]);
    qc.setQueryData(["wiki-space", 7, 1], { space, grants: [], nodes: [node], shortcuts: [] });
    qc.setQueryData(["wiki-import-drive", "shared", 1], []);
    qc.setQueryData(["workspace-org", 10, 1], {
      workspaceId: 10,
      workspaceName: "研发团队空间",
      callerRole: "owner",
      members: [],
      departments: [{ id: 101, workspaceId: 10, parentId: null, name: "研发中心", sortOrder: 1, members: [], createdAt: "", updatedAt: "" }],
      groups: [],
    });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <WikiSpacesPage me={multiWsMe} />
        <WikiMoveNodeDialog node={node} workspaceId={10} userId={1} onClose={() => {}} onMoved={() => {}} />
        <WikiImportDriveDialog spaceId={7} nodes={[node]} userId={1} onClose={() => {}} onImported={() => {}} />
        <WikiShortcutDialog spaceId={7} workspaceId={10} userId={1} nodes={[node]} onClose={() => {}} onCreated={() => {}} />
        <WikiSpaceSettingsDialog
          space={space}
          grants={[{ subjectType: "department", subjectId: 101, name: "研发中心", role: "edit" }]}
          userId={1}
          onClose={() => {}}
          onDeleted={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="切换企业空间"');
    expect(html).toContain("data-wiki-import-source");
    expect(html).toContain("data-wiki-shortcut-space-select");
    expect(html).toContain("data-wiki-shortcut-parent");
    expect(html).toContain("data-wiki-grant-type");
    expect(html).toContain("data-wiki-grant-subject");
    expect(html).toContain("data-wiki-grant-role");
    expect(html).toContain("data-select-value");
    expect(html).toContain("data-select-options");
  });
});
