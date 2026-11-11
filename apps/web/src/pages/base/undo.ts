import type { Cell } from "@/lib/api";

/**
 * 多维表格撤销/重做（本人本页会话内的操作）。
 *
 * 每一步记录写入前后的单元格值；撤销/重做都走服务端条件写入（expected），
 * 若单元格已被他人或其他标签页改动则拒绝执行并丢弃该步，绝不覆盖较新的内容。
 * 新增的记录撤销时仅在其内容仍完全等于本人写入值时删除。
 */
export type UndoCellValue = Cell | number[] | null;
export interface UndoCellChange { rid: number; fid: number; before: UndoCellValue; after: UndoCellValue }
export interface UndoStep {
  label: string;
  cells: UndoCellChange[];
  /** 本步新增的记录（rid → 新增时写入的非空单元格）。 */
  created: { rid: number; cells: Record<string, UndoCellValue> }[];
}

export interface UndoApi {
  setCellsIf: (rid: number, expected: Record<string, UndoCellValue>, cells: Record<string, UndoCellValue>) => Promise<unknown>;
  deleteRecordIf: (rid: number, expected: Record<string, UndoCellValue>) => Promise<unknown>;
  addRecord: (cells: Record<string, UndoCellValue>) => Promise<{ id: number; cells: Record<string, UndoCellValue | undefined> }>;
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
    if (!cells.length && !step.created.length) return;
    this.undoSteps.push({ ...step, cells });
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
      for (const [rid, row] of groupByRecord(step.cells.filter((c) => !step.created.some((r) => r.rid === c.rid)), "before")) await api.setCellsIf(rid, row.expected, row.cells);
      for (const rec of step.created) {
        // The record may have been edited later in this step's own cell list.
        const expected = { ...rec.cells };
        for (const c of step.cells) if (c.rid === rec.rid) expected[String(c.fid)] = c.after;
        for (const k of Object.keys(expected)) if (emptyCell(expected[k])) delete expected[k];
        await api.deleteRecordIf(rec.rid, expected);
      }
      this.undoSteps.pop();
      this.redoSteps.push(step);
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
      for (const [rid, row] of groupByRecord(step.cells.filter((c) => !remap.has(c.rid)), "after")) await api.setCellsIf(rid, row.expected, row.cells);
      this.redoSteps.pop();
      // Re-created records get new IDs; their content is now captured in `created`.
      this.undoSteps.push({ label: step.label, cells: step.cells.filter((c) => !remap.has(c.rid)), created });
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
