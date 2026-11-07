import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, extrasApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("search API", () => {
  it("passes an abort signal and encodes the search string", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ docs: [{ id: 1 }] })));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    await expect(extrasApi.search("文档 &", controller.signal)).resolves.toEqual([{ id: 1 }]);
    expect(fetcher).toHaveBeenCalledWith("/api/search?q=%E6%96%87%E6%A1%A3%20%26", expect.objectContaining({ signal: controller.signal }));
  });

  it("aborts a pending request when the search changes", async () => {
    const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const pending = extrasApi.search("旧词", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps incomplete and malformed responses distinct from no results", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "search_incomplete", message: "搜索未完成" }), { status: 503 }))
      .mockResolvedValueOnce(new Response("not json", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(extrasApi.search("词")).rejects.toMatchObject({ status: 503, code: "search_incomplete" });
    await expect(extrasApi.search("词")).rejects.toBeInstanceOf(ApiError);
  });
});
