import { Doc, Tx, UndoManager, encodeClientMsg, encodeOps, eqId, idKey, type Op, type OpId } from "@jiange/collab";
import { FIND_CHANGED_CODEPOINT_LIMIT, FIND_FRAME_LIMIT, FIND_REPLACEMENT_BYTES_LIMIT, FIND_WORK_LIMIT, preflightFindReplace } from "./find-replace-safety";
import { replaceMatches, searchableLocations, type FindMatch } from "./find-replace";
import { readTableFindState, resolveTableFindMatch } from "./table-find";
import { writeTable } from "./table-cells";
import { tableHistoryGuard } from "./table-history-undo";

const STATE_LIMIT = 16 << 20;
type State = NonNullable<ReturnType<typeof readTableFindState>>;
type Cell = { row: number; col: number };
type TablePlan = { block: OpId; state: State; before: string[][]; after: string[][]; cells: Cell[] };
type Alias = { key: string; block: string; expected: string; versions: (string | null)[] };
type TableHistory = { block: OpId; before: string[][]; after: string[][]; cells: Cell[]; expected: string; versions: (string | null)[]; beforeData: string | null; afterData: string | null; guard: string };
type TextBlock = { block: OpId; parent: OpId };
type Entry = { doc: Doc; text: UndoManager<null>; textBlocks: TextBlock[]; tables: TableHistory[]; beforeAliases: Alias[]; afterAliases: Alias[] };
export type BatchStatus = "replaced" | "unchanged" | "stale" | "size" | "work" | "preflight" | "unavailable";
type BatchResult = { status: BatchStatus; ops: Op[]; count: number };
type StepResult = { status: "ready"; ops: Op[]; rebases: { block: OpId; logical: string | null; actual: string | null; guard: string }[] } | { status: "empty" | "conflict" | "size" };
let serial = 0;

/** Table inverses must not be generated against an offline or unconfirmed replica. */
export function canStepFindBatch(state: { caughtUp: boolean; status: string; unacked: number; blocked: string | null }): boolean {
  return state.caughtUp && state.status === "synced" && state.unacked === 0 && !state.blocked;
}

function plans(doc: Doc, matches: readonly FindMatch[], replacement: string): { text: FindMatch[]; tables: TablePlan[] } | null {
  const text: FindMatch[] = [], tables = new Map<string, TablePlan>(), cells = new Map<string, FindMatch[]>();
  for (const match of matches) {
    if (match.doc !== doc) return null;
    if (!match.table) { text.push(match); continue; }
    const key = idKey(match.block);
    let table = tables.get(key);
    if (!table) {
      const state = readTableFindState(doc, match.block);
      if (!state || !state.rows.every((row) => Array.isArray(row) && row.every((value) => typeof value === "string"))) return null;
      table = { block: match.block, state, before: state.rows.map((row) => [...row]), after: state.rows.map((row) => [...row]), cells: [] };
      tables.set(key, table);
    }
    if (!resolveTableFindMatch(doc, match, table.state)) return null;
    const cell = `${key}:${match.table.row}:${match.table.col}`, list = cells.get(cell) ?? [];
    list.push(match); cells.set(cell, list);
  }
  for (const list of cells.values()) {
    const first = list[0], location = first.table!, table = tables.get(idKey(first.block))!;
    const original = table.before[location.row][location.col], chars = [...original];
    let previous = chars.length;
    const parts: string[] = [];
    for (const match of [...list].sort((a, b) => b.start - a.start || b.end - a.end)) {
      if (match.end > previous) return null;
      parts.push(chars.slice(match.end, previous).join(""), replacement);
      previous = match.start;
    }
    parts.push(chars.slice(0, previous).join(""));
    const value = parts.reverse().join("");
    if (value !== original) { table.after[location.row][location.col] = value; table.cells.push({ row: location.row, col: location.col }); }
  }
  return { text, tables: [...tables.values()].filter((table) => table.cells.length > 0) };
}

const withinFrame = (ops: readonly Op[], limit = FIND_FRAME_LIMIT) => !ops.length || encodeClientMsg({ type: "ops", batch: encodeOps([...ops]) }).byteLength <= Math.min(FIND_FRAME_LIMIT, limit);
function writePlans(doc: Doc, tables: readonly { block: OpId; rows: string[][] }[]): Op[] {
  const tx = new Tx(doc);
  for (const table of tables) {
    const state = readTableFindState(doc, table.block);
    if (!state) throw new Error("table changed");
    writeTable(tx, table.block, state.props, table.rows, doc.client);
  }
  return tx.ops;
}

