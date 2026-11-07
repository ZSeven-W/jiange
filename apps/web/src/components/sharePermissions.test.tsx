import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, docsApi, type DocMeta } from "@/lib/api";
import { changeCopyProtection, copyProtectionError, SharePermissions } from "./sharePermissions";
import { ShareDialog } from "./ShareDialog";

const doc: DocMeta = { id: 7, workspaceId: 1, parentId: null, title: "测试", creatorId: 1, creatorName: "测试", icon: "", createdAt: "", updatedAt: "", role: "manage", copyProtected: false };

describe("share permission settings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers the supported combined restriction and disables it until verified", () => {
    const html = renderToStaticMarkup(<SharePermissions protectedCopy={false} busy={false} loading={true} enabled={false} error="" onBack={() => {}} onChange={() => {}} />);
    expect(html).toContain("权限设置");
    expect(html).toContain("限制非管理者复制、下载和导出内容");
    expect(html).toContain('aria-label="防复制下载"');
    expect(html).toContain("disabled");
    expect(html).toContain("正在验证权限设置");
    expect(html).not.toContain("可编辑的用户");
  });

  it("keeps a focusable back control while a setting update is pending", () => {
    const html = renderToStaticMarkup(<SharePermissions protectedCopy={false} busy={true} loading={false} enabled={true} error="" onBack={() => {}} onChange={() => {}} />);
    expect(html).toMatch(/<button[^>]*aria-label="返回分享"[^>]*aria-disabled="true"/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });

  it("writes the requested value only after a fresh manager check", async () => {
    const write = vi.fn(async () => undefined);
    await changeCopyProtection(false, true, async () => doc, write, () => true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(true, false);
  });

  it("sends the observed value in the guarded update and reports conflicts", async () => {
    const requests: Array<{ body?: string }> = [];
    vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
      requests.push({ body: init.body as string });
      return new Response(JSON.stringify(doc), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    await docsApi.setCopyProtected(doc.id, true, false);
    await docsApi.setCopyProtected(doc.id, false);
    expect(requests.map((request) => JSON.parse(request.body!))).toEqual([
      { copyProtected: true, expectedCopyProtected: false },
      { copyProtected: false },
    ]);
    expect(copyProtectionError(new ApiError(409, "share_conflict", "conflict"))).toContain("设置已被更改");
    expect(copyProtectionError(new TypeError("network"))).toContain("更新结果可能尚未确认");
  });

  it("does not overwrite a changed value or write after a role loss", async () => {
    const write = vi.fn(async () => undefined);
    await expect(changeCopyProtection(false, true, async () => ({ ...doc, copyProtected: true }), write, () => true)).rejects.toThrow("设置已被更改");
    await expect(changeCopyProtection(false, true, async () => ({ ...doc, role: "edit" }), write, () => true)).rejects.toThrow("没有管理权限");
    expect(write).not.toHaveBeenCalled();
  });

  it("does not write when the dialog closes during the permission check", async () => {
    const write = vi.fn(async () => undefined);
    await expect(changeCopyProtection(false, true, async () => doc, write, () => false)).rejects.toThrow("页面状态已变化");
    expect(write).not.toHaveBeenCalled();
  });

  it("shows settings only to document managers", () => {
    vi.stubGlobal("location", { origin: "https://example.test" });
    const render = (role: "manage" | "edit") => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      qc.setQueryData(["shares", doc.id], { role, members: [], link: { role: "none" } });
      return renderToStaticMarkup(<QueryClientProvider client={qc}><ShareDialog meta={{ ...doc, role }} onClose={() => {}} /></QueryClientProvider>);
    };
    expect(render("manage")).toContain("权限设置");
    expect(render("edit")).not.toContain("权限设置");
  });

  it("hides cached share details after an access error", () => {
    vi.stubGlobal("location", { origin: "https://example.test" });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
    const key = ["shares", doc.id];
    qc.setQueryData(key, { role: "manage", members: [{ userId: 3, name: "私人协作者", email: "private@example.test", role: "edit" }], link: { role: "view", token: "private-token" } });
    const query = qc.getQueryCache().find({ queryKey: key })!;
    query.setState({ status: "error", error: new ApiError(403, "forbidden", "denied") });
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><ShareDialog meta={doc} onClose={() => {}} /></QueryClientProvider>);
    expect(html).toContain("加载分享设置失败");
    expect(html).not.toContain("私人协作者");
    expect(html).not.toContain("private-token");
    expect(html).not.toContain("权限设置");
  });

  it("handles successful share and link updates without a response body", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    expect(await docsApi.share(doc.id, "user@example.test", "edit")).toBeUndefined();
    expect(await docsApi.setLink(doc.id, "view")).toBeUndefined();
    expect(await docsApi.setCopyProtected(doc.id, true, false)).toBeUndefined();
  });
});
