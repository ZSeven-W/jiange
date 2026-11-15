import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, slidesApi } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("slides visibility protocol", () => {
  it("rejects an old server and malformed visibility instead of showing hidden slides", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ pages: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ presentationProtocol: 4, pages: [{ id: 1 }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(slidesApi.pages(7, 3)).rejects.toMatchObject({ status: 426, code: "slide_server_outdated" } satisfies Partial<ApiError>);
    await expect(slidesApi.pages(7, 3)).rejects.toMatchObject({ status: 426 });
  });

  it("rejects unknown layouts and accepts the blank variants", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ presentationProtocol: 4, pages: [{ id: 1, hidden: false, shapes: [], layout: "future" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ presentationProtocol: 4, pages: [{ id: 1, hidden: false, shapes: [], layout: "blank-title" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(slidesApi.pages(7, 3)).rejects.toMatchObject({ status: 426 });
    expect(await slidesApi.pages(7, 3)).toEqual([{ id: 1, hidden: false, shapes: [], layout: "blank-title" }]);
  });
  it("rejects unsupported shapes rather than rendering a different shape", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ presentationProtocol: 4, pages: [{ id: 1, hidden: false, layout: "", shapes: [{ kind: "future-shape" }] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(slidesApi.pages(7, 3)).rejects.toMatchObject({ status: 426 });
  });
  it("binds a supported read to the initiating account", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ presentationProtocol: 4, pages: [{ id: 4, hidden: true, shapes: [], layout: "" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await slidesApi.pages(7, 3)).toEqual([{ id: 4, hidden: true, shapes: [], layout: "" }]);
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ "X-Jiange-User-Id": "3", "X-Jiange-Slides-Version": "4" });
  });
});
