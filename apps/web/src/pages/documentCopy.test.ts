import { describe, expect, it } from "vitest";
import { ApiError, type DocMeta } from "@/lib/api";
import { canCopyContent, canCopyDocument, canDownloadDocument, copyErrorMessage, mayUseDownloadRecheck, pendingDocumentBackup } from "./documentCopy";

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

  it("enforces independent role thresholds for content and downloads", () => {
    const roles = ["view", "edit", "manage"] as const;
    for (const [index, role] of roles.entries()) {
      for (const [copyIndex, copyMinRole] of roles.entries()) {
        for (const [downloadIndex, downloadMinRole] of roles.entries()) {
          const meta = { ...doc, role, copyMinRole, downloadMinRole, permissionsRevision: 1, copyProtected: true };
          expect(canCopyContent(meta)).toBe(index >= copyIndex);
          expect(canDownloadDocument(meta)).toBe(index >= downloadIndex);
        }
      }
    }
  });

  it("retains the legacy boolean policy but rejects malformed split policies", () => {
    expect(canCopyContent({ ...doc, role: "edit", copyProtected: true })).toBe(false);
    expect(canDownloadDocument({ ...doc, role: "manage", copyProtected: true })).toBe(true);
    expect(canCopyContent({ ...doc, copyMinRole: "view" })).toBe(false);
    expect(canCopyContent({ ...doc, copyMinRole: "view", downloadMinRole: "view" })).toBe(false);
    expect(canDownloadDocument({ ...doc, copyMinRole: "view", downloadMinRole: "other" })).toBe(false);
    expect(canCopyContent({ ...doc, role: undefined, copyMinRole: "view", downloadMinRole: "view" })).toBe(false);
  });

  it("preserves pending edits without exporting a replica when access is unverified", () => {
    const ops = [{ id: 4, text: "我的未同步修改" }];
    expect(pendingDocumentBackup(1, 2, 3, ops)).toEqual({ version: 1, userId: 1, docId: 2, clientId: 3, state: null, ops });
  });

  it("requires a fresh download permission for the same document and unchanged cache", () => {
    const original = { ...doc, downloadMinRole: "view", copyMinRole: "view", permissionsRevision: 1 };
    expect(mayUseDownloadRecheck(1, original, original, original)).toBe(true);
    expect(mayUseDownloadRecheck(1, original, { ...original }, original)).toBe(false);
    expect(mayUseDownloadRecheck(1, original, original, { ...original, id: 2 })).toBe(false);
    expect(mayUseDownloadRecheck(1, original, original, { ...original, downloadMinRole: "manage", permissionsRevision: 2 })).toBe(false);
    expect(mayUseDownloadRecheck(1, original, original, { ...original, role: undefined })).toBe(false);
  });
});
