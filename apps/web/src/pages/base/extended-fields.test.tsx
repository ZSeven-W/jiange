import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BaseRecord, Field, User, ViewConfig } from "@/lib/api";
import { CellEditor, CellView } from "./cells";
import { buildGroupTree, resolveGroupFieldIds, withGroupsConfig } from "./multi-group";
import { defaultCell } from "./fields";
import { selectionStatistics } from "./selection-statistics";
import { displayValue } from "./registry";

const members: User[] = [
  { id: 1, name: "张三", email: "a@x.com", createdAt: "" },
  { id: 2, name: "李四", email: "b@x.com", createdAt: "" },
];

describe("5 extended field cell views & editors", () => {
  const curF: Field = { id: 1, name: "金额", type: "currency", options: ["USD", "2"], position: 1 };
  const progBar: Field = { id: 2, name: "进度", type: "progress", options: ["bar"], position: 2 };
  const progRing: Field = { id: 3, name: "环形进度", type: "progress", options: ["ring"], position: 3 };
  const progPct: Field = { id: 4, name: "百分比", type: "progress", options: ["percent"], position: 4 };
  const autoF: Field = { id: 5, name: "编号", type: "autonumber", options: ["ORD-", "4"], position: 5 };
  const btnF: Field = { id: 6, name: "操作", type: "button", options: ["打开工单", "open_url", "https://example.com/{编号}"], position: 6 };
  const locF: Field = { id: 7, name: "地点", type: "location", position: 7 };
  const allFields = [curF, progBar, progRing, progPct, autoF, btnF, locF];

  const rec: BaseRecord = {
    id: 9,
    baseId: 1,
    position: 1,
    cells: {
      "1": 1234.5,
      "2": 65,
      "3": 100,
      "4": 40,
      "5": 12,
      "7": "北京市海淀区 | 39.98,116.31",
    },
  };

  it("renders currency, progress (bar/ring/percent), autonumber, button, and location cleanly", () => {
    const curHtml = renderToStaticMarkup(<CellView field={curF} record={rec} members={members} canEdit={false} />);
    expect(curHtml).toContain("data-cell-currency");
    expect(curHtml).toContain("$1,234.50");

    const barHtml = renderToStaticMarkup(<CellView field={progBar} record={rec} members={members} canEdit={false} />);
    expect(barHtml).toContain('data-cell-progress="bar"');
    expect(barHtml).toContain("65%");

    const ringHtml = renderToStaticMarkup(<CellView field={progRing} record={rec} members={members} canEdit={false} />);
    expect(ringHtml).toContain('data-cell-progress="ring"');
    expect(ringHtml).toContain("100%");

    const pctHtml = renderToStaticMarkup(<CellView field={progPct} record={rec} members={members} canEdit={false} />);
    expect(pctHtml).toContain('data-cell-progress="percent"');
    expect(pctHtml).toContain("40%");

    const autoHtml = renderToStaticMarkup(<CellView field={autoF} record={rec} members={members} canEdit={false} />);
    expect(autoHtml).toContain("data-cell-autonumber");
    expect(autoHtml).toContain("ORD-0012");

    const btnHtml = renderToStaticMarkup(<CellView field={btnF} record={rec} members={members} allFields={allFields} canEdit={false} />);
    expect(btnHtml).toContain('data-cell-button="6"');
    expect(btnHtml).toContain("打开工单");

    const locHtml = renderToStaticMarkup(<CellView field={locF} record={rec} members={members} canEdit={false} />);
    expect(locHtml).toContain("data-cell-location");
    expect(locHtml).toContain("北京市海淀区");
    expect(locHtml).toContain("39.98,116.31");
    expect(locHtml).toContain("data-location-map-link");
  });

  it("renders inline editors for currency, progress, and location with ZERO native <select>", () => {
    const curEdit = renderToStaticMarkup(<CellEditor field={curF} record={rec} members={members} onCommit={() => {}} onCancel={() => {}} />);
    expect(curEdit).toContain("data-currency-editor");
    expect(curEdit).toContain("$");
    expect(curEdit).not.toContain("<select");

    const progEdit = renderToStaticMarkup(<CellEditor field={progBar} record={rec} members={members} onCommit={() => {}} onCancel={() => {}} />);
    expect(progEdit).toContain("data-progress-editor");
    expect(progEdit).toContain('type="range"');
    expect(progEdit).not.toContain("<select");

    const locEdit = renderToStaticMarkup(<CellEditor field={locF} record={rec} members={members} onCommit={() => {}} onCancel={() => {}} />);
    expect(locEdit).toContain("data-location-editor");
    expect(locEdit).toContain("北京市海淀区");
    expect(locEdit).toContain("39.98,116.31");
    expect(locEdit).not.toContain("<select");
  });

  it("validates default values and includes currency & progress in selection statistics", () => {
    expect(defaultCell("currency", "99.5", [])).toBe(99.5);
    expect(defaultCell("progress", "50", [])).toBe(50);
    expect(defaultCell("progress", "150", [])).toBeNull();
    expect(defaultCell("location", "上海市", [])).toBe("上海市");
    expect(defaultCell("autonumber", "1", [])).toBeNull();
    expect(defaultCell("button", "x", [])).toBeNull();

    const stats = selectionStatistics(
      { ar: 0, af: 0, rr: 0, rf: 1, rowIds: [9], fieldIds: [1, 2] },
      [rec],
      [curF, progBar],
      (r, f) => displayValue(r, f, members),
    );
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(2);
    expect(stats!.sum).toBe(1299.5);
  });
});

