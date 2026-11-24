import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PublicSSOProvider } from "@/lib/sso-api";
import { t } from "@/lib/i18n";
import { formatSSOErrorMessage, LoginPage, readSSOErrorFromLocation } from "./login";

describe("LoginPage SSO integration", () => {
  it("omits SSO section when no public providers are enabled", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["public-sso-providers"], [] satisfies PublicSSOProvider[]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LoginPage />
      </QueryClientProvider>,
    );
    expect(html).not.toContain("data-sso-login-section");
    expect(html).not.toContain("或使用企业单点登录");
    expect(html).not.toContain("data-sso-error-banner");
  });

  it("renders Feishu-style SSO divider and buttons linking to /api/auth/sso/{slug}/start", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const providers: PublicSSOProvider[] = [
      { id: 1, slug: "corp-oidc", name: "Acme Okta", providerType: "oidc" },
      { id: 2, slug: "feishu", name: "飞书企业登录", providerType: "feishu" },
    ];
    qc.setQueryData(["public-sso-providers"], providers);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LoginPage />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-sso-login-section");
    expect(html).toContain("或使用企业单点登录");
    expect(html).toContain('data-sso-provider="corp-oidc"');
    expect(html).toContain('href="/api/auth/sso/corp-oidc/start"');
    expect(html).toContain("使用 Acme Okta 登录");
    expect(html).toContain('data-sso-provider="feishu"');
    expect(html).toContain('href="/api/auth/sso/feishu/start"');
    expect(html).toContain("使用 飞书企业登录 登录");
  });

  it("renders SSO error alert banner when sso_error is present", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["public-sso-providers"], [] satisfies PublicSSOProvider[]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LoginPage initialSSOError="domain_not_allowed" />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-sso-error-banner");
    expect(html).toContain('role="alert"');
    expect(html).toContain("当前企业邮箱域名未被授权登录此空间");
  });

  it("extracts sso_error from both search and hash query strings", () => {
    expect(readSSOErrorFromLocation("?sso_error=access_denied", "")).toBe("access_denied");
    expect(readSSOErrorFromLocation("", "#/?sso_error=invalid_state")).toBe("invalid_state");
    expect(readSSOErrorFromLocation("", "#/login?foo=1&sso_error=user_not_provisioned")).toBe("user_not_provisioned");
    expect(readSSOErrorFromLocation("", "#/")).toBe("");
  });

  it("formats known and unknown SSO error codes", () => {
    expect(formatSSOErrorMessage("access_denied", t)).toContain("已取消企业单点登录授权");
    expect(formatSSOErrorMessage("invalid_state", t)).toContain("登录状态已过期");
    expect(formatSSOErrorMessage("user_not_provisioned", t)).toContain("尚未开通访问权限");
    expect(formatSSOErrorMessage("custom_idp_err", t)).toContain("custom_idp_err");
  });
});
