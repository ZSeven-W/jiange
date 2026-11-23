import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocReactionsBar, toggleDocReaction } from "./doc-reactions";

describe("doc-reactions", () => {
  it("toggles reactions per user and removes empty reaction buckets", () => {
    const alice = { id: 1, name: "Alice" };
    const bob = { id: 2, name: "Bob" };
    let state = toggleDocReaction([], "👍", alice);
    expect(state).toEqual([{ emoji: "👍", users: [alice] }]);
    state = toggleDocReaction(state, "👍", bob);
    expect(state[0].users).toHaveLength(2);
    state = toggleDocReaction(state, "🎉", alice);
    expect(state).toHaveLength(2);
    state = toggleDocReaction(state, "🎉", alice);
    expect(state).toHaveLength(1);
  });

  it("renders Feishu like button, reaction trigger, and deduplicated reader count", () => {
    const html = renderToStaticMarkup(
      <DocReactionsBar
        docId={999}
        me={{ id: 1, name: "Jiange Audit" }}
        readers={[{ id: 1, name: "Jiange Audit" }, { id: 2, name: "Bob", viewedAt: "今天" }]}
      />,
    );
    expect(html).toContain("data-doc-reactions");
    expect(html).toContain("data-doc-like-btn");
    expect(html).toContain("data-doc-reaction-add");
    expect(html).toContain("2 人看过");
  });
});
