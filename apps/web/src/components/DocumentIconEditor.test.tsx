import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { ApiError, docsApi, type DocMeta } from "@/lib/api";
import { DocumentGlyph, displayDocumentIcon } from "./DocumentGlyph";
import { changeDocumentIcon, DocumentIconEditor, iconErrorMessage, iconVersion } from "./DocumentIconEditor";
import { publishDocumentIcon } from "./documentIconCache";

const doc: DocMeta = { id: 7, workspaceId: 1, parentId: null, title: "示例", icon: "", creatorId: 1, creatorName: "示例", createdAt: "", updatedAt: "", role: "edit" };

describe("document icons", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders a real text glyph and falls back for unsafe legacy values", () => {
    expect(displayDocumentIcon("👩‍💻")).toBe("👩‍💻");
    expect(displayDocumentIcon("<img>")).toBeUndefined();
    expect(displayDocumentIcon("a/b")).toBeUndefined();
    expect(renderToStaticMarkup(<DocumentGlyph icon="📌" fallback={<i>fallback</i>} />)).toContain("📌");
    expect(renderToStaticMarkup(<DocumentGlyph icon="<img>" fallback={<i>fallback</i>} />)).toContain("fallback");
  });

  it("only offers the editor to an authorized editable document", () => {
    const base = { id: 7, userId: 1, onUpdated: () => {}, onRevalidate: () => {}, children: <p>正文</p> };
    expect(renderToStaticMarkup(<DocumentIconEditor {...base} enabled icon="" />)).toContain("添加图标");
    const readonly = renderToStaticMarkup(<DocumentIconEditor {...base} enabled={false} icon="📌" />);
    expect(readonly).toContain("📌");
    expect(readonly).not.toContain("更换文档图标");
    expect(readonly).not.toContain("添加图标");
  });

  it("verifies the latest role and exact revision before updating", async () => {
    const write = vi.fn(async () => ({ icon: "📌", revision: 3 }));
    const getIcon = vi.fn().mockResolvedValueOnce({ icon: "😀", revision: 2 }).mockResolvedValueOnce({ icon: "📌", revision: 3 });
    const result = await changeDocumentIcon(7, { icon: "😀", revision: 2 }, "📌", async () => doc, getIcon, write, () => true);
    expect(write).toHaveBeenCalledWith("📌", 2);
    expect(result).toEqual({ icon: "📌", revision: 3 });
  });

  it("uses a newer authoritative icon instead of a late write response", async () => {
    const getIcon = vi.fn().mockResolvedValueOnce({ icon: "😀", revision: 2 }).mockResolvedValueOnce({ icon: "🚀", revision: 4 });
    const result = await changeDocumentIcon(7, { icon: "😀", revision: 2 }, "📌", async () => doc, getIcon, async () => ({ icon: "📌", revision: 3 }), () => true);
    expect(result).toEqual({ icon: "🚀", revision: 4 });
  });

  it("does not write after a role loss, navigation, or concurrent update", async () => {
    const write = vi.fn(async () => ({ icon: "📌", revision: 3 }));
    await expect(changeDocumentIcon(7, { icon: "😀", revision: 2 }, "📌", async () => ({ ...doc, role: "view" }), async () => ({ icon: "😀", revision: 2 }), write, () => true)).rejects.toMatchObject({ status: 403 });
    await expect(changeDocumentIcon(7, { icon: "😀", revision: 2 }, "📌", async () => doc, async () => ({ icon: "😀", revision: 3 }), write, () => true)).rejects.toMatchObject({ status: 409 });
    await expect(changeDocumentIcon(7, { icon: "😀", revision: 2 }, "📌", async () => doc, async () => ({ icon: "😀", revision: 2 }), write, () => false)).rejects.toThrow("页面状态已变化");
    expect(write).not.toHaveBeenCalled();
  });

  it("handles a committed 204 only after revalidating access and the stored value", async () => {
    const getDoc = vi.fn().mockResolvedValueOnce(doc).mockResolvedValueOnce({ ...doc, role: "view" });
    const getIcon = vi.fn().mockResolvedValue({ icon: "😀", revision: 2 });
    const result = await changeDocumentIcon(7, { icon: "😀", revision: 2 }, "📌", getDoc, getIcon, async () => undefined, () => true);
    expect(result).toBeUndefined();
    expect(getIcon).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid revisions and does not render legacy data as markup", () => {
    expect(iconVersion({ icon: "", revision: -1 })).toBeUndefined();
    expect(iconVersion({ icon: "", revision: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
    expect(iconVersion({ icon: "legacy/invalid", revision: 0 })).toEqual({ icon: "legacy/invalid", revision: 0 });
    expect(iconErrorMessage(new ApiError(409, "icon_conflict", ""))).toContain("其他人");
    expect(iconErrorMessage(new TypeError("offline"))).toContain("尚未确认");
  });

  it("sends the intended icon and observed revision", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => { calls.push(init); return new Response(JSON.stringify({ icon: "📌", revision: 2 }), { status: 200 }); });
    await docsApi.setIcon(7, "📌", 1);
    expect(JSON.parse(String(calls[0].body))).toEqual({ icon: "📌", expectedRevision: 1 });
  });

  it("does not let an older metadata request overwrite a confirmed icon", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = ["doc", 7, 1] as const;
    qc.setQueryData(key, doc);
    let release!: (value: DocMeta) => void;
    const old = new Promise<DocMeta>((resolve) => { release = resolve; });
    const pending = qc.fetchQuery({ queryKey: key, queryFn: () => old }).catch(() => undefined);
    await publishDocumentIcon(qc, key, "📌", () => true);
    release(doc);
    await pending;
    expect(qc.getQueryData<DocMeta>(key)?.icon).toBe("📌");
    qc.clear();
  });

  it("does not publish after the account or document changes during cancellation", async () => {
    const qc = new QueryClient();
    const key = ["doc", 7, 1] as const;
    qc.setQueryData(key, doc);
    await publishDocumentIcon(qc, key, "📌", () => false);
    expect(qc.getQueryData<DocMeta>(key)?.icon).toBe("");
    qc.clear();
  });
});
