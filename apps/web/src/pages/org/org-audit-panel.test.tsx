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
  dlpEnabled: true,
  dlpKeywords: ["绝密", "/\\b1[3-9]\\d{9}\\b/"],
  dlpAction: "block",
  dlpBlockPublicShare: true,
  retentionDays: 180,
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
    expect(html).toContain('data-dlp-policy-card=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-dlp-save=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-dlp-test-btn=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-retention-run-btn=""/);
    expect(html).toContain("仅空间所有者或管理员可修改企业 DLP 与保留策略。");
    expect(html).toContain('data-audit-forbidden=""');
    expect(html).not.toContain('data-audit-table=""');
    expect(html).not.toContain('data-audit-export=""');
  });

  it("renders Enterprise DLP & Retention card with presets, rule chips, FeishuSelect controls, live test box, and zero native select", () => {
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

    // Strictly zero native <select> elements anywhere in the panel
    expect(html).not.toMatch(/<select[\s>]/i);

    // DLP card container, header & save button
    expect(html).toContain('data-dlp-policy-card=""');
    expect(html).toContain("数据防泄漏（DLP）与保留策略");
    expect(html).toContain("保存安全策略");
    const dlpSaveBtn = html.match(/<button[^>]*data-dlp-save=""[^>]*>/)?.[0] ?? "";
    expect(dlpSaveBtn).toContain('data-dlp-save=""');
    expect(dlpSaveBtn).not.toContain(' disabled=""');

    // Toggle switch
    expect(html).toContain("启用企业 DLP 敏感词策略");
    const dlpToggle = html.match(/<button[^>]*data-dlp-enabled-toggle=""[^>]*>/)?.[0] ?? "";
    expect(dlpToggle).toContain('role="switch"');
    expect(dlpToggle).toContain('aria-checked="true"');

    // Rule input, add button, quick presets & rule chips
    expect(html).toContain('data-dlp-rule-input=""');
    expect(html).toContain("添加规则");
    expect(html).toContain('data-dlp-preset="top-secret"');
    expect(html).toContain('data-dlp-preset="confidential"');
    expect(html).toContain('data-dlp-preset="pii-regex"');
    expect(html).toContain("绝密");
    expect(html).toContain("内部机密");
    expect(html).toContain("身份证/手机号正则");
    expect(html).toContain('data-dlp-rule-chip="绝密"');
    expect(html).toContain('data-dlp-rule-chip="/\\b1[3-9]\\d{9}\\b/"');

    // FeishuSelect controls for DLP action & retention days (no native <select>)
    expect(html).toContain("命中处置动作");
    expect(html).toContain("data-dlp-action-select");
    expect(html).toContain("仅警告并记录审计");
    expect(html).toContain("拦截对外公开分享");
    expect(html).toContain("对外公开分享时自动扫描文档内容");
    expect(html).toContain("回收站与审计数据保留周期");
    expect(html).toContain("data-retention-days-select");
    expect(html).toContain("永久保留");
    expect(html).toContain("180 天");
    expect(html).toContain("365 天");
    expect(html).toContain("立即执行清理");
    const runRetentionBtn = html.match(/<button[^>]*data-retention-run-btn=""[^>]*>/)?.[0] ?? "";
    expect(runRetentionBtn).toContain('data-retention-run-btn=""');
    expect(runRetentionBtn).not.toContain(' disabled=""');

    // Live test sandbox
    expect(html).toContain("规则实测");
    expect(html).toContain('data-dlp-test-input=""');
    expect(html).toContain('data-dlp-test-btn=""');
    expect(html).toContain("立即检测");
  });

  it("disables manual retention cleanup button when retentionDays is 0 (forever)", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(workspaceSecurityPolicyQueryKey(10), {
      ...samplePolicy,
      retentionDays: 0,
    });
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

    expect(html).not.toMatch(/<select[\s>]/i);
    expect(html).toContain("立即执行清理");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-retention-run-btn=""/);
  });

  it("renders workspace-enforced MFA policy toggle (data-require-mfa-toggle) and disables it for non-admins", () => {
    const qcAdmin = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qcAdmin.setQueryData(workspaceSecurityPolicyQueryKey(10), {
      ...samplePolicy,
      requireMfa: true,
    });
    qcAdmin.setQueryData(
      auditLogsQueryKey(10, 1, { action: "", resourceType: "", q: "", offset: 0 }),
      sampleAuditPage,
    );

    const adminHtml = renderToStaticMarkup(
      <QueryClientProvider client={qcAdmin}>
        <OrgAuditPanel
          workspaceId={10}
          userId={1}
          userName="林晓"
          userEmail="linxiao@corp.com"
          canAdmin={true}
        />
      </QueryClientProvider>,
    );
    expect(adminHtml).toContain("强制工作空间全员开启二步验证（MFA / Passkey）");
    const adminToggle = adminHtml.match(/<button[^>]*data-require-mfa-toggle=""[^>]*>/)?.[0] ?? "";
    expect(adminToggle).toContain('role="switch"');
    expect(adminToggle).toContain('aria-checked="true"');
    expect(adminToggle).not.toContain(' disabled=""');
    expect(adminHtml).not.toMatch(/<select[\s>]/i);

    const qcMember = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qcMember.setQueryData(workspaceSecurityPolicyQueryKey(10), {
      ...samplePolicy,
      requireMfa: false,
    });
    const memberHtml = renderToStaticMarkup(
      <QueryClientProvider client={qcMember}>
        <OrgAuditPanel
          workspaceId={10}
          userId={2}
          userName="陈明"
          userEmail="chenming@corp.com"
          canAdmin={false}
        />
      </QueryClientProvider>,
    );
    const memberToggle = memberHtml.match(/<button[^>]*data-require-mfa-toggle=""[^>]*>/)?.[0] ?? "";
    expect(memberToggle).toContain('role="switch"');
    expect(memberToggle).toContain('aria-checked="false"');
    expect(memberToggle).toContain(' disabled=""');
  });

  it("localizes known audit action and resource labels and preserves unknown ones", () => {
    expect(formatAuditActionLabel("auth.login")).toBe("账号登录");
    expect(formatAuditActionLabel("auth.sso_login")).toBe("SSO 单点登录");
    expect(formatAuditActionLabel("auth.passkey_registered")).toBe("绑定通行密钥");
    expect(formatAuditActionLabel("auth.passkey_login")).toBe("通行密钥登录");
    expect(formatAuditActionLabel("auth.passkey_deleted")).toBe("移除通行密钥");
    expect(formatAuditActionLabel("doc.create")).toBe("创建文档");
    expect(formatAuditActionLabel("doc.delete")).toBe("删除文档");
    expect(formatAuditActionLabel("share.update")).toBe("变更共享权限");
    expect(formatAuditActionLabel("dlp.share_blocked")).toBe("DLP 拦截公开分享");
    expect(formatAuditActionLabel("dlp.share_warned")).toBe("DLP 敏感词告警");
    expect(formatAuditActionLabel("dlp.export_blocked")).toBe("DLP 拦截导出/下载");
    expect(formatAuditActionLabel("dlp.export_warned")).toBe("DLP 导出敏感告警");
    expect(formatAuditActionLabel("retention.purged")).toBe("执行数据保留清理");
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
      if (url.includes("/retention/run") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            workspaceId: 10,
            retentionDays: 180,
            purgedAuditLogs: 12,
            purgedTrashNodes: 3,
            ranAt: "2026-11-24T09:00:00Z",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/dlp/check") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            matched: true,
            action: "block",
            matches: [{ rule: "绝密", match: "绝密", snippet: "这是一份绝密报告" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
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

    const updated = await enterpriseApi.updateSecurityPolicy(
      10,
      {
        watermarkEnabled: true,
        watermarkOpacity: 0.1,
        dlpEnabled: true,
        dlpKeywords: ["绝密"],
        dlpAction: "block",
        dlpBlockPublicShare: true,
        retentionDays: 180,
        requireMfa: true,
      },
      1,
    );
    expect(updated.watermarkEnabled).toBe(true);
    expect(updated.dlpEnabled).toBe(true);
    expect(updated.retentionDays).toBe(180);
    expect(calls[1].method).toBe("PUT");
    expect(JSON.parse(calls[1].body!)).toEqual({
      watermarkEnabled: true,
      watermarkOpacity: 0.1,
      dlpEnabled: true,
      dlpKeywords: ["绝密"],
      dlpAction: "block",
      dlpBlockPublicShare: true,
      retentionDays: 180,
      requireMfa: true,
    });

    const dlpCheck = await enterpriseApi.checkDlp(
      10,
      { text: "这是一份绝密报告", keywords: ["绝密"], action: "block" },
      1,
    );
    expect(dlpCheck.matched).toBe(true);
    expect(dlpCheck.matches).toHaveLength(1);
    expect(calls[2].url).toBe("/api/workspaces/10/dlp/check");
    expect(calls[2].method).toBe("POST");

    const exported = await enterpriseApi.exportAuditLogsCsv(10, { action: "auth.login" }, 1);
    expect(exported.filename).toBe("audit-logs-ws-10.csv");
    expect(calls[3].url).toBe("/api/workspaces/10/audit-logs/export?action=auth.login");

    const retentionStats = await enterpriseApi.runRetentionPurge(10, 1);
    expect(retentionStats.workspaceId).toBe(10);
    expect(retentionStats.retentionDays).toBe(180);
    expect(retentionStats.purgedAuditLogs).toBe(12);
    expect(retentionStats.purgedTrashNodes).toBe(3);
    expect(calls[4].url).toBe("/api/workspaces/10/retention/run");
    expect(calls[4].method).toBe("POST");
    expect(calls[4].headers?.["X-Jiange-User-Id"]).toBe("1");

    await expect(enterpriseApi.getSecurityPolicy(99, 1)).rejects.toBeInstanceOf(ApiError);
  });
});
