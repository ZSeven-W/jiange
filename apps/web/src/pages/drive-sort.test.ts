import { describe, expect, it } from "vitest";
import type { DriveEntry } from "@/lib/api";
import { formatDriveTime, ownRootFolders, sortDriveDocuments, sortDriveFolders } from "./drive-sort";

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
  it("sorts documents by the selected column independently", () => {
    const documents = folders.map((item) => ({ ...item, kind: "doc" }));
    expect(sortDriveDocuments(documents, "updated", "asc").map((e) => e.id)).toEqual([2, 3, 1]);
    expect(sortDriveDocuments(documents, "created", "desc").map((e) => e.id)).toEqual([2, 1, 3]);
  });
  it("formats today, yesterday, older and invalid dates", () => {
    const now = new Date(2026, 10, 8, 12, 30);
    expect(formatDriveTime(new Date(2026, 10, 8, 9, 5).toISOString(), now)).toBe("今天 09:05");
    expect(formatDriveTime(new Date(2026, 10, 7, 23, 9).toISOString(), now)).toBe("昨天 23:09");
    expect(formatDriveTime(new Date(2023, 9, 15, 12).toISOString(), now)).toBe("2023年10月15日");
    expect(formatDriveTime("not-a-date", now)).toBe("");
  });
});
