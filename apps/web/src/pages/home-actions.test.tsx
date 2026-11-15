import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { extrasApi, type DocMeta } from "@/lib/api";
import { HomeDocumentActions } from "./HomeDocumentActions";

afterEach(() => vi.unstubAllGlobals());
describe("home document actions", () => {
  it("binds reads and favorite writes to the initiating account", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ docs: [] }), { status: 200 })).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(JSON.stringify({ error: "session_changed" }), { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    expect(await extrasApi.favoritesForAccount(7)).toEqual([]);
    await extrasApi.favoriteForAccount(12, 7, true);
    await expect(extrasApi.pinsForAccount(7)).rejects.toMatchObject({ status: 401 });
    expect(fetch.mock.calls.map(([path, init]) => [path, init.method, init.headers["X-Jiange-User-Id"]])).toEqual([["/api/account-favorites", "GET", "7"], ["/api/docs/12/account-star", "PUT", "7"], ["/api/account-pins", "GET", "7"]]);
  });
  it("exposes a named menu trigger without nesting it in the card link", () => {
    const doc: DocMeta = { id: 1, title: "项目计划", updatedAt: "2026-01-01", createdAt: "2026-01-01", workspaceId: 1, parentId: null, icon: "", creatorId: 1, creatorName: "测试" };
    const html = renderToStaticMarkup(<HomeDocumentActions doc={doc} starred={false} pinned={false} ready busy={false} onFavorite={() => {}} onPin={() => {}} onCopy={() => {}} onShare={() => {}}/>);
    expect(html).toContain('aria-label="项目计划 更多操作"');
    expect(html).toContain('aria-haspopup="menu"');
  });
});
