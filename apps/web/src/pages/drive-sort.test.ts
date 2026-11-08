import { describe, expect, it } from "vitest";
import type { DriveEntry } from "@/lib/api";
import { ownRootFolders, sortDriveFolders } from "./drive-sort";

const entry = (id: number, title: string, createdAt: string | undefined, updatedAt: string): DriveEntry => ({ id, workspaceId: 1, parentId: null, kind: "folder", title, role: "manage", revision: 1, createdAt, updatedAt });
const folders = [entry(1, "项目10", "2026-01-01", "2026-03-01"), entry(2, "项目2", "2026-02-01", "2026-01-01"), entry(3, "归档", undefined, "2026-02-01")];

describe("folder sorting", () => {
  it("orders creation and modification dates in both directions and keeps missing dates last", () => {
    expect(sortDriveFolders(folders, "created", "asc").map((e) => e.id)).toEqual([1, 2, 3]);
    expect(sortDriveFolders(folders, "created", "desc").map((e) => e.id)).toEqual([2, 1, 3]);
    expect(sortDriveFolders(folders, "updated", "desc").map((e) => e.id)).toEqual([1, 3, 2]);
  });
  it("supports natural name order without mutating the input", () => {
    const asc = sortDriveFolders(folders, "name", "asc");
    const desc = sortDriveFolders(folders, "name", "desc");
    expect(asc.findIndex((e) => e.id === 2)).toBeLessThan(asc.findIndex((e) => e.id === 1));
    expect(desc.findIndex((e) => e.id === 2)).toBeGreaterThan(desc.findIndex((e) => e.id === 1));
    expect(folders.map((e) => e.id)).toEqual([1, 2, 3]);
  });
  it("shows only this user's shared roots in the all-folders rule", () => {
    const mine = { ...folders[0], creatorId: 7 };
    const sharedMine = { ...folders[1], creatorId: 7 };
    const sharedOther = { ...folders[2], creatorId: 8 };
    expect(ownRootFolders([mine], [sharedMine, sharedOther], 7, true, "").map((e) => e.id)).toEqual([1, 2]);
    expect(ownRootFolders([mine], [sharedMine, sharedOther], 7, false, "").map((e) => e.id)).toEqual([1]);
    expect(ownRootFolders([mine], [sharedMine, sharedOther], 7, true, "项目2").map((e) => e.id)).toEqual([2]);
  });
});
