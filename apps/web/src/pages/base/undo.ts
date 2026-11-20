import type { Cell, Field, View, ViewConfig } from "@/lib/api";

/**
 * 多维表格撤销/重做（本人本页会话内的操作）。
 *
 * 覆盖：
 * 1. 单元格写入（含日历小时排程与甘特拖拽排期）、新增记录与原子批量删除/恢复；
 * 2. 字段结构级操作（新增字段、编辑字段属性、调整列顺序、删除字段及无损恢复列数据）；
 * 3. 视图结构级操作（新建/复制视图、重命名、保存视图配置、调整视图顺序、删除并原位恢复视图）。
 */
export type UndoCellValue = Cell | number[] | null;
export interface UndoCellChange { rid: number; fid: number; before: UndoCellValue; after: UndoCellValue }
export interface UndoDeletedRecord {
  rid: number;
  tableId?: number;
  position: number;
  cells: Record<string, UndoCellValue>;
}

export interface UndoFieldSnapshot {
  id: number;
  tableId?: number;
  name: string;
  type: Field["type"];
  options?: string[];
  optionColors?: number[];
  description?: string;
  formula?: string;
  position: number;
  defaultValue?: Cell | null;
  multiple?: boolean;
  targetTableId?: number;
}

export interface UndoViewSnapshot {
  id: number;
  tableId?: number;
  name: string;
  type: View["type"];
  config?: ViewConfig;
  pos?: number;
  isPersonal?: boolean;
}

export type UndoStructuralAction =
  | { kind: "field_create"; field: UndoFieldSnapshot }
  | { kind: "field_update"; fieldId: number; before: Partial<Field>; after: Partial<Field> }
  | { kind: "field_delete"; field: UndoFieldSnapshot; cells: { recordId: number; value: UndoCellValue }[] }
  | { kind: "field_reorder"; beforeOrder: number[]; afterOrder: number[] }
  | { kind: "view_create"; view: UndoViewSnapshot }
  | { kind: "view_rename"; viewId: number; beforeName: string; afterName: string }
  | { kind: "view_config"; viewId: number; beforeConfig: ViewConfig; afterConfig: ViewConfig }
  | { kind: "view_reorder"; beforeOrder: number[]; afterOrder: number[] }
  | { kind: "view_delete"; view: UndoViewSnapshot };

export interface UndoStep {
  label: string;
  cells: UndoCellChange[];
  /** 本步新增的记录（rid → 新增时写入的非空单元格）。 */
  created: { rid: number; cells: Record<string, UndoCellValue> }[];
  /** 本步原子删除的记录快照（用于撤销恢复与重做删除）。 */
  deleted?: UndoDeletedRecord[];
  /** 本步字段或视图结构级变更。 */
  structural?: UndoStructuralAction;
}

export interface UndoApi {
  setCellsIf: (rid: number, expected: Record<string, UndoCellValue>, cells: Record<string, UndoCellValue>) => Promise<unknown>;
  deleteRecordIf: (rid: number, expected: Record<string, UndoCellValue>) => Promise<unknown>;
  addRecord: (cells: Record<string, UndoCellValue>) => Promise<{ id: number; cells: Record<string, UndoCellValue | undefined> }>;
  batchUpdateCells?: (updates: { id: number; expected: Record<string, UndoCellValue>; cells: Record<string, UndoCellValue> }[]) => Promise<unknown>;
  batchDeleteRecords?: (ids: number[]) => Promise<{ deleted: { id: number; tableId?: number; position: number; cells: Record<string, UndoCellValue | undefined> }[] }>;
  batchRestoreRecords?: (records: { tableId?: number; position: number; cells: Record<string, UndoCellValue> }[]) => Promise<{ records: { id: number; tableId?: number; position: number; cells: Record<string, UndoCellValue | undefined> }[] }>;
  addField?: (f: Partial<Field>) => Promise<Field>;
  patchField?: (fid: number, f: Partial<Field>) => Promise<Field>;
  deleteField?: (fid: number) => Promise<unknown>;
  restoreField?: (input: { field: Partial<Field>; cells?: { recordId: number; value: UndoCellValue }[] }) => Promise<{ field: Field; restoredCells: number }>;
  reorderFields?: (expected: number[], desired: number[]) => Promise<unknown>;
  addView?: (v: Partial<View> & { isPersonal?: boolean }) => Promise<View>;
  renameView?: (vid: number, expectedName: string, name: string) => Promise<View>;
  patchView?: (vid: number, patch: Partial<View>) => Promise<View>;
  reorderViews?: (expected: number[], desired: number[]) => Promise<unknown>;
  deleteView?: (vid: number) => Promise<unknown>;
  onSelectView?: (vid: number) => void;
}

