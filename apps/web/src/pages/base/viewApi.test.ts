import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, baseApi } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("base atomic operations API", () => {
  it("sends the complete view order and propagates a conflict", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "view_conflict", message: "changed" }), { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(baseApi.reorderViews(4, [6, 7, 8], [8, 6, 7])).rejects.toMatchObject({ status: 409, code: "view_conflict" });
    expect(fetcher.mock.calls[0][0]).toBe("/api/bases/4/views/reorder");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ expectedViewIds: [6, 7, 8], viewIds: [8, 6, 7] });
  });
  it("copies a saved view through the dedicated endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 19 }), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(baseApi.duplicateView(4, 6)).resolves.toMatchObject({ id: 19 });
    expect(fetcher.mock.calls[0][0]).toBe("/api/bases/4/views/6/duplicate");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({});
  });
  it("renames with an expected name instead of overwriting concurrent configuration", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 6, name: "新视图" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await baseApi.renameView(4, 6, "旧视图", "新视图");
    expect(fetcher.mock.calls[0][0]).toBe("/api/bases/4/views/6/rename");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ expectedName: "旧视图", name: "新视图" });
  });
  it("sends expected cells with the atomic date update and surfaces conflict", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "cell_conflict", message: "changed" }), { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      await baseApi.compareCells(4, 12, { "7": "2026-01-01", "8": null }, { "7": "2026-01-02" });
      throw new Error("expected a conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(409);
    }
    expect(fetcher.mock.calls[0][0]).toBe("/api/bases/4/records/12/compare-cells");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ expected: { "7": "2026-01-01", "8": null }, cells: { "7": "2026-01-02" } });
  });
});
