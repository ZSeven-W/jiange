/**
 * AI-Native `Base` Facade for `@jiange/base-sdk`.
 *
 * Manages multiple tables, typed fields, records (with live formula + link/lookup evaluation),
 * saved views, dashboard widgets, CSV/TSV I/O, undo/redo, token-budgeted `inspect()`,
 * `query()`, atomic `apply(ops, { dryRun, atomic })`, and structural `verify()` diagnostics.
 */

import { exportTableToCsv, parseCsvToTableData } from "./csv.js";
import { computeGroupedSeries, computeMetricSummary, defaultDashboardWidgets, type GroupedSeries, type MetricSummary } from "./dashboard.js";
import { evalRecordFormulas, formulaRefs, formulaValid } from "./formula.js";
import { queryRecords, type QueryRecordsOptions, type QueryRecordsResult } from "./query.js";
import type {
  BaseCell,
  BaseField,
  BaseRecord,
  BaseSnapshot,
  BaseTable,
  BaseView,
  BaseViewType,
  DashboardWidget,
  FieldType,
  ViewConfig,
} from "./types.js";

export type BaseDiagnosticSeverity = "error" | "warning" | "info";

export interface BaseDiagnostic {
  code:
    | "EMPTY_BASE"
    | "MISSING_PRIMARY_FIELD"
    | "DUPLICATE_FIELD_NAME"
    | "INVALID_FORMULA"
    | "FORMULA_CYCLE"
    | "BROKEN_LINK_TARGET"
    | "BROKEN_LOOKUP_CONFIG"
    | "INVALID_SELECT_OPTION";
  severity: BaseDiagnosticSeverity;
  tableId?: number;
  fieldId?: number;
  recordId?: number;
  message: string;
  suggestion: string;
}

export type BaseOp =
  | { op: "createTable"; name: string }
  | { op: "renameTable"; tableId: number; name: string }
  | { op: "deleteTable"; tableId: number }
  | {
      op: "addField";
      tableId?: number;
      field: {
        name: string;
        type: FieldType;
        isPrimary?: boolean;
        options?: string[];
        formula?: string;
        targetTableId?: number;
        linkFieldId?: number;
        lookupFieldId?: number;
        defaultValue?: BaseCell | null;
        multiple?: boolean;
        description?: string;
      };
    }
  | { op: "updateField"; fieldId: number; patch: Partial<Omit<BaseField, "id" | "tableId">> }
  | { op: "deleteField"; fieldId: number }
  | { op: "addRecord"; tableId?: number; cells: Record<string, BaseCell> }
  | { op: "updateRecord"; recordId: number; cells: Record<string, BaseCell | null> }
  | { op: "deleteRecord"; recordId: number }
  | { op: "addView"; tableId?: number; name: string; type: BaseViewType; config?: ViewConfig };

export interface BaseApplyOptions {
  dryRun?: boolean;
  atomic?: boolean;
  actor?: string;
}

export interface BaseApplyResult {
  ok: boolean;
  applied: number;
  undoToken: string | null;
  diff: Array<{ op: BaseOp["op"]; detail: string }>;
  errors: string[];
}

export interface BaseInspectOptions {
  detail?: "summary" | "standard" | "full";
  maxTokens?: number;
  tableId?: number;
}

export interface BaseInspectResult {
  name: string;
  tableCount: number;
  truncated: boolean;
  tables: Array<{
    id: number;
    name: string;
    fieldCount: number;
    recordCount: number;
    viewCount: number;
    fields?: Array<{ id: number; name: string; type: FieldType; isPrimary?: boolean; options?: string[]; formula?: string }>;
    sampleRecords?: Array<{ id: number; cells: Record<string, BaseCell> }>;
  }>;
}

function cloneSnapshot(snap: BaseSnapshot): BaseSnapshot {
  return {
    name: snap.name,
    tables: snap.tables.map((t) => ({ ...t })),
    fields: snap.fields.map((f) => ({
      ...f,
      options: f.options ? [...f.options] : undefined,
      optionColors: f.optionColors ? [...f.optionColors] : undefined,
    })),
    records: snap.records.map((r) => ({
      ...r,
      cells: Object.fromEntries(
        Object.entries(r.cells).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
      ) as Record<string, BaseCell>,
    })),
    views: snap.views.map((v) => ({
      ...v,
      config: JSON.parse(JSON.stringify(v.config)) as ViewConfig,
    })),
  };
}

