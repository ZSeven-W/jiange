import { idKey, Tx, type Doc, type Op, type OpId, type UndoManager } from "@jiange/collab";
import { tableDataOf } from "./tableCells";

type Change = { key: string; before: string; after: string };
type Entry = { block: OpId; changes: Change[]; expected: string };

/** Capture all table registers, including hidden cells, and paragraph text after whole-table deletion. */
function guard(doc: Doc, block: OpId): string {
  const info = doc.blockInfo(block);
  const keys = new Set(["type", "tableData", "tableMerges", "tableWidths", "tableHeader", ...Object.keys(info.props).filter((key) => key.startsWith("tbl."))]);
  const versions = [...keys].sort().map((key) => {
    const version = doc.propVersion(block, key);
    return [key, version ? idKey(version) : null];
  });
  return JSON.stringify([versions, tableDataOf(info.props), doc.visibleIds(block).map(idKey), doc.richChars(block)]);
}

/** Local, guarded undo for a selection deletion that changes table structure. */
export class TableStructureHistory {
  private next = 0;
  private readonly entries = new Map<string, Entry>();

  record<S>(doc: Doc, block: OpId, tx: Tx, undo: UndoManager<S>): string | null {
    for (const key of this.entries.keys()) if (!undo.hasMarker(key)) this.entries.delete(key);
    const changes = new Map<string, Change>();
    const info = doc.blockInfo(block);
    for (const item of tx.items) {
      if (item.k !== "prop" || idKey(item.block) !== idKey(block)) return null;
      const existing = changes.get(item.key);
      const after = item.key === "type" ? info.type : info.props[item.key] ?? "";
      changes.set(item.key, { key: item.key, before: existing?.before ?? item.prev, after });
    }
    if (!changes.size) return null;
    const key = `table-structure:${idKey(block)}:${++this.next}`;
    this.entries.set(key, { block, changes: [...changes.values()], expected: guard(doc, block) });
    return key;
  }

  step<S>(doc: Doc, undo: UndoManager<S>, key: string, redo: boolean): { status: "ready"; ops: Op[] } | { status: "empty" | "conflict" } {
    const entry = this.entries.get(key);
    if (!entry || undo.peekMarker(redo) !== key) return { status: "empty" };
    if (!doc.hasBlock(entry.block) || guard(doc, entry.block) !== entry.expected) return { status: "conflict" };
    const tx = new Tx(doc);
    for (const change of entry.changes) tx.setProp(entry.block, change.key, redo ? change.after : change.before);
    if (!tx.ops.length) return { status: "empty" };
    entry.expected = guard(doc, entry.block);
    undo.moveMarker(redo, key);
    return { status: "ready", ops: tx.ops };
  }

  discard(key: string) { this.entries.delete(key); }
}
