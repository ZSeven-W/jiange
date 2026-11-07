import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocMeta } from "@/lib/api";
import { changeDocumentCover, coverImageURL, parseDocumentCover } from "@/lib/documentCoverApi";
import { PublicDocumentCover, scheduleCoverPreviewRetry } from "./DocumentCover";

const doc: DocMeta = { id: 7, workspaceId: 1, parentId: null, title: "示例", icon: "", creatorId: 1, creatorName: "示例", createdAt: "", updatedAt: "", role: "edit" };
const initial = { kind: "builtin", asset: "misty-lake", position: 0.5, revision: 2 } as const;

describe("document cover", () => {
  afterEach(() => vi.useRealTimers());
  it("validates metadata and never converts an arbitrary asset into a URL", () => {
    expect(parseDocumentCover({ kind: "none", position: 0.5, revision: 0 })).toEqual({ kind: "none", position: 0.5, revision: 0 });
    expect(parseDocumentCover({ kind: "file", fileId: 2, position: 1, revision: 3 })).toEqual({ kind: "file", fileId: 2, position: 1, revision: 3 });
    expect(parseDocumentCover({ kind: "file", fileId: -1, position: 1, revision: 3 })).toBeUndefined();
    expect(parseDocumentCover({ kind: "none", position: 1.1, revision: 3 })).toBeUndefined();
    expect(parseDocumentCover({ kind: "none", position: 0, revision: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
    expect(coverImageURL({ ...initial, asset: "https://evil.example/a" }, 7)).toBeUndefined();
    expect(coverImageURL(initial, 7)).toBe("/covers/misty-lake.webp");
    expect(coverImageURL({ kind: "file", fileId: 2, position: 0.5, revision: 3 }, 7)).toBe("/api/docs/7/cover/image?revision=3");
    expect(coverImageURL({ kind: "file", fileId: 2, position: 0.5, revision: 3 }, undefined, "a/b")).toBe("/api/public/a%2Fb/cover/image?revision=3");
  });

  it("shows only a valid controlled cover in a public document", () => {
    const file = renderToStaticMarkup(<PublicDocumentCover value={{ kind: "file", fileId: 4, position: 0.25, revision: 3 }} token="a/b"/>);
    expect(file).toContain("/api/public/a%2Fb/cover/image?revision=3");
    expect(file).toContain("center 25%");
    expect(renderToStaticMarkup(<PublicDocumentCover value={{ ...initial, asset: "https://evil.example/a" }} token="x"/>)).toBe("");
    expect(renderToStaticMarkup(<PublicDocumentCover value={initial} token="x" allowPrint={false}/>)).toContain('data-document-print-restricted="true"');
  });

  it("verifies role and revision before writing and returns the latest state", async () => {
    const getCover = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce({ kind: "none", position: 0.5, revision: 3 });
    const write = vi.fn(async () => ({ kind: "none", position: 0.5, revision: 3 }));
    const result = await changeDocumentCover(7, initial, { kind: "none", position: 0.5 }, () => true, async () => doc, getCover, write);
    expect(write).toHaveBeenCalledWith({ kind: "none", position: 0.5 }, 2);
    expect(result).toEqual({ kind: "none", position: 0.5, revision: 3 });
  });

  it("does not overwrite a changed cover or a document the user cannot edit", async () => {
    const write = vi.fn(async () => undefined);
    await expect(changeDocumentCover(7, initial, { kind: "none", position: 0.5 }, () => true, async () => ({ ...doc, role: "view" }), async () => initial, write)).rejects.toMatchObject({ status: 403 });
    await expect(changeDocumentCover(7, initial, { kind: "none", position: 0.5 }, () => true, async () => doc, async () => ({ ...initial, revision: 3 }), write)).rejects.toMatchObject({ status: 409 });
    await expect(changeDocumentCover(7, initial, { kind: "none", position: 0.5 }, () => true, async () => doc, async () => ({ ...initial, position: 0.1 }), write)).rejects.toMatchObject({ status: 409 });
    expect(write).not.toHaveBeenCalled();
  });

  it("does not apply an old response after navigation or a committed 204 after permission loss", async () => {
    let current = true;
    const write = vi.fn(async () => { current = false; return { kind: "none", position: 0.5, revision: 3 }; });
    expect(await changeDocumentCover(7, initial, { kind: "none", position: 0.5 }, () => current, async () => doc, async () => initial, write)).toBeUndefined();
    const getDoc = vi.fn().mockResolvedValueOnce(doc).mockResolvedValueOnce({ ...doc, role: "view" });
    expect(await changeDocumentCover(7, initial, { kind: "none", position: 0.5 }, () => true, getDoc, async () => initial, async () => undefined)).toBeUndefined();
  });

  it("uses a newer authoritative cover instead of a late write response", async () => {
    const newer = { kind: "file", fileId: 4, position: 0.75, revision: 4 } as const;
    const getCover = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(newer);
    const result = await changeDocumentCover(7, initial, { kind: "none", position: 0.5 }, () => true, async () => doc, getCover, async () => ({ kind: "none", position: 0.5, revision: 3 }));
    expect(result).toEqual(newer);
  });

  it("retries temporary preview failures with a limit and cancels pending retries on unmount", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const cancel = scheduleCoverPreviewRetry(0, retry);
    vi.advanceTimersByTime(499);
    expect(retry).not.toHaveBeenCalled();
    cancel();
    vi.advanceTimersByTime(1);
    expect(retry).not.toHaveBeenCalled();
    scheduleCoverPreviewRetry(2, retry);
    vi.advanceTimersByTime(1999);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);
    scheduleCoverPreviewRetry(3, retry);
    vi.advanceTimersByTime(10000);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
