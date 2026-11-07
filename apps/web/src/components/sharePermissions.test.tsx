import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, docsApi, type DocMeta } from "@/lib/api";
import { changeContentPermission, contentPermissions, copyProtectionError, SharePermissions } from "./sharePermissions";
import { ShareDialog } from "./ShareDialog";

const doc: DocMeta = { id: 7, workspaceId: 1, parentId: null, title: "测试", creatorId: 1, creatorName: "测试", icon: "", createdAt: "", updatedAt: "", role: "manage", copyProtected: false, copyMinRole: "view", downloadMinRole: "view", permissionsRevision: 0 };
const permissions = { copyMinRole: "view", downloadMinRole: "view", permissionsRevision: 0 } as const;

describe("share permission settings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers separate role settings and disables them until verified", () => {
    const html = renderToStaticMarkup(<SharePermissions permissions={undefined} busy={false} loading={true} enabled={false} error="" onBack={() => {}} onChange={() => {}} />);
    expect(html).toContain("权限设置");
    expect(html).toContain("谁可以复制内容");
    expect(html).toContain("谁可以创建副本、打印和下载");
    expect(html).toContain("disabled");
    expect(html).toContain("正在验证权限设置");
    expect(html).toContain("可编辑的用户");
  });

  it("keeps a focusable back control while a setting update is pending", () => {
    const html = renderToStaticMarkup(<SharePermissions permissions={permissions} busy={true} loading={false} enabled={true} error="" onBack={() => {}} onChange={() => {}} />);
    expect(html).toMatch(/<button[^>]*aria-label="返回分享"[^>]*aria-disabled="true"/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).toMatch(/<select[^>]*disabled=""/);
  });

  it("writes the requested value only after a fresh manager check", async () => {
    const write = vi.fn(async () => undefined);
    await changeContentPermission(permissions, "copyMinRole", "edit", async () => doc, write, () => true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ copyMinRole: "edit" }, 0);
  });

  it("sends the observed value in the guarded update and reports conflicts", async () => {
    const requests: Array<{ body?: string }> = [];
    vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
      requests.push({ body: init.body as string });
      return new Response(JSON.stringify(doc), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    await docsApi.setContentPermissions(doc.id, { copyMinRole: "edit" }, 0);
    await docsApi.setContentPermissions(doc.id, { downloadMinRole: "manage" }, 1);
    expect(requests.map((request) => JSON.parse(request.body!))).toEqual([
      { copyMinRole: "edit", expectedPermissionsRevision: 0 },
      { downloadMinRole: "manage", expectedPermissionsRevision: 1 },
    ]);
    expect(copyProtectionError(new ApiError(409, "share_conflict", "conflict"))).toContain("设置已被更改");
    expect(copyProtectionError(new TypeError("network"))).toContain("更新结果可能尚未确认");
  });

  it("does not overwrite a changed value or write after a role loss", async () => {
    const write = vi.fn(async () => undefined);
    await expect(changeContentPermission(permissions, "copyMinRole", "edit", async () => ({ ...doc, permissionsRevision: 2 }), write, () => true)).rejects.toThrow("设置已被更改");
    await expect(changeContentPermission(permissions, "copyMinRole", "edit", async () => ({ ...doc, role: "edit" }), write, () => true)).rejects.toThrow("没有管理权限");
    expect(write).not.toHaveBeenCalled();
  });

  it("does not write when the dialog closes during the permission check", async () => {
    const write = vi.fn(async () => undefined);
    await expect(changeContentPermission(permissions, "copyMinRole", "edit", async () => doc, write, () => false)).rejects.toThrow("页面状态已变化");
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects missing, invalid, or unsafe policy revisions rather than inventing a value", () => {
    expect(contentPermissions({ ...doc, copyMinRole: undefined })).toBeUndefined();
    expect(contentPermissions({ ...doc, permissionsRevision: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
    expect(contentPermissions({ ...doc, permissionsRevision: -1 })).toBeUndefined();
    expect(contentPermissions(doc)).toEqual(permissions);
  });

  it("keeps the two independent permission choices when updating either", async () => {
    const write = vi.fn(async () => undefined);
    const current = { ...doc, copyMinRole: "edit" as const, downloadMinRole: "manage" as const, permissionsRevision: 9 };
    await changeContentPermission(contentPermissions(current)!, "downloadMinRole", "view", async () => current, write, () => true);
    expect(write).toHaveBeenCalledWith({ downloadMinRole: "view" }, 9);
  });

  it("renders the selected role for each permission independently", () => {
    const html = renderToStaticMarkup(<SharePermissions permissions={{ copyMinRole: "edit", downloadMinRole: "manage", permissionsRevision: 3 }} busy={false} loading={false} enabled={true} error="" onBack={() => {}} onChange={() => {}} />);
    const copy = html.match(/<select id="permission-copyMinRole"[^>]*>(.*?)<\/select>/)?.[1];
    const download = html.match(/<select id="permission-downloadMinRole"[^>]*>(.*?)<\/select>/)?.[1];
    expect(copy).toContain('<option value="edit" selected="">可编辑的用户</option>');
    expect(download).toContain('<option value="manage" selected="">可管理的用户</option>');
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
    expect(await docsApi.setContentPermissions(doc.id, { copyMinRole: "edit" }, 0)).toBeUndefined();
  });
});
