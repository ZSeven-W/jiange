import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { baseApi, sheetsApi, type BaseRecord, type Field, type SheetSnapshot } from "@/lib/api";
import {
  BaseEmbedPreview,
  SheetEmbedPreview,
  coerceBaseCellInput,
  commitEmbedBaseCellEdit,
  commitEmbedSheetCellEdit,
  createEmbedBaseRecord,
  isBaseFieldInlineEditable,
} from "./embed-block";

const sampleSheetSnapshot: SheetSnapshot = {
  nodeId: 12,
  workspaceId: 1,
  parentId: null,
  title: "Q4 预算表",
  role: "edit",
  creatorId: 1,
  creatorName: "管理员",
  driveRevision: 1,
  workbookRevision: 3,
  updatedAt: "2026-11-23T00:00:00Z",
  sheets: [
    {
      id: 101,
      nodeId: 12,
      title: "总表",
      pos: 0,
      frozenRows: 0,
      frozenCols: 0,
      merges: [],
      filter: {},
      revision: 2,
      rows: [
        { id: 10, pos: 0 },
        { id: 11, pos: 1 },
      ],
      columns: [
        { id: 20, pos: 0 },
        { id: 21, pos: 1 },
      ],
      cells: [
        { rowId: 10, columnId: 20, raw: "项目", revision: 1 },
        { rowId: 10, columnId: 21, raw: "金额", revision: 1 },
        { rowId: 11, columnId: 20, raw: "云服务", revision: 2 },
        { rowId: 11, columnId: 21, raw: "5000", revision: 2 },
      ],
    },
  ],
};

const sampleFields: Field[] = [
  { id: 1, name: "任务", type: "text", position: 0, isPrimary: true },
  { id: 2, name: "预算", type: "number", position: 1 },
  { id: 3, name: "状态", type: "select", position: 2, options: ["待开始", "进行中", "已完成"] },
  { id: 4, name: "合计公式", type: "formula", position: 3, formula: "{预算}*2" },
];

