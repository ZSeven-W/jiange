import { afterEach, describe, expect, it, vi } from "vitest";
import { docsApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
describe("account-bound version entries", () => {
  it("binds management to the selected entry, account and revision", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await docsApi.manageVersionEntry(8, "s:3", 2, "rename", 4, "交付版");
    await docsApi.manageVersionEntry(8, "s:3", 3, "delete", 4);
    expect(fetcher.mock.calls[0][0]).toBe("/api/docs/8/version-entries/s%3A3");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "PATCH", headers: { "X-Jiange-User-Id": "4" } });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: "rename", expectedRevision: 2, label: "交付版" });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ action: "delete", expectedRevision: 3 });
  });
  it("addresses and verifies the specific saved entry", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "n:2", seq: 3, view: { blocks: [] } }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ id: "n:1", seq: 3, view: { blocks: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await docsApi.savedVersionPreview(8, "n:2", 3, 4);
    expect(fetcher.mock.calls[0][0]).toBe("/api/docs/8/version-entries/n%3A2/preview");
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({ "X-Jiange-User-Id": "4" });
    await expect(docsApi.savedVersionPreview(8, "n:2", 3, 4)).rejects.toThrow("版本数据不匹配");
  });
  it("requests the selected version scope and binds previews to the account", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ versions: [] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ seq: 3, view: { blocks: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await docsApi.versionEntries(8, 4, "saved");
    await docsApi.versionPreview(8, 3, 4);
    expect(fetcher.mock.calls[0][0]).toBe("/api/docs/8/version-entries?scope=saved");
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({ "X-Jiange-User-Id": "4" });
    expect(fetcher.mock.calls[1][0]).toBe("/api/docs/8/versions/3");
    expect(fetcher.mock.calls[1][1].headers).toMatchObject({ "X-Jiange-User-Id": "4" });
  });
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
  it("binds restore to the initiating account and exposes cancellation", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ restored: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    await docsApi.restoreVersion(8, 3, 4, controller.signal);
    expect(fetcher.mock.calls[0][0]).toBe("/api/docs/8/versions/3/restore-guarded");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "X-Jiange-User-Id": "4" }, signal: controller.signal });
  });
});
