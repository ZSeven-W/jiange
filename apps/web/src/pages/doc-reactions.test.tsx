import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { docsApi, type DocReactionsResponse } from "@/lib/api";
import {
  applyOptimisticDocReaction,
  DOC_REACTION_EMOJIS,
  DocReactionsBar,
  docReactionsQueryKey,
  docReactionToggleOptions,
} from "./doc-reactions";

describe("doc-reactions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies optimistic toggles in palette order and removes zero-count buckets", () => {
    let state = applyOptimisticDocReaction(undefined, "🙏");
    expect(state).toEqual({
      reactions: [{ emoji: "🙏", count: 1, reacted: true }],
      viewerCount: 1,
    });

    // Adding an earlier palette emoji orders it ahead of 🙏 and keeps viewerCount.
    state = applyOptimisticDocReaction({ ...state, viewerCount: 4 }, "👍");
    expect(state).toEqual({
      reactions: [
        { emoji: "👍", count: 1, reacted: true },
        { emoji: "🙏", count: 1, reacted: true },
      ],
      viewerCount: 4,
    });

    // Reacting to an emoji already set by another user increments count and marks reacted.
    state = applyOptimisticDocReaction(
      {
        reactions: [{ emoji: "🎉", count: 2, reacted: false }],
        viewerCount: 3,
      },
      "🎉",
    );
    expect(state.reactions).toEqual([{ emoji: "🎉", count: 3, reacted: true }]);

    // Toggling off when other users remain decrements count and clears reacted.
    state = applyOptimisticDocReaction(state, "🎉");
    expect(state.reactions).toEqual([{ emoji: "🎉", count: 2, reacted: false }]);

    // Toggling off the sole reaction removes the empty bucket completely.
    const sole = applyOptimisticDocReaction(
      { reactions: [{ emoji: "🔥", count: 1, reacted: true }], viewerCount: 2 },
      "🔥",
    );
    expect(sole).toEqual({ reactions: [], viewerCount: 2 });

    expect(DOC_REACTION_EMOJIS).toEqual([
      "👍",
      "❤️",
      "🎉",
      "👏",
      "🔥",
      "😄",
      "🚀",
      "👀",
      "💯",
      "🙏",
    ]);
  });

  it("renders SSR safely before data resolves with default 0 reactions and 1 viewer", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <DocReactionsBar
          docId={999}
          me={{ id: 1, name: "Jiange Audit" }}
          readers={[]}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-doc-reactions");
    expect(html).toContain("data-doc-like-btn");
    expect(html).toContain("赞");
    expect(html).toContain("data-doc-reaction-add");
    expect(html).toContain('aria-label="添加表情回应"');
    expect(html).toContain("1 人看过");
  });

  it("renders deduplicated local readers and cloud-persisted reactions & viewerCount from cache", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const cached: DocReactionsResponse = {
      reactions: [
        { emoji: "👍", count: 3, reacted: true },
        { emoji: "🎉", count: 2, reacted: false },
      ],
      viewerCount: 7,
    };
    qc.setQueryData(docReactionsQueryKey(42), cached);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <DocReactionsBar
          docId={42}
          me={{ id: 1, name: "Alice" }}
          readers={[
            { id: 1, name: "Alice" },
            { id: 2, name: "Bob", viewedAt: "今天" },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("data-doc-reactions");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("data-doc-like-btn");
    expect(html).toContain(">3<");
    expect(html).toContain('data-doc-reaction="🎉"');
    expect(html).toContain(">2<");
    expect(html).toContain("7 人看过");
  });

  it("performs optimistic cache update on toggle and settles or rolls back on error", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const docId = 101;
    const key = docReactionsQueryKey(docId);
    const initial: DocReactionsResponse = {
      reactions: [{ emoji: "👍", count: 1, reacted: false }],
      viewerCount: 3,
    };
    qc.setQueryData(key, initial);

    const serverSnapshot: DocReactionsResponse = {
      reactions: [{ emoji: "👍", count: 2, reacted: true }],
      viewerCount: 4,
    };
    const spy = vi.spyOn(docsApi, "toggleReaction").mockResolvedValueOnce(serverSnapshot);

    const opts = docReactionToggleOptions(qc, docId);
    const ctx = await opts.onMutate("👍");
    expect(qc.getQueryData<DocReactionsResponse>(key)).toEqual({
      reactions: [{ emoji: "👍", count: 2, reacted: true }],
      viewerCount: 3,
    });

    const settled = await opts.mutationFn("👍");
    opts.onSuccess(settled, "👍", ctx);
    expect(spy).toHaveBeenCalledWith(docId, "👍");
    expect(qc.getQueryData<DocReactionsResponse>(key)).toEqual(serverSnapshot);

    // Error path rolls back optimistic state cleanly.
    const errSpy = vi.spyOn(docsApi, "toggleReaction").mockRejectedValueOnce(new Error("forbidden"));
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
    const errCtx = await opts.onMutate("🎉");
    expect(qc.getQueryData<DocReactionsResponse>(key)?.reactions.map((r) => r.emoji)).toEqual([
      "👍",
      "🎉",
    ]);
    await expect(opts.mutationFn("🎉")).rejects.toThrow("forbidden");
    opts.onError(new Error("forbidden"), "🎉", errCtx);
    expect(errSpy).toHaveBeenCalledWith(docId, "🎉");
    expect(qc.getQueryData<DocReactionsResponse>(key)).toEqual(serverSnapshot);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: key, exact: true });
  });
});
