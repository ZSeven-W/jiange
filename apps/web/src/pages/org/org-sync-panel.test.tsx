import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pullOrgSync, saveConnectorConfig, type OrgSyncSourceExtended } from "@/lib/org-sync-pull-api";
import { OrgSyncPanel, parseOrgDirectoryCsv, SAMPLE_ORG_DIRECTORY_CSV } from "./org-sync-panel";

describe("parseOrgDirectoryCsv", () => {
  it("builds nested department trees, groups, roles, and leader flags from sample CSV", () => {
    const { payload, warnings } = parseOrgDirectoryCsv(SAMPLE_ORG_DIRECTORY_CSV);
    expect(warnings).toEqual([]);
    expect(payload.departments.map((d) => ({ id: d.externalId, parent: d.parentExternalId, name: d.name }))).toEqual([
      { id: "dept:研发中心", parent: undefined, name: "研发中心" },
      { id: "dept:研发中心/基础架构部", parent: "dept:研发中心", name: "基础架构部" },
      { id: "dept:研发中心/云文档部", parent: "dept:研发中心", name: "云文档部" },
      { id: "dept:产品设计部", parent: undefined, name: "产品设计部" },
      { id: "dept:产品设计部/交互组", parent: "dept:产品设计部", name: "交互组" },
    ]);
    expect(payload.groups.map((g) => g.name)).toEqual(["核心架构组", "安全审计组", "产品评审组"]);
    expect(payload.members).toEqual([
      {
        email: "linxiao@example.com",
        name: "林晓",
        role: "admin",
        departmentExternalIds: ["dept:研发中心/基础架构部"],
        leaderDepartmentExternalIds: ["dept:研发中心/基础架构部"],
        groupExternalIds: ["csv-grp:核心架构组", "csv-grp:安全审计组"],
      },
      {
        email: "chenming@example.com",
        name: "陈明",
        role: "member",
        departmentExternalIds: ["dept:研发中心/云文档部"],
        leaderDepartmentExternalIds: [],
        groupExternalIds: ["csv-grp:核心架构组"],
      },
      {
        email: "zhouyao@example.com",
        name: "周瑶",
        role: "member",
        departmentExternalIds: ["dept:产品设计部/交互组"],
        leaderDepartmentExternalIds: ["dept:产品设计部/交互组"],
        groupExternalIds: ["csv-grp:产品评审组"],
      },
    ]);
  });

  it("merges duplicate member rows, supports English headers, multi-department cells, and department-only rows", () => {
    const csv = [
      "Department,Name,Email,Role,Groups,Leader",
      "Engineering/Platform;Engineering/Security,Alice,ALICE@Example.com,member,Arch,true",
      "Engineering/Cloud,Alice,alice@example.com,admin,Oncall,false",
      "Operations/Finance,,,,,",
    ].join("\n");
    const { payload } = parseOrgDirectoryCsv(csv);
    expect(payload.departments.map((d) => d.name)).toEqual([
      "Engineering",
      "Platform",
      "Security",
      "Cloud",
      "Operations",
      "Finance",
    ]);
    expect(payload.members).toHaveLength(1);
    expect(payload.members[0]).toEqual({
      email: "alice@example.com",
      name: "Alice",
      role: "admin",
      departmentExternalIds: [
        "dept:Engineering/Platform",
        "dept:Engineering/Security",
        "dept:Engineering/Cloud",
      ],
      leaderDepartmentExternalIds: [
        "dept:Engineering/Platform",
        "dept:Engineering/Security",
      ],
      groupExternalIds: ["csv-grp:Arch", "csv-grp:Oncall"],
    });
  });

  it("rejects empty CSV and invalid emails", () => {
    expect(() => parseOrgDirectoryCsv("   \n# comment")).toThrow("CSV 内容为空");
    expect(() => parseOrgDirectoryCsv("部门路径,姓名,邮箱\n研发,张三,not-an-email")).toThrow("邮箱格式无效");
  });

  it("renders FeishuSelect for sync provider without native select elements", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-org-sync", 10, 1], { sources: [], runs: [] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgSyncPanel workspaceId={10} userId={1} canAdmin={true} />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-sync-provider-select");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('data-select-value="scim"');
    expect(html).toContain("data-select-options");
    expect(html).not.toContain("<select");
  });
});

