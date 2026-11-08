import { describe, expect, it, vi, afterEach } from "vitest";
import { nodeHref, parseHash } from "./route";
import { driveApi, ApiError } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("standalone drive files", () => {
  it("opens file links as files, not collaborative documents", () => {
    expect(nodeHref({ id: 42, kind: "file" })).toBe("#/file/42");
    expect(nodeHref({ id: 7, kind: "slides" })).toBe("#/slides/7");
    expect(parseHash("#/file/42")).toEqual({ page: "file", id: 42 });
    expect(parseHash("#/file/42/extra")).toEqual({ page: "home" });
  });
  it("uploads multipart data to the chosen folder and preserves server errors", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 7, kind: "file" }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "no_storage", message: "云盘文件存储未配置" }), { status: 503, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await expect(driveApi.uploadFile(file, 12, true)).resolves.toMatchObject({ id: 7, kind: "file" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/drive/files");
    expect(init.headers["X-Jiange-Upload"]).toBe("1");
    expect(init.body.get("parentId")).toBe("12");
    expect(init.body.get("scope")).toBe("personal");
    expect(init.body.get("file").name).toBe("notes.txt");
    await expect(driveApi.uploadFile(file, null, false)).rejects.toMatchObject({ status: 503, code: "no_storage" } satisfies Partial<ApiError>);
  });
  it("uses account-bound routes for batch mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 7, kind: "folder" }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    await driveApi.create("目录", null, true, signal, 42);
    await driveApi.uploadFile(new File(["a"], "a.txt"), 7, true, signal, 42);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/drive/batch/folders");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/drive/batch/files");
    expect(fetchMock.mock.calls[0][1].headers["X-Jiange-User-Id"]).toBe("42");
    expect(fetchMock.mock.calls[1][1].headers["X-Jiange-User-Id"]).toBe("42");
  });
});
