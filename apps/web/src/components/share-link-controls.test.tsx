import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { roleForScope, shareLinkScope, ShareLinkAccessSelect, ShareLinkScopeSelect } from "./share-link-controls";
import { docsApi } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("link sharing scope and access", () => {
  it("preserves edit access only when it was already selected for signed-in users", () => {
    expect(shareLinkScope("none")).toBe("restricted");
    expect(shareLinkScope("anon")).toBe("public");
    expect(shareLinkScope("edit")).toBe("signed-in");
    expect(shareLinkScope("workspace_view")).toBe("workspace");
    expect(roleForScope("signed-in", "none")).toBe("view");
    expect(roleForScope("signed-in", "anon")).toBe("view");
    expect(roleForScope("signed-in", "edit")).toBe("edit");
    expect(roleForScope("workspace", "edit")).toBe("workspace_view");
    expect(roleForScope("workspace", "workspace_edit")).toBe("workspace_edit");
    expect(roleForScope("signed-in", "workspace_edit")).toBe("view");
    expect(roleForScope("public", "edit")).toBe("anon");
    expect(roleForScope("restricted", "edit")).toBe("none");
  });
  it("binds link reads and changes to an account and observed revision", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ role: "manage", members: [], link: { role: "none", revision: 0 } }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ role: "view", revision: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect((await docsApi.sharesForAccount(8, 4)).link.revision).toBe(0);
    const controller = new AbortController();
    await docsApi.setLinkAtRevision(8, "view", 0, 4, controller.signal);
    expect(fetcher.mock.calls[0][0]).toBe("/api/docs/8/shares-account");
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({ "X-Jiange-User-Id": "4" });
    expect(fetcher.mock.calls[1][0]).toBe("/api/docs/8/link-guarded");
    expect(fetcher.mock.calls[1][1].headers).toMatchObject({ "X-Jiange-User-Id": "4" });
    expect(fetcher.mock.calls[1][1].signal).toBe(controller.signal);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ role: "view", expectedRevision: 0 });
  });
  it("treats an incomplete success response as an unconfirmed write", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ role: "view" }), { status: 200 })));
    await expect(docsApi.setLinkAtRevision(8, "view", 0, 4)).rejects.toBeInstanceOf(TypeError);
  });
  it("opens links through an account-bound, cancellable request", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 8, kind: "doc" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher); const controller = new AbortController();
    await docsApi.joinForAccount("abc123", 4, controller.signal);
    expect(fetcher.mock.calls[0][0]).toBe("/api/share/abc123/join-guarded");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", signal: controller.signal, headers: { "X-Jiange-User-Id": "4" } });
  });
  it("renders separate accessible controls without offering anonymous edit", () => {
    const scope = renderToStaticMarkup(<ShareLinkScopeSelect role="view" allowPublic disabled={false} onChange={() => {}} />);
    const edit = renderToStaticMarkup(<ShareLinkAccessSelect role="view" disabled={false} onChange={() => {}} />);
    const publicAccess = renderToStaticMarkup(<ShareLinkAccessSelect role="anon" disabled={false} onChange={() => {}} />);
    expect(scope).toContain('aria-label="链接分享范围"');
    expect(scope).toContain("互联网上任何人");
    expect(scope).toContain("当前空间成员");
    expect(edit).toContain('aria-label="链接分享权限"');
    expect(edit).toContain("可编辑");
    expect(publicAccess).toContain("可阅读");
    expect(publicAccess).not.toContain("可编辑");
    expect(renderToStaticMarkup(<ShareLinkAccessSelect role="workspace_edit" disabled={false} onChange={() => {}} />)).toContain('<option value="edit" selected="">可编辑</option>');
    expect(renderToStaticMarkup(<ShareLinkScopeSelect role="view" allowPublic={false} disabled={false} onChange={() => {}} />)).not.toContain("互联网上任何人");
  });
});