export class Base {
  private name: string;
  private tables: BaseTable[];
  private fields: BaseField[];
  private records: BaseRecord[];
  private views: BaseView[];
  private nextTableId = 1;
  private nextFieldId = 1;
  private nextRecordId = 1;
  private nextViewId = 1;
  private undoStack: Array<{ token: string; snapshot: BaseSnapshot }> = [];
  private redoStack: BaseSnapshot[] = [];
  private undoSeq = 1;
  private versionCounter = 1;

  private constructor(snap: BaseSnapshot) {
    const cloned = cloneSnapshot(snap);
    this.name = cloned.name;
    this.tables = cloned.tables;
    this.fields = cloned.fields;
    this.records = cloned.records;
    this.views = cloned.views;
    for (const t of this.tables) if (t.id >= this.nextTableId) this.nextTableId = t.id + 1;
    for (const f of this.fields) if (f.id >= this.nextFieldId) this.nextFieldId = f.id + 1;
    for (const r of this.records) if (r.id >= this.nextRecordId) this.nextRecordId = r.id + 1;
    for (const v of this.views) if (v.id >= this.nextViewId) this.nextViewId = v.id + 1;
  }

  static create(options?: { name?: string; defaultTableName?: string; empty?: boolean }): Base {
    const name = options?.name?.trim() || "Untitled Base";
    if (options?.empty) {
      return new Base({ name, tables: [], fields: [], records: [], views: [] });
    }
    const table: BaseTable = {
      id: 1,
      baseId: 1,
      name: options?.defaultTableName?.trim() || "Table 1",
      position: 1000,
      isDefault: true,
    };
    const primaryField: BaseField = {
      id: 1,
      tableId: 1,
      name: "Name",
      type: "text",
      isPrimary: true,
      position: 1000,
    };
    const gridView: BaseView = {
      id: 1,
      baseId: 1,
      tableId: 1,
      type: "grid",
      name: "Grid View",
      config: {},
      pos: 1000,
    };
    return new Base({ name, tables: [table], fields: [primaryField], records: [], views: [gridView] });
  }

  static fromJSON(snapshot: BaseSnapshot): Base {
    return new Base(snapshot);
  }

  static fromCsv(csvText: string, options?: { name?: string; tableName?: string; delimiter?: string }): Base {
    const parsed = parseCsvToTableData(csvText, options?.delimiter ?? ",");
    const base = Base.create({ name: options?.name ?? "CSV Import", empty: true });
    const table = base.createTable(options?.tableName ?? "Imported Table");
    const fieldIds = new Map<string, number>();
    for (const f of parsed.fields) {
      const created = base.addField(table.id, { name: f.name, type: f.type, isPrimary: f.isPrimary });
      fieldIds.set(f.name, created.id);
    }
    for (const row of parsed.rows) {
      const cells: Record<string, BaseCell> = {};
      for (const [colName, val] of Object.entries(row)) {
        const fid = fieldIds.get(colName);
        if (fid !== undefined) cells[String(fid)] = val;
      }
      base.addRecord(table.id, cells);
    }
    // Clear import history so caller starts fresh
    base.undoStack = [];
    base.redoStack = [];
    return base;
  }

  private capture(): BaseSnapshot {
    return cloneSnapshot({
      name: this.name,
      tables: this.tables,
      fields: this.fields,
      records: this.records,
      views: this.views,
    });
  }

  private restore(snap: BaseSnapshot): void {
    const cloned = cloneSnapshot(snap);
    this.name = cloned.name;
    this.tables = cloned.tables;
    this.fields = cloned.fields;
    this.records = cloned.records;
    this.views = cloned.views;
    this.versionCounter++;
  }

  private pushUndo(before: BaseSnapshot): string {
    const token = `base-undo-${this.undoSeq++}`;
    this.undoStack.push({ token, snapshot: before });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.versionCounter++;
    return token;
  }

  get version(): number {
    return this.versionCounter;
  }

