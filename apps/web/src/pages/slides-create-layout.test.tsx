import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { slidesApi } from "@/lib/api";
import { SlideCreateLayoutPicker, slideCreatePickerPosition } from "./slides-create-layout";

afterEach(() => vi.unstubAllGlobals());

describe("new slide layout", () => {
  it("shows only layouts that the editor can actually create", () => {
    const html = renderToStaticMarkup(<SlideCreateLayoutPicker onSelect={() => {}} />);
    for (const name of ["空白", "标题", "标题与正文", "标题与两栏内容"]) expect(html).toContain(`使用${name}布局新建`);
    expect(html).not.toContain("标题与三栏内容");
  });
  it("keeps the picker inside short and narrow viewports", () => {
    const short = slideCreatePickerPosition({ left: 45, top: 68, bottom: 100 }, 320, 200);
    expect(short.left).toBeGreaterThanOrEqual(12);
    expect(short.left + short.width).toBeLessThanOrEqual(308);
    expect(short.top + short.maxHeight).toBeLessThanOrEqual(188);
    const normal = slideCreatePickerPosition({ left: 65, top: 68, bottom: 100 }, 390, 844);
    expect(normal).toEqual({ left: 12, top: 108, width: 366, maxHeight: 724 });
  });
  it("keeps the legacy default request and sends modern layout atomically", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ id: 3 }), { status: 201 })));
    vi.stubGlobal("fetch", fetchMock);
    await slidesApi.insertPage(1, 2, 3, 4);
    await slidesApi.insertPage(1, 2, 3, 4, "title");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ afterPageId: 3, expectedRevision: 4 });
    expect(fetchMock.mock.calls[0][1].headers["X-Jiange-Slides-Version"]).toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ afterPageId: 3, expectedRevision: 4, layout: "title" });
    expect(fetchMock.mock.calls[1][1].headers["X-Jiange-Slides-Version"]).toBe("4");
  });
  it("does not retry with a different layout if an old server rejects the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "bad_request" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(slidesApi.insertPage(1, 2, 3, 4, "title")).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
