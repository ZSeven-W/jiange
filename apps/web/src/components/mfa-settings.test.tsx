import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  isMfaChallengeResponse,
  MFA_STATUS_QUERY_KEY,
  type MfaStatus,
} from "@/lib/mfa-api";
import { formatTotpSecret, MfaSettings } from "./mfa-settings";

describe("MfaSettings", () => {
  it("renders disabled status badge and setup button with zero native selects", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<MfaStatus>(MFA_STATUS_QUERY_KEY, {
      enabled: false,
      recoveryCodesRemaining: 0,
      enabledAt: null,
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MfaSettings />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-mfa-settings");
    expect(html).toContain('data-mfa-enabled="false"');
    expect(html).toContain("未开启");
    expect(html).toContain("data-mfa-start-setup");
    expect(html).toContain("开启二步验证");
    expect(html).not.toContain("data-mfa-open-disable");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders enabled badge, remaining recovery codes count, and disable button", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<MfaStatus>(MFA_STATUS_QUERY_KEY, {
      enabled: true,
      recoveryCodesRemaining: 6,
      enabledAt: "2026-11-24T08:00:00Z",
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MfaSettings />
      </QueryClientProvider>,
    );
    expect(html).toContain('data-mfa-enabled="true"');
    expect(html).toContain("已开启二步验证");
    expect(html).toContain("data-mfa-recovery-remaining");
    expect(html).toContain("剩余备用恢复码：6 个");
    expect(html).toContain("2026-11-24");
    expect(html).toContain("data-mfa-open-disable");
    expect(html).toContain("关闭二步验证");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders setup flow with QR code, formatted Base32 secret, otpauth URI, and 6-digit input", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<MfaStatus>(MFA_STATUS_QUERY_KEY, {
      enabled: false,
      recoveryCodesRemaining: 0,
      enabledAt: null,
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MfaSettings
          initialSetup={{
            secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
            otpauthUri:
              "otpauth://totp/Jiange:alice@example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Jiange&algorithm=SHA1&digits=6&period=30",
          }}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-mfa-setup-panel");
    expect(html).toContain("<svg");
    expect(html).toContain("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
    expect(html).toContain("otpauth://totp/Jiange:alice@example.com");
    expect(html).toContain("data-mfa-copy-secret");
    expect(html).toContain("data-mfa-copy-uri");
    expect(html).toContain("data-mfa-enable-code-input");
    expect(html).toContain("验证并开启");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders 8 one-time recovery codes grid and copy-all button", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<MfaStatus>(MFA_STATUS_QUERY_KEY, {
      enabled: true,
      recoveryCodesRemaining: 8,
      enabledAt: "2026-11-24T08:00:00Z",
    });
    const codes = [
      "ABCD-EF23",
      "GHJK-LM45",
      "NPQR-ST67",
      "UVWX-YZ89",
      "BCDE-FG24",
      "HJKL-MN35",
      "PQRS-TU46",
      "VWXY-ZA57",
    ];
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MfaSettings initialRecoveryCodes={codes} />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-mfa-recovery-codes-panel");
    expect(html).toContain("data-mfa-copy-all-recovery");
    expect(html).toContain("复制全部恢复码");
    for (const c of codes) {
      expect(html).toContain(c);
    }
    expect(html).toContain("我已妥善保存");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders disable flow supporting both password and TOTP/recovery code modes", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<MfaStatus>(MFA_STATUS_QUERY_KEY, {
      enabled: true,
      recoveryCodesRemaining: 5,
      enabledAt: "2026-11-24T08:00:00Z",
    });
    const htmlPassword = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MfaSettings initialDisableOpen={true} initialDisableMethod="password" />
      </QueryClientProvider>,
    );
    expect(htmlPassword).toContain("data-mfa-disable-panel");
    expect(htmlPassword).toContain('role="radiogroup"');
    expect(htmlPassword).toContain("data-mfa-disable-password-input");
    expect(htmlPassword).toContain("确认关闭");
    expect(htmlPassword).not.toMatch(/<select[\s>]/i);

    const htmlCode = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MfaSettings initialDisableOpen={true} initialDisableMethod="code" />
      </QueryClientProvider>,
    );
    expect(htmlCode).toContain("data-mfa-disable-code-input");
    expect(htmlCode).not.toMatch(/<select[\s>]/i);
  });

  it("formats Base32 secrets and detects MFA challenge responses accurately", () => {
    expect(formatTotpSecret("jbswy3dpehpk3pxp")).toBe("JBSW Y3DP EHPK 3PXP");
    expect(
      isMfaChallengeResponse({
        mfaRequired: true,
        mfaToken: "tok-123",
        email: "alice@example.com",
      }),
    ).toBe(true);
    expect(isMfaChallengeResponse({ mfaRequired: false, mfaToken: "tok-123" })).toBe(false);
    expect(isMfaChallengeResponse({ user: { id: 1 }, workspaces: [] })).toBe(false);
    expect(isMfaChallengeResponse(null)).toBe(false);
  });
});