export type UndoOutcome = { ok: true; label: string } | { ok: false; label: string; conflict: boolean };

const LIMIT = 50;

export const emptyCell = (value: UndoCellValue | undefined | "") => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
export const sameCell = (a: UndoCellValue | undefined, b: UndoCellValue | undefined) =>
  emptyCell(a) && emptyCell(b) ? true : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function fieldToUndoSnapshot(f: Field): UndoFieldSnapshot {
  return {
    id: f.id,
    tableId: f.tableId,
    name: f.name,
    type: f.type,
    options: f.options ? [...f.options] : undefined,
    optionColors: f.optionColors ? [...f.optionColors] : undefined,
    description: f.description,
    formula: f.formula,
    position: f.position,
    defaultValue: f.defaultValue ?? null,
    multiple: f.multiple,
    targetTableId: f.targetTableId,
  };
}

export function viewToUndoSnapshot(v: View): UndoViewSnapshot {
  return {
    id: v.id,
    tableId: v.tableId,
    name: v.name,
    type: v.type,
    config: v.config ? JSON.parse(JSON.stringify(v.config)) : {},
    pos: v.pos,
    isPersonal: v.ownerId != null,
  };
}

function fieldSnapshotPayload(f: UndoFieldSnapshot): Partial<Field> {
  return {
    ...(f.tableId ? { tableId: f.tableId } : {}),
    name: f.name,
    type: f.type,
    ...(f.options ? { options: [...f.options] } : {}),
    ...(f.optionColors ? { optionColors: [...f.optionColors] } : {}),
    description: f.description ?? "",
    ...(f.formula !== undefined ? { formula: f.formula } : {}),
    position: f.position,
    defaultValue: f.defaultValue ?? null,
    ...(f.type === "person" ? { multiple: !!f.multiple } : {}),
    ...(f.targetTableId ? { targetTableId: f.targetTableId } : {}),
  };
}

function viewSnapshotPayload(v: UndoViewSnapshot): Partial<View> & { isPersonal?: boolean } {
  return {
    ...(v.tableId ? { tableId: v.tableId } : {}),
    name: v.name,
    type: v.type,
    config: v.config ?? {},
    ...(v.pos ? { pos: v.pos } : {}),
    ...(v.isPersonal ? { isPersonal: true } : {}),
  };
}

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

