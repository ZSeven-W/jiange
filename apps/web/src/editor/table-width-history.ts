import { eqId, idKey, ROOT, type Doc, type Op, type OpId, type UndoManager } from "@jiange/collab";
import { isCellTable, tableRowsOf, TBL_BASE, TBL_COLS, TBL_ROWS } from "./table-cells";
import { TableCellHistory } from "./table-cell-history";
import { validTableWidths } from "./table-widths";
import type { ConditionalAlignmentPlan } from "./column-alignment-history";

let serial = 0;
const prefix = (block: OpId) => `table-width:${idKey(block)}:`;
const version = (doc: Doc, block: OpId, key: string) => { const id = doc.propVersion(block, key); return id ? idKey(id) : null; };
export type TableWidthBefore = { value: string; version: string | null; guard: string; columns: number };
type Prepared = { doc: Doc; undo: object; key: string; redo: boolean; revision: number; block: OpId; before: TableWidthBefore; target: string; opId: OpId };

/** Resizing never replaces a width or structure change already seen locally. */
export class TableWidthHistory {
  private history = new TableCellHistory();
  private prepared = new WeakMap<ConditionalAlignmentPlan, Prepared>();

  capture(doc: Doc, block: OpId): TableWidthBefore | null {
    if (!doc.hasBlock(block)) return null;
    const info = doc.blockInfo(block);
    if (info.type !== "table" || !eqId(info.parent, ROOT)) return null;
    const rows = tableRowsOf(info.props), columns = rows[0]?.length ?? 0;
    if (!columns || columns > 1000 || !rows.every((row) => Array.isArray(row) && row.length === columns && row.every((value) => typeof value === "string"))) return null;
    const value = info.props.tableWidths ?? "";
    if (!validTableWidths(value)) return null;
    // A structural edit can keep the same dimensions. Guard the version, not
    // just the dimensions, so a column reorder cannot retarget a drag.
    const guard = JSON.stringify([idKey(info.parent), idKey(doc.blockLocation(block).version), ...["type", "tableData", "tableMerges", "tbl.rows", "tbl.cols"].map((key) => version(doc, block, key)), rows.length, columns]);
    return { value, version: version(doc, block, "tableWidths"), guard, columns };
  }

  record<S>(doc: Doc, undo: UndoManager<S>, block: OpId, before: TableWidthBefore): string {
    const after = this.capture(doc, block);
    if (!after || before.guard !== after.guard || before.value === after.value) throw new Error("invalid table width history");
    const key = `${prefix(block)}${++serial}`;
    this.history.record(doc, key, before.value, after.value, before.version, after.version, before.guard, undefined, Date.now(), false);
    undo.seal(); undo.recordMarker(key); undo.seal();
    return key;
  }

  prepareConditional<S>(doc: Doc, undo: UndoManager<S>, key: string, redo: boolean): { status: "ready"; plan: ConditionalAlignmentPlan } | { status: "empty" | "conflict" | "unsupported" } {
    const match = /^table-width:(\d+):(\d+):(\d+)$/.exec(key);
    if (!match || undo.peekMarker(redo) !== key) return { status: "empty" };
    const block = { client: Number(match[1]), clock: Number(match[2]) }, current = this.capture(doc, block);
    if (!current) return { status: "conflict" };
    const candidate = this.history.prepare(doc, key, redo, current.value, current.version, current.guard);
    if (candidate.status !== "ready") return candidate;
    if (!validTableWidths(candidate.value) || doc.client <= 0) return { status: "unsupported" };
    let opId: OpId;
    try { [opId] = doc.allocateOpIds(1); } catch { return { status: "unsupported" }; }
    const op = Object.freeze({ t: "bset" as const, id: Object.freeze({ ...opId }), block: Object.freeze({ ...block }), key: "tableWidths", value: candidate.value });
    const plan = Object.freeze({ op });
    this.prepared.set(plan, { doc, undo, key, redo, revision: undo.revision, block, before: current, target: candidate.value, opId });
    return { status: "ready", plan };
  }

  canSubmitConditional<S>(doc: Doc, undo: UndoManager<S>, plan: ConditionalAlignmentPlan): boolean {
    const entry = this.prepared.get(plan);
    if (!entry || entry.doc !== doc || entry.undo !== undo || entry.revision !== undo.revision || undo.peekMarker(entry.redo) !== entry.key) return false;
    const current = this.capture(doc, entry.block);
    return !!current && current.guard === entry.before.guard && current.value === entry.before.value && current.version === entry.before.version;
  }

