import { describe, expect, it } from "vitest";
import { ApiError, type DocMeta } from "@/lib/api";
import { docMetaKey, docMetaState, isDocAccessDenied, shouldRetryDocMeta } from "./docMetaState";

const cached = { id: 7, role: "edit" } as DocMeta;

describe("document metadata access", () => {
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
});
