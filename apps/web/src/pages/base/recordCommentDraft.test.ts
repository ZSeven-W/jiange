import { describe, expect, it } from "vitest";
import { bindRecordCommentDraft, clearRecordCommentDraftConfirmation, clearRecordCommentDraftIfUnchanged, isRecordCommentDraftConfirmed, loadRecordCommentDraft, markRecordCommentDraftConfirmed, reconcileRecordCommentDraft, recordCommentDraftKey, recordCommentDraftRevision, saveRecordCommentDraft } from "./recordCommentDraft";

function storage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null, removeItem: (key) => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
}

describe("record comment drafts", () => {
  it("isolates user, base and record, including whitespace", () => {
    const store = storage();
    saveRecordCommentDraft(store, 1, 2, 3, " 草稿 ");
    expect(loadRecordCommentDraft(store, 1, 2, 3)).toBe(" 草稿 ");
    expect(loadRecordCommentDraft(store, 2, 2, 3)).toBe("");
    expect(loadRecordCommentDraft(store, 1, 2, 4)).toBe("");
    saveRecordCommentDraft(store, 1, 2, 3, "");
    expect(loadRecordCommentDraft(store, 1, 2, 3)).toBe("");
  });
  it("does not clear a newer edit, even when its text matches the sent draft", () => {
    const store = storage();
    saveRecordCommentDraft(store, 1, 2, 3, "原稿");
    const revision = recordCommentDraftRevision(store, 1, 2, 3);
    saveRecordCommentDraft(store, 1, 2, 3, "新稿");
    saveRecordCommentDraft(store, 1, 2, 3, "原稿");
    expect(clearRecordCommentDraftIfUnchanged(store, 1, 2, 3, revision)).toBe(false);
    expect(loadRecordCommentDraft(store, 1, 2, 3)).toBe("原稿");
    expect(clearRecordCommentDraftIfUnchanged(store, 1, 2, 3, recordCommentDraftRevision(store, 1, 2, 3))).toBe(true);
  });
  it("rejects invalid identities instead of sharing a draft key", () => {
    expect(() => recordCommentDraftKey(0, 1, 1)).toThrow();
    expect(() => recordCommentDraftKey(1, Number.MAX_SAFE_INTEGER + 1, 1)).toThrow();
  });
  it("keeps a recovered confirmation across remounts and unblocks only a changed or acknowledged draft", () => {
    const store = storage();
    saveRecordCommentDraft(store, 1, 2, 3, "消息");
    expect(markRecordCommentDraftConfirmed(store, 1, 2, 3, "消息")).toBe(true);
    expect(isRecordCommentDraftConfirmed(store, 1, 2, 3)).toBe(true);
    expect(isRecordCommentDraftConfirmed(store, 2, 2, 3)).toBe(false);
    saveRecordCommentDraft(store, 1, 2, 3, "消息新");
    expect(isRecordCommentDraftConfirmed(store, 1, 2, 3)).toBe(false);
    clearRecordCommentDraftConfirmation(store, 1, 2, 3);
    expect(isRecordCommentDraftConfirmed(store, 1, 2, 3)).toBe(false);
  });
  it("marks only the bound tab and never overwrites a later revision", () => {
    const first = storage(), second = storage();
    const id = "1234567890abcdef1234567890abcdef";
    saveRecordCommentDraft(first, 1, 2, 3, "消息");
    saveRecordCommentDraft(second, 1, 2, 3, "消息");
    expect(bindRecordCommentDraft(first, 1, 2, 3, id, "消息", recordCommentDraftRevision(first, 1, 2, 3))).toBe(true);
    expect(reconcileRecordCommentDraft(first, 1, 2, 3, () => false)).toBe(false);
    expect(reconcileRecordCommentDraft(second, 1, 2, 3, () => true)).toBe(false);
    expect(reconcileRecordCommentDraft(first, 1, 2, 3, (key) => key === id)).toBe(true);
    expect(isRecordCommentDraftConfirmed(first, 1, 2, 3)).toBe(true);
    expect(loadRecordCommentDraft(first, 1, 2, 3)).toBe("消息");
    saveRecordCommentDraft(first, 1, 2, 3, "新稿");
    saveRecordCommentDraft(first, 1, 2, 3, "消息");
    expect(reconcileRecordCommentDraft(first, 1, 2, 3, () => true)).toBe(false);
    expect(isRecordCommentDraftConfirmed(first, 1, 2, 3)).toBe(false);
  });
});
