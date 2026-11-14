import type { BaseRecord, Field } from "@/lib/api";

/** Selection remembers the actual visible order, not only its numeric offsets. */
export interface GridSelection {
  ar: number;
  af: number;
  rr: number;
  rf: number;
  rowIds: number[];
  fieldIds: number[];
}

export type SelectionRect = Pick<GridSelection, "ar" | "af" | "rr" | "rf">;

export function captureGridSelection(rect: SelectionRect, records: readonly BaseRecord[], fields: readonly Field[]): GridSelection | null {
  if (![rect.ar, rect.rr].every((index) => Number.isInteger(index) && index >= 0 && index < records.length) ||
      ![rect.af, rect.rf].every((index) => Number.isInteger(index) && index >= 0 && index < fields.length)) return null;
  return { ...rect, rowIds: records.map((record) => record.id), fieldIds: fields.map((field) => field.id) };
}

/** A changed row/field order invalidates before any read or mutation. */
export function validGridSelection(selection: GridSelection | null, records: readonly BaseRecord[], fields: readonly Field[]): selection is GridSelection {
  if (!selection || selection.rowIds.length !== records.length || selection.fieldIds.length !== fields.length) return false;
  if (!selection.rowIds.every((id, index) => records[index]?.id === id) || !selection.fieldIds.every((id, index) => fields[index]?.id === id)) return false;
  return [selection.ar, selection.rr].every((index) => Number.isInteger(index) && index >= 0 && index < records.length) &&
    [selection.af, selection.rf].every((index) => Number.isInteger(index) && index >= 0 && index < fields.length);
}

/** Extend the original anchor only if the dataset is still the one at drag start. */
export function extendGridSelection(start: GridSelection, row: number, field: number, records: readonly BaseRecord[], fields: readonly Field[]): GridSelection | null {
  if (!validGridSelection(start, records, fields)) return null;
  return captureGridSelection({ ar: start.ar, af: start.af, rr: row, rf: field }, records, fields);
}

export function selectionCellCount(selection: GridSelection): number {
  return (Math.abs(selection.rr - selection.ar) + 1) * (Math.abs(selection.rf - selection.af) + 1);
}

/** Paint the rectangle's perimeter without changing table column dimensions. */
export function selectionOutline(selection: GridSelection, row: number, field: number): string | undefined {
  const top = Math.min(selection.ar, selection.rr), bottom = Math.max(selection.ar, selection.rr);
  const left = Math.min(selection.af, selection.rf), right = Math.max(selection.af, selection.rf);
  if (row < top || row > bottom || field < left || field > right) return undefined;
  const shadows: string[] = [];
  if (row === top) shadows.push("inset 0 2px #3370ff");
  if (row === bottom) shadows.push("inset 0 -2px #3370ff");
  if (field === left) shadows.push("inset 2px 0 #3370ff");
  if (field === right) shadows.push("inset -2px 0 #3370ff");
  return shadows.length ? shadows.join(", ") : undefined;
}

/** An in-flight batch already captured its IDs; ordering can change safely. */
export function batchTargetsAuthorized(recordIds: readonly number[], fieldIds: readonly number[], records: readonly BaseRecord[], fields: readonly Field[]): boolean {
  const visibleRecords = new Set(records.map((record) => record.id));
  const visibleFields = new Set(fields.map((field) => field.id));
  return recordIds.every((id) => visibleRecords.has(id)) && fieldIds.every((id) => visibleFields.has(id));
}

export interface BatchAccess {
  baseId: number;
  mounted: boolean;
  canEdit: boolean;
  detailAccessReady: boolean;
  selectionAccessReady: boolean;
  authorizedRecords: readonly BaseRecord[];
  fields: readonly Field[];
}

/** Await the fresh snapshot caused by a write, with a bounded safe stop. */
export async function waitForBatchTargets(read: () => BatchAccess, baseId: number, recordIds: number[], fieldIds: number[], timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = read();
    if (!current.mounted || current.baseId !== baseId || !current.canEdit) return false;
    if (current.detailAccessReady && current.selectionAccessReady) return batchTargetsAuthorized(recordIds, fieldIds, current.authorizedRecords, current.fields);
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}
