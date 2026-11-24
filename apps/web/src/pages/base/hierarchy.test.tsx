import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BaseRecord, Field, User } from "@/lib/api";
import {
  buildHierarchyTree,
  extractParentId,
  flattenHierarchy,
  HierarchyView,
  isSelfLinkField,
} from "./hierarchy";

const baseId = 7;
const tableId = 11;
const members: User[] = [{ id: 1, name: "张三", email: "z@example.com", createdAt: "" }];

const titleField: Field = { id: 1, name: "任务", type: "text", position: 1, isPrimary: true };
const parentLinkField: Field = {
  id: 2,
  name: "父任务",
  type: "link",
  options: [String(baseId)],
  targetTableId: tableId,
  position: 2,
};
const otherBaseLinkField: Field = {
  id: 3,
  name: "关联项目",
  type: "link",
  options: ["999"],
  position: 3,
};
const progressField: Field = { id: 4, name: "进度", type: "progress", options: ["bar"], position: 4 };
const budgetField: Field = { id: 5, name: "预算", type: "currency", options: ["CNY", "2"], position: 5 };
const autoField: Field = { id: 6, name: "编号", type: "autonumber", options: ["T-", "3"], position: 6 };

const fields: Field[] = [titleField, parentLinkField, progressField, budgetField, autoField];

const makeRec = (id: number, title: string, parentId?: number, extra?: BaseRecord["cells"]): BaseRecord => ({
  id,
  baseId,
  tableId,
  position: id,
  cells: {
    "1": title,
    ...(parentId !== undefined ? { "2": [parentId] } : {}),
    ...extra,
  },
});

