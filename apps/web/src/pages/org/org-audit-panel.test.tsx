import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { enterpriseApi, type AuditLogPage, type WorkspaceSecurityPolicy } from "@/lib/enterprise-api";
import { workspaceSecurityPolicyQueryKey } from "@/components/document-watermark";
import {
  AUDIT_PAGE_SIZE,
  OrgAuditPanel,
  auditLogsQueryKey,
  formatAuditActionLabel,
  formatAuditResourceTypeLabel,
} from "./org-audit-panel";

const samplePolicy: WorkspaceSecurityPolicy = {
  workspaceId: 10,
  watermarkEnabled: true,
  watermarkText: "严禁外传",
  watermarkShowUser: true,
  watermarkShowEmail: true,
  watermarkShowDate: true,
  watermarkOpacity: 0.1,
  updatedBy: 1,
  updatedAt: "2026-11-24T08:00:00Z",
};

const sampleAuditPage: AuditLogPage = {
  total: 25,
  actions: ["auth.login", "auth.sso_login", "doc.create", "org.watermark_update", "share.update"],
  items: [
    {
      id: 101,
      workspaceId: 10,
      actorId: 1,
      actorName: "林晓",
      actorEmail: "linxiao@corp.com",
      action: "org.watermark_update",
      resourceType: "workspace",
      resourceId: 10,
      resourceTitle: "严禁外传",
      detail: { watermarkEnabled: true },
      ipAddress: "10.0.1.15",
      userAgent: "Chrome/130",
      createdAt: "2026-11-24T08:00:00Z",
    },
    {
      id: 100,
      workspaceId: 10,
      actorId: 2,
      actorName: "陈明",
      actorEmail: "chenming@corp.com",
      action: "auth.sso_login",
      resourceType: "auth",
      resourceId: 2,
      resourceTitle: "chenming@corp.com",
      detail: { provider: "okta" },
      ipAddress: "203.0.113.42",
      userAgent: "Safari/18",
      createdAt: "2026-11-24T07:30:00Z",
    },
    {
      id: 99,
      workspaceId: 10,
      actorId: 3,
      actorName: "周瑶",
      actorEmail: "zhouyao@corp.com",
      action: "share.update",
      resourceType: "doc",
      resourceId: 88,
      resourceTitle: "Q4 战略规划",
      detail: { role: "edit" },
      ipAddress: "198.51.100.8",
      userAgent: "Firefox/132",
      createdAt: "2026-11-24T07:00:00Z",
    },
  ],
};

