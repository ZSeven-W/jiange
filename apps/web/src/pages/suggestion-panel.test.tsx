import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocSuggestion } from "@/lib/api";
import { SuggestionPanel } from "./suggestion-panel";

const sampleSuggestions: DocSuggestion[] = [
  {
    id: 1,
    docId: 10,
    blockId: "1:2",
    authorId: 2,
    authorName: "李明",
    kind: "replace",
    originalText: "原方案将在周五上线",
    proposedText: "新方案将在下周一灰度上线",
    note: "避开周五发布窗口",
    status: "open",
    createdAt: "2026-11-19T08:00:00Z",
    updatedAt: "2026-11-19T08:00:00Z",
  },
];

describe("SuggestionPanel", () => {
  it("renders composer, diff preview, batch actions, and single accept/reject/withdraw buttons for editor/author", () => {
    const html = renderToStaticMarkup(
      <SuggestionPanel
        suggestions={sampleSuggestions}
        blocks={[{ id: "1:2", type: "paragraph", text: "原方案将在周五上线" }]}
        currentUserId={2}
        canEdit={true}
        canManage={false}
        canSuggest={true}
        suggestMode={true}
        onCreate={() => {}}
        onAccept={() => {}}
        onReject={() => {}}
        onWithdraw={() => {}}
        onAcceptAll={() => {}}
        onRejectAll={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("data-suggestion-panel");
    expect(html).toContain("data-suggestion-composer");
    expect(html).toContain("data-suggestion-block-select");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('data-select-value="1:2"');
    expect(html).toContain("data-select-options");
    expect(html).toContain("data-accept-all-suggestions");
    expect(html).toContain("data-reject-all-suggestions");
    expect(html).toContain("原方案将在周五上线");
    expect(html).toContain("新方案将在下周一灰度上线");
    expect(html).toContain("避开周五发布窗口");
    expect(html).toContain('data-suggestion-accept="1"');
    expect(html).toContain('data-suggestion-reject="1"');
    expect(html).toContain('data-suggestion-withdraw="1"');
  });

  it("hides editor accept/reject and batch controls for read-only viewer", () => {
    const html = renderToStaticMarkup(
      <SuggestionPanel
        suggestions={sampleSuggestions}
        blocks={[{ id: "1:2", type: "paragraph", text: "原方案将在周五上线" }]}
        currentUserId={99}
        canEdit={false}
        canManage={false}
        canSuggest={true}
        suggestMode={false}
        onCreate={() => {}}
        onAccept={() => {}}
        onReject={() => {}}
        onWithdraw={() => {}}
        onAcceptAll={() => {}}
        onRejectAll={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).not.toContain("data-accept-all-suggestions");
    expect(html).not.toContain('data-suggestion-accept="1"');
    expect(html).not.toContain('data-suggestion-withdraw="1"');
  });
});
