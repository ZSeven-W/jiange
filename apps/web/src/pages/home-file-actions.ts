import type { DocMeta } from "@/lib/api";
import { canCopyDocument } from "./document-copy";

/** The copy endpoint supports documents, presentations, and spreadsheets. */
export function canDuplicateHomeDocument(doc: DocMeta): boolean {
  if (!Number.isSafeInteger(doc.id) || doc.id <= 0 || (doc.kind !== "doc" && doc.kind !== "slides" && doc.kind !== "sheet")) return false;
  // Some legacy metadata includes the zero revision but omits both split
  // policy fields. The copy endpoint still rechecks the authoritative policy.
  const legacy = doc.copyMinRole === undefined && doc.downloadMinRole === undefined && doc.permissionsRevision === 0;
  return canCopyDocument(legacy ? { ...doc, permissionsRevision: undefined } : doc);
}
/** Reject a confirmation if the visible document changed while it was open. */
export function sameTrashSnapshot(before: DocMeta, after: DocMeta): boolean {
  return Number.isSafeInteger(before.id) && before.id > 0 && before.id === after.id && before.role === "manage" && after.role === "manage" &&
    Number.isSafeInteger(before.driveRevision) && (before.driveRevision as number) >= 0 && before.driveRevision === after.driveRevision &&
    typeof before.title === "string" && before.title === after.title && typeof before.updatedAt === "string" && Number.isFinite(Date.parse(before.updatedAt)) && before.updatedAt === after.updatedAt &&
    (before.parentId === null || Number.isSafeInteger(before.parentId) && before.parentId > 0) &&
    (before.kind === "doc" || before.kind === "base" || before.kind === "slides" || before.kind === "sheet" || before.kind === "file") && before.kind === after.kind && before.parentId === after.parentId;
}
