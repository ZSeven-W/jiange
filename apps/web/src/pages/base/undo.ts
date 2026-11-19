import type { Cell } from "@/lib/api";

/**
 * 多维表格撤销/重做（本人本页会话内的操作）。
 *
 * 每一步记录写入前后的单元格值、新增记录及被删除记录快照；
 * 单元格撤销/重做走服务端条件写入（多行时走原子批量接口），
 * 删除记录撤销走服务端原子批量恢复，重做再原子删除恢复后的记录。
 */
export type UndoCellValue = Cell | number[] | null;
export interface UndoCellChange { rid: number; fid: number; before: UndoCellValue; after: UndoCellValue }
export interface UndoDeletedRecord {
  rid: number;
  tableId?: number;
  position: number;
  cells: Record<string, UndoCellValue>;
}
export interface UndoStep {
  label: string;
  cells: UndoCellChange[];
  /** 本步新增的记录（rid → 新增时写入的非空单元格）。 */
  created: { rid: number; cells: Record<string, UndoCellValue> }[];
  /** 本步原子删除的记录快照（用于撤销恢复与重做删除）。 */
  deleted?: UndoDeletedRecord[];
}

export interface UndoApi {
  setCellsIf: (rid: number, expected: Record<string, UndoCellValue>, cells: Record<string, UndoCellValue>) => Promise<unknown>;
  deleteRecordIf: (rid: number, expected: Record<string, UndoCellValue>) => Promise<unknown>;
  addRecord: (cells: Record<string, UndoCellValue>) => Promise<{ id: number; cells: Record<string, UndoCellValue | undefined> }>;
  batchUpdateCells?: (updates: { id: number; expected: Record<string, UndoCellValue>; cells: Record<string, UndoCellValue> }[]) => Promise<unknown>;
  batchDeleteRecords?: (ids: number[]) => Promise<{ deleted: { id: number; tableId?: number; position: number; cells: Record<string, UndoCellValue | undefined> }[] }>;
  batchRestoreRecords?: (records: { tableId?: number; position: number; cells: Record<string, UndoCellValue> }[]) => Promise<{ records: { id: number; tableId?: number; position: number; cells: Record<string, UndoCellValue | undefined> }[] }>;
}

export type UndoOutcome = { ok: true; label: string } | { ok: false; label: string; conflict: boolean };

const LIMIT = 50;

export const emptyCell = (value: UndoCellValue | undefined | "") => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
export const sameCell = (a: UndoCellValue | undefined, b: UndoCellValue | undefined) =>
  emptyCell(a) && emptyCell(b) ? true : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Group a step's cell changes per record so each record is one conditional write. */
export function groupByRecord(cells: UndoCellChange[], pick: "before" | "after") {
  const out = new Map<number, { expected: Record<string, UndoCellValue>; cells: Record<string, UndoCellValue> }>();
  for (const c of cells) {
    const row = out.get(c.rid) ?? { expected: {}, cells: {} };
    const from = pick === "before" ? c.after : c.before; // value that must be present now
    const to = pick === "before" ? c.before : c.after;
    row.expected[String(c.fid)] = emptyCell(from) ? null : from;
    row.cells[String(c.fid)] = emptyCell(to) ? null : to;
    out.set(c.rid, row);
  }
  return out;
}

export class BaseUndoStack {
  private undoSteps: UndoStep[] = [];
  private redoSteps: UndoStep[] = [];
  private busy = false;
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.version;
  private emit() { this.version++; for (const fn of this.listeners) fn(); }

  get canUndo() { return !this.busy && this.undoSteps.length > 0; }
  get canRedo() { return !this.busy && this.redoSteps.length > 0; }
  get undoLabel() { return this.undoSteps.at(-1)?.label; }
  get redoLabel() { return this.redoSteps.at(-1)?.label; }

  record(step: UndoStep) {
    const cells = step.cells.filter((c) => !sameCell(c.before, c.after));
    const deleted = step.deleted ?? [];
    if (!cells.length && !step.created.length && !deleted.length) return;
    this.undoSteps.push({ ...step, cells, ...(deleted.length ? { deleted } : {}) });
    if (this.undoSteps.length > LIMIT) this.undoSteps.shift();
    this.redoSteps = [];
    this.emit();
  }

  clear() { this.undoSteps = []; this.redoSteps = []; this.emit(); }

