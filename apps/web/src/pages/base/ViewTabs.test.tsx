import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ViewTabs, moveViewIds, retainRejectedViewRename } from "./ViewTabs";
import { WriteLedger } from "./writeSafety";
import type { DocMeta, View } from "@/lib/api";

const makeView = (id: number): View => ({ id, baseId: 1, name: `视图${id}`, type: "grid", config: {}, pos: id });

describe("view tabs", () => {
  it("moves by ID using the full current order without mutating it", () => {
    const ids = [1, 2, 3, 4];
    expect(moveViewIds(ids, 1, 3)).toEqual([2, 3, 1, 4]);
    expect(moveViewIds(ids, 4, 2)).toEqual([1, 4, 2, 3]);
    expect(moveViewIds(ids, 2, 2)).toBeNull();
    expect(moveViewIds(ids, 9, 1)).toBeNull();
    expect(moveViewIds([1, 1, 2], 1, 2)).toBeNull();
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  it("exposes the menu only to editors and marks the active view", () => {
    const props = { baseId: 1, views: [makeView(1), makeView(2)], activeId: 2, dirty: false, icon: () => null, onSelect: () => {}, onRefresh: async () => {} };
    const client = new QueryClient();
    const edit = renderToStaticMarkup(<QueryClientProvider client={client}><ViewTabs {...props} canEdit /></QueryClientProvider>);
    expect(edit).toContain('aria-label="视图2视图菜单"');
    expect(edit).toContain('aria-selected="true"');
    const read = renderToStaticMarkup(<QueryClientProvider client={client}><ViewTabs {...props} canEdit={false} /></QueryClientProvider>);
    expect(read).not.toContain("视图菜单");
  });
  it("preserves the rejected name while releasing the view-operation lock", () => {
    const ledger = new WriteLedger();
    const base: DocMeta = { id: 1, workspaceId: 1, parentId: null, title: "表", icon: "", creatorId: 1, creatorName: "A", createdAt: "", updatedAt: "", role: "edit" };
    const snapshot = { base, fields: [], records: [], views: [makeView(1)], expansions: {} };
    ledger.setAuthorization(snapshot);
    const operation = ledger.begin("重命名视图", "新名称", "view:write")!;
    retainRejectedViewRename(ledger, "新名称", 1);
    ledger.complete(operation);
    expect(ledger.blocked("view:write")).toBe(false);
    const issue = ledger.snapshot()[0];
    expect(issue).toMatchObject({ draft: "新名称", status: "failed", message: expect.stringContaining("未保存") });
    ledger.setAuthorization({ ...snapshot, views: [{ ...makeView(1), name: "他人的名称" }] });
    expect(ledger.mayShow(issue)).toBe(true);
    ledger.setAuthorization({ ...snapshot, views: [] });
    expect(ledger.mayShow(issue)).toBe(false);
    ledger.setAuthorization({ ...snapshot, base: { ...base, role: "view" } });
    expect(ledger.mayShow(issue)).toBe(false);
    ledger.setAuthorization({ ...snapshot, base: { ...base, copyProtected: true } });
    expect(ledger.mayShow(issue)).toBe(false);
    expect(ledger.begin("重新命名", "", "view:write")).not.toBeNull();
  });
});
