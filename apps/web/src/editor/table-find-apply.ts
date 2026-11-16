import { idKey, Tx, type Doc, type Op, type UndoManager } from "@jiange/collab";
import type { FindMatch } from "./find-replace";
import { writeTable } from "./table-cells";
import { tableHistoryGuard } from "./table-history-undo";
import type { TableCellHistory } from "./table-cell-history";
import { planTableFindReplace, preflightTableFindReplace } from "./table-find";

export type TableFindResult = "replaced" | "unchanged" | "stale" | "size" | "preflight" | "unavailable";

/** Use the same guarded table history as a cell edit; callers send returned ops. */
export function applyTableFindReplace<S>(doc: Doc, session: object, undo: UndoManager<S>, history: TableCellHistory, match: FindMatch, replacement: string): { status: TableFindResult; ops: Op[] } {
  if (!match.table) return { status: "unavailable", ops: [] };
  const checked = preflightTableFindReplace(doc, match, replacement);
  if (checked !== "ok") return { status: checked, ops: [] };
  const plan = planTableFindReplace(doc, match, replacement);
  if (!plan) return { status: "stale", ops: [] };
  if (plan.before === plan.after) return { status: "unchanged", ops: [] };
  const previous = doc.propVersion(match.block, "tableData"), guard = tableHistoryGuard(doc, match.block), tx = new Tx(doc);
  writeTable(tx, match.block, plan.state.props, plan.rows, doc.client);
  if (!tx.ops.length) return { status: "unchanged", ops: [] };
  const next = doc.propVersion(match.block, "tableData"), key = `table:${idKey(match.block)}:${match.table.row}:${match.table.col}`;
  history.record(session, key, plan.before, plan.after, previous ? idKey(previous) : null, next ? idKey(next) : null, guard, "find-replace", Date.now(), false);
  undo.seal(); undo.recordMarker(key, false); undo.seal();
  return { status: "replaced", ops: tx.ops };
}
