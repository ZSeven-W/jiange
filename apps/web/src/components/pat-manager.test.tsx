import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  patApi,
  securityApi,
  type CreatePATResult,
  type PersonalAccessToken,
} from "@/lib/security-api";
import {
  PAT_QUERY_KEY,
  PatManager,
  formatPATCurlExample,
  getPATStatus,
  togglePATScope,
} from "./pat-manager";

const activeToken: PersonalAccessToken = {
  id: 11,
  userId: 1,
  name: "CI 发布流水线",
  tokenPrefix: "jg_pat_AbCdEfG",
  scopes: ["read", "write"],
  expiresAt: "2099-12-31T00:00:00Z",
  lastUsedAt: "2026-11-24T06:30:00Z",
  revokedAt: null,
  createdAt: "2026-11-01T08:00:00Z",
};

const expiredToken: PersonalAccessToken = {
  id: 12,
  userId: 1,
  name: "历史导入脚本",
  tokenPrefix: "jg_pat_Exp1234",
  scopes: ["read"],
  expiresAt: "2020-01-01T00:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2019-12-01T08:00:00Z",
};

const revokedToken: PersonalAccessToken = {
  id: 13,
  userId: 1,
  name: "已泄露临时令牌",
  tokenPrefix: "jg_pat_Rev9876",
  scopes: ["read", "write", "admin"],
  expiresAt: null,
  lastUsedAt: "2026-11-10T09:15:00Z",
  revokedAt: "2026-11-20T12:00:00Z",
  createdAt: "2026-10-01T08:00:00Z",
};

function renderManager(
  tokens: PersonalAccessToken[],
  initialCreatedToken: CreatePATResult | null = null,
  apiOrigin?: string,
): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  qc.setQueryData(PAT_QUERY_KEY, tokens);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <PatManager initialCreatedToken={initialCreatedToken} apiOrigin={apiOrigin} />
    </QueryClientProvider>,
  );
}

