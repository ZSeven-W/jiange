import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { docsApi, driveApi, type DocMeta, type DriveEntry, type DriveShortcut, type Me } from "@/lib/api";
import { Home } from "./home";
import { DrivePage } from "./drive-page";
import { DriveUploadManager } from "./drive-upload";

afterEach(() => vi.unstubAllGlobals());

const me: Me = {
  user: { id: 7, name: "测试用户", email: "test@example.test", createdAt: "2026-11-01T00:00:00Z" },
  workspaces: [{ id: 1, name: "测试空间", ownerId: 7 }],
};

const sampleDoc: DocMeta = {
  id: 11,
  title: "Q4 产品规划",
  kind: "doc",
  workspaceId: 1,
  parentId: null,
  icon: "",
  creatorId: 7,
  creatorName: "测试用户",
  createdAt: "2026-11-18T10:00:00Z",
  updatedAt: "2026-11-19T10:00:00Z",
  role: "manage",
  driveRevision: 2,
};

const sampleBase: DocMeta = {
  id: 12,
  title: "客户台账",
  kind: "base",
  workspaceId: 1,
  parentId: null,
  icon: "",
  creatorId: 7,
  creatorName: "测试用户",
  createdAt: "2026-11-18T11:00:00Z",
  updatedAt: "2026-11-19T11:00:00Z",
  role: "manage",
  driveRevision: 1,
};

describe("home and drive operations closure", () => {
  it("renders dedicated pinned docs card section and batch checkboxes on Home", () => {
    const qc = new QueryClient();
    qc.setQueryData(["docs"], [sampleDoc, sampleBase]);
    qc.setQueryData(["recent", 7], [
      { ...sampleDoc, viewedAt: "2026-11-19T12:00:00Z" },
      { ...sampleBase, viewedAt: "2026-11-19T11:30:00Z" },
    ]);
    qc.setQueryData(["home-favorites", 7], []);
    qc.setQueryData(["home-pins", 7], [sampleDoc]);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Home me={me} uploads={new DriveUploadManager(7, () => {})} />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-home-pins");
    expect(html).toContain('data-home-pin-card="11"');
    expect(html).toContain("置顶文档");
    expect(html).toContain("data-home-select");
  });

  it("renders enabled shortcut button, live/revoked shortcut cards, and draggable drive entries", () => {
    const qc = new QueryClient();
    const folderEntry: DriveEntry = {
      id: 21, workspaceId: 1, parentId: null, kind: "folder", title: "研发归档",
      role: "manage", revision: 1, personal: true, updatedAt: "2026-11-19T10:00:00Z",
    };
    const baseEntry: DriveEntry = {
      id: 22, workspaceId: 1, parentId: null, kind: "base", title: "项目跟踪",
      role: "manage", revision: 1, personal: true, updatedAt: "2026-11-19T11:00:00Z",
    };
    const shortcuts: DriveShortcut[] = [
      {
        id: 1, workspaceId: 1, parentId: null, personal: true, targetNodeId: 11, title: "Q4 产品规划",
        creatorId: 7, creatorName: "测试用户", createdAt: "2026-11-19T10:00:00Z", updatedAt: "2026-11-19T10:00:00Z",
        targetAccessible: true, targetKind: "doc", targetTitle: "Q4 产品规划",
      },
      {
        id: 2, workspaceId: 1, parentId: null, personal: true, targetNodeId: 99, title: "旧文档",
        creatorId: 7, creatorName: "测试用户", createdAt: "2026-11-19T10:00:00Z", updatedAt: "2026-11-19T10:00:00Z",
        targetAccessible: false,
      },
    ];
    qc.setQueryData(["drive", null, true], [folderEntry, baseEntry]);
    qc.setQueryData(["drive-shortcuts", null, true], shortcuts);
    qc.setQueryData(["favorites"], []);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <DrivePage folderId={null} personalRoot userId={7} uploads={new DriveUploadManager(7, () => {})} />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-drive-add-shortcut");
    expect(html).not.toContain('title="暂不支持添加快捷方式"');
    expect(html).toContain("data-drive-shortcuts");
    expect(html).toContain('data-drive-shortcut="1"');
    expect(html).toContain("原文档已删除或无权访问");
    expect(html).toContain('data-drive-folder="21"');
    expect(html).toContain('draggable="true"');
  });

  it("serializes shortcut APIs and duplicate-to-folder destination payload", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ shortcuts: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 5, targetNodeId: 11, targetAccessible: true }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 88, kind: "base", parentId: 21 }), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(driveApi.shortcuts(21, true)).resolves.toEqual([]);
    await expect(driveApi.createShortcut(11, 21, true, 7)).resolves.toMatchObject({ id: 5 });
    await expect(driveApi.deleteShortcut(5, 7)).resolves.toBeUndefined();
    await expect(docsApi.duplicateForAccount(12, 7, { parentId: 21, personal: true })).resolves.toMatchObject({ id: 88, parentId: 21 });

    expect(fetcher.mock.calls[0][0]).toBe("/api/drive/shortcuts?parent=21&scope=personal");
    expect(fetcher.mock.calls[1][0]).toBe("/api/drive/shortcuts");
    expect(JSON.parse(String(fetcher.mock.calls[1][1].body))).toEqual({ targetNodeId: 11, parentId: 21, scope: "personal" });
    expect(fetcher.mock.calls[1][1].headers["X-Jiange-User-Id"]).toBe("7");
    expect(fetcher.mock.calls[2][0]).toBe("/api/drive/shortcuts/5");
    expect(fetcher.mock.calls[2][1].method).toBe("DELETE");
    expect(fetcher.mock.calls[3][0]).toBe("/api/docs/12/account-duplicate");
    expect(JSON.parse(String(fetcher.mock.calls[3][1].body))).toEqual({ parentId: 21, personal: true });
  });
});
