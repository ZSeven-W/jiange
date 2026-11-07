import { afterEach, describe, expect, it, vi } from "vitest";
import { docsApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("recent visits API", () => {
  it("reads personal visit history and records visits with an empty request", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ docs: [{ id: 3, viewedAt: "2026-11-07T01:00:00Z" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    expect((await docsApi.recent())[0].viewedAt).toBe("2026-11-07T01:00:00Z");
    await expect(docsApi.recordVisit(3)).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0][0]).toBe("/api/recent");
    expect(fetcher.mock.calls[1][0]).toBe("/api/docs/3/visit");
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "same-origin" });
  });

  it("sends the parent's workspace when creating a child document", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 9 }), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    await docsApi.create("", 8, 42);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ title: "", parentId: 8, workspaceId: 42 });
  });
});