describe("OrgAuditPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders watermark policy editor, live preview, FeishuSelect filters (zero native select), and audit table for admins", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(workspaceSecurityPolicyQueryKey(10), samplePolicy);
    qc.setQueryData(
      auditLogsQueryKey(10, 1, { action: "", resourceType: "", q: "", offset: 0 }),
      sampleAuditPage,
    );

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgAuditPanel
          workspaceId={10}
          userId={1}
          userName="林晓"
          userEmail="linxiao@corp.com"
          canAdmin={true}
        />
      </QueryClientProvider>,
    );

    // Zero native <select> elements
    expect(html).not.toMatch(/<select[\s>]/i);

    // Section 1: Watermark Policy + Live Preview
    expect(html).toContain("全套件安全水印策略");
    expect(html).toContain("开启全局文档水印");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("严禁外传");
    expect(html).toContain("显示姓名");
    expect(html).toContain("显示邮箱");
    expect(html).toContain("显示日期");
    expect(html).toContain("10%");
    expect(html).toContain('data-watermark-preview=""');
    expect(html).toContain('data-watermark=""');
    expect(html).toContain("林晓");
    expect(html).toContain("linxiao@corp.com");
    const saveBtn = html.match(/<button[^>]*data-watermark-save=""[^>]*>/)?.[0] ?? "";
    expect(saveBtn).toContain('data-watermark-save=""');
    expect(saveBtn).not.toContain(' disabled=""');

    // Section 2: Audit Log Filters & Export
    expect(html).toContain("企业安全审计日志");
    expect(html).toContain("data-audit-action-select");
    expect(html).toContain("data-audit-resource-select");
    expect(html).toContain('role="combobox"');
    expect(html).toContain("导出 CSV");
    expect(html).toContain("刷新");

    // Table entries with localized action badges
    expect(html).toContain("变更水印策略");
    expect(html).toContain("SSO 单点登录");
    expect(html).toContain("变更共享权限");
    expect(html).toContain("Q4 战略规划");
    expect(html).toContain("203.0.113.42");

    // Pagination (25 total > AUDIT_PAGE_SIZE = 20 -> next enabled, prev disabled)
    expect(html).toContain("共 25 条记录");
    expect(html).toContain("1 / 2");
    const prevBtn = html.match(/<button[^>]*data-audit-prev=""[^>]*>/)?.[0] ?? "";
    const nextBtn = html.match(/<button[^>]*data-audit-next=""[^>]*>/)?.[0] ?? "";
    expect(prevBtn).toContain(' disabled=""');
    expect(nextBtn).toContain('data-audit-next=""');
    expect(nextBtn).not.toContain(' disabled=""');
    expect(AUDIT_PAGE_SIZE).toBe(20);
  });

  it("disables watermark policy mutations and hides audit logs for regular members", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(workspaceSecurityPolicyQueryKey(10), {
      ...samplePolicy,
      watermarkEnabled: false,
    });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgAuditPanel
          workspaceId={10}
          userId={2}
          userName="陈明"
          userEmail="chenming@corp.com"
          canAdmin={false}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain("全套件安全水印策略");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-watermark-save=""/);
    expect(html).toContain("仅空间所有者或管理员可修改安全水印策略。");
    expect(html).toContain('data-audit-forbidden=""');
    expect(html).not.toContain('data-audit-table=""');
    expect(html).not.toContain('data-audit-export=""');
  });

  it("localizes known audit action and resource labels and preserves unknown ones", () => {
    expect(formatAuditActionLabel("auth.login")).toBe("账号登录");
    expect(formatAuditActionLabel("auth.sso_login")).toBe("SSO 单点登录");
    expect(formatAuditActionLabel("doc.create")).toBe("创建文档");
    expect(formatAuditActionLabel("doc.delete")).toBe("删除文档");
    expect(formatAuditActionLabel("share.update")).toBe("变更共享权限");
    expect(formatAuditActionLabel("org.member_update")).toBe("变更成员角色");
    expect(formatAuditActionLabel("org.watermark_update")).toBe("变更水印策略");
    expect(formatAuditActionLabel("org.sso_update")).toBe("变更 SSO 配置");
    expect(formatAuditActionLabel("base.permissions_update")).toBe("变更表格权限");
    expect(formatAuditActionLabel("audit.export")).toBe("导出审计日志");
    expect(formatAuditActionLabel("custom.event")).toBe("custom.event");

    expect(formatAuditResourceTypeLabel("doc")).toBe("云文档");
    expect(formatAuditResourceTypeLabel("sheet")).toBe("电子表格");
    expect(formatAuditResourceTypeLabel("base")).toBe("多维表格");
    expect(formatAuditResourceTypeLabel("slides")).toBe("演示文稿");
    expect(formatAuditResourceTypeLabel("workspace")).toBe("工作空间");
    expect(formatAuditResourceTypeLabel("")).toBe("-");
  });

  it("constructs enterprise API requests with query params, headers, and ApiError handling", async () => {
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method,
        headers: init?.headers as Record<string, string> | undefined,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.includes("/export")) {
        return new Response("\uFEFFid,action\n1,auth.login\n", {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="audit-logs-ws-10.csv"',
          },
        });
      }
      if (url.includes("/security-policy") && init?.method === "PUT") {
        return new Response(JSON.stringify(samplePolicy), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/audit-logs")) {
        return new Response(JSON.stringify(sampleAuditPage), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "forbidden", message: "没有权限" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    });

    const page = await enterpriseApi.listAuditLogs(
      10,
      { action: "doc.create", resourceType: "doc", q: "战略", limit: 20, offset: 0 },
      1,
    );
    expect(page.total).toBe(25);
    expect(calls[0].url).toContain("/api/workspaces/10/audit-logs?");
    expect(calls[0].url).toContain("action=doc.create");
    expect(calls[0].url).toContain("resourceType=doc");
    expect(calls[0].headers?.["X-Jiange-User-Id"]).toBe("1");

    const updated = await enterpriseApi.updateSecurityPolicy(10, { watermarkEnabled: true, watermarkOpacity: 0.1 }, 1);
    expect(updated.watermarkEnabled).toBe(true);
    expect(calls[1].method).toBe("PUT");
    expect(JSON.parse(calls[1].body!)).toEqual({ watermarkEnabled: true, watermarkOpacity: 0.1 });

    const exported = await enterpriseApi.exportAuditLogsCsv(10, { action: "auth.login" }, 1);
    expect(exported.filename).toBe("audit-logs-ws-10.csv");
    expect(calls[2].url).toBe("/api/workspaces/10/audit-logs/export?action=auth.login");

    await expect(enterpriseApi.getSecurityPolicy(99, 1)).rejects.toBeInstanceOf(ApiError);
  });
});
