import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me, WorkspaceOrgSnapshot } from "@/lib/api";
import { AskHost, cancelOutstandingAsks } from "@/components/ui/ask";
import { OrgPage, requestWorkspaceOwnerTransfer } from "./org-page";

const me: Me = {
  user: { id: 1, email: "owner@example.test", name: "Owner", createdAt: "2026-11-18T00:00:00Z" },
  workspaces: [{ id: 10, name: "研发团队空间", ownerId: 1 }],
};

describe("OrgPage", () => {
  afterEach(() => {
    cancelOutstandingAsks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders workspace departments and admin controls when caller is workspace owner", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const snapshot: WorkspaceOrgSnapshot = {
      workspaceId: 10,
      workspaceName: "研发团队空间",
      callerRole: "owner",
      members: [
        { userId: 1, email: "owner@example.test", name: "Owner", role: "owner", createdAt: "2026-11-18T00:00:00Z" },
        { userId: 2, email: "alice@example.test", name: "Alice", role: "member", createdAt: "2026-11-18T00:00:00Z" },
      ],
      departments: [
        {
          id: 101,
          workspaceId: 10,
          parentId: null,
          name: "研发中心",
          sortOrder: 1,
          members: [{ userId: 2, name: "Alice", email: "alice@example.test", isLeader: true }],
          createdAt: "2026-11-18T00:00:00Z",
          updatedAt: "2026-11-18T00:00:00Z",
        },
      ],
      groups: [],
      invitations: [{ id: 5, workspaceId: 10, email: "pending@example.test", role: "member", createdAt: "2026-11-18T00:00:00Z" }],
    };
    qc.setQueryData(["workspace-org", 10, 1], snapshot);
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><OrgPage me={me} /></QueryClientProvider>);
    expect(html).toContain("组织架构");
    expect(html).toContain("研发中心");
    expect(html).toContain("Alice");
    expect(html).toContain("负责人");
    expect(html).toContain("新建一级部门");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="选择部门成员"');
    expect(html).toContain('data-select-value="1"');
    expect(html).toContain("data-select-options");
  });

  it("hides admin mutation buttons for regular workspace members", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-org", 10, 1], {
      workspaceId: 10,
      workspaceName: "研发团队空间",
      callerRole: "member",
      members: [],
      departments: [],
      groups: [],
    } satisfies WorkspaceOrgSnapshot);
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><OrgPage me={me} /></QueryClientProvider>);
    expect(html).toContain("普通成员");
    expect(html).not.toContain("新建一级部门");
    expect(html).not.toContain("添加到部门");
  });

  it("shows 转让所有者 button only for workspace owner on non-owner members and transfers ownership on confirm", async () => {
    const ownerSnapshot: WorkspaceOrgSnapshot = {
      workspaceId: 10,
      workspaceName: "研发团队空间",
      callerRole: "owner",
      members: [
        { userId: 1, email: "owner@example.test", name: "Owner", role: "owner", createdAt: "2026-11-18T00:00:00Z" },
        { userId: 2, email: "alice@example.test", name: "Alice", role: "admin", createdAt: "2026-11-18T00:00:00Z" },
      ],
      departments: [],
      groups: [],
    };
    const qcOwner = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qcOwner.setQueryData(["workspace-org", 10, 1], ownerSnapshot);
    const ownerHtml = renderToStaticMarkup(
      <QueryClientProvider client={qcOwner}>
        <OrgPage me={me} initialTab="members" />
      </QueryClientProvider>,
    );
    expect(ownerHtml).toContain("转让所有者");
    expect(ownerHtml).toContain('data-transfer-owner="2"');
    expect(ownerHtml).not.toContain('data-transfer-owner="1"');
    expect(ownerHtml).not.toMatch(/<select[\s>]/i);

    // Non-owner admin must NOT see the 转让所有者 button.
    const qcAdmin = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qcAdmin.setQueryData(["workspace-org", 10, 1], {
      ...ownerSnapshot,
      callerRole: "admin",
    } satisfies WorkspaceOrgSnapshot);
    const adminHtml = renderToStaticMarkup(
      <QueryClientProvider client={qcAdmin}>
        <OrgPage me={me} initialTab="members" />
      </QueryClientProvider>,
    );
    expect(adminHtml).toContain("移出空间");
    expect(adminHtml).not.toContain("转让所有者");

    // Confirmation dialog warns about admin demotion; cancelling skips transfer.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, workspaceId: 10, ownerId: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runMutationSpy = vi.fn(async (fn: () => Promise<void | string>, _msg: string) => {
      await fn();
    });

    // Trigger real `ask(...)` dialog and verify warning content before cancelling.
    const pendingCancel = requestWorkspaceOwnerTransfer({
      workspaceId: 10,
      callerUserId: 1,
      member: { userId: 2, name: "Alice" },
      runMutation: runMutationSpy,
    });
    const dialogHtml = renderToStaticMarkup(<AskHost />);
    expect(dialogHtml).toContain("将空间所有者转让给「Alice」？");
    expect(dialogHtml).toContain("管理员");
    cancelOutstandingAsks();
    await expect(pendingCancel).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // Confirming calls transferWorkspaceOwner (POST /api/workspaces/10/transfer-owner) and reports success message.
    const invalidateGlobal = vi.fn(async () => {});
    const confirmed = await requestWorkspaceOwnerTransfer({
      workspaceId: 10,
      callerUserId: 1,
      member: { userId: 2, name: "Alice" },
      confirmFn: vi.fn(async () => true),
      runMutation: runMutationSpy,
      invalidateGlobal,
    });
    expect(confirmed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/10/transfer-owner", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUserId: 2 }),
    });
    expect(invalidateGlobal).toHaveBeenCalledTimes(1);
    expect(runMutationSpy).toHaveBeenCalledWith(expect.any(Function), "已将空间所有者转让给 Alice");
  });
});