  async undo(api: UndoApi): Promise<UndoOutcome | null> {
    const step = this.undoSteps.at(-1);
    if (!step || this.busy) return null;
    this.busy = true; this.emit();
    try {
      const grouped = groupByRecord(step.cells.filter((c) => !step.created.some((r) => r.rid === c.rid)), "before");
      if (grouped.size > 1 && api.batchUpdateCells) {
        await api.batchUpdateCells([...grouped.entries()].map(([id, row]) => ({ id, expected: row.expected, cells: row.cells })));
      } else {
        for (const [rid, row] of grouped) await api.setCellsIf(rid, row.expected, row.cells);
      }
      for (const rec of step.created) {
        // The record may have been edited later in this step's own cell list.
        const expected = { ...rec.cells };
        for (const c of step.cells) if (c.rid === rec.rid) expected[String(c.fid)] = c.after;
        for (const k of Object.keys(expected)) if (emptyCell(expected[k])) delete expected[k];
        await api.deleteRecordIf(rec.rid, expected);
      }
      let redoDeleted = step.deleted;
      if (step.deleted && step.deleted.length > 0) {
        if (api.batchRestoreRecords) {
          const res = await api.batchRestoreRecords(
            step.deleted.map((rec) => ({ tableId: rec.tableId, position: rec.position, cells: rec.cells })),
          );
          redoDeleted = res.records.map((r, i) => ({
            rid: r.id,
            tableId: r.tableId ?? step.deleted![i]?.tableId,
            position: r.position,
            cells: definedCells(r.cells),
          }));
        } else {
          const restored: UndoDeletedRecord[] = [];
          for (const rec of step.deleted) {
            const added = await api.addRecord(rec.cells);
            restored.push({ rid: added.id, tableId: rec.tableId, position: rec.position, cells: definedCells(added.cells) });
          }
          redoDeleted = restored;
        }
      }
      this.undoSteps.pop();
      this.redoSteps.push({ ...step, ...(redoDeleted?.length ? { deleted: redoDeleted } : {}) });
      return { ok: true, label: step.label };
    } catch (err) {
      // Partial undo cannot be redone safely; drop the step and history after it.
      this.undoSteps.pop();
      this.redoSteps = [];
      return { ok: false, label: step.label, conflict: isCellConflict(err) };
    } finally { this.busy = false; this.emit(); }
  }

  async redo(api: UndoApi): Promise<UndoOutcome | null> {
    const step = this.redoSteps.at(-1);
    if (!step || this.busy) return null;
    this.busy = true; this.emit();
    try {
      const created: UndoStep["created"] = [];
      const remap = new Map<number, number>();
      for (const rec of step.created) {
        const cells = { ...rec.cells };
        for (const c of step.cells) if (c.rid === rec.rid) cells[String(c.fid)] = c.after;
        for (const k of Object.keys(cells)) if (emptyCell(cells[k])) delete cells[k];
        const added = await api.addRecord(cells);
        remap.set(rec.rid, added.id);
        // Capture what the server actually stored (field defaults included).
        created.push({ rid: added.id, cells: definedCells(added.cells) });
      }
      const grouped = groupByRecord(step.cells.filter((c) => !remap.has(c.rid)), "after");
      if (grouped.size > 1 && api.batchUpdateCells) {
        await api.batchUpdateCells([...grouped.entries()].map(([id, row]) => ({ id, expected: row.expected, cells: row.cells })));
      } else {
        for (const [rid, row] of grouped) await api.setCellsIf(rid, row.expected, row.cells);
      }
      let nextDeleted = step.deleted;
      if (step.deleted && step.deleted.length > 0) {
        if (api.batchDeleteRecords) {
          const res = await api.batchDeleteRecords(step.deleted.map((r) => r.rid));
          nextDeleted = res.deleted.map((r) => ({
            rid: r.id,
            tableId: r.tableId,
            position: r.position,
            cells: definedCells(r.cells),
          }));
        } else {
          for (const rec of step.deleted) {
            await api.deleteRecordIf(rec.rid, rec.cells);
          }
        }
      }
      this.redoSteps.pop();
      // Re-created records get new IDs; their content is now captured in `created`.
      this.undoSteps.push({
        label: step.label,
        cells: step.cells.filter((c) => !remap.has(c.rid)),
        created,
        ...(nextDeleted?.length ? { deleted: nextDeleted } : {}),
      });
      return { ok: true, label: step.label };
    } catch (err) {
      this.redoSteps = [];
      return { ok: false, label: step.label, conflict: isCellConflict(err) };
    } finally { this.busy = false; this.emit(); }
  }
}

export function definedCells(cells: Record<string, UndoCellValue | undefined>): Record<string, UndoCellValue> {
  const out: Record<string, UndoCellValue> = {};
  for (const [k, v] of Object.entries(cells)) if (!emptyCell(v)) out[k] = v as UndoCellValue;
  return out;
}

export function isCellConflict(err: unknown) {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "cells_changed";
}

/** Undoable field types: plain values written through the guarded record API. */
export const UNDOABLE_TYPES = new Set(["text", "number", "select", "multi_select", "checkbox", "date", "person", "url", "phone", "email", "rating"]);
