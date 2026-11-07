import { idKey, Tx, type Doc, type Op } from "@jiange/collab";
import type { UndoManager } from "@jiange/collab";
import { applyTableEdit, parseTableData } from "./model";
import type { TableCellHistory } from "./tableCellHistory";

type Result = { status: "ready"; ops: Op[] } | { status: "empty" | "conflict" };

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
  const rows = parseTableData(info.props.tableData);
  if (!structural && (!Array.isArray(rows[row]) || typeof rows[row][col] !== "string")) return { status: "conflict" };
  const current = structural ? (info.props.tableData ?? "") : rows[row][col];
  const version = doc.propVersion(block, "tableData"), typeVersion = doc.propVersion(block, "type");
  const result = history.prepare(session, key, redo, current, version ? idKey(version) : null, typeVersion ? idKey(typeVersion) : null);
  if (result.status !== "ready") return result;
  const tx = new Tx(doc);
  tx.setProp(block, "tableData", structural ? result.value : JSON.stringify(applyTableEdit(rows, row, col, result.value)));
  if (!tx.ops.length) return { status: "empty" };
  const next = doc.propVersion(block, "tableData"), nextVersion = next ? idKey(next) : null;
  const logicalVersion = history.commit(session, key, redo, nextVersion);
  history.rebase(session, `table:${idKey(block)}:`, logicalVersion, nextVersion, typeVersion ? idKey(typeVersion) : null);
  undo.moveMarker(redo, key);
  return { status: "ready", ops: tx.ops };
}