const sampleRecords: BaseRecord[] = [
  { id: 501, baseId: 8, tableId: 3, position: 0, cells: { "1": "重构白板", "2": 1200, "3": "进行中" } },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("interactive inline-editable embedded Sheet & Base cards", () => {
  it("renders editable Sheet preview when writable and hides edit affordances when read-only", () => {
    const editableHtml = renderToStaticMarkup(
      <SheetEmbedPreview
        snapshot={sampleSheetSnapshot}
        activeIndex={0}
        onSelectSheet={() => {}}
        userId={9}
        readOnly={false}
      />,
    );
    expect(editableHtml).toContain('data-embed-editable="true"');
    expect(editableHtml).toContain('data-embed-sheet-cell="1:1"');
    expect(editableHtml).toContain("点击单元格即可编辑");
    expect(editableHtml).toContain("5000");

    const readonlyHtml = renderToStaticMarkup(
      <SheetEmbedPreview
        snapshot={{ ...sampleSheetSnapshot, role: "view" }}
        activeIndex={0}
        onSelectSheet={() => {}}
        userId={9}
        readOnly={false}
      />,
    );
    expect(readonlyHtml).not.toContain('data-embed-editable="true"');
    expect(readonlyHtml).not.toContain("点击单元格即可编辑");

    const docReadonlyHtml = renderToStaticMarkup(
      <SheetEmbedPreview
        snapshot={sampleSheetSnapshot}
        activeIndex={0}
        onSelectSheet={() => {}}
        userId={9}
        readOnly
      />,
    );
    expect(docReadonlyHtml).not.toContain('data-embed-editable="true"');
  });

  it("commits embedded Sheet cell edits via sheetsApi.writeCells and surfaces conflicts", async () => {
    const writeSpy = vi.spyOn(sheetsApi, "writeCells").mockResolvedValue({
      mutationId: "m-1",
      worksheetId: 101,
      workbookRevision: 4,
      cells: [{ rowId: 11, columnId: 21, revision: 3, raw: "6200" }],
      replayed: false,
    });

    const result = await commitEmbedSheetCellEdit({
      sheetId: 12,
      userId: 9,
      worksheetId: 101,
      rowId: 11,
      columnId: 21,
      expectedRevision: 2,
      raw: "6200",
      mutationId: "m-1",
    });

    expect(writeSpy).toHaveBeenCalledWith(12, 9, {
      mutationId: "m-1",
      worksheetId: 101,
      mergeMode: "auto",
      cells: [{ rowId: 11, columnId: 21, expectedRevision: 2, raw: "6200" }],
    });
    expect(result.workbookRevision).toBe(4);

    writeSpy.mockResolvedValueOnce({
      mutationId: "m-2",
      worksheetId: 101,
      workbookRevision: 5,
      cells: [],
      conflicts: [
        {
          rowId: 11,
          columnId: 21,
          row: 1,
          col: 1,
          expectedRevision: 2,
          currentRevision: 4,
          currentRaw: "9999",
          reason: "value_conflict",
        },
      ],
      replayed: false,
    });

    await expect(
      commitEmbedSheetCellEdit({
        sheetId: 12,
        userId: 9,
        worksheetId: 101,
        rowId: 11,
        columnId: 21,
        expectedRevision: 2,
        raw: "7000",
        mutationId: "m-2",
      }),
    ).rejects.toThrow("单元格已被他人修改");
  });

  it("renders editable Base preview with + 新增记录 button and respects read-only state", () => {
    const editableHtml = renderToStaticMarkup(
      <BaseEmbedPreview
        baseId={8}
        activeTableId={3}
        tableName="研发排期"
        tableCount={2}
        fields={sampleFields}
        records={sampleRecords}
        readOnly={false}
      />,
    );
    expect(editableHtml).toContain('data-embed-editable="true"');
    expect(editableHtml).toContain("data-embed-base-add-record");
    expect(editableHtml).toContain("+ 新增记录");
    expect(editableHtml).toContain('data-embed-base-cell="501:1"');
    expect(editableHtml).toContain('title="点击编辑「任务」"');
    expect(editableHtml).toContain('title="点击编辑「预算」"');
    expect(editableHtml).toContain('title="点击编辑「状态」"');
    expect(editableHtml).not.toContain('title="点击编辑「合计公式」"');

    const readonlyHtml = renderToStaticMarkup(
      <BaseEmbedPreview
        baseId={8}
        activeTableId={3}
        tableName="研发排期"
        tableCount={2}
        fields={sampleFields}
        records={sampleRecords}
        readOnly
      />,
    );
    expect(readonlyHtml).not.toContain('data-embed-editable="true"');
    expect(readonlyHtml).not.toContain("data-embed-base-add-record");
  });

  it("validates Base field editability, coerces values, patches cells, and adds records", async () => {
    expect(isBaseFieldInlineEditable(sampleFields[0])).toBe(true);
    expect(isBaseFieldInlineEditable(sampleFields[1])).toBe(true);
    expect(isBaseFieldInlineEditable(sampleFields[2])).toBe(true);
    expect(isBaseFieldInlineEditable(sampleFields[3])).toBe(false);

    expect(coerceBaseCellInput(sampleFields[1], " 350.5 ")).toEqual({ ok: true, value: 350.5 });
    expect(coerceBaseCellInput(sampleFields[1], "")).toEqual({ ok: true, value: null });
    expect(coerceBaseCellInput(sampleFields[1], "not-a-num")).toEqual({ ok: false, error: "请输入有效数字" });
    expect(coerceBaseCellInput(sampleFields[2], "已完成")).toEqual({ ok: true, value: "已完成" });
    expect(coerceBaseCellInput(sampleFields[2], "无效状态")).toEqual({ ok: false, error: "请选择有效选项" });

    const setSpy = vi.spyOn(baseApi, "setCells").mockResolvedValue({
      ...sampleRecords[0],
      cells: { ...sampleRecords[0].cells, "2": 2500 },
    });

    await commitEmbedBaseCellEdit({
      baseId: 8,
      recordId: 501,
      field: sampleFields[1],
      raw: "2500",
    });
    expect(setSpy).toHaveBeenCalledWith(8, 501, { "2": 2500 });

    await expect(
      commitEmbedBaseCellEdit({
        baseId: 8,
        recordId: 501,
        field: sampleFields[1],
        raw: "abc",
      }),
    ).rejects.toThrow("请输入有效数字");
    expect(setSpy).toHaveBeenCalledTimes(1);

    const addSpy = vi.spyOn(baseApi, "addRecord").mockResolvedValue({
      id: 502,
      baseId: 8,
      tableId: 3,
      position: 1,
      cells: {},
    });

    const created = await createEmbedBaseRecord({ baseId: 8, tableId: 3 });
    expect(addSpy).toHaveBeenCalledWith(8, {}, 3);
    expect(created.id).toBe(502);
  });
});