  private resolveTableId(tableId?: number): number {
    if (tableId !== undefined) {
      if (!this.tables.some((t) => t.id === tableId)) throw new Error(`table ${tableId} not found`);
      return tableId;
    }
    const def = this.tables.find((t) => t.isDefault) ?? this.tables[0];
    if (!def) throw new Error("base contains no tables");
    return def.id;
  }

  private normalizeCellsInput(tableId: number, cells: Record<string, BaseCell | null>): Record<string, BaseCell | null> {
    const tableFields = this.fields.filter((f) => f.tableId === tableId);
    const byId = new Map(tableFields.map((f) => [String(f.id), f]));
    const byLowerName = new Map(tableFields.map((f) => [f.name.trim().toLowerCase(), f]));
    const out: Record<string, BaseCell | null> = {};
    for (const [key, val] of Object.entries(cells)) {
      const f = byId.get(key) ?? byLowerName.get(key.trim().toLowerCase());
      out[f ? String(f.id) : key] = val;
    }
    return out;
  }

  getName(): string {
    return this.name;
  }

  getTables(): BaseTable[] {
    return this.tables.map((t) => ({ ...t }));
  }

  getFields(tableId?: number): BaseField[] {
    const tid = this.resolveTableId(tableId);
    return this.fields
      .filter((f) => f.tableId === tid)
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map((f) => ({ ...f, options: f.options ? [...f.options] : undefined }));
  }

  getViews(tableId?: number): BaseView[] {
    const tid = this.resolveTableId(tableId);
    return this.views.filter((v) => v.tableId === tid).sort((a, b) => a.pos - b.pos || a.id - b.id);
  }

  /**
   * Compute derived `lookup` and `formula` cell values on a record without mutating stored raw cells.
   */
  resolveRecord(record: BaseRecord): BaseRecord {
    const tableFields = this.fields.filter((f) => f.tableId === record.tableId);
    const computedCells: Record<string, BaseCell> = { ...record.cells };
    const overrides: Record<number, BaseCell> = {};

    // 1. Resolve `lookup` fields from `link` target tables
    for (const f of tableFields) {
      if (f.type !== "lookup" || !f.linkFieldId || !f.lookupFieldId) continue;
      const linkField = tableFields.find((lf) => lf.id === f.linkFieldId && lf.type === "link");
      if (!linkField || !linkField.targetTableId) continue;
      const rawIds = record.cells[String(linkField.id)];
      const linkedIds = Array.isArray(rawIds)
        ? rawIds.map((v) => Number(v)).filter((n) => Number.isFinite(n))
        : typeof rawIds === "number"
          ? [rawIds]
          : [];
      const targetRecs = this.records.filter(
        (r) => r.tableId === linkField.targetTableId && linkedIds.includes(r.id),
      );
      const vals = targetRecs
        .map((tr) => tr.cells[String(f.lookupFieldId)])
        .filter((v): v is BaseCell => v !== undefined);
      if (vals.length === 1 && !Array.isArray(vals[0])) {
        computedCells[String(f.id)] = vals[0];
        overrides[f.id] = vals[0];
      } else if (vals.length > 0) {
        const joined = vals.map((v) => (Array.isArray(v) ? v.join(", ") : String(v)));
        computedCells[String(f.id)] = joined;
        overrides[f.id] = joined;
      }
    }

    // 2. Evaluate `formula` fields in dependency order
    const formulaVals = evalRecordFormulas(record, tableFields, overrides);
    for (const [fidStr, val] of Object.entries(formulaVals)) {
      if (val !== null) computedCells[fidStr] = val;
    }

    return { ...record, cells: computedCells };
  }

  getRecords(tableId?: number, options?: { computed?: boolean }): BaseRecord[] {
    const tid = this.resolveTableId(tableId);
    const raw = this.records
      .filter((r) => r.tableId === tid)
      .sort((a, b) => a.position - b.position || a.id - b.id);
    if (options?.computed === false) {
      return raw.map((r) => ({ ...r, cells: { ...r.cells } }));
    }
    return raw.map((r) => this.resolveRecord(r));
  }

