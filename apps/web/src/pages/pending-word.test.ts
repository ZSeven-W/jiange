import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPendingWord, loadPendingWord, stagePendingWord } from "./pending-word";

afterEach(() => vi.unstubAllGlobals());

describe("pending Word file", () => {
  it("keeps an account-scoped volatile copy when persistent storage is unavailable", async () => {
    const entries = new Map<string, string>();
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => entries.set(k, v), removeItem: (k: string) => entries.delete(k) });
    const file = new File(["example"], "项目.docx");
    expect((await stagePendingWord(101, 201, file)).persistent).toBe(false);
    expect((await loadPendingWord(101, 201))?.file).toBe(file);
    expect(await loadPendingWord(102, 201)).toBeNull();
    vi.resetModules();
    const fresh = await import("./pending-word");
    const lost = await fresh.loadPendingWord(101, 201);
    expect(lost).toEqual({ name: "项目.docx", persistent: false, missing: true });
    await fresh.clearPendingWord(101, 201, lost!);
    expect(await fresh.loadPendingWord(101, 201)).toBeNull();
    await clearPendingWord(101, 201, { file, name: file.name, persistent: false });
  });
});
