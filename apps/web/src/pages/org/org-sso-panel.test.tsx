import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildSSOCallbackUrl, type SSOProvider } from "@/lib/sso-api";
import { OrgSSOPanel, SSO_PROVIDER_PRESETS } from "./org-sso-panel";

const sampleProvider: SSOProvider = {
  id: 7,
  workspaceId: 10,
  slug: "corp-oidc",
  name: "Corp Okta",
  providerType: "oidc",
  enabled: true,
  issuerUrl: "https://idp.example.com",
  authUrl: "https://idp.example.com/oauth2/authorize",
  tokenUrl: "https://idp.example.com/oauth2/token",
  userinfoUrl: "https://idp.example.com/oauth2/userinfo",
  clientId: "client-abc",
  hasClientSecret: true,
  secretHint: "9876",
  scopes: "openid email profile",
  autoCreateUser: true,
  defaultRole: "member",
  allowedDomains: "example.com,corp.example.com",
  createdAt: "2026-11-24T00:00:00Z",
  updatedAt: "2026-11-24T00:00:00Z",
};

describe("OrgSSOPanel", () => {
  it("blocks regular workspace members with an informational guard", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgSSOPanel workspaceId={10} userId={2} canAdmin={false} />
      </QueryClientProvider>,
    );
    expect(html).toContain("仅空间所有者或管理员可配置企业单点登录（SSO）");
    expect(html).not.toContain("data-sso-create-btn");
  });

  it("renders configured providers with switch, callback URL, secret hint, and zero native selects", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-sso-providers", 10, 1], [sampleProvider]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgSSOPanel workspaceId={10} userId={1} canAdmin={true} />
      </QueryClientProvider>,
    );
    expect(html).toContain("Corp Okta");
    expect(html).toContain("通用 OIDC");
    expect(html).toContain("corp-oidc");
    expect(html).toContain("/api/auth/sso/corp-oidc/callback");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("data-sso-copy-callback");
    expect(html).toContain("末四位 9876");
    expect(html).toContain("example.com,corp.example.com");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders create modal with quick presets, OIDC discovery, and FeishuSelect (no native select)", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-sso-providers", 10, 1], []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgSSOPanel workspaceId={10} userId={1} canAdmin={true} initialEditorOpen={true} />
      </QueryClientProvider>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("OIDC 自动发现");
    for (const preset of SSO_PROVIDER_PRESETS) {
      expect(html).toContain(`data-sso-preset="${preset.type}"`);
    }
    expect(html).toContain("飞书 SSO");
    expect(html).toContain("企业微信");
    expect(html).toContain("钉钉");
    expect(html).toContain("Google");
    expect(html).toContain("GitHub");
    expect(html).toContain("data-sso-default-role-select");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('data-select-value="member"');
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders edit modal with masked client secret placeholder", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["workspace-sso-providers", 10, 1], [sampleProvider]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrgSSOPanel
          workspaceId={10}
          userId={1}
          canAdmin={true}
          initialEditingProvider={sampleProvider}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("编辑 SSO 提供商");
    expect(html).toContain("已保存（末四位 9876），留空则保持不变");
    expect(html).toContain('value="Corp Okta"');
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("builds stable SSO callback URLs", () => {
    expect(buildSSOCallbackUrl("acme-sso", "https://docs.acme.com/")).toBe(
      "https://docs.acme.com/api/auth/sso/acme-sso/callback",
    );
  });
});
