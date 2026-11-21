import { describe, expect, it } from "vitest";
import {
  Base,
  createBaseTools,
  evalFormula,
  formulaRefs,
  formulaValid,
  computeSelectionStats,
  matchFillRule,
  isGroupableField,
  computeMetricSummary,
  computeGroupedSeries,
} from "../src/index.js";

describe("@jiange/base-sdk", () => {
  it("evaluates Base [Field] formulas with all operators, functions, short-circuit IF/IFS, and cycle detection", () => {
    expect(formulaValid("ROUND([Price] * [Qty] * (1 - [Discount]), 2)")).toBe(true);
    expect(formulaValid("1 + (")).toBe(false);
    expect(formulaRefs("[Price] + [Tax] + [Price]")).toEqual(["Price", "Tax"]);

    const env = {
      get: (k: string) => ({ Price: 12.5, Qty: 4, Tag: "  Pro Plan  ", Flag: true, Date: "2026-11-21" }[k] ?? null),
    };
    expect(evalFormula("ABS(-5) + FLOOR(3.9) + CEILING(3.1) + INT(2.9) + POW(2, 3) + SQRT(9) + MOD(10, 3)", env)).toBe(26);
    expect(evalFormula("MIN(3, 1, 5) + MAX(3, 1, 5) + SUM(2, 4) + AVERAGE(2, 4)", env)).toBe(15);
    expect(evalFormula('IF([Flag], UPPER(TRIM([Tag])), LOWER("NO"))', env)).toBe("PRO PLAN");
    expect(evalFormula('IFS([Qty] < 2, "S", [Qty] < 5, "M", "L")', env)).toBe("M");
    expect(evalFormula("AND(TRUE, NOT(FALSE), OR(FALSE, TRUE), ISBLANK(BLANK()))", env)).toBe(true);
    expect(evalFormula('CONCATENATE(LEFT("Hello", 2), MID("abcdef", 2, 2), RIGHT("World", 2)) & LEN("你好")', env)).toBe("Hebcld2");
    expect(evalFormula('CONTAINS("jiange-sdk", "sdk")', env)).toBe(true);
    expect(evalFormula('VALUE("42") + YEAR([Date]) + MONTH([Date]) + DAY([Date])', env)).toBe(2100);
    expect(evalFormula("2 ^ 3 ^ 2", env)).toBe(512);
    expect(evalFormula("10 != 20", env)).toBe(true);
    expect(evalFormula('"a" < "b"', env)).toBe(true);
    expect(typeof evalFormula("TODAY()", env)).toBe("string");
    expect(typeof evalFormula("NOW()", env)).toBe("string");
    expect(evalFormula("TEXT(123)", env)).toBe("123");
    expect(() => evalFormula("1 / 0", env)).toThrow("#DIV/0!");
    expect(() => evalFormula("SQRT(-1)", env)).toThrow("#NUM?");
    expect(() => evalFormula("NO_SUCH_FN(1)", env)).toThrow("#NAME?");
  });

  it("manages multi-table schemas, formulas, link/lookup resolution, views, dashboard, CSV, undo/redo & AI tools", () => {
    const base = Base.create({ name: "CRM", defaultTableName: "Accounts" });
    expect(base.getName()).toBe("CRM");
    expect(base.version).toBe(1);
    expect(base.undo()).toBe(false);
    expect(base.redo()).toBe(false);

    const accountsId = base.getTables()[0].id;
    base.addField(accountsId, { name: "Tier", type: "select", options: ["Enterprise", "Startup"] });
    const acct1 = base.addRecord(accountsId, { Name: "Acme Corp", Tier: "Enterprise" });
    const acct2 = base.addRecord(accountsId, { Name: "Beta Labs", Tier: "Startup" });

    // Create Deals table with link + lookup + formula + checkbox + date
    const deals = base.createTable("Deals");
    const titleF = base.addField(deals.id, { name: "Deal", type: "text", isPrimary: true });
    const statusF = base.addField(deals.id, { name: "Stage", type: "select", options: ["Open", "Won", "Lost"], defaultValue: "Open" });
    const amtF = base.addField(deals.id, { name: "Amount", type: "number" });
    const taxF = base.addField(deals.id, { name: "Total", type: "formula", formula: "ROUND([Amount] * 1.1, 2)" });
    const doneF = base.addField(deals.id, { name: "Closed", type: "checkbox", defaultValue: false });
    const dateF = base.addField(deals.id, { name: "CloseDate", type: "date" });
    const linkF = base.addField(deals.id, { name: "Account", type: "link", targetTableId: accountsId });
    const tierFieldOnAccounts = base.getFields(accountsId).find((f) => f.name === "Tier")!;
    const lookupF = base.addField(deals.id, {
      name: "AccountTier",
      type: "lookup",
      linkFieldId: linkF.id,
      lookupFieldId: tierFieldOnAccounts.id,
    });
    expect(isGroupableField(statusF)).toBe(true);

    // Dry run & atomic rollback
    const dry = base.apply([{ op: "addRecord", tableId: deals.id, cells: { Deal: "Ghost" } }], { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.undoToken).toBeNull();
    expect(base.getRecords(deals.id)).toHaveLength(0);

    const fail = base.apply([
      { op: "addRecord", tableId: deals.id, cells: { Deal: "Temp" } },
      { op: "deleteRecord", recordId: 99999 },
    ]);
    expect(fail.ok).toBe(false);
    expect(base.getRecords(deals.id)).toHaveLength(0);

    // Add deals (by field name!)
    const r1 = base.addRecord(deals.id, { Deal: "Global Expansion", Stage: "Won", Amount: 1000, Closed: true, CloseDate: "2026-10-01", Account: [acct1.id] });
    const r2 = base.addRecord(deals.id, { Deal: "Pilot", Amount: 250, CloseDate: "2026-11-15", Account: [acct2.id] });
    expect(r1.cells[String(taxF.id)]).toBe(1100);
    expect(r1.cells[String(lookupF.id)]).toBe("Enterprise");
    expect(r2.cells[String(statusF.id)]).toBe("Open"); // defaultValue applied!

    // Update record & verify
    const updated = base.updateRecord(r2.id, { Amount: 300, Stage: "Won", Closed: true });
    expect(updated.cells[String(taxF.id)]).toBe(330);

    // Views, filters (AND/OR), sort, groupBy, fill rules, stats
    base.apply([
      {
        op: "addView",
        tableId: deals.id,
        name: "Won Deals",
        type: "grid",
        config: {
          filters: { conj: "and", rules: [{ f: statusF.id, op: "eq", v: "Won" }, { f: amtF.id, op: "gte", v: 300 }] },
          sorts: [{ f: amtF.id, asc: false }],
          group: statusF.id,
        },
      },
    ]);
    const viewId = base.getViews(deals.id)[0].id;
    const viewRes = base.queryView(viewId);
    expect(viewRes.total).toBe(2);
    expect(viewRes.records[0].cells[String(titleF.id)]).toBe("Global Expansion");
    expect(viewRes.groups).toHaveLength(1);

    // Match fill rule & selection stats
    expect(matchFillRule(r1, [{ f: amtF.id, op: "gt", v: 500, color: 3 }])).toBe(3);
    expect(matchFillRule(r1, [{ f: amtF.id, op: "lt", v: 100, color: 1 }])).toBeNull();
    const stats = computeSelectionStats([1000, 300, undefined, ""]);
    expect(stats.sum).toBe(1300);
    expect(stats.avg).toBe(650);
    expect(stats.empty).toBe(2);

    // Dashboard evaluation (auto + custom widgets)
    const dash = base.evaluateDashboard(undefined, deals.id);
    expect(dash.length).toBeGreaterThanOrEqual(4);
    expect(dash[0].metric?.value).toBe(2);
    expect(dash.some((d) => d.series && d.series.buckets.length > 0)).toBe(true);
    expect(dateF.type).toBe("date");
    expect(doneF.type).toBe("checkbox");

    // CSV round-trip
    const csv = base.toCsv(deals.id);
    expect(csv).toContain("Global Expansion");
    expect(csv).toContain("1100");
    const imported = Base.fromCsv("Title,Score,Active,Due\nAlpha,95,true,2026-12-01\n\"Beta, Inc\",80,false,2026-12-05");
    expect(imported.getRecords()).toHaveLength(2);
    expect(imported.getFields().map((f) => f.type)).toEqual(["text", "number", "checkbox", "date"]);

    // Snapshot round-trip
    const restored = Base.fromJSON(base.toJSON());
    expect(restored.getTables()).toHaveLength(2);

    // Undo / Redo + AI tools
    const runtime = createBaseTools(base);
    expect(runtime.tools).toHaveLength(8);
    expect((runtime.execute("base_inspect", { detail: "full", tableId: deals.id }) as { tableCount: number }).tableCount).toBe(2);
    expect((runtime.execute("base_query", { tableId: deals.id, search: "Global", limit: 1 }) as { records: unknown[] }).records).toHaveLength(1);
    expect((runtime.execute("base_verify") as unknown[])).toEqual([]);
    expect((runtime.execute("base_dashboard", { tableId: deals.id }) as unknown[]).length).toBeGreaterThan(0);
    expect((runtime.execute("base_export_csv", { tableId: deals.id }) as { csv: string }).csv).toContain("Enterprise");
    expect((runtime.execute("base_apply", { ops: [{ op: "deleteRecord", recordId: r2.id }] }) as { ok: boolean }).ok).toBe(true);
    expect((runtime.execute("base_undo") as { undone: boolean }).undone).toBe(true);
    expect((runtime.execute("base_redo") as { redone: boolean }).redone).toBe(true);
    expect(() => runtime.execute("unknown")).toThrow();
  });

  it("detects schema and formula issues in verify()", () => {
    const empty = Base.create({ empty: true });
    expect(empty.verify()[0].code).toBe("EMPTY_BASE");

    const base = Base.create({ name: "Audit" });
    const tid = base.getTables()[0].id;
    base.apply([
      { op: "updateField", fieldId: 1, patch: { isPrimary: false } },
      { op: "addField", tableId: tid, field: { name: "Name", type: "text" } },
      { op: "addField", tableId: tid, field: { name: "BadF", type: "formula", formula: "1 + (" } },
      { op: "addField", tableId: tid, field: { name: "CycA", type: "formula", formula: "[CycB] + 1" } },
      { op: "addField", tableId: tid, field: { name: "CycB", type: "formula", formula: "[CycA] + 1" } },
      { op: "addField", tableId: tid, field: { name: "BadLink", type: "link", targetTableId: 999 } },
      { op: "addField", tableId: tid, field: { name: "BadLookup", type: "lookup", linkFieldId: 999, lookupFieldId: 1 } },
      { op: "addField", tableId: tid, field: { name: "Tag", type: "select", options: ["A", "B"] } },
      { op: "addRecord", tableId: tid, cells: { Tag: "UnknownOption" } },
    ]);

    const codes = new Set(base.verify().map((d) => d.code));
    expect(codes.has("MISSING_PRIMARY_FIELD")).toBe(true);
    expect(codes.has("DUPLICATE_FIELD_NAME")).toBe(true);
    expect(codes.has("INVALID_FORMULA")).toBe(true);
    expect(codes.has("FORMULA_CYCLE")).toBe(true);
    expect(codes.has("BROKEN_LINK_TARGET")).toBe(true);
    expect(codes.has("BROKEN_LOOKUP_CONFIG")).toBe(true);
    expect(codes.has("INVALID_SELECT_OPTION")).toBe(true);

    // Cycle formula evaluates cleanly to #CYCLE without hanging
    const rec = base.getRecords(tid)[0];
    const cycA = base.getFields(tid).find((f) => f.name === "CycA")!;
    expect(rec.cells[String(cycA.id)]).toBe("#CYCLE");
  });

  it("covers all filter operators, dashboard metrics (avg/min/max/checked_pct), multi_select, rename/delete table & field", () => {
    const base = Base.create({ name: "Analytics" });
    const tid = base.getTables()[0].id;
    const scoreF = base.addField(tid, { name: "Score", type: "number" });
    const tagsF = base.addField(tid, { name: "Tags", type: "multi_select", options: ["AI", "GPU", "Go"] });
    const doneF = base.addField(tid, { name: "Done", type: "checkbox" });
    const noteF = base.addField(tid, { name: "Note", type: "text" });

    base.addRecord(tid, { Name: "Item 1", Score: 10, Tags: ["AI", "GPU"], Done: true, Note: "hello, \"world\"" });
    base.addRecord(tid, { Name: "Item 2", Score: 30, Tags: ["Go"], Done: false });
    base.addRecord(tid, { Name: "Item 3", Score: 20, Tags: [], Done: true, Note: "fast" });

    // All filter ops + OR conjunction
    expect(base.query({ tableId: tid, filters: { conj: "or", rules: [{ f: scoreF.id, op: "lte", v: 10 }, { f: scoreF.id, op: "gt", v: 25 }] } }).total).toBe(2);
    expect(base.query({ tableId: tid, filters: { conj: "and", rules: [{ f: noteF.id, op: "is_empty" }] } }).total).toBe(1);
    expect(base.query({ tableId: tid, filters: { conj: "and", rules: [{ f: noteF.id, op: "is_not_empty" }] } }).total).toBe(2);
    expect(base.query({ tableId: tid, filters: { conj: "and", rules: [{ f: tagsF.id, op: "contains", v: ["AI"] }] } }).total).toBe(1);
    expect(base.query({ tableId: tid, filters: { conj: "and", rules: [{ f: tagsF.id, op: "not_contains", v: ["Go"] }] } }).total).toBe(2);
    expect(base.query({ tableId: tid, filters: { conj: "and", rules: [{ f: tagsF.id, op: "in", v: ["GPU", "Go"] }] } }).total).toBe(2);
    expect(base.query({ tableId: tid, filters: { conj: "and", rules: [{ f: scoreF.id, op: "neq", v: 20 }] } }).total).toBe(2);

    // Dashboard metrics: avg, min, max, checked_pct + multi_select groupBy
    const recs = base.getRecords(tid);
    const fields = base.getFields(tid);
    expect(computeMetricSummary(recs, { id: "m1", type: "metric", title: "Avg", span: 1, metric: "avg", valueFieldId: scoreF.id }).value).toBe(20);
    expect(computeMetricSummary(recs, { id: "m2", type: "metric", title: "Min", span: 1, metric: "min", valueFieldId: scoreF.id }).value).toBe(10);
    expect(computeMetricSummary(recs, { id: "m3", type: "metric", title: "Max", span: 1, metric: "max", valueFieldId: scoreF.id }).value).toBe(30);
    expect(computeMetricSummary(recs, { id: "m4", type: "metric", title: "Pct", span: 1, metric: "checked_pct", valueFieldId: doneF.id }).progressPct).toBeCloseTo(66.67, 1);
    expect(computeGroupedSeries(recs, fields, { id: "g1", type: "bar", title: "Tags", span: 1, groupFieldId: tagsF.id, metric: "avg", valueFieldId: scoreF.id }).buckets.length).toBeGreaterThanOrEqual(3);
    expect(computeGroupedSeries(recs, fields, { id: "g2", type: "bar", title: "Tags Min", span: 1, groupFieldId: tagsF.id, metric: "min", valueFieldId: scoreF.id }).buckets.length).toBeGreaterThanOrEqual(3);
    expect(computeGroupedSeries(recs, fields, { id: "g3", type: "bar", title: "Tags Max", span: 1, groupFieldId: tagsF.id, metric: "max", valueFieldId: scoreF.id }).buckets.length).toBeGreaterThanOrEqual(3);
    expect(computeGroupedSeries(recs, fields, { id: "g4", type: "bar", title: "Tags Pct", span: 1, groupFieldId: tagsF.id, metric: "checked_pct", valueFieldId: doneF.id }).buckets.length).toBeGreaterThanOrEqual(3);

    // Selection stats with booleans
    const bStats = computeSelectionStats([true, false, true]);
    expect(bStats.checkedCount).toBe(2);

    // CSV quoting with commas & quotes
    const csv = base.toCsv(tid);
    expect(csv).toContain('"hello, ""world"""');

    // Table rename, field delete, table delete
    const t2 = base.createTable("Scratch");
    const res = base.apply([
      { op: "renameTable", tableId: t2.id, name: "TempRenamed" },
      { op: "deleteField", fieldId: noteF.id },
      { op: "deleteTable", tableId: t2.id },
    ]);
    expect(res.ok).toBe(true);
    expect(base.getTables()).toHaveLength(1);

    // AI tool explicit optional args
    const rt = createBaseTools(base);
    expect((rt.execute("base_inspect", { detail: "summary", maxTokens: 500 }) as { tableCount: number }).tableCount).toBe(1);
    expect((rt.execute("base_query", { tableId: tid, sorts: [{ f: scoreF.id, asc: true }], groupBy: doneF.id, offset: 0, limit: 10 }) as { total: number }).total).toBe(3);
    expect((rt.execute("base_apply", { ops: [], dryRun: true, atomic: false, actor: "agent" }) as { ok: boolean }).ok).toBe(true);
    expect((rt.execute("base_export_csv", { tableId: tid, delimiter: "\t" }) as { csv: string }).csv).toContain("\t");
  });
});
