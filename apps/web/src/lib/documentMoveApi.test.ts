import { afterEach, describe, expect, it, vi } from "vitest";
import { driveApi, extrasApi } from "./api";
import { nodeHref } from "./route";

afterEach(() => vi.unstubAllGlobals());

describe("document move and pin requests", () => {
  it("binds mutations to the initiating account and expected revision", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await driveApi.moveForAccount(8, 4, 3, 12);
    await extrasApi.pinForAccount(8, 12, true);
    await extrasApi.pinForAccount(8, 12, false);
    expect(fetcher.mock.calls[0][0]).toBe("/api/drive/account-move/8");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Jiange-User-Id": "12" } });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ parentId: 4, expected: 3 });
    expect(fetcher.mock.calls[1][0]).toBe("/api/docs/8/account-pin");
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "PUT", headers: { "X-Jiange-User-Id": "12" } });
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: "DELETE", headers: { "X-Jiange-User-Id": "12" } });
  });

  it("loads folders in the document workspace and routes folder breadcrumbs correctly", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await driveApi.children(null, true, 9);
    await driveApi.children(4, false, 9);
    expect(fetcher.mock.calls[0][0]).toBe("/api/drive/children?scope=personal&workspaceId=9");
    expect(fetcher.mock.calls[1][0]).toBe("/api/drive/children?parent=4&workspaceId=9");
    expect(nodeHref({ id: 4, kind: "folder" })).toBe("#/drive/4");
  });
});
