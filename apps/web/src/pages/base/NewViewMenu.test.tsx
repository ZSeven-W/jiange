import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "@/i18n/en";
import { createdViewSelectionResult, isCreatedView, NewViewMenu, VIEW_CHOICES } from "./NewViewMenu";

describe("new view menu", () => {
  it("offers each supported view once with translated labels", () => {
    expect(VIEW_CHOICES.map((item) => item.type)).toEqual(["grid", "kanban", "calendar", "gantt", "gallery", "form"]);
    for (const choice of VIEW_CHOICES) expect(en).toHaveProperty(choice.label);
    const html = renderToStaticMarkup(<NewViewMenu open={false} onOpenChange={() => {}} canEdit busy={false} onCreate={() => {}} />);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(renderToStaticMarkup(<NewViewMenu open={false} onOpenChange={() => {}} canEdit={false} busy={false} onCreate={() => {}} />)).toBe("");
  });

  it("does not select an incomplete or mismatched creation response", () => {
    const view = { id: 12, baseId: 7, type: "kanban", name: "看板视图", config: {}, pos: 2 };
    expect(isCreatedView(view, 7, "kanban", "看板视图")).toBe(true);
    for (const bad of [null, {}, { ...view, id: 0 }, { ...view, baseId: 8 }, { ...view, type: "grid" }, { ...view, name: "不同" }, { ...view, pos: NaN }, { ...view, config: null }, { ...view, config: [] }]) {
      expect(isCreatedView(bad, 7, "kanban", "看板视图")).toBe(false);
    }
  });

  it("waits for a fresh authorized list and respects a later manual selection", () => {
    const before = { base: { role: "edit" }, views: [{ id: 1, baseId: 7 }] };
    const selection = { baseId: 7, userId: 3, viewId: 2, revision: 4, baseline: before };
    const state = { baseId: 7, userId: 3, revision: 4, ready: true, fetching: false, blocked: false, snapshot: before };
    expect(createdViewSelectionResult(selection, state)).toBe("wait");
    const fresh = { base: { role: "edit" }, views: [{ id: 1, baseId: 7 }, { id: 2, baseId: 7 }] };
    expect(createdViewSelectionResult(selection, { ...state, snapshot: fresh, fetching: true })).toBe("wait");
    expect(createdViewSelectionResult(selection, { ...state, snapshot: fresh })).toBe("select");
    expect(createdViewSelectionResult(selection, { ...state, snapshot: fresh, revision: 5 })).toBe("discard");
    expect(createdViewSelectionResult(selection, { ...state, snapshot: fresh, userId: 4 })).toBe("discard");
    expect(createdViewSelectionResult(selection, { ...state, snapshot: { ...fresh, base: { role: "view" } } })).toBe("discard");
    expect(createdViewSelectionResult(selection, { ...state, snapshot: { ...before, views: [...before.views] } })).toBe("missing");
  });
});
