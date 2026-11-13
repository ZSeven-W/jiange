import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, commitConditionalOps, conditionalBatchBase64 } from "./api";

afterEach(() => vi.unstubAllGlobals());
const base = { docId: 8, userId: 4, historyEpoch: 2, expectedSeq: 3, requestId: "a".repeat(32), batch: new Uint8Array([0, 1, 254, 255]), opCount: 2, signal: new AbortController().signal };

describe("conditional operation client", () => {
  it("sends the exact batch, account and version and validates the receipt", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sequences: [4, 5] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await commitConditionalOps(base)).toEqual([4, 5]);
    expect(fetcher.mock.calls[0][0]).toBe("/api/docs/8/conditional-ops");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "X-Jiange-User-Id": "4" }, signal: base.signal });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ historyEpoch: 2, expectedSeq: 3, requestId: "a".repeat(32), batch: "AAH+/w==" });
  });
  it("rejects invalid parameters before sending and treats malformed success as uncertain", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sequences: [4, 7] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(commitConditionalOps({ ...base, requestId: "bad" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(commitConditionalOps(base)).rejects.toMatchObject({ status: 502, code: "invalid_receipt" } satisfies Partial<ApiError>);
  });
  it("encodes large batches without argument-stack overflow", () => {
    const data = Uint8Array.from({ length: 200000 }, (_, i) => i % 256);
    const decoded = atob(conditionalBatchBase64(data));
    expect(decoded.length).toBe(data.length);
    expect(decoded.charCodeAt(199999)).toBe(data[199999]);
  });
});