  finishConditional<S>(doc: Doc, undo: UndoManager<S>, plan: ConditionalAlignmentPlan): "ready" | "conflict" {
    const entry = this.prepared.get(plan);
    if (!entry || entry.doc !== doc || entry.undo !== undo || entry.revision !== undo.revision || undo.peekMarker(entry.redo) !== entry.key) return "conflict";
    const current = this.capture(doc, entry.block);
    if (!current || current.guard !== entry.before.guard || current.value !== entry.target || current.version !== idKey(entry.opId)) return "conflict";
    const logical = this.history.commit(doc, entry.key, entry.redo, current.version);
    this.history.rebase(doc, prefix(entry.block), logical, current.version, current.guard);
    if (!undo.moveMarker(entry.redo, entry.key)) throw new Error("table width marker changed during completion");
    this.prepared.delete(plan);
    return "ready";
  }

  /** Rebase only after a verified local structural inverse recreates a snapshot. */
  rebaseStructure(doc: Doc, block: OpId, logical: string, actual: string): void {
    if (!doc.hasBlock(block)) return;
    const location = doc.blockLocation(block);
    const fromSnapshot = (snapshot: string) => {
      try {
        const [entries, data] = JSON.parse(snapshot) as [Array<[string, string | null]>, string];
        const versions = new Map(entries), rows: unknown = JSON.parse(data);
        if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0])) return null;
        const guard = JSON.stringify([idKey(location.parent), idKey(location.version), ...["type", "tableData", "tableMerges", "tbl.rows", "tbl.cols"].map((key) => versions.get(key) ?? null), rows.length, rows[0].length]);
        return { guard, width: versions.get("tableWidths") ?? null };
      } catch { return null; }
    };
    const before = fromSnapshot(logical), after = fromSnapshot(actual);
    if (before && after) this.history.rebaseStructure(doc, prefix(block), before.width, after.width, before.guard, after.guard);
  }

  /** A verified cell inverse can advance the table mirror without changing axes. */
  rebaseData(doc: Doc, block: OpId, logical: string | null, actual: string | null, ops: readonly Op[]): void {
    if (ops.some((op) => op.t !== "bset" || !eqId(op.block, block) || !(op.key === "tableData" || op.key === "tbl.m" || op.key?.startsWith("tbl.c.")))) return;
    const current = this.capture(doc, block);
    if (!current) return;
    const parts: unknown[] = JSON.parse(current.guard);
    if (parts[3] !== actual) return;
    parts[3] = logical;
    this.history.rebaseStructure(doc, prefix(block), current.version, current.version, JSON.stringify(parts), current.guard);
  }

  /** Local legacy-to-cell migration preserves positional axes and prior text. */
  rebaseMigration(doc: Doc, block: OpId, before: TableWidthBefore | null, oldProps: Record<string, string>): void {
    if (!before || isCellTable(oldProps) || !doc.hasBlock(block)) return;
    const props = doc.blockInfo(block).props, after = this.capture(doc, block), rows = tableRowsOf(oldProps);
    if (!after || !isCellTable(props) || before.version !== after.version || before.value !== after.value || props[TBL_BASE] !== JSON.stringify(rows)) return;
    try {
      const rowIds: unknown = JSON.parse(props[TBL_ROWS]), colIds: unknown = JSON.parse(props[TBL_COLS]);
      if (!Array.isArray(rowIds) || !Array.isArray(colIds) || rowIds.length !== rows.length || colIds.length !== before.columns || rowIds.some((id, i) => id !== `r${i}`) || colIds.some((id, i) => id !== `c${i}`)) return;
      const oldGuard: unknown[] = JSON.parse(before.guard), nextGuard: unknown[] = JSON.parse(after.guard);
      if ([0, 1, 2, 4, 7, 8].some((index) => oldGuard[index] !== nextGuard[index])) return;
      nextGuard[3] = oldGuard[3];
      this.history.rebaseStructure(doc, prefix(block), before.version, before.version, before.guard, JSON.stringify(nextGuard));
    } catch { /* Unrecognized metadata remains guarded. */ }
  }

  discard(doc: Doc, key: string, redo: boolean): void { this.history.discard(doc, key, redo); }
}
