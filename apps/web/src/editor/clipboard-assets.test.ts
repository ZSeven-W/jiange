import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { ClipBlock } from "./model";
import { copyClipboardAssetsWithRetry, planClipboardAssets, remapClipboardAssets } from "./clipboard-assets";

const source = { origin: "https://jiange.test", docId: 3 };
const blocks: ClipBlock[] = [
  { type: "image", source, props: { fileId: "7", name: "图" }, chars: [] },
  { type: "file", source, props: { fileId: "9", name: "附件" }, chars: [] },
  { type: "flowchart", source, props: { "fc.n.one": JSON.stringify({ shape: "image", fileId: 7, x: 1 }), "fc.n.other": JSON.stringify({ shape: "rect", text: "节点" }) }, chars: [] },
];

describe("clipboard attachment provenance", () => {
  it("deduplicates image, file and flowchart references and remaps all copies", () => {
    const plan = planClipboardAssets(blocks, source.origin);
    expect(plan).toEqual({ ok: true, assets: { sourceDocId: 3, fileIds: [7, 9] } });
    if (!plan.ok || !plan.assets) throw new Error("missing assets");
    const result = remapClipboardAssets(blocks, plan.assets, { "7": 70, "9": 90 }, 4)!;
    expect(result[0].props.fileId).toBe("70");
    expect(result[1].props.fileId).toBe("90");
    expect(JSON.parse(result[2].props["fc.n.one"])).toEqual({ shape: "image", fileId: 70, x: 1 });
    expect(blocks[0].props.fileId).toBe("7");
  });
  it("refuses missing, foreign, mixed or malformed provenance", () => {
    expect(planClipboardAssets([{ ...blocks[0], source: undefined }], source.origin)).toMatchObject({ ok: false });
    expect(planClipboardAssets(blocks, "https://other.test")).toMatchObject({ ok: false });
    expect(planClipboardAssets([blocks[0], { ...blocks[1], source: { ...source, docId: 8 } }], source.origin)).toMatchObject({ ok: false });
    expect(planClipboardAssets([{ ...blocks[0], props: { fileId: "01" } }], source.origin)).toMatchObject({ ok: false });
    expect(planClipboardAssets([{ type: "flowchart", source, props: { "fc.n.bad": "{" }, chars: [] }], source.origin)).toMatchObject({ ok: false });
  });
  it("rejects incomplete, duplicated or unsafe mappings", () => {
    const assets = { sourceDocId: 3, fileIds: [7, 9] };
    expect(remapClipboardAssets(blocks, assets, { "7": 70 }, 4)).toBeNull();
    expect(remapClipboardAssets(blocks, assets, { "7": 70, "9": 70 }, 4)).toBeNull();
    expect(remapClipboardAssets(blocks, assets, { "7": 7, "9": 90 }, 4)).toBeNull();
    expect(remapClipboardAssets(blocks, assets, { "7": 7, "9": 9 }, 3)).not.toBeNull();
  });
  it("reuses the same request ID after an unknown response and rejects stale paste state", async () => {
    const assets = { sourceDocId: 3, fileIds: [7, 9] }, signal = new AbortController().signal;
    const copy = vi.fn().mockRejectedValueOnce(new Error("network lost")).mockResolvedValueOnce({ mapping: { "7": 70, "9": 90 } });
    const result = await copyClipboardAssetsWithRetry(copy, blocks, assets, "0123456789abcdef0123456789abcdef", 4, signal, () => true, 20);
    expect(result[0].props.fileId).toBe("70");
    expect(copy).toHaveBeenCalledTimes(2);
    expect(copy.mock.calls[0][2]).toBe(copy.mock.calls[1][2]);
    const denied = vi.fn().mockRejectedValue(new ApiError(403, "forbidden", "无权复制"));
    await expect(copyClipboardAssetsWithRetry(denied, blocks, assets, "a".repeat(32), 4, signal, () => true, 20)).rejects.toThrow("无权复制");
    expect(denied).toHaveBeenCalledTimes(1);
    let current = true;
    const changed = vi.fn(async () => { current = false; return { mapping: { "7": 70, "9": 90 } }; });
    await expect(copyClipboardAssetsWithRetry(changed, blocks, assets, "b".repeat(32), 4, signal, () => current, 20)).rejects.toThrow("paste changed");
  });
});
