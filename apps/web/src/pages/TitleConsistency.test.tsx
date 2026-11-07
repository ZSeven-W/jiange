import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createTitleConsistencyCheck, TitleConsistency } from "./TitleConsistency";

const good = { directoryTitle: "目录名称", documentTitle: "正文标题", head: 14, differs: true };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("title consistency inspection", () => {
  it("only shows a loading state until the user-requested snapshot is received", () => {
    const html = renderToStaticMarkup(<TitleConsistency id={17} allowCopy onClose={() => {}} onAccessDenied={() => {}} />);
    expect(html).toContain("正在检查");
    expect(html).not.toContain(good.directoryTitle);
    expect(html).not.toContain(good.documentTitle);
  });

  it("requests a private fresh snapshot and preserves both original values", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(response(good));
    const update = vi.fn();
    const check = createTitleConsistencyCheck(17, update, vi.fn(), send);
    await check.run();
    expect(send).toHaveBeenCalledWith("/api/docs/17/title-consistency", expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal) }));
    expect(update).toHaveBeenLastCalledWith({ status: "ready", snapshot: good });
  });

  it("does not display obsolete results after a second check or disposal", async () => {
    let resolveFirst!: (response: Response) => void;
    const send = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockResolvedValueOnce(response({ ...good, directoryTitle: "新名称" }));
    const update = vi.fn();
    const check = createTitleConsistencyCheck(17, update, vi.fn(), send);
    const first = check.run();
    await check.run();
    resolveFirst(response(good));
    await first;
    expect(update).toHaveBeenLastCalledWith({ status: "ready", snapshot: { ...good, directoryTitle: "新名称" } });

    let resolveLater!: (response: Response) => void;
    const lateSend = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { resolveLater = resolve; }));
    const laterUpdate = vi.fn();
    const later = createTitleConsistencyCheck(17, laterUpdate, vi.fn(), lateSend);
    const pending = later.run();
    later.dispose();
    resolveLater(response(good));
    await pending;
    expect(laterUpdate).toHaveBeenCalledTimes(1);
    expect(laterUpdate).toHaveBeenLastCalledWith({ status: "loading" });
  });

  it("clears a visible snapshot and rejects a late response when backgrounded", async () => {
    let resolveLate!: (response: Response) => void;
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(good)).mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve; }));
    const update = vi.fn();
    const check = createTitleConsistencyCheck(17, update, vi.fn(), send);
    await check.run();
    const pending = check.run();
    check.pause();
    resolveLate(response(good));
    await pending;
    expect(update).toHaveBeenLastCalledWith({ status: "loading" });
  });

  it.each([401, 403, 404])("clears a result and requests permission revalidation on HTTP %s", async (status) => {
    const update = vi.fn();
    const denied = vi.fn();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(good)).mockResolvedValueOnce(response({}, status));
    const check = createTitleConsistencyCheck(17, update, denied, send);
    await check.run();
    await check.run();
    expect(update).toHaveBeenLastCalledWith({ status: "denied" });
    expect(denied).toHaveBeenCalledOnce();
  });

  it("does not expose malformed, contradictory or failed results", async () => {
    for (const res of [response({}, 503), response({ ...good, differs: false }), response({ ...good, head: Number.MAX_SAFE_INTEGER + 1 })]) {
      const update = vi.fn();
      const check = createTitleConsistencyCheck(17, update, vi.fn(), vi.fn<typeof fetch>().mockResolvedValue(res));
      await check.run();
      expect(update).toHaveBeenLastCalledWith({ status: "error" });
    }
  });
});
