import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkspaceInvitation } from "@/lib/api";
import { WorkspaceInvitations } from "./workspace-invitations";

const render = (invitations: WorkspaceInvitation[] | undefined) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  if (invitations) qc.setQueryData(["workspace-invitations", 7], invitations);
  return renderToStaticMarkup(<QueryClientProvider client={qc}><WorkspaceInvitations userId={7} /></QueryClientProvider>);
};

describe("WorkspaceInvitations", () => {
  it("renders nothing without pending invitations", () => {
    expect(render([])).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("lists invitations with explicit accept and decline actions", () => {
    const html = render([{ id: 3, workspaceId: 10, workspaceName: "研发团队空间", email: "me@example.test", role: "admin", inviterName: "Owner", createdAt: "2026-11-18T00:00:00Z" }]);
    expect(html).toContain("空间邀请");
    expect(html).toContain("研发团队空间");
    expect(html).toContain("Owner 邀请你以管理员身份加入");
    expect(html).toContain("data-accept-invitation");
    expect(html).toContain("data-decline-invitation");
  });
});
