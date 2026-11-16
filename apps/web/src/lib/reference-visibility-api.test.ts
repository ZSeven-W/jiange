import { afterEach, describe, expect, it, vi } from "vitest";
import { docsApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
describe("reference visibility API", () => {
  it("binds account and validates revisioned reads and writes", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ visible: true, revision: 0 }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ visible: false, revision: 1 }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ visible: "bad", revision: 1 }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ visible: true, revision: 99 }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    expect(await docsApi.referenceVisibility(3, 7, signal)).toEqual({ visible: true, revision: 0 });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", headers: { "X-Jiange-User-Id": "7" }, signal });
    expect(await docsApi.setReferenceVisibility(3, 7, false, 0)).toEqual({ visible: false, revision: 1 });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ visible: false, expectedRevision: 0 });
    await expect(docsApi.referenceVisibility(3, 7)).rejects.toThrow("无法确认显示设置");
    await expect(docsApi.setReferenceVisibility(3, 7, true, 1)).rejects.toThrow("无法确认显示设置");
  });
});
