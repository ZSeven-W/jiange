import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Doc, ROOT, Tx, idKey } from "@zseven-w/collab";
import type { DocSuggestion } from "@/lib/api";
import type { SyncDoc } from "@/lib/use-sync-doc";
import { InlineTrackChanges, computeInlineDiff, formatSuggestionTimestamp } from "./inline-track-changes";
import { Editor } from "./editor";

const openSuggestion = (blockId: string, overrides: Partial<DocSuggestion> = {}): DocSuggestion => ({
  id: 101,
  docId: 5,
  blockId,
  authorId: 7,
  authorName: "张华",
  kind: "replace",
  originalText: "原方案将在周五上线",
  proposedText: "新方案将在下周一灰度上线",
  note: "避开周五变更窗口",
  status: "open",
  createdAt: "2026-11-24T08:15:00Z",
  updatedAt: "2026-11-24T08:15:00Z",
  ...overrides,
});

describe("computeInlineDiff", () => {
  it("computes minimal inline deleted and inserted spans for mixed text", () => {
    const segs = computeInlineDiff("原方案将在周五上线", "新方案将在下周一灰度上线");
    expect(segs).toEqual([
      { kind: "delete", text: "原" },
      { kind: "insert", text: "新" },
      { kind: "equal", text: "方案将在" },
      { kind: "insert", text: "下" },
      { kind: "equal", text: "周" },
      { kind: "delete", text: "五" },
      { kind: "insert", text: "一灰度" },
      { kind: "equal", text: "上线" },
    ]);
    // Reconstruct original and proposed strings cleanly from segments
    expect(segs.filter((s) => s.kind !== "insert").map((s) => s.text).join("")).toBe("原方案将在周五上线");
    expect(segs.filter((s) => s.kind !== "delete").map((s) => s.text).join("")).toBe("新方案将在下周一灰度上线");
  });

  it("handles pure insert, pure delete, and identical text", () => {
    expect(computeInlineDiff("", "新增段落")).toEqual([{ kind: "insert", text: "新增段落" }]);
    expect(computeInlineDiff("删除段落", "")).toEqual([{ kind: "delete", text: "删除段落" }]);
    expect(computeInlineDiff("相同", "相同")).toEqual([{ kind: "equal", text: "相同" }]);
    expect(formatSuggestionTimestamp("2026-11-24T08:15:00Z")).toMatch(/2026-11-24 \d{2}:\d{2}/);
  });
});

describe("InlineTrackChanges component and Editor integration", () => {
  it("renders author, timestamp, red strikethrough, green highlight, note, and accept/reject controls", () => {
    const s = openSuggestion("1:2");
    const html = renderToStaticMarkup(
      <InlineTrackChanges
        blockId="1:2"
        blockText="原方案将在周五上线"
        suggestions={[s]}
        canEdit={true}
        canSuggest={true}
        onAccept={() => {}}
        onReject={() => {}}
        onCreate={() => {}}
      />,
    );
    expect(html).toContain('data-inline-suggestion-id="101"');
    expect(html).toContain("张华");
    expect(html).toContain("data-inline-suggestion-time");
    expect(html).toContain("data-diff-delete");
    expect(html).toContain("line-through");
    expect(html).toContain("bg-red-50");
    expect(html).toContain("text-red-700");
    expect(html).toContain("data-diff-insert");
    expect(html).toContain("bg-emerald-50");
    expect(html).toContain("text-emerald-700");
    expect(html).toContain("underline");
    expect(html).toContain("decoration-emerald-400");
    expect(html).toContain("避开周五变更窗口");
    expect(html).toContain('data-inline-suggestion-accept="101"');
    expect(html).toContain('data-inline-suggestion-reject="101"');
    expect(html).toContain('data-inline-propose-btn="1:2"');
    expect(html).toContain("提出修订建议");
  });

  it("hides accept/reject buttons for users without edit permission", () => {
    const html = renderToStaticMarkup(
      <InlineTrackChanges
        blockId="1:2"
        blockText="原方案将在周五上线"
        suggestions={[openSuggestion("1:2")]}
        canEdit={false}
        onAccept={() => {}}
        onReject={() => {}}
      />,
    );
    expect(html).toContain('data-inline-suggestion-id="101"');
    expect(html).not.toContain('data-inline-suggestion-accept="101"');
    expect(html).not.toContain('data-inline-suggestion-reject="101"');
  });

  it("projects open suggestions inline inside Editor only when trackChangesMode is active", () => {
    const doc = new Doc(1);
    const tx = new Tx(doc);
    const p1 = tx.create("paragraph", null, ROOT);
    tx.insert(p1, 0, "原方案将在周五上线");
    const p2 = tx.create("paragraph", p1, ROOT);
    tx.insert(p2, 0, "无需修改的第二段");

    const open = openSuggestion(idKey(p1), { id: 201 });
    const accepted = openSuggestion(idKey(p2), { id: 202, status: "accepted" });
    const sync = { client: { doc, docId: 5 }, peers: [], version: 0, status: "synced" } as unknown as SyncDoc;

    const disabledHtml = renderToStaticMarkup(
      <Editor
        sync={sync}
        me={{ name: "测试", color: "#3370ff" }}
        trackChangesMode={false}
        openSuggestions={[open, accepted]}
        canAcceptSuggestions={true}
        onAcceptSuggestion={() => {}}
        onRejectSuggestion={() => {}}
      />,
    );
    expect(disabledHtml).not.toContain("data-inline-suggestion-id");

    const enabledHtml = renderToStaticMarkup(
      <Editor
        sync={sync}
        me={{ name: "测试", color: "#3370ff" }}
        trackChangesMode={true}
        openSuggestions={[open, accepted]}
        canAcceptSuggestions={true}
        canSuggestInline={true}
        onAcceptSuggestion={() => {}}
        onRejectSuggestion={() => {}}
        onCreateSuggestion={() => {}}
      />,
    );
    expect(enabledHtml).toContain('data-inline-suggestion-id="201"');
    expect(enabledHtml).not.toContain('data-inline-suggestion-id="202"');
    expect(enabledHtml).toContain('data-inline-suggestion-accept="201"');
    expect(enabledHtml).toContain('data-inline-suggestion-reject="201"');
    expect(enabledHtml).toContain(`data-inline-propose-btn="${idKey(p2)}"`);
  });
});
