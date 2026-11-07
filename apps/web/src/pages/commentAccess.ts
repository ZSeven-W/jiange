import { canCopyContent, canDownloadDocument, type DocumentPermissions } from "./documentCopy";

/** Each verified access period gets an isolated cache namespace. */
let nextSession = 0;
export type CommentTarget = { doc: number; user: number; session: number };
export type SavedCommentDraft = { text: string; draft: { block: string; startChar: string; endChar: string; quote: string } | null; parentId?: number };

/** A read role is sufficient only when a verified server policy allows it.
 * Servers predating this policy only allow edit/manage, so missing policy is
 * interpreted conservatively. Anonymous public links never grant comments. */
export function canWriteComments(meta: { role?: string; commentMinRole?: unknown; permissionsRevision?: number } | undefined): boolean {
  if (!meta || (meta.role !== "view" && meta.role !== "edit" && meta.role !== "manage")) return false;
  if (meta.commentMinRole === undefined) return meta.role === "edit" || meta.role === "manage";
  if (!Number.isSafeInteger(meta.permissionsRevision) || meta.permissionsRevision! < 0) return false;
  if (meta.commentMinRole !== "view" && meta.commentMinRole !== "edit") return false;
  return meta.commentMinRole === "view" || meta.role === "edit" || meta.role === "manage";
}

/** Own comment text may be recovered, but protected document quotes may not be copied. */
export function redactCommentDraftQuote(value: SavedCommentDraft, allowQuote: boolean): SavedCommentDraft {
  return { ...value, draft: value.draft ? { ...value.draft, quote: allowQuote ? value.draft.quote : "" } : null };
}

export function mayExportCommentDraftData(meta: DocumentPermissions | undefined, metadataVerified: boolean, commentsAvailable: boolean): boolean {
  // Damaged raw storage can include both the user's text and a quoted document
  // selection. Never release unredacted bytes unless both permissions allow it.
  return metadataVerified && commentsAvailable && canCopyContent(meta) && canDownloadDocument(meta);
}

/** Keep an already authorized draft anchor across an in-flight policy check;
 * presentation and export must additionally require that check to finish. */
export function mayRetainCommentQuote(meta: DocumentPermissions | undefined, metadataVerified: boolean, commentsAvailable: boolean): boolean {
  return metadataVerified && commentsAvailable && canCopyContent(meta);
}

/** A pending request is immutable. Initial loading or a transient error must
 * not irreversibly redact its quote; only a verified denial can do that. */
export function mustRedactCommentAttemptQuote(meta: DocumentPermissions | undefined, metadataVerified: boolean, documentDenied: boolean, commentsDenied: boolean): boolean {
  return documentDenied || commentsDenied || metadataVerified && !!meta && !canCopyContent(meta);
}

/** Keep frozen drafts until explicitly dismissed, even if a composer is reused. */
export function mergeRecoveredCommentDrafts(existing: readonly SavedCommentDraft[], incoming: readonly SavedCommentDraft[]): SavedCommentDraft[] {
  const result = existing.map((item) => ({ ...item, draft: item.draft ? { ...item.draft } : null }));
  const keys = new Set(result.map((item) => JSON.stringify([item.text, item.parentId ?? null, item.draft?.block ?? null, item.draft?.startChar ?? null, item.draft?.endChar ?? null, item.draft?.quote ?? null])));
  for (const item of incoming) {
    const key = JSON.stringify([item.text, item.parentId ?? null, item.draft?.block ?? null, item.draft?.startChar ?? null, item.draft?.endChar ?? null, item.draft?.quote ?? null]);
    if (!keys.has(key)) { result.push({ ...item, draft: item.draft ? { ...item.draft } : null }); keys.add(key); }
  }
  return result;
}

/** In-memory only; one draft per composer and strictly scoped to account + document. */
export class CommentDraftJournal {
  private entries = new Map<string, SavedCommentDraft>();
  private frozen = new Map<string, SavedCommentDraft[]>();
  private scope(doc: number, user: number): string { return `${doc}:${user}`; }
  private key(doc: number, user: number, parentId?: number): string { return `${doc}:${user}:${parentId ?? "root"}`; }
  save(doc: number, user: number, draft: SavedCommentDraft): void {
    const key = this.key(doc, user, draft.parentId);
    if (!draft.text.trim()) this.entries.delete(key);
    else this.entries.set(key, { ...draft, draft: draft.draft ? { ...draft.draft } : null });
  }
  list(doc: number, user: number): SavedCommentDraft[] {
    const prefix = `${doc}:${user}:`;
    return [...this.entries].filter(([key]) => key.startsWith(prefix)).map(([, value]) => ({ ...value, draft: value.draft ? { ...value.draft } : null }));
  }
  freeze(doc: number, user: number): SavedCommentDraft[] {
    const scope = this.scope(doc, user);
    const drafts = mergeRecoveredCommentDrafts(this.frozen.get(scope) ?? [], this.list(doc, user));
    if (drafts.length) this.frozen.set(scope, drafts);
    return mergeRecoveredCommentDrafts([], drafts);
  }
  recovered(doc: number, user: number): SavedCommentDraft[] {
    return mergeRecoveredCommentDrafts([], this.frozen.get(this.scope(doc, user)) ?? []);
  }
  dismiss(doc: number, user: number): void { this.frozen.delete(this.scope(doc, user)); }
  clear(doc: number, user: number): void {
    const prefix = `${doc}:${user}:`;
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }
}

export function matchesCommentTarget(target: CommentTarget | null, doc: number, user: number, session: number): boolean {
  return target?.doc === doc && target.user === user && target.session === session;
}

/** Ignore a late policy response from an earlier document, account or session. */
export function revalidateCurrentCommentPolicy(current: CommentTarget | null, target: CommentTarget, revalidate: () => void): boolean {
  if (!matchesCommentTarget(current, target.doc, target.user, target.session)) return false;
  revalidate();
  return true;
}

/** At most one automatic revalidation until a fresh session succeeds. */
export class CommentRecoveryGate {
  private attempted = false;
  begin(): boolean {
    if (this.attempted) return false;
    this.attempted = true;
    return true;
  }
  reset(): void { this.attempted = false; }
}

export function newCommentSession(): number {
  return ++nextSession;
}

export function commentListKey(docId: number, userId: number, session: number) {
  return ["comments", docId, userId, session] as const;
}

export function commentMembersKey(docId: number, userId: number, session: number) {
  return ["docmembers", docId, userId, session] as const;
}
