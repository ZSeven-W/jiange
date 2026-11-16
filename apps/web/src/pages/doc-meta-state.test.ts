import { describe, expect, it } from "vitest";
import { ApiError, type DocMeta } from "@/lib/api";
import { QueryClient } from "@tanstack/react-query";
import { docMetaKey, docMetaState, isDocAccessDenied, mayConnectDocument, removeDeniedDocumentReferences, shouldRetryDocMeta } from "./doc-meta-state";

const cached = { id: 7, role: "edit" } as DocMeta;

describe("document metadata access", () => {
  it("connects sync only for a known document with usable metadata", () => {
    const doc = { ...cached, kind: "doc" } as DocMeta;
    expect(mayConnectDocument(doc, "ready")).toBe(true);
    expect(mayConnectDocument(doc, "offline")).toBe(true);
    for (const state of ["loading", "retry", "denied"] as const) expect(mayConnectDocument(doc, state)).toBe(false);
    for (const kind of ["base", "slides", "sheet", undefined]) expect(mayConnectDocument({ ...cached, kind } as DocMeta, "ready")).toBe(false);
    expect(mayConnectDocument(undefined, "loading")).toBe(false);
  });
  it("keeps same-account cached data only for temporary failures", () => {
    for (const error of [new TypeError("network failed"), new ApiError(500, "error", "server failed"), new ApiError(429, "rate_limit", "retry")]) {
      expect(docMetaState(cached, true, error)).toBe("offline");
      expect(docMetaState(undefined, true, error)).toBe("retry");
      expect(shouldRetryDocMeta(0, error)).toBe(true);
      expect(shouldRetryDocMeta(2, error)).toBe(false);
    }
  });

  it.each([401, 403, 404])("never displays cached content after status %i", (status) => {
    const error = new ApiError(status, "forbidden", "denied");
    expect(isDocAccessDenied(error)).toBe(true);
    expect(docMetaState(cached, true, error)).toBe("denied");
    expect(docMetaState(undefined, true, error)).toBe("denied");
    expect(shouldRetryDocMeta(0, error)).toBe(false);
  });

  it("uses account-specific query keys while retaining the doc invalidation prefix", () => {
    expect(docMetaKey(7, 1)).not.toEqual(docMetaKey(7, 2));
    expect(docMetaKey(7, 1).slice(0, 2)).toEqual(["doc", 7]);
    expect(docMetaState(undefined, false, null)).toBe("loading");
    expect(docMetaState(cached, false, null)).toBe("ready");
  });

  it("removes a denied document from cached lists without letting an older request restore it", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const denied = { id: 7, title: "已撤权" }, allowed = { id: 8, title: "仍可访问" };
    for (const key of [["docs"], ["shared"], ["favorites"], ["pins"], ["recent", 1], ["search", "项目"]]) qc.setQueryData(key, [denied, allowed]);
    let finish!: (value: unknown[]) => void;
    const stale = qc.fetchQuery({ queryKey: ["shared"], queryFn: () => new Promise<unknown[]>((resolve) => { finish = resolve; }) }).catch(() => undefined);
    await Promise.resolve();
    await removeDeniedDocumentReferences(qc, 7, () => true);
    finish([denied, allowed]); await stale;
    for (const key of [["docs"], ["shared"], ["favorites"], ["pins"], ["recent", 1], ["search", "项目"]]) expect(qc.getQueryData(key)).toEqual([allowed]);
    qc.clear();
  });

  it("does not remove an entry after access has already been restored", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["shared"], [{ id: 7, title: "已恢复" }]);
    await removeDeniedDocumentReferences(qc, 7, () => false);
    expect(qc.getQueryData(["shared"])).toEqual([{ id: 7, title: "已恢复" }]);
    qc.clear();
  });
});
