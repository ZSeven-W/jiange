import { afterEach, describe, expect, it, vi } from "vitest";
import { docsApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
describe("account-bound version entries", () => {
  it("sends account, request identity, expected head and epoch", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ versions: [] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ id: "n:1", seq: 3 }), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await docsApi.versionEntries(8, 4)).toEqual([]);
    const controller = new AbortController();
    await docsApi.createVersionEntry(8, "初稿", 3, 2, "a".repeat(32), 4, controller.signal);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "same-origin", headers: { "X-Jiange-User-Id": "4" } });
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "X-Jiange-User-Id": "4" }, signal: controller.signal });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ label: "初稿", expectedSeq: 3, historyEpoch: 2, requestId: "a".repeat(32) });
  });
});
