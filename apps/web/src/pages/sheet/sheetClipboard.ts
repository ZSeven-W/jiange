import { applyCellChanges, pasteCells, pointKey, selectionBounds, selectionText, type CellChange, type CellEdit, type SheetCells, type SheetPoint, type SheetSelection } from "./gridModel";
import { translateSheetFormula } from "./formula";

export const SHEET_COPY_MIME = "application/x-jiange-sheet-copy";
export type SheetCopy = { token: string; text: string; top: number; left: number; values: string[][] };
export type SheetPaste = CellEdit | { ok: false; reason: "unsupported_formula" | "unverified_copy" };

/** Keep the snapshot in memory: clipboard metadata itself cannot supply source cells. */
export function copySheetCells(cells: SheetCells, selection: SheetSelection, token: string): SheetCopy | null {
  const { top, bottom, left, right } = selectionBounds(selection);
  if (!token || (bottom - top + 1) * (right - left + 1) > 500) return null;
  const values: string[][] = [];
  for (let row = top; row <= bottom; row++) {
    const line: string[] = [];
    for (let col = left; col <= right; col++) line.push(cells[pointKey({ row, col })] ?? "");
    values.push(line);
  }
  return { token, text: selectionText(cells, selection), top, left, values };
}

/** Adjust each source cell by the copy offset, then validate the entire paste. */
export function pasteCopiedSheetCells(cells: SheetCells, at: SheetPoint, copy: SheetCopy): SheetPaste {
  const changes: CellChange[] = [], rowDelta = at.row - copy.top, colDelta = at.col - copy.left;
  for (let row = 0; row < copy.values.length; row++) for (let col = 0; col < copy.values[row].length; col++) {
    const value = translateSheetFormula(copy.values[row][col], rowDelta, colDelta);
    if (value === null) return { ok: false, reason: "unsupported_formula" };
    changes.push({ point: { row: at.row + row, col: at.col + col }, value });
  }
  return applyCellChanges(cells, changes);
}

/** Do not silently paste a known internal formula without its origin marker. */
export function resolveSheetPaste(cells: SheetCells, at: SheetPoint, text: string, token: string, copy: SheetCopy | null): SheetPaste {
  if (copy && token === copy.token && text === copy.text) return pasteCopiedSheetCells(cells, at, copy);
  if (token || (copy && text === copy.text && copy.values.some((row) => row.some((value) => value.startsWith("="))))) return { ok: false, reason: "unverified_copy" };
  return pasteCells(cells, at, text);
}
