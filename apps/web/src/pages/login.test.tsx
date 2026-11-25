import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicSSOProvider } from "@/lib/sso-api";
import { MY_SESSIONS_QUERY_KEY, type UserSession } from "@/lib/account-security-api";
import { AccountSecurityHost, parseUserAgentSummary } from "@/components/account-security-dialog";
import { t } from "@/lib/i18n";
import {
  formatSSOErrorMessage,
  LoginPage,
  normalizePostLoginHash,
  readResetTokenFromLocation,
  readSSOErrorFromLocation,
} from "./login";

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

describe("LoginPage MFA challenge integration", () => {
  it("renders standard login form when no MFA challenge is active", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["public-sso-providers"], [] satisfies PublicSSOProvider[]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LoginPage />
      </QueryClientProvider>,
    );
    expect(html).not.toContain("data-mfa-challenge-form");
    expect(html).not.toContain("data-mfa-code-input");
    expect(html).toContain("欢迎回来");
  });

  it("renders Feishu-styled MFA 6-digit / recovery code challenge form when mfaRequired is triggered", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["public-sso-providers"], [] satisfies PublicSSOProvider[]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LoginPage
          initialMFAChallenge={{
            mfaToken: "challenge-token-xyz",
            email: "alice@example.com",
          }}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-mfa-challenge-form");
    expect(html).toContain("二步验证（MFA）");
    expect(html).toContain("alice@example.com");
    expect(html).toContain("data-mfa-code-input");
    expect(html).toContain("验证并登录");
    expect(html).toContain("返回账号登录");
    expect(html).not.toContain('id="password"');
    expect(html).not.toMatch(/<select[\s>]/i);
  });
});

describe("LoginPage Passkey integration", () => {
  it("renders passwordless Passkey login button when WebAuthn is supported", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["public-sso-providers"], [] satisfies PublicSSOProvider[]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LoginPage initialPasskeySupported={true} />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-passkey-login-btn");
    expect(html).toContain("使用通行密钥（Passkey）登录");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("omits Passkey login button when WebAuthn is unsupported", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["public-sso-providers"], [] satisfies PublicSSOProvider[]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LoginPage initialPasskeySupported={false} />
      </QueryClientProvider>,
    );
    expect(html).not.toContain("data-passkey-login-btn");
    expect(html).not.toContain("使用通行密钥（Passkey）登录");
  });
});

describe("LoginPage Password Reset & Hash Normalization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders Forgot Password trigger in login mode and omits it in register mode", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["public-sso-providers"], [] satisfies PublicSSOProvider[]);

    const loginHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LoginPage initialMode="login" />
      </QueryClientProvider>,
    );
    expect(loginHtml).toContain("data-forgot-password-btn");
    expect(loginHtml).toContain("忘记密码？");
    expect(loginHtml).not.toMatch(/<select[\s>]/i);

    const registerHtml = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LoginPage initialMode="register" />
      </QueryClientProvider>,
    );
    expect(registerHtml).not.toContain("data-forgot-password-btn");
  });

  it("renders Forgot Password request form", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["public-sso-providers"], [] satisfies PublicSSOProvider[]);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LoginPage initialMode="forgot" />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-password-reset-request-form");
    expect(html).toContain("找回密码");
    expect(html).toContain("data-reset-email-input");
    expect(html).toContain("data-reset-request-submit-btn");
    expect(html).toContain("已有重置口令？立即重设");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("auto-enters Reset Confirm mode and pre-fills token when initialResetToken is provided", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["public-sso-providers"], [] satisfies PublicSSOProvider[]);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LoginPage initialResetToken="reset-tok-999" />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-password-reset-confirm-form");
    expect(html).toContain("重设登录密码");
    expect(html).toContain('value="reset-tok-999"');
    expect(html).toContain("data-reset-new-password-input");
    expect(html).toContain("data-reset-confirm-password-input");
    expect(html).toContain("确认重设密码");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("extracts reset_token from both search and hash query strings", () => {
    expect(readResetTokenFromLocation("?reset_token=abc123", "")).toBe("abc123");
    expect(readResetTokenFromLocation("", "#/login?reset_token=tok_xyz")).toBe("tok_xyz");
    expect(readResetTokenFromLocation("", "#/?foo=1&reset_token=tok_456")).toBe("tok_456");
    expect(readResetTokenFromLocation("", "#/login")).toBe("");
  });

  it("normalizes #/login and #/login?... hashes to #/ while preserving deep links", () => {
    const replaceState = vi.fn();
    const fakeWindow = {
      location: { hash: "#/login" },
      history: { replaceState },
    };
    vi.stubGlobal("window", fakeWindow);

    normalizePostLoginHash();
    expect(replaceState).toHaveBeenCalledWith(null, "", "#/");

    replaceState.mockClear();
    fakeWindow.location.hash = "#/login?reset_token=abc";
    normalizePostLoginHash();
    expect(replaceState).toHaveBeenCalledWith(null, "", "#/");

    replaceState.mockClear();
    fakeWindow.location.hash = "#/doc/42";
    normalizePostLoginHash();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("AccountSecurityHost password and sessions tabs", () => {
  it("renders password change tab with default revoke-other-sessions checkbox and zero selects", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <AccountSecurityHost initialOpen={true} initialTab="password" />
      </QueryClientProvider>,
    );
    expect(html).toContain('data-security-tab="password"');
    expect(html).toContain('data-security-tab="sessions"');
    expect(html).toContain("data-password-security-panel");
    expect(html).toContain("data-password-change-form");
    expect(html).toContain("同时退出其他设备登录");
    expect(html).toContain("checked");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders active sessions tab with parsed UA labels, current badge, and revoke buttons", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sessions: UserSession[] = [
      {
        id: 101,
        userId: 1,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/128.0.0.0 Safari/537.36",
        ipAddress: "203.0.113.10",
        createdAt: "2026-11-25T08:00:00Z",
        lastSeenAt: "2026-11-25T09:45:00Z",
        expiresAt: "2026-12-02T08:00:00Z",
        current: true,
      },
      {
        id: 102,
        userId: 1,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1",
        ipAddress: "198.51.100.77",
        createdAt: "2026-11-24T12:00:00Z",
        lastSeenAt: "2026-11-25T07:30:00Z",
        expiresAt: "2026-12-01T12:00:00Z",
        current: false,
      },
    ];
    qc.setQueryData<UserSession[]>(MY_SESSIONS_QUERY_KEY, sessions);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <AccountSecurityHost initialOpen={true} initialTab="sessions" />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-sessions-security-panel");
    expect(html).toContain("共 2 台活跃设备");
    expect(html).toContain("Chrome · macOS");
    expect(html).toContain("Safari · iPhone");
    expect(html).toContain("203.0.113.10");
    expect(html).toContain("198.51.100.77");
    expect(html).toContain("data-current-session-badge");
    expect(html).toContain("当前设备");
    expect(html).toContain("data-revoke-other-sessions-btn");
    expect(html).toContain('data-session-revoke-btn="102"');
    expect(html).not.toMatch(/<select[\s>]/i);

    expect(parseUserAgentSummary("", t)).toEqual({ label: "未知设备", isMobile: false });
    expect(parseUserAgentSummary("Mozilla/5.0 (Windows NT 10.0) Edg/128.0", t)).toEqual({
      label: "Edge · Windows",
      isMobile: false,
    });
  });
});
