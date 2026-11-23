import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Me, WorkspaceOrgSnapshot } from "@/lib/api";
import { OrgPage } from "./org-page";

const me: Me = {
  user: { id: 1, email: "owner@example.test", name: "Owner", createdAt: "2026-11-18T00:00:00Z" },
  workspaces: [{ id: 10, name: "研发团队空间", ownerId: 1 }],
};

describe("OrgPage", () => {
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
});
