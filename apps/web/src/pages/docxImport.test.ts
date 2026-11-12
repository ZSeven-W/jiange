import { afterEach, describe, expect, it, vi } from "vitest";
import { Doc, ROOT, Tx } from "@jiange/collab";
import { bodyBlocks } from "@/editor/model";
import type { MdBlock } from "@/lib/markdown";
import { fetchDocxImages } from "./docxImages";
import { peekStarter, stageStarter, takeStarter } from "./pendingStarter";
import { insertStarterBlocks } from "./starterTemplateOps";

afterEach(() => vi.unstubAllGlobals());

const seeds: MdBlock[] = [
  { type: "h1", text: "导入", props: {}, spans: [{ text: "导入", marks: {} }] },
  { type: "paragraph", text: "下划线", props: {}, spans: [{ text: "下划线", marks: { underline: "true", color: "#D83931" } }] },
];

describe("staged Word import", () => {
  it("persists parsed blocks next to the Markdown fallback and restores them after reload", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { setItem: (k: string, v: string) => storage.set(k, v), getItem: (k: string) => storage.get(k) ?? null, removeItem: (k: string) => storage.delete(k) });
    expect(stageStarter(5, 50, "# 导入\n\n下划线\n", seeds)).toBe(true);
    vi.resetModules();
    const fresh = await import("./pendingStarter");
    expect(fresh.peekStarter(5, 50)?.blocks).toEqual(seeds);
    fresh.takeStarter(5, 50);
    expect(storage.size).toBe(0);
  });

  it("ignores corrupt staged blocks and clears stale ones on re-stage", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { setItem: (k: string, v: string) => storage.set(k, v), getItem: (k: string) => storage.get(k) ?? null, removeItem: (k: string) => storage.delete(k) });
    stageStarter(6, 60, "x", seeds);
    stageStarter(6, 60, "y");
    expect([...storage.keys()]).toEqual(["jiange:starter:6:60"]);
    storage.set("jiange:starter:6:60:blocks", "{not json");
    vi.resetModules();
    const fresh = await import("./pendingStarter");
    expect(fresh.peekStarter(6, 60)).toEqual({ markdown: "y", persistent: true });
    takeStarter(6, 60);
    expect(peekStarter(6, 60)).toBeUndefined();
  });

  it("inserts staged blocks with their marks only into an empty document", () => {
    const doc = new Doc(1);
    const init = new Tx(doc);
    init.create("paragraph", null, ROOT);
    const tx = insertStarterBlocks(doc, seeds)!;
    expect(tx).not.toBeNull();
    const ids = bodyBlocks(doc);
    expect(doc.blockInfo(ids[0]).type).toBe("h1");
    expect(doc.richChars(ids[1])[0].marks).toMatchObject({ underline: "true", color: "#D83931" });
    expect(insertStarterBlocks(doc, seeds)).toBeNull();
  });
});

describe("Word export image loading", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
  it("fetches same-origin file URLs once per file and skips failures or unsupported formats", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/ok")) return new Response(png);
      if (url.endsWith("/svg")) return new Response("<svg/>");
      return new Response("", { status: 403 });
    };
    const images = await fetchDocxImages([
      { type: "image", props: { fileId: "ok" } }, { type: "image", props: { fileId: "ok" } },
      { type: "image", props: { fileId: "svg" } }, { type: "image", props: { fileId: "denied" } },
      { type: "image", props: { fileId: "../../etc" } }, { type: "paragraph", props: {} },
    ], fetcher);
    expect(calls).toEqual(["/api/files/ok", "/api/files/svg", "/api/files/denied"]);
    expect([...images.keys()]).toEqual(["ok"]);
    expect(images.get("ok")).toMatchObject({ contentType: "image/png", width: 2, height: 3 });
  });
});
