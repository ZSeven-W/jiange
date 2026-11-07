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
