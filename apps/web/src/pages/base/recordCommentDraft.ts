/** A tab-local, account- and record-scoped draft; never shared across accounts. */
export function recordCommentDraftKey(userId: number, baseId: number, recordId: number): string {
  if (![userId, baseId, recordId].every((id) => Number.isSafeInteger(id) && id > 0)) throw new Error("invalid comment draft identity");
  return `jiange:record-comment-draft:v1:${userId}:${baseId}:${recordId}`;
}

export function loadRecordCommentDraft(storage: Storage, userId: number, baseId: number, recordId: number): string {
  return storage.getItem(recordCommentDraftKey(userId, baseId, recordId)) ?? "";
}

export function saveRecordCommentDraft(storage: Storage, userId: number, baseId: number, recordId: number, text: string): void {
  const key = recordCommentDraftKey(userId, baseId, recordId);
  const revisionKey = `${key}:revision`;
  const revision = Number(storage.getItem(revisionKey) ?? "0");
  // A fresh token prevents an older in-flight send from clearing newer input,
  // even if the user later types exactly the same text.
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new Error("invalid comment draft revision");
  storage.setItem(revisionKey, String(revision + 1));
  if (text) storage.setItem(key, text); else storage.removeItem(key);
}

export function recordCommentDraftRevision(storage: Storage, userId: number, baseId: number, recordId: number): string | null {
  return storage.getItem(`${recordCommentDraftKey(userId, baseId, recordId)}:revision`);
}

export function clearRecordCommentDraftIfUnchanged(storage: Storage, userId: number, baseId: number, recordId: number, revision: string | null): boolean {
  if (recordCommentDraftRevision(storage, userId, baseId, recordId) !== revision) return false;
  saveRecordCommentDraft(storage, userId, baseId, recordId, "");
  return true;
}
