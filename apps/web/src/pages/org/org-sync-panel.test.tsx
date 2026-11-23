import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
  });
});