describe("hierarchy tree engine", () => {
  it("identifies self-referencing link fields pointing to the same base and table", () => {
    expect(isSelfLinkField(parentLinkField, baseId, tableId)).toBe(true);
    expect(isSelfLinkField(otherBaseLinkField, baseId, tableId)).toBe(false);
    expect(isSelfLinkField(titleField, baseId, tableId)).toBe(false);
    expect(isSelfLinkField({ ...parentLinkField, targetTableId: 888 }, baseId, tableId)).toBe(false);
  });

  it("extracts parent IDs from either folded server expansions or raw numeric cells", () => {
    const foldedRec: BaseRecord = { id: 102, baseId, position: 2, cells: { "1": "子任务", "2": ["父任务"] } };
    const expansions = { "2": { "102": [101] } };
    expect(extractParentId(foldedRec, 2, expansions)).toBe(101);
    expect(extractParentId(makeRec(102, "子任务", 101), 2)).toBe(101);
    expect(extractParentId(makeRec(101, "父任务"), 2)).toBeNull();
  });

  it("builds a multi-level tree with accurate depths, descendant counts, and flatten collapse", () => {
    const records = [
      makeRec(1, "根节点 A"),
      makeRec(2, "子节点 A1", 1),
      makeRec(3, "孙节点 A1a", 2),
      makeRec(4, "子节点 A2", 1),
      makeRec(5, "根节点 B"),
    ];
    const tree = buildHierarchyTree(records, parentLinkField.id);
    expect(tree.hadCycle).toBe(false);
    expect(tree.roots).toHaveLength(2);
    expect(tree.roots[0].record.id).toBe(1);
    expect(tree.roots[0].descendantCount).toBe(3);
    expect(tree.roots[0].children.map((c) => c.record.id)).toEqual([2, 4]);
    expect(tree.roots[0].children[0].children[0].record.id).toBe(3);
    expect(tree.roots[0].children[0].children[0].depth).toBe(2);
    expect(tree.branchIds).toContain(1);
    expect(tree.branchIds).toContain(2);

    // Full flatten visits all 5 nodes in preorder.
    expect(flattenHierarchy(tree.roots, new Set()).map((n) => n.record.id)).toEqual([1, 2, 3, 4, 5]);
    // Collapsing node 2 hides node 3 only.
    expect(flattenHierarchy(tree.roots, new Set([2])).map((n) => n.record.id)).toEqual([1, 2, 4, 5]);
    // Collapsing root 1 hides all its descendants.
    expect(flattenHierarchy(tree.roots, new Set([1])).map((n) => n.record.id)).toEqual([1, 5]);
  });

  it("breaks self-loops, 2-cycles, 3-cycles, and lasso cycles without infinite recursion", () => {
    // Self-loop: 1 -> 1
    const selfLoop = buildHierarchyTree([makeRec(1, "自环", 1)], 2);
    expect(selfLoop.hadCycle).toBe(true);
    expect(flattenHierarchy(selfLoop.roots, new Set()).map((n) => n.record.id)).toEqual([1]);

    // 2-cycle: 1 -> 2, 2 -> 1
    const twoCycle = buildHierarchyTree([makeRec(1, "A", 2), makeRec(2, "B", 1)], 2);
    expect(twoCycle.hadCycle).toBe(true);
    expect(flattenHierarchy(twoCycle.roots, new Set())).toHaveLength(2);

    // 3-cycle + external node pointing into cycle: 4 -> 1 -> 2 -> 3 -> 1
    const threeCycle = buildHierarchyTree(
      [makeRec(1, "A", 3), makeRec(2, "B", 1), makeRec(3, "C", 2), makeRec(4, "D", 1)],
      2,
    );
    expect(threeCycle.hadCycle).toBe(true);
    const ids = flattenHierarchy(threeCycle.roots, new Set()).map((n) => n.record.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });
});

describe("HierarchyView component", () => {
  it("renders parent-child tree rows, indent guides, child count badges, add-child buttons, and ZERO native <select>", () => {
    const records = [
      makeRec(1, "一级规划", undefined, { "4": 60, "5": 1200, "6": 1 }),
      makeRec(2, "二级拆分", 1, { "4": 100, "5": 400, "6": 2 }),
      makeRec(3, "三级执行", 2, { "4": 25, "5": 200, "6": 3 }),
    ];
    const html = renderToStaticMarkup(
      <HierarchyView
        baseId={baseId}
        tableId={tableId}
        canEdit
        fields={fields}
        allFields={fields}
        records={records}
        members={members}
        parentFieldId={parentLinkField.id}
        onChangeParentField={() => {}}
        onMutate={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("data-hierarchy-view");
    expect(html).toContain("data-hierarchy-parent-select");
    expect(html).toContain('role="combobox"');
    expect(html).not.toContain("<select");
    expect(html).toContain("全部展开");
    expect(html).toContain("全部折叠");
    expect(html).toContain('data-hierarchy-row="1"');
    expect(html).toContain('data-hierarchy-depth="0"');
    expect(html).toContain('data-hierarchy-row="2"');
    expect(html).toContain('data-hierarchy-depth="1"');
    expect(html).toContain('data-hierarchy-row="3"');
    expect(html).toContain('data-hierarchy-depth="2"');
    expect(html).toContain('data-hierarchy-toggle="1"');
    expect(html).toContain('data-hierarchy-child-count="1"');
    expect(html).toContain('data-hierarchy-add-child="1"');
    expect(html).toContain("添加子记录");
    // Extended field renderers also render inside HierarchyView
    expect(html).toContain("¥1,200.00");
    expect(html).toContain("T-001");
    expect(html).toContain("60%");
  });

  it("offers one-click self-link creation banner when no self-link field exists", () => {
    const html = renderToStaticMarkup(
      <HierarchyView
        baseId={baseId}
        tableId={tableId}
        canEdit
        fields={[titleField, progressField]}
        allFields={[titleField, progressField]}
        records={[makeRec(1, "独立任务")]}
        members={members}
        onChangeParentField={() => {}}
        onMutate={() => {}}
      />,
    );
    expect(html).toContain("data-hierarchy-setup-banner");
    expect(html).toContain("data-hierarchy-create-parent-field");
    expect(html).toContain("创建父任务关联字段");
    expect(html).not.toContain("<select");
  });

  it("shows cycle warning badge when links contain a cycle", () => {
    const html = renderToStaticMarkup(
      <HierarchyView
        baseId={baseId}
        tableId={tableId}
        canEdit={false}
        fields={fields}
        allFields={fields}
        records={[makeRec(1, "A", 2), makeRec(2, "B", 1)]}
        members={members}
        parentFieldId={parentLinkField.id}
        onChangeParentField={() => {}}
        onMutate={() => {}}
      />,
    );
    expect(html).toContain("data-hierarchy-cycle-warning");
    expect(html).toContain("已自动断开循环关联");
    // Readers should not see add-child action buttons
    expect(html).not.toContain("data-hierarchy-add-child");
  });
});