async function applyStructuralUndo(action: UndoStructuralAction, api: UndoApi): Promise<UndoStructuralAction> {
  switch (action.kind) {
    case "field_create":
      if (!api.deleteField) throw new Error("deleteField unavailable");
      await api.deleteField(action.field.id);
      return action;
    case "field_update":
      if (!api.patchField) throw new Error("patchField unavailable");
      await api.patchField(action.fieldId, action.before);
      return action;
    case "field_delete": {
      if (!api.restoreField) throw new Error("restoreField unavailable");
      const res = await api.restoreField({
        field: fieldSnapshotPayload(action.field),
        cells: action.cells,
      });
      return { ...action, field: fieldToUndoSnapshot(res.field) };
    }
    case "field_reorder":
      if (!api.reorderFields) throw new Error("reorderFields unavailable");
      await api.reorderFields(action.afterOrder, action.beforeOrder);
      return action;
    case "view_create":
      if (!api.deleteView) throw new Error("deleteView unavailable");
      await api.deleteView(action.view.id);
      return action;
    case "view_rename":
      if (!api.renameView) throw new Error("renameView unavailable");
      await api.renameView(action.viewId, action.afterName, action.beforeName);
      return action;
    case "view_config":
      if (!api.patchView) throw new Error("patchView unavailable");
      await api.patchView(action.viewId, { config: action.beforeConfig });
      return action;
    case "view_reorder":
      if (!api.reorderViews) throw new Error("reorderViews unavailable");
      await api.reorderViews(action.afterOrder, action.beforeOrder);
      return action;
    case "view_delete": {
      if (!api.addView) throw new Error("addView unavailable");
      const restored = await api.addView(viewSnapshotPayload(action.view));
      api.onSelectView?.(restored.id);
      return { ...action, view: viewToUndoSnapshot(restored) };
    }
  }
}

async function applyStructuralRedo(action: UndoStructuralAction, api: UndoApi): Promise<UndoStructuralAction> {
  switch (action.kind) {
    case "field_create": {
      if (!api.addField) throw new Error("addField unavailable");
      const recreated = await api.addField(fieldSnapshotPayload(action.field));
      return { ...action, field: fieldToUndoSnapshot(recreated) };
    }
    case "field_update":
      if (!api.patchField) throw new Error("patchField unavailable");
      await api.patchField(action.fieldId, action.after);
      return action;
    case "field_delete":
      if (!api.deleteField) throw new Error("deleteField unavailable");
      await api.deleteField(action.field.id);
      return action;
    case "field_reorder":
      if (!api.reorderFields) throw new Error("reorderFields unavailable");
      await api.reorderFields(action.beforeOrder, action.afterOrder);
      return action;
    case "view_create": {
      if (!api.addView) throw new Error("addView unavailable");
      const recreated = await api.addView(viewSnapshotPayload(action.view));
      api.onSelectView?.(recreated.id);
      return { ...action, view: viewToUndoSnapshot(recreated) };
    }
    case "view_rename":
      if (!api.renameView) throw new Error("renameView unavailable");
      await api.renameView(action.viewId, action.beforeName, action.afterName);
      return action;
    case "view_config":
      if (!api.patchView) throw new Error("patchView unavailable");
      await api.patchView(action.viewId, { config: action.afterConfig });
      return action;
    case "view_reorder":
      if (!api.reorderViews) throw new Error("reorderViews unavailable");
      await api.reorderViews(action.beforeOrder, action.afterOrder);
      return action;
    case "view_delete":
      if (!api.deleteView) throw new Error("deleteView unavailable");
      await api.deleteView(action.view.id);
      return action;
  }
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
    if (!cells.length && !step.created.length && !deleted.length && !step.structural) return;
    this.undoSteps.push({
      ...step,
      cells,
      ...(deleted.length ? { deleted } : {}),
    });
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
      let nextStructural = step.structural;
      if (step.structural) {
        nextStructural = await applyStructuralUndo(step.structural, api);
      }
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
      this.redoSteps.push({
        ...step,
        ...(redoDeleted?.length ? { deleted: redoDeleted } : {}),
        ...(nextStructural ? { structural: nextStructural } : {}),
      });
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
      let nextStructural = step.structural;
      if (step.structural) {
        nextStructural = await applyStructuralRedo(step.structural, api);
      }
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
        ...(nextStructural ? { structural: nextStructural } : {}),
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
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; status?: number };
  return e.code === "cells_changed" || e.code === "conflict" || e.code === "primary_field" || e.status === 409;
}

/** Undoable field types: plain values written through the guarded record API. */
export const UNDOABLE_TYPES = new Set(["text", "number", "select", "multi_select", "checkbox", "date", "person", "url", "phone", "email", "rating"]);