describe("PatManager", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders FeishuSelect expiration options (zero native select), scope checkboxes, token table, and curl example", () => {
    const html = renderManager([activeToken, expiredToken, revokedToken]);

    // Strict zero native <select> check
    expect(html).not.toMatch(/<select[\s>]/i);

    // FeishuSelect combobox with exact expiration options
    expect(html).toContain('role="combobox"');
    expect(html).toContain('data-pat-expiry-select=""');
    expect(html).toContain("30:30 天|90:90 天|365:1 年|0:永不过期");

    // Scope checkboxes
    expect(html).toContain('data-pat-scope="read"');
    expect(html).toContain('data-pat-scope="write"');
    expect(html).toContain('data-pat-scope="admin"');
    expect(html).toContain("只读");
    expect(html).toContain("读写");
    expect(html).toContain("管理");

    // Active count pill (only 1 of 3 is active)
    expect(html).toContain("1 / 50 生效中");

    // Token rows with prefix, scopes, last-used, status pills, and revoke actions
    expect(html).toContain("CI 发布流水线");
    expect(html).toContain("jg_pat_AbCdEfG...");
    expect(html).toContain("生效中");
    expect(html).toContain('data-pat-revoke="11"');

    expect(html).toContain("历史导入脚本");
    expect(html).toContain("jg_pat_Exp1234...");
    expect(html).toContain("已过期");
    expect(html).toContain("从未使用");
    expect(html).toContain('data-pat-revoke="12"');

    expect(html).toContain("已泄露临时令牌");
    expect(html).toContain("jg_pat_Rev9876...");
    expect(html).toContain("已吊销");
    expect(html).not.toContain('data-pat-revoke="13"');

    // Concise curl example box
    expect(html).toContain('data-pat-curl-example=""');
    expect(html).toContain('curl -H &quot;Authorization: Bearer jg_pat_...&quot; /api/me');
  });

  it("renders empty state when user has no personal access tokens", () => {
    const html = renderManager([]);
    expect(html).toContain('data-pat-empty=""');
    expect(html).toContain("尚未创建任何个人访问令牌");
    expect(html).toContain("0 / 50 生效中");
    expect(html).not.toContain('data-pat-table=""');
  });

  it("renders one-time created token banner with raw jg_pat_ secret, copy button, and warning", () => {
    const rawToken = "jg_pat_SecretRawTokenValue1234567890abcdefghijk";
    const html = renderManager([activeToken], { token: activeToken, rawToken });

    expect(html).toContain('data-pat-created-banner=""');
    expect(html).toContain('data-pat-raw-token=""');
    expect(html).toContain(rawToken);
    expect(html).toContain("此令牌仅展示一次，关闭后无法再次查看");
    expect(html).toContain("一键复制");
    expect(html).toContain('data-pat-copy-raw=""');
    expect(html).toContain('data-pat-banner-close=""');
  });

  it("computes PAT status, toggles scopes in canonical order, and formats curl snippets", () => {
    const now = new Date("2026-11-24T12:00:00Z");
    expect(getPATStatus({ revokedAt: null, expiresAt: null }, now)).toBe("active");
    expect(getPATStatus({ revokedAt: null, expiresAt: "2026-11-25T00:00:00Z" }, now)).toBe("active");
    expect(getPATStatus({ revokedAt: null, expiresAt: "2026-11-24T12:00:00Z" }, now)).toBe("expired");
    expect(getPATStatus({ revokedAt: null, expiresAt: "2026-11-20T00:00:00Z" }, now)).toBe("expired");
    expect(getPATStatus({ revokedAt: "2026-11-20T00:00:00Z", expiresAt: "2020-01-01T00:00:00Z" }, now)).toBe("revoked");

    expect(togglePATScope(["read"], "admin")).toEqual(["read", "admin"]);
    expect(togglePATScope(["read", "admin"], "write")).toEqual(["read", "write", "admin"]);
    expect(togglePATScope(["read", "write"], "read")).toEqual(["write"]);

    expect(formatPATCurlExample()).toBe('curl -H "Authorization: Bearer jg_pat_..." /api/me');
    expect(formatPATCurlExample("https://docs.example.com/")).toBe(
      'curl -H "Authorization: Bearer jg_pat_..." https://docs.example.com/api/me',
    );
  });

  it("calls GET/POST/DELETE /api/me/tokens and maps errors to ApiError", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (url === "/api/me/tokens" && method === "GET") {
        return new Response(JSON.stringify({ tokens: [activeToken] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/me/tokens" && method === "POST") {
        const parsed = JSON.parse(String(init?.body ?? "{}"));
        if (parsed.name === "overflow") {
          return new Response(
            JSON.stringify({ error: "pat_limit_reached", message: "最多保留 50 个有效访问令牌" }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ token: activeToken, rawToken: "jg_pat_created_raw_token" }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/me/tokens/11" && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ error: "not_found", message: "访问令牌不存在" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    const list = await patApi.list();
    expect(list).toHaveLength(1);
    expect(list[0].tokenPrefix).toBe("jg_pat_AbCdEfG");

    const created = await securityApi.createPAT({
      name: "CI 发布流水线",
      scopes: ["read", "write"],
      expiresInDays: 90,
    });
    expect(created.rawToken).toBe("jg_pat_created_raw_token");
    expect(JSON.parse(calls[1].body!)).toEqual({
      name: "CI 发布流水线",
      scopes: ["read", "write"],
      expiresInDays: 90,
    });

    await expect(securityApi.revokePAT(11)).resolves.toBeUndefined();
    expect(calls[2]).toEqual({ url: "/api/me/tokens/11", method: "DELETE", body: undefined });

    await expect(patApi.create({ name: "overflow", scopes: ["read"] })).rejects.toMatchObject({
      status: 409,
      code: "pat_limit_reached",
    });
    await expect(patApi.revoke(999)).rejects.toBeInstanceOf(ApiError);
  });
});
