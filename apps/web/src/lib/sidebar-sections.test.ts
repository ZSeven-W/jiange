import { describe, expect, it, vi } from "vitest";
import { decodeSidebarSection, readSidebarSection, sidebarSectionKey, writeSidebarSection } from "./sidebar-sections";

describe("sidebar section preferences", () => {
  it("keeps sections and accounts independent", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeSidebarSection(storage, 1, "pinned", false);
    expect(readSidebarSection(storage, 1, "pinned")).toBe(false);
    expect(readSidebarSection(storage, 1, "documents")).toBe(true);
    expect(readSidebarSection(storage, 2, "pinned")).toBe(true);
    writeSidebarSection(storage, 1, "documents", false);
    expect(values.get(sidebarSectionKey(1, "documents"))).toBe("collapsed");
    expect(decodeSidebarSection("invalid")).toBe(true);
  });

  it("falls back to expanded when storage is unavailable", () => {
    const storage = { getItem: vi.fn(() => { throw new Error("denied"); }), setItem: vi.fn(() => { throw new Error("denied"); }) };
    expect(readSidebarSection(storage, 1, "pinned")).toBe(true);
    expect(() => writeSidebarSection(storage, 1, "documents", false)).not.toThrow();
    expect(readSidebarSection(storage, 0, "documents")).toBe(true);
    writeSidebarSection(storage, NaN, "pinned", false);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });
});
