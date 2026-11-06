import { afterEach, describe, expect, it, vi } from "vitest";
import { peekStarter, stageStarter, takeStarter } from "./pendingStarter";

afterEach(() => vi.unstubAllGlobals());
describe("pending starter content", () => {
  it("isolates users and documents and consumes each item only once", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { setItem: (k: string, v: string) => storage.set(k, v), getItem: (k: string) => storage.get(k) ?? null, removeItem: (k: string) => storage.delete(k) });
    expect(stageStarter(1, 11, "# 第一篇")).toBe(true);
    expect(stageStarter(2, 11, "# 第二篇")).toBe(true);
    expect(peekStarter(1, 11)?.markdown).toBe("# 第一篇");
    expect(takeStarter(1, 11)?.markdown).toBe("# 第一篇");
    expect(takeStarter(1, 11)).toBeUndefined();
    expect(takeStarter(2, 11)?.markdown).toBe("# 第二篇");
  });
  it("restores a staged import from session storage after module reload", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { setItem: (k: string, v: string) => storage.set(k, v), getItem: (k: string) => storage.get(k) ?? null, removeItem: (k: string) => storage.delete(k) });
    stageStarter(7, 71, "# 待恢复");
    vi.resetModules();
    const fresh = await import("./pendingStarter");
    expect(fresh.peekStarter(7, 71)).toEqual({ markdown: "# 待恢复", persistent: true });
    expect(fresh.peekStarter(8, 71)).toBeUndefined();
    fresh.takeStarter(7, 71);
  });
  it("keeps a volatile fallback and reports storage failure", () => {
    vi.stubGlobal("sessionStorage", { setItem: () => { throw new Error("quota"); }, getItem: () => null, removeItem: () => {} });
    expect(stageStarter(3, 99, "内容")).toBe(false);
    expect(peekStarter(3, 99)).toEqual({ markdown: "内容", persistent: false });
    takeStarter(3, 99);
  });
});
