import { columnName } from "./grid.js";
import type {
  SheetCell,
  SheetCellConflict,
  SheetCellRevision,
  SheetCellStyle,
  SheetCellWrite,
  SheetMerge,
  SheetSnapshot,
  SheetStylePatch,
} from "./types.js";

export interface RemoteCollaborator {
  userId: number;
  name: string;
  worksheetId: number;
  row: number;
  col: number;
  anchorRow?: number;
  anchorCol?: number;
  editing?: boolean;
}

export interface PendingMergeConflict {
  worksheetId: number;
  attemptedRect: SheetMerge;
  conflictingMerges: SheetMerge[];
  message: string;
}

export function formatSheetCellAddress(row: number, col: number): string {
  return `${columnName(col)}${row + 1}`;
}

export function formatSheetRect(rect: SheetMerge): string {
  const start = formatSheetCellAddress(rect.top, rect.left);
  const end = formatSheetCellAddress(rect.bottom, rect.right);
  return start === end ? start : `${start}:${end}`;
}

export function remoteCollaboratorBounds(c: RemoteCollaborator): SheetMerge {
  const aRow = typeof c.anchorRow === "number" ? c.anchorRow : c.row;
  const aCol = typeof c.anchorCol === "number" ? c.anchorCol : c.col;
  return {
    top: Math.min(c.row, aRow),
    bottom: Math.max(c.row, aRow),
    left: Math.min(c.col, aCol),
    right: Math.max(c.col, aCol),
  };
}

export function toSheetStylePatch(patch: Partial<SheetCellStyle>): SheetStylePatch {
  const out: SheetStylePatch = {};
  if ("bold" in patch && patch.bold !== undefined) out.bold = patch.bold;
  if ("italic" in patch && patch.italic !== undefined) out.italic = patch.italic;
  if ("underline" in patch && patch.underline !== undefined) out.underline = patch.underline;
  if ("strike" in patch && patch.strike !== undefined) out.strike = patch.strike;
  if ("fontFamily" in patch && patch.fontFamily !== undefined) out.fontFamily = patch.fontFamily;
  if ("fontSize" in patch && patch.fontSize !== undefined) out.fontSize = patch.fontSize;
  if ("color" in patch && patch.color !== undefined) out.color = patch.color;
  if ("bg" in patch && patch.bg !== undefined) out.bg = patch.bg;
  if ("align" in patch && patch.align !== undefined) out.align = patch.align;
  if ("valign" in patch && patch.valign !== undefined) out.valign = patch.valign;
  if ("wrap" in patch && patch.wrap !== undefined) out.wrap = patch.wrap;
  if ("numFmt" in patch && patch.numFmt !== undefined) out.numFmt = patch.numFmt;
  if ("borders" in patch) {
    if (!patch.borders) out.clearBorders = true;
    else out.borders = patch.borders;
  }
  return out;
}

export function applyRemoteCellDelta<TSnap extends SheetSnapshot>(
  snapshot: TSnap | undefined,
  worksheetId: number,
  workbookRevision: number,
  cells: SheetCellRevision[],
): TSnap | null {
  if (!snapshot || !worksheetId || !Array.isArray(cells) || cells.length === 0) return null;
  if (workbookRevision <= snapshot.workbookRevision) return snapshot;
  if (workbookRevision !== snapshot.workbookRevision + 1) return null;
  if (!snapshot.sheets.some((ws) => ws.id === worksheetId)) return null;
  return {
    ...snapshot,
    workbookRevision,
    sheets: snapshot.sheets.map((ws) => {
      if (ws.id !== worksheetId) return ws;
      const byKey = new Map<string, SheetCell>();
      for (const c of ws.cells) byKey.set(`${c.rowId}:${c.columnId}`, c);
      for (const item of cells) {
        const key = `${item.rowId}:${item.columnId}`;
        const prev = byKey.get(key);
        if (prev && prev.revision >= item.revision) continue;
        byKey.set(key, {
          rowId: item.rowId,
          columnId: item.columnId,
          raw: item.raw !== undefined ? item.raw : (prev?.raw ?? ""),
          style: item.style !== undefined ? item.style : (prev?.style ?? {}),
          revision: item.revision,
        });
      }
      return { ...ws, revision: ws.revision + 1, cells: [...byKey.values()] };
    }),
  };
}

export function buildConflictResolutionWrite(
  conflict: SheetCellConflict,
  choice: "mine" | "anchor",
): SheetCellWrite | null {
  if (choice === "anchor") {
    if (
      conflict.reason !== "merge_slave_conflict" ||
      !conflict.anchorRowId ||
      !conflict.anchorColumnId ||
      conflict.attemptedRaw === undefined
    ) {
      return null;
    }
    return {
      rowId: conflict.anchorRowId,
      columnId: conflict.anchorColumnId,
      expectedRevision: conflict.anchorRevision ?? 0,
      raw: conflict.attemptedRaw,
    };
  }
  if (conflict.reason === "merge_slave_conflict") return null;
  const write: SheetCellWrite = {
    rowId: conflict.rowId,
    columnId: conflict.columnId,
    expectedRevision: conflict.currentRevision,
  };
  if (conflict.attemptedRaw !== undefined) write.raw = conflict.attemptedRaw;
  if (conflict.attemptedStylePatch) write.stylePatch = conflict.attemptedStylePatch;
  else if (conflict.attemptedStyle) write.style = conflict.attemptedStyle;
  if (write.raw === undefined && !write.stylePatch && !write.style) return null;
  return write;
}
