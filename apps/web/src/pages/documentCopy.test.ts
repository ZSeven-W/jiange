import { describe, expect, it } from "vitest";
import { ApiError, type DocMeta } from "@/lib/api";
import { canCopyDocument, copyErrorMessage } from "./documentCopy";

const doc: DocMeta = { id: 1, workspaceId: 1, parentId: null, title: "文档", icon: "", creatorId: 1, creatorName: "成员", createdAt: "", updatedAt: "", role: "view" };

describe("document copy access", () => {
  it("permits explicit roles unless the owner has disabled copying", () => {
    expect(canCopyDocument(undefined)).toBe(false);
    expect(canCopyDocument({ ...doc, role: undefined })).toBe(false);
    for (const role of ["view", "edit", "manage"] as const) expect(canCopyDocument({ ...doc, role })).toBe(true);
    expect(canCopyDocument({ ...doc, role: "view", copyProtected: true })).toBe(false);
    expect(canCopyDocument({ ...doc, role: "edit", copyProtected: true })).toBe(false);
    expect(canCopyDocument({ ...doc, role: "manage", copyProtected: true })).toBe(true);
  });

  it("shows an actionable server error and a safe fallback for network failures", () => {
    expect(copyErrorMessage(new ApiError(409, "invalid_attachment", "附件不可用，无法创建副本"))).toBe("附件不可用，无法创建副本");
    expect(copyErrorMessage(new TypeError("Failed to fetch"))).toContain("网络");
  });
});