describe("OrgSyncPanel Active Directory Pull Connectors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeSource = (overrides: Partial<OrgSyncSourceExtended>): OrgSyncSourceExtended => ({
    id: 1,
    workspaceId: 10,
    name: "Corp AD",
    provider: "ldap",
    enabled: true,
    tokenPrefix: "jg_sync_12345678…",
    autoInviteMissing: true,
    pruneMissing: false,
    lastStatus: "",
    lastSummary: "",
    createdBy: 1,
    createdAt: "2026-11-24T12:00:00Z",
    updatedAt: "2026-11-24T12:00:00Z",
    endpointUrl: "ldaps://ad.corp.internal:636",
    connectorConfigHint: "base=dc=corp · pwd=****9876",
    hasConnectorConfig: true,
    syncIntervalMinutes: 60,
    ...overrides,
  });

  it("renders LDAP connector config form, FeishuSelect auto-sync interval, and pull buttons without native select", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-org-sync", 10, 1], {
      sources: [makeSource({ provider: "ldap" })],
      runs: [],
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgSyncPanel workspaceId={10} userId={1} canAdmin={true} />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-org-sync-connector-section");
    expect(html).toContain('data-connector-provider="ldap"');
    expect(html).toContain("data-connector-endpoint");
    expect(html).toContain("data-connector-ldap-bind-dn");
    expect(html).toContain("data-connector-ldap-bind-password");
    expect(html).toContain("data-connector-ldap-base-dn");
    expect(html).toContain("data-connector-ldap-user-filter");
    expect(html).toContain("data-connector-ldap-dept-filter");
    expect(html).toContain("data-org-sync-interval-select");
    expect(html).toContain('data-select-value="60"');
    expect(html).toContain("0:关闭|30:每 30 分钟|60:每小时|360:每 6 小时|1440:每 24 小时");
    expect(html).toContain("data-org-sync-pull");
    expect(html).toContain("data-org-sync-pull-dry-run");
    expect(html).toContain("立即拉取同步");
    expect(html).toContain("预览拉取 (Dry-Run)");
    expect(html).not.toContain("<select");
  });

  it("renders WeCom and DingTalk provider-specific credential inputs and hides pull panel for SCIM", () => {
    for (const [provider, expectedAttr] of [
      ["wecom", "data-connector-wecom-corpid"],
      ["dingtalk", "data-connector-dingtalk-appkey"],
    ] as const) {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      qc.setQueryData(["workspace-org-sync", 10, 1], {
        sources: [makeSource({ provider, hasConnectorConfig: false, syncIntervalMinutes: 0 })],
        runs: [],
      });
      const html = renderToStaticMarkup(
        <QueryClientProvider client={qc}>
          <OrgSyncPanel workspaceId={10} userId={1} canAdmin={true} />
        </QueryClientProvider>,
      );
      expect(html).toContain(expectedAttr);
      expect(html).toContain("未配置拉取凭证");
      expect(html).not.toContain("<select");
    }

    const qcScim = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qcScim.setQueryData(["workspace-org-sync", 10, 1], {
      sources: [makeSource({ provider: "scim" })],
      runs: [],
    });
    const scimHtml = renderToStaticMarkup(
      <QueryClientProvider client={qcScim}>
        <OrgSyncPanel workspaceId={10} userId={1} canAdmin={true} />
      </QueryClientProvider>,
    );
    expect(scimHtml).not.toContain("data-org-sync-connector-section");
  });

  it("sends correct PATCH and POST pull requests via org-sync-pull-api helpers", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({
            source: makeSource({ id: 7, provider: "wecom", syncIntervalMinutes: 30 }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          run: {
            id: 99,
            workspaceId: 10,
            sourceId: 7,
            triggerMode: "pull",
            dryRun: true,
            status: "ok",
            departmentsCreated: 3,
            departmentsUpdated: 0,
            departmentsRemoved: 0,
            groupsCreated: 0,
            groupsUpdated: 0,
            groupsRemoved: 0,
            membersLinked: 2,
            membersInvited: 1,
            membershipsUpdated: 2,
            createdAt: "2026-11-24T12:00:00Z",
          },
          fetched: { departments: 3, groups: 0, members: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const saved = await saveConnectorConfig(
      10,
      7,
      {
        endpointUrl: "https://qyapi.weixin.qq.com",
        syncIntervalMinutes: 30,
        connectorConfig: { corpId: "ww123", corpSecret: "sec-xyz", rootDeptId: 1 },
      },
      1,
    );
    expect(saved.source.syncIntervalMinutes).toBe(30);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/workspaces/10/org/sync-sources/7",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Jiange-User-Id": "1",
        }),
      }),
    );

    const pulled = await pullOrgSync(10, 7, true, 1);
    expect(pulled.run.triggerMode).toBe("pull");
    expect(pulled.fetched).toEqual({ departments: 3, groups: 0, members: 3 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/workspaces/10/org/sync-sources/7/pull",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      }),
    );
  });
});