describe("multi-level grouping engine", () => {
  const statusF: Field = { id: 1, name: "状态", type: "select", options: ["待办", "进行中", "完成"], position: 1 };
  const ownerF: Field = { id: 2, name: "负责人", type: "person", position: 2 };
  const locF: Field = { id: 3, name: "城市", type: "location", position: 3 };
  const extraF: Field = { id: 4, name: "额外", type: "text", position: 4 };
  const fields = [statusF, ownerF, locF, extraF];

  it("synchronizes legacy group with groups[0], deduplicates, and caps at 3 levels", () => {
    const legacyCfg: ViewConfig = { group: 1 };
    expect(resolveGroupFieldIds(legacyCfg, fields)).toEqual([1]);

    const multi = withGroupsConfig({}, [1, 2, 1, 3, 4]);
    expect(multi.groups).toEqual([1, 2, 3]);
    expect(multi.group).toBe(1);

    const cleared = withGroupsConfig(multi, []);
    expect(cleared.group).toBeUndefined();
    expect(cleared.groups).toBeUndefined();
  });

  it("builds a 3-level nested group tree with unique collapse paths and accurate counts", () => {
    const records: BaseRecord[] = [
      { id: 1, baseId: 1, position: 1, cells: { "1": "进行中", "2": 1, "3": "北京 | 39.9,116.3" } },
      { id: 2, baseId: 1, position: 2, cells: { "1": "进行中", "2": 1, "3": "上海" } },
      { id: 3, baseId: 1, position: 3, cells: { "1": "待办", "2": 2, "3": "北京" } },
      { id: 4, baseId: 1, position: 4, cells: { "1": "进行中" } },
    ];
    const tree = buildGroupTree(records, [statusF, ownerF, locF], members);
    // Select option order puts "待办" before "进行中".
    expect(tree.map((g) => g.label)).toEqual(["待办", "进行中"]);
    expect(tree[0].records).toHaveLength(1);
    expect(tree[1].records).toHaveLength(3);
    expect(tree[1].children).toHaveLength(2); // 张三 + ungrouped
    const zhangNode = tree[1].children.find((c) => c.label === "张三")!;
    expect(zhangNode.depth).toBe(1);
    expect(zhangNode.records).toHaveLength(2);
    expect(zhangNode.children.map((c) => c.label)).toEqual(["北京", "上海"]);
    expect(zhangNode.children[0].depth).toBe(2);
    expect(zhangNode.children[0].pathKey).toBe("1:进行中/2:1/3:北京 | 39.9,116.3");
  });
});
