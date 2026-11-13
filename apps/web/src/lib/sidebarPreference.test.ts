import { describe, expect, it, vi } from "vitest";
import { decodeSidebarPreference, readSidebarPreference, sidebarPreferenceKey, writeSidebarPreference } from "./sidebarPreference";

describe("document sidebar preference", () => {
  it("restores each account independently and defaults to expanded", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readSidebarPreference(storage, 1)).toBe(true);
    writeSidebarPreference(storage, 1, false);
    expect(readSidebarPreference(storage, 1)).toBe(false);
    expect(readSidebarPreference(storage, 2)).toBe(true);
    writeSidebarPreference(storage, 2, true);
    expect(values.get(sidebarPreferenceKey(1))).toBe("collapsed");
    expect(values.get(sidebarPreferenceKey(2))).toBe("expanded");
    expect(decodeSidebarPreference(null)).toBe(true);
    expect(decodeSidebarPreference("damaged")).toBe(true);
  });

  it("continues in memory if storage is denied or the account id is invalid", () => {
    const storage = { getItem: vi.fn(() => { throw new Error("denied"); }), setItem: vi.fn(() => { throw new Error("denied"); }) };
    expect(readSidebarPreference(storage, 1)).toBe(true);
    expect(() => writeSidebarPreference(storage, 1, false)).not.toThrow();
    expect(readSidebarPreference(null, 1)).toBe(true);
    expect(readSidebarPreference(storage, 0)).toBe(true);
    writeSidebarPreference(storage, NaN, false);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });
});