/** An all-or-nothing local operation, with preflight on a separate replica. */
export function applyFindBatch<S>(doc: Doc, undo: UndoManager<S>, history: FindBatchHistory, matches: readonly FindMatch[], replacement: string, frameLimit = FIND_FRAME_LIMIT): BatchResult {
  if (!matches.length || !matches.some((match) => match.table)) return { status: "unavailable", ops: [], count: 0 };
  if (replacement.length * matches.length > FIND_REPLACEMENT_BYTES_LIMIT || new TextEncoder().encode(replacement).length * matches.length > FIND_REPLACEMENT_BYTES_LIMIT) return { status: "size", ops: [], count: 0 };
  if (([...replacement].length * matches.length) + matches.reduce((n, match) => n + [...match.text].length, 0) > FIND_CHANGED_CODEPOINT_LIMIT) return { status: "size", ops: [], count: 0 };
  const original = plans(doc, matches, replacement);
  if (!original) return { status: "stale", ops: [], count: 0 };
  const work = original.tables.reduce((sum, table) => sum + table.before.reduce((n, row) => n + row.length + row.reduce((total, cell) => total + cell.length, 0), 0), 0);
  if (work > FIND_WORK_LIMIT) return { status: "work", ops: [], count: 0 };
  const textCheck = preflightFindReplace(doc, original.text, replacement, frameLimit);
  if (!textCheck.ok) return { status: textCheck.reason, ops: [], count: 0 };
  try {
    const encoded = doc.encodeState();
    if (encoded.byteLength > STATE_LIMIT) return { status: "work", ops: [], count: 0 };
    const copy = Doc.fromState(doc.client, encoded), rebound = matches.map((match) => ({ ...match, doc: copy })), test = plans(copy, rebound, replacement);
    if (!test) return { status: "stale", ops: [], count: 0 };
    const textTx = new Tx(copy), textResult = replaceMatches(textTx, test.text, replacement);
    if (textResult.skipped) return { status: "stale", ops: [], count: 0 };
    const tableOps = writePlans(copy, test.tables.map((table) => ({ block: table.block, rows: table.after })));
    if (!withinFrame([...textTx.ops, ...tableOps], frameLimit)) return { status: "size", ops: [], count: 0 };
    // Also bound the immediate inverse, which may restore longer cell values.
    const previewHistory = new UndoManager<null>(); previewHistory.record(textTx, null, null);
    const reverseText = previewHistory.undo(copy)?.ops ?? [];
    const reverseTables = writePlans(copy, test.tables.map((table) => ({ block: table.block, rows: table.before })));
    if (!withinFrame([...reverseText, ...reverseTables], frameLimit)) return { status: "size", ops: [], count: 0 };
  } catch { return { status: "preflight", ops: [], count: 0 }; }

  // No asynchronous work occurs between validation and applying this batch.
  const plan = plans(doc, matches, replacement);
  if (!plan) return { status: "stale", ops: [], count: 0 };
  const beforeAliases = history.capture(doc, plan.tables.map((table) => table.block));
  const beforeData = new Map(plan.tables.map((table) => { const version = doc.propVersion(table.block, "tableData"); return [idKey(table.block), version ? idKey(version) : null]; }));
  const textTx = new Tx(doc), textResult = replaceMatches(textTx, plan.text, replacement);
  if (textResult.skipped) throw new Error("find snapshot changed during synchronous application");
  const tableOps = writePlans(doc, plan.tables.map((table) => ({ block: table.block, rows: table.after })));
  const ops = [...textTx.ops, ...tableOps];
  if (!ops.length) return { status: "unchanged", ops: [], count: matches.length };
  const textHistory = new UndoManager<null>(); textHistory.shareRemappings(undo); textHistory.record(textTx, null, null);
  const unique = new Map<string, TextBlock>();
  for (const match of plan.text) unique.set(idKey(match.block), { block: match.block, parent: match.parent });
  const tables: TableHistory[] = plan.tables.map((table) => {
    const state = readTableFindState(doc, table.block)!;
    const version = doc.propVersion(table.block, "tableData");
    return { block: table.block, before: table.before, after: table.after, cells: table.cells, expected: state.snapshot, versions: table.cells.map((cell) => state.cellVersion(cell.row, cell.col)), beforeData: beforeData.get(idKey(table.block)) ?? null, afterData: version ? idKey(version) : null, guard: tableHistoryGuard(doc, table.block) };
  });
  history.record(undo, { doc, text: textHistory, textBlocks: [...unique.values()], tables, beforeAliases, afterAliases: [] });
  return { status: "replaced", ops, count: matches.length };
}

