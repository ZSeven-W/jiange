import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicDoc, initialPublicDocState, updatePublicDocState, type PublicSnapshot } from "./publicDocState";

const snapshot: PublicSnapshot = { title: "公开方案", updatedAt: "2026-11-06T00:00:00Z", view: { blocks: [] } };

afterEach(() => vi.unstubAllGlobals());

describe("public document refresh", () => {
  it("replaces stale content when updated and hides it after a link is disabled or requires login", () => {
    let state = updatePublicDocState(initialPublicDocState("abc"), "abc", { snapshot });
    state = updatePublicDocState(state, "abc", { snapshot: { ...snapshot, title: "更新后的方案", copyProtected: true } });
    expect(state.snapshot?.title).toBe("更新后的方案");
    expect(state.snapshot?.copyProtected).toBe(true);
    expect(updatePublicDocState(state, "abc", { issue: "expired" }).snapshot).toBeNull();
    expect(updatePublicDocState(state, "abc", { issue: "login" }).snapshot).toBeNull();
  });

  it("keeps the last snapshot only for temporary failure and retries failed images after recovery", () => {
    const loaded = updatePublicDocState(initialPublicDocState("abc"), "abc", { snapshot });
    const offline = updatePublicDocState(loaded, "abc", { issue: "temporary" });
    expect(offline.snapshot).toEqual(snapshot);
    expect(offline.issue).toBe("temporary");
    const recovered = updatePublicDocState(offline, "abc", { snapshot });
    expect(recovered.issue).toBeNull();
    expect(recovered.recovery).toBe(1);
    expect(updatePublicDocState(offline, "different-token", { issue: "temporary" }).snapshot).toBeNull();
  });

  it("distinguishes login, revoked links and transient errors", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ title: "malformed" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    expect(await fetchPublicDoc("a/b", signal)).toEqual({ issue: "login" });
    expect(fetcher.mock.calls[0][0]).toBe("/api/public/a%2Fb");
    expect(await fetchPublicDoc("abc", signal)).toEqual({ issue: "expired" });
    expect(await fetchPublicDoc("abc", signal)).toEqual({ issue: "temporary" });
    expect(await fetchPublicDoc("abc", signal)).toEqual({ issue: "temporary" });
    expect(await fetchPublicDoc("abc", signal)).toEqual({ issue: "temporary" });
    expect(await fetchPublicDoc("abc", signal)).toEqual({ snapshot });
  });
});
