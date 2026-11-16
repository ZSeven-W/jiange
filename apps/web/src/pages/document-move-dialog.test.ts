import { describe, expect, it } from "vitest";
import type { DocMeta, DriveEntry } from "@/lib/api";
import { resolveMoveSource } from "./document-move-dialog";

const doc: DocMeta = { id: 7, workspaceId: 3, parentId: null, title: "文档", icon: "", creatorId: 1, creatorName: "用户", createdAt: "2026-01-01", updatedAt: "2026-01-01", role: "manage", kind: "doc", driveRevision: 2 };
const root: DriveEntry = { id: 7, workspaceId: 3, parentId: null, title: "文档", kind: "doc", role: "manage", revision: 2, personal: true, updatedAt: "2026-01-01" };

describe("document move source", () => {
  it("uses the visible root to determine scope", () => {
    expect(resolveMoveSource(doc, [], [root], [])?.personal).toBe(true);
    expect(resolveMoveSource(doc, [], [], [root])?.personal).toBe(false);
    const ancestor = { ...doc, id: 4, parentId: null, title: "目录", kind: "folder" as const };
    const nested = { ...doc, parentId: 4 };
    expect(resolveMoveSource(nested, [ancestor], [{ ...root, id: 4, kind: "folder" }], [])?.personal).toBe(true);
  });

  it("does not infer a scope from missing or ambiguous ancestors", () => {
    expect(resolveMoveSource({ ...doc, parentId: 4 }, [], [root], [])).toBeNull();
    expect(resolveMoveSource(doc, [], [root], [root])).toBeNull();
    expect(resolveMoveSource({ ...doc, role: "view" }, [], [root], [])).toBeNull();
    expect(resolveMoveSource({ ...doc, driveRevision: -1 }, [], [root], [])).toBeNull();
    expect(resolveMoveSource(doc, [], [{ ...root, workspaceId: 9 }], [])).toBeNull();
    const parent = { ...doc, id: 4, parentId: 5, kind: "folder" as const };
    const brokenRoot = { ...doc, id: 3, parentId: null, kind: "folder" as const };
    expect(resolveMoveSource({ ...doc, parentId: 4 }, [brokenRoot, parent], [{ ...root, id: 3, kind: "folder" }], [])).toBeNull();
  });
});
