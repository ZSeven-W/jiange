import { describe, expect, it } from "vitest";
import type { WikiNodeEntry } from "@/lib/api";
import { canDropWikiNode, computeStepReorder, computeWikiDropPlan, isWikiDescendant, resolveRowDropZone } from "./wiki-tree-dnd";

function mk(id: number, parentId: number | null, kind: WikiNodeEntry["kind"] = "doc", role: WikiNodeEntry["role"] = "manage"): WikiNodeEntry {
  return {
    id,
    workspaceId: 1,
    wikiSpaceId: 7,
    parentId,
    kind,
    title: `N${id}`,
    creatorId: 1,
    creatorName: "Owner",
    role,
    revision: 1,
    inheritParentAcl: true,
    createdAt: "",
    updatedAt: "",
  };
}

function maps(nodes: WikiNodeEntry[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenMap = new Map<number | null, WikiNodeEntry[]>();
  for (const n of nodes) {
    const p = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    childrenMap.set(p, [...(childrenMap.get(p) ?? []), n]);
  }
  return { byId, childrenMap };
}

describe("Wiki tree drag-and-drop planning", () => {
  it("computes before/after/inside drop plans and filters no-op drops", () => {
    const a = mk(1, null);
    const b = mk(2, null);
    const c = mk(3, null);
    const { byId, childrenMap } = maps([a, b, c]);

    // Drag C before A -> position 0
    expect(computeWikiDropPlan(childrenMap, byId, c, a, "before", "manage")).toEqual({ targetParentId: null, position: 0 });
    // Drag A after C -> position 2 (accounting for removing A from [A, B, C] -> [B, C], after C is index 2)
    expect(computeWikiDropPlan(childrenMap, byId, a, c, "after", "manage")).toEqual({ targetParentId: null, position: 2 });
    // Drag A before B -> already immediately before B -> no-op null!
    expect(computeWikiDropPlan(childrenMap, byId, a, b, "before", "manage")).toBeNull();
    // Drag B inside A -> parent A, position 0
    expect(computeWikiDropPlan(childrenMap, byId, b, a, "inside", "manage")).toEqual({ targetParentId: 1, position: 0 });
  });

  it("blocks cyclic drops, folder-under-doc drops, and insufficient permissions", () => {
    const folder = mk(1, null, "folder", "manage");
    const doc = mk(2, 1, "doc", "manage");
    const child = mk(3, 2, "doc", "edit");
    const { byId, childrenMap } = maps([folder, doc, child]);

    expect(isWikiDescendant(byId, 3, 1)).toBe(true);
    expect(isWikiDescendant(byId, 1, 3)).toBe(false);
    // Cycle: cannot drop folder inside its descendant doc
    expect(canDropWikiNode(byId, folder, child, "inside", "manage")).toBe(false);
    // Folder cannot nest under non-folder doc
    const folder2 = mk(4, null, "folder", "manage");
    const m2 = maps([folder, doc, folder2]);
    expect(canDropWikiNode(m2.byId, folder2, doc, "inside", "manage")).toBe(false);
    // Edit-only node cannot reparent to another parent (requires manage), but CAN reorder under same parent
    const child2 = mk(5, 2, "doc", "edit");
    const m3 = maps([folder, doc, child, child2]);
    expect(computeWikiDropPlan(m3.childrenMap, m3.byId, child2, child, "before", "edit")).toEqual({ targetParentId: 2, position: 0 });
    expect(canDropWikiNode(m3.byId, child2, folder, "inside", "edit")).toBe(false);
    // View-only user cannot drop anywhere
    const viewerDoc = mk(6, null, "doc", "view");
    const viewerDoc2 = mk(7, null, "doc", "view");
    const m4 = maps([viewerDoc, viewerDoc2]);
    expect(canDropWikiNode(m4.byId, viewerDoc, viewerDoc2, "after", "view")).toBe(false);
  });

  it("resolves row drop zones and step reorder indices cleanly", () => {
    expect(resolveRowDropZone(102, { top: 100, height: 32 })).toBe("before");
    expect(resolveRowDropZone(116, { top: 100, height: 32 })).toBe("inside");
    expect(resolveRowDropZone(130, { top: 100, height: 32 })).toBe("after");

    const list = [mk(1, null), mk(2, null), mk(3, null)];
    expect(computeStepReorder(list, 1, -1)).toBeNull();
    expect(computeStepReorder(list, 1, 1)).toBe(1);
    expect(computeStepReorder(list, 3, -1)).toBe(1);
    expect(computeStepReorder(list, 3, 1)).toBeNull();
  });
});
