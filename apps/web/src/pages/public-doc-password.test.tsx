import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type DocMeta, type ShareInfo } from "@/lib/api";
import { putLinkPassword, verifyPublicLinkPassword } from "@/lib/share-password-api";
import { ShareDialog } from "@/components/share-dialog";
import {
  fetchPublicDoc,
  initialPublicDocState,
  updatePublicDocState,
  type PublicSnapshot,
} from "./public-doc-state";
import { PublicDoc, PublicDocMessage, PublicPasswordGate } from "./public-doc";

const sampleSnapshot: PublicSnapshot = {
  title: "机密架构方案",
  updatedAt: "2026-11-24T08:00:00Z",
  copyProtected: true,
  view: { blocks: [] },
};

const sampleDoc: DocMeta = {
  id: 42,
  workspaceId: 1,
  parentId: null,
  title: "测试文档",
  creatorId: 1,
  creatorName: "林晓",
  icon: "",
  createdAt: "",
  updatedAt: "",
  role: "manage",
  copyProtected: false,
  copyMinRole: "view",
  downloadMinRole: "view",
  permissionsRevision: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe("public-doc-state password_required handling", () => {
  it("maps HTTP 403 password_required to password_required issue and other 403s to expired", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "password_required", message: "此分享链接已加密，请输入访问密码" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;

    expect(await fetchPublicDoc("secret-tok", signal)).toEqual({ issue: "password_required" });
    expect(await fetchPublicDoc("secret-tok", signal)).toEqual({ issue: "expired" });
    expect(await fetchPublicDoc("secret-tok", signal)).toEqual({ issue: "expired" });
  });

  it("clears any previously loaded snapshot when password_required arrives", () => {
    const loaded = updatePublicDocState(initialPublicDocState("tok"), "tok", { snapshot: sampleSnapshot });
    expect(loaded.snapshot?.title).toBe("机密架构方案");
    const locked = updatePublicDocState(loaded, "tok", { issue: "password_required" });
    expect(locked.snapshot).toBeNull();
    expect(locked.issue).toBe("password_required");
  });
});

describe("PublicDoc password gate & watermark", () => {
  it("renders Feishu-style password gate card for password_required issue", () => {
    const html = renderToStaticMarkup(
      <PublicDocMessage issue="password_required" token="enc-tok" onRetry={() => {}} />,
    );
    expect(html).toContain("data-public-password-gate");
    expect(html).toContain("data-public-password-input");
    expect(html).toContain("data-public-password-submit");
    expect(html).toContain("此分享链接已加密");
    expect(html).toContain("验证并访问");
    expect(html).toContain("<svg");
    expect(html).not.toContain("<select");
  });

  it("renders custom description on PublicPasswordGate (used by JoinLink)", () => {
    const html = renderToStaticMarkup(
      <PublicPasswordGate token="join-tok" description="请输入访问密码（提取码）以加入协作" onVerified={() => {}} />,
    );
    expect(html).toContain("请输入访问密码（提取码）以加入协作");
    expect(html).toContain("验证并访问");
  });

  it("renders diagonal tiled DocumentWatermark on PublicDoc when copyProtected is true", () => {
    const protectedHtml = renderToStaticMarkup(
      <PublicDoc token="wm-tok" initialSnapshot={sampleSnapshot} />,
    );
    expect(protectedHtml).toContain('data-watermark=""');
    expect(protectedHtml).toContain('data-watermark-source="copy-protected"');
    expect(protectedHtml).toContain('data-watermark-label="机密架构方案"');
    expect(protectedHtml).toContain("rotate(-24)");

    const openHtml = renderToStaticMarkup(
      <PublicDoc token="open-tok" initialSnapshot={{ ...sampleSnapshot, copyProtected: false }} />,
    );
    expect(openHtml).not.toContain('data-watermark=""');
  });
});

describe("ShareDialog access password control", () => {
  const renderShareDialog = (share: ShareInfo & { hasPassword?: boolean }) => {
    vi.stubGlobal("location", { origin: "https://example.test", pathname: "/" });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["shares", sampleDoc.id, 1], share);
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <ShareDialog meta={sampleDoc} userId={1} onClose={() => {}} />
      </QueryClientProvider>,
    );
  };

  it("renders password row with unset badge when link sharing is enabled for managers", () => {
    const html = renderShareDialog({
      role: "manage",
      members: [],
      link: { role: "anon", token: "abc123", revision: 1 },
      hasPassword: false,
    });
    expect(html).toContain("data-link-password-section");
    expect(html).toContain("访问密码（提取码）");
    expect(html).toContain("未设置");
    expect(html).toContain("data-link-password-input");
    expect(html).toContain("data-link-password-save");
    expect(html).not.toContain("data-link-password-clear");
    expect(html).not.toContain("<select");
  });

  it("renders active password badge and clear button when hasPassword is true", () => {
    const html = renderShareDialog({
      role: "manage",
      members: [],
      link: { role: "view", token: "abc123", revision: 2 },
      hasPassword: true,
    });
    expect(html).toContain("已设置访问密码");
    expect(html).toContain("data-link-password-clear");
    expect(html).toContain("取消密码");
    expect(html).toContain("保存密码");
    expect(html).not.toContain("<select");
  });

  it("hides access password row when link is closed or caller is not a manager", () => {
    const closedHtml = renderShareDialog({
      role: "manage",
      members: [],
      link: { role: "none", revision: 0 },
      hasPassword: false,
    });
    expect(closedHtml).not.toContain("data-link-password-section");

    const viewerHtml = renderShareDialog({
      role: "view",
      members: [],
      link: { role: "anon", revision: 1 },
      hasPassword: true,
    });
    expect(viewerHtml).not.toContain("data-link-password-section");
  });
});

describe("share-password-api client", () => {
  it("calls PUT /api/docs/{id}/link-password and POST /api/public/{token}/verify-password", async () => {
    const calls: Array<{ url: string; method?: string; body?: string; headers?: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method,
        body: init?.body as string | undefined,
        headers: init?.headers as Record<string, string> | undefined,
      });
      if (url.endsWith("/link-password")) {
        return new Response(JSON.stringify({ hasPassword: true }), { status: 200 });
      }
      if (init?.body === JSON.stringify({ password: "bad" })) {
        return new Response(JSON.stringify({ error: "invalid_password", message: "访问密码错误" }), { status: 403 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const putRes = await putLinkPassword(42, { password: "pass2026" }, 7);
    expect(putRes).toEqual({ hasPassword: true });
    expect(calls[0].url).toBe("/api/docs/42/link-password");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].headers?.["X-Jiange-User-Id"]).toBe("7");

    await expect(verifyPublicLinkPassword("a/b", "bad")).rejects.toMatchObject({
      status: 403,
      code: "invalid_password",
    } satisfies Partial<ApiError>);

    const okRes = await verifyPublicLinkPassword("a/b", "pass2026");
    expect(okRes).toEqual({ ok: true });
    expect(calls[2].url).toBe("/api/public/a%2Fb/verify-password");
    expect(calls[2].method).toBe("POST");
  });
});