export class FindBatchHistory {
  private readonly entries = new Map<string, Entry>();
  private readonly tableActions = new Map<string, { undo: { before: Alias[]; after: Alias[] }[]; redo: { before: Alias[]; after: Alias[] }[] }>();
  capture(doc: Doc, blocks: readonly OpId[], exclude?: string): Alias[] {
    const keys = new Set(blocks.map(idKey)), states = new Map<string, ReturnType<typeof readTableFindState>>(), result: Alias[] = [];
    for (const [key, entry] of this.entries) {
      if (key === exclude || entry.doc !== doc) continue;
      for (const table of entry.tables) {
        const block = idKey(table.block); if (!keys.has(block)) continue;
        if (!states.has(block)) states.set(block, readTableFindState(doc, table.block));
        const state = states.get(block);
        if (state && state.snapshot === table.expected && table.cells.every((cell, i) => state.cellVersion(cell.row, cell.col) === table.versions[i])) result.push({ key, block, expected: table.expected, versions: [...table.versions] });
      }
    }
    return result;
  }
  private rebase(doc: Doc, aliases: readonly Alias[]) {
    for (const alias of aliases) {
      const table = this.entries.get(alias.key)?.tables.find((item) => idKey(item.block) === alias.block);
      if (!table || table.expected !== alias.expected || table.versions.some((value, i) => value !== alias.versions[i])) continue;
      const state = readTableFindState(doc, table.block); if (!state) continue;
      table.expected = state.snapshot; table.versions = table.cells.map((cell) => state.cellVersion(cell.row, cell.col));
    }
  }
  /** Track guarded cell actions interleaved with a mixed replacement. */
  recordTableChange(key: string, before: Alias[], merged: boolean) {
    if (!before.length && !this.tableActions.has(key)) return;
    const history = this.tableActions.get(key) ?? { undo: [], redo: [] };
    if (!merged || !history.undo.length) history.undo.push({ before, after: [] });
    history.redo = [];
    if (history.undo.length > 500) history.undo.shift();
    this.tableActions.delete(key); this.tableActions.set(key, history);
    if (this.tableActions.size > 500) this.tableActions.delete(this.tableActions.keys().next().value!);
  }
  finishTableChange(doc: Doc, key: string, redo: boolean, current: Alias[]) {
    const history = this.tableActions.get(key), from = redo ? history?.redo : history?.undo, to = redo ? history?.undo : history?.redo;
    const item = from?.pop(); if (!item || !to) return;
    this.rebase(doc, redo ? item.after : item.before);
    if (redo) item.before = current; else item.after = current;
    to.push(item);
  }
  discardTableChange(key: string, redo: boolean) {
    const history = this.tableActions.get(key); if (!history) return;
    (redo ? history.redo : history.undo).pop();
    if (!history.undo.length && !history.redo.length) this.tableActions.delete(key);
  }
  record<S>(undo: UndoManager<S>, entry: Entry) {
    for (const key of this.entries.keys()) if (!undo.hasMarker(key)) this.entries.delete(key);
    const key = `find-batch:${++serial}`;
    undo.seal(); undo.recordMarker(key); undo.seal();
    this.entries.set(key, entry);
  }
  discard(key: string) { this.entries.delete(key); }
  step<S>(doc: Doc, undo: UndoManager<S>, key: string, redo: boolean): StepResult {
    const entry = this.entries.get(key);
    if (!entry || undo.peekMarker(redo) !== key) return { status: "empty" };
    if (entry.doc !== doc) return { status: "conflict" };
    const locations = new Map(searchableLocations(doc).map((item) => [idKey(item.block), item.parent]));
    if (entry.textBlocks.some((item) => !locations.has(idKey(undo.map(item.block))) || !eqId(locations.get(idKey(undo.map(item.block)))!, undo.map(item.parent)))) return { status: "conflict" };
    for (const table of entry.tables) {
      const state = readTableFindState(doc, table.block);
      if (!state || state.snapshot !== table.expected || table.cells.some((cell, i) => state.cellVersion(cell.row, cell.col) !== table.versions[i])) return { status: "conflict" };
    }
    try {
      const state = doc.encodeState(); if (state.byteLength > STATE_LIMIT) return { status: "size" };
      const copy = Doc.fromState(doc.client, state), text = entry.text.preview(copy, redo)?.ops ?? [];
      const tables = writePlans(copy, entry.tables.map((table) => ({ block: table.block, rows: redo ? table.after : table.before })));
      if (!withinFrame([...text, ...tables])) return { status: "size" };
    } catch { return { status: "conflict" }; }
    const aliases = this.capture(doc, entry.tables.map((table) => table.block), key);
    const text = (redo ? entry.text.redo(doc) : entry.text.undo(doc))?.ops ?? [];
    const tables = writePlans(doc, entry.tables.map((table) => ({ block: table.block, rows: redo ? table.after : table.before })));
    for (const table of entry.tables) {
      const state = readTableFindState(doc, table.block)!;
      table.expected = state.snapshot; table.versions = table.cells.map((cell) => state.cellVersion(cell.row, cell.col));
    }
    this.rebase(doc, redo ? entry.afterAliases : entry.beforeAliases);
    if (redo) entry.beforeAliases = aliases; else entry.afterAliases = aliases;
    undo.moveMarker(redo, key);
    return { status: "ready", ops: [...text, ...tables], rebases: entry.tables.map((table) => { const version = doc.propVersion(table.block, "tableData"); return { block: table.block, logical: redo ? table.afterData : table.beforeData, actual: version ? idKey(version) : null, guard: table.guard }; }) };
  }
}
