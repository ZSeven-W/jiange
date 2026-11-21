import { describe, expect, it } from "vitest";
import { createSheetTools } from "../src/ai-tools.js";
import { computePivotTable, detectDataTableRange, extractChartDataset, pivotResultToCellMatrix } from "../src/analytics.js";
import { applyRemoteCellDelta, buildConflictResolutionWrite, formatSheetRect, remoteCollaboratorBounds, toSheetStylePatch } from "../src/collab.js";
import { evaluateSheetConditionalFormat, evaluateSheetValidation, findSheetDropdown, isSheetCellProtected } from "../src/rules.js";
import { Workbook } from "../src/workbook.js";
import { exportWorkbookToXlsxAsync, parseXlsxBytesForWorkbook } from "../src/workbook-xlsx.js";
import { createFormulaWorkerHost, FormulaWorkerClient, type FormulaWorkerRequest, type MessagePortLike } from "../src/worker.js";

describe("Workbook Facade, AI-Native Loop, Analytics, Rules, Collab, and Worker", () => {
  it("runs a full AI Agent closed loop: inspect -> query -> dryRun apply -> apply -> verify -> undo -> export", async () => {
    const wb = Workbook.fromCsv("Region,Product,Units,Price\nEast,Alpha,10,25\nWest,Beta,5,40\nEast,Gamma,8,30\n", "Sales");
    const toolkit = createSheetTools(wb);
    expect(toolkit.tools.map((t) => t.name)).toContain("sheet_apply");

    // 1. Inspect within a tight token budget
    const inspected = toolkit.execute("sheet_inspect", { detail: "summary", maxTokens: 1200 }) as ReturnType<Workbook["inspect"]>;
    expect(inspected.kind).toBe("sheet");
    expect(inspected.promptText).toContain("Sales");
    expect(inspected.summary.sheets[0].headers).toEqual(["Region", "Product", "Units", "Price"]);
    expect(inspected.estimatedTokens).toBeLessThanOrEqual(1200);

    // 2. Dry-run apply previews diff without mutating
    const dry = toolkit.execute("sheet_apply", {
      dryRun: true,
      ops: [
        { op: "setCells", sheet: "Sales", cells: [
          { a1: "E1", raw: "Revenue", style: { bold: true, bg: "#eef3ff" } },
          { a1: "E2", raw: "=C2*D2" },
          { a1: "E3", raw: "=C3*D3" },
          { a1: "E4", raw: "=C4*D4" },
          { a1: "E5", raw: "=SUM(E2:E4)" },
        ] },
      ],
    }) as ReturnType<Workbook["apply"]>;
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    expect(dry.diff.cellChanges.find((c) => c.a1 === "E5")?.afterValue).toBe("690");
    expect(wb.sheet("Sales").getValue("E5")).toBeNull(); // untouched!

    // 3. Real atomic apply + chart + validation + conditional format + defined name
    const applied = toolkit.execute("sheet_apply", {
      reason: "Add revenue formulas and summary chart",
      ops: [
        { op: "defineName", name: "BonusRate", ref: "0.1" },
        { op: "setCells", sheet: "Sales", cells: [
          { a1: "E1", raw: "Revenue", style: { bold: true, numFmt: "currency" } },
          { a1: "E2", raw: "=C2*D2", style: { numFmt: "currency" } },
          { a1: "E3", raw: "=C3*D3", style: { numFmt: "currency" } },
          { a1: "E4", raw: "=C4*D4", style: { numFmt: "currency" } },
          { a1: "E5", raw: "=SUM(E2:E4)" },
          { a1: "F2", raw: "=E2*BonusRate" },
        ] },
        { op: "addValidation", sheet: "Sales", range: "A2:A4", type: "list", options: ["East", "West"], strict: true },
        { op: "addConditionalFormat", sheet: "Sales", range: "E2:E4", ruleOp: "gte", value1: "240", bg: "#dcfce7", bold: true },
        { op: "addChart", sheet: "Sales", title: "Revenue", chartType: "column", range: "A1:E4" },
        { op: "setFreeze", sheet: "Sales", rows: 1, cols: 0 },
        { op: "resize", sheet: "Sales", colWidths: { 0: 140 }, rowHeights: { 0: 32 } },
      ],
    }) as ReturnType<Workbook["apply"]>;
    expect(applied.ok).toBe(true);
    expect(applied.diagnostics).toEqual([]);
    expect(applied.undoToken).toBeTruthy();
    expect(wb.sheet("Sales").getValue("E5")).toBe(690);
    expect(wb.sheet("Sales").getValue("F2")).toBe(25);

    // 4. Query formulas only
    const formulaQuery = toolkit.execute("sheet_query", { sheet: "Sales", onlyFormulas: true }) as ReturnType<Workbook["query"]>;
    expect(formulaQuery.totalMatched).toBe(5);

    // 5. Introduce a formula error + validation error -> verify catches both with suggestions
    wb.apply([
      { op: "setCells", sheet: "Sales", cells: [{ a1: "G2", raw: "=1/0" }, { a1: "A2", raw: "North" }] },
    ]);
    const verified = toolkit.execute("sheet_verify") as { diagnostics: ReturnType<Workbook["verify"]> };
    expect(verified.diagnostics.some((d) => d.code === "formula_div0" && d.suggestion?.includes("IFERROR"))).toBe(true);
    expect(verified.diagnostics.some((d) => d.code === "validation_violation" && d.target === "Sales!A2")).toBe(true);

    // 6. Undo rolls back cleanly
    const undone = toolkit.execute("sheet_undo") as { ok: boolean };
    expect(undone.ok).toBe(true);
    expect(wb.verify()).toEqual([]);
    expect(wb.redo()).toBe(true);
    expect(wb.verify().length).toBeGreaterThan(0);
    expect(wb.undo()).toBe(true);

    // 7. Atomic rollback when an op fails mid-batch
    const badBatch = wb.apply([
      { op: "setCells", sheet: "Sales", cells: [{ a1: "A10", raw: "temp" }] },
      { op: "deleteSheet", name: "NonExistent" },
    ]);
    expect(badBatch.ok).toBe(false);
    expect(wb.sheet("Sales").getValue("A10")).toBeNull();

    // 8. Round-trip compressed XLSX & CSV export
    const csvOut = (toolkit.execute("sheet_export_csv", { sheet: "Sales" }) as { csv: string }).csv;
    expect(csvOut).toContain("Revenue");
    const xlsxBytes = await wb.toXlsxAsync();
    const reloaded = await Workbook.fromXlsx(xlsxBytes);
    expect(reloaded.workbook.sheet("Sales").getValue("E5")).toBe(690);

    // Workbook-xlsx preview parser
    const snap = wb.toSnapshot();
    const preview = await parseXlsxBytesForWorkbook(await exportWorkbookToXlsxAsync(snap.sheets));
    expect(preview.sheets[0].title).toBe("Sales");
    expect(preview.sheets[0].colWidths?.[0]).toBeGreaterThan(0);
  });

  it("supports sheets management, rules, charts, pivot tables, collab deltas, and Web Worker bridge", async () => {
    const wb = Workbook.create({ sheets: [{ name: "Data", rows: 20, cols: 8 }] });
    wb.sheet("Data").setRange("A1", [
      ["Dept", "Quarter", "Revenue"],
      ["Eng", "Q1", 100],
      ["Sales", "Q1", 200],
      ["Eng", "Q2", 150],
    ]);
    wb.addSheet("Summary").setCell("A1", "=SUM(Data!C2:C4)");
    expect(wb.sheet("Summary").getValue("A1")).toBe(450);
    wb.renameSheet("Summary", "Total");
    expect(wb.listSheets()).toEqual(["Data", "Total"]);
    wb.deleteSheet("Total");
    expect(wb.listSheets()).toEqual(["Data"]);

    const snap = wb.toSnapshot();
    const ws = snap.sheets[0];
    const evalMap = wb._getSheetEvalMap(ws.id);

    // Analytics: detect range, chart dataset, pivot computation & materialization
    const rect = detectDataTableRange(ws, evalMap, { top: 0, left: 0, bottom: 0, right: 0 });
    expect(rect).toEqual({ top: 0, left: 0, bottom: 3, right: 2 });
    const chartDs = extractChartDataset(ws, evalMap, { ...rect, headerRow: true });
    expect(chartDs.series[0].values).toEqual([100, 200, 150]);
    const pivotSpec = { id: "p1", title: "By Dept", ...rect, rowFields: [0], colField: 1, values: [{ col: 2, agg: "sum" as const }], showRowTotals: true, showColTotals: true };
    const pivot = computePivotTable(ws, evalMap, pivotSpec);
    expect(pivot.rows).toHaveLength(2);
    expect(pivotResultToCellMatrix(pivotSpec, pivot).length).toBeGreaterThan(4);

    // Rules: validation, dropdown, conditional format, protected range
    const validations = [{ id: "v1", top: 1, left: 0, bottom: 3, right: 0, type: "list" as const, options: ["Eng", "Sales"], strict: true }];
    expect(findSheetDropdown(validations, 1, 0)?.id).toBe("v1");
    expect(evaluateSheetValidation("HR", validations, 1, 0).valid).toBe(false);
    expect(evaluateSheetConditionalFormat("200", { kind: "number", value: 200 }, [{ id: "c1", top: 0, left: 0, bottom: 5, right: 5, op: "between", value1: "150", value2: "250", bg: "#dcfce7", bold: true }], 2, 2)?.bg).toBe("#dcfce7");
    expect(isSheetCellProtected([{ id: "pr1", top: 0, left: 0, bottom: 3, right: 2, allowedUserIds: [2] }], 1, 1, 3, "edit").blocked).toBe(true);
    expect(isSheetCellProtected([{ id: "pr1", top: 0, left: 0, bottom: 3, right: 2, allowedUserIds: [2] }], 1, 1, 3, "manage").blocked).toBe(false);

    // Collab delta & conflict resolution
    expect(formatSheetRect(remoteCollaboratorBounds({ userId: 1, name: "A", worksheetId: 1, row: 2, col: 3, anchorRow: 0, anchorCol: 1 }))).toBe("B1:D3");
    expect(toSheetStylePatch({ bold: true, borders: undefined })).toEqual({ bold: true, clearBorders: true });
    const fullSnap = { nodeId: 1, workspaceId: 1, parentId: null, title: "T", role: "edit", creatorId: 1, creatorName: "U", driveRevision: 1, workbookRevision: 1, sheets: snap.sheets, updatedAt: "" };
    const patched = applyRemoteCellDelta(fullSnap, ws.id, 2, [{ rowId: ws.rows[1].id, columnId: ws.columns[2].id, revision: 5, raw: "999" }]);
    expect(patched?.workbookRevision).toBe(2);
    expect(buildConflictResolutionWrite({ rowId: 1, columnId: 1, row: 0, col: 0, expectedRevision: 1, currentRevision: 2, currentRaw: "a", attemptedRaw: "b", reason: "value_conflict" }, "mine")?.expectedRevision).toBe(2);

    // Worker protocol round-trip
    const host = createFormulaWorkerHost();
    let clientHandler: ((ev: { data: unknown }) => void) | null = null;
    const mockPort: MessagePortLike = {
      postMessage(msg) {
        const resp = host(msg as FormulaWorkerRequest);
        queueMicrotask(() => clientHandler?.({ data: resp }));
      },
      addEventListener(_type, fn) { clientHandler = fn; },
      removeEventListener() { clientHandler = null; },
    };
    const workerClient = new FormulaWorkerClient(mockPort);
    const loaded = await workerClient.load(snap.sheets);
    expect(loaded[ws.id]["1:2"]).toEqual({ kind: "number", value: 100 });
    const upd = await workerClient.update(ws.id, [{ row: 4, col: 2, raw: "=SUM(C2:C4)" }]);
    expect(upd.patch["4:2"]).toEqual({ kind: "number", value: 450 });
    const fetched = await workerClient.getSheet(ws.id);
    expect(fetched["4:2"]).toEqual({ kind: "number", value: 450 });
    workerClient.dispose();
  });
});
