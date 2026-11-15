import { describe, expect, it } from "vitest";
import type { DocMeta } from "@/lib/api";
import { canDuplicateHomeDocument, sameTrashSnapshot } from "./home-file-actions";
const doc: DocMeta = { id: 1, kind: "doc", title: "计划", icon: "", workspaceId: 1, parentId: null, creatorId: 1, creatorName: "用户", createdAt: "2026-01-01", updatedAt: "2026-01-02", role: "manage", driveRevision: 3 };
describe("home file actions", () => {
  it("only allows supported kinds and valid download permissions for duplication", () => {
    expect(canDuplicateHomeDocument(doc)).toBe(true);
    expect(canDuplicateHomeDocument({ ...doc, kind: "slides" })).toBe(true);
    expect(canDuplicateHomeDocument({ ...doc, kind: "slides", permissionsRevision: 0 })).toBe(true);
    expect(canDuplicateHomeDocument({ ...doc, kind: "slides", permissionsRevision: 1 })).toBe(false);
    expect(canDuplicateHomeDocument({ ...doc, kind: "slides", role: "view", permissionsRevision: 0, copyProtected: true })).toBe(false);
    expect(canDuplicateHomeDocument({ ...doc, kind: "base" })).toBe(false);
    expect(canDuplicateHomeDocument({ ...doc, role: "view", copyProtected: true })).toBe(false);
  });
  it("rejects stale or incomplete deletion confirmations", () => {
    expect(sameTrashSnapshot(doc, { ...doc })).toBe(true);
    for (const changed of [{ driveRevision: 4 }, { updatedAt: "2026-01-03" }, { title: "新标题" }, { role: "view" as const }, { parentId: 5 }]) expect(sameTrashSnapshot(doc, { ...doc, ...changed })).toBe(false);
    expect(sameTrashSnapshot({ ...doc, driveRevision: undefined }, { ...doc, driveRevision: undefined })).toBe(false);
    expect(sameTrashSnapshot({ ...doc, updatedAt: "" }, { ...doc, updatedAt: "" })).toBe(false);
  });
});
