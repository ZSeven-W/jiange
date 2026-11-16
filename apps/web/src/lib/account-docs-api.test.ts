import { afterEach, describe, expect, it, vi } from "vitest";
import { docsApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("account-bound document titles", () => {
  it("sends the account and rejects malformed title lists", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ docs: [{ id: 3, title: "需求" }] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ docs: [{ id: -1, title: "不应使用" }] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ docs: "bad" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await docsApi.listForAccount(7)).toEqual([{ id: 3, title: "需求" }]);
    expect(fetcher.mock.calls[0][0]).toBe("/api/account-docs");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "same-origin", headers: { "X-Jiange-User-Id": "7" } });
    await expect(docsApi.listForAccount(7)).rejects.toThrow("无法确认文档列表");
    await expect(docsApi.listForAccount(7)).rejects.toThrow("无法确认文档列表");
  });
});