  createTable(name: string): BaseTable {
    const res = this.apply([{ op: "createTable", name }]);
    if (!res.ok) throw new Error(res.errors.join("; "));
    return { ...this.tables[this.tables.length - 1] };
  }

  addField(
    tableId: number | undefined,
    field: Extract<BaseOp, { op: "addField" }>["field"],
  ): BaseField {
    const res = this.apply([{ op: "addField", tableId, field }]);
    if (!res.ok) throw new Error(res.errors.join("; "));
    return { ...this.fields[this.fields.length - 1] };
  }

  addRecord(tableId: number | undefined, cells: Record<string, BaseCell>): BaseRecord {
    const res = this.apply([{ op: "addRecord", tableId, cells }]);
    if (!res.ok) throw new Error(res.errors.join("; "));
    return this.resolveRecord(this.records[this.records.length - 1]);
  }

  updateRecord(recordId: number, cells: Record<string, BaseCell | null>): BaseRecord {
    const res = this.apply([{ op: "updateRecord", recordId, cells }]);
    if (!res.ok) throw new Error(res.errors.join("; "));
    return this.resolveRecord(this.records.find((r) => r.id === recordId)!);
  }

  deleteRecord(recordId: number): boolean {
    return this.apply([{ op: "deleteRecord", recordId }]).ok;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const item = this.undoStack.pop();
    if (!item) return false;
    this.redoStack.push(this.capture());
    this.restore(item.snapshot);
    return true;
  }

  redo(): boolean {
    const snap = this.redoStack.pop();
    if (!snap) return false;
    this.undoStack.push({ token: `base-undo-${this.undoSeq++}`, snapshot: this.capture() });
    this.restore(snap);
    return true;
  }

  /** Query records in a table (with formulas & lookups resolved). */
  query(options: QueryRecordsOptions & { tableId?: number } = {}): QueryRecordsResult {
    const tid = this.resolveTableId(options.tableId);
    const fields = this.getFields(tid);
    const records = this.getRecords(tid, { computed: true });
    return queryRecords(records, fields, options);
  }

  queryView(viewId: number, overrides?: Partial<QueryRecordsOptions>): QueryRecordsResult {
    const view = this.views.find((v) => v.id === viewId);
    if (!view) throw new Error(`view ${viewId} not found`);
    return this.query({
      tableId: view.tableId,
      filters: view.config.filters,
      sorts: view.config.sorts,
      groupBy: view.config.group,
      ...overrides,
    });
  }

  evaluateDashboard(
    widgets?: readonly DashboardWidget[],
    tableId?: number,
  ): Array<{ widget: DashboardWidget; metric?: MetricSummary; series?: GroupedSeries }> {
    const tid = this.resolveTableId(tableId);
    const fields = this.getFields(tid);
    const targetWidgets = widgets ?? defaultDashboardWidgets(fields, tid);
    return targetWidgets.map((widget) => {
      const wTid = widget.tableId ?? tid;
      const wFields = this.getFields(wTid);
      const wRecs = this.getRecords(wTid, { computed: true });
      if (widget.type === "metric") {
        return { widget, metric: computeMetricSummary(wRecs, widget) };
      }
      return { widget, series: computeGroupedSeries(wRecs, wFields, widget) };
    });
  }

