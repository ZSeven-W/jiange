import { describe, expect, it } from "vitest";
import type { DocMeta } from "@/lib/api";
import { slideTitleCheck } from "./SlideDeckTitle";
import { readSlideTitleDraft, writeSlideTitleDraft } from "./slides-title-recovery";

const meta: DocMeta = { id: 1, workspaceId: 1, parentId: null, title: "原名称", icon: "", creatorId: 1, creatorName: "", createdAt: "", updatedAt: "", role: "manage", kind: "slides", driveRevision: 3 };
const base = { title: "原名称", revision: 3 };

describe("slide deck title", () => {
  it("trims a valid title and rejects empty or oversized names", () => {
    expect(slideTitleCheck(" 新名称 ", base, meta, true)).toEqual({ ok: true, title: "新名称" });
    expect(slideTitleCheck(" ", base, meta, true).ok).toBe(false);
    expect(slideTitleCheck("😀".repeat(101), base, meta, true).ok).toBe(false);
    expect(slideTitleCheck("😀".repeat(100), base, meta, true).ok).toBe(true);
  });
  it("blocks stale versions, changed titles, permission loss and unchecked metadata", () => {
    for (const current of [{ ...meta, driveRevision: 4 }, { ...meta, title: "其他名称" }, { ...meta, role: "view" as const }, { ...meta, kind: "doc" as const }]) {
      expect(slideTitleCheck("新名称", base, current, true).ok).toBe(false);
    }
    expect(slideTitleCheck("新名称", base, meta, false).ok).toBe(false);
    expect(slideTitleCheck("编辑者名称", base, { ...meta, role: "edit" }, true).ok).toBe(true);
  });
  it("keeps drafts scoped to the account and does not replay an uncertain save", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
    writeSlideTitleDraft(storage, 1, 2, { value: "新名称", base, phase: "saving", error: "" });
    expect(readSlideTitleDraft(storage, 2, 2)).toBeNull();
    expect(readSlideTitleDraft(storage, 1, 3)).toBeNull();
    expect(readSlideTitleDraft(storage, 1, 2)).toMatchObject({ value: "新名称", phase: "unknown" });
    writeSlideTitleDraft(storage, 1, 2, null);
    expect(readSlideTitleDraft(storage, 1, 2)).toBeNull();
  });
});
