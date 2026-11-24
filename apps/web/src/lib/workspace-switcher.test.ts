import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type DocMeta, type Me, type Workspace } from "@/lib/api";
import { Sidebar } from "@/components/sidebar";
import {
  activeWorkspaceStorageKey,
  deleteWorkspace,
  getActiveWorkspaceId,
  leaveWorkspace,
  renameWorkspace,
  setActiveWorkspaceId,
  subscribeActiveWorkspace,
  transferWorkspaceOwner,
  useActiveWorkspace,
  workspacesApi,
} from "./workspace-switcher";

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

const sampleWorkspaces: Workspace[] = [
  { id: 10, name: "个人空间", ownerId: 1 },
  { id: 20, name: "研发团队空间", ownerId: 1 },
  { id: 30, name: "产品设计空间", ownerId: 2 },
];

describe("workspace-switcher storage & subscriptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns null for empty workspace lists and falls back to the first workspace", () => {
    const storage = createMemoryStorage();
    expect(getActiveWorkspaceId(1, [], storage)).toBeNull();
    expect(getActiveWorkspaceId(1, sampleWorkspaces, storage)).toBe(10);

    // Invalid or stale stored IDs safely fall back to the first workspace.
    storage.setItem(activeWorkspaceStorageKey(1), "not-a-number");
    expect(getActiveWorkspaceId(1, sampleWorkspaces, storage)).toBe(10);

    storage.setItem(activeWorkspaceStorageKey(1), "999");
    expect(getActiveWorkspaceId(1, sampleWorkspaces, storage)).toBe(10);
  });

  it("persists active workspace per user and notifies subscribers", () => {
    const storage = createMemoryStorage();
    const events: { userId: number; workspaceId: number | null }[] = [];
    const unsubscribe = subscribeActiveWorkspace((change) => events.push(change));

    setActiveWorkspaceId(1, 20, storage);
    setActiveWorkspaceId(2, 30, storage);

    expect(getActiveWorkspaceId(1, sampleWorkspaces, storage)).toBe(20);
    expect(getActiveWorkspaceId(2, sampleWorkspaces, storage)).toBe(30);
    expect(events).toEqual([
      { userId: 1, workspaceId: 20 },
      { userId: 2, workspaceId: 30 },
    ]);

    // Invalid IDs are ignored and do not emit events.
    setActiveWorkspaceId(1, 0, storage);
    setActiveWorkspaceId(-1, 20, storage);
    expect(events).toHaveLength(2);

    unsubscribe();
    setActiveWorkspaceId(1, 30, storage);
    expect(events).toHaveLength(2);
    expect(getActiveWorkspaceId(1, sampleWorkspaces, storage)).toBe(30);
  });

  it("handles failing storage implementations without throwing", () => {
    const broken = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    const seen: number[] = [];
    const unsub = subscribeActiveWorkspace((c) => {
      if (c.workspaceId !== null) seen.push(c.workspaceId);
    });
    expect(getActiveWorkspaceId(1, sampleWorkspaces, broken)).toBe(10);
    expect(() => setActiveWorkspaceId(1, 20, broken)).not.toThrow();
    expect(seen).toEqual([20]);
    unsub();
  });

  it("calls GET/POST /api/workspaces and surfaces ApiError on failure", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ workspaces: sampleWorkspaces }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const listed = await workspacesApi.list();
    expect(listed).toEqual(sampleWorkspaces);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/workspaces", {
      method: "GET",
      credentials: "same-origin",
      headers: undefined,
      body: undefined,
    });

    const createdWs: Workspace = { id: 40, name: "市场部空间", ownerId: 1 };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ workspace: createdWs }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const created = await workspacesApi.create("市场部空间");
    expect(created).toEqual(createdWs);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/workspaces", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "市场部空间" }),
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "workspace_limit_reached", message: "已达到上限" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(workspacesApi.create("超出上限")).rejects.toMatchObject({
      status: 409,
      code: "workspace_limit_reached",
      message: "已达到上限",
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_workspace_name", message: "名称无效" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(workspacesApi.create("")).rejects.toBeInstanceOf(ApiError);
  });

  it("exposes active workspace via useActiveWorkspace and filters Sidebar docs to the active workspace", () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", {
      localStorage: storage,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("localStorage", storage);

    const me: Me = {
      user: { id: 7, email: "alice@example.test", name: "Alice", createdAt: "2026-11-24T00:00:00Z" },
      workspaces: sampleWorkspaces,
    };

    function Probe() {
      const { activeWorkspace, activeWorkspaceId } = useActiveWorkspace(me);
      return createElement("div", { "data-probe-id": activeWorkspaceId ?? "" }, activeWorkspace?.name ?? "");
    }

    expect(renderToStaticMarkup(createElement(Probe))).toContain('data-probe-id="10">个人空间');
    setActiveWorkspaceId(7, 20);
    expect(renderToStaticMarkup(createElement(Probe))).toContain('data-probe-id="20">研发团队空间');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    const docs: DocMeta[] = [
      { id: 101, workspaceId: 10, parentId: null, title: "空间一文档", icon: "", creatorId: 7, creatorName: "Alice", createdAt: "", updatedAt: "", kind: "doc" },
      { id: 202, workspaceId: 20, parentId: null, title: "研发空间文档", icon: "", creatorId: 7, creatorName: "Alice", createdAt: "", updatedAt: "", kind: "doc" },
    ];
    qc.setQueryData(["docs"], docs);
    qc.setQueryData(["shared"], []);
    qc.setQueryData(["pins"], []);
    qc.setQueryData(["favorites"], []);

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(Sidebar, { me, route: { page: "home" }, onLogout: () => {} }),
      ),
    );
    expect(html).toContain("研发团队空间");
    expect(html).toContain("研发空间文档");
    expect(html).not.toContain("空间一文档");
    expect(html).not.toContain("<select");
  });

  it("supports renameWorkspace, deleteWorkspace, transferWorkspaceOwner, and leaveWorkspace", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Rename workspace (PATCH /api/workspaces/:wsId)
    const renamedWs: Workspace = { id: 20, name: "新研发空间", ownerId: 1 };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ workspace: renamedWs }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const renamed = await renameWorkspace(20, "新研发空间");
    expect(renamed).toEqual(renamedWs);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/workspaces/20", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "新研发空间" }),
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "forbidden", message: "仅空间所有者或管理员可重命名" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(workspacesApi.rename(20, "无权")).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });

    // Delete workspace (DELETE /api/workspaces/:wsId -> 204 No Content)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(deleteWorkspace(20)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/workspaces/20", {
      method: "DELETE",
      credentials: "same-origin",
      headers: undefined,
      body: undefined,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "last_workspace", message: "无法删除最后一个工作空间" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(workspacesApi.delete(10)).rejects.toMatchObject({
      status: 409,
      code: "last_workspace",
    });

    // Transfer owner (POST /api/workspaces/:wsId/transfer-owner)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, workspaceId: 20, ownerId: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(transferWorkspaceOwner(20, 2)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/workspaces/20/transfer-owner", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUserId: 2 }),
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "not_found", message: "目标成员不存在" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(workspacesApi.transferOwner(20, 999)).rejects.toBeInstanceOf(ApiError);

    // Leave workspace (POST /api/workspaces/:wsId/leave -> 204 No Content)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(leaveWorkspace(30)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/workspaces/30/leave", {
      method: "POST",
      credentials: "same-origin",
      headers: undefined,
      body: undefined,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "owner_cannot_leave", message: "空间所有者不能直接退出" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(workspacesApi.leave(10)).rejects.toMatchObject({
      status: 409,
      code: "owner_cannot_leave",
    });
  });
});