  /** AI-Native token-budgeted inspection of tables, schemas, and sample records. */
  inspect(options: BaseInspectOptions = {}): BaseInspectResult {
    const detail = options.detail ?? "standard";
    const maxChars = Math.max(250, (options.maxTokens ?? 4000) * 4);
    const targetTables =
      options.tableId !== undefined
        ? this.tables.filter((t) => t.id === options.tableId)
        : this.tables;

    const tablesOut: BaseInspectResult["tables"] = [];
    let used = 120;
    let truncated = false;

    for (const table of targetTables) {
      const tFields = this.getFields(table.id);
      const tRecs = this.getRecords(table.id, { computed: true });
      const tViews = this.getViews(table.id);

      const entry: BaseInspectResult["tables"][number] = {
        id: table.id,
        name: table.name,
        fieldCount: tFields.length,
        recordCount: tRecs.length,
        viewCount: tViews.length,
      };
      if (detail !== "summary") {
        entry.fields = tFields.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          ...(f.isPrimary ? { isPrimary: true } : {}),
          ...(f.options ? { options: f.options } : {}),
          ...(f.formula ? { formula: f.formula } : {}),
        }));
      }
      if (detail === "full") {
        entry.sampleRecords = tRecs.slice(0, 20).map((r) => ({ id: r.id, cells: r.cells }));
      }
      const sz = JSON.stringify(entry).length;
      if (used + sz > maxChars && tablesOut.length > 0) {
        truncated = true;
        break;
      }
      used += sz;
      tablesOut.push(entry);
    }

    return { name: this.name, tableCount: this.tables.length, truncated, tables: tablesOut };
  }

  /** Atomically apply structured schema & record mutations with optional dry-run & rollback. */
  apply(ops: readonly BaseOp[], options: BaseApplyOptions = {}): BaseApplyResult {
    const atomic = options.atomic !== false;
    const dryRun = Boolean(options.dryRun);
    const before = this.capture();
    const diff: BaseApplyResult["diff"] = [];
    const errors: string[] = [];
    let applied = 0;

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      try {
        switch (op.op) {
          case "createTable": {
            const id = this.nextTableId++;
            const table: BaseTable = {
              id,
              baseId: 1,
              name: op.name.trim() || `Table ${id}`,
              position: id * 1000,
              isDefault: this.tables.length === 0,
            };
            this.tables.push(table);
            diff.push({ op: op.op, detail: `created table "${table.name}" (#${id})` });
            applied++;
            break;
          }
          case "renameTable": {
            const t = this.tables.find((x) => x.id === op.tableId);
            if (!t) throw new Error(`table ${op.tableId} not found`);
            t.name = op.name.trim() || t.name;
            diff.push({ op: op.op, detail: `renamed table #${op.tableId} to "${t.name}"` });
            applied++;
            break;
          }
          case "deleteTable": {
            const idx = this.tables.findIndex((x) => x.id === op.tableId);
            if (idx < 0) throw new Error(`table ${op.tableId} not found`);
            this.tables.splice(idx, 1);
            this.fields = this.fields.filter((f) => f.tableId !== op.tableId);
            this.records = this.records.filter((r) => r.tableId !== op.tableId);
            this.views = this.views.filter((v) => v.tableId !== op.tableId);
            diff.push({ op: op.op, detail: `deleted table #${op.tableId}` });
            applied++;
            break;
          }
          case "addField": {
            const tid = this.resolveTableId(op.tableId);
            const id = this.nextFieldId++;
            const existing = this.fields.filter((f) => f.tableId === tid);
            const field: BaseField = {
              id,
              tableId: tid,
              name: op.field.name.trim() || `Field ${id}`,
              type: op.field.type,
              isPrimary: op.field.isPrimary ?? existing.length === 0,
              options: op.field.options ? [...op.field.options] : undefined,
              formula: op.field.formula,
              targetTableId: op.field.targetTableId,
              linkFieldId: op.field.linkFieldId,
              lookupFieldId: op.field.lookupFieldId,
              defaultValue: op.field.defaultValue,
              multiple: op.field.multiple,
              description: op.field.description,
              position: (existing.length + 1) * 1000,
            };
            this.fields.push(field);
            diff.push({ op: op.op, detail: `added ${field.type} field "${field.name}" (#${id})` });
            applied++;
            break;
          }
          case "updateField": {
            const f = this.fields.find((x) => x.id === op.fieldId);
            if (!f) throw new Error(`field ${op.fieldId} not found`);
            Object.assign(f, op.patch);
            diff.push({ op: op.op, detail: `updated field #${op.fieldId}` });
            applied++;
            break;
          }
          case "deleteField": {
            const idx = this.fields.findIndex((x) => x.id === op.fieldId);
            if (idx < 0) throw new Error(`field ${op.fieldId} not found`);
            this.fields.splice(idx, 1);
            const key = String(op.fieldId);
            for (const r of this.records) delete r.cells[key];
            diff.push({ op: op.op, detail: `deleted field #${op.fieldId}` });
            applied++;
            break;
          }
          case "addRecord": {
            const tid = this.resolveTableId(op.tableId);
            const id = this.nextRecordId++;
            const normalized = this.normalizeCellsInput(tid, op.cells);
            const finalCells: Record<string, BaseCell> = {};
            const tableFields = this.fields.filter((f) => f.tableId === tid);
            for (const f of tableFields) {
              if (f.defaultValue !== undefined && f.defaultValue !== null) {
                finalCells[String(f.id)] = f.defaultValue;
              }
            }
            for (const [k, v] of Object.entries(normalized)) {
              if (v !== null && v !== undefined) finalCells[k] = v;
            }
            const now = new Date().toISOString();
            this.records.push({
              id,
              baseId: 1,
              tableId: tid,
              cells: finalCells,
              position: id * 1000,
              createdAt: now,
              updatedAt: now,
            });
            diff.push({ op: op.op, detail: `added record #${id} in table #${tid}` });
            applied++;
            break;
          }
          case "updateRecord": {
            const rec = this.records.find((r) => r.id === op.recordId);
            if (!rec) throw new Error(`record ${op.recordId} not found`);
            const normalized = this.normalizeCellsInput(rec.tableId, op.cells);
            for (const [k, v] of Object.entries(normalized)) {
              if (v === null) delete rec.cells[k];
              else rec.cells[k] = v;
            }
            rec.updatedAt = new Date().toISOString();
            diff.push({ op: op.op, detail: `updated record #${op.recordId}` });
            applied++;
            break;
          }
          case "deleteRecord": {
            const idx = this.records.findIndex((r) => r.id === op.recordId);
            if (idx < 0) throw new Error(`record ${op.recordId} not found`);
            this.records.splice(idx, 1);
            diff.push({ op: op.op, detail: `deleted record #${op.recordId}` });
            applied++;
            break;
          }
          case "addView": {
            const tid = this.resolveTableId(op.tableId);
            const id = this.nextViewId++;
            this.views.push({
              id,
              baseId: 1,
              tableId: tid,
              name: op.name.trim() || `View ${id}`,
              type: op.type,
              config: op.config ? (JSON.parse(JSON.stringify(op.config)) as ViewConfig) : {},
              pos: id * 1000,
            });
            diff.push({ op: op.op, detail: `added ${op.type} view "${op.name}" (#${id})` });
            applied++;
            break;
          }
        }
      } catch (err) {
        errors.push(`op[${i}] (${op.op}): ${err instanceof Error ? err.message : String(err)}`);
        if (atomic) break;
      }
    }

    if (dryRun || (errors.length > 0 && atomic)) {
      this.restore(before);
      return {
        ok: errors.length === 0,
        applied: errors.length > 0 && atomic ? 0 : applied,
        undoToken: null,
        diff: errors.length > 0 && atomic ? [] : diff,
        errors,
      };
    }

    const undoToken = applied > 0 ? this.pushUndo(before) : null;
    return { ok: errors.length === 0, applied, undoToken, diff, errors };
  }

  /** Structural & schema integrity verification for AI self-correction loops. */
  verify(): BaseDiagnostic[] {
    const diagnostics: BaseDiagnostic[] = [];
    if (this.tables.length === 0) {
      diagnostics.push({
        code: "EMPTY_BASE",
        severity: "error",
        message: "Base has no tables.",
        suggestion: "Create at least one table via createTable.",
      });
      return diagnostics;
    }

    const tableIds = new Set(this.tables.map((t) => t.id));

    for (const table of this.tables) {
      const tFields = this.fields.filter((f) => f.tableId === table.id);
      if (!tFields.some((f) => f.isPrimary)) {
        diagnostics.push({
          code: "MISSING_PRIMARY_FIELD",
          severity: "warning",
          tableId: table.id,
          message: `Table "${table.name}" has no primary field.`,
          suggestion: "Mark one field with isPrimary: true.",
        });
      }

      const nameSet = new Set<string>();
      const byLowerName = new Map<string, BaseField>();
      for (const f of tFields) {
        const key = f.name.trim().toLowerCase();
        if (nameSet.has(key)) {
          diagnostics.push({
            code: "DUPLICATE_FIELD_NAME",
            severity: "error",
            tableId: table.id,
            fieldId: f.id,
            message: `Duplicate field name "${f.name}" in table "${table.name}".`,
            suggestion: "Rename the duplicate field so formula [Field] references stay unambiguous.",
          });
        }
        nameSet.add(key);
        byLowerName.set(key, f);

        if (f.type === "formula") {
          const expr = f.formula?.trim() ?? "";
          if (!expr || !formulaValid(expr)) {
            diagnostics.push({
              code: "INVALID_FORMULA",
              severity: "error",
              tableId: table.id,
              fieldId: f.id,
              message: `Formula field "${f.name}" has invalid expression "${expr}".`,
              suggestion: "Fix formula syntax (e.g. [Price] * [Qty]).",
            });
          }
        }

        if (f.type === "link" && (!f.targetTableId || !tableIds.has(f.targetTableId))) {
          diagnostics.push({
            code: "BROKEN_LINK_TARGET",
            severity: "error",
            tableId: table.id,
            fieldId: f.id,
            message: `Link field "${f.name}" points to missing tableId ${f.targetTableId}.`,
            suggestion: "Set targetTableId to an existing table id.",
          });
        }

        if (f.type === "lookup") {
          const linkField = tFields.find((lf) => lf.id === f.linkFieldId && lf.type === "link");
          const targetExists =
            linkField?.targetTableId !== undefined &&
            this.fields.some((tf) => tf.tableId === linkField.targetTableId && tf.id === f.lookupFieldId);
          if (!linkField || !targetExists) {
            diagnostics.push({
              code: "BROKEN_LOOKUP_CONFIG",
              severity: "error",
              tableId: table.id,
              fieldId: f.id,
              message: `Lookup field "${f.name}" has invalid linkFieldId or lookupFieldId.`,
              suggestion: "Point linkFieldId to a valid link field and lookupFieldId to a field on its target table.",
            });
          }
        }
      }

      // Formula cycle check per table
      const formulaFields = tFields.filter((f) => f.type === "formula" && f.formula && formulaValid(f.formula));
      const state = new Map<number, number>();
      const visit = (fid: number): boolean => {
        state.set(fid, 1);
        const f = formulaFields.find((x) => x.id === fid);
        if (f?.formula) {
          for (const ref of formulaRefs(f.formula)) {
            const target = byLowerName.get(ref.toLowerCase());
            if (target && target.type === "formula") {
              if (state.get(target.id) === 1) return true;
              if (!state.get(target.id) && visit(target.id)) return true;
            }
          }
        }
        state.set(fid, 2);
        return false;
      };
      for (const ff of formulaFields) {
        if (!state.get(ff.id) && visit(ff.id)) {
          diagnostics.push({
            code: "FORMULA_CYCLE",
            severity: "error",
            tableId: table.id,
            fieldId: ff.id,
            message: `Circular dependency detected in formula field "${ff.name}".`,
            suggestion: "Remove the mutual reference between formula fields.",
          });
        }
      }

      // Select option consistency
      const selectFields = tFields.filter((f) => (f.type === "select" || f.type === "multi_select") && f.options?.length);
      const tRecs = this.records.filter((r) => r.tableId === table.id);
      for (const rec of tRecs) {
        for (const sf of selectFields) {
          const val = rec.cells[String(sf.id)];
          if (val === undefined || val === "") continue;
          const allowed = new Set(sf.options);
          const vals = Array.isArray(val) ? val.map(String) : [String(val)];
          for (const v of vals) {
            if (!allowed.has(v)) {
              diagnostics.push({
                code: "INVALID_SELECT_OPTION",
                severity: "warning",
                tableId: table.id,
                fieldId: sf.id,
                recordId: rec.id,
                message: `Record #${rec.id} value "${v}" is not in field "${sf.name}" options.`,
                suggestion: `Add "${v}" to field options or update the record cell.`,
              });
            }
          }
        }
      }
    }

    return diagnostics;
  }

  toCsv(tableId?: number, delimiter = ","): string {
    const tid = this.resolveTableId(tableId);
    return exportTableToCsv(this.getFields(tid), this.getRecords(tid, { computed: true }), delimiter);
  }

  toJSON(): BaseSnapshot {
    return this.capture();
  }
}
