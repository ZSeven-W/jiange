import { idKey, Tx, type Doc, type Op } from "@zseven-w/collab";
import type { UndoManager } from "@zseven-w/collab";
import { applyTableEdit, parseTableData } from "./model";
import type { TableCellHistory } from "./table-cell-history";
import { tableDataOf, tableRowsOf, writeTable } from "./table-cells";

type Result = { status: "ready"; ops: Op[]; rebase: { logical: string | null; actual: string | null } } | { status: "empty" | "conflict" };

/** Merge changes can make previously visible cells hidden without changing data. */
export function tableHistoryGuard(doc: Doc, block: { client: number; clock: number }): string {
  const type = doc.propVersion(block, "type"), merges = doc.propVersion(block, "tableMerges");
  return `${type ? idKey(type) : "-"}|${merges ? idKey(merges) : "-"}`;
}

/** Apply a table marker only when its original register versions still match. */
export function applyTableHistory<S>(doc: Doc, session: object, undo: UndoManager<S>, history: TableCellHistory, key: string, redo: boolean): Result {
  const location = /^table:(\d+):(\d+):(-?\d+):(-?\d+)$/.exec(key);
  if (!location || undo.peekMarker(redo) !== key) return { status: "empty" };
  const block = { client: Number(location[1]), clock: Number(location[2]) };
  if (!doc.hasBlock(block)) return { status: "conflict" };
  const info = doc.blockInfo(block);
  if (info.type !== "table") return { status: "conflict" };
  const row = Number(location[3]), col = Number(location[4]);
  const structural = row === -1 && col === -1;
  const rows = tableRowsOf(info.props);
  if (!structural && (!Array.isArray(rows[row]) || typeof rows[row][col] !== "string")) return { status: "conflict" };
  const current = structural ? tableDataOf(info.props) : rows[row][col];
  const version = doc.propVersion(block, "tableData"), guard = tableHistoryGuard(doc, block);
  const result = history.prepare(session, key, redo, current, version ? idKey(version) : null, guard);
  if (result.status !== "ready") return result;
  const tx = new Tx(doc);
  writeTable(tx, block, info.props, structural ? parseTableData(result.value) : applyTableEdit(rows, row, col, result.value), doc.client);
  if (!tx.ops.length) return { status: "empty" };
  const next = doc.propVersion(block, "tableData"), nextVersion = next ? idKey(next) : null;
  const logicalVersion = history.commit(session, key, redo, nextVersion);
  history.rebase(session, `table:${idKey(block)}:`, logicalVersion, nextVersion, guard);
  undo.moveMarker(redo, key);
  return { status: "ready", ops: tx.ops, rebase: { logical: logicalVersion, actual: nextVersion } };
}
