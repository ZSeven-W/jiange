import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSampleWorkspace } from "./sample-workspace";

const mocks = vi.hoisted(() => ({
  baseCreate: vi.fn(),
  baseGetForAccount: vi.fn(),
  baseBatchDeleteRecords: vi.fn(),
  basePatchField: vi.fn(),
  baseDeleteField: vi.fn(),
  baseAddField: vi.fn(),
  baseAddRecord: vi.fn(),
  baseAddViewForAccount: vi.fn(),
  driveCreateNode: vi.fn(),
  sheetsGet: vi.fn(),
  sheetsWriteCells: vi.fn(),
  sheetsUpdateWorksheet: vi.fn(),
  docsCreate: vi.fn(),
  docsRecordVisit: vi.fn(),
  stageStarter: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  baseApi: {
    create: mocks.baseCreate,
    getForAccount: mocks.baseGetForAccount,
    batchDeleteRecords: mocks.baseBatchDeleteRecords,
    patchField: mocks.basePatchField,
    deleteField: mocks.baseDeleteField,
    addField: mocks.baseAddField,
    addRecord: mocks.baseAddRecord,
    addViewForAccount: mocks.baseAddViewForAccount,
  },
  driveApi: {
    createNode: mocks.driveCreateNode,
  },
  sheetsApi: {
    get: mocks.sheetsGet,
    writeCells: mocks.sheetsWriteCells,
    updateWorksheet: mocks.sheetsUpdateWorksheet,
  },
  docsApi: {
    create: mocks.docsCreate,
    recordVisit: mocks.docsRecordVisit,
  },
}));

vi.mock("./pending-starter", () => ({
  stageStarter: mocks.stageStarter,
}));

describe("createSampleWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.baseCreate.mockResolvedValue({ id: 10 });
    mocks.baseGetForAccount.mockResolvedValue({
      activeTableId: 100,
      fields: [
        { id: 1, name: "Title", type: "text", isPrimary: true },
        { id: 2, name: "Extra", type: "text" },
      ],
      records: [{ id: 500 }],
    });
    let nextFieldId = 10;
    mocks.baseAddField.mockImplementation(async (_id, field) => ({ id: ++nextFieldId, ...field }));
    mocks.driveCreateNode.mockResolvedValue({ id: 20 });
    mocks.sheetsGet.mockResolvedValue({
      sheets: [
        {
          id: 200,
          rows: Array.from({ length: 10 }, (_, idx) => ({ id: 1000 + idx })),
          columns: Array.from({ length: 10 }, (_, idx) => ({ id: 2000 + idx })),
        },
      ],
    });
    mocks.docsCreate.mockResolvedValue({ id: 30 });
    mocks.docsRecordVisit.mockResolvedValue(undefined);
    mocks.stageStarter.mockReturnValue(true);
  });

  it("creates Base, Sheet with valid 32-hex mutationId, and staged Welcome Doc", async () => {
    const res = await createSampleWorkspace(7, "zh-CN");
    expect(res).toEqual({ docId: 30, sheetId: 20, baseId: 10 });
    expect(mocks.baseBatchDeleteRecords).toHaveBeenCalledWith(10, [500]);
    expect(mocks.baseAddRecord).toHaveBeenCalledTimes(4);
    expect(mocks.baseAddViewForAccount).toHaveBeenCalledWith(
      10,
      7,
      expect.objectContaining({ type: "kanban", tableId: 100 }),
    );
    expect(mocks.sheetsWriteCells).toHaveBeenCalledTimes(1);
    const batch = mocks.sheetsWriteCells.mock.calls[0][2];
    expect(batch.mutationId).toMatch(/^[a-f0-9]{32}$/);
    expect(batch.cells.some((c: { raw: string }) => c.raw.startsWith("=SUM("))).toBe(true);
    expect(mocks.sheetsUpdateWorksheet).toHaveBeenCalledWith(
      20,
      200,
      7,
      expect.objectContaining({ frozenRows: 1 }),
    );
    expect(mocks.stageStarter).toHaveBeenCalledWith(7, 30, expect.stringContaining("Jiange"));
  });
});
