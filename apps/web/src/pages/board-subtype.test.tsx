import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { driveApi, type DocMeta, type DriveEntry, type Me } from "@/lib/api";
import { docTitle, isBoardDoc, Sidebar } from "@/components/sidebar";
import { DriveUploadManager } from "./drive-upload";
import { DrivePage } from "./drive-page";
import { Home } from "./home";
import { Trash } from "./trash";

afterEach(() => vi.unstubAllGlobals());

describe("board document subtype UI", () => {
  const me: Me = {
    user: { id: 7, name: "测试", email: "test@example.test", createdAt: "2026-01-01" },
    workspaces: [{ id: 1, name: "测试空间", ownerId: 7 }],
  };

  it("identifies board documents and formats untitled board titles", () => {
    expect(isBoardDoc({ kind: "doc", docType: "board" })).toBe(true);
    expect(isBoardDoc({ docType: "board" })).toBe(true);
    expect(isBoardDoc({ kind: "doc", docType: "" })).toBe(false);
    expect(isBoardDoc({ kind: "base", docType: "board" })).toBe(false);
    expect(docTitle({ title: "", kind: "doc", docType: "board" })).toBe("未命名画板");
    expect(docTitle({ title: "", kind: "doc" })).toBe("未命名文档");
    expect(docTitle({ title: "架构图", kind: "doc", docType: "board" })).toBe("架构图");
  });

  it("renders distinct board icons, filter options, and trash badges across home, sidebar, drive, and trash", () => {
    const board: DocMeta = {
      id: 11,
      title: "",
      updatedAt: "2026-11-18",
      createdAt: "2026-11-18",
      workspaceId: 1,
      parentId: null,
      icon: "",
      creatorId: 7,
      creatorName: "测试",
      kind: "doc",
      docType: "board",
      role: "manage",
      driveRevision: 2,
    };
    const plain: DocMeta = { ...board, id: 12, title: "普通笔记", docType: "" };

    const qc = new QueryClient();
    qc.setQueryData(["docs"], [board, plain]);
    qc.setQueryData(["recent", 7], [{ ...board, viewedAt: "2026-11-18" }, { ...plain, viewedAt: "2026-11-18" }]);
    qc.setQueryData(["pins"], [board]);
    qc.setQueryData(["favorites"], []);
    qc.setQueryData(["home-favorites", 7], []);
    qc.setQueryData(["home-pins", 7], [board]);
    qc.setQueryData(["shared"], []);
    qc.setQueryData(["trash"], [board]);
    const driveEntry: DriveEntry = {
      id: 11,
      workspaceId: 1,
      parentId: null,
      kind: "doc",
      docType: "board",
      title: "",
      role: "manage",
      revision: 2,
      personal: true,
      updatedAt: "2026-11-18",
    };
    qc.setQueryData(["drive", null, true], [driveEntry]);

    const homeHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Home me={me} uploads={new DriveUploadManager(7, () => {})} />
      </QueryClientProvider>,
    );
    expect(homeHtml).toContain('<option value="board">画板</option>');
    expect(homeHtml).toContain("未命名画板");
    expect(homeHtml).toContain("text-[#34c759]");

    const sidebarHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Sidebar me={me} route={{ page: "home" }} onLogout={() => {}} />
      </QueryClientProvider>,
    );
    expect(sidebarHtml).toContain("未命名画板");
    expect(sidebarHtml).toContain("text-[#34c759]");

    const driveHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <DrivePage folderId={null} personalRoot userId={7} uploads={new DriveUploadManager(7, () => {})} />
      </QueryClientProvider>,
    );
    expect(driveHtml).toContain("未命名画板");
    expect(driveHtml).toContain("text-[#34c759]");

    const trashHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Trash />
      </QueryClientProvider>,
    );
    expect(trashHtml).toContain("data-board-tag");
    expect(trashHtml).toContain("未命名画板");
    expect(trashHtml).toContain("text-[#34c759]");
  });

  it("sends docType=board when creating a board node via driveApi", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 9, workspaceId: 1, parentId: null, kind: "doc", docType: "board", title: "未命名画板", role: "manage", revision: 1, updatedAt: "2026-11-18" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetch);
    const created = await driveApi.createWordImportNode("未命名画板", null, true, 7, "board");
    expect(created.docType).toBe("board");
    const [, init] = fetch.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ kind: "doc", docType: "board", title: "未命名画板", scope: "personal" });
    expect(init.headers["X-Jiange-User-Id"]).toBe("7");
  });
});
