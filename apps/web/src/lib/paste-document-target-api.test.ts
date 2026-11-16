import { afterEach, describe, expect, it, vi } from "vitest";
import { docsApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
describe("account-bound pasted document lookup", () => {
  it("binds the account and rejects a mismatched target", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 3, title: "需求" }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ id: 4, title: "不应使用" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    expect(await docsApi.pasteTarget(3, 7, signal)).toBe("需求");
    expect(fetcher.mock.calls[0][0]).toBe("/api/docs/3/paste-target");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "same-origin", headers: { "X-Jiange-User-Id": "7" }, signal });
    await expect(docsApi.pasteTarget(3, 7, signal)).rejects.toThrow("无法确认文档名称");
  });
});
