import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MFA_STATUS_QUERY_KEY } from "@/lib/mfa-api";
import {
  PASSKEYS_QUERY_KEY,
  base64UrlToBuffer,
  bufferToBase64Url,
  deletePasskey,
  isWebAuthnSupported,
  listPasskeys,
  loginWithPasskey,
  registerPasskey,
  type PasskeySummary,
} from "@/lib/passkey-api";
import { AccountSecurityHost } from "./account-security-dialog";
import { PasskeySettings } from "./passkey-settings";

const samplePasskeys: PasskeySummary[] = [
  {
    id: 1,
    name: "MacBook Touch ID",
    credentialId: "Y3JlZC0x",
    aaguid: "01020304-0506-0708-090a-0b0c0d0e0f10",
    transports: ["internal", "hybrid"],
    createdAt: "2026-11-20T08:00:00Z",
    lastUsedAt: "2026-11-24T09:30:00Z",
  },
  {
    id: 2,
    name: "YubiKey 5C",
    credentialId: "Y3JlZC0y",
    aaguid: "00000000-0000-0000-0000-000000000000",
    transports: ["usb", "nfc"],
    createdAt: "2026-11-21T10:00:00Z",
    lastUsedAt: null,
  },
];

describe("PasskeySettings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders empty state and add form with zero native selects", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<PasskeySummary[]>(PASSKEYS_QUERY_KEY, []);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <PasskeySettings webAuthnSupported={true} />
      </QueryClientProvider>,
    );

    expect(html).toContain("data-passkey-settings");
    expect(html).toContain("通行密钥（Passkey）");
    expect(html).toContain("未绑定");
    expect(html).toContain("data-passkey-empty");
    expect(html).toContain("暂未绑定通行密钥");
    expect(html).toContain("data-passkey-name-input");
    expect(html).toContain("data-passkey-add-btn");
    expect(html).toContain("添加通行密钥");
    expect(html).not.toContain("data-passkey-unsupported");
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders registered passkeys with transports, timestamps, and inline delete confirmation (zero window.confirm)", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<PasskeySummary[]>(PASSKEYS_QUERY_KEY, samplePasskeys);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <PasskeySettings webAuthnSupported={true} initialConfirmDeleteId={1} />
      </QueryClientProvider>,
    );

    expect(html).toContain("已绑定 2 个");
    expect(html).toContain('data-passkey-item="1"');
    expect(html).toContain("MacBook Touch ID");
    expect(html).toContain("本机认证器");
    expect(html).toContain("跨设备蓝牙");
    expect(html).toContain("2026-11-20");
    expect(html).toContain('data-passkey-confirm-box="1"');
    expect(html).toContain('data-passkey-confirm-delete="1"');
    expect(html).toContain('data-passkey-cancel-delete="1"');
    expect(html).toContain("确认移除");

    expect(html).toContain('data-passkey-item="2"');
    expect(html).toContain("YubiKey 5C");
    expect(html).toContain("USB");
    expect(html).toContain("NFC");
    expect(html).toContain("尚未使用");
    expect(html).toContain('data-passkey-delete-btn="2"');
    expect(html).not.toMatch(/<select[\s>]/i);
  });

  it("renders unsupported WebAuthn notice and disables add button when unsupported", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<PasskeySummary[]>(PASSKEYS_QUERY_KEY, []);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <PasskeySettings webAuthnSupported={false} />
      </QueryClientProvider>,
    );

    expect(html).toContain("data-passkey-unsupported");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-passkey-add-btn/);
  });

  it("round-trips base64url buffers and executes passkey register, list, login, and delete API calls", async () => {
    const sampleBytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = bufferToBase64Url(sampleBytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    const decoded = new Uint8Array(base64UrlToBuffer(encoded));
    expect(Array.from(decoded)).toEqual(Array.from(sampleBytes));

    // Stub WebAuthn globals in Node test environment
    const fakeCredRawId = new Uint8Array([10, 20, 30, 40]).buffer;
    const fakeClientData = new Uint8Array([123, 125]).buffer;
    const fakeAttObj = new Uint8Array([161, 1, 2]).buffer;
    const fakeAuthData = new Uint8Array(37).buffer;
    const fakeSig = new Uint8Array([48, 6, 2, 1, 1, 2, 1, 2]).buffer;

    vi.stubGlobal("window", { PublicKeyCredential: function PublicKeyCredential() {} });
    vi.stubGlobal("navigator", {
      credentials: {
        create: vi.fn(async () => ({
          id: bufferToBase64Url(fakeCredRawId),
          rawId: fakeCredRawId,
          type: "public-key",
          response: {
            clientDataJSON: fakeClientData,
            attestationObject: fakeAttObj,
            getTransports: () => ["internal"],
          },
        })),
        get: vi.fn(async () => ({
          id: bufferToBase64Url(fakeCredRawId),
          rawId: fakeCredRawId,
          type: "public-key",
          response: {
            clientDataJSON: fakeClientData,
            authenticatorData: fakeAuthData,
            signature: fakeSig,
            userHandle: null,
          },
        })),
      },
    });
    expect(isWebAuthnSupported()).toBe(true);

    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url === "/api/me/passkeys" && init?.method === "GET") {
        return new Response(JSON.stringify({ passkeys: samplePasskeys }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/me/passkeys/register/begin") {
        return new Response(
          JSON.stringify({
            rp: { id: "localhost", name: "Jiange" },
            user: { id: "AAAAAAAAAAE", name: "alice@example.com", displayName: "Alice" },
            challenge: "Y2hhbGxlbmdlLTE",
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            timeout: 60000,
            excludeCredentials: [],
            attestation: "none",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/me/passkeys/register/finish") {
        return new Response(JSON.stringify(samplePasskeys[0]), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/auth/passkey/login/begin") {
        return new Response(
          JSON.stringify({
            challenge: "bG9naW4tY2hhbGxlbmdl",
            timeout: 60000,
            rpId: "localhost",
            allowCredentials: [{ type: "public-key", id: bufferToBase64Url(fakeCredRawId) }],
            userVerification: "preferred",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/auth/passkey/login/finish") {
        return new Response(
          JSON.stringify({
            user: { id: 1, email: "alice@example.com", name: "Alice" },
            workspaces: [{ id: 1, name: "Alice 的空间", ownerId: 1 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/me/passkeys/1" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });

    const listed = await listPasskeys();
    expect(listed).toHaveLength(2);

    const created = await registerPasskey("MacBook Touch ID");
    expect(created.name).toBe("MacBook Touch ID");

    const me = await loginWithPasskey("alice@example.com");
    expect(me.user.email).toBe("alice@example.com");

    await deletePasskey(1);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/me/passkeys",
      "POST /api/me/passkeys/register/begin",
      "POST /api/me/passkeys/register/finish",
      "POST /api/auth/passkey/login/begin",
      "POST /api/auth/passkey/login/finish",
      "DELETE /api/me/passkeys/1",
    ]);
    expect(calls[3].body).toEqual({ email: "alice@example.com" });
  });

  it("renders AccountSecurityHost with Passkey tab and amber mfaSetupRequired policy banner", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(MFA_STATUS_QUERY_KEY, {
      enabled: false,
      recoveryCodesRemaining: 0,
      enabledAt: null,
      mfaRequiredByPolicy: true,
      mfaRequiredWorkspaces: ["Acme 研发空间"],
      mfaSetupRequired: true,
    });
    qc.setQueryData<PasskeySummary[]>(PASSKEYS_QUERY_KEY, []);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <AccountSecurityHost initialOpen={true} initialTab="passkey" />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-security-tab="mfa"');
    expect(html).toContain('data-security-tab="passkey"');
    expect(html).toContain('data-security-tab="pat"');
    expect(html).toContain("通行密钥 / Passkey");
    expect(html).toContain("data-mfa-policy-required-banner");
    expect(html).toContain("工作空间要求开启二步验证");
    expect(html).toContain("Acme 研发空间");
    expect(html).toContain("data-passkey-settings");
    expect(html).not.toMatch(/<select[\s>]/i);
  });
});
